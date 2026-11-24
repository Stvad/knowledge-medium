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
		buildId: "fa0f14332049-6b67c4d1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1874/\":\"50568ce0a682eb69\",\"/knowledge-medium/pr-preview/pr-1874/index.html\":\"50568ce0a682eb69\",\"/knowledge-medium/pr-preview/pr-1874/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1874/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1874/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1874/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1874/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1874/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1874/app.css\":\"141c7ab4732fe1ad\",\"/knowledge-medium/pr-preview/pr-1874/assets/FacadeVFS-DvRy7WC5.js\":\"53ed24c4cd823b88\",\"/knowledge-medium/pr-preview/pr-1874/assets/OPFSCoopSyncVFS-Bil_SCCj.js\":\"ac755e9d10c4055c\",\"/knowledge-medium/pr-preview/pr-1874/assets/OPFSWriteAheadVFS-BsEy7Zxk.js\":\"e536613ff3629593\",\"/knowledge-medium/pr-preview/pr-1874/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1874/assets/wa-sqlite-TOTH2Jnh.js\":\"33ff5a3c08cda943\",\"/knowledge-medium/pr-preview/pr-1874/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1874/assets/wa-sqlite-async-B6vO9MmG.js\":\"209fdce3bbfea13c\",\"/knowledge-medium/pr-preview/pr-1874/assets/worker-C7le3Clj.js\":\"5382ba3723625ede\",\"/knowledge-medium/pr-preview/pr-1874/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1874/chunks/app-DftIvrW8.js\":\"3642f1284b3c4d33\",\"/knowledge-medium/pr-preview/pr-1874/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1874/index.js\":\"fb4a505a6f474dca\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1874/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1874/assets/AccessHandlePoolVFS-DCj9ZRk2.js\":\"0d02443a1f2e391c\",\"/knowledge-medium/pr-preview/pr-1874/assets/IDBBatchAtomicVFS-hMbdUTkK.js\":\"8a31c63e74265434\",\"/knowledge-medium/pr-preview/pr-1874/assets/MemoryVFS-Rwzb432g.js\":\"828b19503cfa8f89\",\"/knowledge-medium/pr-preview/pr-1874/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1874/assets/mc-wa-sqlite-async-Bp-mI1vu.js\":\"8df1216ac7f5a946\",\"/knowledge-medium/pr-preview/pr-1874/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1874/assets/mc-wa-sqlite-fmiEloNN.js\":\"ea51e42fbbf3ec01\",\"/knowledge-medium/pr-preview/pr-1874/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1874/chunks/AccessHandlePoolVFS-9WSeFTPW.js\":\"98cb8dcef7ba5c5a\",\"/knowledge-medium/pr-preview/pr-1874/chunks/FacadeVFS-C-QowDfs.js\":\"a535e4949b2d80ff\",\"/knowledge-medium/pr-preview/pr-1874/chunks/IDBBatchAtomicVFS-MaoBdrQe.js\":\"a159cb3969da7c01\",\"/knowledge-medium/pr-preview/pr-1874/chunks/MemoryVFS-DU3uwr3P.js\":\"dd824c2194a6d538\",\"/knowledge-medium/pr-preview/pr-1874/chunks/OPFSCoopSyncVFS-DWC3KScj.js\":\"5376241db7cdda41\",\"/knowledge-medium/pr-preview/pr-1874/chunks/OPFSWriteAheadVFS-Bpeikr9O.js\":\"ca5ec45e3b2a79e7\",\"/knowledge-medium/pr-preview/pr-1874/chunks/Preview-DurdVrrQ.js\":\"ef0fd491bb310e3a\",\"/knowledge-medium/pr-preview/pr-1874/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1874/chunks/card-CkOmx7gL.js\":\"2aef2459878ec900\",\"/knowledge-medium/pr-preview/pr-1874/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1874/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1874/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1874/chunks/dist-v0_4se1m.js\":\"5366e1230e069c7e\",\"/knowledge-medium/pr-preview/pr-1874/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1874/chunks/mc-wa-sqlite-BAe_AjMO.js\":\"55e332d0669ddc39\",\"/knowledge-medium/pr-preview/pr-1874/chunks/mc-wa-sqlite-async-orcUPvJU.js\":\"0fd23757314e9899\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-ByLjkmDf.js\":\"b03dc66d343cbdd0\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-CSKl0dFW.js\":\"3a4c4711ada2ebb7\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-Cl-8J7PP.js\":\"c5336a65c6c9f33d\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-DHcdyuF0.js\":\"1f1ebf1f6442dae0\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-DPWIXmAU.js\":\"3e056a6af6832f8d\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-Dbty5ypB.js\":\"9da5c351e9384f0e\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-JRIaT_h5.js\":\"94dd5e0b9a4ddc88\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-dom-server-legacy.browser.production-DRX20bOO.js\":\"e5e8670ff6dec103\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-dom-server.browser.production-DIF_ZF5W.js\":\"3313ff4a524f2074\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-dom-server.edge.production-B6FGu67N.js\":\"5349ac3b010a3dbf\",\"/knowledge-medium/pr-preview/pr-1874/chunks/react-l8dth4w-.js\":\"6f053671b43a2d6e\",\"/knowledge-medium/pr-preview/pr-1874/chunks/server.browser-BM6wveDB.js\":\"664944b9b2eda552\",\"/knowledge-medium/pr-preview/pr-1874/chunks/textarea-DMukdtWH.js\":\"0ea11ff95a6d8799\",\"/knowledge-medium/pr-preview/pr-1874/chunks/ui-qONusMRB.js\":\"3157d4823abca25d\",\"/knowledge-medium/pr-preview/pr-1874/chunks/wa-sqlite-async-BO2sesM0.js\":\"be899fd9baf2bd6a\",\"/knowledge-medium/pr-preview/pr-1874/chunks/wa-sqlite-mHF7P0lO.js\":\"e88e4ce54e95af65\",\"/knowledge-medium/pr-preview/pr-1874/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1874/extension-utilities.css\":\"1a2b9a89fd3a3bea\",\"/knowledge-medium/pr-preview/pr-1874/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1874/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1874/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1874/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1874/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1874/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1874/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1874/src/App.js\":\"77e9cf2074a14bd6\",\"/knowledge-medium/pr-preview/pr-1874/src/appUpdate.js\":\"83acf4e5665438e3\",\"/knowledge-medium/pr-preview/pr-1874/src/appVersion.js\":\"aa794e1cc4adb002\",\"/knowledge-medium/pr-preview/pr-1874/src/bootstrap/initialLayout.js\":\"09043dfd94b85edf\",\"/knowledge-medium/pr-preview/pr-1874/src/bootstrap/openWorkspaceData.js\":\"c599dfe6540a8c7a\",\"/knowledge-medium/pr-preview/pr-1874/src/bootstrap/resolveWorkspace.js\":\"514980825f6ad407\",\"/knowledge-medium/pr-preview/pr-1874/src/bootstrap/workspaceBootstrap.js\":\"9a055810388c7838\",\"/knowledge-medium/pr-preview/pr-1874/src/components/BlockComponent.js\":\"1e5819328e2b1b01\",\"/knowledge-medium/pr-preview/pr-1874/src/components/BlockCrumbs.js\":\"e0da53e186cc6edc\",\"/knowledge-medium/pr-preview/pr-1874/src/components/BlockEditor.js\":\"6ff5efd4c6f8c170\",\"/knowledge-medium/pr-preview/pr-1874/src/components/BlockLoadingPlaceholder.js\":\"a578ff12b668ae6b\",\"/knowledge-medium/pr-preview/pr-1874/src/components/BlockProperties.js\":\"510f38e0283bfa9b\",\"/knowledge-medium/pr-preview/pr-1874/src/components/BlockSearchPicker.js\":\"2c8a188548d79133\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ConfirmBulkDeleteDialog.js\":\"d46490c353571302\",\"/knowledge-medium/pr-preview/pr-1874/src/components/DividerHandle.js\":\"466517c2a9db6e7b\",\"/knowledge-medium/pr-preview/pr-1874/src/components/DraftEditor.js\":\"cfa2d3cf9ffd9e6b\",\"/knowledge-medium/pr-preview/pr-1874/src/components/GutterPill.js\":\"554536a54a288bb9\",\"/knowledge-medium/pr-preview/pr-1874/src/components/Header.js\":\"26d69d58a3560856\",\"/knowledge-medium/pr-preview/pr-1874/src/components/LazyBlockComponent.js\":\"426ccd63d103ba76\",\"/knowledge-medium/pr-preview/pr-1874/src/components/Login.js\":\"66dd817a01f4ca23\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ZoomableSurface.js\":\"168535b6973f01f7\",\"/knowledge-medium/pr-preview/pr-1874/src/components/editModeKeepalive.js\":\"73e0d95e6a250d4e\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyDisplay/PropertyDisplayScope.js\":\"106686b1f2851307\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5b0f1b1470df73b4\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/RefPropertyEditor.js\":\"4ed27761524ce251\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/RefTargetTypePicker.js\":\"709f829080ab2589\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/SelectPropertyEditor.js\":\"04d6c40e5a77cea6\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/TypesPropertyEditor.js\":\"692efa2dfd4fb233\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/defaults.js\":\"e854ba2f2321f09d\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/kernelValuePresets.js\":\"bfcbaf5a73dc9962\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/selectablePresets.js\":\"6811ae637c78823f\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyEditors/typesPropertyUi.js\":\"501aa3b71b071fc2\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/AddPropertyForm.js\":\"3d93a7f363a666d0\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/PropertyPicker.js\":\"7795f9bcb67acac5\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/PropertyRow.js\":\"c55870c6842e0dda\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/Rows.js\":\"c377db036d1e70b3\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/actions.js\":\"95a284c8d7175aa7\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/declarationOnly.js\":\"6607c25cf9d7c5b8\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/layout.js\":\"af1d2c6bc71d831c\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/model.js\":\"222be80c908f5aa9\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/shapeUi.js\":\"cc956c5e000815c0\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/shapes.js\":\"82da0b20e900a80e\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ed976e8fc9c8d0d6\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanel/visibility.js\":\"7a72b04b4f40a760\",\"/knowledge-medium/pr-preview/pr-1874/src/components/propertyPanelSections.js\":\"cfb901367c729443\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/BlockEmbed.js\":\"4789aa56d2d65993\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/BlockLink.js\":\"c7ad7a1e21985727\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/BlockRef.js\":\"254e3d19c65a9da5\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/ReferenceLink.js\":\"ecc0438a3a1fa64e\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/cycleGuard.js\":\"4f38b72de50cda75\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/cycleGuardContext.js\":\"b4a4e97e9fc53a43\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/linkInteraction.js\":\"8d01ca35ae9edd42\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/referenceLayout.js\":\"1994c9550011ee44\",\"/knowledge-medium/pr-preview/pr-1874/src/components/references/useBlockRefAncestors.js\":\"249d0627677225fe\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/BlockGutter.js\":\"7a118ccc3df5f94e\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/BlockInfoDialog.js\":\"1599456b37ca8f61\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/BlockTypeBlockRenderer.js\":\"b99cc1581c661648\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/BulletHoverCard.js\":\"c5ce46def8572bc7\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/CodeMirrorContentRenderer.js\":\"f40756f2649d5598\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"473d7032b244844f\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/ColumnResizeHandles.js\":\"1ffe39453c967b2c\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"4fbc4887c6537457\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/DefaultBlockRenderer.js\":\"c1987dc512e63580\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/LayoutRenderer.js\":\"1fcef9ffe5a28ce6\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/MarkdownContentRenderer.js\":\"d126e7748bd6468f\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/MissingDataRenderer.js\":\"9a159a9ad5c53782\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/PanelRenderer.js\":\"38b673abc4485bac\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/PropertySchemaBlockRenderer.js\":\"99745cf670fda3a5\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/TopLevelRenderer.js\":\"bce1673fbd363f40\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/blockGutterMode.js\":\"85f56b304b80dab6\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/blockTitleText.js\":\"92724527591595a3\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/fieldCreationKeydown.js\":\"1056bb73facee931\",\"/knowledge-medium/pr-preview/pr-1874/src/components/renderer/layoutRootContext.js\":\"f4078243df2b0ef7\",\"/knowledge-medium/pr-preview/pr-1874/src/components/typeChip/TypeChip.js\":\"e918f40a397f26c3\",\"/knowledge-medium/pr-preview/pr-1874/src/components/typeChip/chipStyle.js\":\"5648931e869a9718\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/anchored-floating.js\":\"4b3fd4a0fb9b3839\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/button.js\":\"9561acbb3a992587\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/card.js\":\"dd7810d398256599\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/checkbox.js\":\"30e0f680a06c0c27\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/collapsible.js\":\"76b16fbb4783104c\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/command.js\":\"edfb630fd818b0f6\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/context-menu.js\":\"a0ba49443e473182\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/dialog.js\":\"2ae19acda9dce594\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/dropdown-menu.js\":\"7315e0cea8a67f68\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/floating-listbox.js\":\"27bfd586c89e4314\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/index.js\":\"d271a70d4a93c98b\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/input.js\":\"2e1aa88106c686c4\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/kbd.js\":\"c9c10bb35d0f34e0\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/label.js\":\"53336399aa445ba7\",\"/knowledge-medium/pr-preview/pr-1874/src/components/ui/textarea.js\":\"40bed9dfbb908624\",\"/knowledge-medium/pr-preview/pr-1874/src/components/useEditModeYieldKeepalive.js\":\"81a4bef537d616eb\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/BootFallback.js\":\"95c80609ab839157\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/FocusedRowLazyMount.js\":\"e612f8db5750b669\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/LazyViewportMount.js\":\"d20f92e8c1f12c98\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/LocalDbCorruptionFallback.js\":\"5699e2c79de8252b\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/error.js\":\"ebcbd72aacb907c1\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/lazyMountRegistry.js\":\"72830dbebcb377a9\",\"/knowledge-medium/pr-preview/pr-1874/src/components/util/suspense.js\":\"42f0ecd450ac9c3b\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/CreateWorkspaceDialog.js\":\"1d2ca3d97f8b0bf7\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/PendingInvitations.js\":\"1bd437ec936a6d26\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/SyncProgress.js\":\"f9f2ba1ebe9d0677\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/UnlockProgress.js\":\"8301326eda222021\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/WorkspaceKeyGate.js\":\"f20c1fc0f00c9364\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/WorkspaceSettingsDialog.js\":\"aa264797f524cd47\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/WorkspaceSwitcher.js\":\"1ed6cca40bdb6dd5\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/WorkspaceSyncGate.js\":\"8d9e712b73739e08\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/ConversionFlow.js\":\"6a4450fc0325e8e4\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/ConversionFlowHost.js\":\"b36ecac98fb0662c\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/EncryptionSection.js\":\"1d8b22edc6b06849\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/attachmentPrompts.js\":\"e4a00ef805a6d81a\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0c26e51bdee665fe\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/conversionFlowDeps.js\":\"fa76f897f65ae816\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/conversionFlowStore.js\":\"71e2051d5801d6ad\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/flowUi.js\":\"0f02150fdfbcf291\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/conversion/useConversionRun.js\":\"60adf4b5196f40c8\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/keyUi.js\":\"b2c98fde7986052b\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/useCloseOnKeyLoss.js\":\"7812d1c0a233cfff\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/useCloseOnServerE2ee.js\":\"5f6e20f54d64c68c\",\"/knowledge-medium/pr-preview/pr-1874/src/components/workspace/workspaceUnlocked.js\":\"75af8a97fe785caa\",\"/knowledge-medium/pr-preview/pr-1874/src/context/backgroundSubtree.js\":\"f785737090b76bdb\",\"/knowledge-medium/pr-preview/pr-1874/src/context/block.js\":\"80e7218abf3d1eae\",\"/knowledge-medium/pr-preview/pr-1874/src/context/layoutWsContext.js\":\"6f7f95cb064e3524\",\"/knowledge-medium/pr-preview/pr-1874/src/context/propertyDisplay.js\":\"44e64f2232f71dad\",\"/knowledge-medium/pr-preview/pr-1874/src/context/repo.js\":\"ceb2e106d928aeac\",\"/knowledge-medium/pr-preview/pr-1874/src/data/aliasClaim.js\":\"28414975c6019df4\",\"/knowledge-medium/pr-preview/pr-1874/src/data/aliasSeatNamespace.js\":\"e805d2bd160f3a4c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/blockData.js\":\"20b85e75656d58f7\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/blockType.js\":\"b33b4706a193fb73\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/changeScope.js\":\"1247d8582a840025\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/codecs.js\":\"428a870975e42c1b\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/derivedData.js\":\"9a52d12a5c56831c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/errors.js\":\"a5acc36e917a57fa\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/events.js\":\"ba46a17f9afcfd2b\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/handle.js\":\"1521e1d1320eed5e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/index.js\":\"56759d59f39150f2\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/mutator.js\":\"71fa7cc469242723\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/processor.js\":\"a39bddb9c2876dea\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/propertySchema.js\":\"f06f33bc20b659b5\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/query.js\":\"125f13cc11e52bde\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/sameTxProcessor.js\":\"7e9e5e1102d8ec95\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/schema.js\":\"1521e1d1320eed5e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/tx.js\":\"1521e1d1320eed5e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/typedBlockQuery.js\":\"ed19575153a06959\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/user.js\":\"9f67c3c5b144a327\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/valuePresetCore.js\":\"2266ce034677cb9e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/api/valuePresets.js\":\"1a831d3c03da0316\",\"/knowledge-medium/pr-preview/pr-1874/src/data/attachmentCleanerIOVerb.js\":\"ba48f22689edf9cc\",\"/knowledge-medium/pr-preview/pr-1874/src/data/block.js\":\"555817d7bcd9a7d6\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockCache.js\":\"4bbb111674a13b7a\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockId.js\":\"f9c1d35b90834a7d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockLiveness.js\":\"bfe63786afd39567\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockMerge.js\":\"2db80acab539be30\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockSchema.js\":\"be340e0330eed79f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockTypeLookup.js\":\"6022b35e7a98b206\",\"/knowledge-medium/pr-preview/pr-1874/src/data/blockTypes.js\":\"79487f662a977018\",\"/knowledge-medium/pr-preview/pr-1874/src/data/childrenView.js\":\"611e9dbd1224c36d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/clientContext.js\":\"fe0902c92eba2ef6\",\"/knowledge-medium/pr-preview/pr-1874/src/data/dbFileSiblings.js\":\"ab00efcafb68d2fe\",\"/knowledge-medium/pr-preview/pr-1874/src/data/definitionSeeds.js\":\"fddf5e2a716d4010\",\"/knowledge-medium/pr-preview/pr-1874/src/data/derivedIds.js\":\"1f78a3773caf3cbf\",\"/knowledge-medium/pr-preview/pr-1874/src/data/drawnSubtree.js\":\"8ede4a11a48d938a\",\"/knowledge-medium/pr-preview/pr-1874/src/data/facetBridge.js\":\"f8f51d203e23e26e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/facets.js\":\"fc7505b810a01dfd\",\"/knowledge-medium/pr-preview/pr-1874/src/data/globalState.js\":\"fa178af9e241fb09\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/aliasClaimRederiveProcessor.js\":\"c8d37a83f516e6e4\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/ancestorBatch.js\":\"4e093b5b22d88560\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/blockTypeTypeifyProcessor.js\":\"eeb9ef039f96157a\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/clientSchema.js\":\"a60023ffe1929227\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/commitPipeline.js\":\"29e98e422ba1875e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/devAssertions.js\":\"06aff6b06ef9d50e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/firstSync.js\":\"316e4f38bd949826\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/freshInitialLoad.js\":\"599b3951626f2e17\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/graphBackfillClaim.js\":\"b3fa2653e5469e6c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/handleStore.js\":\"776f375a1a75f578\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/idleMarkerJobs.js\":\"88033fbe26748f5b\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/initialDownload.js\":\"74f395a3c44d58ad\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/initializeClientDatabase.js\":\"45127ea5f77bb377\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/jsonCanonical.js\":\"144d1a9747a6fc54\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/kernelInvalidation.js\":\"b2b3e9bd0f9733dd\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/kernelProcessors.js\":\"04b87dfff03e3ec9\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/kernelQueries.js\":\"2aa0392fc6740f2b\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/mergeTypeMembershipProcessor.js\":\"2db6ef75c09f80f3\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/normalizeReferencesProcessor.js\":\"a88aeadb46dde31f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/poolInstrumentation.js\":\"608dded7021ed69d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/processorRunner.js\":\"259f50dc5130d84b\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyCellBackfill.js\":\"083a77e23b4073ad\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyChildMint.js\":\"37084d7e54617bcb\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyChildrenProcessor.js\":\"8c0ac0dca629fcc2\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyDefinitionChangeProcessor.js\":\"439d6bf5e7e388a7\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyDefinitionSynthesis.js\":\"2452093856d7495f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyKeyScan.js\":\"51035ce067586936\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertySchemaResolution.js\":\"10470f996e54485f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/propertyValueEdits.js\":\"9f69d8f6211c09e1\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/raiseProtocol.js\":\"ed9038c4d4476190\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/readBatch.js\":\"0d24401d367b8535\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/refProjection.js\":\"6f280d640a3bbf0e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/referenceTargetLookups.js\":\"4f5a19f46043771f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/referenceTargetProcessor.js\":\"1e09a24b4c414dde\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/replayMerge.js\":\"b414a96ceb4cfd55\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/sqlBinds.js\":\"1e1f517f79418503\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c62c8bce8a87d7c7\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/syncObserver/arrivalProcessors.js\":\"45b84b5c056436d2\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/syncObserver/invalidate.js\":\"e32ea7af5ddbdcea\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/syncObserver/materialize.js\":\"ef57b34cdc5bc943\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/syncObserver/observer.js\":\"c6ef30d547a882b4\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/syncObserver/reconcile.js\":\"b7faf44cfd287fcb\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/timingMetrics.js\":\"83c4e98b5a4b5e8e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/treeQueries.js\":\"d1710d322653ff52\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/txEngine.js\":\"4a3985da999ed483\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/txSnapshots.js\":\"1a00c5528bc959dd\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/typedBlockQuery.js\":\"ba57ac6cdb7ac41d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/internals/undoManager.js\":\"ef2427ba56f99499\",\"/knowledge-medium/pr-preview/pr-1874/src/data/invalidation.js\":\"73dbb136b98c1a2b\",\"/knowledge-medium/pr-preview/pr-1874/src/data/kernelDataExtension.js\":\"878042746a767214\",\"/knowledge-medium/pr-preview/pr-1874/src/data/kernelPage.js\":\"01ef6cda4e1dc52c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/kernelValuePresetCores.js\":\"a1cee67b5e2e689e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/localDbCorruptionSignal.js\":\"6b0d530a7144978e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/localDbStorage.js\":\"74afd6bac1a132a9\",\"/knowledge-medium/pr-preview/pr-1874/src/data/localDbVfs.js\":\"489546aab71b0451\",\"/knowledge-medium/pr-preview/pr-1874/src/data/localSchema.js\":\"09327a27a51b1464\",\"/knowledge-medium/pr-preview/pr-1874/src/data/maintenance.js\":\"5f2a8d6a00bb9838\",\"/knowledge-medium/pr-preview/pr-1874/src/data/mergeProperties.js\":\"35fd8f748815e30b\",\"/knowledge-medium/pr-preview/pr-1874/src/data/metricsConsoleHook.js\":\"793a30f7d3bdba37\",\"/knowledge-medium/pr-preview/pr-1874/src/data/migrationsPage.js\":\"235430eb0446f98c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/mutators.js\":\"0f70ffe71b13c460\",\"/knowledge-medium/pr-preview/pr-1874/src/data/orderKey.js\":\"1d6083a0148ebe13\",\"/knowledge-medium/pr-preview/pr-1874/src/data/orderKeyPlacement.js\":\"cddf79936c58cff2\",\"/knowledge-medium/pr-preview/pr-1874/src/data/outlineSurface.js\":\"6fde4e0f697545d4\",\"/knowledge-medium/pr-preview/pr-1874/src/data/pendingEditorContent.js\":\"584ec07a446e7db4\",\"/knowledge-medium/pr-preview/pr-1874/src/data/pendingUploadsSql.js\":\"f244aa83551125ee\",\"/knowledge-medium/pr-preview/pr-1874/src/data/pluginStateExtensions.js\":\"0e7240580842ae8e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/powerSyncLogger.js\":\"42c52600d4e9b576\",\"/knowledge-medium/pr-preview/pr-1874/src/data/projectorRuntime.js\":\"9522d1d1ef791f3c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/properties.js\":\"2264f5b9f3cdeb02\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertiesPage.js\":\"469dd002d716b664\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertyChildren.js\":\"c91705cf80e7ee98\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertyDefinitionFanout.js\":\"6e82c5e3969cdf0c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertyDefinitionMetadata.js\":\"aea7908135fd91c4\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertyDefinitionRegistry.js\":\"49a71add9b138060\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertyDisplayMode.js\":\"2d2fbef275a9f4a9\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertyRowCreation.js\":\"363bad153ef2c6b1\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertySchemaCreation.js\":\"bb7e47c39064e655\",\"/knowledge-medium/pr-preview/pr-1874/src/data/propertySeeds.js\":\"6ec3a4ba4a61ac4c\",\"/knowledge-medium/pr-preview/pr-1874/src/data/recentsPage.js\":\"b8cee4719ae61569\",\"/knowledge-medium/pr-preview/pr-1874/src/data/referenceBlock.js\":\"5f1bda5d8feb748f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/rejectedUploads.js\":\"e28cbada7da170ea\",\"/knowledge-medium/pr-preview/pr-1874/src/data/releasePowerSyncConnection.js\":\"596d968f73a7d83f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/repo.js\":\"1ad34ee52b902159\",\"/knowledge-medium/pr-preview/pr-1874/src/data/repoProvider.js\":\"13adfef1d39bb404\",\"/knowledge-medium/pr-preview/pr-1874/src/data/rowProperty.js\":\"9cbcda77669b5d81\",\"/knowledge-medium/pr-preview/pr-1874/src/data/searchFilter.js\":\"29626e38c730ae08\",\"/knowledge-medium/pr-preview/pr-1874/src/data/seedIdentityLedger.js\":\"3c0cd4846533d8fa\",\"/knowledge-medium/pr-preview/pr-1874/src/data/stateBlocks.js\":\"e061853b7c561d9f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/structuralEditPolicy.js\":\"9b94a59ed5b90a70\",\"/knowledge-medium/pr-preview/pr-1874/src/data/structuralInsert.js\":\"c02d0cc9d61e0883\",\"/knowledge-medium/pr-preview/pr-1874/src/data/subtreeDelete.js\":\"2004e7fa267d8810\",\"/knowledge-medium/pr-preview/pr-1874/src/data/syncStreamLock.js\":\"de7560e99e4e1e0e\",\"/knowledge-medium/pr-preview/pr-1874/src/data/syncedTableSqlRecognizer.js\":\"23b05cb19c7ae410\",\"/knowledge-medium/pr-preview/pr-1874/src/data/syncedTableWriteGuard.js\":\"fcebc08d1e93bdf7\",\"/knowledge-medium/pr-preview/pr-1874/src/data/targets.js\":\"d2bc0e0e5884acdd\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeColors.js\":\"c1c8701da5605b73\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeDefinitionMetadata.js\":\"8433e982272f53e7\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeDefinitionRegistry.js\":\"d9eebf1cb119d5bc\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeExtraction.js\":\"f19cd4bd7a974021\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeInitialValues.js\":\"7bd4e0ff72e666b7\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typePropertyGroups.js\":\"f050a2bde5c2b467\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeSeeds.js\":\"57c568e07e40119a\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typeTagger.js\":\"b5aed854332c1544\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typedRecords.js\":\"347b65269a62306f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/typesPage.js\":\"ecb44a0d97d8a892\",\"/knowledge-medium/pr-preview/pr-1874/src/data/userPrefs.js\":\"de339054cea6523d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/userSchemasService.js\":\"8c2b6b568cad7f49\",\"/knowledge-medium/pr-preview/pr-1874/src/data/userTypesService.js\":\"514ef0a0df0f00e7\",\"/knowledge-medium/pr-preview/pr-1874/src/data/valuePresetRegistry.js\":\"61cb7a8a64f80e27\",\"/knowledge-medium/pr-preview/pr-1874/src/data/visibleChildren.js\":\"47878a899f95fe88\",\"/knowledge-medium/pr-preview/pr-1874/src/data/workspaceConversion.js\":\"0c2a690503cbd379\",\"/knowledge-medium/pr-preview/pr-1874/src/data/workspaceFirstSync.js\":\"1b20ae80aaec1e4f\",\"/knowledge-medium/pr-preview/pr-1874/src/data/workspaceIdNamespace.js\":\"c44835ad8a3b10fa\",\"/knowledge-medium/pr-preview/pr-1874/src/data/workspaceSchema.js\":\"324874b7263c050a\",\"/knowledge-medium/pr-preview/pr-1874/src/data/workspaces.js\":\"0f65b5950941e5b2\",\"/knowledge-medium/pr-preview/pr-1874/src/data/writeAheadLog.js\":\"2d4d801949f5ca9d\",\"/knowledge-medium/pr-preview/pr-1874/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/BlockPasteShellDecorator.js\":\"016111226d1dee3d\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/atTrigger.js\":\"5a11d282060de254\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/autocomplete.js\":\"5461b52b1eda611d\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/codeMirrorExtensions.js\":\"c35e22797db02f28\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/contentFlush.js\":\"7211efde1a93437b\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/defaultInteractions.js\":\"76feb74deea960aa\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/editSettleSignal.js\":\"54b1381ae56686cb\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/insertImage.js\":\"643b496269969bfb\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/referenceCompletionRange.js\":\"524572479c66558d\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/referenceTargetTypes.js\":\"d06c30dd9c8085c5\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/syntaxContext.js\":\"6af54f589849bd1d\",\"/knowledge-medium/pr-preview/pr-1874/src/editor/triggerMatch.js\":\"b64773f09a911ad4\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/AppRuntimeProvider.js\":\"177e92a493b9bbd5\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/BlockFocusShellDecorator.js\":\"5a20a99f241a52c8\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/ExtensionRenderBoundary.js\":\"9416be0a699f3631\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/PanelContentRecovery.js\":\"fa069ffe4b1745b9\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/apiCatalog.js\":\"392e2231a39153f6\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/approveExtensionHere.js\":\"1d9ba56e8b8bb7cc\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/armedCutAppMount.js\":\"0b5c50ad01965027\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/batchableKeyedStore.js\":\"a2cb7b24962fe0b9\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/blockInteraction.js\":\"46b44124bd133e2d\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/blockSelectionAction.js\":\"67b13f0ef0162e7e\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/compileExtensionModule.js\":\"4b493e4a0d6cabd6\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/compiledModuleCache.js\":\"d8990b00c7d933fd\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/continuousGestures.js\":\"679fe47da24002ec\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/core.js\":\"cadf96471de0ea45\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/defaultRenderers.js\":\"51bb14539c921912\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/definitionFanoutAppMount.js\":\"b660acae4531d828\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/dialogAppMount.js\":\"5a676b40ffc368a0\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/dynamicExtensionSeeds.js\":\"0f9a7d5a5f1ca375\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/dynamicExtensions.js\":\"f09981ccf1da99c0\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/exampleExtensions.js\":\"75859a7a66cf14b3\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/extensionApprovalStatus.js\":\"92c6cb863f639349\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/extensionLoadErrorToast.js\":\"535bf9eb0e2b2eb5\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/extensionLoadErrors.js\":\"ba8f3d65696deaf7\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/extensionLookup.js\":\"95f1fdc92809b13b\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/extensionToggles.js\":\"ce74a0cf372498af\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/extensionUtilitiesCss.js\":\"b63a5121bb16b904\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/kernelPageDeletionGuard.js\":\"e9d38d2a0b556d57\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/liveRuntime.js\":\"f8bcd7feb6b44ea2\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/openExtensionsSettings.js\":\"f92f543f18b4dd74\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/overridesCache.js\":\"1daf91a659446480\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/pluginIds.js\":\"a39ae79bc20c79a5\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/processorRejectionToast.js\":\"f9212bd9b64a47fb\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/runtimeActions.js\":\"5d3108739c5b5b53\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/runtimeContext.js\":\"0579b7c7fdc27c60\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/staticAppExtensions.js\":\"2accb1a3157901ff\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/staticDataExtensions.js\":\"f4d0ff1e5b48c040\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/toastAppMount.js\":\"107c3532e186f095\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/useOverrides.js\":\"5c3370bfcde93480\",\"/knowledge-medium/pr-preview/pr-1874/src/extensions/useShortcutSurfaceActivations.js\":\"37df0277e9ab5fd9\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/discoverToggleTree.js\":\"7b2cd325babb4075\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/facet.js\":\"3af9ab9e7510f0a1\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/resolveAppRuntime.js\":\"36768364228e21a6\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/runtimeEvents.js\":\"eb18e30c9996e539\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/togglable.js\":\"4bcd44cd9245dbc1\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/variantFacet.js\":\"51ff056791ffbd01\",\"/knowledge-medium/pr-preview/pr-1874/src/facets/verbFacet.js\":\"8cbabb0c3809365f\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/block.js\":\"c3b9b38a5a19e073\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/focusedChild.js\":\"d320ec8282225de3\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/propertySchemas.js\":\"97d3bc12b79317b8\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/typeRegistry.js\":\"6afed353f7d206ed\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useAncestorCrumbs.js\":\"205bcab0a4e2c1b6\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useAutocompleteListbox.js\":\"20bea21e52185ec8\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useDebouncedSearch.js\":\"8906e388754fd968\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useDebouncedValue.js\":\"4e4c5892e07a175b\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useIsFocalRender.js\":\"81a5fd917adcd4da\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useIsReadOnly.js\":\"b6336366de0fb513\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useMaterializeBacklog.js\":\"a8c0a9d8e5a3afe5\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useMinuteClock.js\":\"5057b29367ed88d9\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/usePanelLayoutProjection.js\":\"7dbc31187572f21b\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/usePendingInvitations.js\":\"6b59bab04ad77e46\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useRendererRegistry.js\":\"3a3090d374086084\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useRetainedFieldRows.js\":\"97567a2d7cdad30d\",\"/knowledge-medium/pr-preview/pr-1874/src/hooks/useWorkspaces.js\":\"a6847bba84793a7d\",\"/knowledge-medium/pr-preview/pr-1874/src/lib/utils.js\":\"1a6799ad0483449f\",\"/knowledge-medium/pr-preview/pr-1874/src/main.js\":\"175a2913bc2b4d8b\",\"/knowledge-medium/pr-preview/pr-1874/src/markdown/MarkdownImage.js\":\"66189cce32000104\",\"/knowledge-medium/pr-preview/pr-1874/src/markdown/blockSeparators.js\":\"12dd0d7785222781\",\"/knowledge-medium/pr-preview/pr-1874/src/markdown/context.js\":\"185a651116f97824\",\"/knowledge-medium/pr-preview/pr-1874/src/markdown/defaultMarkdownExtension.js\":\"a3aa71dbdb2d68eb\",\"/knowledge-medium/pr-preview/pr-1874/src/markdown/extensions.js\":\"0c42183fd3c62b4f\",\"/knowledge-medium/pr-preview/pr-1874/src/markdown/renderMarkdownHtml.js\":\"4fa0d6405c18adef\",\"/knowledge-medium/pr-preview/pr-1874/src/minimal-editor.js\":\"ea4eb9d35f95f9be\",\"/knowledge-medium/pr-preview/pr-1874/src/paste/armedCut.js\":\"bee5a24f3ca96fe2\",\"/knowledge-medium/pr-preview/pr-1874/src/paste/captureMediaVerb.js\":\"739599632239ba99\",\"/knowledge-medium/pr-preview/pr-1874/src/paste/clipboard.js\":\"48297706a5a90bf6\",\"/knowledge-medium/pr-preview/pr-1874/src/paste/decision.js\":\"b7a1667d4f14aa39\",\"/knowledge-medium/pr-preview/pr-1874/src/paste/operations.js\":\"2fa33e0c5a9ed3af\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/account-header/AccountHeaderItem.js\":\"f2cd52bb7f5775c5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/account-header/index.js\":\"4771311ddd567b9b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ef81e17a720b3778\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/askAgent.js\":\"825919402d9d82af\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/askedStore.js\":\"693b1af6000e2e40\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"58409412788d4098\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/chipState.js\":\"cf0b09b0fbab7e2c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/dataExtension.js\":\"a15e83d9b215e24a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/index.js\":\"7690397fc886cf23\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b966dcf42a738e42\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-dispatch-companion/schema.js\":\"d7a0040121b1eb3d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/AgentTokensDialog.js\":\"164daac073cacae9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/BridgePairingDialog.js\":\"85a4c7c485f21c76\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/addMedia.js\":\"9a0941703ac75bc6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/backlinks.js\":\"dd6ae60bddde0bc8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/block.js\":\"cd4d4463bd48e6f4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/context.js\":\"7ab7e2732209f5b0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c7fbced3ec36f821\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/index.js\":\"81a5a1c8ded5f7c7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/outline.js\":\"aa2c05b2584982ff\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/properties.js\":\"5f7e3c98b5a898c9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/refs.js\":\"4964eb8bc624c863\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ae5dbab2f8b6af3c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/search.js\":\"07b4cd97f149d08d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/shared.js\":\"4a452d2e9e9a633d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"7b6d9b3c56f7ccb8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentViews/text.js\":\"cdf25035efec3399\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/agentWrites.js\":\"d8d7fe734d5b46e3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/authoringCatalog.js\":\"243bd8df6fb22b76\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/blockRefTargets.js\":\"4cc2b1041fe49491\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/bridge.js\":\"6bb985c793c6b506\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/bridgeLoop.js\":\"b97907d50fe3718c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/changeHistory.js\":\"bc98436028034e6b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/commands.js\":\"0c44146c55f9e8d6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/commentsCommands.js\":\"0a5bee82bf9f3f4c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/dataExtension.js\":\"548fe1c64e6da42f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/dataModelGuide.js\":\"1210644c884d73c9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/describeRuntime.js\":\"8a1fcb4b788cb9b4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/extensionLint.js\":\"07b410fae2f2d160\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/grainAudit.js\":\"9b593b9a5e9f4760\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/healthCommand.js\":\"96817f164b1d468b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/index.js\":\"3d304750251436b2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/presetIdentity.js\":\"15b44eb867d061b3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"0ab75ed0abc65fae\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/readMedia.js\":\"3fba5754ded407b4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/schema.js\":\"1731e5e94384fa5f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/serialization.js\":\"36e9084622f3484b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/targets.js\":\"6857fe45c18881f4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/tokens.js\":\"4c492ef8412596bc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/watchEvents.js\":\"99e1c4692cab961b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/workspaceGuard.js\":\"2a3c6caa59706011\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/agent-runtime/writeCommands.js\":\"b62b7c5f6b6598fa\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/AliasCollisionToast.js\":\"7b245b9428304a3a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/DuplicateNameBanner.js\":\"5981bccc4016e067\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/collisionMerge.js\":\"7a4b58a52762d964\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/dataExtension.js\":\"fbf50834bcaa68ee\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/index.js\":\"f827a9c1dccb9264\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/mergeCollisionAction.js\":\"fce8ce79b2b05783\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/pageStyling.js\":\"520ec4c5811dc150\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/rejectionToast.js\":\"0e47bee2d0316c06\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/alias/syncProcessor.js\":\"c69c2a7618b92e78\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/actions.js\":\"85edc2beaed338db\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/addComment.js\":\"260bd96e3164bb5a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/anchor.js\":\"718bde26dd3e1333\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/anchorState.js\":\"0315e52803cec955\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/commentLinks.js\":\"1db7ccf9fe3b3ee8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/confirmThreadDeletion.js\":\"f1f8bc4af654811e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/container.js\":\"f7aa7d612bd2da4a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/dataExtension.js\":\"e486e8802fda21ec\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/deleteComment.js\":\"baaeff79a8218144\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/highlights.js\":\"c9c220610bdda08f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/index.js\":\"b65050d0435708cb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/linkedCommentsPill.js\":\"251eb8da3156d2a5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/margin.js\":\"3cb1c42113e05567\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/marginSchema.js\":\"3431d2584741a8e7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/newComment.js\":\"27163df4c735d181\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/ownThreadPicker.js\":\"5b5484f3ecb8a60f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/placement.js\":\"c1f0aefe66181242\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/queries.js\":\"e956a71f12592f64\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/quotePosition.js\":\"630d5948a9d75773\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/quotedIn.js\":\"f8b75379288b0ca5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/quotedRange.js\":\"cb4495bad04f0dad\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/rangeRefs.js\":\"843f5a5b1db1f45e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/readHighlights.js\":\"95466d14e5d1deb3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/readSelection.js\":\"7b3e895c0c9e0e77\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/readSelectionUi.js\":\"bf724850ac2bc94b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/reanchor.js\":\"fd7005cfad2ee7e5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/schema.js\":\"10c678739b825876\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/scope.js\":\"84ad27560e63131c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/scopeThreads.js\":\"f96769ac9c659dae\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/splitRetarget.js\":\"60ae09d17bdfef42\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/suggestionCard.js\":\"d818413d728393a4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/suggestions.js\":\"b94c438f8115e063\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/summaries.js\":\"6b0fc26e2ad95430\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/summaryBatch.js\":\"b272869977183b19\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/surface.js\":\"bb636b757761793f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/threadNavigation.js\":\"2f3c96b616f7be2c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/threads.js\":\"ed3df88edd13e394\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/ui.js\":\"9804bf1d334765ba\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/annotations/uiStore.js\":\"2a33c0244d22a558\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/app-intents/appIntents.js\":\"23cda5ff0f3ef918\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/app-intents/index.js\":\"d213dfc117ec921e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/app-update-prompt/index.js\":\"299107cc59934c3d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/app-update-prompt/status.js\":\"076b16ee037be6fd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"40418e20296e4339\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/MediaBlockRenderer.js\":\"a59c3023bc63cfcc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/MediaDownLaneReplicator.js\":\"bd8f8b8c188a72e3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/MediaUploadReconciler.js\":\"26465dbbc2ef9645\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/assetDownLane.js\":\"9053378d504a2906\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/assetResolver.js\":\"8959edbaf4a9473b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/assetUpload.js\":\"56067873419c0752\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/attachmentCleanerIO.js\":\"1441b8edc5d95e51\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/audit/supabaseAuditIO.js\":\"836242b1ee9e53f7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/blobStore.js\":\"b8dbffd4814676be\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/browserMedia.js\":\"8a511c19ef321008\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/byteStore.js\":\"11ecb5bba8182021\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/cleanerIO.js\":\"d6c9298a2e5530a8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/cleanupAttachments.js\":\"725121387adad56a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/dataExtension.js\":\"7e6ca642a122305f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/downLane.js\":\"3b5f343d00b2b85d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/index.js\":\"3e3d29f6f44ac57b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/insertImageContribution.js\":\"dd67d48613d6ec22\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/laneArming.js\":\"53a066b3613e027b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/laneLock.js\":\"9e1aed2e1944d839\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/mediaBlock.js\":\"e0bd35e16852ada4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/mediaCapture.js\":\"2db420edc7ce2cd7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/mediaLanes.js\":\"dd0adfc335a2e460\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/mediaViewers.js\":\"074d9137179e84c8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/mediaViewersFacet.js\":\"4fcde371e051323f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/pasteCapture.js\":\"26731ea35ce7df88\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/resolver.js\":\"f1df98a1e0d2875c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/retryUploadsAction.js\":\"fb4795419ace39ba\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/storagePaths.js\":\"7c6f96d8cbbc8376\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/uploadDrain.js\":\"3b1ebb33e98cd9bc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/uploadLaneStatus.js\":\"8d999d64c7c87784\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/uploadReconcile.js\":\"1dc266e4a0c2a4a7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/uploadRecovery.js\":\"12e506f1de9e78e8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/uploadStore.js\":\"92658bb02f783fd0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/attachments/useAssetObjectUrl.js\":\"f71e55aa53df64d9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"1c46ca0be3e3b797\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks-view/BacklinksViewSection.js\":\"700f8a903dd1a2d4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks-view/facet.js\":\"7e1d7c7b76507f64\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks-view/index.js\":\"619ea2e2d54913b0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks-view/prop.js\":\"e2eb562443393cdc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/BacklinkFilters.js\":\"983d2479bad380dd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"01cf3103b3c6bef1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/BlockEntry.js\":\"b95a8a788f42be3b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/LinkedReferences.js\":\"f2fec705b4c6c1e3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"19e8007f12110f22\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/dailyNoteDefaults.js\":\"f3dfbd603b6e6d98\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/dataExtension.js\":\"b65fef01776c5d56\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/edgeExclusions.js\":\"e6816e608a3729c8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/filterProperty.js\":\"a4f25d15d6c75edf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/index.js\":\"59df0025adffeff4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"690d48b01d4f8dac\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/inline-counts/applies.js\":\"fb916fd65f61fecf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/inline-counts/countQuery.js\":\"a8edc9de6e94fbde\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/inline-counts/expansionStore.js\":\"e25caffc5bdc0dc8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/inline-counts/index.js\":\"51a6d5f6d0cf72fd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"bde285c2e75f0530\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/presentationInvalidation.js\":\"6aefec89c52d64a7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/propertyEditorOverride.js\":\"923adf98f34044f7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/propertyFilter.js\":\"eed6985bf0084ac6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/query.js\":\"238371214f2441f0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/resolveFilter.js\":\"19d2cd46f1f073b7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/sourceBatch.js\":\"115f1ff25f44fb6d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/sources.js\":\"83b66605f93e0f97\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/useBacklinks.js\":\"c818a564921dc19c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"001d78f8b187f514\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/birthday/BirthdayCelebration.js\":\"9f94369d49a48cf7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/birthday/BirthdayOverlay.js\":\"519dc9527e16a53f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/birthday/gate.js\":\"88cff95b5ebe145b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/birthday/index.js\":\"7bfabae5f6c4e33d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/birthday/wolfTheme.js\":\"2b9fbcb073e57c60\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-drag/BlockDragLayer.js\":\"08cd5014cf7ed444\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-drag/dragController.js\":\"beb89fdf0fe07253\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-drag/dropTarget.js\":\"181c6a1198da5666\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-drag/index.js\":\"e2dbe941ddc0254c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-drag/projection.js\":\"cf40a513445f689c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-info/BlockMetaCard.js\":\"f3e5233ef434b558\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-info/index.js\":\"fe86f5766d188ea1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/AddTagDialog.js\":\"0d3bef7fc1d0d186\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"eff001ac57f55093\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/TagNameIssueHint.js\":\"c3f2e3f91c0265b9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/addTagAction.js\":\"f32246154841273f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/appendTag.js\":\"ba6df9cfa5b62678\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/config.js\":\"a8b822dcf3028942\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/dataExtension.js\":\"d999317925a4f2da\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/index.js\":\"e924bbcc09503f68\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/block-tagging/propertyEditorOverride.js\":\"99f3b025ed2f93e5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/BreadcrumbList.js\":\"a0206da33581d731\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"35b7f08faa77fd0b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/Breadcrumbs.js\":\"eb8106ebb0125b93\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"d78d16fca8afe569\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"50a51bc17ad190ed\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/index.js\":\"9d83269a3b87906c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"67b8f9c8f3420f8e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/CharacterCountItem.js\":\"8cf0c8434ebe9131\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/ProfilePropertyEditor.js\":\"7935dae33ba19c53\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/actions.js\":\"cebacaae702f842a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/blockType.js\":\"e1dfdd9f03c4f82b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/charCount.js\":\"4f47ba367d9e3615\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/dataExtension.js\":\"5ca559b1ad1a6108\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/index.js\":\"e38d23df7929c2d3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/profiles.js\":\"0d7601430cfe15d5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/properties.js\":\"6719d76825f7bd8d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/character-counter/textCounts.js\":\"cf6576581992a303\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/colemak-keybindings/index.js\":\"27eea35862473940\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/CommandPalette.js\":\"9cf04d3ef4bceb32\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/HeaderItem.js\":\"22b65887f2fd9443\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/context.js\":\"0ab2db108c8649e0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/index.js\":\"4ab8f4d2850ffea3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/selection.js\":\"85f6b44f55d93ae7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/toggleStore.js\":\"530f1b4aef4097da\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/command-palette/useCommandPaletteActions.js\":\"ff203a7dd288bb9d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/ContributorBadges.js\":\"0c07a6bf36b67bdb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/author.js\":\"5224898cb001afab\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/codeMirrorExtensions.js\":\"289c0abdb57df84a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/dataExtension.js\":\"a465dded0b48ae10\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/index.js\":\"3e8d48937615854f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/mentionAutocomplete.js\":\"35563efbdebbf2ce\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/processor.js\":\"1beae22ead24b86a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/profiles.js\":\"08d0153a0b4f356a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/queries.js\":\"47c2445278fbba53\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/contributors/schema.js\":\"337e3f4da6e101fe\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"bd32768dc1b8a5c4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4c3b7ad081f2312d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/cursor-follows-scroll/index.js\":\"fd9018b692a3872f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5238405aedf180ce\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e75d89e803fc5816\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/CalendarGrid.js\":\"e4f3ca912c4fd8cb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/DailyNotePicker.js\":\"e6fad9d9ff9b9c65\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"0e078379afe37287\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/DateNavDecorator.js\":\"64c47657339a329d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/DateScrubOverlay.js\":\"54fca18ae544e896\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/HeaderItem.js\":\"2b84dac5f474db3d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/ReschedulePicker.js\":\"e275b438b027e5b9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4732e4b74e85d8eb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/actions.js\":\"9310fc97b750e256\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/blockDateAdapter.js\":\"d9171af5f7bfaced\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/calendar.js\":\"48f32cf354a8f2f1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dailyNotes.js\":\"04bd983378e03067\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dataExtension.js\":\"e57933e5d23decc1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dateScrubActions.js\":\"3143e3c04f52f4e6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dateScrubGesture.js\":\"26b540edaf0c133b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dateScrubGestureActions.js\":\"fecb920c8448228e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dateScrubRecognizer.js\":\"7bf28736923909f4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/deletionGuard.js\":\"a37282807729f844\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/dueQuery.js\":\"5eba5f6d73e3d56d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/index.js\":\"70605328246271c3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/landing.js\":\"65d62190a0522bac\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/localSchema.js\":\"0bd1f316885a1856\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/referenceDateAdapter.js\":\"c59844f87ac13a48\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/rescheduleAction.js\":\"e4b7e8905c9ec853\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/schema.js\":\"8b7f6a2bd5cea980\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/spreadBlockDates.js\":\"6c43b9335d194265\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/spreadDatesAction.js\":\"7fe20a238849cc32\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/today.js\":\"79f3978090ef1b13\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"5097a1a9d2fe539d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"5ce561cbcb7b6a23\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/audit.js\":\"16dccdc2cb46f4e0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/auditAction.js\":\"113c5704bc752939\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/auditRanges.js\":\"631fff139b45f317\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/diagnosticsSource.js\":\"2892a9caca6a7079\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/divergenceScan.js\":\"e3608ea8561e4923\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/index.js\":\"7d2a5180522d9d51\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/propertyChildrenChecks.js\":\"7eff07be09505823\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/referencesMirror.js\":\"3b293a954b4180e1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/rowJson.js\":\"6cf12743435126fa\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/schedule.js\":\"e5563e0b7da01949\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/data-integrity/store.js\":\"2df19a3545278e1f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-maintenance/action.js\":\"2b1a2a9f608da495\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-maintenance/index.js\":\"41c9b37ec4dda046\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-maintenance/plugin.js\":\"ff1f6c27694b6c5d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"3f878d2104414344\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/actions.js\":\"a3d45abc2a1aa7d4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/changeMarker.js\":\"273c17e524013f78\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/diagnostics.js\":\"88012ee3019c651f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/fileSystemAccess.js\":\"8a74f57871eee6ad\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/filenames.js\":\"e860734338b28794\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/index.js\":\"897f3831470d3a48\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/mirror.js\":\"63fb0be52efb1133\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/runLock.js\":\"0f3e19640f333bbf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/runtimeHealth.js\":\"4e7ad9495435508d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/schedule.js\":\"9f8edccc572f8514\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/db-mirror/store.js\":\"dfa93ad059fff85f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/default-themes/index.js\":\"d668e14a4284470e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/default-themes/themes.js\":\"b7d99b521b6d666a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/diagnostics/facet.js\":\"74e394892762062f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/diagnostics/useDiagnostics.js\":\"2d5d7d0c93dcad16\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extension-prompts/dismissals.js\":\"9d7ab78d847b4ebf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extension-prompts/index.js\":\"af4d60a9a462d180\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extension-prompts/status.js\":\"ae85626a9a1f0043\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extension-prompts/store.js\":\"b36bda99f6aca6f9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e503cca82930de5c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b19ccbcb8738fbdb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/actions.js\":\"4a29213406e86421\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/config.js\":\"c16cd7d49ae1660a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/dataExtension.js\":\"ce7b69cbc4f32605\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/effect.js\":\"52047bf49e8e1172\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/index.js\":\"0f15fa8c34c47a84\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/propertyEditorOverride.js\":\"4feb4a565f9ebb75\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extensions-settings/useToggleTree.js\":\"679029bc5f182614\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extract-type/ExtractTypeDialog.js\":\"7e469b4eab20d754\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"92af832b5b5dcd0c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extract-type/PropertyShapePicker.js\":\"70be5c51b37da4a0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extract-type/action.js\":\"3789387c659c1071\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/extract-type/index.js\":\"1ecbe1abcc64a0d4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/FindReplaceDialog.js\":\"8d24838f742b2f86\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/HeaderItem.js\":\"f5a0068d57810aae\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/dataExtension.js\":\"82a1dd2aa9d00b6f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/index.js\":\"268343d14297d15e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/search.js\":\"cd63383d66986b45\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/toggleStore.js\":\"ce4a32b3e5e00e2d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/LocationPropertyEditor.js\":\"8f5facc8c631fc1a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/MapView.js\":\"c94363aac9cd5449\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/blockTypes.js\":\"3fa317f5ad6ac0c9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/codeMirrorExtensions.js\":\"ba2022d9578c1b2a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/createOrFindPlace.js\":\"15e1c14687002ccb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/currentLocation.js\":\"a2056c94662eb559\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/dataExtension.js\":\"cc72ba7611fbfbf7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/geoContentDecorator.js\":\"b52a0e7132d84a21\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/googlePlacesClient.js\":\"cb56b25b3022c4dd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/index.js\":\"1af05f45ce5b63a9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/locationsPage.js\":\"6ad064917a2fa638\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/mapViewport.js\":\"5daad603f8d984c5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/pickCurrentLocation.js\":\"e170d24141437afc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/placeAutocomplete.js\":\"d25833d163336f32\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/placeNameCollision.js\":\"71d27c6ecdd3e697\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/properties.js\":\"d2f1d1e71ec00a2c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/propertyEditorOverrides.js\":\"6057c780ee3f5a71\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/query.js\":\"17d522001e0c2297\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/geo/usePlaceSearch.js\":\"c241dc7247870add\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"48429a19c4397179\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"503b5e19254735d8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"b49f4b273c0cfa3b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/config.js\":\"0e2cd04787fa2356\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/dataExtension.js\":\"52a7a51fe7fe631b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/facet.js\":\"0c946d4244b41399\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/grouping.js\":\"5803f527005773b1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/index.js\":\"ec45295ceeb0dbf8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"75be3e3e65d4e199\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/query.js\":\"73178f81f719ae35\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/resolveConfig.js\":\"557de7b0122d5761\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"fe3bee6179bb38db\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c80b7e495ef7146a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/HtmlDocumentContent.js\":\"50f683262df6e877\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/HtmlFrame.js\":\"d0d145bc2ce08d9b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/actions.js\":\"1ec725506bb623f3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/blockType.js\":\"3c02e4dc02a15452\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/confirmRunScripts.js\":\"a0abadacf822c45b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/dataExtension.js\":\"02ffd22987583ecc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/frameAnnotations.js\":\"1e288827bedd5f69\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/frameDocument.js\":\"0cf0b9e64d3783c6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/frameTheme.js\":\"af26b73d77f2c82d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/index.js\":\"f649082f461dad88\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/scriptConsent.js\":\"e05b1b396a194ec5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/sourceMap.js\":\"aace2c065da6ef41\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/html-document/useDocumentScripts.js\":\"615c51ea08d8b820\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/interaction-metrics/index.js\":\"283f4529623aa8c2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/interaction-metrics/record.js\":\"0b68ed56842a23f6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/interaction-metrics/recordStore.js\":\"8c85bd5c445a1110\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/interaction-metrics/responsiveness.js\":\"232b58e8b3bfcd26\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/interaction-metrics/schedule.js\":\"5f41486bdc727246\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/interaction-metrics/sessionContext.js\":\"093bc61ad8efadfe\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d276283609c3e717\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"903e9e4b14b655db\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/actions.js\":\"fbf6404b226e066a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/config.js\":\"eaee4f4446f1ae84\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/dataExtension.js\":\"35e66ef525eb0256\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/effect.js\":\"4a3b4cb47dbed5ac\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/index.js\":\"fe8fb178b2c6a2c9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/keyCapture.js\":\"52c9cedef60bd4b9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/overrideStore.js\":\"2cab336d67288e02\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b4fd9839a89f33a6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/HeaderItem.js\":\"4d4c555eaa21f803\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/LeftSidebar.js\":\"2780d885f9ee3e4a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/actions.js\":\"22af9142ab9a9493\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/facet.js\":\"1502dd9bf9c85a0f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/index.js\":\"d85f97f83b07c082\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/shortcuts.js\":\"bf118711d47ca0ea\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/left-sidebar/toggleStore.js\":\"9a1ee83ea63d9756\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/merge-blocks/MergePicker.js\":\"a1d37efd9114f3ee\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/merge-blocks/index.js\":\"f30b774e72d7d951\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/merge-blocks/mergeAction.js\":\"d7958161e1418467\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/merge-blocks/strategy.js\":\"225f1be7ec20c577\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-bottom-nav/Button.js\":\"61091138a902200d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"814742eff03281c6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-bottom-nav/defaultItems.js\":\"215652b5c4b6de79\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-bottom-nav/facet.js\":\"a3a317cbd507f377\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-bottom-nav/index.js\":\"51b017169d5f717e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d81e726ef1dc20e2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-keyboard-toolbar/actions.js\":\"db6694d5857bdb67\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"94f6f2124fb434b5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-keyboard-toolbar/facet.js\":\"52ba3c99850dbad7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/mobile-keyboard-toolbar/index.js\":\"7690bba1cd24a4c6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/MoveDestinationPicker.js\":\"3204d2259c885846\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/blockSubtreeMembership.js\":\"eababe0092cb0024\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/contextMenuItem.js\":\"b83f2892a3370cee\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/index.js\":\"c9b1053a6f279513\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/moveAction.js\":\"8cc0a350d3d0c2e2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/moveBlocks.js\":\"068e71c9f019844d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/move-blocks/selectionAfterMove.js\":\"ec20c416a76383c7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/TutorialBanner.js\":\"2c782d45a7053216\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/action.js\":\"493f8fea5e067382\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/bannerDismissal.js\":\"e0e59552d28c6181\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/documents/cheatSheet.js\":\"ad67132d9561d602\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/index.js\":\"f4c2ad90965fd7f2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/keys.js\":\"15cfe9daf2a33fff\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/landing.js\":\"6dd5e1f00aa3e2c2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/outline.js\":\"cb5488d07d36f778\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/onboarding/seed.js\":\"2bada0e4ed03de5c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/PerfTrendDialog.js\":\"d77baaa9b4fd8456\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/analyze.js\":\"637fe0aa106dfb4f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/diagnosticsSource.js\":\"fca2da6cb39dc387\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/index.js\":\"57fae01b86d7f28e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/load.js\":\"3501ed18e1ebbbca\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/monitorRun.js\":\"3c5ebc68cde8a393\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/schedule.js\":\"b7e77bc188aeb2b9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/series.js\":\"a05545aa91f64323\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/store.js\":\"8af6911c05c96755\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/trendAction.js\":\"21604b793dbb4b0a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/perf-monitor/verdict.js\":\"0a03cdfcde3ad6fb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/plain-outliner/clickToEditAction.js\":\"20b2a020c8892a44\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/plain-outliner/index.js\":\"3039c7a8f2c28eca\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/plain-outliner/interactions.js\":\"2a3ef74d1472bbd8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"41463f0a804ed600\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/MigrationGate.js\":\"a2ada9c5183fd379\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/MigrationGateDialog.js\":\"b76a1a70992d5898\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/action.js\":\"30b76fb2fd97708c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/index.js\":\"eb93699430520992\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/localRunMessage.js\":\"36b1c3ef14818a74\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/plugin.js\":\"3d3498313456cff0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/progressReport.js\":\"c3de2e051d00684b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/properties-migration/sweepProgress.js\":\"c0e79c51f6fafeb1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/FieldRowRenderer.js\":\"e29b62e38f72176a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/ValueRowRenderer.js\":\"4a72d67e30c5d35c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/actions.js\":\"c0abafd98fcf0286\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/autocomplete.js\":\"a1e32f7a65afa522\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/fieldRow.js\":\"8063fd27da6702e4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/index.js\":\"163bc04022013ecd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/referenceWarning.js\":\"f9a7a6a08f99399a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/valueAutocomplete.js\":\"169344bd711c40da\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/property-rows/valueSchema.js\":\"ce2c2c2beb8d970c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/HeaderItem.js\":\"923efc08e0472a6b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/QuickFind.js\":\"8868add98bdc8f28\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/index.js\":\"719c2cb0b98d79c3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/recents.js\":\"4c955150a14ee07c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/resultItems.js\":\"66602ce031594f90\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/selection.js\":\"d015a5e170b9cf8b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/quick-find/toggleStore.js\":\"ca1305586b4be2b4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/recents/HeaderItem.js\":\"170a21dc290c98d0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/recents/RecentsPageBlockRenderer.js\":\"1383c4f9ac25cd69\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/recents/grouping.js\":\"2cba68e7c1cdef8f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/recents/index.js\":\"b12a3ac10b0e4f42\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/recents/target.js\":\"5f8bd72eeabb04fe\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/codeMirrorExtensions.js\":\"eea56d92c58de230\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/contentPrefill.js\":\"40260357036dcb86\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/dataExtension.js\":\"9144c3fcae4f5f29\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/index.js\":\"cf34f2426d1a640a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"9be8d3bc0ce75610\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/invalidation.js\":\"f9e6b86c384c5373\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/localSchema.js\":\"dd18b81a408d325c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/blockrefs/index.js\":\"569ba8dd5c745061\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d8bb83cf03c6d387\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/index.js\":\"cf859fafc4d668d0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/referenceNode.js\":\"4b9af09cd6b2b365\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/remark-reference-occurrences.js\":\"37c62049699fade0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b7ae9088f6aedc4e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/wikilinks/index.js\":\"b4dc04229bb42b4a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e762cd4b303991d8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ac1e43eefb3a964a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/mergeRetargetProcessor.js\":\"b2a583e2980d4e8d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/parseFence.js\":\"ecc23920ae2fe5c9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/referenceParser.js\":\"ff89af158bbe11b6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/referenceProjection.js\":\"55b0c14f1d1a4f14\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/referencesProcessor.js\":\"fe7b2fa985c8d7c5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/renameProcessor.js\":\"995011dc49f719dd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/references/spanReplacement.js\":\"d53627aec62dc800\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/rich-paste/htmlToOutline.js\":\"17a4b9f8afa0c852\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/rich-paste/index.js\":\"3a71805a0fb5fef7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f4c70c8354712196\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/rich-paste/pasteDecision.js\":\"da3586b90d085b54\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/action.js\":\"417d74f2f2d6d23e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/blockIds.js\":\"249906c2f5beca77\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/content.js\":\"d35cffee89ec2a9a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/effect.js\":\"84e91f9aaa07e556\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/ids.js\":\"4423c99bcc64a125\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/import.js\":\"4f8a321f59be5530\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/index.js\":\"adb8934b74e39c4e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/plan.js\":\"d799053723c9c13b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/plugin.js\":\"3f4dd119d171fc3a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/promotion.js\":\"9282fd734f99e531\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/properties.js\":\"96ea6b9cbf0ccc74\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/references.js\":\"01305fec032e2711\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/report.js\":\"04e716e3d7ceda17\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/roamMemo.js\":\"694708c4d16da7af\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/runtime.js\":\"fd26add060d285e8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/schemaReconciliation.js\":\"79912b60fcceddd6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/srsMarkers.js\":\"fcd20589ae67a837\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/todo.js\":\"673864f116d79ec3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/typeCandidates.js\":\"776cc75f5f343b1b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/roam-import/types.js\":\"1034c3866b61f9a7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/search-health/index.js\":\"aef7c82a3bdce1c3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/search-health/store.js\":\"1f5185b9d72a36eb\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/shortcut-help/HeaderItem.js\":\"11dddddbd1553384\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"276eb4fea94622ee\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/shortcut-help/index.js\":\"f3c074b34fb5eba8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/shortcut-help/model.js\":\"be3c9da79cd54f9b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/shortcut-help/toggleStore.js\":\"8c81c86974eef594\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/shortcut-help/useKeyInspector.js\":\"761861696a989877\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5b68034b306bf091\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/ShellDecorator.js\":\"af0ee385479e81be\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/actions.js\":\"b1be113a84e81af6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/exclusionsFacet.js\":\"07a83d7d66a831fa\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/index.js\":\"5b7de849ee74733d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/shell.js\":\"8fe212e3089ea2c4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/surface.js\":\"9d2263a8ceef2b09\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/spatial-navigation/walker.js\":\"dc585248c09ff996\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/RescheduleToast.js\":\"aa3fc94f1788a10b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/dataExtension.js\":\"2869555f2aa24159\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/index.js\":\"89258dbf35c3a9dc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/indicator.js\":\"25d4c3ccbe4afe9a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/moveSrsState.js\":\"ba5665491f77aa33\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f67d1c5db01731b0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/scheduler.js\":\"72b5942fef45efbc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/schema.js\":\"abe62f91c8c68d2f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"dd483b901b557781\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/srsClipboard.js\":\"b8b7c91e15ff8fac\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"bcb82e115c7d58a4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ecd3a3b5949c2fc8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/DeckPicker.js\":\"791e1165da1ffdbf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/ReviewControls.js\":\"65ddcf68c7982ca4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/ReviewDeckRenderer.js\":\"40284a11f4309426\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/ReviewSession.js\":\"ad07ed015fbf7e01\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/actions.js\":\"2f3bf8c933d258ec\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/archive.js\":\"3a460f2e74d113c8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/dataExtension.js\":\"e422c29c49aa048e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/deck.js\":\"6adf077cc3e87a11\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/dueQuery.js\":\"979203a05234d0b8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/gradeDecision.js\":\"9177db1fa952ac53\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/index.js\":\"77ac8202219cbd7e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/keyHints.js\":\"aed835a5480a7e7b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/reviewCardLayout.js\":\"10d9a0df17b0a0e8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/reviewProgress.js\":\"5d1dde8d434cc945\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/schema.js\":\"fee7ea6c2d5650c0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/srs-review/useDueCards.js\":\"5c1d35fa640b7516\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/startup-metrics/index.js\":\"3a638fbc6d4bcc31\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/startup-metrics/record.js\":\"2edc3ef207f2ead7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/storage-persistence/index.js\":\"2788f22964df33f0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/storage-persistence/persistenceStatus.js\":\"72665fa7a08a830a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/storage-persistence/requestAction.js\":\"2bd2921e255d1906\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/supertags/TypeChipsDecorator.js\":\"c5b187f44640ed46\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/supertags/codeMirrorExtensions.js\":\"578561ff51f535dd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/supertags/index.js\":\"41e4757744b9fa47\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/supertags/typeAutocomplete.js\":\"7d342002efa87a6c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d7f9799b5c942eaf\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/actions.js\":\"1ef7493f956e67c1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/anchor.js\":\"febac027689cfc7d\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/events.js\":\"6f5c64c2c72cede7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/gestureActions.js\":\"c222f0cb8651b67c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/index.js\":\"90e1a389f03a06b9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"a9f021b893cb56a3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/sync-metrics/collect.js\":\"7ed17a180f73b67a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/sync-metrics/index.js\":\"f86a8c660246dfbc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/sync-metrics/record.js\":\"b24273372dd0cd1f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/RejectionDialog.js\":\"4c456994627fbd89\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/SystemStatusHeaderItem.js\":\"fb074e2e1d2dedc2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/index.js\":\"5c3de55b2da36333\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/model.js\":\"74a28fed83e3039c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/queueCounts.js\":\"dfe3e4c4335d53e3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/rejectedHelpers.js\":\"171cd944b9cbe3ec\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/rematerializeAction.js\":\"d70c0b20afa1dba7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/system-status/useHysteresis.js\":\"64806ebaf62b0239\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/ColumnHeaders.js\":\"540d7079dd972914\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/QueryUi.js\":\"0bf4a5ad86cd63ef\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/TableLayout.js\":\"ce94126331331898\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/actions.js\":\"59838a68b00cb6ef\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/cellEdits.js\":\"882a435a391a39bc\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/childrenViews.js\":\"076fe32ca359ae4f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/columns.js\":\"aa7ba23b36bb9f26\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/controller.js\":\"f419886dc272b501\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/convert.js\":\"91f601b90cdce636\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/dataExtension.js\":\"5ff6534e08b7ce19\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/index.js\":\"8ad7291995cbc508\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/keys.js\":\"a5d4663ad9a468b7\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/model.js\":\"353917f7048723f6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/query/backfill.js\":\"848e15bd4b1a4e01\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/query/completion.js\":\"495d4d19acfbd51e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/query/format.js\":\"e194744f176902e9\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/query/parse.js\":\"c27bdd11b6645740\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/query/queryValue.js\":\"d7398b63e3f2ab95\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/query/source.js\":\"c7401c3ce405051b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/registry.js\":\"85555095d840b75c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/rowGutter.js\":\"92059e777ada1d57\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/rowVerbs.js\":\"471d8dae98c5897c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/schema.js\":\"4dcf9d589baabab4\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/tables/sort.js\":\"1c595279e32b9850\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/theme-toggle/effect.js\":\"8d59f9353922c99a\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/theme-toggle/index.js\":\"9d3f141a8e2bfbc1\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/theme-toggle/theme.js\":\"cd38b6513546569b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/todo/actions.js\":\"7d1d1a288774905c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/todo/dataExtension.js\":\"ebf4ed3e7ece57cd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/todo/index.js\":\"26e868eca232a877\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/todo/schema.js\":\"ef744f305063f4a2\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/touch-selection/TouchSelectionLayer.js\":\"cf4d32b33906cb55\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/touch-selection/actions.js\":\"42674853b91bebb8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/touch-selection/defaultItems.js\":\"12f1e33347365262\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/touch-selection/facet.js\":\"4ee4c59d5a7d5722\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/touch-selection/holdRecognizer.js\":\"ccf7ce5c8fa17c5f\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/touch-selection/index.js\":\"31112223fe993e14\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/update-indicator/UpdateIndicator.js\":\"11c52a5d23babe93\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/update-indicator/index.js\":\"d61c1e58619f56ee\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/update-indicator/loadTimes.js\":\"0c3681fe6ecfcbfd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/VideoNotesRenderer.js\":\"6370b0ea3d39afa5\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/VideoPlayerRenderer.js\":\"bbd3cd50caa4442c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/VideoTimeStamp.js\":\"a5eedb77ba973ae0\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/actions.js\":\"56a8d5fa8c304d9e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/index.js\":\"170f07f8ab7763ec\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/markdown.js\":\"d4ecdc3d2e247a8e\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/notes.js\":\"026fd69e4f8603f6\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/registry.js\":\"2044fa3d24aa9549\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/remark-timestamps.js\":\"b216f37f26698078\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/video-player/view.js\":\"e02d2fc8aa5c01f8\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-link-hints/LinkHints.js\":\"b6d8b2a00e2c288c\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-link-hints/index.js\":\"1d40b5c8b0b089bd\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-link-hints/model.js\":\"cf8f1d0f3ed45e48\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-link-hints/settings.js\":\"de5d8cae2007a403\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-normal-mode/actions.js\":\"044de2cb1167c931\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-normal-mode/index.js\":\"4509bf497d88061b\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/vim-normal-mode/interactions.js\":\"acc68753eed8eaf3\",\"/knowledge-medium/pr-preview/pr-1874/src/plugins/workspace-header/index.js\":\"7aa771eec0bd2be9\",\"/knowledge-medium/pr-preview/pr-1874/src/registerServiceWorker.js\":\"b11953a2397b7342\",\"/knowledge-medium/pr-preview/pr-1874/src/requestPersistentStorage.js\":\"cf3c1f3c1d1a9973\",\"/knowledge-medium/pr-preview/pr-1874/src/services/authRequestDeadline.js\":\"4c5fb4984b47e9f5\",\"/knowledge-medium/pr-preview/pr-1874/src/services/authStorage.js\":\"11df142672e4369c\",\"/knowledge-medium/pr-preview/pr-1874/src/services/powersync.js\":\"63edab87daa419b4\",\"/knowledge-medium/pr-preview/pr-1874/src/services/supabase.js\":\"e31b1a46b14cecd8\",\"/knowledge-medium/pr-preview/pr-1874/src/services/uploadErrorClassifier.js\":\"4da9e98dde41e86c\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/ActiveContexts.js\":\"9bd9c78910936168\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/HotkeyReconciler.js\":\"27393a22c1012944\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/WipeLocalDataDialog.js\":\"d09e11d489359794\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/actionDispatch.js\":\"c5dfc269f27a6342\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/actionRefItems.js\":\"8b8361e120f61e84\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/applyKeybindingOverrides.js\":\"0d2b2100142aa736\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/blockActions.js\":\"b07315de739056b7\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/blockMergeGesture.js\":\"0354e0821b5c3362\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/canonicalizeChord.js\":\"59e0e833ae4c11d8\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/defaultContexts.js\":\"0e086953893dcd56\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/defaultShortcuts.js\":\"007da5a152bbcca4\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/effectiveActions.js\":\"249b0bd568e9e8da\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/gestureAction.js\":\"57a475fbf51d6e77\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/gestureBinding.js\":\"2ceeddd5a87642e5\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/holdRegistry.js\":\"070d3f3bc6ad6a30\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/keybindingConflicts.js\":\"9bca6e9ef8d2677c\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/keybindingOverrides.js\":\"8f6070858569525f\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/pointerAction.js\":\"011bd5e066d85895\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/resolve.js\":\"9b3c6a4541ee19ef\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/runAction.js\":\"d37a69c0f1463c28\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/sequenceMatcher.js\":\"9cdb30a6742b498e\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/types.js\":\"d2ac0b13e2267caa\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/useActionContext.js\":\"e4088dde7648b1a9\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/useActionDiscovery.js\":\"8aba9f149567a342\",\"/knowledge-medium/pr-preview/pr-1874/src/shortcuts/utils.js\":\"ea86c76b5b9a2b75\",\"/knowledge-medium/pr-preview/pr-1874/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1874/src/sw/bootStore.js\":\"7a29ce38752d391c\",\"/knowledge-medium/pr-preview/pr-1874/src/sw/previewDatabases.js\":\"bfea03d880806d4c\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/byteTransform.js\":\"0ad44134279e3d2f\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/attachmentCleaner.js\":\"a281de707e8e2ad4\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/bundle/attachmentParts.js\":\"6d04c37e3e77f0f4\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/bundle/bundleParts.js\":\"1bfbd5f9c4bb96a4\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/bundle/bundleRecord.js\":\"e5d54cedc09b0140\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/bundle/manifest.js\":\"fac8f87148de065b\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/bundle/takeBundle.js\":\"b0af51225a739f24\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/bundle/verifyBundle.js\":\"f27718c014445e6b\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/cleaningStage.js\":\"b74fbac39d80c211\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/conversionKey.js\":\"dc4b52f47f638ce3\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/conversionServer.js\":\"1802a96c7aed3ce3\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/flip.js\":\"79f3f1bc807e1ee2\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/flipAttempts.js\":\"f6f2b846ce1eddee\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/pages.js\":\"60d4c8480e11dd19\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/preflight.js\":\"1ce6209679922277\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/reseal.js\":\"58fd272084cc595e\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/runConversion.js\":\"73897cf9a82f0536\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/runLock.js\":\"ef6f4ca5e7959123\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/sealing.js\":\"7a3cc82cce87f7a3\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/sealingStage.js\":\"5246c3f3e5d3e797\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/stage.js\":\"19976d1bcb45d602\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/conversion/verifyReseal.js\":\"b40418bf84efab70\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/aad.js\":\"3270fc83bc70142f\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/aead.js\":\"1046e23c7763140d\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/base32.js\":\"731bd004f5b3b62e\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/base64url.js\":\"4db8fd31b4757148\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/binaryEnvelope.js\":\"4ea85ff36f12486d\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/byteAead.js\":\"20d8fda72577c6c5\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/canary.js\":\"f50fbf8dc1bc1726\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/contentHash.js\":\"49677ec50a0be53f\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/contentKey.js\":\"2114bf2ddb80f479\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/derivedIdNamespace.js\":\"32b76b071eb348a9\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/envelope.js\":\"4c7aa9fa8ec375e6\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/hex.js\":\"80699c613ffbc49c\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/sha256Hex.js\":\"5880ae4ecbafe9cc\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/crypto/workspaceKey.js\":\"d023dc145deafd58\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/conversionState.js\":\"059f45cb93cb2e02\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/flows/createEncryptedWorkspace.js\":\"48f6517eb0192b45\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/flows/pastedKey.js\":\"36208290b6f42623\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"0ca28011fb48bd9b\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b97f6bfb902720a6\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/keyStore.js\":\"d55f397cfb76df8d\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/mintWorkspaceKey.js\":\"7fc6607dda4f3a63\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/modePin.js\":\"9a9b6a3bf41c515a\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/openWorkspaceKeys.js\":\"2b1564dabced8598\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/resolveWorkspaceEntry.js\":\"33034bd89b04b52c\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/resolver.js\":\"b8d909dd10d726c3\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/keys/workspaceAccess.js\":\"4c285b764192cbf5\",\"/knowledge-medium/pr-preview/pr-1874/src/sync/transform.js\":\"3fa68ea43acd204b\",\"/knowledge-medium/pr-preview/pr-1874/src/themeBootDefaults.js\":\"17213c0aa84cc1c4\",\"/knowledge-medium/pr-preview/pr-1874/src/types.js\":\"875ce044f1bcc952\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/ClientLocalSettings.js\":\"59dc731bba642231\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/abortableSleep.js\":\"eed2c1939e634037\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/array.js\":\"19feae14411f3d36\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/backlinkAutocomplete.js\":\"ce099232c084078a\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/blockCrumbs.js\":\"663f9f3daf192a9b\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/blockrefAutocomplete.js\":\"c2d87d4bec11ddd6\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/cadencedIdleJob.js\":\"f8955823688c757a\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/callbackSet.js\":\"d254e3e4d9094a90\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/clientId.js\":\"a21a769a3518485c\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/codemirror.js\":\"c1f3261f079669d5\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/codemirrorCompletion.js\":\"25018cbae33f6eab\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/copy.js\":\"04c0c2ba509675b2\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/dailyPage.js\":\"6267bcb053e1bb76\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/dbForensics.js\":\"d328deceaef92b79\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/dbForensicsHooks.js\":\"b2e3e80274bcd854\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/deleteBlockThroughUi.js\":\"2b8b0df3f127b4e1\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/dialogs.js\":\"d9bf16641ea780b7\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/dom.js\":\"0f0cc8be177b9983\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/downloadBlob.js\":\"f151bb31f6f70d27\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/drawnWalk.js\":\"a7db1caf02a01181\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/exportSqliteDb.js\":\"5e5cc04166973048\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/fileSystemAccess.js\":\"1643b897f2fc2373\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/flipSlide.js\":\"c124a493c0fb8f64\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/fnv1a.js\":\"1d144a4e438c3de6\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/formatBytes.js\":\"f9d2587075303119\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/fuzzyRank.js\":\"eb2de92668c8a6d5\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/idbKeyedStore.js\":\"77275fb26c594cc7\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/idleCallbackPolyfill.js\":\"895e79973364c870\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/keyboardAwareScroll.js\":\"6234d6bb636b2abe\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/keyboardViewport.js\":\"8e2882f5f00f9399\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/lastWorkspace.js\":\"f72bb7b5344e6d4c\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/layoutColumns.js\":\"0ca6f5cedb485fab\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/layoutSessionDom.js\":\"31dc56f8e37ca66b\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/layoutSessionId.js\":\"3057d7cfb4ecbf21\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/linkClickGestures.js\":\"e0325f2d03c32975\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/linkTargetAutocomplete.js\":\"a1ac26ef3031704e\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/localDbCorruption.js\":\"5a99bd030d14c26f\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/localDbRecovery.js\":\"241c66d866db07d7\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/markdownParser.js\":\"fd4c64f6d9a18bf8\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/memoize.js\":\"7739671bff9401a4\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/nameFieldCommit.js\":\"752f0e41c60ed767\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/nameList.js\":\"af27edbfb60735b7\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/navigation.js\":\"dcb364ac53594256\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/omnilinerNamespace.js\":\"07f6cacd9c8d1c5d\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/opfsPageScan.js\":\"ac25362dfaeb9305\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/panelClearance.js\":\"55893401c789d38a\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/panelHistory.js\":\"b1131610172eecdd\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/panelLanes.js\":\"5c627c7fefa47b81\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/panelLayoutProjection.js\":\"1a829c3abeabdd06\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/panelScrollAnchor.js\":\"6f2dd6f2846af6c0\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/panelUrlFlags.js\":\"671c36db85913bfc\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/platform.js\":\"61012a584932a69f\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/pluralize.js\":\"6d410298f56900dc\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/propertyCreation.js\":\"740d56a4a26f15f2\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/propertyNavigation.js\":\"d62ffe20e46db475\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/propertyValueContext.js\":\"7a326226b52044c5\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/react.js\":\"6ef24cfedc6740a5\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/relativeDate.js\":\"a4fe42d962bc4fea\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/relativeTime.js\":\"fe989823732c4883\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/renderScope.js\":\"4059107c153def21\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/resolvedThenable.js\":\"220ca010beb5783a\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/routing.js\":\"d1dd24d6cae11ea9\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/safeMode.js\":\"dfa43ae2327b8692\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/scheduleIdle.js\":\"02cfa59fb33e160c\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/screenWakeLock.js\":\"e26e26c397b2d1c6\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/selection.js\":\"c6031fb1acda0512\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/softKeyboardGrab.js\":\"73a195ba3f2fff2d\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/startupTimeline.js\":\"3560fdaa8b5000ea\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/state.js\":\"0670537adc125da7\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/string.js\":\"339d6c3c021097bf\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/surfaceZoom.js\":\"fa26fdfa267f05cb\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/time.js\":\"106e0d2366ee9aa3\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/toast.js\":\"9b10017b1f43a1c5\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/toggleStore.js\":\"c0e68149962fc22f\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/untilStopped.js\":\"60649c1a95209d2b\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/userActivity.js\":\"8958dca79a8d770e\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/viewTransition.js\":\"4208cff166f16512\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/viewport.js\":\"675175b73c9dcfd8\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/webLock.js\":\"f9fcc2c9fa79682a\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/workspaceRecovery.js\":\"18d41cf59927b4b3\",\"/knowledge-medium/pr-preview/pr-1874/src/utils/workspaceSnapshotStore.js\":\"0ec508deebb1aa37\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-compiler-runtime.js\":\"c6d4e8a4cf1700e2\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom-client.js\":\"b46cefe753275f3c\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom-server-edge.js\":\"97b63e47967c9e04\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom-server.js\":\"f82990f697bbc820\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom-static-edge.js\":\"c3c1567c52cf2bbe\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom-static.js\":\"157c5fc32ea2dad4\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom-test-utils.js\":\"ded9e3a0522be4f7\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-dom.js\":\"24ed1bbb2274d0ec\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react-jsx-runtime.js\":\"1bc4d30f1d079f45\",\"/knowledge-medium/pr-preview/pr-1874/src/vendor/react.js\":\"7cdbf85f109fc8ae\",\"/knowledge-medium/pr-preview/pr-1874/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1874/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1874/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
