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
		buildId: "c90b611fd54f-8c79bd83",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/\":\"1bc9e587eb6a970b\",\"/knowledge-medium/pr-preview/pr-1876/index.html\":\"1bc9e587eb6a970b\",\"/knowledge-medium/pr-preview/pr-1876/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1876/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1876/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1876/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1876/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/pr-preview/pr-1876/assets/FacadeVFS-QjCi6DWI.js\":\"5e5274e12fa22bc2\",\"/knowledge-medium/pr-preview/pr-1876/assets/OPFSCoopSyncVFS-wxp1Uqdx.js\":\"26e3c44a3087f499\",\"/knowledge-medium/pr-preview/pr-1876/assets/OPFSWriteAheadVFS-CVFEYFmB.js\":\"9c0c063f0b0aca04\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-8TWgCfd6.js\":\"a9534c7c077aec29\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-async-Dzf0FjH0.js\":\"cc0155b76245b694\",\"/knowledge-medium/pr-preview/pr-1876/assets/worker-CedGonAS.js\":\"f8bbe6a306fb4ba6\",\"/knowledge-medium/pr-preview/pr-1876/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1876/chunks/app-COBQeT2F.js\":\"95d24579085c227f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1876/index.js\":\"6e2ca73599ab7506\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1876/assets/AccessHandlePoolVFS-Dia6ZnV6.js\":\"5a4b19079172a975\",\"/knowledge-medium/pr-preview/pr-1876/assets/IDBBatchAtomicVFS-CP0iq6pd.js\":\"11d774c0189783d6\",\"/knowledge-medium/pr-preview/pr-1876/assets/MemoryVFS-X1IFqAfC.js\":\"1e75a85b7e069894\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-BpOZgN39.js\":\"ce63225182905fa2\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-async-N55meU-N.js\":\"328756d3ba260649\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1876/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1876/chunks/AccessHandlePoolVFS-BgMDmHhJ.js\":\"985302057316668b\",\"/knowledge-medium/pr-preview/pr-1876/chunks/FacadeVFS-Cc3hK1f9.js\":\"4cfebba7b9d692ef\",\"/knowledge-medium/pr-preview/pr-1876/chunks/IDBBatchAtomicVFS-Dja7ll2L.js\":\"33b19bad4d13fe19\",\"/knowledge-medium/pr-preview/pr-1876/chunks/MemoryVFS-DUriqDk8.js\":\"9fd8c7d73ba3d871\",\"/knowledge-medium/pr-preview/pr-1876/chunks/OPFSCoopSyncVFS-CXpPi-E7.js\":\"c2a5266aaf2b1684\",\"/knowledge-medium/pr-preview/pr-1876/chunks/OPFSWriteAheadVFS-BsQVp1PJ.js\":\"8da17d7af6fcbcb5\",\"/knowledge-medium/pr-preview/pr-1876/chunks/Preview-DAEDW_bk.js\":\"ec357bc474676ea9\",\"/knowledge-medium/pr-preview/pr-1876/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/card-_kpkXclX.js\":\"c8201b1b0b3b1a83\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-BiD_-HrE.js\":\"d2653f918b73a868\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1876/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1876/chunks/mc-wa-sqlite-B72rlJkn.js\":\"e0d08bce43e37242\",\"/knowledge-medium/pr-preview/pr-1876/chunks/mc-wa-sqlite-async-eLVkrJOT.js\":\"f049793fdf76158f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-24yiFyt1.js\":\"183672f509a1c17a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-CR4PXcaK.js\":\"05bd589bd415f621\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-D-zmgMDq.js\":\"eb17ac4e21264de1\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-DEcVMPJl.js\":\"c0a44edc132a0783\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-Dr9a5Uwf.js\":\"3641f070f72fb406\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-XpPzzFet.js\":\"318780b107bdb76e\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server-legacy.browser.production-D8iMYihB.js\":\"edb89ac6d55ee56c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server.browser.production-BJGckpoB.js\":\"35b4e68810b28430\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server.edge.production-CN04yvpm.js\":\"14a90ea8a36d8d7c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-hw0qEJbg.js\":\"64db622a6413ca7f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-obOJsCqd.js\":\"eeb8e18e45517beb\",\"/knowledge-medium/pr-preview/pr-1876/chunks/server.browser-CV0YD7Lo.js\":\"b5ac142e96b9f3d4\",\"/knowledge-medium/pr-preview/pr-1876/chunks/textarea-2cHBBXOD.js\":\"744ab782f38dd546\",\"/knowledge-medium/pr-preview/pr-1876/chunks/ui-CmP6cePa.js\":\"5c3e35dbff770276\",\"/knowledge-medium/pr-preview/pr-1876/chunks/wa-sqlite-Cb0EYRpo.js\":\"5fb4e94cb4b50c1a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/wa-sqlite-async-BZU99hzR.js\":\"bed609b4f46da444\",\"/knowledge-medium/pr-preview/pr-1876/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1876/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1876/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1876/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1876/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1876/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1876/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1876/src/App.js\":\"05910d98f484f4b5\",\"/knowledge-medium/pr-preview/pr-1876/src/appUpdate.js\":\"878efced90db259b\",\"/knowledge-medium/pr-preview/pr-1876/src/appVersion.js\":\"7de752ebe331dbba\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/initialLayout.js\":\"885fc23d29ab7f89\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/openWorkspaceData.js\":\"e4e65e6df1773544\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/resolveWorkspace.js\":\"692dad1d466d45ca\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/workspaceBootstrap.js\":\"3369d7e7934ce787\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockComponent.js\":\"f5d600656f797f16\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockCrumbs.js\":\"fa92ec122e4c9568\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockEditor.js\":\"48b144354996818f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockLoadingPlaceholder.js\":\"a67b6b5e7be0cac2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockProperties.js\":\"28ca2dafc71e345d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockSearchPicker.js\":\"04847d7f2f66e503\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ConfirmBulkDeleteDialog.js\":\"3bb8fa81a88a8802\",\"/knowledge-medium/pr-preview/pr-1876/src/components/DividerHandle.js\":\"b7227b34965d7012\",\"/knowledge-medium/pr-preview/pr-1876/src/components/DraftEditor.js\":\"07c408f97a5db0ef\",\"/knowledge-medium/pr-preview/pr-1876/src/components/GutterPill.js\":\"dfcdfe4eefcffa26\",\"/knowledge-medium/pr-preview/pr-1876/src/components/Header.js\":\"be12cfdb247879a5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/LazyBlockComponent.js\":\"eb3c1316273bcbfb\",\"/knowledge-medium/pr-preview/pr-1876/src/components/Login.js\":\"ec0a5e4cefa36c39\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ZoomableSurface.js\":\"6e7a40e75faf5c1c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/editModeKeepalive.js\":\"33f397deaa050f3f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyDisplay/PropertyDisplayScope.js\":\"bf59f87969261644\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"fa9ab9b9ee05c77f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/RefPropertyEditor.js\":\"8460457aa1eab947\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/RefTargetTypePicker.js\":\"5de41ad877a68ffd\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/SelectPropertyEditor.js\":\"a09812ebc46d3e2a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/TypesPropertyEditor.js\":\"a5a0b03ae156aa95\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/defaults.js\":\"0d92393038865dd8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/kernelValuePresets.js\":\"ce081563747ae6ed\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/selectablePresets.js\":\"a6001cfb9f07de7f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/typesPropertyUi.js\":\"82d69baf28e7e4d6\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/AddPropertyForm.js\":\"f1c5b24fae75ffb2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/PropertyPicker.js\":\"b79b214d45cb6e17\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/PropertyRow.js\":\"282220fba1ff4119\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/Rows.js\":\"2efbfa0a338d3dc4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/actions.js\":\"41617b6eadac44dc\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/declarationOnly.js\":\"01adca977bd66492\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/layout.js\":\"b15bbba82df38e53\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/model.js\":\"f42313a1133a18de\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/shapeUi.js\":\"aec875f9680cf2ab\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/shapes.js\":\"fa0c48e3ee58d257\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9fd6564a9f519e1b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/visibility.js\":\"2ee8433d4d840eee\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanelSections.js\":\"fa01e68ff2b4575a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockEmbed.js\":\"de037d33e5e75310\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockLink.js\":\"91a77b37a46d61bb\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockRef.js\":\"7c9e34d74a892276\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/ReferenceLink.js\":\"0cffa7d164105b8b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/cycleGuard.js\":\"d54d72a9fa8d554e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/cycleGuardContext.js\":\"ed708b393600f795\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/linkInteraction.js\":\"b29f9c2e2a216f8b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/referenceLayout.js\":\"c29ff1fbd23b7e3f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/useBlockRefAncestors.js\":\"8f2042ce87b4cc19\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockGutter.js\":\"e78a4685b82bb5cf\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockInfoDialog.js\":\"590c338bc39b92aa\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockTypeBlockRenderer.js\":\"f453667d2d01610a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BulletHoverCard.js\":\"0c79b7024d81a41f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/CodeMirrorContentRenderer.js\":\"2eafd7e845b8d0be\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"d2efed3ee7596982\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/ColumnResizeHandles.js\":\"9563978ab7f7f726\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ebc7b374c6d9ec2a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/DefaultBlockRenderer.js\":\"4f6e5568707ef73d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/LayoutRenderer.js\":\"84fb53ca1b424276\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/MarkdownContentRenderer.js\":\"3f96536b7c3b6eca\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/MissingDataRenderer.js\":\"750e09d0db3564bd\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/PanelRenderer.js\":\"7bb273e3e81a8d5d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/PropertySchemaBlockRenderer.js\":\"1ab81b05b1d96990\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/TopLevelRenderer.js\":\"57a754c352e580d3\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/blockGutterMode.js\":\"94d02ca1d2555a4b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/blockTitleText.js\":\"5d80882db4336336\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/fieldCreationKeydown.js\":\"09a9d2b45fcf90a9\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/layoutRootContext.js\":\"43d49a2bf5e6d96e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/typeChip/TypeChip.js\":\"baf6f69e72a2328e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/typeChip/chipStyle.js\":\"ba1926c34dc2569d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/anchored-floating.js\":\"495a69134bb420fd\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/button.js\":\"a08da6499cb7d773\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/card.js\":\"eab6539c6ac354f2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/checkbox.js\":\"306a1df5921add43\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/collapsible.js\":\"fe8d0da55225154b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/command.js\":\"19c45d28d736e419\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/context-menu.js\":\"8386f5b2435c3116\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/dialog.js\":\"b5a269534cf5c92c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/dropdown-menu.js\":\"5333a56a70a6f94f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/floating-listbox.js\":\"df91152b2fdc514e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/index.js\":\"3cfdef298f7dd01e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/input.js\":\"c26ba5eae23b2fad\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/kbd.js\":\"8da7301f18144d1f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/label.js\":\"35ffb02eceadae78\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/textarea.js\":\"d49b9c55c831a2cd\",\"/knowledge-medium/pr-preview/pr-1876/src/components/useEditModeYieldKeepalive.js\":\"06aad37c1343c770\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/BootFallback.js\":\"de6b02375edd7ba4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/FocusedRowLazyMount.js\":\"e4b593f83cdb6afe\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/LazyViewportMount.js\":\"dc76c7acf2d0cbfd\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/LocalDbCorruptionFallback.js\":\"072c5da1ee11f5f8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/error.js\":\"b60c6931a1553257\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/lazyMountRegistry.js\":\"b9eee5c3d0d24397\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/suspense.js\":\"642fce064f33caa6\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/CreateWorkspaceDialog.js\":\"b97da993feb24abc\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/PendingInvitations.js\":\"9cd371f8e8cf4d33\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/SyncProgress.js\":\"be8ec993a24542e2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/UnlockProgress.js\":\"684aa94c4bdde99b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceKeyGate.js\":\"2f1cccc1d2eedeb5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSettingsDialog.js\":\"927b6cfcd6446e3f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSwitcher.js\":\"3ba77cbea40f0545\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSyncGate.js\":\"942c0f5ac21a5954\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/ConversionFlow.js\":\"7646cc72b70b59fa\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/ConversionFlowHost.js\":\"c7ccd08d322b3d61\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/EncryptionSection.js\":\"b0bc77618f5e13de\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/attachmentPrompts.js\":\"a8a33eb910f03063\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0d2c8b855d01e1ea\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/conversionFlowDeps.js\":\"29e3011ef49350fe\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/conversionFlowStore.js\":\"b13efa9d5223801d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/flowUi.js\":\"ca02c4b7f1d75cfd\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/useConversionRun.js\":\"239a7a380cdbcc83\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/keyUi.js\":\"f07cf1d4a7727585\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/useCloseOnKeyLoss.js\":\"4c2899999902b2ae\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/useCloseOnServerE2ee.js\":\"86e2fca13023b2b5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/workspaceUnlocked.js\":\"52b63e437e42d72c\",\"/knowledge-medium/pr-preview/pr-1876/src/context/backgroundSubtree.js\":\"f85f1a930a940e8d\",\"/knowledge-medium/pr-preview/pr-1876/src/context/block.js\":\"ccc6a203cab11954\",\"/knowledge-medium/pr-preview/pr-1876/src/context/layoutWsContext.js\":\"346949e22b23c1bd\",\"/knowledge-medium/pr-preview/pr-1876/src/context/propertyDisplay.js\":\"d298e7291004baa9\",\"/knowledge-medium/pr-preview/pr-1876/src/context/repo.js\":\"765b33b8fd96de81\",\"/knowledge-medium/pr-preview/pr-1876/src/data/aliasClaim.js\":\"01194904c7367a6e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/aliasSeatNamespace.js\":\"17f5920933853b32\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/blockData.js\":\"4a2de7838a03bb59\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/blockType.js\":\"5c0a93a928c40801\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/changeScope.js\":\"a132f391c5e3548b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/codecs.js\":\"c612bb995e06f959\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/derivedData.js\":\"0cfdb66bbd20cc43\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/errors.js\":\"f11d71c6a3a56a45\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/events.js\":\"c3987fe5a8140d2d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/handle.js\":\"751de15e3a4cf143\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/index.js\":\"3fa14599e374de34\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/mutator.js\":\"5813f762a331c035\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/processor.js\":\"0e4b370e58c63852\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/propertySchema.js\":\"7a1aca7b1cb70252\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/query.js\":\"1bc2c97fb5e23a4f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/sameTxProcessor.js\":\"441f518a00ec2752\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/schema.js\":\"751de15e3a4cf143\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/tx.js\":\"751de15e3a4cf143\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/typedBlockQuery.js\":\"f2dc0d05fce40cab\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/user.js\":\"d81a46893a546665\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/valuePresetCore.js\":\"cccdf5154c4b9b59\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/valuePresets.js\":\"758ff96636e6e9fd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/attachmentCleanerIOVerb.js\":\"3338cd8ef393a6ed\",\"/knowledge-medium/pr-preview/pr-1876/src/data/block.js\":\"cd8d0a78c37e1cf6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockCache.js\":\"7ae214b69b05dbc6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockId.js\":\"0a1a4a1295fb4058\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockLiveness.js\":\"e9d79694c48e8a4b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockMerge.js\":\"49533a4cd0580638\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockSchema.js\":\"4620b5dc132669b3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockTypeLookup.js\":\"c4938e289c41c603\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockTypes.js\":\"8e4e4ae350d59908\",\"/knowledge-medium/pr-preview/pr-1876/src/data/childrenView.js\":\"56fb8eb7b967a470\",\"/knowledge-medium/pr-preview/pr-1876/src/data/clientContext.js\":\"8df358d02921878b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/dbFileSiblings.js\":\"01efabfef71a1cbb\",\"/knowledge-medium/pr-preview/pr-1876/src/data/definitionSeeds.js\":\"0e67cfc93dfe5850\",\"/knowledge-medium/pr-preview/pr-1876/src/data/derivedIds.js\":\"0c9ec4c67c727029\",\"/knowledge-medium/pr-preview/pr-1876/src/data/drawnSubtree.js\":\"f55cec86ed574989\",\"/knowledge-medium/pr-preview/pr-1876/src/data/facetBridge.js\":\"ce016f4511584e74\",\"/knowledge-medium/pr-preview/pr-1876/src/data/facets.js\":\"58c74c474652af68\",\"/knowledge-medium/pr-preview/pr-1876/src/data/globalState.js\":\"e3b6f5ddaf282001\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/aliasClaimRederiveProcessor.js\":\"8098db4fedb0bbbc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/ancestorBatch.js\":\"a86f746219d9e773\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/blockTypeTypeifyProcessor.js\":\"5e40080b05c8a5e8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/clientSchema.js\":\"26a5b8634cfba31b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/commitPipeline.js\":\"931e4fb4e3ddabaf\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/devAssertions.js\":\"1f19ca5cf3b38328\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/firstSync.js\":\"87c1c1dcfdc7614f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/freshInitialLoad.js\":\"1be2af085d046337\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/graphBackfillClaim.js\":\"099bbc29b22f974e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/handleStore.js\":\"c1e01b75b75a41c4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/idleMarkerJobs.js\":\"0791f2b90da13704\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/initialDownload.js\":\"161859847868f499\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/initializeClientDatabase.js\":\"de9d3f09831985b4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/jsonCanonical.js\":\"8ebcc37edb291e8e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelInvalidation.js\":\"1f10ea6837e2c90c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelProcessors.js\":\"1b178d329f9cf961\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelQueries.js\":\"16702d0eb57b0910\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/mergeTypeMembershipProcessor.js\":\"d708d094dabe129c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/normalizeReferencesProcessor.js\":\"78b91d3f07253cd0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/poolInstrumentation.js\":\"c1ea65d710dbb320\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/processorRunner.js\":\"ea7a1faf7065e09d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyCellBackfill.js\":\"b243c1ea17d1821c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyChildMint.js\":\"19e0c50d422cbb21\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyChildrenProcessor.js\":\"336193314276e9a8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9140b46d630e91e0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyDefinitionSynthesis.js\":\"984902acfa062bce\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyKeyScan.js\":\"77a4db3c6f44059b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertySchemaResolution.js\":\"d3a18248886f67d0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyValueEdits.js\":\"65f07fd9d6bb2f08\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/raiseProtocol.js\":\"870530f123352d9e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/readBatch.js\":\"98a5ecfe61022129\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/refProjection.js\":\"11d89e96818e9913\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/referenceTargetLookups.js\":\"d15a0dfddfa0939e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/referenceTargetProcessor.js\":\"6a74575f349ee378\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/replayMerge.js\":\"f94340982f9dba63\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/sqlBinds.js\":\"9424092eacdc190f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0c45a09fcc9a61dc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/arrivalProcessors.js\":\"b812a0bbb79d949d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/invalidate.js\":\"99f81093d5ebf5f5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/materialize.js\":\"efbd63dcc6e99ef9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/observer.js\":\"0e002aba21aa5ea8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/reconcile.js\":\"a7b7c0f5b941a23e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/timingMetrics.js\":\"e8a62a811aa8a7ba\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/treeQueries.js\":\"a4476314325c8022\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/txEngine.js\":\"74ee033a97926417\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/txSnapshots.js\":\"d0fd22b7a7b65a4c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/typedBlockQuery.js\":\"eab65d2142fd0f3e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/undoManager.js\":\"450b4eeb4cfd1a7d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/invalidation.js\":\"c55eadcdae7a0137\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelDataExtension.js\":\"d5874937b0c7a58e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelPage.js\":\"b229d08eb52c93b1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelValuePresetCores.js\":\"e2da760c2d4420f2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbCorruptionSignal.js\":\"cea8aac53574d9f4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbStorage.js\":\"4e779967e9da78e7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbVfs.js\":\"d2fa14ed3894fd8f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localSchema.js\":\"d5a7e5a9b8268e76\",\"/knowledge-medium/pr-preview/pr-1876/src/data/maintenance.js\":\"f2d99dae6d80e925\",\"/knowledge-medium/pr-preview/pr-1876/src/data/mergeProperties.js\":\"34f394889e6d3a96\",\"/knowledge-medium/pr-preview/pr-1876/src/data/metricsConsoleHook.js\":\"185e2279bc5ba384\",\"/knowledge-medium/pr-preview/pr-1876/src/data/migrationsPage.js\":\"caf72168a712b42a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/mutators.js\":\"df2e4e8f5de93006\",\"/knowledge-medium/pr-preview/pr-1876/src/data/orderKey.js\":\"139dd7a23a0560b2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/orderKeyPlacement.js\":\"742272a0f51d301f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/outlineSurface.js\":\"ec95249bda13a949\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pendingEditorContent.js\":\"a5bb041a45f2c2ba\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pendingUploadsSql.js\":\"ccc59daff5cbedc9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pluginStateExtensions.js\":\"e1d330f8638dd4f0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/powerSyncLogger.js\":\"ae1bafc93da45880\",\"/knowledge-medium/pr-preview/pr-1876/src/data/projectorRuntime.js\":\"5223e5aca9b5bd53\",\"/knowledge-medium/pr-preview/pr-1876/src/data/properties.js\":\"a74448df30b00531\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertiesPage.js\":\"46a6000f7f977bab\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyChildren.js\":\"2e58216fbd6bb5ab\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionFanout.js\":\"e49ef9a49c71dd1e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionMetadata.js\":\"6cc82dbfe959763f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionRegistry.js\":\"4bc07be8be21c94b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDisplayMode.js\":\"653efa3c42f8fc0d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyRowCreation.js\":\"94047d10393fa1fc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertySchemaCreation.js\":\"85ea81ecf0cf9e95\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertySeeds.js\":\"6a4eee876eaed398\",\"/knowledge-medium/pr-preview/pr-1876/src/data/recentsPage.js\":\"2b1ff59f0e46c1e8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/referenceBlock.js\":\"d2f0f0ceab7d4037\",\"/knowledge-medium/pr-preview/pr-1876/src/data/rejectedUploads.js\":\"cb8a67132bd89601\",\"/knowledge-medium/pr-preview/pr-1876/src/data/releasePowerSyncConnection.js\":\"f8fd8f059f96c44d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/repo.js\":\"80b6b4320286198d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/repoProvider.js\":\"bd8cc88c3d839318\",\"/knowledge-medium/pr-preview/pr-1876/src/data/rowProperty.js\":\"9fa8d798ce6df895\",\"/knowledge-medium/pr-preview/pr-1876/src/data/searchFilter.js\":\"007ee6f1e61ea94c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/seedIdentityLedger.js\":\"89027aeea0791b15\",\"/knowledge-medium/pr-preview/pr-1876/src/data/stateBlocks.js\":\"e48392dbeee0d624\",\"/knowledge-medium/pr-preview/pr-1876/src/data/structuralEditPolicy.js\":\"b14914a231b04b91\",\"/knowledge-medium/pr-preview/pr-1876/src/data/structuralInsert.js\":\"df9b362c76440c78\",\"/knowledge-medium/pr-preview/pr-1876/src/data/subtreeDelete.js\":\"2c9ebd5b2ad1da87\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncStreamLock.js\":\"e2a025b36a2fbc1e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncedTableSqlRecognizer.js\":\"bc61a6b39c6d1f88\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncedTableWriteGuard.js\":\"ed5e2057cf41fc3d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/targets.js\":\"d16ff4379549b11c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeColors.js\":\"671eb8f34846753d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeDefinitionMetadata.js\":\"f7e340d7103ac09f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeDefinitionRegistry.js\":\"2e5ccdccfb336690\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeExtraction.js\":\"0b358f95c2b5490c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeInitialValues.js\":\"127b253d4127d71e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typePropertyGroups.js\":\"a5c8b95655dbf82e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeSeeds.js\":\"435a69df8e8ed662\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeTagger.js\":\"bf5240e918c20d86\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typedRecords.js\":\"aac8a8f6c877f69a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typesPage.js\":\"21180d9d2a5548e3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userPrefs.js\":\"966baccd13489707\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userSchemasService.js\":\"90b96e8110726e58\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userTypesService.js\":\"4a5df0398b3e5294\",\"/knowledge-medium/pr-preview/pr-1876/src/data/valuePresetRegistry.js\":\"0b2a1bdadd542ac4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/visibleChildren.js\":\"7524036df066a69e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceConversion.js\":\"c544ab5d3409a4e1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceFirstSync.js\":\"2fa18d84c92aaf8b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceIdNamespace.js\":\"9c2a19412380ca8d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceSchema.js\":\"24f321af8dbf828a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaces.js\":\"0389096316c196cb\",\"/knowledge-medium/pr-preview/pr-1876/src/data/writeAheadLog.js\":\"2ff98500c9f0b75c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/BlockPasteShellDecorator.js\":\"25a8b1925e4ebba4\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/atTrigger.js\":\"0d33fc517956fa30\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/autocomplete.js\":\"aa978add546e9c2f\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/codeMirrorExtensions.js\":\"256ff9304a79a5d9\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/contentFlush.js\":\"5cfdba87fafe45b9\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/defaultInteractions.js\":\"47c4defa36f8b0f2\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/editSettleSignal.js\":\"bf204532efd33c03\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/insertImage.js\":\"723d3ad0e2088dbe\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/referenceCompletionRange.js\":\"80c791535ae14421\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/referenceTargetTypes.js\":\"34f863af28b73bb5\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/syntaxContext.js\":\"e8ca7683be37a674\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/triggerMatch.js\":\"778610cf2e8a5d93\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/AppRuntimeProvider.js\":\"d56862896d265a13\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/BlockFocusShellDecorator.js\":\"0b2b7205d9db5695\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/ExtensionRenderBoundary.js\":\"63290b70a0c3596e\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/PanelContentRecovery.js\":\"8168654c9b2df285\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/apiCatalog.js\":\"e97c437bf10c1ff6\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/approveExtensionHere.js\":\"15e2aa1f4e5e15ea\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/armedCutAppMount.js\":\"3dff650264263367\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/batchableKeyedStore.js\":\"cdc6e28df5981391\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/blockInteraction.js\":\"8a49244af4c68e59\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/blockSelectionAction.js\":\"439dfc21db50ad8f\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/compileExtensionModule.js\":\"447b5ff951024158\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/compiledModuleCache.js\":\"8a3a9bfd5fb6f7e7\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/continuousGestures.js\":\"12042889e93ed901\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/core.js\":\"607573d62da96336\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/defaultRenderers.js\":\"7b988da79d98f340\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/definitionFanoutAppMount.js\":\"9c618259aceba93c\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dialogAppMount.js\":\"fd081c0e98347f60\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dynamicExtensionSeeds.js\":\"ceaeae780d41c30a\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dynamicExtensions.js\":\"74377861d3037f97\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/exampleExtensions.js\":\"c7740cebf12a8429\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionApprovalStatus.js\":\"16de7170e598aa55\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLoadErrorToast.js\":\"0ab247e7bc94bfee\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLoadErrors.js\":\"c0561bf612fb973f\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLookup.js\":\"f78fe0661c053197\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionToggles.js\":\"6b56f5e886262f4e\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionUtilitiesCss.js\":\"7f28433c2d0edeca\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/kernelPageDeletionGuard.js\":\"1749ab4c34474ef1\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/liveRuntime.js\":\"5b407451d8e91a88\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/openExtensionsSettings.js\":\"9fd6582c1f0a523a\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/overridesCache.js\":\"8cbd839dccddf203\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/pluginIds.js\":\"88d668fd38707763\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/processorRejectionToast.js\":\"7025092ed3eda8f6\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/runtimeActions.js\":\"b44cb5012ffbdd29\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/runtimeContext.js\":\"334091dd032c4de9\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/staticAppExtensions.js\":\"c7bda855205ec1da\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/staticDataExtensions.js\":\"4faf27b8236b55bb\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/toastAppMount.js\":\"944099cc2cf8b408\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/useOverrides.js\":\"d3fce8a34809e14c\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/useShortcutSurfaceActivations.js\":\"f8a957ea1cd428c1\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/discoverToggleTree.js\":\"818dcf79663227fe\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/facet.js\":\"7b36ce2efe49b3c0\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/resolveAppRuntime.js\":\"d578b012eb797174\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/runtimeEvents.js\":\"097c3465434f6849\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/togglable.js\":\"63e96721af6c838d\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/variantFacet.js\":\"034bf5e5a6b7d970\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/verbFacet.js\":\"01e47847dd662508\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/block.js\":\"43bb6a74e333867e\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/focusedChild.js\":\"11df0e740a168899\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/propertySchemas.js\":\"eeada3ce06e58e42\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/typeRegistry.js\":\"fc97a3c7d8538548\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useAncestorCrumbs.js\":\"e152dd6edeafc3ca\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useAutocompleteListbox.js\":\"5b5913fc108a32d6\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useDebouncedSearch.js\":\"a5bc8e662b7ac8fe\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useDebouncedValue.js\":\"764ae8bc1da948cd\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useIsFocalRender.js\":\"0acd1868be0b6e10\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useIsReadOnly.js\":\"9bfc59324bbd6a26\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useMaterializeBacklog.js\":\"dab127c6075acbe8\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useMinuteClock.js\":\"0af27fe12f57a203\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/usePanelLayoutProjection.js\":\"340ec7fc255075c1\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/usePendingInvitations.js\":\"acdc059eccc728d7\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useRendererRegistry.js\":\"bded491e27a6f2d7\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useRetainedFieldRows.js\":\"169cdb3ba572f26c\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useWorkspaces.js\":\"e7f3fa2dab1c1d71\",\"/knowledge-medium/pr-preview/pr-1876/src/lib/utils.js\":\"17c74df7c3c69d37\",\"/knowledge-medium/pr-preview/pr-1876/src/main.js\":\"ba9312514407d634\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/MarkdownImage.js\":\"1580419f212b4fbc\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/blockSeparators.js\":\"f11939c1fcd88798\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/context.js\":\"528d8dbb2c0c0567\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/defaultMarkdownExtension.js\":\"963b72b916a5c182\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/extensions.js\":\"52e03e144f76b23c\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/renderMarkdownHtml.js\":\"1a971ee2da6e0e14\",\"/knowledge-medium/pr-preview/pr-1876/src/minimal-editor.js\":\"5cd605d1304b027f\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/armedCut.js\":\"bae2a0a8dc0ae583\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/captureMediaVerb.js\":\"e3422b251890bd2e\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/clipboard.js\":\"40aa116b95364b53\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/decision.js\":\"1ebcf0b59895e120\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/operations.js\":\"13018dbb5ce420ab\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/account-header/AccountHeaderItem.js\":\"9c0e5eafaa92c8f4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/account-header/index.js\":\"0c9afcdf3e18b4b4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"1bf483c2c26d83a5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/askAgent.js\":\"3c29784d1169bec5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/askedStore.js\":\"1ed120a9024abcf8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1fab24d5ef65199c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/chipState.js\":\"2434b961f2ae4580\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/dataExtension.js\":\"0f69b269dafc1564\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/index.js\":\"8c2795687ebba5cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d51bf826b9f4cc07\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/schema.js\":\"c89cbb7d428f42e3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/AgentTokensDialog.js\":\"f3717cf57e96a6d7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a9134dabb8170d3f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/addMedia.js\":\"dd54cdb6312e6a6c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/backlinks.js\":\"ff4c2e9daa30ebfa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/block.js\":\"adba78d5d82defc1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/context.js\":\"bdd0981dd281e56f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/displayIds.js\":\"019c8d9a7a4354aa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/index.js\":\"87b0f69e5ce8fd17\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/outline.js\":\"a80e3117684e93a1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/properties.js\":\"521d3df700fcdce8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/refs.js\":\"2999819d6ec2a34a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"8f26205212446676\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/search.js\":\"cac41da3106f937f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/shared.js\":\"f21a0e706f07a870\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9e1aafcf51920ec6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/text.js\":\"09e9ed7de9208434\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentWrites.js\":\"a8ca834facf24ed8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/authoringCatalog.js\":\"dbb13a56acd1534c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/blockRefTargets.js\":\"c974778c316daaf7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/bridge.js\":\"5504f79f3868de03\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/bridgeLoop.js\":\"bba2e7bc9096a6ff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/changeHistory.js\":\"e71fd0e8c0b199bb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/commands.js\":\"496e6d6a02bbc208\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/commentsCommands.js\":\"bf47be9169bf301f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/dataExtension.js\":\"233e8aad4999573f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/dataModelGuide.js\":\"7d7959ac80d66479\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/describeRuntime.js\":\"811e8995c3652a7f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/extensionLint.js\":\"64e093c3c09315d7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/grainAudit.js\":\"a99864927ebf1685\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/healthCommand.js\":\"5c5288627ad0782d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/index.js\":\"a776e34b408b74f8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/presetIdentity.js\":\"7a06db92ba58b39c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c4fd62de24fdce25\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/readMedia.js\":\"1806dea8cfbe6664\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/schema.js\":\"be0255b77c740263\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/serialization.js\":\"59faae8cfda7616d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/targets.js\":\"9305d98c424d9789\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/tokens.js\":\"ebe53759ef7ffcd1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/watchEvents.js\":\"276dc799b3bf15da\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/workspaceGuard.js\":\"ae76a36122086cf1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/writeCommands.js\":\"280d4b6060738026\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/AliasCollisionToast.js\":\"3c25202b23174f4c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/DuplicateNameBanner.js\":\"a8a6fb9a29d23868\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/collisionMerge.js\":\"75080cfd7e32666f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/dataExtension.js\":\"8d396167cc091df8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/index.js\":\"dc8a5d06b18cc7c7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/mergeCollisionAction.js\":\"ffae8187f9c3f286\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/pageStyling.js\":\"50b7bcac23272998\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/rejectionToast.js\":\"cbb33c40c1eba130\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/syncProcessor.js\":\"3c8673bc8f7c5ed0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/actions.js\":\"41431d3bff780239\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/addComment.js\":\"741ea8258652aa46\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/anchor.js\":\"c03b2ddd86437316\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/anchorState.js\":\"fc96acdd55d88e33\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/commentLinks.js\":\"3f27f1c5fdaa64d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/confirmThreadDeletion.js\":\"86b140f5950bf4c0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/container.js\":\"ccecec010b26e73a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/dataExtension.js\":\"fe54d824f61908da\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/deleteComment.js\":\"43fdf718668454b7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/highlights.js\":\"c80987926a88ffec\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/index.js\":\"f97dae2e5533a5cc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/linkedCommentsPill.js\":\"fb6e50f0fd67539b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/margin.js\":\"4966c6094dbc5d67\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/marginAnchorLinks.js\":\"4554be5a2e0bb115\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/marginSchema.js\":\"cfec44a2989aa4ae\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/newComment.js\":\"7cd49b135713563c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/ownThreadPicker.js\":\"f1c9c4899571d791\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/placement.js\":\"8fdf0fa519a99306\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/queries.js\":\"3e661bf4b0fddf78\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotePosition.js\":\"3d98df22c34f60c7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotedIn.js\":\"92e491aab29914f6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotedRange.js\":\"b59c5a6bdd690f90\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/rangeRefs.js\":\"9781801423c3462f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readHighlights.js\":\"0348b199afc4279b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readSelection.js\":\"266196cab2c76aa8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readSelectionUi.js\":\"33799220a8348a11\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/reanchor.js\":\"350c15d0e81037b1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/schema.js\":\"7ddbcb151315b654\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/scope.js\":\"4376ed9f121c9c66\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/scopeThreads.js\":\"646846f7a434ea4b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/splitRetarget.js\":\"0b23cb85b3100c9e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/suggestionCard.js\":\"f04552f459a71769\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/suggestions.js\":\"1a7659a346121baa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/summaries.js\":\"45daf20b74ead506\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/summaryBatch.js\":\"6a25cb93c963ad79\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/surface.js\":\"d944d2bd14cd2b7c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/threadNavigation.js\":\"6a079c82473148da\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/threads.js\":\"31e80d440a97524a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/ui.js\":\"25423ca57041138b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/uiStore.js\":\"61203f1bf224f72d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-intents/appIntents.js\":\"5b4c1834b4300967\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-intents/index.js\":\"36f92df65a1dd7ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-update-prompt/index.js\":\"457632c34b0410ca\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-update-prompt/status.js\":\"e235927578aab649\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"69e7cb5f7c5593fb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaBlockRenderer.js\":\"5e0783118ffd4ce9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaDownLaneReplicator.js\":\"3b98db4feb1b69aa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaUploadReconciler.js\":\"f3ce25fa6305b8ed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetDownLane.js\":\"3b530932d83581de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetResolver.js\":\"4022f342a23da796\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetUpload.js\":\"82901811a2dc9b25\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/attachmentCleanerIO.js\":\"91da3b193fe86d22\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/supabaseAuditIO.js\":\"ebd9b5cee32c6efb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/blobStore.js\":\"eb5c7ed4fcae1e02\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/browserMedia.js\":\"02ff4bb09679c5ca\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/byteStore.js\":\"9ea8e103ed916527\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/cleanerIO.js\":\"45a29ab996875885\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/cleanupAttachments.js\":\"dc71a3d01aabd531\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/dataExtension.js\":\"b254b63f5eb6643b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/downLane.js\":\"d81dd8224c591615\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/index.js\":\"a6042e3ec28651a3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/insertImageContribution.js\":\"07cdb5d47b494214\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/laneArming.js\":\"c631f2b3b87e27e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/laneLock.js\":\"81186d567e822322\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaBlock.js\":\"4fccf87583cb411f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaCapture.js\":\"f726fac54617cd04\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaLanes.js\":\"0296628d13eaa089\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaViewers.js\":\"aa9a8c42b8a854c0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaViewersFacet.js\":\"be2683481b7aef0a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/pasteCapture.js\":\"70424adc6bc327b7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/resolver.js\":\"065398aedf069d33\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/retryUploadsAction.js\":\"d6098529eaea40b4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/storagePaths.js\":\"7c36a09b565a172c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadDrain.js\":\"781e9b4fcfe92837\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadLaneStatus.js\":\"14e4988a8c2f8ccb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadReconcile.js\":\"c9e578d7ec5dd8ec\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadRecovery.js\":\"b7e33a887fa0792a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadStore.js\":\"956fb38b1337a0e6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/useAssetObjectUrl.js\":\"3f8c88303972228f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"19210e4373c475c3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5a29185318d29d7c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/facet.js\":\"2a93988e80ec61d3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/index.js\":\"e59174140014f184\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/prop.js\":\"0e2503672efa8080\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BacklinkFilters.js\":\"f475beabbcf8acdf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"bc001cc49d5fe98e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BlockEntry.js\":\"903f3a560cc6f1ee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/LinkedReferences.js\":\"19fdb7f161ced757\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"986e6b9d44eb5173\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/dailyNoteDefaults.js\":\"bbb4c103a0bd7d31\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/dataExtension.js\":\"21fcb6b3c54ddc22\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/edgeExclusions.js\":\"972bc2ade2605abb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/filterProperty.js\":\"33a9e8ca071d5215\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/index.js\":\"fb9d0ade29f4a153\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ea05ca91eaada155\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/applies.js\":\"5492ea2b926a876b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/countQuery.js\":\"f2321df0c809acce\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/expansionStore.js\":\"50565b8da0f35db4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/index.js\":\"d103ec1a2a1f4e40\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"2e1fbdabccf151cc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/presentationInvalidation.js\":\"1cee3a28dceba8e4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/propertyEditorOverride.js\":\"617db1982e646bd5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/propertyFilter.js\":\"4a72b93ad3e7f9f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/query.js\":\"1d3ce45f3999ac4b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/resolveFilter.js\":\"ef0829a70f176604\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/sourceBatch.js\":\"593bbc8b23971da3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/sources.js\":\"c5c155cd85944f6e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/useBacklinks.js\":\"ec27dc2c562b90d9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"fdaa110f13fe827a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/BirthdayCelebration.js\":\"719820c3afc3ab2f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/BirthdayOverlay.js\":\"a4046067f1fe1440\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/gate.js\":\"c591fc2042707ef9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/index.js\":\"6daedaf71333669b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/wolfTheme.js\":\"19e6ef8aed6a1d97\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/BlockDragLayer.js\":\"31da67dd851c312a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/dragController.js\":\"bd24bb48a6ce220e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/dropTarget.js\":\"5ff460746f6ff31a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/index.js\":\"a2e2cc07718edd38\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/projection.js\":\"aaf5c493c461f313\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-info/BlockMetaCard.js\":\"bac711095e430440\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-info/index.js\":\"500ebb33e4309d75\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/AddTagDialog.js\":\"459409270ad36839\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"8a0ab4b7d97480bc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/TagNameIssueHint.js\":\"81e1c5d396b1bbac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/addTagAction.js\":\"36cc402530876d49\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/appendTag.js\":\"bcac5a5a623697f6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/config.js\":\"d33ec79c6ee10f65\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/dataExtension.js\":\"3261123e1bc68a71\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/index.js\":\"be006a7c5e45211b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/propertyEditorOverride.js\":\"c11dd0f7541f5a0f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9b7b47c0a43fabe6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"f3f401600a284010\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a04f7c4d217d8d02\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"34535fe47d5679f3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ea0feda464a1433e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/index.js\":\"1fa5841870fa80a2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"383bb4178e90d735\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/CharacterCountItem.js\":\"8e2ce2091a3ed0b1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/ProfilePropertyEditor.js\":\"2cb5e55d769e9773\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/actions.js\":\"f78924d3d22e6918\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/blockType.js\":\"34ab91791ec87496\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/charCount.js\":\"9c0e391444ca66c7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/dataExtension.js\":\"4b8e638bb57f8e99\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/index.js\":\"f2c7828a6bb72e53\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/profiles.js\":\"b95c5fe673bbb306\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/properties.js\":\"fe839e9873de1cd2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/textCounts.js\":\"6d1086301826ee3b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/colemak-keybindings/index.js\":\"1befc4a6b8584adc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/CommandPalette.js\":\"8759eb854dbf9d8e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/HeaderItem.js\":\"4e9bfce0c990adea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/context.js\":\"b47f8716ebcd78cf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/index.js\":\"277ca1ece7814585\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/selection.js\":\"76da0dd683e0b8c9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/toggleStore.js\":\"eb8d8ce17ae479f0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/useCommandPaletteActions.js\":\"34cb9e99b53f0e77\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/ContributorBadges.js\":\"0ee425766224211f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/author.js\":\"6a561d9baa1e475d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/codeMirrorExtensions.js\":\"119b653b50b55b18\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/dataExtension.js\":\"f221c5b26473d324\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/index.js\":\"7da3ae58db65bceb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/mentionAutocomplete.js\":\"11daf18ee9e2e5c0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/processor.js\":\"55dd1c185c748043\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/profiles.js\":\"f939b48f955d0e5d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/queries.js\":\"feb1f17106ecd2e6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/schema.js\":\"77916bc052746048\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"427774141252f74c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2dcb16d492a648c2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/index.js\":\"bcb4b48a8e9e9651\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c94ac20a0dc106d7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"aede79b00628fba2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/CalendarGrid.js\":\"93876944457739f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DailyNotePicker.js\":\"b9428b134bb83e12\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"d54744a2e51dfa7f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateNavDecorator.js\":\"1012ce322c16bc61\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateScrubOverlay.js\":\"7b890f4e998bb3d7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/HeaderItem.js\":\"5d412ba08992cfd2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/ReschedulePicker.js\":\"9dd0b14cd298a892\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8cf9678baa857353\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/actions.js\":\"64510f13edee2dfb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/blockDateAdapter.js\":\"d86c5f79b1402a50\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/calendar.js\":\"8d17d2f6337a0a6c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dailyNotes.js\":\"214461e0b9fcc4a3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dataExtension.js\":\"d1b66057668bce8a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubActions.js\":\"21ad7de851ce612f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubGesture.js\":\"1a45e1990361a02b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubGestureActions.js\":\"94773f57704880fa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3dde206a62f6a901\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/deletionGuard.js\":\"efeacd9970c8fa7b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dueQuery.js\":\"c328c0b15d455c4d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/index.js\":\"1293510cbda3415e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/landing.js\":\"50c54b9a9abb9a50\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/localSchema.js\":\"ccb88f83c3ed47c5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/referenceDateAdapter.js\":\"d6c2fa3d46333645\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/rescheduleAction.js\":\"820bbe5c56bc48de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/schema.js\":\"58aabdbaad500856\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/spreadBlockDates.js\":\"d613cb7a7e3dc94d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/spreadDatesAction.js\":\"56606f4f92acde8c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/today.js\":\"9bd5e12712272f25\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"387c2cc0829328d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f90a8a1196d54cf9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/audit.js\":\"c92c220b318154cb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/auditAction.js\":\"a2891a59d07445b7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/auditRanges.js\":\"47be2ec2207acfb5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/diagnosticsSource.js\":\"69117021bf5146a8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/divergenceScan.js\":\"c8109c2db2383d32\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/index.js\":\"d7a5f5b4e065a306\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/propertyChildrenChecks.js\":\"ad5b98cda2bdcddb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/referencesMirror.js\":\"71719c5dec9b49f2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/rowJson.js\":\"f996065637fd79ed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/schedule.js\":\"48b866aabb819d0d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/store.js\":\"2bacabcaec714e3c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/action.js\":\"9cd0cc4e7269e7b6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/index.js\":\"90d2c53d8204b226\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/plugin.js\":\"730423fc3a0fad22\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b2527cfabf0e41bf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/actions.js\":\"1959b289a60688bb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/changeMarker.js\":\"fd9488e8c380e542\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/diagnostics.js\":\"02e6624e4e517ceb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/fileSystemAccess.js\":\"9a9e0d5cb2b71f8b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/filenames.js\":\"ac434b67fdfa62cc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/index.js\":\"223aa0d17a9aff63\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/mirror.js\":\"0c8f0ebc2ba430c4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/runLock.js\":\"45d46139179e2b5d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/runtimeHealth.js\":\"f1133b535198bbc6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/schedule.js\":\"9bcab5b816094330\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/store.js\":\"be29cd8a820a9290\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/default-themes/index.js\":\"ddd0d1bf7970cfad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/default-themes/themes.js\":\"2a16cfd43d409e23\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/diagnostics/facet.js\":\"19acad66fd66bc6d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/diagnostics/useDiagnostics.js\":\"d38512c0833fb415\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/dismissals.js\":\"f4e1f22f6f8c7319\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/index.js\":\"2a9f0f830e87ae29\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/status.js\":\"1bc13fa0cd22833f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/store.js\":\"4f339726e6a9c8fe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"304c33b9e6758e3e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b5e3594e195f5251\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/actions.js\":\"64cb01e4115d5f06\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/config.js\":\"b63ed0d81183fc70\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/dataExtension.js\":\"8f4682af6acb00bb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/effect.js\":\"93a1393675fb5f39\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/index.js\":\"203df3f1f9d084a2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/propertyEditorOverride.js\":\"aa2116bec75efd3d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/useToggleTree.js\":\"defbe323b6e8ab54\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/ExtractTypeDialog.js\":\"34a6560e5af9d5b0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"40ca8c0ace94f9fd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/PropertyShapePicker.js\":\"36d77804a2db712f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/action.js\":\"d9e19ae5d35059eb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/index.js\":\"71c0afc8e0d080e8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/FindReplaceDialog.js\":\"f04c7a3e10f025b4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/HeaderItem.js\":\"ec92e40187d73741\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/dataExtension.js\":\"fd308a0bbd72b0eb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/index.js\":\"82ce5998782e8931\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/search.js\":\"6a7b67c06f3a7bed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/toggleStore.js\":\"2d9a66ef33303ba5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/LocationPropertyEditor.js\":\"431b1828baa75963\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/MapView.js\":\"35e725cd561b7dbf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/blockTypes.js\":\"f6d171f182b5786b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/codeMirrorExtensions.js\":\"d115e04393135ddf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/createOrFindPlace.js\":\"dc889835c10c9300\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/currentLocation.js\":\"a1bb935978281c3d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/dataExtension.js\":\"dbe07ab849169eaf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/geoContentDecorator.js\":\"f125a18dd08d0628\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/googlePlacesClient.js\":\"f15786ba5746c5bf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/index.js\":\"25ecdfeb4144432f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/locationsPage.js\":\"40c9232067ba587e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/mapViewport.js\":\"25053cb80a992250\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/pickCurrentLocation.js\":\"a8afe664738a7a14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/placeAutocomplete.js\":\"a3c501b9d57eedf7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/placeNameCollision.js\":\"0c9d3ca21c3f65e2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/properties.js\":\"86ef56ee1e947463\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/propertyEditorOverrides.js\":\"112b5d9ddb865db5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/query.js\":\"db9969127dba0bb1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/usePlaceSearch.js\":\"0f6217d4f08d8ec4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"8d0635bd56b024da\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d57eb454d21d4559\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4e1a0500b4e8ebbd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/config.js\":\"ad6bce8274a846f0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/dataExtension.js\":\"bac16a60fd7f61d1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/facet.js\":\"2364aae281f4d5ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/grouping.js\":\"85164099150c85fd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/index.js\":\"386c2c4f8873ac6e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b572606f2b398acc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/query.js\":\"7da8189be79b1412\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/resolveConfig.js\":\"85a636411369abab\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9b8522dac8b18da7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"918a0489438be387\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/HtmlDocumentContent.js\":\"332abe9a7b28ca5f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/HtmlFrame.js\":\"a3f49086acf8bc82\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/actions.js\":\"dd9e3f6dd17f4bf4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/blockType.js\":\"619a428641cd3177\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/confirmRunScripts.js\":\"29e02db010efd2ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/dataExtension.js\":\"e02b77ec214b5ca9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameAnnotations.js\":\"e9d16eba937a4ad8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameDocument.js\":\"b69c4e41297dd280\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameTheme.js\":\"4b907c253b117eeb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/index.js\":\"3bd74590b01acb22\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/scriptConsent.js\":\"41002998fa4bea5e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/sourceMap.js\":\"9c3d0df493ab8902\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/useDocumentScripts.js\":\"546b780d0258ec6f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/index.js\":\"df7635ff8a5efdb7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/record.js\":\"d694b2f3d7bfe954\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/recordStore.js\":\"142fa1fb5c5ea90a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/responsiveness.js\":\"a93f8ccd085b36b1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/schedule.js\":\"17224721e3360c6a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/sessionContext.js\":\"5e4055f8e96f66a7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"64f87c4a9896e2a4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"4ce5f5bdb3318d48\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/actions.js\":\"56b1c2dfdb9290bb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/config.js\":\"eb4de1553cbf95fd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/dataExtension.js\":\"e84282b5570a0c46\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/effect.js\":\"409dde92c976d73a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/index.js\":\"8f3ff7638034197a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/keyCapture.js\":\"dde7dd49e43ca018\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/overrideStore.js\":\"b6c4adb197318a45\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"87eb6fdb28b503c9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/HeaderItem.js\":\"810bc6fa0a7bb438\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/LeftSidebar.js\":\"713d9fbabadad060\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/actions.js\":\"42599be6fcb9390c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/facet.js\":\"87bf8464fd14a0b7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/index.js\":\"70d68b69ee30a57d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/shortcuts.js\":\"b294f9144f2a2153\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/toggleStore.js\":\"f15dc1f67be253c8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/MergePicker.js\":\"69886763b04e12d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/index.js\":\"f1120ba8717ec719\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/mergeAction.js\":\"640560e322d458bc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/strategy.js\":\"6acb8354eed39e5e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/Button.js\":\"cce655dcb3a96383\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"f280788034e9d0ca\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e6a90ae739084c0c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/facet.js\":\"412a150fa9940f85\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/index.js\":\"f07096de97933b5c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1ced40ad35ba5551\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2497501688672d2f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"242102fe1a5cbdd5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/facet.js\":\"82e64d882681cfb3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/index.js\":\"94c1a155f9f426ce\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/MoveDestinationPicker.js\":\"dd79ae772458e6a5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/blockSubtreeMembership.js\":\"40a38cc8a07ea9cb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/contextMenuItem.js\":\"fdf30f471d586bf0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/index.js\":\"45c3e8316843c8ba\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/moveAction.js\":\"c91529402c27b8d6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/moveBlocks.js\":\"e3999b9fae829188\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/selectionAfterMove.js\":\"a1584ae42d2e79f7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/TutorialBanner.js\":\"b5b9709a13c683ec\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/action.js\":\"0ce131a9e8c65d5e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/bannerDismissal.js\":\"f667ac9e3f8f04bb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/documents/cheatSheet.js\":\"437e68e02d9223f6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/index.js\":\"a90bbe520d22ca98\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/keys.js\":\"1179c5cd15544921\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/landing.js\":\"dc3336b56642c55a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/outline.js\":\"b13e6dfe0833033d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/seed.js\":\"849f2e64f032f399\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a3dbe75930d470bf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/analyze.js\":\"e5b277d2d356bc41\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/diagnosticsSource.js\":\"0a51fee2c0fce82f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/index.js\":\"bd0f5c69acf0dd2e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/load.js\":\"e0723efa7cf9b40d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/monitorRun.js\":\"20548c4e426662a3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/schedule.js\":\"ae1371de14a81850\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/series.js\":\"35971b72cd8ed44e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/store.js\":\"240f8ed51a72585b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/trendAction.js\":\"f75092c7186d48c8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/verdict.js\":\"0a4663c505df8016\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/clickToEditAction.js\":\"a9279366169cbae5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/index.js\":\"ca9ef2225be9eab8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/interactions.js\":\"aa979850702711a6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d4e2ce528bf198ea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/MigrationGate.js\":\"2d45ea4107129f8b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/MigrationGateDialog.js\":\"3a376cababafed21\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/action.js\":\"6c0793f46b4e517f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/index.js\":\"a24e2c352eccf378\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/localRunMessage.js\":\"8ded7203ebde17e0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/plugin.js\":\"c9e5ec9098528440\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/progressReport.js\":\"9312ad9a779b6ff5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/sweepProgress.js\":\"9f46a1ad8b46366b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/FieldRowRenderer.js\":\"29c76b9359345754\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/ValueRowRenderer.js\":\"a3d35f230894dc85\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/actions.js\":\"42e70d6c3943f741\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/autocomplete.js\":\"aa56f90e241495ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/fieldRow.js\":\"99c33d56da02fe8d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/index.js\":\"8806c9d378579185\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/referenceWarning.js\":\"360d5c8c58b50ec6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/valueAutocomplete.js\":\"5fff7589cfaab379\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/valueSchema.js\":\"b7e44085808e1526\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/HeaderItem.js\":\"e4e419e066f04a06\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/QuickFind.js\":\"8cfcfa9e9d433d39\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/index.js\":\"edbd712fd3b6c327\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/recents.js\":\"93883611ec6bd7e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/resultItems.js\":\"2cb17d149238d217\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/selection.js\":\"a2527326d937a569\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/toggleStore.js\":\"680be21442e135f1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/HeaderItem.js\":\"9dd5ebdee4563c00\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4f36e21f60170352\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/grouping.js\":\"6050402239f08118\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/index.js\":\"7b0b1ee95d0e0f64\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/target.js\":\"852d9a65a357eefc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/codeMirrorExtensions.js\":\"b00620407b725eb9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/contentPrefill.js\":\"3362aa23d2c8130a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/dataExtension.js\":\"367d2dc968027094\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/index.js\":\"37e63c91a5ddfa8e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"cf9b33fcf6c388fb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/invalidation.js\":\"7354f6580bfb815b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/localSchema.js\":\"912f2e071b77aefe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/blockrefs/index.js\":\"9038b96aea41d4b2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"7ce9b68f0cb150a5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/index.js\":\"0fe8db9f54d7bb07\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/referenceNode.js\":\"fcf1270e54b4a419\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/remark-reference-occurrences.js\":\"672c0561632540cb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5dff2afd928606e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/index.js\":\"02c1bdcec19bbd07\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"bca520b0473af7d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1b6369c066ed6b69\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/mergeRetargetProcessor.js\":\"662e4c491e385598\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/parseFence.js\":\"2e130e60f90ac7c2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referenceParser.js\":\"1c7fe1a5e578e103\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referenceProjection.js\":\"6ec58c845042ac3e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referencesProcessor.js\":\"55e046dd3827a599\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/renameProcessor.js\":\"5585dc5f90c5eef4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/spanReplacement.js\":\"57f603ab7e937385\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/htmlToOutline.js\":\"312aef9f8da5c455\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/index.js\":\"d60ed757e4dff0c0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/normalizeClipboardDom.js\":\"bebcbd68bc46a1ee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/pasteDecision.js\":\"0dba7f37ab8f827b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/action.js\":\"ad3cbfacebb0fc4e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/blockIds.js\":\"a2405ae07766cd13\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/content.js\":\"0a550e5157140541\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/effect.js\":\"8cc54d0b00bb01e8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/ids.js\":\"1520375c542e5b7e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/import.js\":\"1cc3d13a690cfdfc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/index.js\":\"3532ec7cae437d6c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/plan.js\":\"00232a6783a5d203\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/plugin.js\":\"de5e085320f7cae7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/promotion.js\":\"f2bae703bc805297\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/properties.js\":\"28cb2b5e27e4ec21\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/references.js\":\"f719d8abfc251a46\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/report.js\":\"088f26ae6688a32d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/roamMemo.js\":\"08411192c4fbce8e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/runtime.js\":\"ffb4e632ca39e722\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/schemaReconciliation.js\":\"37bddb0cfe971132\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/srsMarkers.js\":\"12b40002c64a37e5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/todo.js\":\"442e7775886c1ff7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/typeCandidates.js\":\"4dfc1be44d684d7d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/types.js\":\"74eb06ce43376560\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/search-health/index.js\":\"bb65ccef169ba14a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/search-health/store.js\":\"e110a93d67147c81\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/HeaderItem.js\":\"f77c66fa52c70bb7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0b6eaae8bbb89792\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/index.js\":\"2702277a8960c61e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/model.js\":\"c719adc4fc5e48b1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/toggleStore.js\":\"9d23c9adb8681a2a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/useKeyInspector.js\":\"bfe1a9f01ead2900\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"84f00c1e9ad5f93d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/ShellDecorator.js\":\"1ccc757250af8ffc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/actions.js\":\"e8abf08151f8cc2c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/exclusionsFacet.js\":\"1cfce78593cc7395\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/index.js\":\"b5d433ba64f36e66\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/shell.js\":\"d4c132493f0a8caf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/surface.js\":\"ceeb1251aeefdbb1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/walker.js\":\"42576d70e1daf13d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/RescheduleToast.js\":\"37163a5178cc087f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/dataExtension.js\":\"fee4094378c1b566\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/index.js\":\"eaeb3fe744e5ab00\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/indicator.js\":\"0b3645c5a5e14f15\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/moveSrsState.js\":\"64eb8e595f1bb5f7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"4b7e7ba79da6cff6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/scheduler.js\":\"35246fc16467ff05\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/schema.js\":\"807729a84f09cbc7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"084435cf7ebef2b4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/srsClipboard.js\":\"115c19a0d53bd736\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"0a0cfa93951be980\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/DailyNoteReviewHint.js\":\"53a889b245b52e54\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/DeckPicker.js\":\"90a44c2af826ce9b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewControls.js\":\"e29e04a8d1dcb15f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewDeckRenderer.js\":\"31c7ac8d67ef85e5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewSession.js\":\"8992de96c7a10ae5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/actions.js\":\"e3c23c83d69bf41e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/archive.js\":\"331f08de65868516\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/dataExtension.js\":\"a5ba55d824f7a8cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/deck.js\":\"c27f27ddf26e1b72\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/dueQuery.js\":\"8632cf5ac681e278\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/gradeDecision.js\":\"d06781bcffd90b31\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/index.js\":\"efedf46906345f4b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/keyHints.js\":\"0b2ad800f70ffb6c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/reviewCardLayout.js\":\"cc5b1664cec38a48\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/reviewProgress.js\":\"5dabe150e86f04e3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/schema.js\":\"28d89c6f6be67a5a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/useDueCards.js\":\"476aaa5eb426758c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/startup-metrics/index.js\":\"a2be6bf074af8670\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/startup-metrics/record.js\":\"0fb8e00f2ff52455\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/index.js\":\"52f9436fba95c7f2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/persistenceStatus.js\":\"26cd0918e9c89451\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/requestAction.js\":\"0c0ce4729b518289\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/TypeChipsDecorator.js\":\"b1394a81a5bfba59\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/codeMirrorExtensions.js\":\"25b354bd0a9f1df9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/index.js\":\"e6280176d87c08c3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/typeAutocomplete.js\":\"2fc2991a4d0bcc67\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"567d31c7612c329d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/actions.js\":\"0bc64ab9523a3e3b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/anchor.js\":\"02093148e52e75e5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/events.js\":\"78914ea5a15f1959\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/gestureActions.js\":\"e4d9618a08fa6fe0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/index.js\":\"a3dbbb00d4a7c2c9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0927177970596b62\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/collect.js\":\"f3a46cb43326f536\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/index.js\":\"261f257adac28bc7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/record.js\":\"55331871df7f98b1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/RejectionDialog.js\":\"cb0a29dbe2452658\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d86c9232a6843a4e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/index.js\":\"79e3f21aafb783dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/model.js\":\"9b441c013085f8cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/queueCounts.js\":\"858110079b63bb2a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/rejectedHelpers.js\":\"897fffad15b26b28\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/rematerializeAction.js\":\"98aa6ba038391614\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/useHysteresis.js\":\"a99b86d5ae109937\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/ColumnHeaders.js\":\"05e393c2918236f6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/QueryUi.js\":\"5c15a3e4f2cb058d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/TableLayout.js\":\"faf7c34936d4c675\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/actions.js\":\"17195a889e1c68db\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/cellEdits.js\":\"8ea68d2b07f5ef08\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/childrenViews.js\":\"f39223fef68c7417\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/columns.js\":\"d1ea4d823a5443e4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/controller.js\":\"d77d6a1803cdca5b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/convert.js\":\"98e29ee573073a79\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/dataExtension.js\":\"7e8bf1d9d844af69\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/index.js\":\"dd6b8b243e5ea4e7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/keys.js\":\"833355efc22d2018\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/model.js\":\"5090971dc1870daf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/backfill.js\":\"f29de328a57028fe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/completion.js\":\"16c30dd6d1aa753b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/format.js\":\"bf6d95d07a88b826\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/parse.js\":\"e26267f269698fda\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/queryValue.js\":\"70485808aa1bd690\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/source.js\":\"9e87e2135a141b5d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/registry.js\":\"a894b04c1f7f64f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/rowGutter.js\":\"40849fcbc32b3be8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/rowVerbs.js\":\"a3cdedded2d5520e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/schema.js\":\"624b530000154a78\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/sort.js\":\"1dacfb4717acdca1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/effect.js\":\"2c51413dd9d22207\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/index.js\":\"1500c47bb14a9154\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/theme.js\":\"3bf88128f5eedca1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/actions.js\":\"d6e96ef2432f32fe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/dataExtension.js\":\"98543d37c09aed92\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/index.js\":\"a5fdbd40fda46dd3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/schema.js\":\"170dfc62e2249f11\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/TouchSelectionLayer.js\":\"53a21960a56aef67\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/actions.js\":\"d56ee7cd6fb1ab71\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/defaultItems.js\":\"2be8d227e64069f2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/facet.js\":\"fc6d06b852854317\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/holdRecognizer.js\":\"93673d8e8137ad95\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/index.js\":\"a846323c960e8d95\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/UpdateIndicator.js\":\"844412e9f77e5d89\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/index.js\":\"693e00ba234ef2f8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/loadTimes.js\":\"fbe06e9783731434\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoNotesRenderer.js\":\"59f7cb97bf1c82d4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoPlayerRenderer.js\":\"7c924e36dfb226b9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoTimeStamp.js\":\"7c49ef540e5f82ac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/actions.js\":\"a43f7d3ad3756b4e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/index.js\":\"018c75405fac858f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/markdown.js\":\"881765979e3de254\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/notes.js\":\"0ade54600e185c8e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/registry.js\":\"464de150719906d8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/remark-timestamps.js\":\"6df4772dc0964ccd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/view.js\":\"19c2d04f8edf9215\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/LinkHints.js\":\"abbe7de543601448\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/index.js\":\"d1a2ba9ccef11588\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/model.js\":\"5a8bd1fef06c463c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/settings.js\":\"94a64a16da76fb7c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/actions.js\":\"d9af18a803fe4382\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/index.js\":\"181d82cdab245173\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/interactions.js\":\"d01ec8a3b4f0876c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/workspace-header/index.js\":\"5ce169c9a2f55015\",\"/knowledge-medium/pr-preview/pr-1876/src/registerServiceWorker.js\":\"eb7e0d3835079983\",\"/knowledge-medium/pr-preview/pr-1876/src/requestPersistentStorage.js\":\"98ce3fd688e3dba6\",\"/knowledge-medium/pr-preview/pr-1876/src/services/authRequestDeadline.js\":\"61b996195b940409\",\"/knowledge-medium/pr-preview/pr-1876/src/services/authStorage.js\":\"44f2ad28593b85af\",\"/knowledge-medium/pr-preview/pr-1876/src/services/powersync.js\":\"c4649b560fbe0cd1\",\"/knowledge-medium/pr-preview/pr-1876/src/services/supabase.js\":\"98234e9aabe24f3d\",\"/knowledge-medium/pr-preview/pr-1876/src/services/uploadErrorClassifier.js\":\"55e6098e532be68a\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/ActiveContexts.js\":\"2980086dd71b9cbb\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/HotkeyReconciler.js\":\"6b89acfc084d5697\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/WipeLocalDataDialog.js\":\"85c16fc57ab2b7c3\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/actionDispatch.js\":\"d9c4543609711e84\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/actionRefItems.js\":\"67e68e0bc7ac561b\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/applyKeybindingOverrides.js\":\"3b37294c58d887e0\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/blockActions.js\":\"590700631453b275\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/blockMergeGesture.js\":\"bd1f6a072dc47983\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/canonicalizeChord.js\":\"0fba7242cb154577\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/defaultContexts.js\":\"95193b9706e5e5bd\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/defaultShortcuts.js\":\"f5edfb41dda7cb9d\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/effectiveActions.js\":\"d9310b93ba9389ef\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/gestureAction.js\":\"6480c50ca7b754e2\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/gestureBinding.js\":\"e58821355c3e99c9\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/holdRegistry.js\":\"0ebb771330eb6ff3\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/keybindingConflicts.js\":\"3766d02857cc8431\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/keybindingOverrides.js\":\"2da5319dabae24fb\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/pointerAction.js\":\"8bf6a2c5d9a92d88\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/resolve.js\":\"e438a1440c3e97a8\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/runAction.js\":\"570481633f55196c\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/sequenceMatcher.js\":\"7d58956e179df771\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/types.js\":\"8744719271184f76\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/useActionContext.js\":\"e7f019dadb39d8e8\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/useActionDiscovery.js\":\"299ba7cc17d29fbb\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/utils.js\":\"f8414cdbb161f5c6\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/bootStore.js\":\"02df1d418ed3d328\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/previewDatabases.js\":\"cacdbcb77af3686a\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/byteTransform.js\":\"8caea042458fd72d\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/attachmentCleaner.js\":\"163ae76bada8d36e\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/attachmentParts.js\":\"bf864beb9ecfb313\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/bundleParts.js\":\"9c309bf9025b0071\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/bundleRecord.js\":\"fdf25bfaee5f8d8c\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/manifest.js\":\"87ecd01c918df1d5\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/takeBundle.js\":\"cde3e2dc8af7739d\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/verifyBundle.js\":\"1af3979cc30a7218\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/cleaningStage.js\":\"34ee5c62a767ae79\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionKey.js\":\"66530a864c110620\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionServer.js\":\"3931b349051ce9eb\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/flip.js\":\"46614f2725c553e4\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/flipAttempts.js\":\"0021b574a3a14ac8\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/pages.js\":\"fb0d6600f5e1fdea\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/preflight.js\":\"af733e49050ecac2\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/reseal.js\":\"e07b8eb32e5cd02f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/runConversion.js\":\"5a9a412c2d4da96a\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/runLock.js\":\"e1af85686b4faf59\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/sealing.js\":\"83f4f82eef873955\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/sealingStage.js\":\"5295e69e16f1ad57\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/stage.js\":\"d95d1f5b5d9b59a9\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/verifyReseal.js\":\"69f090e337bfd348\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/aad.js\":\"8ee5a0b6f8fd377b\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/aead.js\":\"50728fafb81fc10c\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/base32.js\":\"9b4f280c5bab6856\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/base64url.js\":\"553cf6c7744cd6c3\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/binaryEnvelope.js\":\"7224bc32de06babd\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/byteAead.js\":\"d9bf30abd4fb8cc8\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/canary.js\":\"a42aba48401947b4\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/contentHash.js\":\"0b08d2bf63557796\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/contentKey.js\":\"3149f2d7d6929d1f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/derivedIdNamespace.js\":\"c60a1d9f7ea035fd\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/envelope.js\":\"1454a5155ebf3789\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/hex.js\":\"4b7cc7cf7f76169a\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/sha256Hex.js\":\"6325525b2185530b\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/workspaceKey.js\":\"7f2ae8c57f2a2ae4\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/conversionState.js\":\"d0d6c8cf3b041f2a\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/createEncryptedWorkspace.js\":\"f860387580ba1bad\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/pastedKey.js\":\"bd19b1ec01ef7339\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"23d11bbb16a1f05a\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/upgradeWorkspacePin.js\":\"18024cf7c4dcdff7\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/keyStore.js\":\"59775cd752821ab5\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/mintWorkspaceKey.js\":\"f4753f4de8b8ff70\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/modePin.js\":\"d8db40655634d662\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/openWorkspaceKeys.js\":\"8ad7ec3daea3b3cf\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/resolveWorkspaceEntry.js\":\"831af9a8c9625506\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/resolver.js\":\"5a5215dd6327b60c\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/workspaceAccess.js\":\"b2200422539162ff\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/transform.js\":\"efa18fa987e7e684\",\"/knowledge-medium/pr-preview/pr-1876/src/themeBootDefaults.js\":\"0b7c16c1baf66cc9\",\"/knowledge-medium/pr-preview/pr-1876/src/types.js\":\"9ead1fb844db8422\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/ClientLocalSettings.js\":\"4ecb06263bf1da54\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/abortableSleep.js\":\"25ec807c8cf55d02\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/array.js\":\"34c3573ed5e43755\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/backlinkAutocomplete.js\":\"31ede2449dcc8ea9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/blockCrumbs.js\":\"07e94b6601e1945f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/blockrefAutocomplete.js\":\"1e3b6c56754ac013\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/cadencedIdleJob.js\":\"33294488696d3fa0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/callbackSet.js\":\"56689368e36b739b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/clientId.js\":\"093b22e2b2ddde4d\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/codemirror.js\":\"acfbaa21586301e8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/codemirrorCompletion.js\":\"0b56390649ed0bdf\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/copy.js\":\"a3ed2ad69cfacf5a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dailyPage.js\":\"d1b9e72c6a3897ee\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dbForensics.js\":\"9afee8ba92646f2d\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dbForensicsHooks.js\":\"d7be4b319a87d241\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/deleteBlockThroughUi.js\":\"511a6c24a8c5014a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dialogs.js\":\"c24dcc7b2e4e7471\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dom.js\":\"fff6b6a29ed54bb0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/downloadBlob.js\":\"38c9363ab3341ce4\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/drawnWalk.js\":\"e569b008cee82086\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/exportSqliteDb.js\":\"87d0180dab5d56b1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fileSystemAccess.js\":\"a57df1abcc69473a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/flipSlide.js\":\"f3713d4bc83a5165\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fnv1a.js\":\"b24ba29d31ae0391\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/formatBytes.js\":\"7454a4583467857e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fuzzyRank.js\":\"e10d92bb70eb7c46\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/idbKeyedStore.js\":\"1032a296a6078025\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/idleCallbackPolyfill.js\":\"5f8b1848543747ab\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/keyboardAwareScroll.js\":\"c69874f137f46c94\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/keyboardViewport.js\":\"5cff5f1cc9363216\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/lastWorkspace.js\":\"1517db6e718fd9fd\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutColumns.js\":\"50984aa5374f4170\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutSessionDom.js\":\"4cc629d6335d5e11\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutSessionId.js\":\"327a3d236398e58a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/linkClickGestures.js\":\"547daaec5f2c1173\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/linkTargetAutocomplete.js\":\"400f0c2bc3307843\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/localDbCorruption.js\":\"9e0575b5c969c99f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/localDbRecovery.js\":\"ea80911359273b23\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/markdownParser.js\":\"c6a8c6b03cf663c0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/memoize.js\":\"a94babd2066f66c8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/nameFieldCommit.js\":\"2cd5c8c70b616514\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/nameList.js\":\"ef8247f166db6d40\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/navigation.js\":\"8f8ea2e4a90c5380\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/omnilinerNamespace.js\":\"03239d774eae0800\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/opfsPageScan.js\":\"3473953379dd3643\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelClearance.js\":\"8272429865c301a3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelHistory.js\":\"e3d95e77d75ab01f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelLanes.js\":\"010ecd4636df084f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelLayoutProjection.js\":\"0d71fae12121b6fc\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelScrollAnchor.js\":\"93612763961fd095\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelUrlFlags.js\":\"ebeb0c01683f3db3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/platform.js\":\"2d9ada62daa25610\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/pluralize.js\":\"6d4ee0b4ca0ab485\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyCreation.js\":\"7e36f5a928ee0c15\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyNavigation.js\":\"85be8a6c02a17ba8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyValueContext.js\":\"35830716dafa5da5\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/react.js\":\"aab1ab3ec2cb3fcb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/relativeDate.js\":\"fcd5cdeff584e1d1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/relativeTime.js\":\"586ca36aea35b1fb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/renderScope.js\":\"58d779e74f0dbae7\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/resolvedThenable.js\":\"6cbf428657a337a4\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/routing.js\":\"20614d4dc43e5607\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/safeMode.js\":\"c15d204872a1878a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/scheduleIdle.js\":\"01458549dd5be516\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/screenWakeLock.js\":\"82719c027b7c50e1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/selection.js\":\"04cf628c35fc91b1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/softKeyboardGrab.js\":\"a8f2867820e62d09\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/startupTimeline.js\":\"5045579af08d0afb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/state.js\":\"611d02dfea83e834\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/string.js\":\"01905a94d8d91dcc\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/surfaceZoom.js\":\"39ba5ec5c4872d13\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/time.js\":\"956f5d10ebfab691\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/toast.js\":\"ff5af5977edb93a9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/toggleStore.js\":\"7c18bccad1441bc5\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/untilStopped.js\":\"c2dae06bd28436e1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/userActivity.js\":\"8d1f8e052c917cf8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/viewTransition.js\":\"a11aa1cee4de9fda\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/viewport.js\":\"221483fa80ee02f9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/webLock.js\":\"7801530ea0a5c6c3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/workspaceRecovery.js\":\"150d1ecd4122ce85\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/workspaceSnapshotStore.js\":\"11f02e59564f1a3a\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-compiler-runtime.js\":\"39e3e7361ecf2d8f\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-client.js\":\"e79a047672f4face\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-server-edge.js\":\"ac4300dbccfc15ef\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-server.js\":\"50c348eceb3f3b31\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-static-edge.js\":\"7da68dd6be9a526d\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-static.js\":\"2b75445a4656e3a5\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-test-utils.js\":\"5c706bc8a0941dbd\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom.js\":\"8a5349d5e5b77ebd\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-jsx-runtime.js\":\"6fe077d6860e5af0\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react.js\":\"67a0b1b8bbf52e9d\",\"/knowledge-medium/pr-preview/pr-1876/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1876/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1876/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
