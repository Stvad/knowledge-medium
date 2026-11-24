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
		buildId: "34be3d29ce5d-68808c9b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/\":\"1dd1de06f1b44795\",\"/knowledge-medium/pr-preview/pr-1876/index.html\":\"1dd1de06f1b44795\",\"/knowledge-medium/pr-preview/pr-1876/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1876/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1876/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1876/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1876/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/pr-preview/pr-1876/assets/FacadeVFS-QjCi6DWI.js\":\"5e5274e12fa22bc2\",\"/knowledge-medium/pr-preview/pr-1876/assets/OPFSCoopSyncVFS-wxp1Uqdx.js\":\"26e3c44a3087f499\",\"/knowledge-medium/pr-preview/pr-1876/assets/OPFSWriteAheadVFS-CVFEYFmB.js\":\"9c0c063f0b0aca04\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-8TWgCfd6.js\":\"a9534c7c077aec29\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-async-Dzf0FjH0.js\":\"cc0155b76245b694\",\"/knowledge-medium/pr-preview/pr-1876/assets/worker-CedGonAS.js\":\"f8bbe6a306fb4ba6\",\"/knowledge-medium/pr-preview/pr-1876/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1876/chunks/app-CblAhgWR.js\":\"2f8e7e961c1bcfb3\",\"/knowledge-medium/pr-preview/pr-1876/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1876/index.js\":\"c687c11beaeabe0b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1876/assets/AccessHandlePoolVFS-Dia6ZnV6.js\":\"5a4b19079172a975\",\"/knowledge-medium/pr-preview/pr-1876/assets/IDBBatchAtomicVFS-CP0iq6pd.js\":\"11d774c0189783d6\",\"/knowledge-medium/pr-preview/pr-1876/assets/MemoryVFS-X1IFqAfC.js\":\"1e75a85b7e069894\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-BpOZgN39.js\":\"ce63225182905fa2\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-async-N55meU-N.js\":\"328756d3ba260649\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1876/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1876/chunks/AccessHandlePoolVFS-BRC6yeuC.js\":\"1e94188b856d8adb\",\"/knowledge-medium/pr-preview/pr-1876/chunks/FacadeVFS-BUUTlJp3.js\":\"44f04cbdb7ff0da4\",\"/knowledge-medium/pr-preview/pr-1876/chunks/IDBBatchAtomicVFS-DHHYpib7.js\":\"f8aaf3a1e6670638\",\"/knowledge-medium/pr-preview/pr-1876/chunks/MemoryVFS-D0YNRGb4.js\":\"24b94327f215b532\",\"/knowledge-medium/pr-preview/pr-1876/chunks/OPFSCoopSyncVFS-DaYhTMMe.js\":\"63baa75f9358a196\",\"/knowledge-medium/pr-preview/pr-1876/chunks/OPFSWriteAheadVFS-DkZpZpmb.js\":\"af4dafbc240ecc54\",\"/knowledge-medium/pr-preview/pr-1876/chunks/Preview-BR8yLObH.js\":\"49e8e2fc36a422a8\",\"/knowledge-medium/pr-preview/pr-1876/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/card-B_LmfrEo.js\":\"3d9b9866d6b63e5f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-CwvaLfit.js\":\"41d5fb45718a5bf0\",\"/knowledge-medium/pr-preview/pr-1876/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1876/chunks/mc-wa-sqlite-B72rlJkn.js\":\"e0d08bce43e37242\",\"/knowledge-medium/pr-preview/pr-1876/chunks/mc-wa-sqlite-async-eLVkrJOT.js\":\"f049793fdf76158f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react--Xl6hbCK.js\":\"7c6f6879b8115519\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-BAEsYLB0.js\":\"0a3a85a46ba97822\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-BGDhfMYt.js\":\"13d6e52c671ab8f9\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-BwClmTM2.js\":\"f950f407b6d04ccd\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-CheGY1Rq.js\":\"60cef894dc04643a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-D10-pC0s.js\":\"debe6ba8adc62394\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-DkEBsbAl.js\":\"4b49e3511a04d106\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server-legacy.browser.production-DccwOMZT.js\":\"96fbfb912fb00e9f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server.browser.production-VaPst-na.js\":\"2d950e325d42210a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server.edge.production-BE0BU6V3.js\":\"c5c3cfb518a697e9\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-p6S-Amnb.js\":\"269919f5d360841e\",\"/knowledge-medium/pr-preview/pr-1876/chunks/server.browser-67XvaISx.js\":\"df12fd863f8ab198\",\"/knowledge-medium/pr-preview/pr-1876/chunks/textarea-BG9kHe-F.js\":\"ad0749e4fc570afa\",\"/knowledge-medium/pr-preview/pr-1876/chunks/ui-j1IB_PIA.js\":\"9d31ab257017574a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/wa-sqlite-Cb0EYRpo.js\":\"5fb4e94cb4b50c1a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/wa-sqlite-async-BZU99hzR.js\":\"bed609b4f46da444\",\"/knowledge-medium/pr-preview/pr-1876/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1876/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1876/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1876/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1876/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1876/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1876/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1876/src/App.js\":\"50f8e7bb2be5435c\",\"/knowledge-medium/pr-preview/pr-1876/src/appUpdate.js\":\"7dd4c763d837ef53\",\"/knowledge-medium/pr-preview/pr-1876/src/appVersion.js\":\"40b69cc3910b94f9\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/initialLayout.js\":\"0100067908c1de0f\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/openWorkspaceData.js\":\"5b670fd98e3da349\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/resolveWorkspace.js\":\"a6b030d3395057c7\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/workspaceBootstrap.js\":\"c1eeda7d7f4dd82d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockComponent.js\":\"5281965da03e7f97\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockCrumbs.js\":\"21858215200c832a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockEditor.js\":\"88bade8fa00d0ff8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockLoadingPlaceholder.js\":\"59396ed90e17253c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockProperties.js\":\"711eed9f5b152c5d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockSearchPicker.js\":\"310ad7948c98fbf1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ConfirmBulkDeleteDialog.js\":\"b1f42335148ccebc\",\"/knowledge-medium/pr-preview/pr-1876/src/components/DividerHandle.js\":\"18b821eb0f85932b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/DraftEditor.js\":\"3ba1fc2fd49ed18d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/GutterPill.js\":\"9cd81db6698ee4d1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/Header.js\":\"5a6d2447c8ed4a22\",\"/knowledge-medium/pr-preview/pr-1876/src/components/LazyBlockComponent.js\":\"86979338012fc505\",\"/knowledge-medium/pr-preview/pr-1876/src/components/Login.js\":\"b28ced2ff9e63ac3\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ZoomableSurface.js\":\"2049c565199b2d90\",\"/knowledge-medium/pr-preview/pr-1876/src/components/editModeKeepalive.js\":\"1ebd890794880c2d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyDisplay/PropertyDisplayScope.js\":\"7a4ec69cc479a2bf\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"02ec0c8a4e0f1246\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/RefPropertyEditor.js\":\"d7b8138eb7fb69ba\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/RefTargetTypePicker.js\":\"6452a37e7100d999\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/SelectPropertyEditor.js\":\"f81a56ef7eb1c4b7\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/TypesPropertyEditor.js\":\"b5513de7b68929f1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/defaults.js\":\"c129fa0afe8af2c1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/kernelValuePresets.js\":\"d37890bd80ccf4d6\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/selectablePresets.js\":\"52824a4142acf2d5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/typesPropertyUi.js\":\"d16268a549ff03c0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/AddPropertyForm.js\":\"7c3ec7506569779b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/PropertyPicker.js\":\"0802de90c9d47c69\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/PropertyRow.js\":\"67b6f979d602ddda\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/Rows.js\":\"d3d0fcadb9806622\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/actions.js\":\"832cab04cea9a86b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/declarationOnly.js\":\"d9133afd97b8e10e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/layout.js\":\"d22d4d25bc0026c4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/model.js\":\"7a7295193807e44d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/shapeUi.js\":\"b0a708ecf56ac1b8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/shapes.js\":\"c98622c335e38913\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/usePropertyEditingActivation.js\":\"404bf551f6979e43\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/visibility.js\":\"0b3386bf1d0c5129\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanelSections.js\":\"8e64572f0e7735f1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockEmbed.js\":\"195f2aa5d056a291\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockLink.js\":\"323bde4e61133e2e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockRef.js\":\"604601663a76107a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/ReferenceLink.js\":\"559e7022e38be5b2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/cycleGuard.js\":\"b55798b0988e01db\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/cycleGuardContext.js\":\"1869b0704228f086\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/linkInteraction.js\":\"0f98426d31ba0d3c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/referenceLayout.js\":\"c3ff2aac7dd19dc9\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/useBlockRefAncestors.js\":\"c79654c5b73533ee\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockGutter.js\":\"eddde4ef8c2c1713\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockInfoDialog.js\":\"4f63dbe9b02e8636\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockTypeBlockRenderer.js\":\"ded2cae0091de612\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BulletHoverCard.js\":\"85cb076c25ad7471\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/CodeMirrorContentRenderer.js\":\"ce6776c327077635\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"bb7f16f25d8620af\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/ColumnResizeHandles.js\":\"f477f0373adf028e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"53fed24c498c0f36\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/DefaultBlockRenderer.js\":\"c5a2086e28eb1493\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/LayoutRenderer.js\":\"da72ba997c10a99e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/MarkdownContentRenderer.js\":\"d3449c733e82aea8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/MissingDataRenderer.js\":\"6faf61ddfd275871\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/PanelRenderer.js\":\"36ba5c39e8e168db\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/PropertySchemaBlockRenderer.js\":\"244bb1302253e72d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/TopLevelRenderer.js\":\"a052693f6c5be9f4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/blockGutterMode.js\":\"d8143199dfdde008\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/blockTitleText.js\":\"b9d5470ccb853f35\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/fieldCreationKeydown.js\":\"ff5d9f84dfde4a45\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/layoutRootContext.js\":\"6f13c382503b21dd\",\"/knowledge-medium/pr-preview/pr-1876/src/components/typeChip/TypeChip.js\":\"7039059bae7b4ca3\",\"/knowledge-medium/pr-preview/pr-1876/src/components/typeChip/chipStyle.js\":\"48b6f54594482d6f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/anchored-floating.js\":\"b2cfacae20e90616\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/button.js\":\"9279d1d12048286c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/card.js\":\"7f1d24f78361a4aa\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/checkbox.js\":\"789e6cb01e0df86f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/collapsible.js\":\"98641face173a649\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/command.js\":\"192e28eca5b7c021\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/context-menu.js\":\"1e16fa1a25679ece\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/dialog.js\":\"a7b18f5a4c28ce6f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/dropdown-menu.js\":\"d359c39da5c3dc34\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/floating-listbox.js\":\"33285ea455cdf0fb\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/index.js\":\"dd40f55ee3631cac\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/input.js\":\"4c034dd6922176c7\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/kbd.js\":\"2eeca0d84d93093e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/label.js\":\"1bb6ea092c9bf239\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/textarea.js\":\"76f3e714f8c182ce\",\"/knowledge-medium/pr-preview/pr-1876/src/components/useEditModeYieldKeepalive.js\":\"59d8d5c0eaa3a2a3\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/BootFallback.js\":\"479a4c830eddd4b3\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/FocusedRowLazyMount.js\":\"3ef338874ec941cf\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/LazyViewportMount.js\":\"aa267ea6e4cf94d1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/LocalDbCorruptionFallback.js\":\"ce9c8ffc50732722\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/error.js\":\"518dab8f73751c1f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/lazyMountRegistry.js\":\"5f9141c46a9ebcf4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/suspense.js\":\"aaf1bce989fa8ac9\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/CreateWorkspaceDialog.js\":\"83bf9ab39d486f86\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/PendingInvitations.js\":\"4701c8d40c9fb7c9\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/SyncProgress.js\":\"4d5c0b6acf4427cb\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/UnlockProgress.js\":\"ae64aeae5dfab0e5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceKeyGate.js\":\"e9b10535efb193ce\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSettingsDialog.js\":\"9089e20c4bf3b86b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSwitcher.js\":\"6732649b8435d963\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSyncGate.js\":\"078c020e58f101cd\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/ConversionFlow.js\":\"1f8565bafd46d2c1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/ConversionFlowHost.js\":\"4891f0a89a410f2e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/EncryptionSection.js\":\"64745b8e98d7f52b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/attachmentPrompts.js\":\"e1fef2f6f520ecae\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/bundleFolderPrompts.js\":\"7b318158b0fd0dc2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/conversionFlowDeps.js\":\"af0928df5f5c4bac\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/conversionFlowStore.js\":\"552bec65407dcdfd\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/flowUi.js\":\"b8043b4866d3392a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/useConversionRun.js\":\"62c1e0929a351aed\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/keyUi.js\":\"68b4ce17b57e1a2e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/useCloseOnKeyLoss.js\":\"8f4f3de9e03c03ee\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/useCloseOnServerE2ee.js\":\"e30d7c2ff07aa2c8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/workspaceUnlocked.js\":\"3a2bfa0d44e27c27\",\"/knowledge-medium/pr-preview/pr-1876/src/context/backgroundSubtree.js\":\"36a0501d41f7c5bd\",\"/knowledge-medium/pr-preview/pr-1876/src/context/block.js\":\"e40ed7411c18e7ba\",\"/knowledge-medium/pr-preview/pr-1876/src/context/layoutWsContext.js\":\"7e6d1f01d38c9c06\",\"/knowledge-medium/pr-preview/pr-1876/src/context/propertyDisplay.js\":\"03d041e0dc2b2588\",\"/knowledge-medium/pr-preview/pr-1876/src/context/repo.js\":\"0521a24e9d25e0c8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/aliasClaim.js\":\"9f2494f9a9de3c43\",\"/knowledge-medium/pr-preview/pr-1876/src/data/aliasSeatNamespace.js\":\"629f7f80cf697d4f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/blockData.js\":\"f183e2c9d83cc236\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/blockType.js\":\"2036f35c09526b55\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/changeScope.js\":\"ccb86eafe2226bc3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/codecs.js\":\"37d39fd473af21f8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/derivedData.js\":\"3e8d2823a58a5d12\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/errors.js\":\"743abd7b254518c1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/events.js\":\"a554ec925116b262\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/handle.js\":\"ab54875454ca7998\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/index.js\":\"eabe9f14f967b205\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/mutator.js\":\"fd42179d9e980b82\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/processor.js\":\"79436506ea3038f3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/propertySchema.js\":\"a685ebbf2210aae9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/query.js\":\"9677c856b46d6d1a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/sameTxProcessor.js\":\"d9d5cef887f70fa8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/schema.js\":\"ab54875454ca7998\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/tx.js\":\"ab54875454ca7998\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/typedBlockQuery.js\":\"33d4e674b5a38199\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/user.js\":\"9c854f8012fe327a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/valuePresetCore.js\":\"85f47451b2d97522\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/valuePresets.js\":\"875f54033a13adb9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/attachmentCleanerIOVerb.js\":\"7f68d9e4b6dbd2b4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/block.js\":\"ec14d2d0a66fd470\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockCache.js\":\"052fde2a81d6c3f2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockId.js\":\"fa727cf4aa641210\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockLiveness.js\":\"a1244e10dfae584d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockMerge.js\":\"3a06bf0f11224b23\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockSchema.js\":\"9b8f463eb22d7b33\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockTypeLookup.js\":\"9d6397205b33dd31\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockTypes.js\":\"9a886efab5c6fd9c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/childrenView.js\":\"cd35bd7ae69fc1ae\",\"/knowledge-medium/pr-preview/pr-1876/src/data/clientContext.js\":\"bed22dd142f86454\",\"/knowledge-medium/pr-preview/pr-1876/src/data/dbFileSiblings.js\":\"03e81440bf61db6f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/definitionSeeds.js\":\"76cd826967779a52\",\"/knowledge-medium/pr-preview/pr-1876/src/data/derivedIds.js\":\"1110c203093c6caf\",\"/knowledge-medium/pr-preview/pr-1876/src/data/drawnSubtree.js\":\"0124e37e98a81d89\",\"/knowledge-medium/pr-preview/pr-1876/src/data/facetBridge.js\":\"b9de99509dfd80af\",\"/knowledge-medium/pr-preview/pr-1876/src/data/facets.js\":\"f258ee890c70a973\",\"/knowledge-medium/pr-preview/pr-1876/src/data/globalState.js\":\"d7c601ad38908810\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/aliasClaimRederiveProcessor.js\":\"b1ebeabb55becf49\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/ancestorBatch.js\":\"47d17dc93ca91dc5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/blockTypeTypeifyProcessor.js\":\"30dc40f5a992ba95\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/clientSchema.js\":\"e0abe6bc715727a2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/commitPipeline.js\":\"006e31cf32d7ff57\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/devAssertions.js\":\"a74e974c7c9c6455\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/firstSync.js\":\"d4a6e7867915a6e0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/freshInitialLoad.js\":\"8b6951222e0a13f0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/graphBackfillClaim.js\":\"d885bd94a0ab8add\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/handleStore.js\":\"eb62959e4e05e3ba\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/idleMarkerJobs.js\":\"5e496c9d716290c4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/initialDownload.js\":\"ae3837633950b2c8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/initializeClientDatabase.js\":\"e173a97a0ed45e4c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/jsonCanonical.js\":\"cccaa3ff4f258238\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelInvalidation.js\":\"e5c60062b1e37a28\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelProcessors.js\":\"1b90ce0cdaeb24bf\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelQueries.js\":\"578795571f80aa7e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/mergeTypeMembershipProcessor.js\":\"cfe63f4029e7f9ea\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/normalizeReferencesProcessor.js\":\"67ea086a67bbce2c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/poolInstrumentation.js\":\"b53fe14532fc96cd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/processorRunner.js\":\"273736deeb70d452\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyCellBackfill.js\":\"983e15b1c75104cb\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyChildMint.js\":\"0c880b7fe2eaafd6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyChildrenProcessor.js\":\"c0cd6baa87d139c2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyDefinitionChangeProcessor.js\":\"0c5c2c55901e8803\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyDefinitionSynthesis.js\":\"46aeb4f762b4a13d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyKeyScan.js\":\"00842abe14d6d3a1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertySchemaResolution.js\":\"2e8d49143152bb3a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyValueEdits.js\":\"93b9031cedd62429\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/raiseProtocol.js\":\"db1f66716d89d8d4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/readBatch.js\":\"200c3c6b8d63b894\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/refProjection.js\":\"fdfecd9cde7e4fab\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/referenceTargetLookups.js\":\"11a8df3207a0c228\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/referenceTargetProcessor.js\":\"345a28b4997534a3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/replayMerge.js\":\"b5245a16c1e36901\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/sqlBinds.js\":\"16e6ca3a585f5a61\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"be589d323c077339\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/arrivalProcessors.js\":\"4ecb4758729c3386\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/invalidate.js\":\"53a9233d18f21645\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/materialize.js\":\"e62e23a078986cde\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/observer.js\":\"4f8016e511a04081\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/reconcile.js\":\"5e71a49b7c4082e8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/timingMetrics.js\":\"1f8998a618ffccdf\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/treeQueries.js\":\"b56bf94577875fce\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/txEngine.js\":\"41a71c5852f35086\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/txSnapshots.js\":\"444571d49c62d8ef\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/typedBlockQuery.js\":\"063c2d1653982dc3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/undoManager.js\":\"34614203a30fadca\",\"/knowledge-medium/pr-preview/pr-1876/src/data/invalidation.js\":\"7c8beadc40523382\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelDataExtension.js\":\"21d1e7f67ea5d561\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelPage.js\":\"4050e8803ebeb69e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelValuePresetCores.js\":\"3a15e2394aacad9c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbCorruptionSignal.js\":\"bce9795068284dec\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbStorage.js\":\"22086682d29493fb\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbVfs.js\":\"69e1c830f99f287f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localSchema.js\":\"43625d8509c496d9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/maintenance.js\":\"012477329c20e23c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/mergeProperties.js\":\"0e90989776e4fcf5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/metricsConsoleHook.js\":\"916fd9bffe1fbc88\",\"/knowledge-medium/pr-preview/pr-1876/src/data/migrationsPage.js\":\"a1fc0c043b7bd2de\",\"/knowledge-medium/pr-preview/pr-1876/src/data/mutators.js\":\"7a6cb2fe0bc4d3df\",\"/knowledge-medium/pr-preview/pr-1876/src/data/orderKey.js\":\"616370d0ea436c53\",\"/knowledge-medium/pr-preview/pr-1876/src/data/orderKeyPlacement.js\":\"a3507ee3ed99c14b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/outlineSurface.js\":\"2398924b089298f8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pendingEditorContent.js\":\"3bf17c6eb5825eb8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pendingUploadsSql.js\":\"40f95abdc5bb846f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pluginStateExtensions.js\":\"9fa437bb253634a1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/powerSyncLogger.js\":\"de248c580e536310\",\"/knowledge-medium/pr-preview/pr-1876/src/data/projectorRuntime.js\":\"8ab151ec1bc04e44\",\"/knowledge-medium/pr-preview/pr-1876/src/data/properties.js\":\"6445a584f1dc101a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertiesPage.js\":\"c2a31827e0939d76\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyChildren.js\":\"b77c89c562aa7d8d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionFanout.js\":\"ecb03810b2121cb9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionMetadata.js\":\"a5c9edc4e78a7bc5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionRegistry.js\":\"f300dd4e85ec793b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDisplayMode.js\":\"f176580d372426a9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyRowCreation.js\":\"a6a49ba964aa6dd8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertySchemaCreation.js\":\"28cc48cd5e67feff\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertySeeds.js\":\"396dd5fe6556e019\",\"/knowledge-medium/pr-preview/pr-1876/src/data/recentsPage.js\":\"c23ffb01e6fbc9d0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/referenceBlock.js\":\"4d9bdb0b1337f230\",\"/knowledge-medium/pr-preview/pr-1876/src/data/rejectedUploads.js\":\"f9560e268f95bc52\",\"/knowledge-medium/pr-preview/pr-1876/src/data/releasePowerSyncConnection.js\":\"d711eb96c56d559e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/repo.js\":\"501970430b910375\",\"/knowledge-medium/pr-preview/pr-1876/src/data/repoProvider.js\":\"e7a302a35bdfb12f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/rowProperty.js\":\"a5d375442ce47637\",\"/knowledge-medium/pr-preview/pr-1876/src/data/searchFilter.js\":\"05e2e7cd50e1094e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/seedIdentityLedger.js\":\"a639a0e67a6b4f62\",\"/knowledge-medium/pr-preview/pr-1876/src/data/stateBlocks.js\":\"b13314fa6193e734\",\"/knowledge-medium/pr-preview/pr-1876/src/data/structuralEditPolicy.js\":\"f01ecae1e09c7bca\",\"/knowledge-medium/pr-preview/pr-1876/src/data/structuralInsert.js\":\"355b4682a9190904\",\"/knowledge-medium/pr-preview/pr-1876/src/data/subtreeDelete.js\":\"b4bd961eedf54a9c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncStreamLock.js\":\"588a7ad384d653bc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncedTableSqlRecognizer.js\":\"d82f2af725d5c559\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncedTableWriteGuard.js\":\"7ba8a14b9b231b11\",\"/knowledge-medium/pr-preview/pr-1876/src/data/targets.js\":\"c33721e4b52f7b51\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeColors.js\":\"c9aa4ff8fb3b64f5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeDefinitionMetadata.js\":\"365f6c8a5ad77c4a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeDefinitionRegistry.js\":\"9cb5f31934e312b3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeExtraction.js\":\"f18b48defee5a89a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeInitialValues.js\":\"f4031115d6f9429c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typePropertyGroups.js\":\"b19e7bf675f8566a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeSeeds.js\":\"f54be732bf50f32b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeTagger.js\":\"e205e37a14537410\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typedRecords.js\":\"0ad50b86c11b2abf\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typesPage.js\":\"20dff2b2b887f457\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userPrefs.js\":\"d76ae235e0c2ad9a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userSchemasService.js\":\"cdb9dd10a4aa8da9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userTypesService.js\":\"93221c8d2db1e497\",\"/knowledge-medium/pr-preview/pr-1876/src/data/valuePresetRegistry.js\":\"bd2a9e8f28b0baf9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/visibleChildren.js\":\"fa014ca8c1dc9d4c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceConversion.js\":\"9f7d80891de7b610\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceFirstSync.js\":\"62759e54e98407c3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceIdNamespace.js\":\"e1e31a32482a86af\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceSchema.js\":\"684b0f0d8c041320\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaces.js\":\"aec1b9dd1094055d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/writeAheadLog.js\":\"0c76b8086dc742fa\",\"/knowledge-medium/pr-preview/pr-1876/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/BlockPasteShellDecorator.js\":\"241ceb3b31e87b53\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/atTrigger.js\":\"54d69a5c834701ed\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/autocomplete.js\":\"7939e4446686108b\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/codeMirrorExtensions.js\":\"7f8cecfcd7ee17ad\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/contentFlush.js\":\"bb202a67becf4181\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/defaultInteractions.js\":\"cfaf94b93e1fd25c\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/editSettleSignal.js\":\"4709b607ce823a5b\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/insertImage.js\":\"952277b8af084f16\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/referenceCompletionRange.js\":\"3e653b2f424b6a3d\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/referenceTargetTypes.js\":\"6d9db2dfaa880bbe\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/syntaxContext.js\":\"ff9a5e96c9c4335a\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/triggerMatch.js\":\"09c90fe47a08759e\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/AppRuntimeProvider.js\":\"51ae79ae600cb141\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/BlockFocusShellDecorator.js\":\"7582a78c1e408864\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/ExtensionRenderBoundary.js\":\"3f5f05d2541f41b2\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/PanelContentRecovery.js\":\"08f839df9f7c116c\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/apiCatalog.js\":\"420493edeb74d5f5\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/approveExtensionHere.js\":\"a281e4189f2812e8\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/armedCutAppMount.js\":\"147bc494a169d78b\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/batchableKeyedStore.js\":\"8d9b3e5e4c9973d5\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/blockInteraction.js\":\"dc00af28147b41de\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/blockSelectionAction.js\":\"7248e83b285b0826\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/compileExtensionModule.js\":\"bb0e8a7a723e86dc\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/compiledModuleCache.js\":\"6a95f169fe9bff12\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/continuousGestures.js\":\"36ea08a63e40aa77\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/core.js\":\"742c08ebef7dcb8d\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/defaultRenderers.js\":\"452ae6168455d0cc\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/definitionFanoutAppMount.js\":\"88a2daac04cf1407\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dialogAppMount.js\":\"bfcb0933de461dbf\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dynamicExtensionSeeds.js\":\"a1829cb7f9a578e0\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dynamicExtensions.js\":\"e846b6c7db8b4828\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/exampleExtensions.js\":\"a266aa542d5e960a\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionApprovalStatus.js\":\"3ce19248e918b994\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLoadErrorToast.js\":\"b4052546cb17cc0c\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLoadErrors.js\":\"e8ecbc0f44619ceb\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLookup.js\":\"823421b0fa8c59d5\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionToggles.js\":\"10dc17c8aed64d13\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionUtilitiesCss.js\":\"2684e8024463f605\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/kernelPageDeletionGuard.js\":\"feaa659e823c7b4e\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/liveRuntime.js\":\"b7419e4546c60ab1\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/openExtensionsSettings.js\":\"9b1fe18e05747f47\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/overridesCache.js\":\"62c844c47f091ead\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/pluginIds.js\":\"db97d2aa27b2f927\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/processorRejectionToast.js\":\"ccaf6350be55b868\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/runtimeActions.js\":\"69693738b3913dd4\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/runtimeContext.js\":\"e9b181e330cf3872\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/staticAppExtensions.js\":\"b6764556ab85338c\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/staticDataExtensions.js\":\"2b608735cefe11a8\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/toastAppMount.js\":\"2bb60f0fa10d5253\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/useOverrides.js\":\"d5f2d076a63182de\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/useShortcutSurfaceActivations.js\":\"22ec1d5812ce1bba\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/discoverToggleTree.js\":\"977ca823bb193b3a\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/facet.js\":\"cdbf9dd703b87781\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/resolveAppRuntime.js\":\"f6892011ab9e8dd3\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/runtimeEvents.js\":\"043e91a6e612dc12\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/togglable.js\":\"a5aea1dc79bd4453\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/variantFacet.js\":\"01f81387b6ff9fc1\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/verbFacet.js\":\"e79187424304c9ca\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/block.js\":\"31cceb8f50b559b7\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/focusedChild.js\":\"ef8878eef960cfaf\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/propertySchemas.js\":\"b3c0d7f4da41ee5b\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/typeRegistry.js\":\"4e2e14c9fca6d073\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useAncestorCrumbs.js\":\"ae4d3f88aa787849\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useAutocompleteListbox.js\":\"f448a16843ad27a6\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useDebouncedSearch.js\":\"0f96b575989f2da3\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useDebouncedValue.js\":\"181eb3563192a46f\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useIsFocalRender.js\":\"cf60e74ee796b898\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useIsReadOnly.js\":\"29892b3d75b2f75c\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useMaterializeBacklog.js\":\"f23035621c3a74be\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useMinuteClock.js\":\"98a722871c0eb769\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/usePanelLayoutProjection.js\":\"baf294f30ebdfe73\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/usePendingInvitations.js\":\"030465203b9cdf92\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useRendererRegistry.js\":\"6ce24b6bf41719e3\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useRetainedFieldRows.js\":\"ccb5dc7cd9a0ec35\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useWorkspaces.js\":\"901ae0d73d9cbd5b\",\"/knowledge-medium/pr-preview/pr-1876/src/lib/utils.js\":\"117d5a958c31373e\",\"/knowledge-medium/pr-preview/pr-1876/src/main.js\":\"284bd94b50077c8f\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/MarkdownImage.js\":\"686b70a41bab412e\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/blockSeparators.js\":\"a6f623fbd13aa9ba\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/context.js\":\"59322c43ef0cb210\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/defaultMarkdownExtension.js\":\"54be3753bae3ccbf\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/extensions.js\":\"a2b473ad65cf63a7\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/renderMarkdownHtml.js\":\"b92fd0567ad52bb5\",\"/knowledge-medium/pr-preview/pr-1876/src/minimal-editor.js\":\"0c686fce54f33d19\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/armedCut.js\":\"104103dc93abc7b4\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/captureMediaVerb.js\":\"9e9ac51b27179d56\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/clipboard.js\":\"ac5e02dd15de61ee\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/decision.js\":\"28d7e964783ed720\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/operations.js\":\"10d446c635030105\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/account-header/AccountHeaderItem.js\":\"9bb69a05fe8eec95\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/account-header/index.js\":\"ead06befd0514724\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"6d6f37d1c45c2703\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/askAgent.js\":\"1e3d79926efa5296\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/askedStore.js\":\"c47e91b720232983\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3bfbc6aee8b27136\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/chipState.js\":\"14c8adac6ee0ebc7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/dataExtension.js\":\"128942d80c90fbcd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/index.js\":\"9521f363cb529f3f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"65ac26ddc1dae945\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/schema.js\":\"032f67c9219eb63f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/AgentTokensDialog.js\":\"be2e85678b722ff7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/BridgePairingDialog.js\":\"264e718c275eb0e7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/addMedia.js\":\"b554e06ac0ed0836\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/backlinks.js\":\"78d146de9c310f2f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/block.js\":\"4cda874a012536be\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/context.js\":\"fbc7d8c97998f2da\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/displayIds.js\":\"388e6eaa4dce70e9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/index.js\":\"1a7695d186fdbebc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/outline.js\":\"4ece49e4001f65e3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/properties.js\":\"042369df5b985f87\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/refs.js\":\"1ef0cb37524f7745\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"fe9fd40e653027ba\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/search.js\":\"05e0de58286c8815\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/shared.js\":\"33f4d5e746ebcf5e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"04d0cee87b999d9e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/text.js\":\"bd2ea43d36e81f96\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentWrites.js\":\"02daa176504405ab\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/authoringCatalog.js\":\"5daa62e6705d89be\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/blockRefTargets.js\":\"393d7105d1b907ae\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/bridge.js\":\"364b99b1a7a2be44\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/bridgeLoop.js\":\"c8fb7a870cefff0a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/changeHistory.js\":\"1f992f47c34a8a25\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/commands.js\":\"69a159d91a4872d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/commentsCommands.js\":\"fcf5722960554131\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/dataExtension.js\":\"e58b041214f25d21\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/dataModelGuide.js\":\"1a4e9fc0bec83d6c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/describeRuntime.js\":\"b557bb700d7525c8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/extensionLint.js\":\"f64afdfbbcaea369\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/grainAudit.js\":\"42e79863a49cc5b1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/healthCommand.js\":\"28d20adfa86ea36f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/index.js\":\"d9f874b2527f280d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/presetIdentity.js\":\"d078908617d17851\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"84cbec5bae18a5cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/readMedia.js\":\"f2c216320dba7dfe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/schema.js\":\"5a7f6259ef90856d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/serialization.js\":\"9f9e3653a6efd7b4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/targets.js\":\"5f7780091fd6e7cc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/tokens.js\":\"7268f0b5bf1f96b7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/watchEvents.js\":\"922c7e35f653de36\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/workspaceGuard.js\":\"8dcecee0521fbadb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/writeCommands.js\":\"1a0066841ef554f8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/AliasCollisionToast.js\":\"18df9d8294ef7125\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/DuplicateNameBanner.js\":\"61e2f82a78008e9c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/collisionMerge.js\":\"3c90c935d4f5d408\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/dataExtension.js\":\"9b3bf4631a30f7b0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/index.js\":\"5adee58f99b78705\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/mergeCollisionAction.js\":\"c11c450faf8ed884\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/pageStyling.js\":\"2cd78254efe98707\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/rejectionToast.js\":\"e94a850bc591c3e4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/syncProcessor.js\":\"2582e5e45fea49ed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/actions.js\":\"6e5ba561462a56d1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/addComment.js\":\"71b9436aac642594\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/anchor.js\":\"c387410966c9d4a0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/anchorState.js\":\"4b587ea03e14dffe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/commentLinks.js\":\"6eb8174847a1a3d4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/confirmThreadDeletion.js\":\"439f466ff7a73186\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/container.js\":\"e2a5a23f0ed2d176\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/dataExtension.js\":\"a49a089f2ec30cd1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/deleteComment.js\":\"431bf9e470411be4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/highlights.js\":\"7d9b681c94b6a3f6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/index.js\":\"d303a5c5e2acb828\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/linkedCommentsPill.js\":\"f73124260f23e805\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/margin.js\":\"d50a9a373071ee16\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/marginAnchorLinks.js\":\"97a850c0ae717483\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/marginSchema.js\":\"8cf86c83a77b3e02\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/newComment.js\":\"8149ae92918d0282\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/ownThreadPicker.js\":\"784188709911ddde\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/placement.js\":\"224535fbc92d4eb8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/queries.js\":\"a7aab983f2e54588\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotePosition.js\":\"348539c972ac0418\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotedIn.js\":\"4cc7177f9e0f467d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotedRange.js\":\"6f4adc172e9035c2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/rangeRefs.js\":\"2afcf95c04105580\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readHighlights.js\":\"2c886c9da0627dcc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readSelection.js\":\"8a38af242d54af44\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readSelectionUi.js\":\"d86bc2cd7d73f3ed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/reanchor.js\":\"13244edc6178743a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/schema.js\":\"bf410e75c3729b1a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/scope.js\":\"b2106505e5c9ea67\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/scopeThreads.js\":\"9a6128eb1dc02a90\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/splitRetarget.js\":\"7b29bada10ad056a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/suggestionCard.js\":\"803916c933e6564a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/suggestions.js\":\"da29f151e2c14822\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/summaries.js\":\"5b4c7ead4afc2aba\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/summaryBatch.js\":\"75eaa4085f480cc1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/surface.js\":\"a173ad7db764b95f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/threadNavigation.js\":\"c175f9d2de746e26\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/threads.js\":\"d212e600498813db\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/ui.js\":\"9d2e427d7f8641ed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/uiStore.js\":\"80eea9223c2652bd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-intents/appIntents.js\":\"1f6e7ebdc9e37031\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-intents/index.js\":\"6e7dc13f5f11df8e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-update-prompt/index.js\":\"605a7955e9036dae\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-update-prompt/status.js\":\"ab36fdcdbe52486b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"1cc54d93c2ac555a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaBlockRenderer.js\":\"52f0227b6da7369e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0ff56e29bfd7ebea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaUploadReconciler.js\":\"227f5cda83227b92\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetDownLane.js\":\"a88ba12ba034d3f8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetResolver.js\":\"af44d26872bd4e6e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetUpload.js\":\"0fee44635fdca2aa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/attachmentCleanerIO.js\":\"624b4e84aee02489\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/supabaseAuditIO.js\":\"cdf04a53b4a325fc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/blobStore.js\":\"19ba22166ddd1eeb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/browserMedia.js\":\"be99a78402560dc5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/byteStore.js\":\"fc83926e073d2bc6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/cleanerIO.js\":\"295c6e360502210f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/cleanupAttachments.js\":\"0a3fcfc8374215a9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/dataExtension.js\":\"99b34ac54991879a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/downLane.js\":\"d6851a32bb038509\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/index.js\":\"2751cd21a2bc814c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/insertImageContribution.js\":\"f6fd27c386fe7d83\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/laneArming.js\":\"95687d70752e64c6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/laneLock.js\":\"3b9805884f06e1a1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaBlock.js\":\"97158275725fb640\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaCapture.js\":\"1d45f4c997d0dfcd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaLanes.js\":\"88428eb9c2ac2fb5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaViewers.js\":\"6ca1bfe401aa37d6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaViewersFacet.js\":\"8479e88be5f38d0b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/pasteCapture.js\":\"14f8420f7d140fcd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/resolver.js\":\"5b531715096582b9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/retryUploadsAction.js\":\"28d3a19ca7355ea7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/storagePaths.js\":\"54a26f49e024f46b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadDrain.js\":\"ddefebc2b1e0029c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadLaneStatus.js\":\"7de64b040f817e12\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadReconcile.js\":\"9aa20750f2ff33e9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadRecovery.js\":\"42efa9cc176c7cc2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadStore.js\":\"e610fdf8e49fa955\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/useAssetObjectUrl.js\":\"6e339d94dfa41b45\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"287022d8b69663bb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/BacklinksViewSection.js\":\"74f57d59c4a3f690\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/facet.js\":\"a8fc6eb2999c1044\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/index.js\":\"2ba27798f9d94109\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/prop.js\":\"6273721928462c48\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BacklinkFilters.js\":\"bb9e713bb9e55a81\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"0b0bd330b84991de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BlockEntry.js\":\"b357228bbd342225\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/LinkedReferences.js\":\"9e72494fad22f127\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b6ae159a403aeaa3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/dailyNoteDefaults.js\":\"a33dc49ed1df3a8c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/dataExtension.js\":\"c6365bc621d9ee8b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/edgeExclusions.js\":\"b7d2b00273d7cb9d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/filterProperty.js\":\"9949491c80c6c70d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/index.js\":\"db42ef57e34ae821\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b50ad0632a02d460\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/applies.js\":\"710841bc6343ce9a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/countQuery.js\":\"cc6308ad5572ff15\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/expansionStore.js\":\"17d9340282c5c486\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/index.js\":\"6ddf10b53dc309a3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ac332c03a8e779a4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/presentationInvalidation.js\":\"8c549eab02f6a0d1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/propertyEditorOverride.js\":\"d26d0222e63c9e56\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/propertyFilter.js\":\"73e989ad18c540ff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/query.js\":\"de62f82a8d58b1f8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/resolveFilter.js\":\"36a09f7957d0afcb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/sourceBatch.js\":\"b060db13103474ff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/sources.js\":\"834b44faf48d20e8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/useBacklinks.js\":\"3315ba61c31f9e2b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"28c850781234fcae\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/BirthdayCelebration.js\":\"c3a24ac610a84d9e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/BirthdayOverlay.js\":\"2b03f3c5f552d802\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/gate.js\":\"78c18c61854402d5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/index.js\":\"b0d325721a6a1acd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/wolfTheme.js\":\"ff075279b990a9eb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/BlockDragLayer.js\":\"ef68edc2d93569a4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/dragController.js\":\"b4cece9d0a9b7421\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/dropTarget.js\":\"14bc7cdef7a8e1e0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/index.js\":\"b75dc3bf09d1f1a4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/projection.js\":\"0ddb1be92024415f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-info/BlockMetaCard.js\":\"40d91133db7c0a7b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-info/index.js\":\"0eb45eb0564d4483\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/AddTagDialog.js\":\"88547deca6f4aac6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7ad6056fed317eb4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/TagNameIssueHint.js\":\"274c3bb939544b25\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/addTagAction.js\":\"e671a3f3b018e541\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/appendTag.js\":\"51255bb849e0bbb8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/config.js\":\"b945b5e742d083cf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/dataExtension.js\":\"92d4e55bd01ca3a0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/index.js\":\"a2566a76f6f10918\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/propertyEditorOverride.js\":\"c3dc8a856dd1a6f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/BreadcrumbList.js\":\"35c7016cda908e37\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"36309201284311f8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4fd111bdc8e320b0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"bb285d97d64db3c9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d7a6a1f9237459c6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/index.js\":\"4dbef1e0882dc9d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d7d8f82cceda4f27\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/CharacterCountItem.js\":\"fd7cbad957e9ecbd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/ProfilePropertyEditor.js\":\"1f0f00a5f4206f42\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/actions.js\":\"d8a2018b61eff0e6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/blockType.js\":\"307846e31a1767dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/charCount.js\":\"a88261a8b8090ba5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/dataExtension.js\":\"6fbcbd076f2b9b14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/index.js\":\"cb6c6905ecc914bb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/profiles.js\":\"1faa0dc9863e94fc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/properties.js\":\"46b92b7bacd92816\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/textCounts.js\":\"e19890ab62cb4d53\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/colemak-keybindings/index.js\":\"6ad2e612eca529a7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/CommandPalette.js\":\"e279c7ba40d0dded\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/HeaderItem.js\":\"c122e4162b38e830\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/context.js\":\"887231a01ba3482e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/index.js\":\"75575fed4385a94e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/selection.js\":\"72be3a91a5198c48\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/toggleStore.js\":\"4b5d89f12e406a4f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/useCommandPaletteActions.js\":\"c3009767dfe353a7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/ContributorBadges.js\":\"7d669564250639ac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/author.js\":\"faee449c549d7db4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/codeMirrorExtensions.js\":\"ca8bcac8983978eb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/dataExtension.js\":\"a427550fe5f88c8b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/index.js\":\"653b5d86b638abf2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/mentionAutocomplete.js\":\"fbb826a7aaaa126e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/processor.js\":\"0f237ef4d7f4cc53\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/profiles.js\":\"1b9e68c2f61d39aa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/queries.js\":\"c2ed3bacdc4ddb11\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/schema.js\":\"d3b2347f9b063246\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"335def528c74d309\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/followOrigin.js\":\"96d3ff79090790c4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/index.js\":\"4ebc2ef0c095f6af\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2e54eb88a1b31946\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c3611ddff4ba6cc8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/CalendarGrid.js\":\"bc3eeac4667f15a1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DailyNotePicker.js\":\"ae8af1fe18881cff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"536907138b3c2ad8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateNavDecorator.js\":\"b294cea6a8a90e2f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateScrubOverlay.js\":\"7a4da8fb4177ea5c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/HeaderItem.js\":\"5bc2e9e33512e727\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/ReschedulePicker.js\":\"3dfbb69354101860\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0064ac2a3c60dd22\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/actions.js\":\"d0f6254e3c6d1d36\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/blockDateAdapter.js\":\"1e8bab6fb84d3f64\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/calendar.js\":\"98bbf382d550c689\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dailyNotes.js\":\"e770428f19ca908a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dataExtension.js\":\"2ef10d232fa0f981\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubActions.js\":\"d570615f6d8896eb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubGesture.js\":\"8bedb31e8921ddb7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8e50ddc30ceafe50\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d625ca72a39c06da\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/deletionGuard.js\":\"7f6b61012e1c506c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dueQuery.js\":\"ac19078b309b4940\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/index.js\":\"a2811b631059ab91\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/landing.js\":\"6c3e05b8708ebf22\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/localSchema.js\":\"94fcc8daf774f7ba\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/referenceDateAdapter.js\":\"2ff75a383e2c1491\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/rescheduleAction.js\":\"df664c4a82011888\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/schema.js\":\"2f2e36d53fb08006\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/spreadBlockDates.js\":\"924f4ef52fdd745b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/spreadDatesAction.js\":\"e286cde6df78867c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/today.js\":\"8d6ac48f806353f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2f3dce8a9be0b3ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"165611c0ff14025f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/audit.js\":\"67b2522e75811df7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/auditAction.js\":\"9b59f03dcb90228d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/auditRanges.js\":\"2a733f30efa6ba74\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/diagnosticsSource.js\":\"3bed76bd34fdb4ca\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/divergenceScan.js\":\"fc8c3ca5d5f0b101\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/index.js\":\"f5904e99455f392a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/propertyChildrenChecks.js\":\"7c9f30764b003edb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/referencesMirror.js\":\"ffbcad1f696d3552\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/rowJson.js\":\"ac7f666da62a22cb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/schedule.js\":\"3baeb31a018c2794\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/store.js\":\"86d61f0688ef61a5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/action.js\":\"e0c94d7849547e31\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/index.js\":\"57e5088b4834cbf0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/plugin.js\":\"b6c7b61ec039da71\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b6a93b30adb8ceec\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/actions.js\":\"d10a4f3cb29fba89\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/changeMarker.js\":\"ca5dba892baa4c0c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/diagnostics.js\":\"0c0727877dc90d32\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/fileSystemAccess.js\":\"9ff8e4d66bf610b8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/filenames.js\":\"3fc62131bbd7c5e8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/index.js\":\"587cc82ee4cdcb9e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/mirror.js\":\"03602b10b7da4da1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/runLock.js\":\"0dd04ecbeff94e42\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/runtimeHealth.js\":\"0afd8a0043772304\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/schedule.js\":\"894327cf05baed63\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/store.js\":\"94fae6ee79f62ee6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/default-themes/index.js\":\"6a3e6dd4f478fbc2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/default-themes/themes.js\":\"eff88c8758737adc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/diagnostics/facet.js\":\"80a4c4d5a359012b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/diagnostics/useDiagnostics.js\":\"df6739dad1799321\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/dismissals.js\":\"84f3ca81e3b28823\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/index.js\":\"5eb8e360006dccdc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/status.js\":\"47ad9c4afe9f8bd9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/store.js\":\"a2b0de99850c5f50\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e80fa67d62871112\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/ExtensionsSettings.js\":\"7ba469fb77538281\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/actions.js\":\"86db1f4c98b59ee2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/config.js\":\"acf84f83dd0947be\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/dataExtension.js\":\"a0a09880e0cd596f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/effect.js\":\"0138fbd468e8d422\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/index.js\":\"0c57bc56787b3185\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/propertyEditorOverride.js\":\"6cb23198eb4094b8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/useToggleTree.js\":\"ed8bf264181896a8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/ExtractTypeDialog.js\":\"73807244776e1876\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e59d29b0a25553c8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/PropertyShapePicker.js\":\"b595255dbc94deff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/action.js\":\"4c9fc600f94a64f7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/index.js\":\"83871b692004b980\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/FindReplaceDialog.js\":\"7538f78aa8c56a84\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/HeaderItem.js\":\"5762207402272fa5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/dataExtension.js\":\"e33f59cf57a1c0f7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/index.js\":\"b181446716c98c55\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/search.js\":\"448043541e158083\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/toggleStore.js\":\"48ce73ddfa3622e6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/LocationPropertyEditor.js\":\"23b0945ca3eacb19\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/MapView.js\":\"8197fefaad17b346\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/blockTypes.js\":\"c5f11bd07d9120bf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/codeMirrorExtensions.js\":\"4437b2da164c3c7e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/createOrFindPlace.js\":\"3d6cb5b9032d1617\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/currentLocation.js\":\"e96961e37ca4e01c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/dataExtension.js\":\"56ba230a4e2e60fa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/geoContentDecorator.js\":\"ef8da117d4190bec\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/googlePlacesClient.js\":\"3ba9ccc376cb6eaa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/index.js\":\"2d94c611dbfbdefc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/locationsPage.js\":\"758b41fc698b1f74\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/mapViewport.js\":\"a74d4d0083e3a4e8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/pickCurrentLocation.js\":\"bbc99480dc397ab1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/placeAutocomplete.js\":\"9f2195ce7b79a7a7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/placeNameCollision.js\":\"753dd62a0c927363\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/properties.js\":\"0a8ad471de8f9e35\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/propertyEditorOverrides.js\":\"7b08ce5432042de6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/query.js\":\"472459c252742a47\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/usePlaceSearch.js\":\"ecd36110783181a3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"e49398771547e007\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"5833c99bfb9af108\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"efbc7cabb8ed658b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/config.js\":\"70dbe6382ed9b097\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/dataExtension.js\":\"511c025279ff087a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/facet.js\":\"f113d417c7c7dd2c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/grouping.js\":\"8fcc2be1662743de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/index.js\":\"dcd1f0be78e8b0ac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4077b93af28a8ba5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/query.js\":\"2c7bf393c9db653e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/resolveConfig.js\":\"a377807e0de2771a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"336843d7061222c6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"7324feb939227bc8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/HtmlDocumentContent.js\":\"c18850242c443f66\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/HtmlFrame.js\":\"2292fa8cca99075b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/actions.js\":\"0d184dc402deb5fe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/blockType.js\":\"93bc4c1b0adfefa1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/confirmRunScripts.js\":\"66f53cd592012421\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/dataExtension.js\":\"ac2bdd25882900f6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameAnnotations.js\":\"2573c9ec78611375\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameDocument.js\":\"a7902057853989c3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameTheme.js\":\"e0ede38eaf20ee9a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/index.js\":\"28dededb39ccff9e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/scriptConsent.js\":\"b4af66a0316faa97\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/sourceMap.js\":\"157ea5229d9b5eaf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/useDocumentScripts.js\":\"ba2add504bf98606\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/index.js\":\"cff70787d95b7fd3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/record.js\":\"3c2114ab21b99456\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/recordStore.js\":\"70731833d274fef0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/responsiveness.js\":\"24e75a39621a8559\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/schedule.js\":\"cfe26f80ef891c91\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/sessionContext.js\":\"a6936b7b2c6c8e8c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2539e927fbfef905\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"0e95a34a8d2f764d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/actions.js\":\"bb85e83f8cf5d677\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/config.js\":\"11613836b569f95f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/dataExtension.js\":\"3e939cafb103d74e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/effect.js\":\"a4c5a25165eece6c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/index.js\":\"2565ce61789205e9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/keyCapture.js\":\"4642a4f700161f21\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/overrideStore.js\":\"a70676f3df0577b5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f6ffd59fb64035cc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/HeaderItem.js\":\"6f332900f22edfb7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/LeftSidebar.js\":\"8504d7d3230bf74f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/actions.js\":\"56ef6b3f222d7076\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/facet.js\":\"afbce94f4c9eaed8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/index.js\":\"ca3e3d48ba2fcd6b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/shortcuts.js\":\"52ea7f17c939586c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/toggleStore.js\":\"4428c77affed53cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/MergePicker.js\":\"306c218884e3515d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/index.js\":\"17af81c22a1e29ac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/mergeAction.js\":\"41e2a4d456130ac7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/strategy.js\":\"8bf4b9b6f3702501\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/Button.js\":\"d3326191465742c3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"45c522e0898e3386\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a1612fb3ec47b108\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/facet.js\":\"b59107237315a2ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/index.js\":\"78ead4c6afa14d9a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1c7e8e075d12e492\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e1a028b5baa86cf3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b5c129bba8e20970\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/facet.js\":\"727d0a90061e0d42\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/index.js\":\"e70905d43eae0d3e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/MoveDestinationPicker.js\":\"71f10a57de1fac91\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/blockSubtreeMembership.js\":\"605a305076825479\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/contextMenuItem.js\":\"a7fcbadfdb2d17f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/index.js\":\"dd75c54eca4a8c9d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/moveAction.js\":\"245ed4f5e8c6ce70\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/moveBlocks.js\":\"b2c3d454d2482eb8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/selectionAfterMove.js\":\"47568b1cb439f368\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/TutorialBanner.js\":\"b95add9ff75b0d56\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/action.js\":\"24ed86cb715b8b1b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/bannerDismissal.js\":\"6b3fdcdccd7fccd2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/documents/cheatSheet.js\":\"b9776c47871d62d9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/index.js\":\"eb4f39b282828a81\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/keys.js\":\"d74f5224eba5e086\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/landing.js\":\"3840687643179338\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/outline.js\":\"2dd427a76651c401\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/seed.js\":\"010e7031a95fb1c5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/PerfTrendDialog.js\":\"86f3b9b4e0284827\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/analyze.js\":\"bda6d99f9fd783f4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/diagnosticsSource.js\":\"2dc62b33a1ab56ec\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/index.js\":\"f3c05ce03aa24155\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/load.js\":\"bf370c957b544b4f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/monitorRun.js\":\"0d70c0a7c2225136\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/schedule.js\":\"47f4ce5e161f7b72\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/series.js\":\"aa5d0c24d0be4623\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/store.js\":\"f5c94ca4158eb025\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/trendAction.js\":\"2eddfbd2ce607957\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/verdict.js\":\"f1f3b19b57a251c5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/clickToEditAction.js\":\"ccedd7c4f3f8f389\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/index.js\":\"c63b19fd6bdc37f7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/interactions.js\":\"3b6913aad7b8c42a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"954efc684c458d9a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/MigrationGate.js\":\"9863bd9c05f04d54\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/MigrationGateDialog.js\":\"8f5e96916a8fc60c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/action.js\":\"686092e41a4b111a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/index.js\":\"92e84c3ec99606a8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/localRunMessage.js\":\"4e5379aaa817c501\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/plugin.js\":\"516c01ddfe8c72f3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/progressReport.js\":\"f429c8dd8dc0ed57\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/sweepProgress.js\":\"a9f5a66e26e9a5b5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/FieldRowRenderer.js\":\"b459f19ad55ba69f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/ValueRowRenderer.js\":\"91006b96e6cab169\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/actions.js\":\"f2be66c88f51afad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/autocomplete.js\":\"6790592715fe5e08\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/fieldRow.js\":\"6289ca7e2731b92e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/index.js\":\"c9bee47e7d8291d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/referenceWarning.js\":\"c2bfbe408f436de9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/valueAutocomplete.js\":\"ca73958f3d53576b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/valueSchema.js\":\"cea4d61147a20075\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/HeaderItem.js\":\"e5ef38ac41fb8feb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/QuickFind.js\":\"637299fc3ab80e0e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/index.js\":\"4eb3164730cfa972\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/recents.js\":\"a8952b6857273367\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/resultItems.js\":\"bc1db4542ea8e6f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/selection.js\":\"1167e30342de5bce\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/toggleStore.js\":\"3688db9bb93d8546\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/HeaderItem.js\":\"47c66eba3db4d9e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ded8264e37d4d985\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/grouping.js\":\"85697336419ad2c6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/index.js\":\"7c035db60b24236d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/target.js\":\"b45ac6ec32f816b9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/codeMirrorExtensions.js\":\"c0411592b1a816d9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/contentPrefill.js\":\"78e76689b6233c2d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/dataExtension.js\":\"ba9d5316ad9a234b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/index.js\":\"55242f968c6a94ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"16450602701a43a1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/invalidation.js\":\"fe0e29ab485b0773\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/localSchema.js\":\"4d308d2274e89d00\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/blockrefs/index.js\":\"19df50d209fca63c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"a820f2467abc52dd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/index.js\":\"b8b7d11bba0c8a05\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/referenceNode.js\":\"1fea2c000717f39c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/remark-reference-occurrences.js\":\"5f1d47ff50304a2b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f5f769904b007207\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/index.js\":\"2c62eb4968ec1f45\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"d1299bf01cbc975f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"75b72d0ed209fbad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/mergeRetargetProcessor.js\":\"a724f096ee65d96e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/parseFence.js\":\"7f80ffd9573d2c87\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referenceParser.js\":\"641bee3fa01cf60b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referenceProjection.js\":\"6547925907c702ac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referencesProcessor.js\":\"dfe90da4c940bda6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/renameProcessor.js\":\"0a05c2591c12305c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/spanReplacement.js\":\"6738c4d04d7d68ba\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/htmlToOutline.js\":\"3d269c8e3c7bcd42\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/index.js\":\"40ee14e52a564aee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/normalizeClipboardDom.js\":\"d8196176e4b0e1b6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/pasteDecision.js\":\"bd755f5865d43a1e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/action.js\":\"75f6c3affa61c17b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/blockIds.js\":\"c6f702f23361528d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/content.js\":\"309706761737f2c5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/effect.js\":\"4db89eb4f5e39cf4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/ids.js\":\"cc99e5dc5ef7876a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/import.js\":\"7fe15e8861439288\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/index.js\":\"a27aa31328f37dd5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/plan.js\":\"af87472d0a14477e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/plugin.js\":\"0584da5aa1f0685c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/promotion.js\":\"344bcf0349820e9f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/properties.js\":\"3b54b2987e0cdcd4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/references.js\":\"2cb538455f89603d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/report.js\":\"ef73fa3d987ceb8e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/roamMemo.js\":\"a164f0c1623bfa63\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/runtime.js\":\"8640c7f793063fbf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/schemaReconciliation.js\":\"ac0456d547994912\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/srsMarkers.js\":\"c7f3c4996c6073cc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/todo.js\":\"0b42fde15ce9c4b3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/typeCandidates.js\":\"a02107d0fb3dee1a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/types.js\":\"7204523e94ee626c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/search-health/index.js\":\"3b63b005a6f84153\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/search-health/store.js\":\"ac14eba016498b3f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/HeaderItem.js\":\"98578c3f4bdd6782\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"1dd057be76286263\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/index.js\":\"b556446c843aa249\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/model.js\":\"b00ce77d5510f0f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/toggleStore.js\":\"0be7a351771660b9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/useKeyInspector.js\":\"89e396c4538ef30a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"25d3cc0990d8ca40\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/ShellDecorator.js\":\"af910b86230990ab\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/actions.js\":\"616a7a5fa73d92b0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/exclusionsFacet.js\":\"be0e42c7b4a2dc3a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/index.js\":\"7c10690eab5c1f60\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/shell.js\":\"1a60d7ee65c8205a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/surface.js\":\"1860a0038be7e19f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/walker.js\":\"994e2381181784bc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/RescheduleToast.js\":\"7f24ec806a2113e5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/dataExtension.js\":\"032d2a923dd41900\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/index.js\":\"fede1914f6a14132\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/indicator.js\":\"bf34314f4b5c2588\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/moveSrsState.js\":\"76c7a592f9aac6e8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2a45b128856b5e42\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/scheduler.js\":\"b996591990baf4f1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/schema.js\":\"2a5ca265aa1745fb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"4339dc477599a84d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/srsClipboard.js\":\"2e410668f69c77f4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"7a4b030dcbc2a3e5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/DailyNoteReviewHint.js\":\"a2d63510519a2604\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/DeckPicker.js\":\"15e9d94e520037c1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewControls.js\":\"46beb26c89d032e5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3db48c398b179040\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewSession.js\":\"9ab6e85f5a84c217\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/actions.js\":\"be4c134e2b935133\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/archive.js\":\"66ffc78a9d5b8039\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/dataExtension.js\":\"1169d44172ad9c50\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/deck.js\":\"949c4e0d06ea60c7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/dueQuery.js\":\"41cc7301ea38b045\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/gradeDecision.js\":\"e8e0f45f9bb8ace6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/index.js\":\"17aecbfd773b615c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/keyHints.js\":\"732738cec466fce2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/reviewCardLayout.js\":\"410d3ba56f425a52\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/reviewProgress.js\":\"5409c1acbc6889f9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/schema.js\":\"a435b875cb7f2d06\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/useDueCards.js\":\"ff84a8e378b22fa6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/startup-metrics/index.js\":\"4a3bf7ceba57170f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/startup-metrics/record.js\":\"9cf648d5f751af95\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/index.js\":\"55d02a9c4201aa60\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/persistenceStatus.js\":\"9b4fe16d32ab5ae0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/requestAction.js\":\"db6e6a5d2c3a1207\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/TypeChipsDecorator.js\":\"53571cc27551378c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/codeMirrorExtensions.js\":\"381d1ec539286ff3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/index.js\":\"2deaba0b6f0acac1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/typeAutocomplete.js\":\"b7ce7625b85711a6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"1a86c50f589cf934\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/actions.js\":\"8dba2aee2f6121eb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/anchor.js\":\"1f84027f6a40a677\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/events.js\":\"9afebe0b4cbb6f0d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/gestureActions.js\":\"5854668e8d1c75f9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/index.js\":\"01c10070c06f0419\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0c97d9a6d227a97f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/collect.js\":\"4b61082b31141ac0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/index.js\":\"1bd28ca53e3b0ce3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/record.js\":\"583349f65157e6b4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/RejectionDialog.js\":\"d3f7433203d1d205\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/SystemStatusHeaderItem.js\":\"0e81e2fa1f2b0f4c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/index.js\":\"b4f47688f7489cd3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/model.js\":\"61ae613e200c3efc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/queueCounts.js\":\"5ca7be0153b0b32c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/rejectedHelpers.js\":\"136ce98720830dda\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/rematerializeAction.js\":\"6b1dcb8983837a7a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/useHysteresis.js\":\"11973e3bfe9b8440\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/ColumnHeaders.js\":\"e333202e7736e245\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/QueryUi.js\":\"10ba99fd6dbfb02d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/TableLayout.js\":\"cb975de9eb3853a5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/actions.js\":\"3fe4e5ad0886b9cc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/cellEdits.js\":\"266ab03666305fe6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/childrenViews.js\":\"f3b858d0287405f4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/columns.js\":\"7cd865ce991755da\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/controller.js\":\"1161503d45a58d05\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/convert.js\":\"d587107b817c5387\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/dataExtension.js\":\"0b27fa857955dc36\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/index.js\":\"5f13e8e562c36dca\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/keys.js\":\"b58316bdc86bee43\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/model.js\":\"81f54636f30c208b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/backfill.js\":\"a9c18df683a8286e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/completion.js\":\"dda3dc93ff73ba02\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/format.js\":\"4f40cf6fba7725ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/parse.js\":\"d50a2627f2438edd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/queryValue.js\":\"4f2ae5fbdf0ed77b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/source.js\":\"19222e47cd1fc3a8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/registry.js\":\"22e766e44b4cfe4f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/rowGutter.js\":\"fc9b7ec04782d1ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/rowVerbs.js\":\"59db52c255a71651\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/schema.js\":\"70831a104b0c2d65\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/sort.js\":\"6ae5e5db8c89a794\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/effect.js\":\"bdee10710bcf4f35\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/index.js\":\"2dd78a4203bac6b2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/theme.js\":\"818b11b55afeca59\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/actions.js\":\"88763b8ad4b11380\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/dataExtension.js\":\"ca20d99690a3de6c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/index.js\":\"e45e3a45d6a66602\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/schema.js\":\"1e311a52fcc677af\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f41269e68e1afecb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/actions.js\":\"aaa98db84e368164\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/defaultItems.js\":\"0b91b8f9a92630dd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/facet.js\":\"c7a2c46ac1e92c70\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/holdRecognizer.js\":\"14aba5c6949f3d7e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/index.js\":\"784050680d7e8d3a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/UpdateIndicator.js\":\"564b10d624df004e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/index.js\":\"08f96960c76c5232\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/loadTimes.js\":\"587654447164b941\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoNotesRenderer.js\":\"ab5b1c8e980c63d5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoPlayerRenderer.js\":\"3e3fa9fa08a459f4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoTimeStamp.js\":\"1a9ea82976cd4e5d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/actions.js\":\"a42bfe0788cd6cb4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/index.js\":\"d5b0621679b5dd4b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/markdown.js\":\"f8ee571deee42e34\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/notes.js\":\"47446c5af60ec639\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/registry.js\":\"db3ca1bf7bada06f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/remark-timestamps.js\":\"37165ef14a32713f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/view.js\":\"0be7e62a9d216d6c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/LinkHints.js\":\"b9001e5b633791c9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/index.js\":\"617ec58a7aab11ee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/model.js\":\"93cd1b3ad7527f23\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/settings.js\":\"b9c923ea0d56a583\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/actions.js\":\"cbf7a880a35d9b69\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/index.js\":\"442e1e05a816c12e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/interactions.js\":\"bdd909fe93eb8310\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/workspace-header/index.js\":\"489d6706d0bcadbb\",\"/knowledge-medium/pr-preview/pr-1876/src/registerServiceWorker.js\":\"31957297f4004a62\",\"/knowledge-medium/pr-preview/pr-1876/src/requestPersistentStorage.js\":\"a388c4bbb4ce38cc\",\"/knowledge-medium/pr-preview/pr-1876/src/services/authRequestDeadline.js\":\"14a58ca8926487f3\",\"/knowledge-medium/pr-preview/pr-1876/src/services/authStorage.js\":\"43afa724db76818f\",\"/knowledge-medium/pr-preview/pr-1876/src/services/powersync.js\":\"a68c3951e24592d2\",\"/knowledge-medium/pr-preview/pr-1876/src/services/supabase.js\":\"b60584c1fd5cceb9\",\"/knowledge-medium/pr-preview/pr-1876/src/services/uploadErrorClassifier.js\":\"17fc52e0a6231ab9\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/ActiveContexts.js\":\"35c7e024cb95f941\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/HotkeyReconciler.js\":\"2428cd5249319891\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/WipeLocalDataDialog.js\":\"d64a9a456a743e2e\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/actionDispatch.js\":\"2b953791191d3e35\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/actionRefItems.js\":\"817337a4170cc239\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/applyKeybindingOverrides.js\":\"7c1210937ea4c66f\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/blockActions.js\":\"823d1aad77d611ba\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/blockMergeGesture.js\":\"f7e38a4e82cb8439\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/canonicalizeChord.js\":\"65f7f2c3bb5edfb0\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/defaultContexts.js\":\"a61e3c799e51fcbe\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/defaultShortcuts.js\":\"55dfb739a63981f2\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/effectiveActions.js\":\"6ccacd18a4551370\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/gestureAction.js\":\"b149120fe23673df\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/gestureBinding.js\":\"2f4669a8e3ad2869\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/holdRegistry.js\":\"f6855e996d6f2755\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/keybindingConflicts.js\":\"1c725309361d87b1\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/keybindingOverrides.js\":\"6593dd87a45afb59\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/pointerAction.js\":\"29ce1c2b575ebe92\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/resolve.js\":\"770ecedd3bbbeed6\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/runAction.js\":\"fed0422ba41ec129\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/sequenceMatcher.js\":\"51868e3e0c273f76\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/types.js\":\"2e52668091a1486a\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/useActionContext.js\":\"f92e7a973748aeeb\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/useActionDiscovery.js\":\"01f9766dbbb6f87a\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/utils.js\":\"ec7b71d55e8f0c7a\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/bootStore.js\":\"6171545bca54a5df\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/previewDatabases.js\":\"8d325052c6789e3e\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/byteTransform.js\":\"bb06af78ec5c0e76\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/attachmentCleaner.js\":\"cb7ad2ebfbf08c4c\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/attachmentParts.js\":\"fdd64d77e0a9ee08\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/bundleParts.js\":\"d233a42155739f24\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/bundleRecord.js\":\"df30b14de43c27d4\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/manifest.js\":\"caaf872cba3892ba\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/takeBundle.js\":\"77d68b3fe9a059bd\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/verifyBundle.js\":\"b5ad05b7b241068f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/cleaningStage.js\":\"8fecf0ec3a4bb937\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionKey.js\":\"5f3eae62eae8e371\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionServer.js\":\"63e703cdca441c96\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/flip.js\":\"ae988ac026d43ad3\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/flipAttempts.js\":\"914a3ef1f0fd2300\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/pages.js\":\"ac001e625219ea2f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/preflight.js\":\"621b7c2f895b8410\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/reseal.js\":\"58339063bce3cf0b\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/runConversion.js\":\"69cac58b60739ac9\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/runLock.js\":\"67041be263c43be5\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/sealing.js\":\"93e0ae7bbf3a3c20\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/sealingStage.js\":\"a64f63de4616f764\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/stage.js\":\"52db775ffef8b0cf\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/verifyReseal.js\":\"6b3c45e04771f239\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/aad.js\":\"3f37f4f983d94c1a\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/aead.js\":\"8e2235d07f2599d3\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/base32.js\":\"0d21bbffce125189\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/base64url.js\":\"2f5b90d8faf87dbf\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/binaryEnvelope.js\":\"9679033182187a6b\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/byteAead.js\":\"0b850baaafae5b6e\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/canary.js\":\"1af1ac7c26c8b520\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/contentHash.js\":\"b98bd6524dd1130c\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/contentKey.js\":\"57798a55c1de1130\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/derivedIdNamespace.js\":\"c3db2b562714d006\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/envelope.js\":\"658c1c6df9a3b12d\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/hex.js\":\"6620b2f41d9c68bf\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/sha256Hex.js\":\"9e42efc747bdc9fa\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/workspaceKey.js\":\"4183c815b1776e3d\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/conversionState.js\":\"b1c6418c4852ab8f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4573b236648ec20b\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/pastedKey.js\":\"d65e740a04e40ef6\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b78d3b973c0ea915\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a5196f47f7e9bef6\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/keyStore.js\":\"2f7c9a12c4486479\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/mintWorkspaceKey.js\":\"1b61805f38c9ff56\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/modePin.js\":\"63b18b69d71face1\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/openWorkspaceKeys.js\":\"7edc2b23e7281327\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/resolveWorkspaceEntry.js\":\"763768fb094b531e\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/resolver.js\":\"dae8ee31a6c5fd8e\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/workspaceAccess.js\":\"aa68abfdc322b17b\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/transform.js\":\"e0f797e46f05971e\",\"/knowledge-medium/pr-preview/pr-1876/src/themeBootDefaults.js\":\"0bce1e76a7b5e602\",\"/knowledge-medium/pr-preview/pr-1876/src/types.js\":\"61c3ebc347050ab9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/ClientLocalSettings.js\":\"470c3e8386ac2e6a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/abortableSleep.js\":\"48ac41d463dd6f0c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/array.js\":\"67713ef131e5b5ac\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/backlinkAutocomplete.js\":\"63ef684f4ebd4faa\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/blockCrumbs.js\":\"75fd75f6afb5dbd4\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/blockrefAutocomplete.js\":\"e40a4142b71725df\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/cadencedIdleJob.js\":\"f6c0e17ad1064cc8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/callbackSet.js\":\"13222b32103a5630\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/clientId.js\":\"ab5ba156f72f7af0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/codemirror.js\":\"fa0a5cc1dd06b055\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/codemirrorCompletion.js\":\"c333d5b117f32143\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/copy.js\":\"587d299cd4130046\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dailyPage.js\":\"f087fc24adf4d2ab\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dbForensics.js\":\"e99a0b14c740848b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dbForensicsHooks.js\":\"83771574be409544\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/deleteBlockThroughUi.js\":\"59753590e622c9bb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dialogs.js\":\"750a8d2b2ee36f19\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dom.js\":\"4f76f46278cdc9cb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/downloadBlob.js\":\"909a96a49f857d68\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/drawnWalk.js\":\"90cefeeff5330a36\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/exportSqliteDb.js\":\"8aa26ece7daa725e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fileSystemAccess.js\":\"3e083d7ef1d1e340\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/flipSlide.js\":\"feac7f8ad24d7f0d\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fnv1a.js\":\"2914839b0e82cc74\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/formatBytes.js\":\"56697c22041b8a5a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fuzzyRank.js\":\"b4c4a1ccd263fcf8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/idbKeyedStore.js\":\"0a9c5f318789b670\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/idleCallbackPolyfill.js\":\"ac0edfa08a77aa00\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/keyboardAwareScroll.js\":\"fc41082527d882e0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/keyboardViewport.js\":\"37c6bace26992c50\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/lastWorkspace.js\":\"e7591e58ed965d09\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutColumns.js\":\"a8d32c64fbe77306\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutSessionDom.js\":\"312312bf4b4c3dca\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutSessionId.js\":\"02068a46f2e25774\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/linkClickGestures.js\":\"4843a7565fbef4f9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/linkTargetAutocomplete.js\":\"eb1aaae5d944c221\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/localDbCorruption.js\":\"2b3d75f49cca833b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/localDbRecovery.js\":\"bcfc19359f2147e5\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/markdownParser.js\":\"3561c59a9cf0ed97\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/memoize.js\":\"df25f11b1ad0dd71\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/nameFieldCommit.js\":\"bbcdc4d21d1e1b8e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/nameList.js\":\"213ab9202db481c7\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/navigation.js\":\"10e91e3b2ccb1a89\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/omnilinerNamespace.js\":\"56f60a76283cd414\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/opfsPageScan.js\":\"68a98923b56c2013\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelClearance.js\":\"bc222089bcceab93\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelHistory.js\":\"f0c71ff52012bfe3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelLanes.js\":\"42904e5ad0c883fd\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelLayoutProjection.js\":\"d199c6cc3cdb33ba\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelScrollAnchor.js\":\"fb1ce933001059d2\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelUrlFlags.js\":\"2afd88e1c26c69bb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/platform.js\":\"b7f52c0d5c43ac62\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/pluralize.js\":\"1b3b3f65174b3c68\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyCreation.js\":\"ca544431cf892887\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyNavigation.js\":\"67edbdc71888811c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyValueContext.js\":\"5238d27c2d16cd34\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/react.js\":\"992cd047c8a60d98\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/relativeDate.js\":\"d902809c763ecd3d\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/relativeTime.js\":\"e890939cd3d3361b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/renderScope.js\":\"c34f03d1e27bb0d2\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/resolvedThenable.js\":\"5abe7aff20f83c12\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/routing.js\":\"274414fef1476ddb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/safeMode.js\":\"110d4960e7485b3f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/scheduleIdle.js\":\"85010e90bb7a56b1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/screenWakeLock.js\":\"8648ac51bb488e85\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/selection.js\":\"4ac6c38602f57194\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/softKeyboardGrab.js\":\"839f8416616bcbef\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/startupTimeline.js\":\"ed9a718289892a63\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/state.js\":\"7482323800a64c4b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/string.js\":\"7968ed3405f648a5\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/surfaceZoom.js\":\"a1c33358cf73023b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/time.js\":\"517902754f423f8f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/toast.js\":\"86dae16f2091b60b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/toggleStore.js\":\"3245d9d492a1ca1b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/untilStopped.js\":\"13e797ea474b5aa6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/userActivity.js\":\"277321d55bb7afa0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/viewTransition.js\":\"369844a69661b9cd\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/viewport.js\":\"a0f61bd4cc142c29\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/webLock.js\":\"8ea2a840966e8794\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/workspaceRecovery.js\":\"4e63016a69bc7856\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/workspaceSnapshotStore.js\":\"e6c368748b23c75a\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-compiler-runtime.js\":\"0e93230c39c46080\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-client.js\":\"1adbfb06f12f12ec\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-server-edge.js\":\"28183968a787f532\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-server.js\":\"c91f1a81c62e6847\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-static-edge.js\":\"058c20671a95e6b6\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-static.js\":\"4c49f7c8a12dbbe8\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-test-utils.js\":\"6c4eef81cbb3dcab\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom.js\":\"e0ea85a087509c5b\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-jsx-runtime.js\":\"f3d00f4568be520a\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react.js\":\"89846b3a4378d77b\",\"/knowledge-medium/pr-preview/pr-1876/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1876/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1876/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
