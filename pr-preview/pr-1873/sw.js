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
		buildId: "ef954ad97096-346c32e9",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1873/\":\"894c5fd206b8eed4\",\"/knowledge-medium/pr-preview/pr-1873/index.html\":\"894c5fd206b8eed4\",\"/knowledge-medium/pr-preview/pr-1873/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1873/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1873/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1873/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1873/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1873/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1873/app.css\":\"141c7ab4732fe1ad\",\"/knowledge-medium/pr-preview/pr-1873/assets/FacadeVFS-brxf8LIG.js\":\"f81397d38e282705\",\"/knowledge-medium/pr-preview/pr-1873/assets/OPFSCoopSyncVFS-bZ-3o8K5.js\":\"320d3f61a7c18698\",\"/knowledge-medium/pr-preview/pr-1873/assets/OPFSWriteAheadVFS-Bus_w2V_.js\":\"9372eec6be7f8ab9\",\"/knowledge-medium/pr-preview/pr-1873/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1873/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1873/assets/wa-sqlite-async-Didn-8vn.js\":\"fe02daeed23a649f\",\"/knowledge-medium/pr-preview/pr-1873/assets/wa-sqlite-b4IcMcf9.js\":\"e383993e7d3d3d90\",\"/knowledge-medium/pr-preview/pr-1873/assets/worker-DlYV7Jq7.js\":\"4277ddc29b61d349\",\"/knowledge-medium/pr-preview/pr-1873/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1873/chunks/app-CeoayB1P.js\":\"c9b944c0009e269c\",\"/knowledge-medium/pr-preview/pr-1873/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1873/index.js\":\"160177d88208cabb\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1873/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1873/assets/AccessHandlePoolVFS-CKZGKWkl.js\":\"7c93645c5a734866\",\"/knowledge-medium/pr-preview/pr-1873/assets/IDBBatchAtomicVFS-DNW4H4M5.js\":\"bb5c352143176e2b\",\"/knowledge-medium/pr-preview/pr-1873/assets/MemoryVFS-CpyWgXCQ.js\":\"c41bd80befd5bcc4\",\"/knowledge-medium/pr-preview/pr-1873/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1873/assets/mc-wa-sqlite-HN8oonyP.js\":\"14d25f6004622c22\",\"/knowledge-medium/pr-preview/pr-1873/assets/mc-wa-sqlite-async-DhIyOxHO.js\":\"86ecd8a0c238c26d\",\"/knowledge-medium/pr-preview/pr-1873/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1873/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1873/chunks/AccessHandlePoolVFS-D9Txalva.js\":\"4fb088934c50bd09\",\"/knowledge-medium/pr-preview/pr-1873/chunks/FacadeVFS-CHBO78h5.js\":\"ca92ab5c7b673737\",\"/knowledge-medium/pr-preview/pr-1873/chunks/IDBBatchAtomicVFS-WeivbTdP.js\":\"e39ca53a9adb6122\",\"/knowledge-medium/pr-preview/pr-1873/chunks/MemoryVFS-VDCYavR0.js\":\"c883ec907df244a2\",\"/knowledge-medium/pr-preview/pr-1873/chunks/OPFSCoopSyncVFS-CBKE4ON6.js\":\"093b6665555fe552\",\"/knowledge-medium/pr-preview/pr-1873/chunks/OPFSWriteAheadVFS-BIQaZPkr.js\":\"825afb07b57886f9\",\"/knowledge-medium/pr-preview/pr-1873/chunks/Preview-BIRVE6M6.js\":\"908a1ffe001ce486\",\"/knowledge-medium/pr-preview/pr-1873/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1873/chunks/card-INsrq_Yx.js\":\"a97552c1a09eec66\",\"/knowledge-medium/pr-preview/pr-1873/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1873/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1873/chunks/dist-BfshQk5-.js\":\"b9cbae89906690bc\",\"/knowledge-medium/pr-preview/pr-1873/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1873/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1873/chunks/mc-wa-sqlite-BWxp7lkr.js\":\"78f8b1ef3b0070dc\",\"/knowledge-medium/pr-preview/pr-1873/chunks/mc-wa-sqlite-async-DDCIfzl0.js\":\"75e572c1dcce95f7\",\"/knowledge-medium/pr-preview/pr-1873/chunks/react--ng125Wx.js\":\"9a6291bc18d7782a\",\"/knowledge-medium/pr-preview/pr-1873/chunks/react-BjfPPDYv.js\":\"1e3b8c737db7851c\",\"/knowledge-medium/pr-preview/pr-1873/chunks/react-CAZ3q2Z5.js\":\"b728c2684d7bae11\",\"/knowledge-medium/pr-preview/pr-1873/chunks/react-CqJfRoam.js\":\"331077a63cb30155\",\"/knowledge-medium/pr-preview/pr-1873/chunks/react-D4KZ__Fq.js\":\"fb3ff08e3c9b3041\",\"/knowledge-medium/pr-preview/pr-1873/chunks/react-DfvFBvXi.js\":\"94ea71f4623c1e7b\",\"/knowledge-medium/pr-preview/pr-1873/chunks/react-dom-server-legacy.browser.production-C59-eF8u.js\":\"d940ac20a4016eae\",\"/knowledge-medium/pr-preview/pr-1873/chunks/react-dom-server.browser.production-CqpK4Vfa.js\":\"208a16857c973229\",\"/knowledge-medium/pr-preview/pr-1873/chunks/react-dom-server.edge.production-Gv1b6xsh.js\":\"03ee44e86417bf71\",\"/knowledge-medium/pr-preview/pr-1873/chunks/react-tuP5bENl.js\":\"889f6c06d90b5b18\",\"/knowledge-medium/pr-preview/pr-1873/chunks/react-zCq2dm4S.js\":\"95876626893f2e80\",\"/knowledge-medium/pr-preview/pr-1873/chunks/server.browser-CBGKhgDA.js\":\"4a70227ea0cd1429\",\"/knowledge-medium/pr-preview/pr-1873/chunks/textarea-v9RLE56-.js\":\"98feb45eddc012a8\",\"/knowledge-medium/pr-preview/pr-1873/chunks/ui-DDc4i_Bj.js\":\"31d96012c49099bc\",\"/knowledge-medium/pr-preview/pr-1873/chunks/wa-sqlite-BdGSHqZZ.js\":\"626be2f01cf6788a\",\"/knowledge-medium/pr-preview/pr-1873/chunks/wa-sqlite-async-DncCmIzI.js\":\"97895181446ed338\",\"/knowledge-medium/pr-preview/pr-1873/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1873/extension-utilities.css\":\"1a2b9a89fd3a3bea\",\"/knowledge-medium/pr-preview/pr-1873/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1873/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1873/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1873/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1873/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1873/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1873/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1873/src/App.js\":\"380f5fef381452cb\",\"/knowledge-medium/pr-preview/pr-1873/src/appUpdate.js\":\"b1baec71914df598\",\"/knowledge-medium/pr-preview/pr-1873/src/appVersion.js\":\"01dee43e15c1d166\",\"/knowledge-medium/pr-preview/pr-1873/src/bootstrap/initialLayout.js\":\"405bb96593e636f3\",\"/knowledge-medium/pr-preview/pr-1873/src/bootstrap/openWorkspaceData.js\":\"51372a3861d04968\",\"/knowledge-medium/pr-preview/pr-1873/src/bootstrap/resolveWorkspace.js\":\"a3f8009c595ff848\",\"/knowledge-medium/pr-preview/pr-1873/src/bootstrap/workspaceBootstrap.js\":\"af99ac897285e6de\",\"/knowledge-medium/pr-preview/pr-1873/src/components/BlockComponent.js\":\"92c98cd462d416a4\",\"/knowledge-medium/pr-preview/pr-1873/src/components/BlockCrumbs.js\":\"0657e5b07cf484c6\",\"/knowledge-medium/pr-preview/pr-1873/src/components/BlockEditor.js\":\"4b6b872a2449e669\",\"/knowledge-medium/pr-preview/pr-1873/src/components/BlockLoadingPlaceholder.js\":\"e7c30e84fa4d88a4\",\"/knowledge-medium/pr-preview/pr-1873/src/components/BlockProperties.js\":\"93bedd51784a9c8e\",\"/knowledge-medium/pr-preview/pr-1873/src/components/BlockSearchPicker.js\":\"ca6f8ac3f774a909\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ConfirmBulkDeleteDialog.js\":\"1b3f34923e2877de\",\"/knowledge-medium/pr-preview/pr-1873/src/components/DividerHandle.js\":\"b1278afb3a496acd\",\"/knowledge-medium/pr-preview/pr-1873/src/components/DraftEditor.js\":\"1123221118e416af\",\"/knowledge-medium/pr-preview/pr-1873/src/components/GutterPill.js\":\"1e782c194df8b235\",\"/knowledge-medium/pr-preview/pr-1873/src/components/Header.js\":\"c88eec444d5538c0\",\"/knowledge-medium/pr-preview/pr-1873/src/components/LazyBlockComponent.js\":\"2183eef1c8db259e\",\"/knowledge-medium/pr-preview/pr-1873/src/components/Login.js\":\"01b6432383291b22\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ZoomableSurface.js\":\"2fa77324163e5b3f\",\"/knowledge-medium/pr-preview/pr-1873/src/components/editModeKeepalive.js\":\"a3a371289326eb3f\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyDisplay/PropertyDisplayScope.js\":\"95a8ffbfbc60666f\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"de90fef2f06641eb\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyEditors/RefPropertyEditor.js\":\"fa898e7d4697c4e8\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyEditors/RefTargetTypePicker.js\":\"af0e7f273bd2a4db\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyEditors/SelectPropertyEditor.js\":\"67c062465bef140a\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyEditors/TypesPropertyEditor.js\":\"1eca51d499d414e8\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyEditors/defaults.js\":\"bf5dd2791350970d\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyEditors/kernelValuePresets.js\":\"d128d0c6c7e85d86\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyEditors/selectablePresets.js\":\"078fd5f102c41ea8\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyEditors/typesPropertyUi.js\":\"e1ccddb17bef757b\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyPanel/AddPropertyForm.js\":\"faca2b6a50000e7f\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyPanel/PropertyPicker.js\":\"97a9ca6ad658ff6f\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyPanel/PropertyRow.js\":\"36bb3164ded1c1ec\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyPanel/Rows.js\":\"3052d2cae0f4a23f\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyPanel/actions.js\":\"d2c1d8d8247792a2\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyPanel/declarationOnly.js\":\"5b3306fcbc3bb04f\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyPanel/layout.js\":\"9d6ea85e680865d5\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyPanel/model.js\":\"44b1cde268f5fa6f\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyPanel/shapeUi.js\":\"ebb2ff87129905cb\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyPanel/shapes.js\":\"62e8ebbec2dd3b1b\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyPanel/usePropertyEditingActivation.js\":\"882ea0bd3cb59748\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyPanel/visibility.js\":\"aef7604ced6304de\",\"/knowledge-medium/pr-preview/pr-1873/src/components/propertyPanelSections.js\":\"bf1dfe330ab11c65\",\"/knowledge-medium/pr-preview/pr-1873/src/components/references/BlockEmbed.js\":\"4b6c8804eaff64bd\",\"/knowledge-medium/pr-preview/pr-1873/src/components/references/BlockLink.js\":\"ade2533f38041102\",\"/knowledge-medium/pr-preview/pr-1873/src/components/references/BlockRef.js\":\"911ab08a0d68f406\",\"/knowledge-medium/pr-preview/pr-1873/src/components/references/ReferenceLink.js\":\"b4af263fe677cc4e\",\"/knowledge-medium/pr-preview/pr-1873/src/components/references/cycleGuard.js\":\"7c5ac3298400d3fd\",\"/knowledge-medium/pr-preview/pr-1873/src/components/references/cycleGuardContext.js\":\"9bd4b529a8d7a9e8\",\"/knowledge-medium/pr-preview/pr-1873/src/components/references/linkInteraction.js\":\"2e3339980d21d8ef\",\"/knowledge-medium/pr-preview/pr-1873/src/components/references/referenceLayout.js\":\"cf5e5e42874f86e8\",\"/knowledge-medium/pr-preview/pr-1873/src/components/references/useBlockRefAncestors.js\":\"e49f545935a875c7\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/BlockGutter.js\":\"d19c424a8f35215f\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/BlockInfoDialog.js\":\"684590baa3df4092\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/BlockTypeBlockRenderer.js\":\"6b2e577ba6265e63\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/BulletHoverCard.js\":\"6302327ed8def106\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/CodeMirrorContentRenderer.js\":\"9db2eacb52adca8f\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"218b6303ef85b205\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/ColumnResizeHandles.js\":\"4d90e3a478a488e2\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"16a1a31d0da41da4\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/DefaultBlockRenderer.js\":\"a8d43e1c96e8c8a9\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/LayoutRenderer.js\":\"bf3e0fee00106eca\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/MarkdownContentRenderer.js\":\"9681f8aa586278d1\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/MissingDataRenderer.js\":\"49bb1421695f6652\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/PanelRenderer.js\":\"604da4ecedc4ed45\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8a684d318af487b9\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/TopLevelRenderer.js\":\"cd9351a6fee35f6a\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/blockGutterMode.js\":\"2d8c363185641208\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/blockTitleText.js\":\"0c6a52f6f38c4cce\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/fieldCreationKeydown.js\":\"73b3a85f1de74f17\",\"/knowledge-medium/pr-preview/pr-1873/src/components/renderer/layoutRootContext.js\":\"eb1cd31f9ac99e1d\",\"/knowledge-medium/pr-preview/pr-1873/src/components/typeChip/TypeChip.js\":\"527f57da3135932d\",\"/knowledge-medium/pr-preview/pr-1873/src/components/typeChip/chipStyle.js\":\"f4ef918ec0472fd4\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/anchored-floating.js\":\"9ca56343cd623bb0\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/button.js\":\"e2f72474c953730b\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/card.js\":\"dd100051ba68d835\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/checkbox.js\":\"4ab656679e032111\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/collapsible.js\":\"2aa21dda979bdecf\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/command.js\":\"2f0196c6bc30ae53\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/context-menu.js\":\"b7f1b7640f339042\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/dialog.js\":\"78acd0e3a24e9496\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/dropdown-menu.js\":\"391337e7050b0700\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/floating-listbox.js\":\"41c412827ad9012f\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/index.js\":\"6f9ea0e287e15cf7\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/input.js\":\"e1f2c8b5fc455aab\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/kbd.js\":\"37beaed80037cfd8\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/label.js\":\"39e62b8203d5efa0\",\"/knowledge-medium/pr-preview/pr-1873/src/components/ui/textarea.js\":\"4ea45d851276f2fc\",\"/knowledge-medium/pr-preview/pr-1873/src/components/useEditModeYieldKeepalive.js\":\"9e1fcdffa098c22f\",\"/knowledge-medium/pr-preview/pr-1873/src/components/util/BootFallback.js\":\"6aa9bea680a67c42\",\"/knowledge-medium/pr-preview/pr-1873/src/components/util/FocusedRowLazyMount.js\":\"79fb7b0ea6cd90e9\",\"/knowledge-medium/pr-preview/pr-1873/src/components/util/LazyViewportMount.js\":\"25180a0062bcf023\",\"/knowledge-medium/pr-preview/pr-1873/src/components/util/LocalDbCorruptionFallback.js\":\"b40bc29c99768584\",\"/knowledge-medium/pr-preview/pr-1873/src/components/util/error.js\":\"00d47f1edb13ebbb\",\"/knowledge-medium/pr-preview/pr-1873/src/components/util/lazyMountRegistry.js\":\"d013bea6089e2f78\",\"/knowledge-medium/pr-preview/pr-1873/src/components/util/suspense.js\":\"20bcfdb0bc305a95\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/CreateWorkspaceDialog.js\":\"bd595149b879803e\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/PendingInvitations.js\":\"83e4a1acc71f0348\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/SyncProgress.js\":\"3c2ac49e9697839f\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/UnlockProgress.js\":\"2e5d5cf96ceba432\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/WorkspaceKeyGate.js\":\"c461757009d485b0\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/WorkspaceSettingsDialog.js\":\"6013e7bb1f9b20df\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/WorkspaceSwitcher.js\":\"174456bb7c678bc4\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/WorkspaceSyncGate.js\":\"8f5e131d56b81dcc\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/conversion/ConversionFlow.js\":\"7a862c421fbda534\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/conversion/ConversionFlowHost.js\":\"d4fd0edf92299ac6\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/conversion/EncryptionSection.js\":\"b5d9f1201773aab2\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/conversion/attachmentPrompts.js\":\"da9b65ed6a9f2ac3\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/conversion/bundleFolderPrompts.js\":\"e7e8a83b32b11cb2\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/conversion/conversionFlowDeps.js\":\"9a613c65f0a77fbb\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/conversion/conversionFlowStore.js\":\"b58c6b5fbae326c2\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/conversion/flowUi.js\":\"63f94697d0928fcd\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/conversion/useConversionRun.js\":\"cf52f0966ec35513\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/keyUi.js\":\"fb4d55a3c3913a87\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/useCloseOnKeyLoss.js\":\"c7dca9b229f621e6\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/useCloseOnServerE2ee.js\":\"3564323493ba86c4\",\"/knowledge-medium/pr-preview/pr-1873/src/components/workspace/workspaceUnlocked.js\":\"177bfeae7fb33ee9\",\"/knowledge-medium/pr-preview/pr-1873/src/context/backgroundSubtree.js\":\"596892d3e71d93b3\",\"/knowledge-medium/pr-preview/pr-1873/src/context/block.js\":\"98942443a064db19\",\"/knowledge-medium/pr-preview/pr-1873/src/context/layoutWsContext.js\":\"586f2425f378925a\",\"/knowledge-medium/pr-preview/pr-1873/src/context/propertyDisplay.js\":\"e4213af3b5478ad1\",\"/knowledge-medium/pr-preview/pr-1873/src/context/repo.js\":\"02254b689bfda61e\",\"/knowledge-medium/pr-preview/pr-1873/src/data/aliasClaim.js\":\"85c6f27c5031fac5\",\"/knowledge-medium/pr-preview/pr-1873/src/data/aliasSeatNamespace.js\":\"55a83c639dd83d34\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/blockData.js\":\"85a0b4321e24a9f7\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/blockType.js\":\"84f379642a4a4901\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/changeScope.js\":\"28afc987f9153ba3\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/codecs.js\":\"bade52675c2ff98f\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/derivedData.js\":\"1ddddc1d233c815b\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/errors.js\":\"6491069531ad14ea\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/events.js\":\"70f3999500e53e6d\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/handle.js\":\"f622cf692eda7f7b\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/index.js\":\"b3fa85663ccf5409\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/mutator.js\":\"21e987c2fe9fc2d5\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/processor.js\":\"dd91a4a43913d12a\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/propertySchema.js\":\"b1a6614193b7209c\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/query.js\":\"eb6f3722dde14cff\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/sameTxProcessor.js\":\"0894230c668054bd\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/schema.js\":\"f622cf692eda7f7b\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/tx.js\":\"f622cf692eda7f7b\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/typedBlockQuery.js\":\"bc4b0a55bd9eae80\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/user.js\":\"ee1422f866804c13\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/valuePresetCore.js\":\"0703171b696d65c9\",\"/knowledge-medium/pr-preview/pr-1873/src/data/api/valuePresets.js\":\"70615de90494b707\",\"/knowledge-medium/pr-preview/pr-1873/src/data/attachmentCleanerIOVerb.js\":\"eb3e5a2f25a15d9c\",\"/knowledge-medium/pr-preview/pr-1873/src/data/block.js\":\"a627c9d6c3c80987\",\"/knowledge-medium/pr-preview/pr-1873/src/data/blockCache.js\":\"bc272f248706116a\",\"/knowledge-medium/pr-preview/pr-1873/src/data/blockId.js\":\"b364a3a085b98361\",\"/knowledge-medium/pr-preview/pr-1873/src/data/blockLiveness.js\":\"f08d95177def4e13\",\"/knowledge-medium/pr-preview/pr-1873/src/data/blockMerge.js\":\"04072062334b8214\",\"/knowledge-medium/pr-preview/pr-1873/src/data/blockSchema.js\":\"4a12acabd41344c7\",\"/knowledge-medium/pr-preview/pr-1873/src/data/blockTypeLookup.js\":\"39c1773bb200631e\",\"/knowledge-medium/pr-preview/pr-1873/src/data/blockTypes.js\":\"a26b6487c64f296e\",\"/knowledge-medium/pr-preview/pr-1873/src/data/childrenView.js\":\"e0c5cb6feccd0778\",\"/knowledge-medium/pr-preview/pr-1873/src/data/clientContext.js\":\"3c815a5531d49117\",\"/knowledge-medium/pr-preview/pr-1873/src/data/dbFileSiblings.js\":\"8383ccdd3c06d808\",\"/knowledge-medium/pr-preview/pr-1873/src/data/definitionSeeds.js\":\"218b5ee108eedc50\",\"/knowledge-medium/pr-preview/pr-1873/src/data/derivedIds.js\":\"12cb84ea9c21230e\",\"/knowledge-medium/pr-preview/pr-1873/src/data/drawnSubtree.js\":\"e7a40ae6b772a568\",\"/knowledge-medium/pr-preview/pr-1873/src/data/facetBridge.js\":\"14ab7a61b325adbc\",\"/knowledge-medium/pr-preview/pr-1873/src/data/facets.js\":\"869d8d38fef18570\",\"/knowledge-medium/pr-preview/pr-1873/src/data/globalState.js\":\"91c8190033dcc6f6\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/aliasClaimRederiveProcessor.js\":\"5b6048433ed0de69\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/ancestorBatch.js\":\"cba71c9cebebe60d\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/blockTypeTypeifyProcessor.js\":\"0519f46dbe1df544\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/clientSchema.js\":\"9c1b3643e2ccdd60\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/commitPipeline.js\":\"7b4bdca617122d4d\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/devAssertions.js\":\"ee3c1b6eee2bb126\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/firstSync.js\":\"54fc3f46c8e0dcc8\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/freshInitialLoad.js\":\"dac0d9f78ae94dd9\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/graphBackfillClaim.js\":\"57beb9092f50a35d\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/handleStore.js\":\"0914ba5f32e4c765\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/idleMarkerJobs.js\":\"de90ee9f750deb8f\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/initialDownload.js\":\"a8e44e0251da89f2\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/initializeClientDatabase.js\":\"98f80fba2ca7c7c5\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/jsonCanonical.js\":\"1cca223e656d65f3\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/kernelInvalidation.js\":\"cfdf4aa5a595ed45\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/kernelProcessors.js\":\"b5e84a6065a3fe5a\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/kernelQueries.js\":\"77bbb47aefca7142\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/mergeTypeMembershipProcessor.js\":\"3879bb181e6974f0\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/normalizeReferencesProcessor.js\":\"00e2676fab0eb8be\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/poolInstrumentation.js\":\"261c47c51d694717\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/processorRunner.js\":\"3f43da92a8233724\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/propertyCellBackfill.js\":\"9e86e3d4ea6046d6\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/propertyChildMint.js\":\"4efe31e21cc3ac5e\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/propertyChildrenProcessor.js\":\"2d9677e5ab6a01cc\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/propertyDefinitionChangeProcessor.js\":\"839d992ae4895863\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/propertyDefinitionSynthesis.js\":\"971264e2eef6d640\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/propertyKeyScan.js\":\"87f2c475fb5bcbe2\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/propertySchemaResolution.js\":\"8366586d40815d16\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/propertyValueEdits.js\":\"779ac82fee98bb94\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/raiseProtocol.js\":\"8d1d080e6f9b92f8\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/readBatch.js\":\"05b51fa4b6412d8a\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/refProjection.js\":\"7d5f5bc8826234c7\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/referenceTargetLookups.js\":\"a0d1d6882bc1d045\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/referenceTargetProcessor.js\":\"8d610ab648470273\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/replayMerge.js\":\"ea2fd25eb435c4cd\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/sqlBinds.js\":\"2af2d4d97c10784f\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"63d24096b289175c\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/syncObserver/arrivalProcessors.js\":\"98b45cb2b0107b8f\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/syncObserver/invalidate.js\":\"de9f07d1143d2baf\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/syncObserver/materialize.js\":\"9a0a78fc93128bcd\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/syncObserver/observer.js\":\"077bbd3ae1ff1467\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/syncObserver/reconcile.js\":\"e8979d427afefcc0\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/timingMetrics.js\":\"4ca847400c8f3ef9\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/treeQueries.js\":\"79de7dece4e8cf17\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/txEngine.js\":\"33b0aaca16d4d427\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/txSnapshots.js\":\"9c029a378d38b9a9\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/typedBlockQuery.js\":\"8d71ca7f914de657\",\"/knowledge-medium/pr-preview/pr-1873/src/data/internals/undoManager.js\":\"28c1bda3646890b1\",\"/knowledge-medium/pr-preview/pr-1873/src/data/invalidation.js\":\"e51b54750a8f4c10\",\"/knowledge-medium/pr-preview/pr-1873/src/data/kernelDataExtension.js\":\"e77cfc7f1aef7f2c\",\"/knowledge-medium/pr-preview/pr-1873/src/data/kernelPage.js\":\"d3facb256db570ee\",\"/knowledge-medium/pr-preview/pr-1873/src/data/kernelValuePresetCores.js\":\"eec6aa91c978a2c2\",\"/knowledge-medium/pr-preview/pr-1873/src/data/localDbCorruptionSignal.js\":\"8247feebd24acff1\",\"/knowledge-medium/pr-preview/pr-1873/src/data/localDbStorage.js\":\"ccaea60b49dcc928\",\"/knowledge-medium/pr-preview/pr-1873/src/data/localDbVfs.js\":\"5990fb34ebe1a7fc\",\"/knowledge-medium/pr-preview/pr-1873/src/data/localSchema.js\":\"f21a9f309a2e5167\",\"/knowledge-medium/pr-preview/pr-1873/src/data/maintenance.js\":\"1f33ea57b86c9bb5\",\"/knowledge-medium/pr-preview/pr-1873/src/data/mergeProperties.js\":\"ce945330986e7dc6\",\"/knowledge-medium/pr-preview/pr-1873/src/data/metricsConsoleHook.js\":\"7dbac33fbf76b9f6\",\"/knowledge-medium/pr-preview/pr-1873/src/data/migrationsPage.js\":\"5db3edd7d4b71c15\",\"/knowledge-medium/pr-preview/pr-1873/src/data/mutators.js\":\"934f4995bfbb64c9\",\"/knowledge-medium/pr-preview/pr-1873/src/data/orderKey.js\":\"2324f54e38b48b77\",\"/knowledge-medium/pr-preview/pr-1873/src/data/orderKeyPlacement.js\":\"d287bea8465fa988\",\"/knowledge-medium/pr-preview/pr-1873/src/data/outlineSurface.js\":\"8b8397766635f9d4\",\"/knowledge-medium/pr-preview/pr-1873/src/data/pendingEditorContent.js\":\"16a7f0b24a90677b\",\"/knowledge-medium/pr-preview/pr-1873/src/data/pendingUploadsSql.js\":\"c0b2b60b155f7227\",\"/knowledge-medium/pr-preview/pr-1873/src/data/pluginStateExtensions.js\":\"5bc376c1e84c4b99\",\"/knowledge-medium/pr-preview/pr-1873/src/data/powerSyncLogger.js\":\"f15a1d81edc78a5c\",\"/knowledge-medium/pr-preview/pr-1873/src/data/projectorRuntime.js\":\"f5f5ed1828ce8ea1\",\"/knowledge-medium/pr-preview/pr-1873/src/data/properties.js\":\"a8fb1aa218683c05\",\"/knowledge-medium/pr-preview/pr-1873/src/data/propertiesPage.js\":\"b5b8604fceaa94ae\",\"/knowledge-medium/pr-preview/pr-1873/src/data/propertyChildren.js\":\"cdf2042d1d68376f\",\"/knowledge-medium/pr-preview/pr-1873/src/data/propertyDefinitionFanout.js\":\"56ee3098aea546bd\",\"/knowledge-medium/pr-preview/pr-1873/src/data/propertyDefinitionMetadata.js\":\"63443badf4da525e\",\"/knowledge-medium/pr-preview/pr-1873/src/data/propertyDefinitionRegistry.js\":\"f23140fac21233d5\",\"/knowledge-medium/pr-preview/pr-1873/src/data/propertyDisplayMode.js\":\"560da84ea512e21c\",\"/knowledge-medium/pr-preview/pr-1873/src/data/propertyRowCreation.js\":\"a35b86ed6800f6c4\",\"/knowledge-medium/pr-preview/pr-1873/src/data/propertySchemaCreation.js\":\"af2144b6ca1e6d16\",\"/knowledge-medium/pr-preview/pr-1873/src/data/propertySeeds.js\":\"2391b67aaf68ba1e\",\"/knowledge-medium/pr-preview/pr-1873/src/data/recentsPage.js\":\"c8e9f5a9815b9df3\",\"/knowledge-medium/pr-preview/pr-1873/src/data/referenceBlock.js\":\"b067f960a74027f8\",\"/knowledge-medium/pr-preview/pr-1873/src/data/rejectedUploads.js\":\"271b7ab0578d18cc\",\"/knowledge-medium/pr-preview/pr-1873/src/data/releasePowerSyncConnection.js\":\"969af8265b3aeb41\",\"/knowledge-medium/pr-preview/pr-1873/src/data/repo.js\":\"47d0f07767882d7a\",\"/knowledge-medium/pr-preview/pr-1873/src/data/repoProvider.js\":\"419e15486ace9efe\",\"/knowledge-medium/pr-preview/pr-1873/src/data/rowProperty.js\":\"c3384691098fc73f\",\"/knowledge-medium/pr-preview/pr-1873/src/data/searchFilter.js\":\"bf5c94e53409fff4\",\"/knowledge-medium/pr-preview/pr-1873/src/data/seedIdentityLedger.js\":\"d90b4258b83a08ab\",\"/knowledge-medium/pr-preview/pr-1873/src/data/stateBlocks.js\":\"8965e7fba48f39bc\",\"/knowledge-medium/pr-preview/pr-1873/src/data/structuralEditPolicy.js\":\"a3082268d686b51f\",\"/knowledge-medium/pr-preview/pr-1873/src/data/structuralInsert.js\":\"e7696802ad00e9fe\",\"/knowledge-medium/pr-preview/pr-1873/src/data/subtreeDelete.js\":\"3b6a40e3f69e3a66\",\"/knowledge-medium/pr-preview/pr-1873/src/data/syncStreamLock.js\":\"83825b448ee7c750\",\"/knowledge-medium/pr-preview/pr-1873/src/data/syncedTableSqlRecognizer.js\":\"cb3153fc9e5c712d\",\"/knowledge-medium/pr-preview/pr-1873/src/data/syncedTableWriteGuard.js\":\"265d0a5b1ca1510e\",\"/knowledge-medium/pr-preview/pr-1873/src/data/targets.js\":\"c9011a0339e78484\",\"/knowledge-medium/pr-preview/pr-1873/src/data/typeColors.js\":\"42976a0c91e2244d\",\"/knowledge-medium/pr-preview/pr-1873/src/data/typeDefinitionMetadata.js\":\"7f0f503781b58b83\",\"/knowledge-medium/pr-preview/pr-1873/src/data/typeDefinitionRegistry.js\":\"07c36ee94b2961fd\",\"/knowledge-medium/pr-preview/pr-1873/src/data/typeExtraction.js\":\"7cbb58677ea824dd\",\"/knowledge-medium/pr-preview/pr-1873/src/data/typeInitialValues.js\":\"83912264819ad455\",\"/knowledge-medium/pr-preview/pr-1873/src/data/typePropertyGroups.js\":\"87633f6074a77660\",\"/knowledge-medium/pr-preview/pr-1873/src/data/typeSeeds.js\":\"5502369e46ad1ac0\",\"/knowledge-medium/pr-preview/pr-1873/src/data/typeTagger.js\":\"fccdfd38d5708b5f\",\"/knowledge-medium/pr-preview/pr-1873/src/data/typedRecords.js\":\"4a9301471fe42704\",\"/knowledge-medium/pr-preview/pr-1873/src/data/typesPage.js\":\"a6ed0ed68e2b1823\",\"/knowledge-medium/pr-preview/pr-1873/src/data/userPrefs.js\":\"a82868e29dcf55d6\",\"/knowledge-medium/pr-preview/pr-1873/src/data/userSchemasService.js\":\"3030e93a6fec1d10\",\"/knowledge-medium/pr-preview/pr-1873/src/data/userTypesService.js\":\"e5e14e04bbfffa1c\",\"/knowledge-medium/pr-preview/pr-1873/src/data/valuePresetRegistry.js\":\"71d7e164aa701515\",\"/knowledge-medium/pr-preview/pr-1873/src/data/visibleChildren.js\":\"d597d711d57216b4\",\"/knowledge-medium/pr-preview/pr-1873/src/data/workspaceConversion.js\":\"5c4e56ff4664a763\",\"/knowledge-medium/pr-preview/pr-1873/src/data/workspaceFirstSync.js\":\"5a65257cc5b773c8\",\"/knowledge-medium/pr-preview/pr-1873/src/data/workspaceIdNamespace.js\":\"693a25ecdc5593b8\",\"/knowledge-medium/pr-preview/pr-1873/src/data/workspaceSchema.js\":\"93d88bae31f23480\",\"/knowledge-medium/pr-preview/pr-1873/src/data/workspaces.js\":\"a74704f18446f86d\",\"/knowledge-medium/pr-preview/pr-1873/src/data/writeAheadLog.js\":\"4e2a55c0846d182d\",\"/knowledge-medium/pr-preview/pr-1873/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1873/src/editor/BlockPasteShellDecorator.js\":\"b520fdf9914df5dc\",\"/knowledge-medium/pr-preview/pr-1873/src/editor/atTrigger.js\":\"fbea2e837f6fb7fa\",\"/knowledge-medium/pr-preview/pr-1873/src/editor/autocomplete.js\":\"b6798f513dfea6e6\",\"/knowledge-medium/pr-preview/pr-1873/src/editor/codeMirrorExtensions.js\":\"8c79b1045b5be980\",\"/knowledge-medium/pr-preview/pr-1873/src/editor/contentFlush.js\":\"9df8d210c3c9e2f8\",\"/knowledge-medium/pr-preview/pr-1873/src/editor/defaultInteractions.js\":\"ae570e86cf23b8bf\",\"/knowledge-medium/pr-preview/pr-1873/src/editor/editSettleSignal.js\":\"56eec129410f2315\",\"/knowledge-medium/pr-preview/pr-1873/src/editor/insertImage.js\":\"a8d7a8459d7e607e\",\"/knowledge-medium/pr-preview/pr-1873/src/editor/referenceCompletionRange.js\":\"7bbcad12a5be2618\",\"/knowledge-medium/pr-preview/pr-1873/src/editor/referenceTargetTypes.js\":\"6e14b21817fe01b3\",\"/knowledge-medium/pr-preview/pr-1873/src/editor/syntaxContext.js\":\"6b08b81bacc1cb05\",\"/knowledge-medium/pr-preview/pr-1873/src/editor/triggerMatch.js\":\"28dc3a864cdd1a21\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/AppRuntimeProvider.js\":\"c17bb76574082bce\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/BlockFocusShellDecorator.js\":\"6ad7c12ac3abf8b5\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/ExtensionRenderBoundary.js\":\"22d740e3370230cd\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/PanelContentRecovery.js\":\"dc34a9280f4bad5c\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/apiCatalog.js\":\"1301841554e9f387\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/approveExtensionHere.js\":\"25a9616ebe18467c\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/armedCutAppMount.js\":\"b11b480367ec0184\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/batchableKeyedStore.js\":\"657998ad1fa34c6b\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/blockInteraction.js\":\"7288b24cefc93611\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/blockSelectionAction.js\":\"73ec000f5bfb7b30\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/compileExtensionModule.js\":\"146c1ad608d972bc\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/compiledModuleCache.js\":\"3c378298209834b5\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/continuousGestures.js\":\"e030e4f82bd79575\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/core.js\":\"86307306ef30bab6\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/defaultRenderers.js\":\"71ed9bab2ea14a2b\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/definitionFanoutAppMount.js\":\"b46356d05b155581\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/dialogAppMount.js\":\"592d1456354589dc\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/dynamicExtensionSeeds.js\":\"afbcb487bfc1bffd\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/dynamicExtensions.js\":\"d7bfa10930ee9d9f\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/exampleExtensions.js\":\"20b37f5fdecb4d54\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/extensionApprovalStatus.js\":\"2a40aed68439565b\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/extensionLoadErrorToast.js\":\"7ae6a90e77773672\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/extensionLoadErrors.js\":\"00b8e09573762b0d\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/extensionLookup.js\":\"c1c25334033bc34f\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/extensionToggles.js\":\"87218eb5f16fd9fd\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/extensionUtilitiesCss.js\":\"2a7b40527e8fc4de\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/kernelPageDeletionGuard.js\":\"1bc7e197714e4c0b\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/liveRuntime.js\":\"9df42f6d58ea0ac4\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/openExtensionsSettings.js\":\"149480ffd959a726\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/overridesCache.js\":\"413f32bdf4204469\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/pluginIds.js\":\"d31ea8504b9e5bb3\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/processorRejectionToast.js\":\"58424b905eae291b\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/runtimeActions.js\":\"09afd14968196738\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/runtimeContext.js\":\"f0773228ab8d0373\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/staticAppExtensions.js\":\"4b4920bd49f33a6b\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/staticDataExtensions.js\":\"c53383f6a9b808b6\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/toastAppMount.js\":\"6b1b7851078afacd\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/useOverrides.js\":\"aca78a0acc617bc0\",\"/knowledge-medium/pr-preview/pr-1873/src/extensions/useShortcutSurfaceActivations.js\":\"c48862c0cfee67f3\",\"/knowledge-medium/pr-preview/pr-1873/src/facets/discoverToggleTree.js\":\"6871cdf5d7c28515\",\"/knowledge-medium/pr-preview/pr-1873/src/facets/facet.js\":\"6605a01e8706a53f\",\"/knowledge-medium/pr-preview/pr-1873/src/facets/resolveAppRuntime.js\":\"b071aa6595e6758b\",\"/knowledge-medium/pr-preview/pr-1873/src/facets/runtimeEvents.js\":\"b74a2496b544ef09\",\"/knowledge-medium/pr-preview/pr-1873/src/facets/togglable.js\":\"fc2a28993fb13d4e\",\"/knowledge-medium/pr-preview/pr-1873/src/facets/variantFacet.js\":\"65c68f597dc4d276\",\"/knowledge-medium/pr-preview/pr-1873/src/facets/verbFacet.js\":\"35f3eb01e735f7e5\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/block.js\":\"fb3a30ebb85d317d\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/focusedChild.js\":\"d5ee30e2069bc151\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/propertySchemas.js\":\"1a8aedcf42150d6b\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/typeRegistry.js\":\"3ff5f3795752feb7\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/useAncestorCrumbs.js\":\"b23f4cca9a464b2a\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/useAutocompleteListbox.js\":\"1c907131b8fcf497\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/useDebouncedSearch.js\":\"2f36bc823450b38a\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/useDebouncedValue.js\":\"b75c29533fb08587\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/useIsFocalRender.js\":\"82f2f065d32120f7\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/useIsReadOnly.js\":\"145b5a9a3c4b1b07\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/useMaterializeBacklog.js\":\"6c217153ffb2fb1a\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/useMinuteClock.js\":\"61b7b9d88650c01f\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/usePanelLayoutProjection.js\":\"1cdb7aded5ea48e7\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/usePendingInvitations.js\":\"946238f4467225eb\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/useRendererRegistry.js\":\"7b1724a0378cd90d\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/useRetainedFieldRows.js\":\"1f570b28a4cdac10\",\"/knowledge-medium/pr-preview/pr-1873/src/hooks/useWorkspaces.js\":\"f3fd6e9a9eb7e3fd\",\"/knowledge-medium/pr-preview/pr-1873/src/lib/utils.js\":\"d248622cc8ed6f29\",\"/knowledge-medium/pr-preview/pr-1873/src/main.js\":\"45ef2dbd44603da7\",\"/knowledge-medium/pr-preview/pr-1873/src/markdown/MarkdownImage.js\":\"565752427071be06\",\"/knowledge-medium/pr-preview/pr-1873/src/markdown/blockSeparators.js\":\"69f22380dc3d78ab\",\"/knowledge-medium/pr-preview/pr-1873/src/markdown/context.js\":\"257d079f61dac25a\",\"/knowledge-medium/pr-preview/pr-1873/src/markdown/defaultMarkdownExtension.js\":\"4834c76bcde7423f\",\"/knowledge-medium/pr-preview/pr-1873/src/markdown/extensions.js\":\"d5a7dd22b2acaf1f\",\"/knowledge-medium/pr-preview/pr-1873/src/markdown/renderMarkdownHtml.js\":\"84477dba09c49534\",\"/knowledge-medium/pr-preview/pr-1873/src/minimal-editor.js\":\"92a63c49f65a6b2d\",\"/knowledge-medium/pr-preview/pr-1873/src/paste/armedCut.js\":\"7bf8ed106e835153\",\"/knowledge-medium/pr-preview/pr-1873/src/paste/captureMediaVerb.js\":\"c9950812fc2246dc\",\"/knowledge-medium/pr-preview/pr-1873/src/paste/clipboard.js\":\"da7e1ca4e6ec9603\",\"/knowledge-medium/pr-preview/pr-1873/src/paste/decision.js\":\"c72ac06c47b76151\",\"/knowledge-medium/pr-preview/pr-1873/src/paste/operations.js\":\"c342024751e0faa8\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/account-header/AccountHeaderItem.js\":\"d201cdfa159ce0ea\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/account-header/index.js\":\"fd08eda98167eb08\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4d2b848c06d71eaf\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-dispatch-companion/askAgent.js\":\"226c1936d89235ba\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-dispatch-companion/askedStore.js\":\"f497a0af4c39c74a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9def0eb7202d3f78\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-dispatch-companion/chipState.js\":\"e989bc92447efeda\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2f58550cb88eb0e7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-dispatch-companion/index.js\":\"c4f66e732a19e1bb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7750a411c5e6a695\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-dispatch-companion/schema.js\":\"680feebc81718675\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/AgentTokensDialog.js\":\"7b010f83c287f923\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/BridgePairingDialog.js\":\"00840dd3d4530073\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/addMedia.js\":\"37211c7bffd0f5fa\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentViews/backlinks.js\":\"8160530724997d96\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentViews/block.js\":\"551fd5c5481675c6\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentViews/context.js\":\"d3fa753126839151\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentViews/displayIds.js\":\"2d35541bfc6346d1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentViews/index.js\":\"22cc59d0740bf3ce\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentViews/outline.js\":\"e1bebcdb59a86d60\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentViews/properties.js\":\"28e1e21ff706e2bf\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentViews/refs.js\":\"ced1a028bb6a042a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"26bf0e768ef8294f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentViews/search.js\":\"c30fd0d83604cd89\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentViews/shared.js\":\"0d3c40f20317c8c3\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"be07026d9e4fd6c1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentViews/text.js\":\"cca85b8e9f5cce4a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/agentWrites.js\":\"36dc99ebc0358ceb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/authoringCatalog.js\":\"454a20144d416b1e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/blockRefTargets.js\":\"f202795cf1ae0798\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/bridge.js\":\"7ff3b5fed88177ab\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/bridgeLoop.js\":\"feff2ec0152190fd\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/changeHistory.js\":\"8264d2aa12155a10\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/commands.js\":\"dbe037fd9975033f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/commentsCommands.js\":\"27fe903460dff626\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/dataExtension.js\":\"ec3813feb0227ce1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/dataModelGuide.js\":\"61ab35f844675873\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/describeRuntime.js\":\"c769566bb72044d1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/extensionLint.js\":\"96bb514750686328\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/grainAudit.js\":\"80cc0845b7b46726\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/healthCommand.js\":\"b3591a375e5dd5a2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/index.js\":\"f0b31a3f8e09ce9f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/presetIdentity.js\":\"c06832d190aa6076\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"f70572c984486999\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/readMedia.js\":\"b6bb149463b3183d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/schema.js\":\"0651e366204100c6\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/serialization.js\":\"89468eedfb138db9\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/targets.js\":\"98c902d026e30cf1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/tokens.js\":\"51df81a7abf11579\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/watchEvents.js\":\"2795b5108489d3f2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/workspaceGuard.js\":\"7416e36b9293c73a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/agent-runtime/writeCommands.js\":\"36e163143db01171\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/alias/AliasCollisionToast.js\":\"fc2671b045084581\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/alias/DuplicateNameBanner.js\":\"28e03b386cd188a1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/alias/collisionMerge.js\":\"0f3d58ecababc03d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/alias/dataExtension.js\":\"c87f15aa206af10c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/alias/index.js\":\"1e3dc6735873ae63\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/alias/mergeCollisionAction.js\":\"a3ab322df4a5b739\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/alias/pageStyling.js\":\"19a6db960afb7248\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/alias/rejectionToast.js\":\"2e3c187934a6f92d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/alias/syncProcessor.js\":\"a38672c9113c2765\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/actions.js\":\"07faa632293d3337\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/addComment.js\":\"c18b0bce943a902c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/anchor.js\":\"e5f5fdaa4acb7c07\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/anchorState.js\":\"a32299eb3a7ee8c0\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/commentLinks.js\":\"6a439305eb85e60c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/confirmThreadDeletion.js\":\"3a3d0760dba00bc1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/container.js\":\"297e983c7c86e7f4\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/dataExtension.js\":\"33d18cac33897f9e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/deleteComment.js\":\"cbfb3de43c686fb5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/highlights.js\":\"a72fd73a836af0de\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/index.js\":\"4b879642aa917cea\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/linkedCommentsPill.js\":\"a1380d15fdc3e944\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/margin.js\":\"28b72f4425fc894e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/marginSchema.js\":\"71390f58178b9356\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/newComment.js\":\"b8fc1f63189a9f8d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/ownThreadPicker.js\":\"a1d94ba972f9875e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/placement.js\":\"c686aa7db29e8f18\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/queries.js\":\"52000af882245c44\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/quotePosition.js\":\"c221eeb1d453e66c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/quotedIn.js\":\"c921032e7529a455\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/quotedRange.js\":\"cfa8abf30c38a967\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/rangeRefs.js\":\"9cea02af39e1cfb9\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/readHighlights.js\":\"cccde958616519be\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/readSelection.js\":\"1bf79c955d0f96c9\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/readSelectionUi.js\":\"1369720c5e9bb0ad\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/reanchor.js\":\"f0bf6171ee4290d7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/schema.js\":\"ed31ea4015876af3\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/scope.js\":\"b470a51ef7fe2750\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/scopeThreads.js\":\"efee124ba16e426d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/splitRetarget.js\":\"0e110fc2c13f8c77\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/suggestionCard.js\":\"42f96b2d5585b008\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/suggestions.js\":\"9e30752459632b0d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/summaries.js\":\"3266c0b888c3e2fa\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/summaryBatch.js\":\"166bc7c3e2133985\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/surface.js\":\"7f705a401813116a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/threadNavigation.js\":\"01d5c79d3af4abce\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/threads.js\":\"8f65094d98b3eebf\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/ui.js\":\"aec224d90c698d97\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/annotations/uiStore.js\":\"805145901729bbb5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/app-intents/appIntents.js\":\"6bd3dd2b5c6b90b5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/app-intents/index.js\":\"1318d147ffda834f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/app-update-prompt/index.js\":\"5e17248042554775\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/app-update-prompt/status.js\":\"cba86db924395081\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"2e8b01a8658d27ea\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/MediaBlockRenderer.js\":\"d4818a72c0250617\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e071fba2d3359fcf\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/MediaUploadReconciler.js\":\"e388d0aa2e5c5886\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/assetDownLane.js\":\"45a5538a2b19d511\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/assetResolver.js\":\"63b39b59c24c3ea1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/assetUpload.js\":\"36393889b51b3974\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/attachmentCleanerIO.js\":\"d563c2b44b45f40d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e51cb685a5de241d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/blobStore.js\":\"4a646296bcbe4670\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/browserMedia.js\":\"b71b44f09d51884e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/byteStore.js\":\"3dc8a53b0e7c0681\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/cleanerIO.js\":\"b50ab4a4d279770c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/cleanupAttachments.js\":\"36d9fdc1cd79a683\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/dataExtension.js\":\"3d363004e97b24e7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/downLane.js\":\"bd0c63ef2d943f3d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/index.js\":\"88b3ae46b7df9d42\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/insertImageContribution.js\":\"17476cc3122417b6\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/laneArming.js\":\"49fab39f8551c3e6\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/laneLock.js\":\"aa40f40a22618054\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/mediaBlock.js\":\"17e8eb29400a72fa\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/mediaCapture.js\":\"ac2c1699c15d6534\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/mediaLanes.js\":\"fe133fbacf4759ff\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/mediaViewers.js\":\"c7d0146f27946aa4\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/mediaViewersFacet.js\":\"6db815ca5458acab\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/pasteCapture.js\":\"5fae0cc35e779c87\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/resolver.js\":\"65b9e7669ad0f6cf\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/retryUploadsAction.js\":\"4ccfcf4b1abf84c5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/storagePaths.js\":\"0a82ddf4503c628e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/uploadDrain.js\":\"2657f779e69620d9\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/uploadLaneStatus.js\":\"024c04f7eafebd11\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/uploadReconcile.js\":\"320753f06b0e8501\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/uploadRecovery.js\":\"90af5973dbeb3d07\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/uploadStore.js\":\"6fd4fc92ea6b4158\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/attachments/useAssetObjectUrl.js\":\"51f783076f339b31\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"802f49a9bca78761\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks-view/BacklinksViewSection.js\":\"0509a282647f5b2e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks-view/facet.js\":\"4ca8fc410eaced0b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks-view/index.js\":\"208e26c0a38d3e88\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks-view/prop.js\":\"9675d36bfa100a57\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/BacklinkFilters.js\":\"72078402df766647\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"04d2b1b80002cd21\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/BlockEntry.js\":\"a8a2b325d290f01e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/LinkedReferences.js\":\"7e5c951c25851c1a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"87fe033854d542ad\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/dailyNoteDefaults.js\":\"15c1130d86e227a8\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/dataExtension.js\":\"9cd47c1c16557462\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/edgeExclusions.js\":\"9bd18a049eda0c39\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/filterProperty.js\":\"91b299a022da38cf\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/index.js\":\"58e362b656420419\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"3385e49b60d1276e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/inline-counts/applies.js\":\"08ee18ee18bc9f97\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/inline-counts/countQuery.js\":\"904ac8adf08ce304\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/inline-counts/expansionStore.js\":\"04165da17b7377a2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/inline-counts/index.js\":\"f37bedb52db36dbd\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"1f421932bff396c8\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/presentationInvalidation.js\":\"6098a93e8874790d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/propertyEditorOverride.js\":\"b52662f4a6e59ea7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/propertyFilter.js\":\"e74b1ee00469b75e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/query.js\":\"d6283d9ce467365d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/resolveFilter.js\":\"0c9ab72ea507f7ee\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/sourceBatch.js\":\"e2386d8cc9728504\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/sources.js\":\"14a9e63fe042277b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/useBacklinks.js\":\"597a9aaf2799ecac\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"4c0c4ba9c53b0132\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/birthday/BirthdayCelebration.js\":\"81d8d9184e2649d5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/birthday/BirthdayOverlay.js\":\"ab786fdce33ed081\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/birthday/gate.js\":\"35684e564683fc7e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/birthday/index.js\":\"9f7d73555de76f26\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/birthday/wolfTheme.js\":\"842fed5a27b2317b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-drag/BlockDragLayer.js\":\"ff1f92f7e361d0e5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-drag/dragController.js\":\"1f418b1ef9b3cbe6\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-drag/dropTarget.js\":\"6b2370aca333af27\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-drag/index.js\":\"dff0f3774043c049\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-drag/projection.js\":\"f56e3231783425c1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-info/BlockMetaCard.js\":\"70d8ebe2a39d694e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-info/index.js\":\"8d3a76d7f418d285\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-tagging/AddTagDialog.js\":\"b974bec0ae3e1b70\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"42c50082951a991c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-tagging/TagNameIssueHint.js\":\"f3186fe4455a63e7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-tagging/addTagAction.js\":\"d18dfa868a797d99\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-tagging/appendTag.js\":\"b898995b06298fda\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-tagging/config.js\":\"029bddd5957c711f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-tagging/dataExtension.js\":\"75b3b35e6381975f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-tagging/index.js\":\"5433afdae9f211ff\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/block-tagging/propertyEditorOverride.js\":\"89e9693d0e91077e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/breadcrumbs/BreadcrumbList.js\":\"507619c4ec6ad913\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"86269f00364db28c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c2fcc0904693053e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"f83f82fb13e74e91\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"53957574290dfa17\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/breadcrumbs/index.js\":\"65a31080b0e8f42d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"713c3eccfbbfa921\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/character-counter/CharacterCountItem.js\":\"416c030334978bc4\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f2884584bf743d5e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/character-counter/actions.js\":\"65475855558fcdd0\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/character-counter/blockType.js\":\"220ea301bd9137af\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/character-counter/charCount.js\":\"65946254a86a3374\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/character-counter/dataExtension.js\":\"867e83a7e12b1d55\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/character-counter/index.js\":\"d2ede475728381a6\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/character-counter/profiles.js\":\"ce4c76f83e557de5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/character-counter/properties.js\":\"ef06b190cce6a9e3\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/character-counter/textCounts.js\":\"3f5ce3bbd4fb1fca\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/colemak-keybindings/index.js\":\"c6c4a93df6c5b047\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/command-palette/CommandPalette.js\":\"99149148d0f3b348\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/command-palette/HeaderItem.js\":\"e3c89398f52e2a14\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/command-palette/context.js\":\"1285b0a00fbf8829\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/command-palette/index.js\":\"c76928612b75941c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/command-palette/selection.js\":\"cc7c0a81a61d6c00\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/command-palette/toggleStore.js\":\"783cd88a3459512f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/command-palette/useCommandPaletteActions.js\":\"274ebc919b0a326a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/contributors/ContributorBadges.js\":\"7ab72e3fb480625f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/contributors/author.js\":\"bad9819bc72cd7b5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/contributors/codeMirrorExtensions.js\":\"5fb7c6728d80e07b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/contributors/dataExtension.js\":\"e6f4d11077d5bf4a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/contributors/index.js\":\"ddeee881d5cdce3c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/contributors/mentionAutocomplete.js\":\"a4a5205e5c5c3874\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/contributors/processor.js\":\"3ea3b8ae73dce648\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/contributors/profiles.js\":\"cd2444cbbfaa5c1c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/contributors/queries.js\":\"6ae2935d85e4b651\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/contributors/schema.js\":\"637f1369fd099cab\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"bd899002df814dfd\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/cursor-follows-scroll/followOrigin.js\":\"50c20b636c6e003b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/cursor-follows-scroll/index.js\":\"eca6e7352855d2aa\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a9fb3f6dccc75499\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c5cc71cfcab6ab42\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/CalendarGrid.js\":\"cc3dd61248843c70\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/DailyNotePicker.js\":\"80f5a44d44aad516\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"17201103c68d29f6\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/DateNavDecorator.js\":\"55624710f2fe9182\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/DateScrubOverlay.js\":\"1d843a2f1ec2f51a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/HeaderItem.js\":\"11f9b3bbc695f717\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/ReschedulePicker.js\":\"3053ff4f956e1827\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0728691fd1b809dc\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/actions.js\":\"3fff652360cc7692\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/blockDateAdapter.js\":\"2b3b6ac1c4db7c6b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/calendar.js\":\"952f99d8d6d29534\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/dailyNotes.js\":\"ec81fbe317d22be2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/dataExtension.js\":\"043fe4922bdc3055\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/dateScrubActions.js\":\"01a00ebd6681a177\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/dateScrubGesture.js\":\"1c33e05951c12af4\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/dateScrubGestureActions.js\":\"b9e7c6b4f1cce00c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/dateScrubRecognizer.js\":\"38d885e1229ba9e1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/deletionGuard.js\":\"9fcce487efdcc9bd\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/dueQuery.js\":\"0fc70551d175114a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/index.js\":\"458817df0c8a5aca\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/landing.js\":\"c23a6ffa7613279e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/localSchema.js\":\"3267c527c86252c1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/referenceDateAdapter.js\":\"3f809fc8d5d22420\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/rescheduleAction.js\":\"636a1cff911bb22d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/schema.js\":\"dc24488be421f992\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/spreadBlockDates.js\":\"6546b37b11fa89c6\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/spreadDatesAction.js\":\"8807c7c25d7f576c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/today.js\":\"dbd055afb901b463\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"5a62fb050a083b54\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a34a0f0dd34fb031\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/data-integrity/audit.js\":\"f4ef7fe1d3b7c55e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/data-integrity/auditAction.js\":\"b9e4b71eb92095e5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/data-integrity/auditRanges.js\":\"c436c25703c94154\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/data-integrity/diagnosticsSource.js\":\"300c31a3dfa0dd97\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/data-integrity/divergenceScan.js\":\"85effc813a80577d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/data-integrity/index.js\":\"73eb871397621ec9\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0f931730c7f0ec37\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/data-integrity/referencesMirror.js\":\"83821204bd186c9c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/data-integrity/rowJson.js\":\"f3d35907047c863c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/data-integrity/schedule.js\":\"11e6548ee73c28fe\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/data-integrity/store.js\":\"58bd318a6876253b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-maintenance/action.js\":\"383fc67045ac9954\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-maintenance/index.js\":\"050cebea932114b0\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-maintenance/plugin.js\":\"2b54dc29a1009feb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"42b952a952fbac05\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-mirror/actions.js\":\"d3b8575e76e5fc18\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-mirror/changeMarker.js\":\"573ddc20c9cb05ca\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-mirror/diagnostics.js\":\"55f0ec314e079ba3\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-mirror/fileSystemAccess.js\":\"5e7429d3b1c05f79\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-mirror/filenames.js\":\"a653b939e62c4c68\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-mirror/index.js\":\"eac16e0306f8d6fe\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-mirror/mirror.js\":\"843b79723a6e787b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-mirror/runLock.js\":\"831ba8c5f19260c5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-mirror/runtimeHealth.js\":\"570dc4ed2cdee62d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-mirror/schedule.js\":\"589d5fc7be53ee4e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/db-mirror/store.js\":\"24b1584faff41fe7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/default-themes/index.js\":\"e3e65a5985877211\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/default-themes/themes.js\":\"74582424f03cf929\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/diagnostics/facet.js\":\"7900ed349ef27849\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/diagnostics/useDiagnostics.js\":\"80ab335392778bb3\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extension-prompts/dismissals.js\":\"e62c1f7411ef6387\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extension-prompts/index.js\":\"4c22e45800de4b44\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extension-prompts/status.js\":\"a7de62a458975d96\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extension-prompts/store.js\":\"e2300176f91c9b5e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"69d59458e66bc4b5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extensions-settings/ExtensionsSettings.js\":\"76eef9fd8ec171ba\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extensions-settings/actions.js\":\"4d0b7e21c35aeebf\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extensions-settings/config.js\":\"09817e6d173da79d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extensions-settings/dataExtension.js\":\"058f6e6163fc8385\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extensions-settings/effect.js\":\"1c6b3f99eafe6703\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extensions-settings/index.js\":\"cf37f89dc0c603e2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extensions-settings/propertyEditorOverride.js\":\"3842ee47516dcf22\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extensions-settings/useToggleTree.js\":\"86a97b14a5552e33\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extract-type/ExtractTypeDialog.js\":\"9eec1ab080b60c25\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f4f9dfda98e639b5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extract-type/PropertyShapePicker.js\":\"c20bc65326aa1e1f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extract-type/action.js\":\"0ebbcbf538bcf212\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/extract-type/index.js\":\"b4db8fd89eddff13\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/find-replace/FindReplaceDialog.js\":\"1b667290d2d686b9\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/find-replace/HeaderItem.js\":\"713a009734638e4a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/find-replace/dataExtension.js\":\"8b8ed99fcb791d35\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/find-replace/index.js\":\"6fe2c27d1a53bef5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/find-replace/search.js\":\"9db9a62f69251ed2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/find-replace/toggleStore.js\":\"c44503246f235042\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/LocationPropertyEditor.js\":\"556d2bd426230ef3\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/MapView.js\":\"31c6e7850e4d1136\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/blockTypes.js\":\"fb5642c6a49e922b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/codeMirrorExtensions.js\":\"363b2428cf4742d6\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/createOrFindPlace.js\":\"cd50ae9239b16541\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/currentLocation.js\":\"66ffc0d6e64441bb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/dataExtension.js\":\"8b7c3a4e1ff73277\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/geoContentDecorator.js\":\"9c6d5ca682c1afbb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/googlePlacesClient.js\":\"e7546f6b02622aba\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/index.js\":\"394f860712fbae1c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/locationsPage.js\":\"609a26556fa8f22d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/mapViewport.js\":\"190ea9c132ca9ea2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/pickCurrentLocation.js\":\"4b458052ced0943d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/placeAutocomplete.js\":\"c953f2f3a83c02c0\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/placeNameCollision.js\":\"e2e9ee99361fcd71\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/properties.js\":\"d52ddc5a70d2b52a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/propertyEditorOverrides.js\":\"f2d9038c45017313\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/query.js\":\"b72d068dcdf80762\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/geo/usePlaceSearch.js\":\"b1b3f4f6ce15db7c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"998ed1b286d891ac\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"8f185144bf8b9122\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"81a4f77d4d9b4fbe\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/grouped-backlinks/config.js\":\"d03a380c40dccbc1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/grouped-backlinks/dataExtension.js\":\"000f6a8a9aae4a8e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/grouped-backlinks/facet.js\":\"05716d03879466c6\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/grouped-backlinks/grouping.js\":\"fad9311661dbb562\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/grouped-backlinks/index.js\":\"35c72785508061ed\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4cb6aee67b6590c2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/grouped-backlinks/query.js\":\"5fbeeba81ea1bf27\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/grouped-backlinks/resolveConfig.js\":\"6eae05224ef46bdb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c734de2365ead216\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"5be8ab498457953d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/html-document/HtmlDocumentContent.js\":\"6ecf83c276d7a3a4\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/html-document/HtmlFrame.js\":\"4a5e05d5dbe48c2b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/html-document/actions.js\":\"c87e17d1fced455e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/html-document/blockType.js\":\"8b961e17fe58a74d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/html-document/confirmRunScripts.js\":\"2532fc8be685ec1f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/html-document/dataExtension.js\":\"0dbfb68af98ad1bf\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/html-document/frameAnnotations.js\":\"2b742b67f057de53\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/html-document/frameDocument.js\":\"a5bcedf098d59d3f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/html-document/frameTheme.js\":\"7ee2c259d29a9e5b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/html-document/index.js\":\"e0db4965e8e28a45\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/html-document/scriptConsent.js\":\"3609c5493fbf1520\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/html-document/sourceMap.js\":\"2dfc0a99862cacbd\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/html-document/useDocumentScripts.js\":\"b9fe4d68fa1937ea\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/interaction-metrics/index.js\":\"7e842870e9cb6aea\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/interaction-metrics/record.js\":\"44d216c5c6708d7d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/interaction-metrics/recordStore.js\":\"5c570db55b6379fa\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/interaction-metrics/responsiveness.js\":\"fb481a23fec077b9\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/interaction-metrics/schedule.js\":\"0a7d4d0dcf876ba4\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/interaction-metrics/sessionContext.js\":\"da7dded37f5b34bc\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b64ba8611557fb6e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"550f8a479fdf55fc\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/keybindings-settings/actions.js\":\"413fb63d276a7b50\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/keybindings-settings/config.js\":\"a1e4e0d53caee6ed\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/keybindings-settings/dataExtension.js\":\"aff5a90f9fc2cecf\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/keybindings-settings/effect.js\":\"5dea7aaa161fbb0e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/keybindings-settings/index.js\":\"d64aad05b89502e5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/keybindings-settings/keyCapture.js\":\"a9048534416fc805\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/keybindings-settings/overrideStore.js\":\"fce83441126d61c0\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f8f04ba4f8c17a59\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/left-sidebar/HeaderItem.js\":\"13f7c7adc0b5b253\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/left-sidebar/LeftSidebar.js\":\"95113dc8475be14a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/left-sidebar/actions.js\":\"fd1c3891330ae5bb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/left-sidebar/facet.js\":\"f9069a3cde1319cb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/left-sidebar/index.js\":\"6ca1693dc74ef93d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/left-sidebar/shortcuts.js\":\"39cce915ebdb58e4\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/left-sidebar/toggleStore.js\":\"beaf61625c6bb222\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/merge-blocks/MergePicker.js\":\"f79af9e6c6b70bac\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/merge-blocks/index.js\":\"dcccab31684b5306\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/merge-blocks/mergeAction.js\":\"104fe67c8698f394\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/merge-blocks/strategy.js\":\"2c87d90487b6f9f3\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/mobile-bottom-nav/Button.js\":\"38d72b295baedb73\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e4b1569803622ddf\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/mobile-bottom-nav/defaultItems.js\":\"926629d932b594a1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/mobile-bottom-nav/facet.js\":\"a39304832ff8ff9d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/mobile-bottom-nav/index.js\":\"9974a24bd65ef110\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"83258387e99227eb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/mobile-keyboard-toolbar/actions.js\":\"67599e40802fbb5b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f55cb657773b6ddc\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/mobile-keyboard-toolbar/facet.js\":\"7fdec73265f4e362\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/mobile-keyboard-toolbar/index.js\":\"e680bf61d07a36fc\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f42ecbc9d2b30ed4\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d90dd52fb1daede9\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/move-blocks/contextMenuItem.js\":\"39600cfe6aa8a98e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/move-blocks/index.js\":\"d256822ceb719406\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/move-blocks/moveAction.js\":\"46b956e89c275ebe\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/move-blocks/moveBlocks.js\":\"02b06759dfd67b13\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/move-blocks/selectionAfterMove.js\":\"f6595531e9f49a55\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/onboarding/TutorialBanner.js\":\"5e59438c1786525f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/onboarding/action.js\":\"94a38f1933ba7bdc\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/onboarding/bannerDismissal.js\":\"02eee00a8705fc6e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/onboarding/documents/cheatSheet.js\":\"2391a700808ad406\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/onboarding/index.js\":\"9d2a86974af596a5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/onboarding/keys.js\":\"800cf2543be493b7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/onboarding/landing.js\":\"a4ec118350670e7b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/onboarding/outline.js\":\"97e6f61e3a622e75\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/onboarding/seed.js\":\"011fb526297de9fd\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/perf-monitor/PerfTrendDialog.js\":\"c0ca7acff697966d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/perf-monitor/analyze.js\":\"7395e1ba407375f7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/perf-monitor/diagnosticsSource.js\":\"8102a62af75566e5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/perf-monitor/index.js\":\"aa2761c88da21548\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/perf-monitor/load.js\":\"8775e5f690d52e28\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/perf-monitor/monitorRun.js\":\"1668fbf0b51034b7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/perf-monitor/schedule.js\":\"156ded55e5182443\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/perf-monitor/series.js\":\"7a425a6c4f8935cb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/perf-monitor/store.js\":\"abb32e6514874d62\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/perf-monitor/trendAction.js\":\"d623a3f4a1260294\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/perf-monitor/verdict.js\":\"aa1916e5552577ed\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/plain-outliner/clickToEditAction.js\":\"fac6303cf808e026\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/plain-outliner/index.js\":\"47b77eada543043a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/plain-outliner/interactions.js\":\"57917c894e811702\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5c451666e197ced8\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/properties-migration/MigrationGate.js\":\"4a37ae945b2f4f31\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/properties-migration/MigrationGateDialog.js\":\"c8d3b0c5283d8e2d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/properties-migration/action.js\":\"a3bc48f815e59080\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/properties-migration/index.js\":\"cfbff8d743c0a424\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/properties-migration/localRunMessage.js\":\"e78b8706cb663d96\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/properties-migration/plugin.js\":\"71c7dcc16667a5ba\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/properties-migration/progressReport.js\":\"0911af0dbea8ce97\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/properties-migration/sweepProgress.js\":\"15e029ba9c10a29b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/property-rows/FieldRowRenderer.js\":\"f8f7af902fa6e7e7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/property-rows/ValueRowRenderer.js\":\"28db9c2b45c58912\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/property-rows/actions.js\":\"0cb3bd6fee80dbcb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/property-rows/autocomplete.js\":\"761bb1d28985f3e2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/property-rows/fieldRow.js\":\"b002a90f769b0746\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/property-rows/index.js\":\"d23894e20f4b8611\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/property-rows/referenceWarning.js\":\"a29f9fa6966748b6\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/property-rows/valueAutocomplete.js\":\"d90fa9aa43c4b7f9\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/property-rows/valueSchema.js\":\"dfeba8898c583f45\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/quick-find/HeaderItem.js\":\"979f49d743f366ff\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/quick-find/QuickFind.js\":\"a358f3be1b2ab9f6\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/quick-find/index.js\":\"0bd46f05774c0f1a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/quick-find/recents.js\":\"aa8505aed3d63293\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/quick-find/resultItems.js\":\"a6271614ead71420\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/quick-find/selection.js\":\"4ad1b5be8a60da50\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/quick-find/toggleStore.js\":\"af4e00883f946576\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/recents/HeaderItem.js\":\"1caef85044f4969b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c488936e1c3e8cb9\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/recents/grouping.js\":\"1ac92d6fc5f56a4c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/recents/index.js\":\"f7ac416271b3a910\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/recents/target.js\":\"b3e35e5aa9350bb1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/codeMirrorExtensions.js\":\"49f092e16b0d1086\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/contentPrefill.js\":\"770cedecdf633a55\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/dataExtension.js\":\"da929d0efb5af954\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/index.js\":\"410fd100c700b062\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"19c2399e6274db66\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/invalidation.js\":\"6c6ab99bdea72789\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/localSchema.js\":\"963011073fa5e7bd\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/markdown/blockrefs/index.js\":\"94bf0cacaa21a26e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"15c3aa78ca14d381\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/markdown/index.js\":\"c2bdf069f366d3b1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/markdown/referenceNode.js\":\"be1fce3277d891bd\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/markdown/remark-reference-occurrences.js\":\"83ef26086c75406c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c360d9eb45abf247\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/markdown/wikilinks/index.js\":\"c889edfd0fb8fc32\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"d313f0dfc10fbbdb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2875b3ba610193de\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/mergeRetargetProcessor.js\":\"f77184cd0ea22fa0\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/parseFence.js\":\"1931e16e86d28423\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/referenceParser.js\":\"023dd6a6b08791ac\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/referenceProjection.js\":\"f8322cf051ce11ef\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/referencesProcessor.js\":\"7a475ea72aa231ac\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/renameProcessor.js\":\"58bbb78f168aaab3\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/references/spanReplacement.js\":\"95841c2e9bb9f51b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/rich-paste/htmlToOutline.js\":\"4c4a3775674d296b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/rich-paste/index.js\":\"3623ad041c5ea816\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/rich-paste/normalizeClipboardDom.js\":\"3d8a983fbdfab2e8\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/rich-paste/pasteDecision.js\":\"b3b7e995747305cf\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/action.js\":\"b928116ab14a52ed\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/blockIds.js\":\"90120c5f7bda1548\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/content.js\":\"d0999b8bb9f63ba2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/effect.js\":\"f0ea765c2021bfff\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/ids.js\":\"24df0bd1186af675\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/import.js\":\"df7a947baa857f6b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/index.js\":\"8bc5f532045c4b26\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/plan.js\":\"4c7ba3151a9cff1c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/plugin.js\":\"fe42a6aa0fef4561\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/promotion.js\":\"9ccd7823657903b3\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/properties.js\":\"70b9a1c94eba2b37\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/references.js\":\"1a87931ad3aa4a2c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/report.js\":\"87882c338adbed1d\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/roamMemo.js\":\"2b669905415d5b9f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/runtime.js\":\"0043be163d7104f7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/schemaReconciliation.js\":\"af98c9a80aecd9f7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/srsMarkers.js\":\"621688b5ade69603\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/todo.js\":\"9e0254b5ba3e3d46\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/typeCandidates.js\":\"2af27ece14180ce1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/roam-import/types.js\":\"343a9f8eda78e33c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/search-health/index.js\":\"78c42746a1787369\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/search-health/store.js\":\"bb96f989d241f550\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/shortcut-help/HeaderItem.js\":\"93347d1b9f630f9a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"93d9d0940b086e07\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/shortcut-help/index.js\":\"fc94e9d65676b4b4\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/shortcut-help/model.js\":\"e556697b558fa20a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/shortcut-help/toggleStore.js\":\"3b3f8b3e4b08f42a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/shortcut-help/useKeyInspector.js\":\"50270b1de9f8c66c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"649a61b0786c9aa2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/spatial-navigation/ShellDecorator.js\":\"df25a6c80379789e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/spatial-navigation/actions.js\":\"61515145f1bfa5f6\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/spatial-navigation/exclusionsFacet.js\":\"6e4751f1c2fd932e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/spatial-navigation/index.js\":\"994482b4b0a469b9\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/spatial-navigation/shell.js\":\"04adcb181abd5eb4\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/spatial-navigation/surface.js\":\"c6c45eeb7404eaca\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/spatial-navigation/walker.js\":\"d9baa1c314b8d949\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-rescheduling/RescheduleToast.js\":\"eeb642bec8211821\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-rescheduling/dataExtension.js\":\"c58f9bc6d14e07b8\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-rescheduling/index.js\":\"4d01cea70eb89767\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-rescheduling/indicator.js\":\"7d5fbcdf1da5a774\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-rescheduling/moveSrsState.js\":\"4b416eec577cae88\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"93ff7a1f521c42da\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-rescheduling/scheduler.js\":\"0b28d196297b5274\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-rescheduling/schema.js\":\"7597594dbebf48de\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"72f4f4bef8408ae2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-rescheduling/srsClipboard.js\":\"7fce3651d20c095a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5b9bfb8026a3533a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/DailyNoteReviewHint.js\":\"cec564f5e7f07093\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/DeckPicker.js\":\"1ba413ce22aa4927\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/ReviewControls.js\":\"b3c462533b4e2c7a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6bc159a69198e4ef\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/ReviewSession.js\":\"df5a309ec7a089d3\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/actions.js\":\"973f3357146ecd00\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/archive.js\":\"a1ad102eec12fcab\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/dataExtension.js\":\"4e874592db7705c8\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/deck.js\":\"10b2c32ee3ae0a1f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/dueQuery.js\":\"f2fd585e07d40315\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/gradeDecision.js\":\"90e58071f39ae4f1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/index.js\":\"a0ed2d61f1b6b387\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/keyHints.js\":\"2f262bf7e2f07363\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/reviewCardLayout.js\":\"d76fd3d8faba6a5f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/reviewProgress.js\":\"2c77cc899c7d1b76\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/schema.js\":\"aef68b0917ce2322\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/srs-review/useDueCards.js\":\"9d2366865324a640\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/startup-metrics/index.js\":\"0be0dd12926b55d8\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/startup-metrics/record.js\":\"8d7a966651e50b21\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/storage-persistence/index.js\":\"262be6c16dc53a90\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/storage-persistence/persistenceStatus.js\":\"b9284a8b7debc487\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/storage-persistence/requestAction.js\":\"a2069e55da507e3f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/supertags/TypeChipsDecorator.js\":\"a99714c807af4e14\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/supertags/codeMirrorExtensions.js\":\"0400c2566cc247d2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/supertags/index.js\":\"ead8bcb1295cc892\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/supertags/typeAutocomplete.js\":\"ea1a631fbe3470c4\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"69bdeb78b4f67818\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/swipe-quick-actions/actions.js\":\"9e6b74daf8e7dccd\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/swipe-quick-actions/anchor.js\":\"cd40117f007dab59\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/swipe-quick-actions/events.js\":\"6b3c9a6d3ee21c9e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/swipe-quick-actions/gestureActions.js\":\"acd7e92ade58ef31\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/swipe-quick-actions/index.js\":\"c985313725c1d26c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"c309bf458f4c8d38\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/sync-metrics/collect.js\":\"261ad8545ae8bfd1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/sync-metrics/index.js\":\"b421502768373c7e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/sync-metrics/record.js\":\"6393435717b33b28\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/system-status/RejectionDialog.js\":\"edc5de736fc87e5c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/system-status/SystemStatusHeaderItem.js\":\"f6b0a8c2e148e1f2\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/system-status/index.js\":\"e6ccc0f3432b601f\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/system-status/model.js\":\"b8a29a023ea89577\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/system-status/queueCounts.js\":\"9d5cbd6def9741da\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/system-status/rejectedHelpers.js\":\"905142b1635d8815\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/system-status/rematerializeAction.js\":\"144dd3b7f250efd7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/system-status/useHysteresis.js\":\"3ffb62660203c9cc\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/ColumnHeaders.js\":\"f0c9b27512e81d8e\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/QueryUi.js\":\"0cfacd2bfe030c40\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/TableLayout.js\":\"5a9c97c11685c826\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/actions.js\":\"e6d791a5a462c464\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/cellEdits.js\":\"ce86647f83528799\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/childrenViews.js\":\"2a2d09087af99cc1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/columns.js\":\"12275402bbd546dd\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/controller.js\":\"d9135e104c0f61e3\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/convert.js\":\"e23c189e9d267023\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/dataExtension.js\":\"8f88ace9fc272231\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/index.js\":\"cbd33f62d8e4fdda\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/keys.js\":\"b51e7900b9698258\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/model.js\":\"65053b9a01b6d192\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/query/backfill.js\":\"561641365d00bd28\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/query/completion.js\":\"4198a804c51e751b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/query/format.js\":\"86b153342361dd75\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/query/parse.js\":\"a796a2fed1a9b467\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/query/queryValue.js\":\"80c26c084e77b784\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/query/source.js\":\"6acbc3fb2b1a2a39\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/registry.js\":\"6164a61e247136e7\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/rowGutter.js\":\"ceb48b250f673e95\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/rowVerbs.js\":\"f8ffade0a77fb49c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/schema.js\":\"aac2711260c76c84\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/tables/sort.js\":\"d83bad06e80df767\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/theme-toggle/effect.js\":\"8c7088758b561476\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/theme-toggle/index.js\":\"93c4517e96901e59\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/theme-toggle/theme.js\":\"7d2bd84b803d0666\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/todo/actions.js\":\"7fb1e1ee53934e04\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/todo/dataExtension.js\":\"69acdb32d8acc816\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/todo/index.js\":\"6230578242d22685\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/todo/schema.js\":\"d1b8bc7fc3c36e53\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/touch-selection/TouchSelectionLayer.js\":\"30c3108ac04d0afe\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/touch-selection/actions.js\":\"7356bb78c72dda6a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/touch-selection/defaultItems.js\":\"3f76c1fa0889d7a9\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/touch-selection/facet.js\":\"a4cf17d1a794bbcb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/touch-selection/holdRecognizer.js\":\"2f5b1372b6d01731\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/touch-selection/index.js\":\"3e80a6fa663bb97c\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/update-indicator/UpdateIndicator.js\":\"204041cc1d3b9aa1\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/update-indicator/index.js\":\"1f56bab39d6854e5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/update-indicator/loadTimes.js\":\"aa0f5f2fcdc9c269\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/video-player/VideoNotesRenderer.js\":\"d4fbc26c9773eb07\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/video-player/VideoPlayerRenderer.js\":\"d58dfd0aec6132a9\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/video-player/VideoTimeStamp.js\":\"505d9b91f027ad44\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/video-player/actions.js\":\"b77ef656215a25eb\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/video-player/index.js\":\"53414d9a93bb5638\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/video-player/markdown.js\":\"1355bf50f96f7972\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/video-player/notes.js\":\"a4fe70c1c4ccb4e5\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/video-player/registry.js\":\"73dfeb2c92af5743\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/video-player/remark-timestamps.js\":\"61538e537c8ca286\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/video-player/view.js\":\"a39c122350c4e176\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/vim-link-hints/LinkHints.js\":\"dee28535488fd19a\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/vim-link-hints/index.js\":\"e29079d43f973780\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/vim-link-hints/model.js\":\"e2551516c0ab142b\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/vim-link-hints/settings.js\":\"aed26b5640b71513\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/vim-normal-mode/actions.js\":\"e13accc54b232b06\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/vim-normal-mode/index.js\":\"1de6fcd38f0de2e3\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/vim-normal-mode/interactions.js\":\"5627181fbf25fbc8\",\"/knowledge-medium/pr-preview/pr-1873/src/plugins/workspace-header/index.js\":\"15de5ad2308cf5ee\",\"/knowledge-medium/pr-preview/pr-1873/src/registerServiceWorker.js\":\"574e476f08c64e8d\",\"/knowledge-medium/pr-preview/pr-1873/src/requestPersistentStorage.js\":\"26de9c454b6275ed\",\"/knowledge-medium/pr-preview/pr-1873/src/services/authRequestDeadline.js\":\"2919b533e24b4f5d\",\"/knowledge-medium/pr-preview/pr-1873/src/services/authStorage.js\":\"eb395611ad9918b1\",\"/knowledge-medium/pr-preview/pr-1873/src/services/powersync.js\":\"154fe36fca979950\",\"/knowledge-medium/pr-preview/pr-1873/src/services/supabase.js\":\"9c74d0e2df54b083\",\"/knowledge-medium/pr-preview/pr-1873/src/services/uploadErrorClassifier.js\":\"0f4dbfe108f356e8\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/ActiveContexts.js\":\"5627ef3294c1057e\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/HotkeyReconciler.js\":\"c58993388a10ac43\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/WipeLocalDataDialog.js\":\"4a2ce75d038637fa\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/actionDispatch.js\":\"3f4d1107d24f0c7e\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/actionRefItems.js\":\"222d20bcdfadd6ad\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/applyKeybindingOverrides.js\":\"704141aab4f668f3\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/blockActions.js\":\"50f324cca4951473\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/blockMergeGesture.js\":\"b43fbbb7aa1ee509\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/canonicalizeChord.js\":\"7fc4ddcca2c36e79\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/defaultContexts.js\":\"b76e2b4740097e6d\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/defaultShortcuts.js\":\"6006f45682559a94\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/effectiveActions.js\":\"44af3c1d65544145\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/gestureAction.js\":\"b8fe26f881734d73\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/gestureBinding.js\":\"a64844a8145cc330\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/holdRegistry.js\":\"4cc33cb6feb53776\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/keybindingConflicts.js\":\"c38131863a9559b0\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/keybindingOverrides.js\":\"682349e7ae8ff6f4\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/pointerAction.js\":\"93dbc381a78aae64\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/resolve.js\":\"c99b4acdfd84dd42\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/runAction.js\":\"b7d1484f6cfcfc67\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/sequenceMatcher.js\":\"ef355a8ece083b0b\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/types.js\":\"e24f1ec57f3be8b4\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/useActionContext.js\":\"4589da94f793f164\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/useActionDiscovery.js\":\"7be1966315c7ea9a\",\"/knowledge-medium/pr-preview/pr-1873/src/shortcuts/utils.js\":\"f2274258db0f0df8\",\"/knowledge-medium/pr-preview/pr-1873/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1873/src/sw/bootStore.js\":\"f90317265dcd5f8b\",\"/knowledge-medium/pr-preview/pr-1873/src/sw/previewDatabases.js\":\"eca3ec327ce92f6a\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/byteTransform.js\":\"fb20713e498740c1\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/attachmentCleaner.js\":\"ce4814d4b1cd4c8e\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/bundle/attachmentParts.js\":\"ca118152381b017a\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/bundle/bundleParts.js\":\"2a1f643a9cc67506\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/bundle/bundleRecord.js\":\"dc951e3cc0e5d42d\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/bundle/manifest.js\":\"e58a6b61f45ed0a0\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/bundle/takeBundle.js\":\"b0c68a740660c757\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/bundle/verifyBundle.js\":\"4760b65ee3bd427f\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/cleaningStage.js\":\"0d050b96aca421a1\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/conversionKey.js\":\"4740c2071e85b6e7\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/conversionServer.js\":\"31228352a7aeda06\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/flip.js\":\"b23c4c62493a16f1\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/flipAttempts.js\":\"33d275f3d5e2ff90\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/pages.js\":\"33d8a69919b43a09\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/preflight.js\":\"d7c10858d7ae4065\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/reseal.js\":\"7c9cc8e525dc676d\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/runConversion.js\":\"4218127ba0b12bf3\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/runLock.js\":\"9b889236b5289cbc\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/sealing.js\":\"faea11a8e9792ded\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/sealingStage.js\":\"cf5bd77a85d69627\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/stage.js\":\"d90b63d9bcded0d7\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/conversion/verifyReseal.js\":\"560a7f75056513a2\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/aad.js\":\"c4fa355da5979be6\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/aead.js\":\"796e97121d093742\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/base32.js\":\"4b36db4bb724b770\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/base64url.js\":\"3685d7f574ff64fe\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/binaryEnvelope.js\":\"48a265d79b8f40ac\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/byteAead.js\":\"51914f2a3fcca959\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/canary.js\":\"cacbe99bc6f6f9a6\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/contentHash.js\":\"41de4aa0ea2369e7\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/contentKey.js\":\"27a7d2bbb3550b9d\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/derivedIdNamespace.js\":\"ee6de5c903249263\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/envelope.js\":\"ef329994d82b6ca0\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/hex.js\":\"8ac604a17fd4d717\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/sha256Hex.js\":\"eedc119b50d78c75\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/crypto/workspaceKey.js\":\"fa0364fd81730f58\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/keys/conversionState.js\":\"4f5758d85552ae4c\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/keys/flows/createEncryptedWorkspace.js\":\"5b71eec60bae7e31\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/keys/flows/pastedKey.js\":\"115fa89257f15dc7\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2b8a5369e10b62dd\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/keys/flows/upgradeWorkspacePin.js\":\"29296e9adc56b56c\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/keys/keyStore.js\":\"fc3af4dd269964e4\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/keys/mintWorkspaceKey.js\":\"5503f27e7bf8bb56\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/keys/modePin.js\":\"8ba3f5a9beaa0abc\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/keys/openWorkspaceKeys.js\":\"64641af2bf2a1775\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/keys/resolveWorkspaceEntry.js\":\"bf13c5dc573094fa\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/keys/resolver.js\":\"8b51976ce49286ff\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/keys/workspaceAccess.js\":\"74455f0d458421d8\",\"/knowledge-medium/pr-preview/pr-1873/src/sync/transform.js\":\"991a6ba506c479ae\",\"/knowledge-medium/pr-preview/pr-1873/src/themeBootDefaults.js\":\"3e1530fded8f6d18\",\"/knowledge-medium/pr-preview/pr-1873/src/types.js\":\"0ffe7e94e028a597\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/ClientLocalSettings.js\":\"6a4783880b98be01\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/abortableSleep.js\":\"78db73333754f525\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/array.js\":\"72257f9722e40ecd\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/backlinkAutocomplete.js\":\"4141941848491123\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/blockCrumbs.js\":\"a5eec81dade3560a\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/blockrefAutocomplete.js\":\"a9ba39c1e729db54\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/cadencedIdleJob.js\":\"bde21a1bb3d77b41\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/callbackSet.js\":\"5edbd3961be685af\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/clientId.js\":\"5d550e40bfd75730\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/codemirror.js\":\"48383a097fb1c3fb\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/codemirrorCompletion.js\":\"0f5bed34955e9605\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/copy.js\":\"2cacda4df4e41426\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/dailyPage.js\":\"4bd6cfa10bfa3fd9\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/dbForensics.js\":\"c48489a2b368fa36\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/dbForensicsHooks.js\":\"d98bce3228e96a11\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/deleteBlockThroughUi.js\":\"55cad1a679f18239\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/dialogs.js\":\"adf6272f4601d12c\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/dom.js\":\"e32f7dc9fedf80b8\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/downloadBlob.js\":\"e514814ed929563c\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/drawnWalk.js\":\"f3ae8893b2067da5\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/exportSqliteDb.js\":\"3c932cca68072182\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/fileSystemAccess.js\":\"50ac1048bf8ab0f7\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/flipSlide.js\":\"ddf6b52c7592e6f0\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/fnv1a.js\":\"a67ce6990cb838ab\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/formatBytes.js\":\"50c5013c2a1ff465\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/fuzzyRank.js\":\"8f12fb6900f2bef0\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/idbKeyedStore.js\":\"a6eceaaf3cd77a98\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/idleCallbackPolyfill.js\":\"e03a8c0e3094edf2\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/keyboardAwareScroll.js\":\"643f82e8f0b804fc\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/keyboardViewport.js\":\"b2b6b7104e68990d\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/lastWorkspace.js\":\"a9931b138d77aa2c\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/layoutColumns.js\":\"e1c463d947a4f82e\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/layoutSessionDom.js\":\"914ba764fae99470\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/layoutSessionId.js\":\"d9f80efd2e86087a\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/linkClickGestures.js\":\"59a3d70301dd9fcd\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/linkTargetAutocomplete.js\":\"4973205f5134fbcd\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/localDbCorruption.js\":\"c834d3e2a921e199\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/localDbRecovery.js\":\"9d6fb5bb2a9b8817\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/markdownParser.js\":\"0d4790acfc01deea\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/memoize.js\":\"80e68f09a56b9689\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/nameFieldCommit.js\":\"2478c83829c7c68c\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/nameList.js\":\"8c9d8c8ad6337f49\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/navigation.js\":\"0c3a4ab3b270654a\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/omnilinerNamespace.js\":\"9354a684cb3d07a1\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/opfsPageScan.js\":\"e588584f57c7b2db\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/panelClearance.js\":\"3db110e27101f1d3\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/panelHistory.js\":\"f83980e6f376b267\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/panelLanes.js\":\"11f448736778e63c\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/panelLayoutProjection.js\":\"38a01935ffcd1abf\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/panelScrollAnchor.js\":\"6d47301bd89e2596\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/panelUrlFlags.js\":\"70bc783bbdcfc47d\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/platform.js\":\"bd2f2ad3860bec19\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/pluralize.js\":\"a922c9c719ae699c\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/propertyCreation.js\":\"7e0f919a9b807be5\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/propertyNavigation.js\":\"71202ff3e1fb2a80\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/propertyValueContext.js\":\"6f0dce4f681e0a04\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/react.js\":\"5ef3d8b1a04e4947\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/relativeDate.js\":\"265b9dd26666820b\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/relativeTime.js\":\"d078011cac50dcf6\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/renderScope.js\":\"b872f3f3dbfd34c9\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/resolvedThenable.js\":\"20c020ebbe3ae45e\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/routing.js\":\"6786829348967a76\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/safeMode.js\":\"8df3d988cbd8e59c\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/scheduleIdle.js\":\"67d20542b9456675\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/screenWakeLock.js\":\"c8f70039f6e484ce\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/selection.js\":\"a66e1852ec698b7e\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/softKeyboardGrab.js\":\"b3dd70b041bca8ed\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/startupTimeline.js\":\"8f9e426ba8b4fb26\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/state.js\":\"68e717b5bfc8e37f\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/string.js\":\"c4de190bab479ac1\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/surfaceZoom.js\":\"7ee5116bca6d2a93\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/time.js\":\"1187168d6a82feb6\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/toast.js\":\"b0d0000f1ddf9646\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/toggleStore.js\":\"f1f20189b381a8ba\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/untilStopped.js\":\"bfba07bdecbb70be\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/userActivity.js\":\"693bf4832bafbf2c\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/viewTransition.js\":\"e8fc56e202de9162\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/viewport.js\":\"b0bf7f5f8f4e6862\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/webLock.js\":\"7032ebbe79c32610\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/workspaceRecovery.js\":\"33d57536862e9a48\",\"/knowledge-medium/pr-preview/pr-1873/src/utils/workspaceSnapshotStore.js\":\"19b577c3e05d534d\",\"/knowledge-medium/pr-preview/pr-1873/src/vendor/react-compiler-runtime.js\":\"7fa7c6329dde513e\",\"/knowledge-medium/pr-preview/pr-1873/src/vendor/react-dom-client.js\":\"d4543635ef166b88\",\"/knowledge-medium/pr-preview/pr-1873/src/vendor/react-dom-server-edge.js\":\"ca5ca2458d7bd049\",\"/knowledge-medium/pr-preview/pr-1873/src/vendor/react-dom-server.js\":\"0494ec87308bb93f\",\"/knowledge-medium/pr-preview/pr-1873/src/vendor/react-dom-static-edge.js\":\"8f4d66065ed9958d\",\"/knowledge-medium/pr-preview/pr-1873/src/vendor/react-dom-static.js\":\"9f5e1cbbe2b33a42\",\"/knowledge-medium/pr-preview/pr-1873/src/vendor/react-dom-test-utils.js\":\"17a211e145e7374d\",\"/knowledge-medium/pr-preview/pr-1873/src/vendor/react-dom.js\":\"7e21b1dbcd9ffd99\",\"/knowledge-medium/pr-preview/pr-1873/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1873/src/vendor/react-jsx-runtime.js\":\"7e4aee947e034ed4\",\"/knowledge-medium/pr-preview/pr-1873/src/vendor/react.js\":\"24a783509d395422\",\"/knowledge-medium/pr-preview/pr-1873/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1873/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1873/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
