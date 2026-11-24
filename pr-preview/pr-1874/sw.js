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
		buildId: "345683c2b4ac-0a41fd3a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1874/\":\"f3d094eafb55462e\",\"/knowledge-medium/pr-preview/pr-1874/index.html\":\"f3d094eafb55462e\",\"/knowledge-medium/pr-preview/pr-1874/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1874/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1874/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1874/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1874/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1874/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1874/app.css\":\"141c7ab4732fe1ad\",\"/knowledge-medium/pr-preview/pr-1874/assets/FacadeVFS-DvRy7WC5.js\":\"53ed24c4cd823b88\",\"/knowledge-medium/pr-preview/pr-1874/assets/OPFSCoopSyncVFS-Bil_SCCj.js\":\"ac755e9d10c4055c\",\"/knowledge-medium/pr-preview/pr-1874/assets/OPFSWriteAheadVFS-BsEy7Zxk.js\":\"e536613ff3629593\",\"/knowledge-medium/pr-preview/pr-1874/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1874/assets/wa-sqlite-TOTH2Jnh.js\":\"33ff5a3c08cda943\",\"/knowledge-medium/pr-preview/pr-1874/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1874/assets/wa-sqlite-async-B6vO9MmG.js\":\"209fdce3bbfea13c\",\"/knowledge-medium/pr-preview/pr-1874/assets/worker-C7le3Clj.js\":\"5382ba3723625ede\",\"/knowledge-medium/pr-preview/pr-1874/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1874/chunks/app-nFcAqr3t.js\":\"992e2e2a55b36a42\",\"/knowledge-medium/pr-preview/pr-1874/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1874/index.js\":\"791da0ec4307c014\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1874/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1874/assets/AccessHandlePoolVFS-DCj9ZRk2.js\":\"0d02443a1f2e391c\",\"/knowledge-medium/pr-preview/pr-1874/assets/IDBBatchAtomicVFS-hMbdUTkK.js\":\"8a31c63e74265434\",\"/knowledge-medium/pr-preview/pr-1874/assets/MemoryVFS-Rwzb432g.js\":\"828b19503cfa8f89\",\"/knowledge-medium/pr-preview/pr-1874/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1874/assets/mc-wa-sqlite-async-Bp-mI1vu.js\":\"8df1216ac7f5a946\",\"/knowledge-medium/pr-preview/pr-1874/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1874/assets/mc-wa-sqlite-fmiEloNN.js\":\"ea51e42fbbf3ec01\",\"/knowledge-medium/pr-preview/pr-1874/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1874/chunks/AccessHandlePoolVFS-I9fmE8X-.js\":\"7d0939621e26cf23\",\"/knowledge-medium/pr-preview/pr-1874/chunks/FacadeVFS-lmkHBEqf.js\":\"2e34f7b4c87d9052\",\"/knowledge-medium/pr-preview/pr-1874/chunks/IDBBatchAtomicVFS-Df4ZnC82.js\":\"426fa7fbdfe428a1\",\"/knowledge-medium/pr-preview/pr-1874/chunks/MemoryVFS-B8tkiURO.js\":\"dc40f69ca9691098\",\"/knowledge-medium/pr-preview/pr-1874/chunks/OPFSCoopSyncVFS-CFPNmyOg.js\":\"44b38fd28f60ba94\",\"/knowledge-medium/pr-preview/pr-1874/chunks/OPFSWriteAheadVFS-CCkXigrV.js\":\"ef0f46e88c9f9761\",\"/knowledge-medium/pr-preview/pr-1874/chunks/Preview-C_v7dEid.js\":\"a8de633baec8e327\",\"/knowledge-medium/pr-preview/pr-1874/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1874/chunks/card-CkK5GiDa.js\":\"b356fef7825d67ac\",\"/knowledge-medium/pr-preview/pr-1874/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1874/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1874/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1874/chunks/dist-K1fKr7l2.js\":\"3a5007483fecfe52\",\"/knowledge-medium/pr-preview/pr-1874/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1874/chunks/mc-wa-sqlite-BAe_AjMO.js\":\"55e332d0669ddc39\",\"/knowledge-medium/pr-preview/pr-1874/chunks/mc-wa-sqlite-async-orcUPvJU.js\":\"0fd23757314e9899\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-BY8RcUBX.js\":\"a47dca354f94a6a5\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-BcgdhIgM.js\":\"0557d34fe0647f51\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-CWM2Uwii.js\":\"bf564a252fd13f44\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-CngiC4ve.js\":\"f307fbd05e0fb252\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-DKW6NIxM.js\":\"a09df2672f00089c\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-Dk9xyTZv.js\":\"d894970ef837c15b\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-GqDCkONv.js\":\"3047a76cc3c4b0cf\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-dom-server-legacy.browser.production-DSczLxgr.js\":\"740f00ebd66cf209\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-dom-server.browser.production-B2dLBCip.js\":\"97a57dd37901736d\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-dom-server.edge.production-BjpiSvQu.js\":\"9a9a6fc097773c61\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-tOJ9KaUo.js\":\"3de42ce9c800f80f\",\"/knowledge-medium/pr-preview/pr-1874/chunks/server.browser-B0Dw_byC.js\":\"74689e214dd37ef7\",\"/knowledge-medium/pr-preview/pr-1874/chunks/textarea-BsCLZ0W0.js\":\"764ecac3f124dd4b\",\"/knowledge-medium/pr-preview/pr-1874/chunks/ui-C0ygoCkH.js\":\"c4df89b084f56c35\",\"/knowledge-medium/pr-preview/pr-1874/chunks/wa-sqlite-async-BO2sesM0.js\":\"be899fd9baf2bd6a\",\"/knowledge-medium/pr-preview/pr-1874/chunks/wa-sqlite-mHF7P0lO.js\":\"e88e4ce54e95af65\",\"/knowledge-medium/pr-preview/pr-1874/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1874/extension-utilities.css\":\"1a2b9a89fd3a3bea\",\"/knowledge-medium/pr-preview/pr-1874/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1874/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1874/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1874/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1874/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1874/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1874/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1874/src/App.js\":\"47e1816d018aa41c\",\"/knowledge-medium/pr-preview/pr-1874/src/appUpdate.js\":\"99be683adce3b590\",\"/knowledge-medium/pr-preview/pr-1874/src/appVersion.js\":\"83a687a2037a7639\",\"/knowledge-medium/pr-preview/pr-1874/src/bootstrap/initialLayout.js\":\"7b8fd050b99c7ee6\",\"/knowledge-medium/pr-preview/pr-1874/src/bootstrap/openWorkspaceData.js\":\"8b6988d3f5f87b46\",\"/knowledge-medium/pr-preview/pr-1874/src/bootstrap/resolveWorkspace.js\":\"1627c3d5ba725c59\",\"/knowledge-medium/pr-preview/pr-1874/src/bootstrap/workspaceBootstrap.js\":\"a50b1635e8181c17\",\"/knowledge-medium/pr-preview/pr-1874/src/components/BlockComponent.js\":\"3e74043103967237\",\"/knowledge-medium/pr-preview/pr-1874/src/components/BlockCrumbs.js\":\"261eb9e7029db9d9\",\"/knowledge-medium/pr-preview/pr-1874/src/components/BlockEditor.js\":\"d90a3920c6acb9f7\",\"/knowledge-medium/pr-preview/pr-1874/src/components/BlockLoadingPlaceholder.js\":\"78f0c33934fc3803\",\"/knowledge-medium/pr-preview/pr-1874/src/components/BlockProperties.js\":\"feb731d323fabf97\",\"/knowledge-medium/pr-preview/pr-1874/src/components/BlockSearchPicker.js\":\"1b74c0a94e97787e\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ConfirmBulkDeleteDialog.js\":\"1901f51571d71cd5\",\"/knowledge-medium/pr-preview/pr-1874/src/components/DividerHandle.js\":\"2559056bf63c9e23\",\"/knowledge-medium/pr-preview/pr-1874/src/components/DraftEditor.js\":\"74d22d6a638f3820\",\"/knowledge-medium/pr-preview/pr-1874/src/components/GutterPill.js\":\"5f87fdf0a7b84b7e\",\"/knowledge-medium/pr-preview/pr-1874/src/components/Header.js\":\"432447972543dfb9\",\"/knowledge-medium/pr-preview/pr-1874/src/components/LazyBlockComponent.js\":\"7675ebfb29a11796\",\"/knowledge-medium/pr-preview/pr-1874/src/components/Login.js\":\"de7204a2b547c0c1\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ZoomableSurface.js\":\"f7df51c5c2160852\",\"/knowledge-medium/pr-preview/pr-1874/src/components/editModeKeepalive.js\":\"2df8a3694beb2b4d\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyDisplay/PropertyDisplayScope.js\":\"df4274cfdf9dac54\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0d6048557a08535b\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/RefPropertyEditor.js\":\"4ea889252b082d3d\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/RefTargetTypePicker.js\":\"8125d17403a97389\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/SelectPropertyEditor.js\":\"38f701adbceb8154\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/TypesPropertyEditor.js\":\"5a5613c5f3d96b48\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/defaults.js\":\"584137be56ba4551\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/kernelValuePresets.js\":\"afb09d858ea48720\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/selectablePresets.js\":\"cc0c0657fbffe36b\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/typesPropertyUi.js\":\"a45cbb39d539d552\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/AddPropertyForm.js\":\"7f30674eebedd6bc\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/PropertyPicker.js\":\"7b33e8b19b1403a4\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/PropertyRow.js\":\"28a07239fd7d5cd3\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/Rows.js\":\"a3213f08fccbe8e2\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/actions.js\":\"90b766485c75b98c\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/declarationOnly.js\":\"8ba5192f075bc7a7\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/layout.js\":\"3d85d554f2c70e27\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/model.js\":\"550c932c66b18bef\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/shapeUi.js\":\"215fa0983ce32f17\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/shapes.js\":\"8a92d414949a8d62\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/usePropertyEditingActivation.js\":\"f0fc1b052e88e85c\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/visibility.js\":\"0c6934df1c84a751\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanelSections.js\":\"3586d6f28fccd938\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/BlockEmbed.js\":\"c6cdb4f843d81fee\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/BlockLink.js\":\"64a50049441931bd\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/BlockRef.js\":\"e551836192c48d33\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/ReferenceLink.js\":\"fc17c24dcc5f511a\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/cycleGuard.js\":\"4f80c12020ccd7bf\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/cycleGuardContext.js\":\"03250d372a6ca5a6\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/linkInteraction.js\":\"2c39a26e6b72c94d\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/referenceLayout.js\":\"2e21c67c9345ee58\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/useBlockRefAncestors.js\":\"ae9528e3cbd533e5\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/BlockGutter.js\":\"eb35dfcf00c5aed8\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/BlockInfoDialog.js\":\"2f6e8a316f345c6a\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/BlockTypeBlockRenderer.js\":\"6ab583be2f78ef82\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/BulletHoverCard.js\":\"0de46d6b6b395a0d\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/CodeMirrorContentRenderer.js\":\"92ae214c844c99cb\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2932b6694cb25c50\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/ColumnResizeHandles.js\":\"87e444d2c6a1c2fa\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b133fd538d88d60c\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/DefaultBlockRenderer.js\":\"5dcf35629fe52064\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/LayoutRenderer.js\":\"2e84f1dbf0895af4\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/MarkdownContentRenderer.js\":\"969e75046df2def0\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/MissingDataRenderer.js\":\"d5360b9866f1c66f\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/PanelRenderer.js\":\"0262c1daa455f819\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/PropertySchemaBlockRenderer.js\":\"dbb10ebb1e74b163\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/TopLevelRenderer.js\":\"0f7ed9908c24669c\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/blockGutterMode.js\":\"c9312f85b7bf1abf\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/blockTitleText.js\":\"f39ae65f4410b0d9\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/fieldCreationKeydown.js\":\"b31bee387d58f6f8\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/layoutRootContext.js\":\"ad73b7f1cf7cad62\",\"/knowledge-medium/pr-preview/pr-1874/src/components/typeChip/TypeChip.js\":\"f4dab4963c428d8d\",\"/knowledge-medium/pr-preview/pr-1874/src/components/typeChip/chipStyle.js\":\"ee13eeb0d2f9360a\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/anchored-floating.js\":\"41ffc9dab1b61e16\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/button.js\":\"6dffd236820bc9c0\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/card.js\":\"3dc1911c0d9e7f31\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/checkbox.js\":\"33d456c3ea150c82\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/collapsible.js\":\"b07eece51c62b815\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/command.js\":\"f85624f5836d0e09\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/context-menu.js\":\"d3232709b4438b2e\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/dialog.js\":\"68556e27993d27e8\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/dropdown-menu.js\":\"a81950dd078dd380\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/floating-listbox.js\":\"a97de31c45433290\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/index.js\":\"27ee5a1bcbd52b24\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/input.js\":\"31e5b8520a865b1a\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/kbd.js\":\"fb8f573518cc02ec\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/label.js\":\"2b881d5911ac4709\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/textarea.js\":\"3d1b65503e152195\",\"/knowledge-medium/pr-preview/pr-1874/src/components/useEditModeYieldKeepalive.js\":\"fc6523ad7d4881b9\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/BootFallback.js\":\"e958795a5274a219\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/FocusedRowLazyMount.js\":\"e6e37ad017c0f1fa\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/LazyViewportMount.js\":\"20dc0597fb4a1c3f\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/LocalDbCorruptionFallback.js\":\"5fd30fd40529cca1\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/error.js\":\"455496055aec0946\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/lazyMountRegistry.js\":\"ed4fc96a81cf52c1\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/suspense.js\":\"47283595576d624b\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/CreateWorkspaceDialog.js\":\"cc63060f3b6dcb07\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/PendingInvitations.js\":\"c53c0306a0a9044f\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/SyncProgress.js\":\"2f58730ba2761005\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/UnlockProgress.js\":\"a58ed801cff246d3\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/WorkspaceKeyGate.js\":\"fdf6e7d815883cbc\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/WorkspaceSettingsDialog.js\":\"64e6ca56cec419f9\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/WorkspaceSwitcher.js\":\"ad6db8f54073bc71\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/WorkspaceSyncGate.js\":\"d5139d15ed76e80f\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/ConversionFlow.js\":\"69d3cc22e1fc2252\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/ConversionFlowHost.js\":\"26394530f6743d8a\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/EncryptionSection.js\":\"b78e67b253484686\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/attachmentPrompts.js\":\"27517a385d80fd9e\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f4fe5ff1c5540aa3\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/conversionFlowDeps.js\":\"df73c8b88f123b38\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/conversionFlowStore.js\":\"7f9892b3abc8a7af\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/flowUi.js\":\"4967107b9e6e4ff5\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/useConversionRun.js\":\"a85b755451298adc\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/keyUi.js\":\"91646931646fd27e\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/useCloseOnKeyLoss.js\":\"52a0d29a0b56f6dc\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/useCloseOnServerE2ee.js\":\"a9cbcb134a428fac\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/workspaceUnlocked.js\":\"5b8b318bc6afd724\",\"/knowledge-medium/pr-preview/pr-1874/src/context/backgroundSubtree.js\":\"4354ba046e14a9c0\",\"/knowledge-medium/pr-preview/pr-1874/src/context/block.js\":\"d41a6252b3368abe\",\"/knowledge-medium/pr-preview/pr-1874/src/context/layoutWsContext.js\":\"b29de05d77d8a81e\",\"/knowledge-medium/pr-preview/pr-1874/src/context/propertyDisplay.js\":\"add7e54579d98d2b\",\"/knowledge-medium/pr-preview/pr-1874/src/context/repo.js\":\"0a6c64589fb2b435\",\"/knowledge-medium/pr-preview/pr-1874/src/data/aliasClaim.js\":\"3d15f3044fab347d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/aliasSeatNamespace.js\":\"4f4a9eb8cf179c81\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/blockData.js\":\"7b2bb803b3679c5e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/blockType.js\":\"4e9f01cd0a23455c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/changeScope.js\":\"dcc4599fbd2d1a4c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/codecs.js\":\"7757d4d3cfcdd650\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/derivedData.js\":\"84fa42b66ac24fff\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/errors.js\":\"13c21d3654662b58\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/events.js\":\"29b06bb695116016\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/handle.js\":\"4a4fb5fd0ea1dfbf\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/index.js\":\"f39a6993a7f8e71e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/mutator.js\":\"e25d4d80f8af29d6\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/processor.js\":\"2e890b1974c8a1a2\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/propertySchema.js\":\"af03abc49318e485\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/query.js\":\"9e92333a6d975d38\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/sameTxProcessor.js\":\"fee298736ad94f85\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/schema.js\":\"4a4fb5fd0ea1dfbf\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/tx.js\":\"4a4fb5fd0ea1dfbf\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/typedBlockQuery.js\":\"e30cd5fc5e44d27f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/user.js\":\"0bf8ad616d3b66c7\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/valuePresetCore.js\":\"1d3ab1fc3e3fbce8\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/valuePresets.js\":\"9b3c5c115e319232\",\"/knowledge-medium/pr-preview/pr-1874/src/data/attachmentCleanerIOVerb.js\":\"af52cb8b5d2dd525\",\"/knowledge-medium/pr-preview/pr-1874/src/data/block.js\":\"2bca5f01491dd67c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockCache.js\":\"10e05f625b4a0243\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockId.js\":\"17e04f2ec8c9540f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockLiveness.js\":\"6e1e0de1a2d92afa\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockMerge.js\":\"fc5aadea4a3c222e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockSchema.js\":\"cdfacc52e950a758\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockTypeLookup.js\":\"2fba8cee2e0157e3\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockTypes.js\":\"e7f156b5a4f890ce\",\"/knowledge-medium/pr-preview/pr-1874/src/data/childrenView.js\":\"378d96db598d3edd\",\"/knowledge-medium/pr-preview/pr-1874/src/data/clientContext.js\":\"2f7cbf01ff801075\",\"/knowledge-medium/pr-preview/pr-1874/src/data/dbFileSiblings.js\":\"b5e15f734d78749f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/definitionSeeds.js\":\"314113f563977bdb\",\"/knowledge-medium/pr-preview/pr-1874/src/data/derivedIds.js\":\"193f0f4da4743c22\",\"/knowledge-medium/pr-preview/pr-1874/src/data/drawnSubtree.js\":\"d185e5a00892437c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/facetBridge.js\":\"889aa2e9377e163f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/facets.js\":\"f900d2aadb2e5375\",\"/knowledge-medium/pr-preview/pr-1874/src/data/globalState.js\":\"e3e111f307f62e38\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/aliasClaimRederiveProcessor.js\":\"b6ab827e975e85ca\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/ancestorBatch.js\":\"ac73bc915d090fcb\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/blockTypeTypeifyProcessor.js\":\"936492c5621d1b3d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/clientSchema.js\":\"27f08e4c50890a53\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/commitPipeline.js\":\"15810bbc42fe6f0e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/devAssertions.js\":\"656057aad3c0da64\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/firstSync.js\":\"e26e0db7e97c34e3\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/freshInitialLoad.js\":\"d889693a53ee58ef\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/graphBackfillClaim.js\":\"887b78c5bd928d83\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/handleStore.js\":\"d83c42bbda3c3b88\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/idleMarkerJobs.js\":\"5fdf32fbdfb7088a\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/initialDownload.js\":\"b151bade87ece8bc\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/initializeClientDatabase.js\":\"2c90f8ce3fa92caa\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/jsonCanonical.js\":\"a25aaaeff1d6d368\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/kernelInvalidation.js\":\"dd280b6028947197\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/kernelProcessors.js\":\"093e3cf802adf0b0\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/kernelQueries.js\":\"edaa5c223bfd1761\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/mergeTypeMembershipProcessor.js\":\"0acbf996dcb50c3e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/normalizeReferencesProcessor.js\":\"ec2e165332d649af\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/poolInstrumentation.js\":\"1be2fc098786bd10\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/processorRunner.js\":\"39eb15241a7a130d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyCellBackfill.js\":\"6b2824f5704edf2d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyChildMint.js\":\"d38d15b629e8fed2\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyChildrenProcessor.js\":\"bdcfc415b86b2983\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e842febe86df3868\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyDefinitionSynthesis.js\":\"115d22086831b09f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyKeyScan.js\":\"14a363adb4d039b1\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertySchemaResolution.js\":\"c89894a36f105635\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyValueEdits.js\":\"b387738729c68ea5\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/raiseProtocol.js\":\"c7bbc953b05ea11f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/readBatch.js\":\"0ed635b5f7277cc8\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/refProjection.js\":\"0699c927b2824057\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/referenceTargetLookups.js\":\"4d3c70d16ec583e0\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/referenceTargetProcessor.js\":\"8c553394a0ad282a\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/replayMerge.js\":\"a43b843c57edca8e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/sqlBinds.js\":\"8c1b508e0b607dca\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4f0bc62d473e7f7b\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/syncObserver/arrivalProcessors.js\":\"4eb17cf0a170eded\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/syncObserver/invalidate.js\":\"08f9de50f85f5d50\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/syncObserver/materialize.js\":\"d5333e2762895f37\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/syncObserver/observer.js\":\"8461ad1241eca669\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/syncObserver/reconcile.js\":\"96ffd150b4e76700\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/timingMetrics.js\":\"e2e4fe9c11784e3a\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/treeQueries.js\":\"b0a805792e540195\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/txEngine.js\":\"132d8253eeded2f1\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/txSnapshots.js\":\"c6fd382654ab81c3\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/typedBlockQuery.js\":\"dc8f856d41d009ed\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/undoManager.js\":\"53f057aec71f188c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/invalidation.js\":\"399cb22e7f9d9680\",\"/knowledge-medium/pr-preview/pr-1874/src/data/kernelDataExtension.js\":\"2fd9474335855696\",\"/knowledge-medium/pr-preview/pr-1874/src/data/kernelPage.js\":\"7f7f380017941359\",\"/knowledge-medium/pr-preview/pr-1874/src/data/kernelValuePresetCores.js\":\"385e4c006603e136\",\"/knowledge-medium/pr-preview/pr-1874/src/data/localDbCorruptionSignal.js\":\"0594f85451691cf4\",\"/knowledge-medium/pr-preview/pr-1874/src/data/localDbStorage.js\":\"2cbe30004849ff20\",\"/knowledge-medium/pr-preview/pr-1874/src/data/localDbVfs.js\":\"9ecfbefb911bfaac\",\"/knowledge-medium/pr-preview/pr-1874/src/data/localSchema.js\":\"a9c4d5bc5a063fdb\",\"/knowledge-medium/pr-preview/pr-1874/src/data/maintenance.js\":\"ac4f3268962dfe2b\",\"/knowledge-medium/pr-preview/pr-1874/src/data/mergeProperties.js\":\"a1724d69bfe2eab9\",\"/knowledge-medium/pr-preview/pr-1874/src/data/metricsConsoleHook.js\":\"b50790ccecddd2d1\",\"/knowledge-medium/pr-preview/pr-1874/src/data/migrationsPage.js\":\"bb9802c58b45c546\",\"/knowledge-medium/pr-preview/pr-1874/src/data/mutators.js\":\"d26fd7a700e020a2\",\"/knowledge-medium/pr-preview/pr-1874/src/data/orderKey.js\":\"c644eaef74f33b82\",\"/knowledge-medium/pr-preview/pr-1874/src/data/orderKeyPlacement.js\":\"df4edaed0fa7f3a2\",\"/knowledge-medium/pr-preview/pr-1874/src/data/outlineSurface.js\":\"f72bf783751eaf29\",\"/knowledge-medium/pr-preview/pr-1874/src/data/pendingEditorContent.js\":\"3be45b88a171b2cd\",\"/knowledge-medium/pr-preview/pr-1874/src/data/pendingUploadsSql.js\":\"2aa937187247ca02\",\"/knowledge-medium/pr-preview/pr-1874/src/data/pluginStateExtensions.js\":\"dc346c20847c4594\",\"/knowledge-medium/pr-preview/pr-1874/src/data/powerSyncLogger.js\":\"6099c5f75124d194\",\"/knowledge-medium/pr-preview/pr-1874/src/data/projectorRuntime.js\":\"5b986d37ed051591\",\"/knowledge-medium/pr-preview/pr-1874/src/data/properties.js\":\"ad51e11dd9d87e4d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertiesPage.js\":\"9a836faa227b1662\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertyChildren.js\":\"5e3195a93964d27a\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertyDefinitionFanout.js\":\"394577288ae4489c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertyDefinitionMetadata.js\":\"48f81c4b78639344\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertyDefinitionRegistry.js\":\"2dcd387aca48a44f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertyDisplayMode.js\":\"ce5b4f24db7fddb0\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertyRowCreation.js\":\"a8a50da2dbce09f2\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertySchemaCreation.js\":\"5649bb48d60be21a\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertySeeds.js\":\"4c86269365e7e5cd\",\"/knowledge-medium/pr-preview/pr-1874/src/data/recentsPage.js\":\"293a5d0e5880d0a7\",\"/knowledge-medium/pr-preview/pr-1874/src/data/referenceBlock.js\":\"a50e092b6e248300\",\"/knowledge-medium/pr-preview/pr-1874/src/data/rejectedUploads.js\":\"a54f8f2e5b2aa857\",\"/knowledge-medium/pr-preview/pr-1874/src/data/releasePowerSyncConnection.js\":\"1ae062c420d5f428\",\"/knowledge-medium/pr-preview/pr-1874/src/data/repo.js\":\"674d42d1cd2173b1\",\"/knowledge-medium/pr-preview/pr-1874/src/data/repoProvider.js\":\"d069563b9e97cc23\",\"/knowledge-medium/pr-preview/pr-1874/src/data/rowProperty.js\":\"987c48a3b115c3f4\",\"/knowledge-medium/pr-preview/pr-1874/src/data/searchFilter.js\":\"dc0126928df3bd37\",\"/knowledge-medium/pr-preview/pr-1874/src/data/seedIdentityLedger.js\":\"cc5f197b5ce42fec\",\"/knowledge-medium/pr-preview/pr-1874/src/data/stateBlocks.js\":\"95ebeeb356b7d315\",\"/knowledge-medium/pr-preview/pr-1874/src/data/structuralEditPolicy.js\":\"99ec26f84840f477\",\"/knowledge-medium/pr-preview/pr-1874/src/data/structuralInsert.js\":\"717667a8572cdd3c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/subtreeDelete.js\":\"cbb3fbdc44ae6748\",\"/knowledge-medium/pr-preview/pr-1874/src/data/syncStreamLock.js\":\"3c23cc9f3b246f72\",\"/knowledge-medium/pr-preview/pr-1874/src/data/syncedTableSqlRecognizer.js\":\"d2ef84d527e39b4a\",\"/knowledge-medium/pr-preview/pr-1874/src/data/syncedTableWriteGuard.js\":\"d2c13644faeb0990\",\"/knowledge-medium/pr-preview/pr-1874/src/data/targets.js\":\"b448207293a1a7d5\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeColors.js\":\"892f3e29c4783b32\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeDefinitionMetadata.js\":\"9538990e2f3fcf0d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeDefinitionRegistry.js\":\"b7fdcb0f8b367cff\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeExtraction.js\":\"8aab19a5f2267081\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeInitialValues.js\":\"bf0f94c121b5b3d9\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typePropertyGroups.js\":\"3dc5b62da726deca\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeSeeds.js\":\"8f1b362a1b7ebbc4\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeTagger.js\":\"fad70b70658bafd9\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typedRecords.js\":\"78be33b46da1bcc5\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typesPage.js\":\"fcad5be7f74416eb\",\"/knowledge-medium/pr-preview/pr-1874/src/data/userPrefs.js\":\"9dfbfddab55a251d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/userSchemasService.js\":\"3dcfbaf78dcd3ff9\",\"/knowledge-medium/pr-preview/pr-1874/src/data/userTypesService.js\":\"5ceeb7320c73ee9d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/valuePresetRegistry.js\":\"4388be69ffd44939\",\"/knowledge-medium/pr-preview/pr-1874/src/data/visibleChildren.js\":\"2d2da34180a7989e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/workspaceConversion.js\":\"bfa6fbf96870c01b\",\"/knowledge-medium/pr-preview/pr-1874/src/data/workspaceFirstSync.js\":\"c56b05622ff60d8d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/workspaceIdNamespace.js\":\"3d5a76a4eb04a523\",\"/knowledge-medium/pr-preview/pr-1874/src/data/workspaceSchema.js\":\"cb4a6838fc4b9a47\",\"/knowledge-medium/pr-preview/pr-1874/src/data/workspaces.js\":\"52aedfd270278443\",\"/knowledge-medium/pr-preview/pr-1874/src/data/writeAheadLog.js\":\"97b75c7b60919f12\",\"/knowledge-medium/pr-preview/pr-1874/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/BlockPasteShellDecorator.js\":\"9308f66d3b8e6e3d\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/atTrigger.js\":\"7565c5110eaea22b\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/autocomplete.js\":\"03d49c1dd2969485\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/codeMirrorExtensions.js\":\"5c45949f68c5175d\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/contentFlush.js\":\"4cfb767a9131a941\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/defaultInteractions.js\":\"9a80456f0957aeff\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/editSettleSignal.js\":\"88e52594e0fadb68\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/insertImage.js\":\"3826c585324eaddf\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/referenceCompletionRange.js\":\"0b3f503dcb4d704d\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/referenceTargetTypes.js\":\"e0a5e56b0595dd12\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/syntaxContext.js\":\"6c567dd173434cdd\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/triggerMatch.js\":\"d3a0b33307fb41cc\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/AppRuntimeProvider.js\":\"3486ce6bc4450ff5\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/BlockFocusShellDecorator.js\":\"bf92af8363f3fff2\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/ExtensionRenderBoundary.js\":\"452ddbb86d9585de\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/PanelContentRecovery.js\":\"47ccf8099f2e6464\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/apiCatalog.js\":\"147b1d31246c59cc\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/approveExtensionHere.js\":\"e2adc41dd53d5af6\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/armedCutAppMount.js\":\"68a354a72b5c127f\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/batchableKeyedStore.js\":\"4c64a06eab982a26\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/blockInteraction.js\":\"64d884105caa2cab\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/blockSelectionAction.js\":\"8ee1031f459db546\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/compileExtensionModule.js\":\"fdfd13ac897cf9cd\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/compiledModuleCache.js\":\"9dda92f4655bf845\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/continuousGestures.js\":\"0dbabacfed611ca6\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/core.js\":\"4a7909e241ca9ec2\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/defaultRenderers.js\":\"3d9c3b24a171c993\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/definitionFanoutAppMount.js\":\"a9935fdf17e2c5db\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/dialogAppMount.js\":\"882c832345d4f408\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/dynamicExtensionSeeds.js\":\"83a1053c0070d3d3\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/dynamicExtensions.js\":\"86a34236f8abef75\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/exampleExtensions.js\":\"9c40cb07005caf7f\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/extensionApprovalStatus.js\":\"4fc293c23820ba9f\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/extensionLoadErrorToast.js\":\"3885b85104785ae6\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/extensionLoadErrors.js\":\"9744405a1eaa9e0d\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/extensionLookup.js\":\"437501289719780f\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/extensionToggles.js\":\"1fad559f726d6b2b\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/extensionUtilitiesCss.js\":\"1745ab5a564f2dfa\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/kernelPageDeletionGuard.js\":\"76c84e8db37d938f\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/liveRuntime.js\":\"2a1c58be6d667789\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/openExtensionsSettings.js\":\"35e4156775ed016d\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/overridesCache.js\":\"addefe501a94bce0\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/pluginIds.js\":\"afe2a2346f7a0648\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/processorRejectionToast.js\":\"51ff5761f8d44025\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/runtimeActions.js\":\"b9c2646c1cde40a1\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/runtimeContext.js\":\"b5a0ab1c0c0ee986\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/staticAppExtensions.js\":\"0b2791ebd10153e9\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/staticDataExtensions.js\":\"9e4e233d693b5a3c\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/toastAppMount.js\":\"f6f0a454b2bfbdeb\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/useOverrides.js\":\"86e47bb6b7785b8d\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/useShortcutSurfaceActivations.js\":\"3f642aa3cfdce954\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/discoverToggleTree.js\":\"7ab044cfaacdc37a\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/facet.js\":\"e981ddbff138b684\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/resolveAppRuntime.js\":\"d5c777e132eb59d3\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/runtimeEvents.js\":\"d4f26708c6c05988\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/togglable.js\":\"3417737422126f23\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/variantFacet.js\":\"02c8a218c0e0d754\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/verbFacet.js\":\"dfd5b1dbc683a69d\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/block.js\":\"32fa8a4982d93c07\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/focusedChild.js\":\"4d8d46f40c6a6ba2\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/propertySchemas.js\":\"57b108039feb69d6\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/typeRegistry.js\":\"d18b3814fe5e83c7\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useAncestorCrumbs.js\":\"1c2c1323a0907f10\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useAutocompleteListbox.js\":\"c4c26d03028c2de7\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useDebouncedSearch.js\":\"a195ab4efb229bf3\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useDebouncedValue.js\":\"79fba0125c6bef57\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useIsFocalRender.js\":\"addd83e821ae9e5c\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useIsReadOnly.js\":\"49bbb8e71c43cf52\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useMaterializeBacklog.js\":\"97d82c3fab846194\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useMinuteClock.js\":\"3f9b69579185656c\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/usePanelLayoutProjection.js\":\"b58afd32dd0986bc\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/usePendingInvitations.js\":\"df0b6b935c0951c3\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useRendererRegistry.js\":\"2e4cd76e4a6beb1d\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useRetainedFieldRows.js\":\"d1ce33e7f79b65e3\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useWorkspaces.js\":\"23d7d30d68ffe931\",\"/knowledge-medium/pr-preview/pr-1874/src/lib/utils.js\":\"0f682d6ea551c314\",\"/knowledge-medium/pr-preview/pr-1874/src/main.js\":\"e230023b2fe6a02b\",\"/knowledge-medium/pr-preview/pr-1874/src/markdown/MarkdownImage.js\":\"f49fa783a54dc0ed\",\"/knowledge-medium/pr-preview/pr-1874/src/markdown/blockSeparators.js\":\"9946739cdc21bbd6\",\"/knowledge-medium/pr-preview/pr-1874/src/markdown/context.js\":\"c67a476b090087fb\",\"/knowledge-medium/pr-preview/pr-1874/src/markdown/defaultMarkdownExtension.js\":\"d5c0745d6db159e1\",\"/knowledge-medium/pr-preview/pr-1874/src/markdown/extensions.js\":\"e0ae0545d285b6a8\",\"/knowledge-medium/pr-preview/pr-1874/src/markdown/renderMarkdownHtml.js\":\"31074dd2d4d7ded0\",\"/knowledge-medium/pr-preview/pr-1874/src/minimal-editor.js\":\"0304a035a9d91e0e\",\"/knowledge-medium/pr-preview/pr-1874/src/paste/armedCut.js\":\"6aea3208bbb002fc\",\"/knowledge-medium/pr-preview/pr-1874/src/paste/captureMediaVerb.js\":\"15f47abc6be40b5d\",\"/knowledge-medium/pr-preview/pr-1874/src/paste/clipboard.js\":\"9c0a28d8073202a8\",\"/knowledge-medium/pr-preview/pr-1874/src/paste/decision.js\":\"9ee65fcd4aee1e0a\",\"/knowledge-medium/pr-preview/pr-1874/src/paste/operations.js\":\"f1210b7ae34c6617\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/account-header/AccountHeaderItem.js\":\"6dbd5554d3b9ce92\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/account-header/index.js\":\"b055b7c962c73189\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"35546f8d1b41a24e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/askAgent.js\":\"824186abd193fb6a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/askedStore.js\":\"4ed8a44b8b2d02a9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1e9c214ff7410b4f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/chipState.js\":\"44cb34e5c697f0ed\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/dataExtension.js\":\"661b575076d8610b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/index.js\":\"84b68d0d706bf17d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d510c596f4abd4d0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/schema.js\":\"82be702b89c11ec8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/AgentTokensDialog.js\":\"123a2c9e5b0068d8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/BridgePairingDialog.js\":\"15df779862012aba\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/addMedia.js\":\"510323af54841171\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3109bbbf1f7f9b47\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/block.js\":\"f32142eb4a590d84\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/context.js\":\"d334dcad98ccae21\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/displayIds.js\":\"207548ce9ecb037f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/index.js\":\"119fd60ce5380263\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/outline.js\":\"078d361aa96ddee0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/properties.js\":\"c6c3b706ec8243a0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/refs.js\":\"adb8188b0de586d5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6d1814b4e5e8b9b2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/search.js\":\"bcac4adabceb38a2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/shared.js\":\"b099ce76e9a61762\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"5f155a62bda22ff9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/text.js\":\"d0527adbcefc9dcf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentWrites.js\":\"267359144d222825\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/authoringCatalog.js\":\"c2be780f7fd83b21\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/blockRefTargets.js\":\"9968066c9d3cc34e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/bridge.js\":\"e818e9ae26e85a18\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/bridgeLoop.js\":\"926eb7747e5bf044\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/changeHistory.js\":\"7e15bf4655a5197e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/commands.js\":\"76feaf5f4d8bb932\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/commentsCommands.js\":\"355943d064d55fc3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/dataExtension.js\":\"fe8a95aea9a5025c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/dataModelGuide.js\":\"6de25caee51e825a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/describeRuntime.js\":\"143376e5c5c6d6ee\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/extensionLint.js\":\"c26bce46bc1aba58\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/grainAudit.js\":\"16c7af36d702b556\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/healthCommand.js\":\"75088178b29f0c21\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/index.js\":\"6a0eba22c9eaffda\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/presetIdentity.js\":\"8fb1ed83d221b094\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"43036809bb405789\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/readMedia.js\":\"0281815cfdbf3afc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/schema.js\":\"d3fe458fa482c7b4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/serialization.js\":\"ddeee3b9f2c14d32\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/targets.js\":\"54baeef5b56a564b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/tokens.js\":\"ea00d9c1df88fa58\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/watchEvents.js\":\"37c251e8712108bf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/workspaceGuard.js\":\"73d95c19dbbffa42\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/writeCommands.js\":\"e964acf9d9d5447d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/AliasCollisionToast.js\":\"38bfcf8a24c0f650\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/DuplicateNameBanner.js\":\"5eabdd00e7e39038\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/collisionMerge.js\":\"db1291646dbafe03\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/dataExtension.js\":\"f3aa7d8853546cd4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/index.js\":\"1b0df9321896f1a3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/mergeCollisionAction.js\":\"d3c8fef3d6bea047\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/pageStyling.js\":\"52b8efc9499cfd07\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/rejectionToast.js\":\"d077fbe2b5501eeb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/syncProcessor.js\":\"7b7b70d6c823905c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/actions.js\":\"50f15f4eadfb6b8e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/addComment.js\":\"2069de1e93ceee2b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/anchor.js\":\"b195bb1b800ba4cf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/anchorState.js\":\"788362e0585929b0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/commentLinks.js\":\"d98aec696d114f56\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/confirmThreadDeletion.js\":\"91a0703ad439a10d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/container.js\":\"db819b176b038ac8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/dataExtension.js\":\"93620031023153fc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/deleteComment.js\":\"c965c2791f6d4a41\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/highlights.js\":\"cef6535f62e170a0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/index.js\":\"64b64df9f77732ad\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/linkedCommentsPill.js\":\"60405aa2613887b0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/margin.js\":\"de184bb1a0fd7de2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/marginSchema.js\":\"e714bf8f5496ce3f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/newComment.js\":\"50760bffd69b2fc6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/ownThreadPicker.js\":\"304c2a040633de82\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/placement.js\":\"db4bb685d7143a88\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/queries.js\":\"376ae50788745dfd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/quotePosition.js\":\"b3ba2f301d1985e0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/quotedIn.js\":\"a7e76d41da0b001e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/quotedRange.js\":\"b3185a5e76967ed8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/rangeRefs.js\":\"8d591fad366bad60\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/readHighlights.js\":\"70cda499348c2e0f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/readSelection.js\":\"7871a1a6e308f6fc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/readSelectionUi.js\":\"a5e37bb56b37b502\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/reanchor.js\":\"0fb8f7b180de7665\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/schema.js\":\"987e93e9a0d1abaf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/scope.js\":\"e5fdcf4611385c4c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/scopeThreads.js\":\"242d3da29b0aafbc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/splitRetarget.js\":\"cf7c0865d0329449\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/suggestionCard.js\":\"10007e4a086f60a3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/suggestions.js\":\"b90adeb72e2bf3d9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/summaries.js\":\"1ee996c472fc9300\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/summaryBatch.js\":\"9db002df408f5f33\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/surface.js\":\"f19242d42a4c7b3d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/threadNavigation.js\":\"4058925893bfa720\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/threads.js\":\"959436d415b973a3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/ui.js\":\"9416f9459e7c0fe6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/uiStore.js\":\"3c6304289c0cde65\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/app-intents/appIntents.js\":\"d1bc42131964a58f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/app-intents/index.js\":\"3479ee7f3863a722\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/app-update-prompt/index.js\":\"c45727950813693d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/app-update-prompt/status.js\":\"8d0ec0ef403049cf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a5c4d538aabb5f44\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/MediaBlockRenderer.js\":\"9cb535a4abf70eae\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/MediaDownLaneReplicator.js\":\"a9f6ed53fdbc6559\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/MediaUploadReconciler.js\":\"a6145bc8f41b8427\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/assetDownLane.js\":\"8d1ed17a810dfb8b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/assetResolver.js\":\"004aa375f6bc9364\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/assetUpload.js\":\"b2eef64e4a6903e9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/attachmentCleanerIO.js\":\"194590a40494e43f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/audit/supabaseAuditIO.js\":\"549ab7c214fd6744\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/blobStore.js\":\"9acac09ec6b65d97\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/browserMedia.js\":\"fbf8bc474b19ddb8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/byteStore.js\":\"2d8849ee50420b32\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/cleanerIO.js\":\"04a544db4c9041fe\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/cleanupAttachments.js\":\"e45756b134a5dbe8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/dataExtension.js\":\"6e1cf18eabc425d8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/downLane.js\":\"d8c043333badd036\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/index.js\":\"ee4b3456dd66f653\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/insertImageContribution.js\":\"f2f229eff41fb618\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/laneArming.js\":\"77c4b1f32c93bd59\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/laneLock.js\":\"a5877f0b67ce8501\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/mediaBlock.js\":\"7fc1cb25f93cea9c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/mediaCapture.js\":\"dbec7930e4689058\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/mediaLanes.js\":\"130bee5a0ad96762\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/mediaViewers.js\":\"cf73e51eb2a4ec57\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/mediaViewersFacet.js\":\"87871359b3d702a2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/pasteCapture.js\":\"eaca273c2ea8d39f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/resolver.js\":\"4c3bed8ffc804693\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/retryUploadsAction.js\":\"4bef853f751fcaab\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/storagePaths.js\":\"3cf1a92ba264fd9f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/uploadDrain.js\":\"079bfc7fcedb98b9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/uploadLaneStatus.js\":\"8abbc849a5225dc0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/uploadReconcile.js\":\"2416bc9c2be85395\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/uploadRecovery.js\":\"18c07ae3b8df0b53\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/uploadStore.js\":\"c939f1368a110b6a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/useAssetObjectUrl.js\":\"f777383eeb4b1aaf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"976587d74ae84a5a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks-view/BacklinksViewSection.js\":\"695b66a150fe14c8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks-view/facet.js\":\"1e653f97af70232d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks-view/index.js\":\"1b04bcd0efd44648\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks-view/prop.js\":\"36e10e5634654eb4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/BacklinkFilters.js\":\"b31d9597c8237e3c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e752cf84ea96b7ce\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/BlockEntry.js\":\"9532280bc1d1acae\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/LinkedReferences.js\":\"d4588bed57a73ae2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"cb45674add591ff7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/dailyNoteDefaults.js\":\"e85a77626728579e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/dataExtension.js\":\"762712cbba1f90e5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/edgeExclusions.js\":\"e3ccdb8362883c00\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/filterProperty.js\":\"8601b044399cec33\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/index.js\":\"938cc8da1be7f945\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"388f35481d49c88f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/inline-counts/applies.js\":\"cdb312ad79d03aef\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/inline-counts/countQuery.js\":\"591da1756c33550a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/inline-counts/expansionStore.js\":\"aab0e59fd3a9d0b5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/inline-counts/index.js\":\"955e14e065c7370c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f0a2ee1494cbd250\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/presentationInvalidation.js\":\"0abc9e85d06286ef\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/propertyEditorOverride.js\":\"0c17b20d35c731d5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/propertyFilter.js\":\"be6669e9c6e99ae9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/query.js\":\"2558ea5718e7f2c3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/resolveFilter.js\":\"41311858f5658af7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/sourceBatch.js\":\"b2fa46607b00201d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/sources.js\":\"a17345e8922e7212\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/useBacklinks.js\":\"55a0803e47e9551b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f9c44920b9ccfab6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/birthday/BirthdayCelebration.js\":\"ab16477b07a2458b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/birthday/BirthdayOverlay.js\":\"932967b39bdf02b8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/birthday/gate.js\":\"22e0d93c0a59c20d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/birthday/index.js\":\"34b1cc2e822ace27\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/birthday/wolfTheme.js\":\"5a7046e72fe936f3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-drag/BlockDragLayer.js\":\"7ceb3ebf025daccf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-drag/dragController.js\":\"d3b388bb4762d09b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-drag/dropTarget.js\":\"d084c6a98f8fd4da\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-drag/index.js\":\"1eedd0ceb60c671c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-drag/projection.js\":\"80b87ef58fc57c53\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-info/BlockMetaCard.js\":\"6d18f59dd74e07ac\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-info/index.js\":\"3a5938003c3f374c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/AddTagDialog.js\":\"c9640a963c39f9f2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"52e6f02a7e3d1f93\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/TagNameIssueHint.js\":\"32e9c307aff85675\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/addTagAction.js\":\"6e5c5b14042ce3d9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/appendTag.js\":\"0ceadfcf415d5584\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/config.js\":\"e4c37685ab2bc554\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/dataExtension.js\":\"c49200a33b5b26b5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/index.js\":\"cd7eeca051e8ea2e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/propertyEditorOverride.js\":\"b3efba38615e243a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/BreadcrumbList.js\":\"148efa4f58ed57b4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"fc4372a9f599315b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5ba954f5981cbc25\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"59284b5b30ce4736\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"061b6d016d6d6cb5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/index.js\":\"5e18ed7a18dc6b44\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1d08b718446380aa\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/CharacterCountItem.js\":\"12477340c1216162\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d479a1291d9cde74\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/actions.js\":\"7ee6dc5f472dca59\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/blockType.js\":\"bc05d8708743a19b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/charCount.js\":\"48fd74efcbe8222c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/dataExtension.js\":\"60a51a5392a97e4e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/index.js\":\"636a1cdd7277e673\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/profiles.js\":\"4407323a748391f0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/properties.js\":\"ac5b07d74c2c5883\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/textCounts.js\":\"fb516eff7e0dafdc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/colemak-keybindings/index.js\":\"cfebb1a2dbe793d0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/CommandPalette.js\":\"6acf28a7b7a9cf95\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/HeaderItem.js\":\"5cea72023d5fd0ce\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/context.js\":\"266a6b67fc45c2a5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/index.js\":\"22e7cde43faad93f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/selection.js\":\"01455eb21cbc9a02\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/toggleStore.js\":\"d553563575a80dea\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/useCommandPaletteActions.js\":\"b7e40ff91c287d04\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/ContributorBadges.js\":\"4ca41fe6c485c5ca\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/author.js\":\"b3b515eb0a117826\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/codeMirrorExtensions.js\":\"bbe459604673aff8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/dataExtension.js\":\"ffb8a6b84cfba48d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/index.js\":\"94050f7ef65fbc69\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/mentionAutocomplete.js\":\"a7b66828e7dfcb5d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/processor.js\":\"d64f73e1fafad47e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/profiles.js\":\"7ef74da3f2b5fc74\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/queries.js\":\"9fc0cc93f76f22e6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/schema.js\":\"c65798c0404b888c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"da12f1088ec98438\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/cursor-follows-scroll/followOrigin.js\":\"1d81ded2d4c77cf4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/cursor-follows-scroll/index.js\":\"e573e5b69d8f6664\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"3260eb99544b5a19\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"4f35aec7c67fd463\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/CalendarGrid.js\":\"c44e6c3b7e042e11\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/DailyNotePicker.js\":\"fe9b117c8bd36c89\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"89113357298358d2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/DateNavDecorator.js\":\"d8636c87c42ec20f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/DateScrubOverlay.js\":\"962862c801568ea4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/HeaderItem.js\":\"26c228709e7690c6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/ReschedulePicker.js\":\"183184330bf62e0b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0f5a1d9822c8fc60\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/actions.js\":\"f3ed65613c0cf1e6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/blockDateAdapter.js\":\"a580ea160933cade\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/calendar.js\":\"c2bc3b382d297fd4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dailyNotes.js\":\"3c8204df689e6853\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dataExtension.js\":\"19972381da40f475\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dateScrubActions.js\":\"4bbc425dfd2f293c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dateScrubGesture.js\":\"563f9ad2c4ce7a63\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8f4c9c5ef0100d72\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dateScrubRecognizer.js\":\"acfc694b292795b0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/deletionGuard.js\":\"faeaa332d3fca06c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dueQuery.js\":\"81486a20e63b2769\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/index.js\":\"a0de65d028265852\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/landing.js\":\"e74e7c88488adef7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/localSchema.js\":\"06bb5ad43966ac7e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/referenceDateAdapter.js\":\"d06991461804d1a5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/rescheduleAction.js\":\"9c698c5e71a43d9e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/schema.js\":\"865bb483e8f6a2fd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/spreadBlockDates.js\":\"9708bdad9deb779c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/spreadDatesAction.js\":\"9ad38451c1e2acce\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/today.js\":\"be1e69a43b8ad373\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d47d76392606d3ff\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"2c3ab6723f55881a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/audit.js\":\"bba0026455ce08d4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/auditAction.js\":\"4c16c925578aa2c9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/auditRanges.js\":\"0ebf9216a83c6e66\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/diagnosticsSource.js\":\"73fc79458c162517\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/divergenceScan.js\":\"f9b305277b3866f2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/index.js\":\"171446c1d084dd68\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d25656d9b8e134f8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/referencesMirror.js\":\"da9fa238ff0bd545\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/rowJson.js\":\"b653928cd664cbe2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/schedule.js\":\"4510c705bbf2a35a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/store.js\":\"5ac702297c0be228\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-maintenance/action.js\":\"f5c4f1a6f2349182\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-maintenance/index.js\":\"74fc1d307ca000a0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-maintenance/plugin.js\":\"4a7d2474c307cd12\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4cb5078f9d7c03f6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/actions.js\":\"58dff890dc002621\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/changeMarker.js\":\"974a6e43174ba3ec\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/diagnostics.js\":\"ef4557925d5f587a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/fileSystemAccess.js\":\"d9c0b67b5230aa87\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/filenames.js\":\"71b2eb692064df56\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/index.js\":\"c76801ba182f18e9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/mirror.js\":\"e666c8767d92bb37\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/runLock.js\":\"093dbca61f5244a4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/runtimeHealth.js\":\"637bb4641f7aff8b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/schedule.js\":\"36ca6440719f6c9f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/store.js\":\"7a00592fd07f7917\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/default-themes/index.js\":\"12dc9595c55dd955\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/default-themes/themes.js\":\"2492635f55683bcc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/diagnostics/facet.js\":\"128a7ae26dd8c876\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/diagnostics/useDiagnostics.js\":\"2f7dd7d19df16828\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extension-prompts/dismissals.js\":\"5989b1a24a3b3cf2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extension-prompts/index.js\":\"563112f607c70742\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extension-prompts/status.js\":\"072df01ec018e4c3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extension-prompts/store.js\":\"4372cdd0ae7f9f18\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"3174212e4ac3d084\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/ExtensionsSettings.js\":\"683ab356be374f6e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/actions.js\":\"b44eba8b4f08a300\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/config.js\":\"e86697667599b59c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/dataExtension.js\":\"ecd71a236a736678\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/effect.js\":\"e2f4de6ebc5c4bf6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/index.js\":\"96b37f81da0f69e0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5fc2f217a0c2c17a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/useToggleTree.js\":\"0eb7a0dcab4c14df\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extract-type/ExtractTypeDialog.js\":\"08de0790fca94469\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"0a0cbb274da01a5a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extract-type/PropertyShapePicker.js\":\"1fff62d50c494774\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extract-type/action.js\":\"ff85c9acf158030b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extract-type/index.js\":\"66f2009099c8fa05\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/FindReplaceDialog.js\":\"f5aa7f0bb5c2c810\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/HeaderItem.js\":\"e81c69a771d995cf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/dataExtension.js\":\"94973d6049d4545d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/index.js\":\"0a40ecdaf86cfb19\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/search.js\":\"089d5d2a8d2d8477\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/toggleStore.js\":\"38ad51c307c9e23f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/LocationPropertyEditor.js\":\"789f8a75906df5c3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/MapView.js\":\"a9b8119939013718\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/blockTypes.js\":\"342d6eb9b41143e9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/codeMirrorExtensions.js\":\"12b494ad4f9ec79b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/createOrFindPlace.js\":\"82bdcd289f4ff1d9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/currentLocation.js\":\"667d7c877a834411\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/dataExtension.js\":\"12364a5204ef04e6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/geoContentDecorator.js\":\"0e7c49add36e6321\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/googlePlacesClient.js\":\"061c19bd633320c8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/index.js\":\"2ba1dd339410d918\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/locationsPage.js\":\"994accb3f289731f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/mapViewport.js\":\"6625808463c7bdbb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/pickCurrentLocation.js\":\"800feb623fb8f020\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/placeAutocomplete.js\":\"ab4c3ef6d6bc231d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/placeNameCollision.js\":\"bf403ac13730e96e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/properties.js\":\"c33910274cc6dd17\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/propertyEditorOverrides.js\":\"40eabc09bfc71307\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/query.js\":\"ae3d039ed85b0813\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/usePlaceSearch.js\":\"b74443c39055eb24\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"8ddcb98b2b465eb2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"78751cca871b97be\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ec27b59febffd8e4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/config.js\":\"78a3334e0e9ded75\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/dataExtension.js\":\"db808bc9c3e68947\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/facet.js\":\"eabd6d808634346f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/grouping.js\":\"5d45b0555a12372b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/index.js\":\"eb7e166dd33e336d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"8e6362277d0f5d74\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/query.js\":\"279c4f398b2c0c12\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/resolveConfig.js\":\"7c048e91c8ecdf76\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"7a0b3e6b5b0cec4b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e2d995100d099c78\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/HtmlDocumentContent.js\":\"e63fa8bbeabe8621\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/HtmlFrame.js\":\"8f41db4383f27972\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/actions.js\":\"48bc8bf0bc004505\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/blockType.js\":\"9092f84aef843236\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/confirmRunScripts.js\":\"989ab1f18a8519e4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/dataExtension.js\":\"adf6dde4fed8201e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/frameAnnotations.js\":\"882f3a68301c7f92\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/frameDocument.js\":\"1a53dfea7294c561\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/frameTheme.js\":\"75e1a3e0623fff08\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/index.js\":\"af108c9414d88130\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/scriptConsent.js\":\"910b2f7e29085f66\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/sourceMap.js\":\"506067db24fb4502\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/useDocumentScripts.js\":\"531272214a18682e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/interaction-metrics/index.js\":\"61c5a480687e7027\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/interaction-metrics/record.js\":\"5bc147ed89b7bccd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/interaction-metrics/recordStore.js\":\"1f9984031df09f75\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/interaction-metrics/responsiveness.js\":\"91e3cf39a53fbd11\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/interaction-metrics/schedule.js\":\"20e17c1be440c8e9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/interaction-metrics/sessionContext.js\":\"dd6f221e5ffd5b16\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"14de3b23de7b2bce\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"b1363d22b0585d05\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/actions.js\":\"74658796e81bb326\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/config.js\":\"6d2f0198b89984c8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/dataExtension.js\":\"276daef87963eed5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/effect.js\":\"4b1fc135f9370c98\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/index.js\":\"9c9fd13f8b138d77\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/keyCapture.js\":\"a461b51e866249a2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/overrideStore.js\":\"5f9952ed554f1f78\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c748cf914ea037a4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/HeaderItem.js\":\"b2018b588f0fbcec\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/LeftSidebar.js\":\"c3b3698ec8253b17\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/actions.js\":\"206c684444b84975\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/facet.js\":\"cd8e6eaf36c281ca\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/index.js\":\"9c9e02f19da91de6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/shortcuts.js\":\"82bf64e3f50e94e0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/toggleStore.js\":\"8a44afa2c33c8f09\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/merge-blocks/MergePicker.js\":\"2cce33b160d6fc48\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/merge-blocks/index.js\":\"98289cff85c1c0ae\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/merge-blocks/mergeAction.js\":\"917399ad85115852\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/merge-blocks/strategy.js\":\"659ba2d86c7fbfb7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-bottom-nav/Button.js\":\"0b30bafef5c2c893\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"3818767e8c0fc20a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-bottom-nav/defaultItems.js\":\"b89af449cabafac5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-bottom-nav/facet.js\":\"c354f51b74a34a85\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-bottom-nav/index.js\":\"8dc78adfdac4650d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"34a4b5a6c5b79f26\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-keyboard-toolbar/actions.js\":\"8379611c06f892bf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"99cbd785f59b3fab\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-keyboard-toolbar/facet.js\":\"4d74ca42ec96cae3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-keyboard-toolbar/index.js\":\"15dd8cdc9494f778\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9562f96f1bbeeb39\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/blockSubtreeMembership.js\":\"4d431656972d0be9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/contextMenuItem.js\":\"295a1b387aeaac4d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/index.js\":\"bf8fd4ae3b871095\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/moveAction.js\":\"5a9e4fdf6d0b9b36\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/moveBlocks.js\":\"342789cd1e516550\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/selectionAfterMove.js\":\"ac5f98c03010a1f7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/TutorialBanner.js\":\"be7f2424f40e4eb1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/action.js\":\"b9be457c97a295c4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/bannerDismissal.js\":\"95095d6be1319204\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/documents/cheatSheet.js\":\"8af9d38b3d6d001a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/index.js\":\"b3a0b12df2aabdd0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/keys.js\":\"f5b005f0ff080dfc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/landing.js\":\"ad58b3089cee5f60\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/outline.js\":\"eab5fa05c64a4c56\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/seed.js\":\"5aa167dfb7fb01b9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ff3d5fd433e764e4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/analyze.js\":\"719f2c72965e3384\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/diagnosticsSource.js\":\"448dd26927d33d6c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/index.js\":\"4e48dcd58764b8d1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/load.js\":\"f6fc16845ba11f7b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/monitorRun.js\":\"528ec4f1bd0870b0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/schedule.js\":\"529372a113c98b22\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/series.js\":\"377153642960ec76\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/store.js\":\"c8f094535e267b2c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/trendAction.js\":\"c8772dc931ee2571\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/verdict.js\":\"22db130fe8eda390\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/plain-outliner/clickToEditAction.js\":\"cec8cc58e56d8de8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/plain-outliner/index.js\":\"700505efaee8244b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/plain-outliner/interactions.js\":\"cd3d57add7e82333\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"15640df9f0a5ba50\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/MigrationGate.js\":\"390c93b9b9d83251\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/MigrationGateDialog.js\":\"6164e4c3142c3d57\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/action.js\":\"4d148680ed235ec1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/index.js\":\"c562c91615d15bd2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/localRunMessage.js\":\"e6f74415be068b98\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/plugin.js\":\"d838f33a8a5037cb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/progressReport.js\":\"d6359de3020552d0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/sweepProgress.js\":\"945ba5371ef84da0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/FieldRowRenderer.js\":\"e83cd89393a2da4c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/ValueRowRenderer.js\":\"ffca43dcc6318c36\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/actions.js\":\"4888704fdd2da043\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/autocomplete.js\":\"accee4699826e115\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/fieldRow.js\":\"659b15f24de03667\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/index.js\":\"cb792e9c9cb244e0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/referenceWarning.js\":\"915d140dee00981a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/valueAutocomplete.js\":\"67e5d7b8f615289d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/valueSchema.js\":\"6f91b30d56fad165\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/HeaderItem.js\":\"028dbd0c4bc3afea\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/QuickFind.js\":\"e76758196522d1bb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/index.js\":\"ad11fd86e86381b3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/recents.js\":\"2fdf751f8a0d6cc3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/resultItems.js\":\"22d9920f12f2875d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/selection.js\":\"7d15174f51ec1a4e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/toggleStore.js\":\"bf5054556fe80459\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/recents/HeaderItem.js\":\"14613ba0a20c4423\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f5dfa59b5ed0eb42\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/recents/grouping.js\":\"1bf2b4380b4c6614\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/recents/index.js\":\"2f0d673f48ce94d9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/recents/target.js\":\"92fc536c19847513\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/codeMirrorExtensions.js\":\"b14cf25e03a0a72e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/contentPrefill.js\":\"a0e6f9f8732bb7af\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/dataExtension.js\":\"0441f3f0eaf7f025\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/index.js\":\"14cfac42b43f799b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"94fd70daeb0a6336\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/invalidation.js\":\"b04174c0076877bf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/localSchema.js\":\"3f218d0c298b1910\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/blockrefs/index.js\":\"bcdca11f7846090a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"598d4089f75ee961\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/index.js\":\"330874bdef60f528\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/referenceNode.js\":\"0eb773765cac1f02\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e0afac145eee6622\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b7bbd41926e9ce33\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/wikilinks/index.js\":\"8fe17ed8715f71ea\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"dbe082036f9dec60\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"271b17444dbab94b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/mergeRetargetProcessor.js\":\"acdba5fc9f4732de\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/parseFence.js\":\"15cf27752c270043\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/referenceParser.js\":\"240cc7de2960fb06\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/referenceProjection.js\":\"d71f050d36405982\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/referencesProcessor.js\":\"427ffaf4a9ff4079\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/renameProcessor.js\":\"86bb53dc749fd51f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/spanReplacement.js\":\"50592e409af9e496\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/rich-paste/htmlToOutline.js\":\"144a0688c6c4fc4b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/rich-paste/index.js\":\"8766a98135763825\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e6a575abc785cf46\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/rich-paste/pasteDecision.js\":\"d395b93022b43f87\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/action.js\":\"46b34449a1a54be5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/blockIds.js\":\"19a9c126c0f35d35\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/content.js\":\"7dd92ff3a6ed3686\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/effect.js\":\"543aa21453b141fb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/ids.js\":\"1cc862105ccaff08\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/import.js\":\"b64ad75ccb0a7327\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/index.js\":\"e5e6998b0e1568ab\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/plan.js\":\"982bf6edca603564\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/plugin.js\":\"4e6fe23a11cf3df4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/promotion.js\":\"78d9ec70e604eae2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/properties.js\":\"1dd62596d38a2aee\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/references.js\":\"d9c73623015477a4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/report.js\":\"c738a628be2a9bea\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/roamMemo.js\":\"196eb9b315aa84d1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/runtime.js\":\"0229ee7de3b86f2b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/schemaReconciliation.js\":\"cb90dd3794cb2f6f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/srsMarkers.js\":\"c41da425135c674f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/todo.js\":\"7565fc1605e2f5f3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/typeCandidates.js\":\"9736568915eafb88\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/types.js\":\"4ccaa8c01e916eec\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/search-health/index.js\":\"495a2410cc8f4f41\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/search-health/store.js\":\"b27d5e93de3fe0be\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/shortcut-help/HeaderItem.js\":\"ddf9c244b513f03d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"b72909d1218157b9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/shortcut-help/index.js\":\"5b0dabd279752092\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/shortcut-help/model.js\":\"22c8864ec6a80926\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/shortcut-help/toggleStore.js\":\"66c63098c98c4a51\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/shortcut-help/useKeyInspector.js\":\"06962e734af7f378\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"4a48343d3141bb7d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/ShellDecorator.js\":\"1ff30a2685194f35\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/actions.js\":\"d6a9bad18753c88f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/exclusionsFacet.js\":\"2f97ea0ad3a437d4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/index.js\":\"35b2fc9d3d97d654\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/shell.js\":\"e3cbb27b7964815f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/surface.js\":\"0b1902c20ac1bd43\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/walker.js\":\"6182c21c0505f454\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/RescheduleToast.js\":\"59501d67ad557360\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/dataExtension.js\":\"633c3f7525b7633f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/index.js\":\"1d2639f6ad373ffa\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/indicator.js\":\"6ce9f56f045132e8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/moveSrsState.js\":\"f474057dd067336a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"daaa3321056a20ac\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/scheduler.js\":\"85350dced629d79c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/schema.js\":\"e6a367269343eff0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a1af8b2e4c5604f9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/srsClipboard.js\":\"bd7e64d131dceb40\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2b38233185ab81bb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/DailyNoteReviewHint.js\":\"459ff76da108c795\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/DeckPicker.js\":\"1637296eaa124316\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/ReviewControls.js\":\"b6be545a5d289863\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/ReviewDeckRenderer.js\":\"37102ab2369202f6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/ReviewSession.js\":\"016f5ee2235c5fe5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/actions.js\":\"250ec99b0919c5af\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/archive.js\":\"6c811c73f6b27073\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/dataExtension.js\":\"fb82a1f65993e9fa\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/deck.js\":\"9db68cc703102c6a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/dueQuery.js\":\"4eb669f7876f551c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/gradeDecision.js\":\"5cbb484cda0dd954\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/index.js\":\"331c6d308f6ebf29\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/keyHints.js\":\"fd5f864e36957f60\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/reviewCardLayout.js\":\"53be39b92e508f72\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/reviewProgress.js\":\"3f65d08df02cb4a5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/schema.js\":\"9e24cd6503624371\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/useDueCards.js\":\"2d0c163db22e1e3a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/startup-metrics/index.js\":\"4517cb6d2e93e486\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/startup-metrics/record.js\":\"0966e7bd4d0b641f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/storage-persistence/index.js\":\"c96829e51b0032e8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/storage-persistence/persistenceStatus.js\":\"c61f36836988283b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/storage-persistence/requestAction.js\":\"1b9ec20144c6a3a7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/supertags/TypeChipsDecorator.js\":\"9a60c60e0f4d70e2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/supertags/codeMirrorExtensions.js\":\"ffccc77cbdad2efa\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/supertags/index.js\":\"e1465636b34833ba\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/supertags/typeAutocomplete.js\":\"acac308c1ff6b32e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"193bb830f706a682\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/actions.js\":\"b56bd17024cf24f5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/anchor.js\":\"b1aec3d655369ff6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/events.js\":\"8c93486ea8e000aa\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/gestureActions.js\":\"3c37be0db93f2a5b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/index.js\":\"03e7652aeb2f9ec9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e8fb29090d497928\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/sync-metrics/collect.js\":\"76a33700aaa5ccdb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/sync-metrics/index.js\":\"20e87f4bfe5c8fc2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/sync-metrics/record.js\":\"e8219a597dfb77d5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/RejectionDialog.js\":\"758cf5215df763f6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a47f7ee84687ddc2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/index.js\":\"013684ef13d96297\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/model.js\":\"fd1fb95420ba5433\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/queueCounts.js\":\"40e3394650cd4951\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/rejectedHelpers.js\":\"2562097ca89805f3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/rematerializeAction.js\":\"147d0ab90b26f45d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/useHysteresis.js\":\"44f21f08832db376\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/ColumnHeaders.js\":\"f712c7848644aa39\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/QueryUi.js\":\"27f15ca1d04b5d5f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/TableLayout.js\":\"7c0d11d1f0d31201\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/actions.js\":\"5a7d195ac3b9749a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/cellEdits.js\":\"568a34c5083cbeb2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/childrenViews.js\":\"23d0b5d7937aadf0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/columns.js\":\"2f4add6e23b56a77\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/controller.js\":\"7262c22395e447d9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/convert.js\":\"7dfa5c0ee67d6d55\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/dataExtension.js\":\"ba2a1913be211bf4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/index.js\":\"ae11403a36b31591\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/keys.js\":\"ccd9fb2803a08285\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/model.js\":\"e523ac6f220f81d2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/query/backfill.js\":\"61d36a2ac42b79bd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/query/completion.js\":\"b74d643534981245\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/query/format.js\":\"e7e429befa49f7a7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/query/parse.js\":\"22e0e3f2e1f48f2a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/query/queryValue.js\":\"23395125315bb079\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/query/source.js\":\"64e8148fc82a4308\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/registry.js\":\"81fd401878141d87\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/rowGutter.js\":\"46253203fae1a37d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/rowVerbs.js\":\"80c0fcd1753011ec\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/schema.js\":\"0752117e4fed23e9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/sort.js\":\"09dbc1a9c9e556e4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/theme-toggle/effect.js\":\"94ee1ad1e6835d18\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/theme-toggle/index.js\":\"e246614bdad23aaa\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/theme-toggle/theme.js\":\"3e6ab016837efadb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/todo/actions.js\":\"bcd07f9bd2f9726c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/todo/dataExtension.js\":\"d3021b8cfa30468d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/todo/index.js\":\"2987f057f75ccec8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/todo/schema.js\":\"a323b9c6771c62dd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/touch-selection/TouchSelectionLayer.js\":\"3a66ffe2867cad6c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/touch-selection/actions.js\":\"84dc73e3fdf10d00\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/touch-selection/defaultItems.js\":\"ced06de4d4952ae7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/touch-selection/facet.js\":\"b2cc6d86e4ae4e48\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/touch-selection/holdRecognizer.js\":\"10c89858361079da\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/touch-selection/index.js\":\"59106057d00ce726\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/update-indicator/UpdateIndicator.js\":\"a3ff279e84e59efc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/update-indicator/index.js\":\"f55207b2eae5d136\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/update-indicator/loadTimes.js\":\"791dd35979303060\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/VideoNotesRenderer.js\":\"6f24fac6f35dd946\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/VideoPlayerRenderer.js\":\"9edc599f1ee064cd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/VideoTimeStamp.js\":\"9e9ddd13917bd61a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/actions.js\":\"08881ae2c86eb861\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/index.js\":\"f4830b8d9bfb86eb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/markdown.js\":\"78c00d14b39189b5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/notes.js\":\"ff980850cdcb4de9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/registry.js\":\"1d21c12acde45229\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/remark-timestamps.js\":\"38bc34eeed0d0f91\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/view.js\":\"a27f9d9aaabe11c9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-link-hints/LinkHints.js\":\"2d1ffd36887a755a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-link-hints/index.js\":\"c723df7960ab3399\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-link-hints/model.js\":\"7c2f11cbcd0f8ef5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-link-hints/settings.js\":\"ab2319288ca2856f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-normal-mode/actions.js\":\"6dffbdeaf60f1ddf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-normal-mode/index.js\":\"f1656558db05a4b5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-normal-mode/interactions.js\":\"473fc03b75463f62\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/workspace-header/index.js\":\"dcb73994744eec6f\",\"/knowledge-medium/pr-preview/pr-1874/src/registerServiceWorker.js\":\"e12f06f94a08175f\",\"/knowledge-medium/pr-preview/pr-1874/src/requestPersistentStorage.js\":\"331180bc0057d4ad\",\"/knowledge-medium/pr-preview/pr-1874/src/services/authRequestDeadline.js\":\"21732805d25b5695\",\"/knowledge-medium/pr-preview/pr-1874/src/services/authStorage.js\":\"cd6f6d1b28bd3312\",\"/knowledge-medium/pr-preview/pr-1874/src/services/powersync.js\":\"aae44e539f880c16\",\"/knowledge-medium/pr-preview/pr-1874/src/services/supabase.js\":\"7bd55b629c0f31ee\",\"/knowledge-medium/pr-preview/pr-1874/src/services/uploadErrorClassifier.js\":\"7140cc9c686fd768\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/ActiveContexts.js\":\"58226add2e9518d6\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/HotkeyReconciler.js\":\"f5fa372302cc692c\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/WipeLocalDataDialog.js\":\"81c2a5ab1c1686d8\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/actionDispatch.js\":\"f757d80f18191474\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/actionRefItems.js\":\"ca08e8145cc1ea49\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/applyKeybindingOverrides.js\":\"678a3b6ff2ae6225\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/blockActions.js\":\"b2389664139afc9d\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/blockMergeGesture.js\":\"1df764a9c4431c2d\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/canonicalizeChord.js\":\"82bf737dbc36cc63\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/defaultContexts.js\":\"0f23036678fed5cf\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/defaultShortcuts.js\":\"6d58b82aa2c25543\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/effectiveActions.js\":\"3c73feac8b3ae7e4\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/gestureAction.js\":\"9dfbd826a0928ecd\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/gestureBinding.js\":\"0a6f151a2cff8440\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/holdRegistry.js\":\"6d143ea399c1293a\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/keybindingConflicts.js\":\"4bfc6f8386f8df4c\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/keybindingOverrides.js\":\"b3d4d63734202cfc\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/pointerAction.js\":\"242dc5b841f66507\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/resolve.js\":\"5b17e744790128f8\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/runAction.js\":\"d1c8dd213212d485\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/sequenceMatcher.js\":\"52a91779a8538439\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/types.js\":\"4b0f61ccb4da4b4a\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/useActionContext.js\":\"d89a9ae85878eb7c\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/useActionDiscovery.js\":\"7e9d4028382a1f41\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/utils.js\":\"5f9c685aa3a8dec6\",\"/knowledge-medium/pr-preview/pr-1874/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1874/src/sw/bootStore.js\":\"cb756b40d1c586d2\",\"/knowledge-medium/pr-preview/pr-1874/src/sw/previewDatabases.js\":\"601dbc6c3481141a\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/byteTransform.js\":\"5c3375faa562488b\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/attachmentCleaner.js\":\"7731709a9ca9124a\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/bundle/attachmentParts.js\":\"b0ffb1f2b9e7a432\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/bundle/bundleParts.js\":\"32ad5b61b9ac807e\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/bundle/bundleRecord.js\":\"463d4914fa1c02c9\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/bundle/manifest.js\":\"03f55990103111fb\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/bundle/takeBundle.js\":\"f5d7d156cf9569f2\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/bundle/verifyBundle.js\":\"90e9436b55a8e3f9\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/cleaningStage.js\":\"530b53b7be2f7c77\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/conversionKey.js\":\"ba8a1e1cb557da1b\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/conversionServer.js\":\"686f564627a09403\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/flip.js\":\"c61644466c62e388\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/flipAttempts.js\":\"a0390cfa9c20dc8e\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/pages.js\":\"c5852ecea9528ff2\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/preflight.js\":\"6d2cf9250f0fe7d5\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/reseal.js\":\"f54aed60cdbbc790\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/runConversion.js\":\"4b0a92342d38f97d\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/runLock.js\":\"49ddee5673bd0ec9\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/sealing.js\":\"1ba9289a276edc04\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/sealingStage.js\":\"aa2c108f16eb9d9a\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/stage.js\":\"06991ecd4fb04e7d\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/verifyReseal.js\":\"703c9d7c22a42fe9\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/aad.js\":\"8b4fcc815fc0b159\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/aead.js\":\"d10ae5cb62e34134\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/base32.js\":\"9220d0b0bf18f434\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/base64url.js\":\"f2b790d0531d0dc6\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/binaryEnvelope.js\":\"a11ecc1f40f587ed\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/byteAead.js\":\"0cc259d6e2b71681\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/canary.js\":\"a76bfd6433040d02\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/contentHash.js\":\"444608046b35660e\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/contentKey.js\":\"235317e5039188a1\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/derivedIdNamespace.js\":\"b59386a433ee1aa4\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/envelope.js\":\"dbd1685a117988a8\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/hex.js\":\"2bbb8239f2960935\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/sha256Hex.js\":\"3261aab8f2f7ef8f\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/workspaceKey.js\":\"8faffa2231962a1b\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/conversionState.js\":\"1732a0fb249a44dd\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/flows/createEncryptedWorkspace.js\":\"253626e7eb9ae6cc\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/flows/pastedKey.js\":\"da33fd5e0db0b954\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8422f3d7af413104\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/flows/upgradeWorkspacePin.js\":\"897e18cf9a3fbad5\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/keyStore.js\":\"569f5830979fc0f3\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/mintWorkspaceKey.js\":\"81a7f164ca238f1d\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/modePin.js\":\"31f28e22e14e1d07\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/openWorkspaceKeys.js\":\"f79111b26be516e9\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/resolveWorkspaceEntry.js\":\"a0c281a61a09b39d\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/resolver.js\":\"92e4d3e102a9fb1b\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/workspaceAccess.js\":\"5ea75766cc379b7c\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/transform.js\":\"dcb0017accda04e9\",\"/knowledge-medium/pr-preview/pr-1874/src/themeBootDefaults.js\":\"c4b0b17bad14d1d9\",\"/knowledge-medium/pr-preview/pr-1874/src/types.js\":\"93f22356102feb97\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/ClientLocalSettings.js\":\"21e9b03ec09095e1\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/abortableSleep.js\":\"ecfb59cc921f4616\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/array.js\":\"baf2ef251c364caa\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/backlinkAutocomplete.js\":\"b6cef03d7eee78e0\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/blockCrumbs.js\":\"e2b091d85a6a9265\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/blockrefAutocomplete.js\":\"2d1993de640394a8\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/cadencedIdleJob.js\":\"95ae9f65a8ac666a\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/callbackSet.js\":\"8da289b026517d19\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/clientId.js\":\"c9fddf2f11121a74\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/codemirror.js\":\"f0322b20aec95a0c\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/codemirrorCompletion.js\":\"85e4cb397439512b\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/copy.js\":\"a11944d2684ae8af\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/dailyPage.js\":\"3740c9d6f4d9c4ab\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/dbForensics.js\":\"b5c5c675905c9350\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/dbForensicsHooks.js\":\"efde9386c64c21ce\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/deleteBlockThroughUi.js\":\"227356e6677abb0d\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/dialogs.js\":\"10ecae25973f7948\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/dom.js\":\"ee511bd4350b7e62\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/downloadBlob.js\":\"125e881a93b719b1\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/drawnWalk.js\":\"c7e1661d0a84c43e\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/exportSqliteDb.js\":\"88d1ab6f7d689026\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/fileSystemAccess.js\":\"4f10ef518a749886\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/flipSlide.js\":\"7ee51a3b60ce3ed4\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/fnv1a.js\":\"17b4745921913379\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/formatBytes.js\":\"1a11a1b65bc9a0cf\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/fuzzyRank.js\":\"d227ccd22a3555de\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/idbKeyedStore.js\":\"c5bd02e70ab92032\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/idleCallbackPolyfill.js\":\"a0b2e51264a9a87e\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/keyboardAwareScroll.js\":\"1682ccf3387be856\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/keyboardViewport.js\":\"b1a0aa045baf1628\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/lastWorkspace.js\":\"17f298cebb149dbd\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/layoutColumns.js\":\"606d0ba021a5c570\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/layoutSessionDom.js\":\"f45102ca92fdf6d5\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/layoutSessionId.js\":\"c703b9c8955f02ae\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/linkClickGestures.js\":\"f331c994d8d7f405\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/linkTargetAutocomplete.js\":\"f12c930aa85744f4\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/localDbCorruption.js\":\"084b784a5ba5955f\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/localDbRecovery.js\":\"189f9eadc9a30849\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/markdownParser.js\":\"e09acbbfdbd7865f\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/memoize.js\":\"454cc8ed52799af9\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/nameFieldCommit.js\":\"444edcb636a7c410\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/nameList.js\":\"0ad209bed0938fee\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/navigation.js\":\"e472bb3b19ce402a\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/omnilinerNamespace.js\":\"f84af1a59e39699f\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/opfsPageScan.js\":\"d72ea932db0d2707\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/panelClearance.js\":\"9b1ed15aa0e2b376\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/panelHistory.js\":\"f88dc741cff8d176\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/panelLanes.js\":\"bcded8d77afcc686\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/panelLayoutProjection.js\":\"b337cd537967f4e8\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/panelScrollAnchor.js\":\"0ded6d7de5a4f46e\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/panelUrlFlags.js\":\"44902453a78d198d\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/platform.js\":\"2a9297cd3bc76b5c\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/pluralize.js\":\"4ffa06801a132dc9\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/propertyCreation.js\":\"171d9e2b131e2e9b\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/propertyNavigation.js\":\"592502de6a0c4097\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/propertyValueContext.js\":\"fa5cf88d905f5496\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/react.js\":\"1efd2b24611c8294\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/relativeDate.js\":\"34283be981fece75\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/relativeTime.js\":\"15774f3e3f8017d9\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/renderScope.js\":\"e8583a7f3f83ef8f\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/resolvedThenable.js\":\"3f298e6788ff4901\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/routing.js\":\"d85ca2d3e49e0377\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/safeMode.js\":\"65ca23585348ff0a\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/scheduleIdle.js\":\"b70a9659c02a91e6\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/screenWakeLock.js\":\"8d219bf1c630affa\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/selection.js\":\"278c161505c95228\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/softKeyboardGrab.js\":\"fc8b86142f7abcc9\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/startupTimeline.js\":\"33678d35fde75c37\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/state.js\":\"aa4c024990e789ef\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/string.js\":\"36be9d19d1232b9d\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/surfaceZoom.js\":\"187c65ad9b253f99\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/time.js\":\"698a250358920225\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/toast.js\":\"49c50d336059ec32\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/toggleStore.js\":\"31b16c1c608fc302\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/untilStopped.js\":\"dae7b85198792975\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/userActivity.js\":\"ee0017c30172a46f\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/viewTransition.js\":\"e854a3f97f1aac2b\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/viewport.js\":\"bc45dd9e73dc1f00\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/webLock.js\":\"2a176515836e601b\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/workspaceRecovery.js\":\"d52ac20c13629332\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/workspaceSnapshotStore.js\":\"947f7dda6f333635\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-compiler-runtime.js\":\"3b0c817cba615404\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom-client.js\":\"237ed8c85ced6e95\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom-server-edge.js\":\"7e6fd79adf077b63\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom-server.js\":\"f19b3ac6c39fb186\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom-static-edge.js\":\"5872755c0120304d\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom-static.js\":\"57e7e8bedccfa08e\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom-test-utils.js\":\"05e36e046604476f\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom.js\":\"2615645621825641\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-jsx-runtime.js\":\"d04cbd77fa030d35\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react.js\":\"1194db86bbd72432\",\"/knowledge-medium/pr-preview/pr-1874/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1874/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1874/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
