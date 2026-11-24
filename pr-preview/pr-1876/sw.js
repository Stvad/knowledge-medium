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
		buildId: "6abe5115e0d7-b9ac2930",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/\":\"00e4cff247a8cd96\",\"/knowledge-medium/pr-preview/pr-1876/index.html\":\"00e4cff247a8cd96\",\"/knowledge-medium/pr-preview/pr-1876/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1876/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1876/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1876/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1876/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/pr-preview/pr-1876/assets/FacadeVFS-QjCi6DWI.js\":\"5e5274e12fa22bc2\",\"/knowledge-medium/pr-preview/pr-1876/assets/OPFSCoopSyncVFS-wxp1Uqdx.js\":\"26e3c44a3087f499\",\"/knowledge-medium/pr-preview/pr-1876/assets/OPFSWriteAheadVFS-CVFEYFmB.js\":\"9c0c063f0b0aca04\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-8TWgCfd6.js\":\"a9534c7c077aec29\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-async-Dzf0FjH0.js\":\"cc0155b76245b694\",\"/knowledge-medium/pr-preview/pr-1876/assets/worker-CedGonAS.js\":\"f8bbe6a306fb4ba6\",\"/knowledge-medium/pr-preview/pr-1876/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1876/chunks/app-DDEj5D2_.js\":\"2f24cce0086aa451\",\"/knowledge-medium/pr-preview/pr-1876/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1876/index.js\":\"0a6f1e25918f2d90\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1876/assets/AccessHandlePoolVFS-Dia6ZnV6.js\":\"5a4b19079172a975\",\"/knowledge-medium/pr-preview/pr-1876/assets/IDBBatchAtomicVFS-CP0iq6pd.js\":\"11d774c0189783d6\",\"/knowledge-medium/pr-preview/pr-1876/assets/MemoryVFS-X1IFqAfC.js\":\"1e75a85b7e069894\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-BpOZgN39.js\":\"ce63225182905fa2\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-async-N55meU-N.js\":\"328756d3ba260649\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1876/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1876/chunks/AccessHandlePoolVFS-3VJ01Cah.js\":\"201b09d089c0405c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/FacadeVFS-Bz6stjJA.js\":\"0ca539fb7e4ac699\",\"/knowledge-medium/pr-preview/pr-1876/chunks/IDBBatchAtomicVFS-D-Obq8Lm.js\":\"f33e8725185c949e\",\"/knowledge-medium/pr-preview/pr-1876/chunks/MemoryVFS-CUxDnXOs.js\":\"d573a587323c182d\",\"/knowledge-medium/pr-preview/pr-1876/chunks/OPFSCoopSyncVFS-CvjkDHIk.js\":\"7363c96307939054\",\"/knowledge-medium/pr-preview/pr-1876/chunks/OPFSWriteAheadVFS-DXO0ue25.js\":\"bce869d18cacc716\",\"/knowledge-medium/pr-preview/pr-1876/chunks/Preview-CvOkdmD6.js\":\"be46bcbd20298482\",\"/knowledge-medium/pr-preview/pr-1876/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/card-CunjDJdN.js\":\"4944d23ba95a044c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-BWE-Ftnu.js\":\"a0d9ff616c73e3a0\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1876/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1876/chunks/mc-wa-sqlite-B72rlJkn.js\":\"e0d08bce43e37242\",\"/knowledge-medium/pr-preview/pr-1876/chunks/mc-wa-sqlite-async-eLVkrJOT.js\":\"f049793fdf76158f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-2r66t3D8.js\":\"9d2da92859655738\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-Bcln_SP_.js\":\"2e0ac2ef6c7634aa\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-C8ddR8GW.js\":\"8f4f80283ad60631\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-CVi_8574.js\":\"3c3ca8f4dc52738c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-CsqXOXqW.js\":\"2c892bba0ac038d7\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-DCJBm-Yo.js\":\"421455e8c5b9c627\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-DT-EN99Q.js\":\"6e27115782b774cc\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-DeBgLuZL.js\":\"6746779f96f13ad4\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server-legacy.browser.production-Dospj474.js\":\"5a2655e2b9ca6602\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server.browser.production-4niLgHWz.js\":\"6b94cfc052591b64\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server.edge.production-n8-jdj6F.js\":\"0b9c7e771473a03a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/server.browser-C5rRQeGn.js\":\"47f7840aa983dae8\",\"/knowledge-medium/pr-preview/pr-1876/chunks/textarea-CzKvAIWu.js\":\"a477edd40f60bd7f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/ui-L_mcKNuB.js\":\"7ae49539974fcb57\",\"/knowledge-medium/pr-preview/pr-1876/chunks/wa-sqlite-Cb0EYRpo.js\":\"5fb4e94cb4b50c1a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/wa-sqlite-async-BZU99hzR.js\":\"bed609b4f46da444\",\"/knowledge-medium/pr-preview/pr-1876/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1876/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1876/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1876/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1876/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1876/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1876/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1876/src/App.js\":\"e8de6591531b9d4f\",\"/knowledge-medium/pr-preview/pr-1876/src/appUpdate.js\":\"077fb2348a9a3dde\",\"/knowledge-medium/pr-preview/pr-1876/src/appVersion.js\":\"56c2e24e1064af7f\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/initialLayout.js\":\"05f974dd8eb8d4bf\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/openWorkspaceData.js\":\"589f20c25a400589\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/resolveWorkspace.js\":\"ac5f6bcc21175415\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/workspaceBootstrap.js\":\"231bf8e8b87dab02\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockComponent.js\":\"18b5e7c2725910df\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockCrumbs.js\":\"89ca64898c542c83\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockEditor.js\":\"23b69edc561ce86e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockLoadingPlaceholder.js\":\"807a1dda938b4d65\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockProperties.js\":\"e1cfee6aa90e9568\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockSearchPicker.js\":\"29a2472ca851ab64\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ConfirmBulkDeleteDialog.js\":\"49cb2000abc5cf5c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/DividerHandle.js\":\"60a7ece51183bc81\",\"/knowledge-medium/pr-preview/pr-1876/src/components/DraftEditor.js\":\"7f4ee05817a16413\",\"/knowledge-medium/pr-preview/pr-1876/src/components/GutterPill.js\":\"fd8a60be4c0b7882\",\"/knowledge-medium/pr-preview/pr-1876/src/components/Header.js\":\"22a596c8f1d00cb5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/LazyBlockComponent.js\":\"fa849dc623c51195\",\"/knowledge-medium/pr-preview/pr-1876/src/components/Login.js\":\"89b2f19de66f1ed8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ZoomableSurface.js\":\"8cdb626d35593d99\",\"/knowledge-medium/pr-preview/pr-1876/src/components/editModeKeepalive.js\":\"91034c7667260e12\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyDisplay/PropertyDisplayScope.js\":\"4b75c2978af09453\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8f016d37b0604dcb\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/RefPropertyEditor.js\":\"52b4917dd324b534\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/RefTargetTypePicker.js\":\"c4f252ba45259ac4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/SelectPropertyEditor.js\":\"ee70b7e992da6f92\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/TypesPropertyEditor.js\":\"0fc9d553f512db15\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/defaults.js\":\"fa5dc4f8a82b189b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/kernelValuePresets.js\":\"89120750871aae74\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/selectablePresets.js\":\"bd8ed384e1f91e1d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/typesPropertyUi.js\":\"f6546c048c3c650e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/AddPropertyForm.js\":\"3fea706d0356c86b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/PropertyPicker.js\":\"a827686e1c7a3191\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/PropertyRow.js\":\"eae52c72b080875e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/Rows.js\":\"30fff614b6cea146\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/actions.js\":\"d96600c719bcc452\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/declarationOnly.js\":\"c2a924534913a6af\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/layout.js\":\"433f4602f28db350\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/model.js\":\"64d433d1b66cfc88\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/shapeUi.js\":\"a38c6ced6e34d3f7\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/shapes.js\":\"4323ef363f009201\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e96c40de8aa33fe8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/visibility.js\":\"ebfc719bf5a4674a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanelSections.js\":\"fd505a7a731c957f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockEmbed.js\":\"3604b384edc0a0d9\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockLink.js\":\"cb36a5d9d5387535\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockRef.js\":\"06f4a60fd4188e8b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/ReferenceLink.js\":\"cbcaf528ddaa2799\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/cycleGuard.js\":\"92f7796fa0e6a8f4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/cycleGuardContext.js\":\"8ddf8b1895369331\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/linkInteraction.js\":\"f97f1fb1798074cd\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/referenceLayout.js\":\"7b7e6f07b9a32245\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/useBlockRefAncestors.js\":\"c2effd34a8bc30a8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockGutter.js\":\"782fa6a9e7ecb46c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockInfoDialog.js\":\"fbb626d91b66f3c4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockTypeBlockRenderer.js\":\"de147bb5d5e908aa\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BulletHoverCard.js\":\"a55fa7135dc842c5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/CodeMirrorContentRenderer.js\":\"53627af24915731e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"e784d9303a12923e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/ColumnResizeHandles.js\":\"ba78e16eb372a049\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e8bff12b9e5f7cfa\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/DefaultBlockRenderer.js\":\"8434dfdf8f0107a8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/LayoutRenderer.js\":\"38c49c664414888d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/MarkdownContentRenderer.js\":\"2ca8b916e4c76837\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/MissingDataRenderer.js\":\"152c5df3ccf8ff9f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/PanelRenderer.js\":\"9a79a2397075efcc\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/PropertySchemaBlockRenderer.js\":\"3623e2335684dd5c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/TopLevelRenderer.js\":\"896356fcc34479ad\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/blockGutterMode.js\":\"3f39b67d54c0279f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/blockTitleText.js\":\"eee271344da728a0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/fieldCreationKeydown.js\":\"e28f2d8de55710f9\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/layoutRootContext.js\":\"f18c1d00b0cd34fa\",\"/knowledge-medium/pr-preview/pr-1876/src/components/typeChip/TypeChip.js\":\"dc373e211ec112bd\",\"/knowledge-medium/pr-preview/pr-1876/src/components/typeChip/chipStyle.js\":\"9523f489bed59424\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/anchored-floating.js\":\"23261405f694cada\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/button.js\":\"10d22bbd099d75be\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/card.js\":\"887ee03be240e3c6\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/checkbox.js\":\"fc39f2f978dcf832\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/collapsible.js\":\"95ba4ff67068dd66\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/command.js\":\"1bd07bdc4656f49b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/context-menu.js\":\"d441e40194b13e0e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/dialog.js\":\"5388db956133bc82\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/dropdown-menu.js\":\"273ab830de713802\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/floating-listbox.js\":\"1c4993f56b166bc8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/index.js\":\"48de17d2dcc62787\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/input.js\":\"9131241dc72b1966\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/kbd.js\":\"892e38883b233c11\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/label.js\":\"dcc23ac838a1a5a0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/textarea.js\":\"7899a5f1a01fe233\",\"/knowledge-medium/pr-preview/pr-1876/src/components/useEditModeYieldKeepalive.js\":\"656f4b412d6cfdce\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/BootFallback.js\":\"1fec4710ebfa0f23\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/FocusedRowLazyMount.js\":\"d95bb36985c00712\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/LazyViewportMount.js\":\"5de63bbf8f5cedfa\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/LocalDbCorruptionFallback.js\":\"2b2ad2e534ff149e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/error.js\":\"741d21cb7230da86\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/lazyMountRegistry.js\":\"22116916d53ee09c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/suspense.js\":\"ab3bed7d56551af4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/CreateWorkspaceDialog.js\":\"c07e40d817c9613f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/PendingInvitations.js\":\"0982aad1e27fe72d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/SyncProgress.js\":\"bdae170cf8f8cc8d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/UnlockProgress.js\":\"cfb7f6d4b6cd67dc\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceKeyGate.js\":\"3bfc054adeeec940\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSettingsDialog.js\":\"2cc1287b1e3c91e5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSwitcher.js\":\"592b70d6cd2b3a99\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSyncGate.js\":\"f06203f728751e69\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/ConversionFlow.js\":\"2909f1dadc9bcfb8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/ConversionFlowHost.js\":\"cbd96917ede57d2f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/EncryptionSection.js\":\"3ac36bab2141bcb5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/attachmentPrompts.js\":\"490f3d4c2e671775\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/bundleFolderPrompts.js\":\"192ab62df379bbae\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/conversionFlowDeps.js\":\"f0590414bba9ec75\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/conversionFlowStore.js\":\"0cfa7dabe92702e2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/flowUi.js\":\"f23fa0818c5132d7\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/useConversionRun.js\":\"9803f8468f8daef0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/keyUi.js\":\"f977a033a22e02e1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/useCloseOnKeyLoss.js\":\"1a10d590e3d57734\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/useCloseOnServerE2ee.js\":\"c96cf38fbe5b1f2e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/workspaceUnlocked.js\":\"cf3c6a0ef62f65ff\",\"/knowledge-medium/pr-preview/pr-1876/src/context/backgroundSubtree.js\":\"ae90ead84fcc4c50\",\"/knowledge-medium/pr-preview/pr-1876/src/context/block.js\":\"f89c79ecec8bc985\",\"/knowledge-medium/pr-preview/pr-1876/src/context/layoutWsContext.js\":\"e0a59c702b10a67e\",\"/knowledge-medium/pr-preview/pr-1876/src/context/propertyDisplay.js\":\"19ff288e31445ddd\",\"/knowledge-medium/pr-preview/pr-1876/src/context/repo.js\":\"4c6bd2bf60987239\",\"/knowledge-medium/pr-preview/pr-1876/src/data/aliasClaim.js\":\"48a0459f203356c8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/aliasSeatNamespace.js\":\"3470548c7951ced7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/blockData.js\":\"f5c2c99d0bf0452c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/blockType.js\":\"f368eeb04d2bb3ff\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/changeScope.js\":\"1072e5461fe67e0a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/codecs.js\":\"5c4d64cf609c1b81\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/derivedData.js\":\"62f0beddffefb33b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/errors.js\":\"3194fe5b8a63856c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/events.js\":\"e7c695d0bb2e0c47\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/handle.js\":\"97925a259111ece7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/index.js\":\"1fe83a3069eed8c9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/mutator.js\":\"ca837f4b1eafb593\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/processor.js\":\"e4cdbe3e5bad8f34\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/propertySchema.js\":\"3f63139ab39321f3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/query.js\":\"8f0559fad2e65112\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/sameTxProcessor.js\":\"a809dd491d019119\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/schema.js\":\"97925a259111ece7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/tx.js\":\"97925a259111ece7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/typedBlockQuery.js\":\"a9a88384334ce382\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/user.js\":\"aeee47056a4a6004\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/valuePresetCore.js\":\"0235f000bf49ec57\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/valuePresets.js\":\"4726d5bc2b0aabd2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/attachmentCleanerIOVerb.js\":\"a78265ad5fe3354f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/block.js\":\"6aba2437de583027\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockCache.js\":\"f91ed6cb6c87ab43\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockId.js\":\"7605b083595dc6b8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockLiveness.js\":\"e5f3596ea57b4533\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockMerge.js\":\"116bfde382ae8c82\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockSchema.js\":\"b36228b86f95c2f7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockTypeLookup.js\":\"900a33ff2c21ec72\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockTypes.js\":\"0d95c422def2dec2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/childrenView.js\":\"3cbdaa10e80f1e03\",\"/knowledge-medium/pr-preview/pr-1876/src/data/clientContext.js\":\"b1bfcfd0ff4a0f16\",\"/knowledge-medium/pr-preview/pr-1876/src/data/dbFileSiblings.js\":\"91e33ed8623a9787\",\"/knowledge-medium/pr-preview/pr-1876/src/data/definitionSeeds.js\":\"0f43eb1ac2804e70\",\"/knowledge-medium/pr-preview/pr-1876/src/data/derivedIds.js\":\"d90f50ba52697a4f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/drawnSubtree.js\":\"bf0d2484633357b0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/facetBridge.js\":\"7dcb7786c37ee9b5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/facets.js\":\"d4b86dad60d02506\",\"/knowledge-medium/pr-preview/pr-1876/src/data/globalState.js\":\"9d0920eb26d56207\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/aliasClaimRederiveProcessor.js\":\"aff1f1ed05da532d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/ancestorBatch.js\":\"2d0b033d39dd4971\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/blockTypeTypeifyProcessor.js\":\"1b42ad9c32e59b39\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/clientSchema.js\":\"2b4fee24a680047c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/commitPipeline.js\":\"5fb568af3bc690ba\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/devAssertions.js\":\"5a9fdc02a393a2f1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/firstSync.js\":\"9886adcfd8a872bc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/freshInitialLoad.js\":\"a2bd5173b2be0402\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/graphBackfillClaim.js\":\"4988e13834aa5c7b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/handleStore.js\":\"cebf29fa10286c20\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/idleMarkerJobs.js\":\"184382b58ea70a5d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/initialDownload.js\":\"5f786148ed9042e9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/initializeClientDatabase.js\":\"2716caa7c796d14d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/jsonCanonical.js\":\"6419f9c1c4c01af1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelInvalidation.js\":\"2e4d7f8120948d68\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelProcessors.js\":\"13bb280abdb7be0b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelQueries.js\":\"3241158c8ab1ec4d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/mergeTypeMembershipProcessor.js\":\"2d7b77b6ff178459\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/normalizeReferencesProcessor.js\":\"eb7a87bb5b8530c8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/poolInstrumentation.js\":\"57e42cacb6f318a3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/processorRunner.js\":\"55128ff9d4dc49da\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyCellBackfill.js\":\"4fe71a198e4097ca\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyChildMint.js\":\"d3cf55df7dcf1376\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyChildrenProcessor.js\":\"32643716df829daa\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyDefinitionChangeProcessor.js\":\"176e3a1f120f6b76\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyDefinitionSynthesis.js\":\"88839b7dda6ba9e0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyKeyScan.js\":\"e3cd5e25802aee13\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertySchemaResolution.js\":\"26e9eb35a443836e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyValueEdits.js\":\"6c611c42d03036bd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/raiseProtocol.js\":\"1b11f7db7bc98516\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/readBatch.js\":\"c13faafe9f005bca\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/refProjection.js\":\"b431050b043824f9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/referenceTargetLookups.js\":\"4f8d5c861de0db98\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/referenceTargetProcessor.js\":\"622a0ba0a61d01d7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/replayMerge.js\":\"898ca4fc7b0c902d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/sqlBinds.js\":\"cc68e692c9fc3e43\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"113f4e4a1be74865\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/arrivalProcessors.js\":\"b53a25de5d151402\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/invalidate.js\":\"ff04f551dee9f251\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/materialize.js\":\"09b97663537a3e0f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/observer.js\":\"49f3f8334e427900\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/reconcile.js\":\"fadd3a03132416ae\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/timingMetrics.js\":\"41ec5d8317b9a9b0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/treeQueries.js\":\"1f1302c7cad218e9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/txEngine.js\":\"dab1c0c91144f3a2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/txSnapshots.js\":\"867962f1ef6ed413\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/typedBlockQuery.js\":\"aef93883ea258718\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/undoManager.js\":\"5e79336becb824e6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/invalidation.js\":\"39f51d227da07d47\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelDataExtension.js\":\"919d4dbb95ef73f5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelPage.js\":\"6018268f54554277\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelValuePresetCores.js\":\"2493c329355628c6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbCorruptionSignal.js\":\"b97dc556be586bf4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbStorage.js\":\"3421f76031f4f944\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbVfs.js\":\"cd136a33cc6007bb\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localSchema.js\":\"c6aabd142398ebb0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/maintenance.js\":\"15634f94f3132fb7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/mergeProperties.js\":\"e3a1904d7c6253af\",\"/knowledge-medium/pr-preview/pr-1876/src/data/metricsConsoleHook.js\":\"adf99cf4528812d1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/migrationsPage.js\":\"c5635d030bd6a15c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/mutators.js\":\"a2777ad66957d5f0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/orderKey.js\":\"340078a4c74bc9d6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/orderKeyPlacement.js\":\"b5847226845aaa62\",\"/knowledge-medium/pr-preview/pr-1876/src/data/outlineSurface.js\":\"c03817a053e29ea4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pendingEditorContent.js\":\"5a5870856f8297d3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pendingUploadsSql.js\":\"ba7946d7fe2ae563\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pluginStateExtensions.js\":\"da9d0d7470a6115b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/powerSyncLogger.js\":\"a621662d7ca69394\",\"/knowledge-medium/pr-preview/pr-1876/src/data/projectorRuntime.js\":\"71da857e0cdaee70\",\"/knowledge-medium/pr-preview/pr-1876/src/data/properties.js\":\"b00cba0d6cbae137\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertiesPage.js\":\"99ca80662794b02f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyChildren.js\":\"2f90fa81941e8ed0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionFanout.js\":\"5fafe53a4f122e2d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionMetadata.js\":\"1f0979180bb39d07\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionRegistry.js\":\"51ab3d25c23fd0b5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDisplayMode.js\":\"5688494827505646\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyRowCreation.js\":\"9009bb1e2ffdca27\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertySchemaCreation.js\":\"3c06e6cfc7153a9a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertySeeds.js\":\"188ca03c3bf5e6f1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/recentsPage.js\":\"18e4ac41cc2fb21b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/referenceBlock.js\":\"f27760a049553c81\",\"/knowledge-medium/pr-preview/pr-1876/src/data/rejectedUploads.js\":\"9d081e9fcbb61937\",\"/knowledge-medium/pr-preview/pr-1876/src/data/releasePowerSyncConnection.js\":\"051ff623d0c54f2c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/repo.js\":\"fbafdda38c7f01f8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/repoProvider.js\":\"c408d51ca64eeb79\",\"/knowledge-medium/pr-preview/pr-1876/src/data/rowProperty.js\":\"85fe52b1183310ee\",\"/knowledge-medium/pr-preview/pr-1876/src/data/searchFilter.js\":\"747e6813bd1938fc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/seedIdentityLedger.js\":\"552ed4da156c2eab\",\"/knowledge-medium/pr-preview/pr-1876/src/data/stateBlocks.js\":\"98e6dfbde2b6029b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/structuralEditPolicy.js\":\"566cea607b88b0dc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/structuralInsert.js\":\"324a5bd20e4a21ab\",\"/knowledge-medium/pr-preview/pr-1876/src/data/subtreeDelete.js\":\"6583ba13fc1a59ef\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncStreamLock.js\":\"8074297ac17f19ae\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncedTableSqlRecognizer.js\":\"9c1777c977ffd102\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncedTableWriteGuard.js\":\"dd24cb7dcfce9991\",\"/knowledge-medium/pr-preview/pr-1876/src/data/targets.js\":\"40145e4be997b3f4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeColors.js\":\"0b78525bbce0d50c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeDefinitionMetadata.js\":\"511136bd8a9f1ad9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeDefinitionRegistry.js\":\"ea3cde8a48d625d4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeExtraction.js\":\"b623f27996540790\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeInitialValues.js\":\"cba6f814935f8513\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typePropertyGroups.js\":\"accf74c1c6dc0395\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeSeeds.js\":\"6eef8d6971326bb0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeTagger.js\":\"147e7a3cbd4f604e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typedRecords.js\":\"39fd9226875b7f9f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typesPage.js\":\"b65bd132f4ac62cc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userPrefs.js\":\"e449010d64245cd3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userSchemasService.js\":\"4cc27aa98d47ea0b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userTypesService.js\":\"977c6ed190c24e9f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/valuePresetRegistry.js\":\"1d7f90e828698c4d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/visibleChildren.js\":\"1505b895cfe3d955\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceConversion.js\":\"481caced57984b98\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceFirstSync.js\":\"f9c9a19aad3a7d6d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceIdNamespace.js\":\"6c19731c0ee033e0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceSchema.js\":\"774d431d3c48740a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaces.js\":\"8304903e3bef46f7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/writeAheadLog.js\":\"7de26ac35bab7ad8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/BlockPasteShellDecorator.js\":\"3aa0dd1da8f0dafb\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/atTrigger.js\":\"287146f06d8d359a\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/autocomplete.js\":\"bc5d8b142bd42a14\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/codeMirrorExtensions.js\":\"35d0724d72b3bf5f\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/contentFlush.js\":\"a993e8eec49d4f9a\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/defaultInteractions.js\":\"527ce71cfea7c123\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/editSettleSignal.js\":\"4d24bb8425df2193\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/insertImage.js\":\"0f695f923a0cba17\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/referenceCompletionRange.js\":\"13800afe9d67a1ed\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/referenceTargetTypes.js\":\"a911650f0429c297\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/syntaxContext.js\":\"ab4d21fbfeeb3cca\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/triggerMatch.js\":\"4569134200605fe6\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/AppRuntimeProvider.js\":\"60072e2977fca3a4\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/BlockFocusShellDecorator.js\":\"78f096e6eb4a459e\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/ExtensionRenderBoundary.js\":\"fe843e7e706c6484\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/PanelContentRecovery.js\":\"70cdc7bb7b731967\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/apiCatalog.js\":\"4ec476625004ffbd\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/approveExtensionHere.js\":\"ef2b1e42e240fd55\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/armedCutAppMount.js\":\"b67917a97813c79e\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/batchableKeyedStore.js\":\"eef60576d5a19998\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/blockInteraction.js\":\"85a758545d36ea19\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/blockSelectionAction.js\":\"3e411ae939232f96\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/compileExtensionModule.js\":\"6128bf6778b99471\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/compiledModuleCache.js\":\"d3195508e2d8c574\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/continuousGestures.js\":\"29bcde6b4bdba38f\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/core.js\":\"d6fbe8c4329054b3\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/defaultRenderers.js\":\"3513aeecd30edbf9\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/definitionFanoutAppMount.js\":\"f1f7910fbaf095a4\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dialogAppMount.js\":\"25ce0692b3940cce\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dynamicExtensionSeeds.js\":\"21f50a7d09a336c8\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dynamicExtensions.js\":\"f1564f7a4928a26e\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/exampleExtensions.js\":\"53ec6a97bb2b8c76\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionApprovalStatus.js\":\"a33c349f18902eb3\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLoadErrorToast.js\":\"d2d1249d84bc13b1\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLoadErrors.js\":\"f2730227ab92cf53\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLookup.js\":\"29d1a3768c331978\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionToggles.js\":\"f1047f7e588fa229\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionUtilitiesCss.js\":\"c26f0fbcf239acbb\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/kernelPageDeletionGuard.js\":\"bed68f5bc983c106\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/liveRuntime.js\":\"12643e485a6b5c67\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/openExtensionsSettings.js\":\"87133cba6dade94d\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/overridesCache.js\":\"0b6e52f073c4ff13\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/pluginIds.js\":\"9e743eebe2256015\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/processorRejectionToast.js\":\"2077540ef250d680\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/runtimeActions.js\":\"b0cc9b2af4a8eb95\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/runtimeContext.js\":\"aac4edba62f18e9e\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/staticAppExtensions.js\":\"926c21f0715cf3ff\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/staticDataExtensions.js\":\"57b2817810c001c4\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/toastAppMount.js\":\"fa67888aa1d2327b\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/useOverrides.js\":\"98b89241699bb7dd\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/useShortcutSurfaceActivations.js\":\"331baf7a3adb7baa\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/discoverToggleTree.js\":\"a5d174cb55448b51\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/facet.js\":\"08e50228f6ea104b\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/resolveAppRuntime.js\":\"6e8d1e59eccb8694\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/runtimeEvents.js\":\"be570d5a48316209\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/togglable.js\":\"e7a93dbe0fcdbf54\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/variantFacet.js\":\"22ba025502f90b12\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/verbFacet.js\":\"e51cc5b0b382a99f\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/block.js\":\"b715207ef12a15fb\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/focusedChild.js\":\"f3d46a0f02fc3bc0\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/propertySchemas.js\":\"82d7539f7fc56b71\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/typeRegistry.js\":\"f37ff247341f9f40\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useAncestorCrumbs.js\":\"efa069c509cdf82d\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useAutocompleteListbox.js\":\"3b36c7e77137322f\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useDebouncedSearch.js\":\"9a84921a890b5383\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useDebouncedValue.js\":\"d727c697d7b68d5d\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useIsFocalRender.js\":\"fa202972cd1cb3bc\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useIsReadOnly.js\":\"407a64c294ad35fa\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useMaterializeBacklog.js\":\"6af49ba833d7306a\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useMinuteClock.js\":\"c1d10d00202668e7\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/usePanelLayoutProjection.js\":\"ce195b94228cbd5e\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/usePendingInvitations.js\":\"f20045e9b0759dfa\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useRendererRegistry.js\":\"8217c79d236ffde1\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useRetainedFieldRows.js\":\"6edd823ac431107b\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useWorkspaces.js\":\"9cb1816819db4de8\",\"/knowledge-medium/pr-preview/pr-1876/src/lib/utils.js\":\"65058d5d58b80587\",\"/knowledge-medium/pr-preview/pr-1876/src/main.js\":\"c67be5dd0e49962b\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/MarkdownImage.js\":\"2df0df6f941172e9\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/blockSeparators.js\":\"7685091696c53429\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/context.js\":\"97be5034ac12e76c\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/defaultMarkdownExtension.js\":\"0cdc9d951b938ac3\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/extensions.js\":\"076773f81dfa5781\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/renderMarkdownHtml.js\":\"a17f208993cb00d7\",\"/knowledge-medium/pr-preview/pr-1876/src/minimal-editor.js\":\"cade9aeda47f2a1e\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/armedCut.js\":\"a5fe2acad39bc83b\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/captureMediaVerb.js\":\"e2cf3ed47423c0fb\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/clipboard.js\":\"c8d39bdd83dc2751\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/decision.js\":\"f3dc4c6cb46973d2\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/operations.js\":\"74a2452ac1aeed3c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/account-header/AccountHeaderItem.js\":\"d676c83fbb897a1a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/account-header/index.js\":\"f600a7147eb89524\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"bb1edf733042d453\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/askAgent.js\":\"88f368c12c1eac67\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/askedStore.js\":\"19859c3fff8d0f7c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"eda036dd32272f11\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/chipState.js\":\"f833fef9847c5271\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/dataExtension.js\":\"64e34e3cb3c22f3c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/index.js\":\"94e87908fee267b8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c5a58360ac48015b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/schema.js\":\"b28ac4dcc2d19af8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d18be41e9319063f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/BridgePairingDialog.js\":\"172968157934893d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/addMedia.js\":\"c05ba2247d849105\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/backlinks.js\":\"37fa4c76b484c22a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/block.js\":\"7722de163bec80c9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/context.js\":\"63083d7f2bf371fc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/displayIds.js\":\"334de8a1257b7b62\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/index.js\":\"f9151dab7d9fe26f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/outline.js\":\"88ad935c40872a88\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/properties.js\":\"e0245d5e39bf7974\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/refs.js\":\"38d34a184cf98d2d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"5e0d8fcf85585a68\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/search.js\":\"292eabe1c41e3c1d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/shared.js\":\"de261d25175dc125\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"43248172ff85f98b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/text.js\":\"45ac433a1df7d43b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentWrites.js\":\"310338fbff809458\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/authoringCatalog.js\":\"53397b0a36db9cc3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/blockRefTargets.js\":\"76a8017648aa8de3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/bridge.js\":\"4508c2a301a38a83\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/bridgeLoop.js\":\"5bcbf22650ae827c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/changeHistory.js\":\"3a8c3b214947cbf2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/commands.js\":\"270f86249baa125a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/commentsCommands.js\":\"b10a2b0a03847caa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/dataExtension.js\":\"712c7f99acfd816c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/dataModelGuide.js\":\"4af7495218c4c131\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/describeRuntime.js\":\"43042ed8d3e80724\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/extensionLint.js\":\"80dc963bd68c98e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/grainAudit.js\":\"38fa1fb79585fdd8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/healthCommand.js\":\"22b61f56bbd0a5a5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/index.js\":\"efc5b4ec9108f858\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/presetIdentity.js\":\"debf3b10bb6c91c2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"148f61369f8987bf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/readMedia.js\":\"e65f7603bbd698a0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/schema.js\":\"7c2d86ef268b4aa9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/serialization.js\":\"ae59a4dbc06825af\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/targets.js\":\"1d20aacb29662adf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/tokens.js\":\"5e031ccfccf891d6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/watchEvents.js\":\"5d51010f98854fae\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/workspaceGuard.js\":\"45273d75a7ca37af\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/writeCommands.js\":\"667444f23c71c15f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/AliasCollisionToast.js\":\"966a37a1de4035c2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/DuplicateNameBanner.js\":\"c0a8130f6922b3f2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/collisionMerge.js\":\"c66f1d7ddefcff08\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/dataExtension.js\":\"5db08ef9b52732e6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/index.js\":\"f7c57a5143eb47a3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/mergeCollisionAction.js\":\"4e161c2dee2d8501\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/pageStyling.js\":\"86ff760feec82e5f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/rejectionToast.js\":\"daf018e0eeace80e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/syncProcessor.js\":\"2d96ebbed49f7b9b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/actions.js\":\"6216c4471b38a882\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/addComment.js\":\"8e4e6a7e8eb4c384\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/anchor.js\":\"3f947f836bdc4d8d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/anchorState.js\":\"099f17adff183541\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/commentLinks.js\":\"13882f119777aad7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/confirmThreadDeletion.js\":\"8c4a522dde17b436\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/container.js\":\"9d217ffed62bd1dd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/dataExtension.js\":\"5783f640e48ac020\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/deleteComment.js\":\"2c143d40ceb80bd6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/highlights.js\":\"f0c11d723b840437\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/index.js\":\"d29a0ceafb008641\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/linkedCommentsPill.js\":\"db927e7173bacba1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/margin.js\":\"4f1a234d05d694ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/marginAnchorLinks.js\":\"83256c16d9ae4f19\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/marginSchema.js\":\"d7ff118519bb5b79\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/newComment.js\":\"010ce8b90be528b6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/ownThreadPicker.js\":\"a0daaa9686c26256\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/placement.js\":\"8774ba5c4ff1ae17\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/queries.js\":\"f2cf15d8bb5ffa66\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotePosition.js\":\"cedc27f0b4c3a8f0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotedIn.js\":\"238b663e4552047c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotedRange.js\":\"4039f5dff27bc3dd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/rangeRefs.js\":\"3b4b1c8093792ebd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readHighlights.js\":\"1bf485e3bc64c492\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readSelection.js\":\"97ce6e002da9c706\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readSelectionUi.js\":\"3ba17594eb360f5b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/reanchor.js\":\"d83bd687935848fb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/schema.js\":\"39e729f7e804a3cb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/scope.js\":\"4adc7357a64edc99\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/scopeThreads.js\":\"5adbdda96a55e7e8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/splitRetarget.js\":\"57845cfbfb589bf6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/suggestionCard.js\":\"95575ff12984e68a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/suggestions.js\":\"771604c73a78ebd5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/summaries.js\":\"e283447f03225d52\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/summaryBatch.js\":\"7fab1dda2ff33051\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/surface.js\":\"7ccb9ce2696a4818\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/threadNavigation.js\":\"8b94573559a5c276\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/threads.js\":\"47e6359d7cbd4a6a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/ui.js\":\"17cd233eb35f3d38\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/uiStore.js\":\"0404374688b37f8b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-intents/appIntents.js\":\"7cb1c8b0287fa799\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-intents/index.js\":\"bb1d68ac92efb765\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-update-prompt/index.js\":\"4409d40e9151c63c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-update-prompt/status.js\":\"eab241c8327debdf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"79fa67923f170012\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaBlockRenderer.js\":\"7555866c8b1b21f9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1897728e75584b25\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaUploadReconciler.js\":\"1cf2a050a89a3701\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetDownLane.js\":\"c10d4047807a80f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetResolver.js\":\"3283b3518f773849\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetUpload.js\":\"ec2a63e25a80b5b3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/attachmentCleanerIO.js\":\"f7a265ea1cc94d30\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e6ec0790c179f7bc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/blobStore.js\":\"675f74671af2ada8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/browserMedia.js\":\"4fd2b03f57b90238\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/byteStore.js\":\"4450d33ec046a8b5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/cleanerIO.js\":\"7e769ca6d4dfb413\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/cleanupAttachments.js\":\"083dcfa5f148a4b9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/dataExtension.js\":\"8c41e5cb7479d540\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/downLane.js\":\"da35086d9de13dcc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/index.js\":\"5c8eb1cb71a2045b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/insertImageContribution.js\":\"5a2eaa1c9974f75a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/laneArming.js\":\"7894feea743ba8c3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/laneLock.js\":\"aa11f721b3f0f6f2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaBlock.js\":\"2c13dd5fe2b4d6fd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaCapture.js\":\"c98a2d6a0afc6114\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaLanes.js\":\"e6e9b7137252b132\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaViewers.js\":\"25dbe5f88d7ffbf6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaViewersFacet.js\":\"ebbe2030d213aa30\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/pasteCapture.js\":\"eb24040be5921b7b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/resolver.js\":\"e9836f33b0db657c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/retryUploadsAction.js\":\"42b6b80f08b8af02\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/storagePaths.js\":\"fa415cd6cc7d0aef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadDrain.js\":\"4de9a15ff72817a7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadLaneStatus.js\":\"7437d5f5d09f5784\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadReconcile.js\":\"8f644b70f0ca85a7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadRecovery.js\":\"38c3483f3771ed4e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadStore.js\":\"398581765e77a183\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/useAssetObjectUrl.js\":\"ad803cac5b1d18fe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"bf51eb9482129e5b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/BacklinksViewSection.js\":\"89f28bc6680d85ed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/facet.js\":\"1c445a36c47ccfe4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/index.js\":\"9424ffeef80428a7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/prop.js\":\"fe8116327cf9e0bb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BacklinkFilters.js\":\"f18662f5e7ff91ba\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4c091f6d8e78a5aa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BlockEntry.js\":\"aac0b23043758232\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/LinkedReferences.js\":\"49629c2478e0640d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"f91d8a8660783f75\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/dailyNoteDefaults.js\":\"f1fd996fd1fbd737\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/dataExtension.js\":\"e31a89a0ad81f309\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/edgeExclusions.js\":\"6de3c20cab625853\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/filterProperty.js\":\"d40d0bb03a3521af\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/index.js\":\"398d5d7490d4b550\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1d954180dede6352\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/applies.js\":\"01a41b156868a610\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/countQuery.js\":\"082d38faf4dbdfc1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9cd7376a3ef6cfb1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/index.js\":\"ada4236e6f66d920\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ad89a3bd10503a52\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/presentationInvalidation.js\":\"ba7786387bb281e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/propertyEditorOverride.js\":\"868658b44df36550\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/propertyFilter.js\":\"5f4556e87c8b425f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/query.js\":\"59351f12ee7c7e54\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/resolveFilter.js\":\"d2cb70bc21312f91\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/sourceBatch.js\":\"bdc56a8e70cec1ec\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/sources.js\":\"41d8b2c94c7ab803\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/useBacklinks.js\":\"33ff40d6d3db46e8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b234cd88171e382e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/BirthdayCelebration.js\":\"2431b3b6a9ac71e9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/BirthdayOverlay.js\":\"31f631d4032e4837\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/gate.js\":\"e7e90e394e716835\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/index.js\":\"e1f86eece02010fd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/wolfTheme.js\":\"d474d13316071e76\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/BlockDragLayer.js\":\"4804983b83058e3d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/dragController.js\":\"d747f9b8bff289ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/dropTarget.js\":\"8a63d9e089cb3665\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/index.js\":\"f03e5dd4c541e159\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/projection.js\":\"4e8b4bd99936c7ab\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-info/BlockMetaCard.js\":\"8caf9c9f5787a1df\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-info/index.js\":\"1cc97eb55b608099\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/AddTagDialog.js\":\"006450fd7f16e8f2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"16fbb7772a476bd4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/TagNameIssueHint.js\":\"921e01654b978e78\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/addTagAction.js\":\"6fdd8845b22d6f49\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/appendTag.js\":\"3c7daa1b2fdd2292\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/config.js\":\"01649a351723fc8c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/dataExtension.js\":\"6b59c190233d9330\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/index.js\":\"3386c7c4c964daff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/propertyEditorOverride.js\":\"2b7faf561eedd7e4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/BreadcrumbList.js\":\"398058847722dacd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"42e12917c1c0e890\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/Breadcrumbs.js\":\"1a31d1512299f152\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c13aac4d5fd2bd05\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e0e6399adc35eacd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/index.js\":\"b2843d003ef3d3a8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"51d64dc73e687fd5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/CharacterCountItem.js\":\"26762e24e2a9eaa0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d49061aa93d7a476\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/actions.js\":\"8f296d2fbf072c28\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/blockType.js\":\"d723f2524c5fda81\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/charCount.js\":\"e5bd38f46c42bf56\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/dataExtension.js\":\"88a70b0f5960dd50\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/index.js\":\"f57a916a636a99e0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/profiles.js\":\"b8f4e0400f0ac0e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/properties.js\":\"ddc9ae7da588f342\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/textCounts.js\":\"2ad3d9e8201b1a31\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/colemak-keybindings/index.js\":\"8e7e60167f1eac19\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/CommandPalette.js\":\"8bc887618b8265de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/HeaderItem.js\":\"665d9abb8207c660\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/context.js\":\"b9d04e327e4c9f38\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/index.js\":\"becd4c2606707839\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/selection.js\":\"1e425ce8dec4ed9a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/toggleStore.js\":\"592be8a766acaa9b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/useCommandPaletteActions.js\":\"2d42cd6b9495f3a3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/ContributorBadges.js\":\"60a0a44d9dc734d6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/author.js\":\"4a76310e652eaa50\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/codeMirrorExtensions.js\":\"8705536df553db6e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/dataExtension.js\":\"77630a26004dfd74\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/index.js\":\"bc7600efd9a5c903\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/mentionAutocomplete.js\":\"a803f9c60c768696\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/processor.js\":\"e104aec7656a4746\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/profiles.js\":\"1970c1640514d52f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/queries.js\":\"538fbce71a9dc6ba\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/schema.js\":\"9179a7e28bcc9548\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c975577c66a53d34\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/followOrigin.js\":\"42307faa17714ad0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/index.js\":\"349a3bb8d669eb93\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"50a9f91f89cf04d9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"09f7e3b18629fee1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/CalendarGrid.js\":\"0ae53796eed61d24\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DailyNotePicker.js\":\"549201f5596a6513\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a4ab8bb553b02409\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateNavDecorator.js\":\"6f2eb18b0bdf687f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateScrubOverlay.js\":\"4c1009bd55844770\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/HeaderItem.js\":\"fd4c9fbd965bfe2e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/ReschedulePicker.js\":\"abe15480fb5eac9a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/SpreadDatesDialog.js\":\"bff36b18450da1c6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/actions.js\":\"8dc954bf555483a6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/blockDateAdapter.js\":\"ffaf7a66c6c7b071\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/calendar.js\":\"84172b87efa5c9eb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dailyNotes.js\":\"77c064a6e140ac1d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dataExtension.js\":\"c4d0b34f1e281a4b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubActions.js\":\"f2bbf1cafc499dd3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubGesture.js\":\"2e3cb6ee7bb2ab30\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubGestureActions.js\":\"2a1564d0553ce033\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubRecognizer.js\":\"297e565fe98a069a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/deletionGuard.js\":\"000f40877d4e9a3e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dueQuery.js\":\"f42df8abdca8bb8d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/index.js\":\"c723927646002b1e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/landing.js\":\"7a6bbb861988db14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/localSchema.js\":\"b0f71445ad68c3da\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/referenceDateAdapter.js\":\"77853833b2942c8a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/rescheduleAction.js\":\"e4a7a094deca0f68\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/schema.js\":\"f0a0790e49c62395\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/spreadBlockDates.js\":\"c7397f35aa354128\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/spreadDatesAction.js\":\"c7500b33600d96a1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/today.js\":\"b70cc91ac056ef7b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"0937419ca531f7bc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"dc0bbe96a59a7ad4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/audit.js\":\"509a09251efb5727\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/auditAction.js\":\"0c7974432ab72421\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/auditRanges.js\":\"0098ef5e3e769b82\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/diagnosticsSource.js\":\"db8afcfac0e55b04\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/divergenceScan.js\":\"dda3fef2641f2ba3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/index.js\":\"567ba5a7657dbe85\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d31172fff33fff75\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/referencesMirror.js\":\"6c59d2f600336ca7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/rowJson.js\":\"e213580c707756e0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/schedule.js\":\"2c3eefc6a594beee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/store.js\":\"53df5bc8a28ea157\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/action.js\":\"e8793140046485c9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/index.js\":\"876d4b9a4785df4d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/plugin.js\":\"61d49ae6c5919d0d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f5a4e27a95b6f169\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/actions.js\":\"55b690200d211578\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/changeMarker.js\":\"b4671f7b27735185\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/diagnostics.js\":\"6d56c4398a0ad9b9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/fileSystemAccess.js\":\"1ef5bdb39bc9c5ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/filenames.js\":\"a0b0f8da820b51ff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/index.js\":\"f1aca5c4af6c7f66\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/mirror.js\":\"a83c4f314e107fb2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/runLock.js\":\"44d6be5170cebc5d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/runtimeHealth.js\":\"603a287ca748eca9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/schedule.js\":\"e73211b5dcbdedb2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/store.js\":\"e803993617401bbe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/default-themes/index.js\":\"21badbff3f94b902\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/default-themes/themes.js\":\"1a720dd1d867a108\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/diagnostics/facet.js\":\"07817843df1dad5f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/diagnostics/useDiagnostics.js\":\"a28fe86ac8e4f142\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/dismissals.js\":\"5ff61d677f3573fe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/index.js\":\"3ca59054d157d528\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/status.js\":\"aa5a9707ae21543a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/store.js\":\"de9444a01f80946d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"44f032db57c441b2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/ExtensionsSettings.js\":\"739b9dae69575696\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/actions.js\":\"a590f9418b08c368\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/config.js\":\"1f12603a5d6390b1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/dataExtension.js\":\"a0829b0d7edc97ea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/effect.js\":\"8cdb0e309834594b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/index.js\":\"ae426b3ed69c93a3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a6fd71a7edbc0a85\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/useToggleTree.js\":\"1f00fa6c438316f3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/ExtractTypeDialog.js\":\"9ca5cb90ca50fc6f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"da1cefd71cba0abe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/PropertyShapePicker.js\":\"7c3444b85986cf33\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/action.js\":\"cc4a00d8d23e12d1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/index.js\":\"60b62a0b6aa3979b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/FindReplaceDialog.js\":\"eb8660a341fbc630\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/HeaderItem.js\":\"56583a25c92b92ab\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/dataExtension.js\":\"38106b0ca830f0b6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/index.js\":\"695019d20028cbb7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/search.js\":\"ccd76814d0642cd1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/toggleStore.js\":\"ebf9a8f50c5cab42\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/LocationPropertyEditor.js\":\"54a6c08750a8bb06\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/MapView.js\":\"204401799739f77d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/blockTypes.js\":\"ff76338ff40f6d52\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/codeMirrorExtensions.js\":\"1adc7a97cc3577e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/createOrFindPlace.js\":\"5c98b8e57150dbe4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/currentLocation.js\":\"54178e0282276a1d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/dataExtension.js\":\"b805ab0572d81868\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/geoContentDecorator.js\":\"42d9bdf0d165a73a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/googlePlacesClient.js\":\"20c503f79b52c7b8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/index.js\":\"68412ae7c3007c30\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/locationsPage.js\":\"5f9f7331a7794e42\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/mapViewport.js\":\"9604a16b201f2eb8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/pickCurrentLocation.js\":\"fce309fd13093a51\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/placeAutocomplete.js\":\"83684cfa555b0993\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/placeNameCollision.js\":\"ebe5d4f9eee29248\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/properties.js\":\"9721f27f3addfd93\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/propertyEditorOverrides.js\":\"63b98fa04fba3ad1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/query.js\":\"d63f506f1b7f9825\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/usePlaceSearch.js\":\"63c7140eefd13845\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b328bd36a5da157c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7ce14ccbb6b23a43\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"24868a319922fc7e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/config.js\":\"1716f45da1aef4e4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/dataExtension.js\":\"c7e8e7472e92aa76\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/facet.js\":\"56aaacfbb852a8a0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/grouping.js\":\"f71e77cfed6ae65b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/index.js\":\"8dc6794df01d100a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"812c4dffe5a3a3f3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/query.js\":\"69e6865a17af1f26\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/resolveConfig.js\":\"8d07895560656399\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"82e366da5f010cfa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"286c8a4fc7b88ff1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/HtmlDocumentContent.js\":\"d614818252eb2a11\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/HtmlFrame.js\":\"15b4bd1465831270\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/actions.js\":\"c85a7d4c77e05b34\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/blockType.js\":\"ccc5323cfacaa8de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/confirmRunScripts.js\":\"d68ba334e219e1f0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/dataExtension.js\":\"ff530d15a745e574\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameAnnotations.js\":\"e9cb2e64e1d99825\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameDocument.js\":\"6a6c0e651d8df633\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameTheme.js\":\"0a55c455faf2d483\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/index.js\":\"229b7696d5287ead\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/scriptConsent.js\":\"5a260ebfef5127c7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/sourceMap.js\":\"6e7f199912bd62de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/useDocumentScripts.js\":\"137225010721c3d3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/index.js\":\"27b0dc37efd2e2bd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/record.js\":\"12b48a0f92775eae\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/recordStore.js\":\"42c757b05112e015\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/responsiveness.js\":\"a806f8194598c3c2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/schedule.js\":\"41ee4f873b243320\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/sessionContext.js\":\"acb2e4abd8b07f17\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"f9b234e6548eed30\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8ecc7097d970bf24\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/actions.js\":\"8bb02cffb7a41fd3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/config.js\":\"9d08862287739d44\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/dataExtension.js\":\"8699a09a701f12ba\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/effect.js\":\"d1b13d32b17ebd8a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/index.js\":\"a9bec894854136fc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/keyCapture.js\":\"3e1bb0aca9ddb970\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/overrideStore.js\":\"65050c678dd8c0f7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3f4d635cc97fbd88\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/HeaderItem.js\":\"0cd7c09f2f85753c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/LeftSidebar.js\":\"1b8c5aaad5b15168\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/actions.js\":\"3cc29ae041a0a97c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/facet.js\":\"dcf8aab13867705d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/index.js\":\"59e03570dee23034\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/shortcuts.js\":\"53658a32053b0251\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/toggleStore.js\":\"e5a169aefdb34654\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/MergePicker.js\":\"b6ef34a5009e1d97\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/index.js\":\"5a834efe62093a45\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/mergeAction.js\":\"310eef3851446af9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/strategy.js\":\"04bce6f571f2e87c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/Button.js\":\"ed72977fce1664d6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"eb1fe34e2fed5650\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/defaultItems.js\":\"bc387eaacc950a94\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/facet.js\":\"9d3ce00f86b2a393\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/index.js\":\"b460d92557882bde\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1a547db4cb5dbe27\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/actions.js\":\"43e10d484aa18598\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0ba80b54699d1d51\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/facet.js\":\"38a9a9cc08a328c8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/index.js\":\"e1cd9d6ca2febb08\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/MoveDestinationPicker.js\":\"7820023bb3214031\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/blockSubtreeMembership.js\":\"a4c7981d75e735d7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/contextMenuItem.js\":\"588ae37e0828b345\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/index.js\":\"b7326e25e2c4efff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/moveAction.js\":\"2c920fc7edf9b3b2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/moveBlocks.js\":\"704f21194752a9c8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/selectionAfterMove.js\":\"73e57e74ab534233\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/TutorialBanner.js\":\"586289c10b80acd9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/action.js\":\"e060029106ba0e6e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/bannerDismissal.js\":\"a591a2fb1479ae7d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/documents/cheatSheet.js\":\"951fe0a2f74b617a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/index.js\":\"862be57e88ee7c5e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/keys.js\":\"5defebcc9ec9e1cf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/landing.js\":\"7b27cf1691968ca1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/outline.js\":\"3a4274b60f8bea7b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/seed.js\":\"0ce8d522c6301487\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/PerfTrendDialog.js\":\"2b2ae85b21ef965e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/analyze.js\":\"0037b66eee87cf89\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/diagnosticsSource.js\":\"965c4b781d73353a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/index.js\":\"bfd0121738b58f29\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/load.js\":\"5cd0a7e49d3122cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/monitorRun.js\":\"7b64e157142df75a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/schedule.js\":\"78b498ea4fd92625\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/series.js\":\"46b0280692a4cb65\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/store.js\":\"ecef436426613813\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/trendAction.js\":\"26666877296f6f30\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/verdict.js\":\"3c1dcfd9e498bc9e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/clickToEditAction.js\":\"5d807a5e596a289b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/index.js\":\"870f72f9c6e1eb18\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/interactions.js\":\"eaf3407d3e651195\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b2fdd65f8ff3df5e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/MigrationGate.js\":\"fcc38dd503e4dfe9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/MigrationGateDialog.js\":\"bde90c507318e181\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/action.js\":\"431f184144afb3a2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/index.js\":\"87aa22fa001eaa7a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/localRunMessage.js\":\"9dc04b164bc346c7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/plugin.js\":\"cfb5c88feac76f0d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/progressReport.js\":\"4bb283df2e8fa2b5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/sweepProgress.js\":\"b9e8a35440cc3eb7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/FieldRowRenderer.js\":\"b54a97af1f0b00b8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/ValueRowRenderer.js\":\"183e92585ffa3602\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/actions.js\":\"9634e75a526642f4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/autocomplete.js\":\"9f37c406b4189d47\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/fieldRow.js\":\"532d8df10dd360da\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/index.js\":\"67cc66e7d9997cd4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/referenceWarning.js\":\"3e38c3d9028c6bf9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/valueAutocomplete.js\":\"77d20a491d4931c5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/valueSchema.js\":\"0d27984ff4433bef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/HeaderItem.js\":\"8e707479b4c6834c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/QuickFind.js\":\"246b5cd0442add8d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/index.js\":\"4b9640ab24914364\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/recents.js\":\"b4cf0df88d701378\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/resultItems.js\":\"e76d11e9211dd897\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/selection.js\":\"43fad77ce4f75071\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/toggleStore.js\":\"455ec9d941a304a7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/HeaderItem.js\":\"78848ac687c20e10\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e9f1c172799f4824\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/grouping.js\":\"1594bac9c8a38e78\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/index.js\":\"e2556314b56c52e8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/target.js\":\"255cf748d3d76de1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/codeMirrorExtensions.js\":\"349b7e586354c64e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/contentPrefill.js\":\"c15691e024c5966c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/dataExtension.js\":\"ff63bdbb50293c18\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/index.js\":\"4799f2e152986657\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e684568d18af47a0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/invalidation.js\":\"7c0185e111c493de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/localSchema.js\":\"4e2185e79d4036f8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/blockrefs/index.js\":\"6b7858ee097ecc70\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"ab2f5a0dcde2f777\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/index.js\":\"3b9a76bee3fe7433\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/referenceNode.js\":\"65d6bc47aa47450b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/remark-reference-occurrences.js\":\"4a176163ad900f6d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c32bfa6a65ce79cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/index.js\":\"46a7f76992ae9d8b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ab1c22d4ea84c18d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c9020b96872277d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/mergeRetargetProcessor.js\":\"448003a11863a448\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/parseFence.js\":\"6f4e9fbe0b51efbf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referenceParser.js\":\"5a7fe96e98488f29\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referenceProjection.js\":\"a462374693cd4bc2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referencesProcessor.js\":\"df911af8a4067fab\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/renameProcessor.js\":\"7220acd6a748792a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/spanReplacement.js\":\"23eb6184e4e08622\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/htmlToOutline.js\":\"38fff3dc644b45e0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/index.js\":\"2c1be41c2eb28706\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b4935c6074002a6c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/pasteDecision.js\":\"36e3c87e87f7c34f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/action.js\":\"ca4897eb6e612e05\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/blockIds.js\":\"cc33073320a83536\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/content.js\":\"cc2bf46df3068111\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/effect.js\":\"97000f66103003ba\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/ids.js\":\"2f1c87bb94c67749\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/import.js\":\"def1eaea8378aaa1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/index.js\":\"1aec0e00180024f2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/plan.js\":\"d3313cf26ebb4a75\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/plugin.js\":\"91311049ebcf0289\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/promotion.js\":\"cc24badad13af25d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/properties.js\":\"725bbca782ed2f21\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/references.js\":\"371e8bf72bf09e18\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/report.js\":\"c09b006de63abad4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/roamMemo.js\":\"2d8b56612103b9f8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/runtime.js\":\"4ab4a8a1ec17f607\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/schemaReconciliation.js\":\"a5ca8edf52b93c07\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/srsMarkers.js\":\"7f182f5bf24e8ef6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/todo.js\":\"21451fe6b2705278\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/typeCandidates.js\":\"923fb7b19e29cbb4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/types.js\":\"ad700ad865f6828a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/search-health/index.js\":\"0f94e5f66ae242b0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/search-health/store.js\":\"774efec84e3f5997\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/HeaderItem.js\":\"cb37f80309c8a9e2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ca6b631030d11fb0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/index.js\":\"594595ec2d7a8607\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/model.js\":\"85158632954760bb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/toggleStore.js\":\"d6466668d012566c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/useKeyInspector.js\":\"4f611bc8c0915605\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d1277388b8e52935\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/ShellDecorator.js\":\"f38bb025407d102e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/actions.js\":\"1303a369cc901a4f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/exclusionsFacet.js\":\"766c5980f2bba2dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/index.js\":\"9b297b89a0c8e857\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/shell.js\":\"4d64f4d99b3a6c42\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/surface.js\":\"ec9a0949b154196d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/walker.js\":\"84ee10a84860ebab\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/RescheduleToast.js\":\"91943005575786d8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/dataExtension.js\":\"d27885b126b3d7f1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/index.js\":\"87fbf0c140e57f22\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/indicator.js\":\"9331436e0227a1dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/moveSrsState.js\":\"c171a085b3d9e88f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"7d4c3eb0f4ca273c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/scheduler.js\":\"6906727f11f04c21\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/schema.js\":\"c9c6af4f07884944\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"c3aebc1d8ef0803c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/srsClipboard.js\":\"b0e983b5e9da9140\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"fd22e791e833d8c4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/DailyNoteReviewHint.js\":\"66928866855bc5b0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/DeckPicker.js\":\"f2e4d051b61f19e6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewControls.js\":\"9fce23b0f0d64bf5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewDeckRenderer.js\":\"195bde39f6d1c634\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewSession.js\":\"bdfe57f31966690e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/actions.js\":\"23a0af8f5b8e2094\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/archive.js\":\"09310d35d94884df\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/dataExtension.js\":\"beedf7cac52311b1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/deck.js\":\"f788303db3480ec2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/dueQuery.js\":\"a246fd8ab8eb66f0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/gradeDecision.js\":\"d1b1335b63076a23\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/index.js\":\"6a8ada80aa5b36cc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/keyHints.js\":\"921263f67c95af3a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/reviewCardLayout.js\":\"67abfee8854d2c01\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/reviewProgress.js\":\"56102b4ad9d62947\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/schema.js\":\"508f2bc6c29b5aa6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/useDueCards.js\":\"67d83893479606df\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/startup-metrics/index.js\":\"67acb12895e3031c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/startup-metrics/record.js\":\"70b66bec073d8436\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/index.js\":\"48babb48bed6319c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/persistenceStatus.js\":\"75ebc054f8d4dcbd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/requestAction.js\":\"b7d647ea11d50701\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/TypeChipsDecorator.js\":\"6adff2c2c3db8e0f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/codeMirrorExtensions.js\":\"9dabc9942d16aaae\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/index.js\":\"0d80ada181c9df5e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/typeAutocomplete.js\":\"0749c4d6b915e215\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"b74087be132672e2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/actions.js\":\"cfde7c0e5a65895f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/anchor.js\":\"01d10501fd60740b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/events.js\":\"c7a4270a0a2839f6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/gestureActions.js\":\"cc55c628afeeaaea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/index.js\":\"1d664abdd5d8f279\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"da3625c2b955f3b6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/collect.js\":\"7b469f29beec3b9c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/index.js\":\"50f63c3139a9d649\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/record.js\":\"7c9836829e41edc4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/RejectionDialog.js\":\"efe595f00e5b30df\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/SystemStatusHeaderItem.js\":\"cbdd46b1e5e30075\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/index.js\":\"2d93a8850eb6680d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/model.js\":\"e4406bf610fe6185\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/queueCounts.js\":\"e2490116a166acc1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/rejectedHelpers.js\":\"a6713c713ce88cf9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/rematerializeAction.js\":\"eadac385d8fe7305\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/useHysteresis.js\":\"476a917f1b792921\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/ColumnHeaders.js\":\"e14a26a8f627a8f1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/QueryUi.js\":\"d64c35fbcb36bf15\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/TableLayout.js\":\"56fde3202cbcc73a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/actions.js\":\"388063f0a500bb86\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/cellEdits.js\":\"bef2d42ce4b1ad52\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/childrenViews.js\":\"a7f2a8be55056bc5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/columns.js\":\"8e6036c326830385\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/controller.js\":\"dc509ca891510e75\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/convert.js\":\"13793c20d18254f2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/dataExtension.js\":\"44e7b29c95fb69a7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/index.js\":\"63e7ee0f50a90f62\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/keys.js\":\"c2b5143ff9628dac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/model.js\":\"5489d23f6c69442c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/backfill.js\":\"ae49481f95b3e0d5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/completion.js\":\"428ef141f93c92a8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/format.js\":\"8625a294b7dc7522\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/parse.js\":\"16b6abe1738f9715\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/queryValue.js\":\"55578c72b0d2a299\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/source.js\":\"729c6faba4b30a1e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/registry.js\":\"b70e2c40bb86a459\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/rowGutter.js\":\"a1411434d1d8b5d5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/rowVerbs.js\":\"de2d97398eb5e2cc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/schema.js\":\"87fb992ac41ba8ce\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/sort.js\":\"ea3613e22b5f4ceb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/effect.js\":\"60caa0973245b517\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/index.js\":\"8fe32e08c2cceb9d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/theme.js\":\"27d1eb6b7861c838\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/actions.js\":\"216471fe5f176fe0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/dataExtension.js\":\"bac8c9a5e277b4d7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/index.js\":\"717a1167ad5db9fd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/schema.js\":\"66d23669fa6009f3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/TouchSelectionLayer.js\":\"555f9ec77b496ee3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/actions.js\":\"10324d4d7fa6f604\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/defaultItems.js\":\"ad227dc94df0785c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/facet.js\":\"4b19787530768203\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/holdRecognizer.js\":\"beaa3825282626ab\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/index.js\":\"be380a2f6ed7a121\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/UpdateIndicator.js\":\"f84e3444ac0868aa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/index.js\":\"3a8c91002a2f41ff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/loadTimes.js\":\"45642f927d89e6f4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoNotesRenderer.js\":\"9b633f2027d843f8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoPlayerRenderer.js\":\"f856eda1a5a60155\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoTimeStamp.js\":\"c1f402ceff2f9994\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/actions.js\":\"587deb2daf5f690c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/index.js\":\"06d91eb0c12b8675\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/markdown.js\":\"cae67c78fe39693a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/notes.js\":\"19ccb307494a03b7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/registry.js\":\"a1963b1492de9068\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/remark-timestamps.js\":\"f1eae9457a2860f9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/view.js\":\"233cd24c7f3bfd4f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/LinkHints.js\":\"c098556920492b38\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/index.js\":\"e7d9590c6206b615\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/model.js\":\"f84f8665e62efdd2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/settings.js\":\"d2c67594c58843a2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/actions.js\":\"0dbfc151eb961c45\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/index.js\":\"4e30391a68e5b4ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/interactions.js\":\"1fc1c665b97925a2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/workspace-header/index.js\":\"d6acea31f825bdc0\",\"/knowledge-medium/pr-preview/pr-1876/src/registerServiceWorker.js\":\"2a9c3cda8492534a\",\"/knowledge-medium/pr-preview/pr-1876/src/requestPersistentStorage.js\":\"0e8ef4d0fbf96598\",\"/knowledge-medium/pr-preview/pr-1876/src/services/authRequestDeadline.js\":\"a8ad1d27ad974fcd\",\"/knowledge-medium/pr-preview/pr-1876/src/services/authStorage.js\":\"73cdac80db67bd7a\",\"/knowledge-medium/pr-preview/pr-1876/src/services/powersync.js\":\"2cfaee25daa92ead\",\"/knowledge-medium/pr-preview/pr-1876/src/services/supabase.js\":\"9bd7e1b6e0bcf646\",\"/knowledge-medium/pr-preview/pr-1876/src/services/uploadErrorClassifier.js\":\"5998eb1091e8b2f2\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/ActiveContexts.js\":\"701f2882b25c66e0\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/HotkeyReconciler.js\":\"923ec56632617e8f\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/WipeLocalDataDialog.js\":\"85d475652ab00616\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/actionDispatch.js\":\"bfcf057aa62f91e6\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/actionRefItems.js\":\"89a91d8f9c95c6ae\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/applyKeybindingOverrides.js\":\"1289373fbea3e0f1\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/blockActions.js\":\"4e31e8f2031fd6c2\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/blockMergeGesture.js\":\"3dc5509a5facdb2e\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/canonicalizeChord.js\":\"9ae3fcb5cd886bab\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/defaultContexts.js\":\"636de0b561d868f8\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/defaultShortcuts.js\":\"4cdcf9da4413438d\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/effectiveActions.js\":\"93fb76963cc16dc1\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/gestureAction.js\":\"b7f543e6cf5d4b76\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/gestureBinding.js\":\"6050ea4e183a7a4f\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/holdRegistry.js\":\"bff2d5e01d9a3083\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/keybindingConflicts.js\":\"ad152ae80cfa7277\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/keybindingOverrides.js\":\"bdc2cffc8f736514\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/pointerAction.js\":\"097b0cbd69f02313\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/resolve.js\":\"bcdb5bc538ea3511\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/runAction.js\":\"e2a399ada9f39c76\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/sequenceMatcher.js\":\"3442024dcf609fe5\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/types.js\":\"9e467bc42fe36ac8\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/useActionContext.js\":\"9022fcd24e1575af\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/useActionDiscovery.js\":\"670292207f4679e7\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/utils.js\":\"b63755e6746b6b59\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/bootStore.js\":\"b755d90cfa51d049\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/previewDatabases.js\":\"de6b5128f9b6c8e3\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/byteTransform.js\":\"ed0fae6e225b81d9\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/attachmentCleaner.js\":\"12374cf0f3672867\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/attachmentParts.js\":\"d50e1b4e41d3d9e8\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/bundleParts.js\":\"9cb33f494637f369\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/bundleRecord.js\":\"5134b1e0ba609d29\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/manifest.js\":\"970e62e680aaa65b\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/takeBundle.js\":\"f152675bd9b021ae\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/verifyBundle.js\":\"bba02bfaf25f263f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/cleaningStage.js\":\"61b5375cb135e9d3\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionKey.js\":\"9448008809f88cbe\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionServer.js\":\"fd63d67fa6a023fb\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/flip.js\":\"93d85439257154bc\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/flipAttempts.js\":\"34449bb351bd1125\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/pages.js\":\"3ffa240c13e88bd6\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/preflight.js\":\"491d7438fe1ce406\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/reseal.js\":\"955edfd96cf0b8c8\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/runConversion.js\":\"41a31002a9bcd086\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/runLock.js\":\"150a39f200d4a0e4\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/sealing.js\":\"02eda7bf0aea6a49\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/sealingStage.js\":\"72ec3c7c5d8fb87b\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/stage.js\":\"91117e82b3b3c2ef\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/verifyReseal.js\":\"4434ac7fc650d737\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/aad.js\":\"0f9420c09ac0cd4b\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/aead.js\":\"4d4fe6746ade9a72\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/base32.js\":\"880340d61cae18b9\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/base64url.js\":\"d17355ee98d9b557\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/binaryEnvelope.js\":\"ce8104b4e84694f7\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/byteAead.js\":\"e1caaadbfdd7e98f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/canary.js\":\"2dd8033da290f8de\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/contentHash.js\":\"be9ac0547b8bd8ac\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/contentKey.js\":\"cdb41f7dbc742171\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/derivedIdNamespace.js\":\"4ab04a9b8b08c75a\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/envelope.js\":\"e07365d0c6ab8aa4\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/hex.js\":\"097e4aa42858f74c\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/sha256Hex.js\":\"800bbeb68e54a7e2\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/workspaceKey.js\":\"9722e2fa69b63891\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/conversionState.js\":\"07dd13df269a9bf5\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a4c2f593c502aa73\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/pastedKey.js\":\"f655c09b8af93d0b\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"58f082a383f94979\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c6a5c38fad3c81fd\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/keyStore.js\":\"1af439a259c33200\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/mintWorkspaceKey.js\":\"544ad12a4f7cef23\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/modePin.js\":\"6902bc18abe340dc\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/openWorkspaceKeys.js\":\"808d5c51cdcbdd2a\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/resolveWorkspaceEntry.js\":\"df9af696b7c290c5\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/resolver.js\":\"96faa18f13b2093f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/workspaceAccess.js\":\"bca0698e59f50234\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/transform.js\":\"f42e90e4c85fb98a\",\"/knowledge-medium/pr-preview/pr-1876/src/themeBootDefaults.js\":\"284a8a95ce9ac306\",\"/knowledge-medium/pr-preview/pr-1876/src/types.js\":\"b27da8446bbdfc67\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/ClientLocalSettings.js\":\"373c0c8c1a70d7a3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/abortableSleep.js\":\"671d257485408af4\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/array.js\":\"2bbdfcfcbe6e29b3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/backlinkAutocomplete.js\":\"acd7cf27f9de0003\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/blockCrumbs.js\":\"7090febfe7c5b4cb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/blockrefAutocomplete.js\":\"56be25d3dc2a881e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/cadencedIdleJob.js\":\"78471684253dbdf1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/callbackSet.js\":\"de309465e940c9b0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/clientId.js\":\"c1aa4a2a0ef12f02\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/codemirror.js\":\"44727eca1815224f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/codemirrorCompletion.js\":\"899228b6358c2526\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/copy.js\":\"3f0af3fe5c34833a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dailyPage.js\":\"82f9f31a2db31bc8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dbForensics.js\":\"c1b7cb84ec607e7a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dbForensicsHooks.js\":\"9916173058833ed4\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/deleteBlockThroughUi.js\":\"a04922efdf617d2c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dialogs.js\":\"ff35064690ac48bf\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dom.js\":\"3b37a1ada928baad\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/downloadBlob.js\":\"6931ad68c811b9f9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/drawnWalk.js\":\"0f102f3506c91314\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/exportSqliteDb.js\":\"1faa915432d8d583\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fileSystemAccess.js\":\"e5bdf79e4c449e9d\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/flipSlide.js\":\"26f9c1ef66b3666d\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fnv1a.js\":\"514269ae6ba59dee\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/formatBytes.js\":\"46d2b2b824c9858f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fuzzyRank.js\":\"916488c648827443\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/idbKeyedStore.js\":\"96b19346d9054c64\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/idleCallbackPolyfill.js\":\"bd082ce311f0052f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/keyboardAwareScroll.js\":\"83483476b373eb6c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/keyboardViewport.js\":\"f0929558b1ee62b5\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/lastWorkspace.js\":\"9a63d97a3197f4e9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutColumns.js\":\"c7dff6d21ce3dca0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutSessionDom.js\":\"a67bce9926014065\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutSessionId.js\":\"72b03f4487703ae2\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/linkClickGestures.js\":\"ca6e2f98aaae07bb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/linkTargetAutocomplete.js\":\"c9014d85e5180954\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/localDbCorruption.js\":\"5ad405cf020215b1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/localDbRecovery.js\":\"5de309a4cbf39608\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/markdownParser.js\":\"269249003e40c986\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/memoize.js\":\"370ec5b67a39cdcf\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/nameFieldCommit.js\":\"47df23be7c40411b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/nameList.js\":\"ff7c587446e803fd\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/navigation.js\":\"8060477c9eee7486\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/omnilinerNamespace.js\":\"e6ff9725e870d5bc\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/opfsPageScan.js\":\"24cfda32346964d8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelClearance.js\":\"b29a705359df39a3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelHistory.js\":\"46701634b86d709b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelLanes.js\":\"d7d6b5d5b91e5bf6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelLayoutProjection.js\":\"d48a29f87175fb36\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelScrollAnchor.js\":\"b12dc0877050a2c8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelUrlFlags.js\":\"7b358135e7510ee8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/platform.js\":\"8f97b96cb7cae6a2\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/pluralize.js\":\"1bbc13709c1286f9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyCreation.js\":\"bd67993ed5bebb4f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyNavigation.js\":\"27f0f6c36d0cdbc0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyValueContext.js\":\"28fa9873ffd637b8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/react.js\":\"e57727ee7360e9f9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/relativeDate.js\":\"d65e3dc65528cbad\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/relativeTime.js\":\"0f049eaf38fe9a4c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/renderScope.js\":\"16f4d5153dfd60f6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/resolvedThenable.js\":\"cc0aa144c6f96499\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/routing.js\":\"8dfdf495452e92c7\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/safeMode.js\":\"0339227e7139ca5b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/scheduleIdle.js\":\"336ab2a726be869a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/screenWakeLock.js\":\"e9bf2b3973eca7fd\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/selection.js\":\"c21af4913b6e76ea\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/softKeyboardGrab.js\":\"fcbd5ec368e7e0a1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/startupTimeline.js\":\"7a549868bbaa0d30\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/state.js\":\"197982b89f091951\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/string.js\":\"2daecaf7125ae507\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/surfaceZoom.js\":\"645d3904e5c2d676\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/time.js\":\"d964f8e3783b899c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/toast.js\":\"6d0a5ee5c7f11d8a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/toggleStore.js\":\"6779333a1e697ec4\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/untilStopped.js\":\"0dc61966c8ba5bde\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/userActivity.js\":\"5d037456d8c451a0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/viewTransition.js\":\"d7b1dd00a86c5bb0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/viewport.js\":\"b5d8eaf57b4db898\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/webLock.js\":\"a6c583bf9f48e6cf\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/workspaceRecovery.js\":\"624d43e6d3010bb6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/workspaceSnapshotStore.js\":\"a1d26d56f50d51f7\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-compiler-runtime.js\":\"c40c6939a70af929\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-client.js\":\"a6fff64a59a092f0\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-server-edge.js\":\"af2fdf2ecce800a7\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-server.js\":\"146bb06e2dacd14a\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-static-edge.js\":\"a15f0fa16b720ec5\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-static.js\":\"cef35d17c04ecc48\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-test-utils.js\":\"d2ea798449a4d2ea\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom.js\":\"2120f87f903f0a17\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-jsx-runtime.js\":\"6a7fce18632745ec\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react.js\":\"cc9d72496455d8eb\",\"/knowledge-medium/pr-preview/pr-1876/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1876/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1876/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
