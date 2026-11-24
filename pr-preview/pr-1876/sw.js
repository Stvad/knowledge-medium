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
		buildId: "4968094fd1e6-70701cf2",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/\":\"787d53fdb43e2d3f\",\"/knowledge-medium/pr-preview/pr-1876/index.html\":\"787d53fdb43e2d3f\",\"/knowledge-medium/pr-preview/pr-1876/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1876/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1876/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1876/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1876/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/pr-preview/pr-1876/assets/FacadeVFS-QjCi6DWI.js\":\"5e5274e12fa22bc2\",\"/knowledge-medium/pr-preview/pr-1876/assets/OPFSCoopSyncVFS-wxp1Uqdx.js\":\"26e3c44a3087f499\",\"/knowledge-medium/pr-preview/pr-1876/assets/OPFSWriteAheadVFS-CVFEYFmB.js\":\"9c0c063f0b0aca04\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-8TWgCfd6.js\":\"a9534c7c077aec29\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-async-Dzf0FjH0.js\":\"cc0155b76245b694\",\"/knowledge-medium/pr-preview/pr-1876/assets/worker-CedGonAS.js\":\"f8bbe6a306fb4ba6\",\"/knowledge-medium/pr-preview/pr-1876/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1876/chunks/app-Ba-0yOW4.js\":\"2df59f618a768460\",\"/knowledge-medium/pr-preview/pr-1876/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1876/index.js\":\"9ab0e89fce06af86\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1876/assets/AccessHandlePoolVFS-Dia6ZnV6.js\":\"5a4b19079172a975\",\"/knowledge-medium/pr-preview/pr-1876/assets/IDBBatchAtomicVFS-CP0iq6pd.js\":\"11d774c0189783d6\",\"/knowledge-medium/pr-preview/pr-1876/assets/MemoryVFS-X1IFqAfC.js\":\"1e75a85b7e069894\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-BpOZgN39.js\":\"ce63225182905fa2\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-async-N55meU-N.js\":\"328756d3ba260649\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1876/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1876/chunks/AccessHandlePoolVFS-B-I-Y2mX.js\":\"4d8de60b8606321a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/FacadeVFS-CCrlT_Y2.js\":\"7862f96bc8f4032a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/IDBBatchAtomicVFS-BRs0N8vU.js\":\"bf203e824252ea44\",\"/knowledge-medium/pr-preview/pr-1876/chunks/MemoryVFS-DkYUVGGb.js\":\"fed37304143fe7d5\",\"/knowledge-medium/pr-preview/pr-1876/chunks/OPFSCoopSyncVFS-BBfUg52X.js\":\"6f25f02e8cb0e50e\",\"/knowledge-medium/pr-preview/pr-1876/chunks/OPFSWriteAheadVFS-C1-g2CmU.js\":\"ecdd5dbc9a0a391e\",\"/knowledge-medium/pr-preview/pr-1876/chunks/Preview-DQBoPdWx.js\":\"3a17c20650f464b5\",\"/knowledge-medium/pr-preview/pr-1876/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/card-B0PYLr4j.js\":\"d9cd3e0f76fbc3f7\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-DwJIawxX.js\":\"93ae9a52f88e993f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1876/chunks/mc-wa-sqlite-B72rlJkn.js\":\"e0d08bce43e37242\",\"/knowledge-medium/pr-preview/pr-1876/chunks/mc-wa-sqlite-async-eLVkrJOT.js\":\"f049793fdf76158f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-BB18F3yb.js\":\"af3883cb478ba648\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-BNYKSD1R.js\":\"938fe67394cbee20\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-BTxU_CV9.js\":\"382838ad167ecb1d\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-CoafzjWl.js\":\"707c5b1adae066e4\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-Wxq36IW7.js\":\"ff30537a1cf3c929\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-bMgo6tIr.js\":\"ddbdb4b57308a93b\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server-legacy.browser.production-CSvmWVhK.js\":\"7bc0353d373cd10b\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server.browser.production-skbodFkR.js\":\"3ef7a51bef43aa1c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server.edge.production-CROv8c57.js\":\"f698e39c5cbe899d\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-fehy1e3b.js\":\"83bba0d800a10f75\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-gT0KcYIL.js\":\"3cb2e4d69ef74484\",\"/knowledge-medium/pr-preview/pr-1876/chunks/server.browser-D5zkl9Ff.js\":\"b2a206f3160bdd43\",\"/knowledge-medium/pr-preview/pr-1876/chunks/textarea-f2vDPwPN.js\":\"0254dd799c5d4254\",\"/knowledge-medium/pr-preview/pr-1876/chunks/ui-BPCpZiJ8.js\":\"f359efdf356e19b7\",\"/knowledge-medium/pr-preview/pr-1876/chunks/wa-sqlite-Cb0EYRpo.js\":\"5fb4e94cb4b50c1a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/wa-sqlite-async-BZU99hzR.js\":\"bed609b4f46da444\",\"/knowledge-medium/pr-preview/pr-1876/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1876/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1876/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1876/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1876/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1876/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1876/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1876/src/App.js\":\"ced45daf881aaf53\",\"/knowledge-medium/pr-preview/pr-1876/src/appUpdate.js\":\"92307d62b5fb9d2d\",\"/knowledge-medium/pr-preview/pr-1876/src/appVersion.js\":\"db6a57cb0722e2c3\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/initialLayout.js\":\"5a263af14340f4ba\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/openWorkspaceData.js\":\"a076238fec9bf535\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/resolveWorkspace.js\":\"a139da73e65e8964\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/workspaceBootstrap.js\":\"14003ebc97b5033e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockComponent.js\":\"a84fde1090e20fa8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockCrumbs.js\":\"d85b3997b1605d32\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockEditor.js\":\"5cc163f2664774b1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockLoadingPlaceholder.js\":\"abab63e2b9730fa1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockProperties.js\":\"f1f93e76b90f845b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockSearchPicker.js\":\"4b07149a914d1206\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ConfirmBulkDeleteDialog.js\":\"69b18779ad43b8b2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/DividerHandle.js\":\"e305cb5e7f513221\",\"/knowledge-medium/pr-preview/pr-1876/src/components/DraftEditor.js\":\"9bc8eb46efedae6b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/GutterPill.js\":\"44c1bf296ae3db7c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/Header.js\":\"b7ae913e92f735d5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/LazyBlockComponent.js\":\"d310b26144781bce\",\"/knowledge-medium/pr-preview/pr-1876/src/components/Login.js\":\"4aef679581d9c2d9\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ZoomableSurface.js\":\"aaf91eab11695cc8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/editModeKeepalive.js\":\"28e2e4390403b315\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyDisplay/PropertyDisplayScope.js\":\"819da7ab1dd30902\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4d31578ee3ef771f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/RefPropertyEditor.js\":\"08d16a871e00aee0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/RefTargetTypePicker.js\":\"e180cf0ce80a0a45\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/SelectPropertyEditor.js\":\"ec7fe619b9a1c082\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/TypesPropertyEditor.js\":\"68a0107d1cfa6b00\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/defaults.js\":\"31cb06401f242d50\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/kernelValuePresets.js\":\"419aadc5b29b74e4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/selectablePresets.js\":\"d209fdd7e1fd6d2f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/typesPropertyUi.js\":\"175eec9b8904be81\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/AddPropertyForm.js\":\"bcbcf01577470000\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/PropertyPicker.js\":\"13b421da43a2fd47\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/PropertyRow.js\":\"135456cff02a1422\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/Rows.js\":\"0d731be59875fe32\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/actions.js\":\"510789a2e1a7d3d0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/declarationOnly.js\":\"b05a222157a1c1d7\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/layout.js\":\"eab6358392910299\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/model.js\":\"05203e91bdc12e6c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/shapeUi.js\":\"76dd86b871b9fc04\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/shapes.js\":\"edc3b943135e0f72\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/usePropertyEditingActivation.js\":\"d0bc8823b6fc3c43\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/visibility.js\":\"e0254172946c406d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanelSections.js\":\"7072f2827cd8cca2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockEmbed.js\":\"66a48c8cd9654622\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockLink.js\":\"cb38280267bbef17\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockRef.js\":\"01853b90c9a30adf\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/ReferenceLink.js\":\"dbe8a6c9414220f9\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/cycleGuard.js\":\"2ce0e8ddd6e9bfb8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/cycleGuardContext.js\":\"e7f3ee6b786eadf1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/linkInteraction.js\":\"508f2b31521bac31\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/referenceLayout.js\":\"eb1e20526f44fb5b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/useBlockRefAncestors.js\":\"aca5a6f4d5d141ba\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockGutter.js\":\"94d462abf3dfbb90\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockInfoDialog.js\":\"32aee0b8225787ca\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockTypeBlockRenderer.js\":\"255e447b6815cfac\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BulletHoverCard.js\":\"b665505a375da96d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/CodeMirrorContentRenderer.js\":\"71c95b3618f7a688\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7dbd5eaf0f5ac505\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/ColumnResizeHandles.js\":\"78b2d60ece20d602\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ca5cc73f5eb30981\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/DefaultBlockRenderer.js\":\"0d6e555c2b0e8c2d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/LayoutRenderer.js\":\"9d34e6d590bf87ff\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/MarkdownContentRenderer.js\":\"3391c06adff91615\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/MissingDataRenderer.js\":\"b4858d3fca02e51e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/PanelRenderer.js\":\"0ebde799d882c690\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/PropertySchemaBlockRenderer.js\":\"be25ca2f1fb6dbd0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/TopLevelRenderer.js\":\"ebaac006e272fb5b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/blockGutterMode.js\":\"e655e8e5ac141360\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/blockTitleText.js\":\"5424ee5d497bc1e8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/fieldCreationKeydown.js\":\"7cca1c2c6b2d4458\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/layoutRootContext.js\":\"c7948aa78198205f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/typeChip/TypeChip.js\":\"eb18a71ab407334f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/typeChip/chipStyle.js\":\"496650c9a1b39cff\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/anchored-floating.js\":\"f467486524e8cbbf\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/button.js\":\"21c2f63be21c8def\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/card.js\":\"6229ffd29d7046cb\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/checkbox.js\":\"38eaf5dfe0081b84\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/collapsible.js\":\"ceb562cc49592031\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/command.js\":\"12aa45ab54c50d36\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/context-menu.js\":\"56327e0f19bf8030\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/dialog.js\":\"67bb89eb26e0bd3d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/dropdown-menu.js\":\"f1149ead2f6b0167\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/floating-listbox.js\":\"c5f2394a9187db0b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/index.js\":\"19ec17af5d677443\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/input.js\":\"5e92564b05e59410\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/kbd.js\":\"24719c8438fa0b34\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/label.js\":\"1d1d530a93a8ebbf\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/textarea.js\":\"44cd69d5ef4ed278\",\"/knowledge-medium/pr-preview/pr-1876/src/components/useEditModeYieldKeepalive.js\":\"d34c0893812f1a71\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/BootFallback.js\":\"7de688a8b6745f13\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/FocusedRowLazyMount.js\":\"0f7e0518de1110e0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/LazyViewportMount.js\":\"9a239534196a6ba2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/LocalDbCorruptionFallback.js\":\"e8cad03a74f12791\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/error.js\":\"b29d57850899db80\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/lazyMountRegistry.js\":\"c0be2bdae88d1e8c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/suspense.js\":\"673dad40426eed96\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/CreateWorkspaceDialog.js\":\"b6f1ceb1befbfaea\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/PendingInvitations.js\":\"1753109239711a6a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/SyncProgress.js\":\"e6d3b706d85be1bf\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/UnlockProgress.js\":\"e96a7226014b742e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceKeyGate.js\":\"8e19dad560e6f2b4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSettingsDialog.js\":\"55b27c57b789ae59\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSwitcher.js\":\"6e4a9fedb4116858\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSyncGate.js\":\"01aac743ee11604e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/ConversionFlow.js\":\"02fae992abe4aa82\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/ConversionFlowHost.js\":\"0bb523a8207e39da\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/EncryptionSection.js\":\"f24d73289f40cbef\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/attachmentPrompts.js\":\"7b4dbb73fb761d09\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/bundleFolderPrompts.js\":\"c62dfa80c2610dc7\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/conversionFlowDeps.js\":\"e2851fc2c8bba8cd\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/conversionFlowStore.js\":\"3c1ad0cf73c08d22\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/flowUi.js\":\"b3e73b35a5dac00c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/useConversionRun.js\":\"e9591f604cfdf2a5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/keyUi.js\":\"4588ec66f73f1cc2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/useCloseOnKeyLoss.js\":\"b79664a01b21e91c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/useCloseOnServerE2ee.js\":\"e63a74511a2b0b2a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/workspaceUnlocked.js\":\"d286161bc07df6c0\",\"/knowledge-medium/pr-preview/pr-1876/src/context/backgroundSubtree.js\":\"7b6f72e5733edca2\",\"/knowledge-medium/pr-preview/pr-1876/src/context/block.js\":\"d4d5dbf8b26956a5\",\"/knowledge-medium/pr-preview/pr-1876/src/context/layoutWsContext.js\":\"5253e47e8a571998\",\"/knowledge-medium/pr-preview/pr-1876/src/context/propertyDisplay.js\":\"fab4eb424680a9bd\",\"/knowledge-medium/pr-preview/pr-1876/src/context/repo.js\":\"e532d0a08a3cf2e9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/aliasClaim.js\":\"6287325b56bdbf70\",\"/knowledge-medium/pr-preview/pr-1876/src/data/aliasSeatNamespace.js\":\"6efcaef017e39c94\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/blockData.js\":\"7e6eda850681705e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/blockType.js\":\"a36dfc52caf13f95\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/changeScope.js\":\"0467a1664adb8ed2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/codecs.js\":\"11fe261bf75962a5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/derivedData.js\":\"e79f3ada13db45d4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/errors.js\":\"af3043632d2a2388\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/events.js\":\"61a22010f72c06e2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/handle.js\":\"0fa2f326572ada87\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/index.js\":\"671156caf1ddfa0d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/mutator.js\":\"db6fd26309fa748d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/processor.js\":\"768fd085f265c217\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/propertySchema.js\":\"de76059ac1db55ba\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/query.js\":\"c289048ba1256b09\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/sameTxProcessor.js\":\"8021c6b63546ba96\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/schema.js\":\"0fa2f326572ada87\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/tx.js\":\"0fa2f326572ada87\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/typedBlockQuery.js\":\"6adfbeb10ddc2f4c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/user.js\":\"305ccbd6c5b241fd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/valuePresetCore.js\":\"39ded2c9871e2071\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/valuePresets.js\":\"1483f0940a91c423\",\"/knowledge-medium/pr-preview/pr-1876/src/data/attachmentCleanerIOVerb.js\":\"f9100594502a1d05\",\"/knowledge-medium/pr-preview/pr-1876/src/data/block.js\":\"29044dd589a0e4d7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockCache.js\":\"748a1a45ddb1f2c8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockId.js\":\"c5b09b0ee9f9ef69\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockLiveness.js\":\"30ef34f94aace5e6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockMerge.js\":\"c16416a20bb26571\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockSchema.js\":\"a2e62234cdc1633f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockTypeLookup.js\":\"73e287a6d841ccce\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockTypes.js\":\"d185adb0911eb9c2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/childrenView.js\":\"5212dcab22644b47\",\"/knowledge-medium/pr-preview/pr-1876/src/data/clientContext.js\":\"0aca440ed34bb81a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/dbFileSiblings.js\":\"0595a12bd287e812\",\"/knowledge-medium/pr-preview/pr-1876/src/data/definitionSeeds.js\":\"e2b3f97d6ce317bf\",\"/knowledge-medium/pr-preview/pr-1876/src/data/derivedIds.js\":\"6e12b009f43baabd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/drawnSubtree.js\":\"9227891476760248\",\"/knowledge-medium/pr-preview/pr-1876/src/data/facetBridge.js\":\"dcc434bd63ba387e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/facets.js\":\"de7be8ad8e858f70\",\"/knowledge-medium/pr-preview/pr-1876/src/data/globalState.js\":\"81968d5a769c2625\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/aliasClaimRederiveProcessor.js\":\"e03b181eec30b813\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/ancestorBatch.js\":\"6a91640fdfe32f5c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/blockTypeTypeifyProcessor.js\":\"abfdeef7e7d61579\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/clientSchema.js\":\"7b4396dce2f73a45\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/commitPipeline.js\":\"b9dbf2efbafc250b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/devAssertions.js\":\"c13b98b3664b3dae\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/firstSync.js\":\"5e182a1aa61bd38a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/freshInitialLoad.js\":\"5b42244b6a196dc8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/graphBackfillClaim.js\":\"e194a07747b38dd7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/handleStore.js\":\"5e953017033ccc06\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/idleMarkerJobs.js\":\"f8e8e29d2ecd98f7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/initialDownload.js\":\"831a0cf56fe87434\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/initializeClientDatabase.js\":\"ac5669c8ed813207\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/jsonCanonical.js\":\"3e32e4a2fc16bb41\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelInvalidation.js\":\"8dfad7d82f5d09e1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelProcessors.js\":\"012f2b788d88b557\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelQueries.js\":\"dc2faea346948c99\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/mergeTypeMembershipProcessor.js\":\"9a34c5fc19b808b5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/normalizeReferencesProcessor.js\":\"2a0f37eb217b0210\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/poolInstrumentation.js\":\"9a0b12f52de55711\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/processorRunner.js\":\"9451b02964b0dffa\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyCellBackfill.js\":\"b82842a063b5236c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyChildMint.js\":\"8368645760057dcd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyChildrenProcessor.js\":\"d97d681994260fea\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyDefinitionChangeProcessor.js\":\"15a9acf02b23ead1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyDefinitionSynthesis.js\":\"829fc0f4c935d414\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyKeyScan.js\":\"6cfc7fcace74eaff\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertySchemaResolution.js\":\"d130ec2c4f758ecb\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyValueEdits.js\":\"5ffca9313717a16a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/raiseProtocol.js\":\"4bb7c406f9fab809\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/readBatch.js\":\"76f8555cbcbd4caf\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/refProjection.js\":\"dc8940db74049a58\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/referenceTargetLookups.js\":\"ae2b937212a7b25f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/referenceTargetProcessor.js\":\"116fbc7f89859e08\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/replayMerge.js\":\"3c536a665c6cbda1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/sqlBinds.js\":\"04c6979250087c42\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"db3886d85e02f077\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/arrivalProcessors.js\":\"a64f84e18a552fde\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/invalidate.js\":\"a61a7958a99f15b1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/materialize.js\":\"f001824084ecd214\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/observer.js\":\"94ee79cb7f44af57\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/reconcile.js\":\"da32d043f6dfd9ed\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/timingMetrics.js\":\"546d2d32da082ee3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/treeQueries.js\":\"45aa059e8c8191ca\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/txEngine.js\":\"2c900b59dfa50e2b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/txSnapshots.js\":\"458fad61467f9ed2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/typedBlockQuery.js\":\"1f5ef9954874519a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/undoManager.js\":\"aaaf17e65648db97\",\"/knowledge-medium/pr-preview/pr-1876/src/data/invalidation.js\":\"e843a60c2dad50ff\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelDataExtension.js\":\"32a65f125191c44d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelPage.js\":\"4d5ae6c27955895d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelValuePresetCores.js\":\"114bb8c998f74d00\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbCorruptionSignal.js\":\"f4ee7f97a66f78e1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbStorage.js\":\"91b4957d93188205\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbVfs.js\":\"24011426a72d1758\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localSchema.js\":\"35d2f41ad8f57da7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/maintenance.js\":\"38dbd12b72134052\",\"/knowledge-medium/pr-preview/pr-1876/src/data/mergeProperties.js\":\"26268aa06b5dd7d5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/metricsConsoleHook.js\":\"581005768649ffce\",\"/knowledge-medium/pr-preview/pr-1876/src/data/migrationsPage.js\":\"1cfd755d5a49af38\",\"/knowledge-medium/pr-preview/pr-1876/src/data/mutators.js\":\"e1d0ecf84eda9db2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/orderKey.js\":\"045d46454ad5295a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/orderKeyPlacement.js\":\"a5333f371031d074\",\"/knowledge-medium/pr-preview/pr-1876/src/data/outlineSurface.js\":\"04161ebf3c97ebcc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pendingEditorContent.js\":\"3e7f07ed4700b9b7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pendingUploadsSql.js\":\"5a22fb97e0c7124a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pluginStateExtensions.js\":\"657b9120954d12d3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/powerSyncLogger.js\":\"d843492b95b12f83\",\"/knowledge-medium/pr-preview/pr-1876/src/data/projectorRuntime.js\":\"e6f48687ee32477c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/properties.js\":\"1a45746d1b30aa0c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertiesPage.js\":\"ed4c66f8c15ecde3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyChildren.js\":\"05b1c6a427172a21\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionFanout.js\":\"63e06d68cdda7e04\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionMetadata.js\":\"716a41d21c50ab78\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionRegistry.js\":\"2911748f63053293\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDisplayMode.js\":\"c0ddc2cd961bbb51\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyRowCreation.js\":\"8555ed6539318a85\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertySchemaCreation.js\":\"3194a52950b05f4a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertySeeds.js\":\"9e7a231603e3b565\",\"/knowledge-medium/pr-preview/pr-1876/src/data/recentsPage.js\":\"ce366c81a7fc2d92\",\"/knowledge-medium/pr-preview/pr-1876/src/data/referenceBlock.js\":\"985975b36c145940\",\"/knowledge-medium/pr-preview/pr-1876/src/data/rejectedUploads.js\":\"c5718587cbfb4421\",\"/knowledge-medium/pr-preview/pr-1876/src/data/releasePowerSyncConnection.js\":\"433edab41eaafdca\",\"/knowledge-medium/pr-preview/pr-1876/src/data/repo.js\":\"62f8712a2fc7877f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/repoProvider.js\":\"9306210d08b90dd7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/rowProperty.js\":\"6020593707a7faa6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/searchFilter.js\":\"3e23d08d51c71143\",\"/knowledge-medium/pr-preview/pr-1876/src/data/seedIdentityLedger.js\":\"b7a64ed1642c2755\",\"/knowledge-medium/pr-preview/pr-1876/src/data/stateBlocks.js\":\"514e6fa9c445f565\",\"/knowledge-medium/pr-preview/pr-1876/src/data/structuralEditPolicy.js\":\"a718681ddc53379a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/structuralInsert.js\":\"70a84eb8eadae043\",\"/knowledge-medium/pr-preview/pr-1876/src/data/subtreeDelete.js\":\"a44403a0e1eaf0ad\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncStreamLock.js\":\"3a61b5e52004ab40\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncedTableSqlRecognizer.js\":\"8ec5b99078ed11d6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncedTableWriteGuard.js\":\"6edcaa9ac6a4af10\",\"/knowledge-medium/pr-preview/pr-1876/src/data/targets.js\":\"c78ec038534a18f4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeColors.js\":\"31b46f3447cc4793\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeDefinitionMetadata.js\":\"58ffe42de9fcd10c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeDefinitionRegistry.js\":\"2b2e20856c1b6a1b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeExtraction.js\":\"e4c1eae03af1136a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeInitialValues.js\":\"79fa6bc3c05a72a1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typePropertyGroups.js\":\"42c1567e62e7644c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeSeeds.js\":\"bcaf428ed85488cd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeTagger.js\":\"06ee437231179cd4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typedRecords.js\":\"fcba69375e04b5a9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typesPage.js\":\"bedb0e7d90c5224e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userPrefs.js\":\"55a017bc8d0bcaea\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userSchemasService.js\":\"0cf9ec260f771163\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userTypesService.js\":\"b6d82ac21cb1ea5d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/valuePresetRegistry.js\":\"83bc53ed20be415c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/visibleChildren.js\":\"1930137c6224f46e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceConversion.js\":\"ae8892a228cb3642\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceFirstSync.js\":\"69d20d8e0523b30e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceIdNamespace.js\":\"3e5eb7dd899b9309\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceSchema.js\":\"90466c477499dd9a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaces.js\":\"cbd801939081180b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/writeAheadLog.js\":\"08537ffdb7b23a65\",\"/knowledge-medium/pr-preview/pr-1876/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/BlockPasteShellDecorator.js\":\"a36cfe27452fcff0\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/atTrigger.js\":\"3b7d2a66d359f994\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/autocomplete.js\":\"95fa05c31a4066ce\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/codeMirrorExtensions.js\":\"596185d16a939016\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/contentFlush.js\":\"6fb5f2989e0616b5\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/defaultInteractions.js\":\"a11ddbf480f3476a\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/editSettleSignal.js\":\"77103cc449886b60\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/insertImage.js\":\"ed546b3997b67296\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/referenceCompletionRange.js\":\"0b0f07b55b0032ca\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/referenceTargetTypes.js\":\"fa22c23166d1ffcc\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/syntaxContext.js\":\"5beb04f89ec0e179\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/triggerMatch.js\":\"2b4e660c9e7cdcb7\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/AppRuntimeProvider.js\":\"99d5dd24ba47391f\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/BlockFocusShellDecorator.js\":\"b874fe3433a2b6b3\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/ExtensionRenderBoundary.js\":\"2e5eec588f5241a2\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/PanelContentRecovery.js\":\"5036b91b20524e65\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/apiCatalog.js\":\"f69f3ddc25746f24\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/approveExtensionHere.js\":\"b7a3c7ef573b20d2\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/armedCutAppMount.js\":\"1fc331835010b110\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/batchableKeyedStore.js\":\"b9724404de15bfc3\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/blockInteraction.js\":\"fb2b815b9d90b398\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/blockSelectionAction.js\":\"400eb43d82dcd232\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/compileExtensionModule.js\":\"cff0bca6175f38e0\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/compiledModuleCache.js\":\"3938e79e44f98d47\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/continuousGestures.js\":\"47723d45022be593\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/core.js\":\"e1e24463c17eb77f\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/defaultRenderers.js\":\"c7c614760ace4832\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/definitionFanoutAppMount.js\":\"170919dfea5a9c4d\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dialogAppMount.js\":\"16e28ce5628067e8\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dynamicExtensionSeeds.js\":\"2684dfbe6386e64a\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dynamicExtensions.js\":\"a54cc05730355eea\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/exampleExtensions.js\":\"4fcee25e36541de5\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionApprovalStatus.js\":\"bae15ea3d06d57f7\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLoadErrorToast.js\":\"424fa4aa3807ec57\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLoadErrors.js\":\"9fc1716f27be12f8\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLookup.js\":\"283bd312b2c69f99\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionToggles.js\":\"533e9aaa9b6ca6a9\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionUtilitiesCss.js\":\"571f6d2def0908ff\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/kernelPageDeletionGuard.js\":\"4d71eee8a3a6d993\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/liveRuntime.js\":\"6eceae2a16a2daf3\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/openExtensionsSettings.js\":\"0771976fead26737\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/overridesCache.js\":\"482367a59fc10644\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/pluginIds.js\":\"e47f4542dbcb36fb\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/processorRejectionToast.js\":\"1a1efc4a207a5edf\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/runtimeActions.js\":\"db8ca7bcee934d70\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/runtimeContext.js\":\"94530b86f248575d\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/staticAppExtensions.js\":\"a81d22e0110afed9\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/staticDataExtensions.js\":\"712f9971e04b7631\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/toastAppMount.js\":\"1af4448a5e8a1c5e\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/useOverrides.js\":\"dcec46ca516adacb\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/useShortcutSurfaceActivations.js\":\"1fcde868a05e702c\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/discoverToggleTree.js\":\"454b248b4249e950\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/facet.js\":\"409ab63d1b63f6f7\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/resolveAppRuntime.js\":\"4cfd0c3ced8f2a44\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/runtimeEvents.js\":\"dc6cbf9c19a96ef7\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/togglable.js\":\"885fb9700790edcc\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/variantFacet.js\":\"22fdb7157693bf69\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/verbFacet.js\":\"ff5775c35d7f4427\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/block.js\":\"4f0a743db71b487f\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/focusedChild.js\":\"f961c229ddc51894\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/propertySchemas.js\":\"05ac2e706ede21c2\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/typeRegistry.js\":\"38accbf30d75e4ae\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useAncestorCrumbs.js\":\"ab102f4f0cd64f89\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useAutocompleteListbox.js\":\"3f37a3616653d569\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useDebouncedSearch.js\":\"41fb614383c7dcad\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useDebouncedValue.js\":\"84d0f6f736f059b3\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useIsFocalRender.js\":\"3fecdaccfe629142\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useIsReadOnly.js\":\"7b3cae22b16dda5d\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useMaterializeBacklog.js\":\"4a6abcf16d2dcf19\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useMinuteClock.js\":\"e459bc254b6993b9\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/usePanelLayoutProjection.js\":\"daea119df1a19078\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/usePendingInvitations.js\":\"902019a8c9fc22a4\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useRendererRegistry.js\":\"af2fa2a28f30e49b\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useRetainedFieldRows.js\":\"28d79a8c7b1326d0\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useWorkspaces.js\":\"5e06e6cdb678f27d\",\"/knowledge-medium/pr-preview/pr-1876/src/lib/utils.js\":\"b698521f133d66d1\",\"/knowledge-medium/pr-preview/pr-1876/src/main.js\":\"221ea21ead2539e9\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/MarkdownImage.js\":\"0490b3308440202a\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/blockSeparators.js\":\"6db50e1833c30e33\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/context.js\":\"d561293bb674e37c\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/defaultMarkdownExtension.js\":\"09db049c6c0142d3\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/extensions.js\":\"5c1813bad44de0fc\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/renderMarkdownHtml.js\":\"14580835f78ec4c5\",\"/knowledge-medium/pr-preview/pr-1876/src/minimal-editor.js\":\"cc15e435d312fc02\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/armedCut.js\":\"27a01161d37edd58\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/captureMediaVerb.js\":\"e1ee7986e32a6575\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/clipboard.js\":\"ed9b32086fc06b50\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/decision.js\":\"354fef13c02b0602\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/operations.js\":\"ad8fddf1958027b3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/account-header/AccountHeaderItem.js\":\"6522dfd92d8de99f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/account-header/index.js\":\"d6497f1c5e08cf22\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"10e31a0715f63d54\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/askAgent.js\":\"83519bd4f158029f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/askedStore.js\":\"00be4c73847979e7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"fffee1f03bf9cc1f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/chipState.js\":\"b511a5cadc1e348e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/dataExtension.js\":\"67a8f87c1a1a22ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/index.js\":\"1cdee79eef020a77\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"24f79702f10a446e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/schema.js\":\"dcadd6a755d5c940\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/AgentTokensDialog.js\":\"90251bda89ea018a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/BridgePairingDialog.js\":\"abe10c3fc49c557c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/addMedia.js\":\"abdf707e6aef10c1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/backlinks.js\":\"67da1db5b32c0839\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/block.js\":\"e32f0b5f54e95ffd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/context.js\":\"e937415a026e6e62\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d0f4ede9c9c5e22a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/index.js\":\"25bc4048fcd6f9d3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/outline.js\":\"1ffde75bc0fa9799\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/properties.js\":\"753840a60eb46f89\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/refs.js\":\"2a2853406dc47dc1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b9b6a05f57cba8fe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/search.js\":\"48744e1b3c9a76ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/shared.js\":\"636f3b584be81067\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"56adb946a15495ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/text.js\":\"1a8afc7e402118b5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentWrites.js\":\"56fe73f8fc11e6ff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/authoringCatalog.js\":\"fa3b16be4b567e35\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/blockRefTargets.js\":\"8795d2d2d18b92a5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/bridge.js\":\"3296de4cc11e2670\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/bridgeLoop.js\":\"fb8ebdfc1989e9d0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/changeHistory.js\":\"3948fcdd904d8c1c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/commands.js\":\"c005fdb2af55bb72\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/commentsCommands.js\":\"f89bb0800e60538d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/dataExtension.js\":\"7263873ab33c6302\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/dataModelGuide.js\":\"036c8cec492419d7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/describeRuntime.js\":\"34884b6345830ee3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/extensionLint.js\":\"8dc6cd971bdafc55\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/grainAudit.js\":\"ad689f98504312ff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/healthCommand.js\":\"3fd148e32d1755f4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/index.js\":\"63a5f0af32ba1a8e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/presetIdentity.js\":\"553c989e0a47b8bc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"3893967fdcee78c3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/readMedia.js\":\"5b4caa1d5e5759fe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/schema.js\":\"dec06f6a304964f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/serialization.js\":\"905cd749120357ae\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/targets.js\":\"4ecb4e6701eb6f06\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/tokens.js\":\"7b67652fc01389dd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/watchEvents.js\":\"3709d0175f523cd0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/workspaceGuard.js\":\"4badc0bef7f3ed3b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/writeCommands.js\":\"8c78be1fab8ff5c1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/AliasCollisionToast.js\":\"c726d097d3a35bcb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/DuplicateNameBanner.js\":\"ac9c876bec2dd894\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/collisionMerge.js\":\"91f64c450843703e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/dataExtension.js\":\"12646675cfa789ce\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/index.js\":\"4940da44f35969ea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/mergeCollisionAction.js\":\"1944ecb6610c0719\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/pageStyling.js\":\"62d93fa895815736\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/rejectionToast.js\":\"b8e33ca07d916041\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/syncProcessor.js\":\"2db21018b18d43b5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/actions.js\":\"fc22ed2c9492962c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/addComment.js\":\"1fa88e32e5b52c2b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/anchor.js\":\"9dbc9318f5f77641\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/anchorState.js\":\"3e811d66192fd861\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/commentLinks.js\":\"ff4c34f93ca00fc8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/confirmThreadDeletion.js\":\"844424b22bcdb107\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/container.js\":\"fc6f6e882157d0a8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/dataExtension.js\":\"377a84cd237ebd10\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/deleteComment.js\":\"c247cd7bdad3e565\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/highlights.js\":\"f9bab8331d016455\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/index.js\":\"be2f308f313ccffb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/linkedCommentsPill.js\":\"239a4b97c3c1a4e2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/margin.js\":\"06336a85bd8a1119\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/marginAnchorLinks.js\":\"cc4d70b678c4051f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/marginSchema.js\":\"93c461e45c4788f1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/newComment.js\":\"772d7b047c1d18fc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/ownThreadPicker.js\":\"2bd331e24ef7d17a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/placement.js\":\"619c04adc700e95d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/queries.js\":\"eb350799fc27b31b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotePosition.js\":\"a4fb84981bd16f65\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotedIn.js\":\"345d973d9ab95a23\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotedRange.js\":\"9325c1893e135dbc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/rangeRefs.js\":\"596fbf8e90819454\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readHighlights.js\":\"0c956fae8d0a95ab\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readSelection.js\":\"726ec5cbc7dd09d4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readSelectionUi.js\":\"86a5b255292b74b8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/reanchor.js\":\"f4f08d62cc8dce75\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/schema.js\":\"9bbc41a702c6ffbf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/scope.js\":\"9f22f137a802c14c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/scopeThreads.js\":\"b33ab3e55c56eece\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/splitRetarget.js\":\"acad7d7d0d8920c6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/suggestionCard.js\":\"5a9cd6f837f2930e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/suggestions.js\":\"ddade36b9aab3a10\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/summaries.js\":\"f04f7eb5392b58e2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/summaryBatch.js\":\"5c2c8df8a1510f39\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/surface.js\":\"6ce046a4ddc1f02d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/threadNavigation.js\":\"0d4b6830cfc1a09b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/threads.js\":\"085d2dab0b3dab98\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/ui.js\":\"a2b7263762bc591b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/uiStore.js\":\"5f51061d8ccdbaad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-intents/appIntents.js\":\"a92db8360f220529\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-intents/index.js\":\"05550c3f126d9288\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-update-prompt/index.js\":\"52c4578ce94a471c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-update-prompt/status.js\":\"9f05d6f8b4c19b56\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"8e412599d7d9c7d0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaBlockRenderer.js\":\"f4f9dda97d145842\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaDownLaneReplicator.js\":\"87008967ace046ce\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaUploadReconciler.js\":\"c756f250342a0119\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetDownLane.js\":\"2f8cb43cf425c016\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetResolver.js\":\"4aa8e89530c72e6d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetUpload.js\":\"2e1ceac03ed4ea42\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/attachmentCleanerIO.js\":\"5f4c644a279849ac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d135f068da9d1f40\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/blobStore.js\":\"0009682abf67a70d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/browserMedia.js\":\"511843296f76142f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/byteStore.js\":\"c91c67bfc141536d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/cleanerIO.js\":\"6b7b3b5a5c5bfd83\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/cleanupAttachments.js\":\"ad0cbd80a0f0578c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/dataExtension.js\":\"dd33c5aafbe62b08\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/downLane.js\":\"95c8efae9e410b8a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/index.js\":\"260166a3444a5cbd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/insertImageContribution.js\":\"9b17f46bb015819e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/laneArming.js\":\"db53754d819e358e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/laneLock.js\":\"216734226121c982\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaBlock.js\":\"e43cfdcd295b3f47\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaCapture.js\":\"2610357b124ec565\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaLanes.js\":\"12c5383904d606c0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaViewers.js\":\"cc022f522407e868\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaViewersFacet.js\":\"7e70db36c9cbb14d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/pasteCapture.js\":\"2aaca7fdc85ed474\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/resolver.js\":\"d1c59b329ecfbeb0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/retryUploadsAction.js\":\"62e7138916cfdf2f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/storagePaths.js\":\"69b45e3ff1b68000\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadDrain.js\":\"6db43a931402b05c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadLaneStatus.js\":\"02e6b631c6334bb2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadReconcile.js\":\"488a090e0e70a4ee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadRecovery.js\":\"e75aa8dcd6c0b017\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadStore.js\":\"0ae0405b96d0044b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/useAssetObjectUrl.js\":\"96a8e44601b7842d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"3b58e01b01008b4b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/BacklinksViewSection.js\":\"49ee756915a401cf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/facet.js\":\"d1407d0a11913bb5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/index.js\":\"f83d87ee8b3fcd4e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/prop.js\":\"151a51d88c68999f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BacklinkFilters.js\":\"c32a9ff44f573664\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"244476b7d6ef18cb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BlockEntry.js\":\"6b861594f6dd6416\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/LinkedReferences.js\":\"603fb529e489c29c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"1e1844ae7000d7b2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/dailyNoteDefaults.js\":\"5fb381f87a55e6e6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/dataExtension.js\":\"dffe358ed4ad8fee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/edgeExclusions.js\":\"0f973565d2863548\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/filterProperty.js\":\"ceeccd062565ca59\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/index.js\":\"0d04903e3c827fee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"470677432221a43a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/applies.js\":\"74414b37491f27ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/countQuery.js\":\"3c501465b6eb0f68\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f76dcd55df7465d8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/index.js\":\"d2d7c4533a451971\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"55aa264dbbd4a764\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/presentationInvalidation.js\":\"e99f947ef25ac61b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/propertyEditorOverride.js\":\"9a483b7df0864db7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/propertyFilter.js\":\"0be8b5617396d7cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/query.js\":\"7886c66ad60ab08b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/resolveFilter.js\":\"6025580ed67d6034\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/sourceBatch.js\":\"57152808853a124e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/sources.js\":\"569564686a7d7dd6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/useBacklinks.js\":\"f60c8c654d27900f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f02a74a1d40caa8b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/BirthdayCelebration.js\":\"6dab07e466d6437e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/BirthdayOverlay.js\":\"6c78731f06d26f27\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/gate.js\":\"aff7665de6539a86\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/index.js\":\"c68ffe3b521ea914\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/wolfTheme.js\":\"7d97ebff492eef7e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/BlockDragLayer.js\":\"e42ee86d3e9eb7bc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/dragController.js\":\"d7810ccf1a72cd7c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/dropTarget.js\":\"77ffaad4a2cfee2d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/index.js\":\"165c58b13d446491\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/projection.js\":\"0b9a22c784c2f3d8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-info/BlockMetaCard.js\":\"61c8ceabf1222376\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-info/index.js\":\"71dfdedd83a1a9bb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/AddTagDialog.js\":\"7950f5b150f00ef4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"dcddbdeb70b98f26\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/TagNameIssueHint.js\":\"9ea787eb12cc5dd6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/addTagAction.js\":\"254bd78561a67467\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/appendTag.js\":\"0d90f3d990b3155d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/config.js\":\"65f3190741bc57a7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/dataExtension.js\":\"4f32355a01dcf340\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/index.js\":\"c99f8f8577888fea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/propertyEditorOverride.js\":\"b173490007c6e977\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ee240315c6b62dc0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a0bfb1bca180cca8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/Breadcrumbs.js\":\"bd1565f06784e74e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"6a639f96a67bd7f4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"883b6e3e0a6ad406\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/index.js\":\"3378da3cedb84851\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"2ff3c07df8c4bc5d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/CharacterCountItem.js\":\"c63764de3f9e76f6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/ProfilePropertyEditor.js\":\"ae6fd69caaa98c44\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/actions.js\":\"f6b4239df672fb63\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/blockType.js\":\"324f7d8b828080f8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/charCount.js\":\"9cb63577f71ff058\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/dataExtension.js\":\"82e7a403eaa4da20\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/index.js\":\"28b3b92fa9b83182\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/profiles.js\":\"22805c6c726144ed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/properties.js\":\"210a82df5f05dfcd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/textCounts.js\":\"5db334f726f82981\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/colemak-keybindings/index.js\":\"a193f0886b914409\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/CommandPalette.js\":\"b11863174a1c282a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/HeaderItem.js\":\"b68136dd51bf0a53\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/context.js\":\"b39fa76981c009e4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/index.js\":\"648ecada8d391304\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/selection.js\":\"4bd85b7461f09d44\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/toggleStore.js\":\"0f75847d3d74f3d0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/useCommandPaletteActions.js\":\"6809f0c74a5d3f40\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/ContributorBadges.js\":\"15d41458cdfb62ed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/author.js\":\"1a64dc600d15195c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/codeMirrorExtensions.js\":\"872993ba051a61b8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/dataExtension.js\":\"2ce87859a2d2af2b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/index.js\":\"8bbcc06b87546e3b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/mentionAutocomplete.js\":\"664efdf5f4cbd887\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/processor.js\":\"64155319a966d599\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/profiles.js\":\"1034e53f5c7f02db\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/queries.js\":\"65a1fffbdda97778\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/schema.js\":\"8d239cda045d0d2c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4fac9c606f3d651d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/followOrigin.js\":\"99679a3d45a71007\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/index.js\":\"ebc21dab68addf6c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5ef5df9b432eca41\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0deb4ec5fc18fbd8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/CalendarGrid.js\":\"3c6e18d2d567c526\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DailyNotePicker.js\":\"dc7a79b3ec8dca26\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"c3a74f895c97d88f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateNavDecorator.js\":\"02ebe109a67502a3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateScrubOverlay.js\":\"18350cac707b6490\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/HeaderItem.js\":\"2f0c7c227898cd5f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/ReschedulePicker.js\":\"459cbefe618bbf1c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/SpreadDatesDialog.js\":\"ec9227db83b14d93\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/actions.js\":\"0e6a61b84cf32a98\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/blockDateAdapter.js\":\"ede8e21248c241f0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/calendar.js\":\"a7854c516d6c86c5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dailyNotes.js\":\"89219956d42d882c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dataExtension.js\":\"a16b0cb9cebc18da\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubActions.js\":\"7e26a58384b8e4be\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubGesture.js\":\"46dd74cb127c361d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubGestureActions.js\":\"40a0b73cd22460ff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubRecognizer.js\":\"960d90d925e75eca\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/deletionGuard.js\":\"db7106ee715d9998\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dueQuery.js\":\"16188ba010a069a2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/index.js\":\"fea052819fb43e54\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/landing.js\":\"eecf254b81cf197e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/localSchema.js\":\"e2640894350eeec1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/referenceDateAdapter.js\":\"0a6125626050a901\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/rescheduleAction.js\":\"da0a8676c2537d2d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/schema.js\":\"9dfb3478a388079a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/spreadBlockDates.js\":\"451a58ecc0ddbe63\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/spreadDatesAction.js\":\"460ac363a5a0378b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/today.js\":\"583549e9b15eceb8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"66e844df397760df\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"933c705403cddbac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/audit.js\":\"da51f3c15e994502\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/auditAction.js\":\"fc8ad9c52b74f436\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/auditRanges.js\":\"14fb3d8903862de1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/diagnosticsSource.js\":\"8b3ce943735bf2b1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/divergenceScan.js\":\"453a96f9e6f5c33b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/index.js\":\"baa61a44551b3568\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/propertyChildrenChecks.js\":\"641401ebdbeaf2e2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/referencesMirror.js\":\"3571857967513916\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/rowJson.js\":\"8511de25b01b1f51\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/schedule.js\":\"08e1cd8b86ec45f2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/store.js\":\"ce050a2164aab1be\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/action.js\":\"243e8c82b055db07\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/index.js\":\"39ad325507691358\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/plugin.js\":\"d39e39dfdee300e7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"7ce1e4957556fb6d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/actions.js\":\"7ebf2921f33d04b4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/changeMarker.js\":\"9a1ec63a741043e4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/diagnostics.js\":\"b884ea912b1c9786\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/fileSystemAccess.js\":\"5cd3ba0f4393e4e6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/filenames.js\":\"879a552fd0fa9e36\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/index.js\":\"9b24f14d934b44ce\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/mirror.js\":\"22e103f7e1af2d74\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/runLock.js\":\"b51dbf1e683fd725\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/runtimeHealth.js\":\"a41c28fa0ec4033f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/schedule.js\":\"c3da60364098bf7e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/store.js\":\"cd0ef656a2193348\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/default-themes/index.js\":\"c2cb164f7205f847\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/default-themes/themes.js\":\"fac34c2ef9ca9017\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/diagnostics/facet.js\":\"3d3ba92f35d0698e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/diagnostics/useDiagnostics.js\":\"d14d2a12ca1b1b76\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/dismissals.js\":\"cf9033affd044d57\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/index.js\":\"e26541b75692ee77\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/status.js\":\"bca85c660e436d8c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/store.js\":\"7f8f0295d4541adb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"f237d6d78006a637\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/ExtensionsSettings.js\":\"07ff5ea6ae580cb5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/actions.js\":\"153ee11d3831ea6d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/config.js\":\"603fc2ae1c7b1c27\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/dataExtension.js\":\"cab9d163cc0390c3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/effect.js\":\"e283621a7298bc3c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/index.js\":\"6e97f275dafc8d27\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/propertyEditorOverride.js\":\"011ddda4050a5707\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/useToggleTree.js\":\"c6feecd691ffe95c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/ExtractTypeDialog.js\":\"d3de527d9fe981b3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"bd57835acdcf9d5d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/PropertyShapePicker.js\":\"c2351d0d7255b9fe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/action.js\":\"77a2814ecaf272f6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/index.js\":\"4ea1f7ca03829ee4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/FindReplaceDialog.js\":\"cf2d145ad6ff6e35\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/HeaderItem.js\":\"7f42d38ca8341d3b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/dataExtension.js\":\"a1e48c13074e8d22\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/index.js\":\"fc2bb4fa810a9458\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/search.js\":\"e90c6e530ce3cf5c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/toggleStore.js\":\"988f46d017ae8db9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/LocationPropertyEditor.js\":\"bb742854a7458297\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/MapView.js\":\"944da0de8542886e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/blockTypes.js\":\"66f5ed9c7ca0797e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/codeMirrorExtensions.js\":\"72ebf3487bcb190c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/createOrFindPlace.js\":\"deb4d542b233b2ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/currentLocation.js\":\"44e43cdbc659f1d4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/dataExtension.js\":\"daa370010e04662b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/geoContentDecorator.js\":\"0babf96829872780\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/googlePlacesClient.js\":\"1c8e6f015eb9dcdc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/index.js\":\"b7a9d07bf73ccef3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/locationsPage.js\":\"1fb3f9fd73ebc547\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/mapViewport.js\":\"b8416b317d2ebc75\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/pickCurrentLocation.js\":\"54a0c3d42198a609\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/placeAutocomplete.js\":\"fb5c12f3dd46fb88\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/placeNameCollision.js\":\"7fbc72687aa4ebce\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/properties.js\":\"0d4f7e527873a643\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/propertyEditorOverrides.js\":\"d208346485c31363\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/query.js\":\"481d62f085d00fac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/usePlaceSearch.js\":\"b198953760f77e7a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"4997365a085a2e44\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e72d3cc2b43b3602\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3e1efba332687048\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/config.js\":\"5f8eba6409c15f9b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/dataExtension.js\":\"0e2d0d9b4f504f03\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/facet.js\":\"93e6ce65fcb0a524\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/grouping.js\":\"ca7031efeba6c704\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/index.js\":\"cbfd002a9b94bf80\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"cff3e198eb7d5f1f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/query.js\":\"bf6347b75f69d69d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/resolveConfig.js\":\"32e58594c0e7a01f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"427993bad5461abd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8f53e1f918711733\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/HtmlDocumentContent.js\":\"ebc62fc62ddc0801\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/HtmlFrame.js\":\"0109fc8fbcd69c50\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/actions.js\":\"e9b814499c7e08be\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/blockType.js\":\"94f861a4b5fd64ce\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/confirmRunScripts.js\":\"66b9a4ea1cc89450\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/dataExtension.js\":\"f6b9adc3f4381619\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameAnnotations.js\":\"9eb0c6308f9e819c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameDocument.js\":\"1c9cf467b4d3eeef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameTheme.js\":\"9413cb8b76feb49a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/index.js\":\"f996eda6dc706506\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/scriptConsent.js\":\"09ec5d44278676d1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/sourceMap.js\":\"1e1ff551599adc82\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/useDocumentScripts.js\":\"86709106c6e0e59c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/index.js\":\"dc00e4f65c2e0624\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/record.js\":\"36f78a3da8f6f5be\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/recordStore.js\":\"ecd04cfab9ce6225\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/responsiveness.js\":\"29faac8fb050e3fc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/schedule.js\":\"f57130bdfdfa19e5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/sessionContext.js\":\"9b33d4bedcb465b2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"8608a368cb9c7003\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"6fd0f33d48b213db\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/actions.js\":\"6c4a11c4c2166e34\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/config.js\":\"955a54508ac75ac9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/dataExtension.js\":\"f8440b2c1bb0ae26\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/effect.js\":\"0c6457dfc39d354b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/index.js\":\"40883ab71198c2bc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/keyCapture.js\":\"450e8cdc0fd7fb49\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/overrideStore.js\":\"d771e7449779ba38\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"9d2317d1e2072a18\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/HeaderItem.js\":\"c96a75e2dc76f4c6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/LeftSidebar.js\":\"19f5c46785365bf8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/actions.js\":\"04c00f4ccd771998\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/facet.js\":\"01f5da9296d964a5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/index.js\":\"12acf138d12ff366\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/shortcuts.js\":\"04283ee8dc2a1e9c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/toggleStore.js\":\"64c36af77f9ddb97\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/MergePicker.js\":\"6da21a873f1bd7f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/index.js\":\"ec639d72019788bc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/mergeAction.js\":\"c4b21e9985d388b5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/strategy.js\":\"233d862d97ad43ed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/Button.js\":\"4ac2de9d0eb01072\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6a13eaa171133ddb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/defaultItems.js\":\"15076435e5d84497\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/facet.js\":\"653f524d66c04013\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/index.js\":\"a6ac75f9552e6efc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"cb5d540dabec0720\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/actions.js\":\"241ad11400fc1603\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"34ff220385a16379\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/facet.js\":\"1f7bf7bb2c50bdf2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/index.js\":\"3fa60ead5731294f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/MoveDestinationPicker.js\":\"42895acaff4c9444\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/blockSubtreeMembership.js\":\"f3162d57d97046db\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/contextMenuItem.js\":\"4e12dfc99316c511\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/index.js\":\"c8e02f460e6edc00\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/moveAction.js\":\"00076e24f60e2ee4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/moveBlocks.js\":\"47ac14aa3345534b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/selectionAfterMove.js\":\"184501b9520a190d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/TutorialBanner.js\":\"7aaaa017b5f94938\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/action.js\":\"ae2d60b70aff1401\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/bannerDismissal.js\":\"8705e9df29394d18\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/documents/cheatSheet.js\":\"dd0fc841903510ac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/index.js\":\"dbd214660657fcb3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/keys.js\":\"1c1b7e4d73e3242f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/landing.js\":\"921ec4b16cf30354\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/outline.js\":\"8b6a0930f8f696dd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/seed.js\":\"4de1768da614a64d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8fdd75e7365133dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/analyze.js\":\"fcd5fba2fb1aacd4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/diagnosticsSource.js\":\"b26e3e2f6be83f14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/index.js\":\"135e5bfc737cf05b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/load.js\":\"82849a5b6da0fc2c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/monitorRun.js\":\"226ff64695de1321\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/schedule.js\":\"d7106b7ad338ed33\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/series.js\":\"070122d4d745905f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/store.js\":\"02ceb1cc1dba913a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/trendAction.js\":\"89352e7678823a32\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/verdict.js\":\"92c02811703e732e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/clickToEditAction.js\":\"ea89ab1ff855ac15\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/index.js\":\"112ad30b487ee3f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/interactions.js\":\"6c0f16aeb8b78b2a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"89cb878b2e2a9607\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/MigrationGate.js\":\"56dd7d0032e9774c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/MigrationGateDialog.js\":\"5693344cbed8fc61\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/action.js\":\"b8c90a7a8008bfb1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/index.js\":\"b09ce96c3068e2fe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/localRunMessage.js\":\"d91f70129cb0916c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/plugin.js\":\"90ca4c4592e76053\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/progressReport.js\":\"79c402259273f0ca\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/sweepProgress.js\":\"abeb88b834d8135b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/FieldRowRenderer.js\":\"00900c3967463847\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/ValueRowRenderer.js\":\"e041dbfe6095bd4c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/actions.js\":\"490fc6982ecb96a9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/autocomplete.js\":\"b7e505a998c14b9d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/fieldRow.js\":\"9997caa263a96399\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/index.js\":\"fe776c53b49717ce\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/referenceWarning.js\":\"b2eefb7fb1e3dc88\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/valueAutocomplete.js\":\"1488d825cc486aef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/valueSchema.js\":\"8f3f369f389bc892\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/HeaderItem.js\":\"2ab19f5ff96a1995\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/QuickFind.js\":\"f5e541707a0a458a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/index.js\":\"386220a4b227e46f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/recents.js\":\"d63a1c024f324dad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/resultItems.js\":\"dfd1f817e63685a8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/selection.js\":\"99c965576e83f3ed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/toggleStore.js\":\"ea430987137c94a3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/HeaderItem.js\":\"97e01fb8576b9bd9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/RecentsPageBlockRenderer.js\":\"85bef91a6dc194b0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/grouping.js\":\"eca0bbe5908547ff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/index.js\":\"5e98e9bc9b070fc0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/target.js\":\"9218c88d591d7874\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/codeMirrorExtensions.js\":\"ee28ab66d76d32a6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/contentPrefill.js\":\"b0c4bec668e54183\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/dataExtension.js\":\"2a1c010f638b591f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/index.js\":\"2b74303ee27f1dc8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a1086a4716a3dddd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/invalidation.js\":\"a8b9d315e1ce39c1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/localSchema.js\":\"ffa8273218bb00a6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/blockrefs/index.js\":\"2f500cdcb6e0de47\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f4428a47abdb11b7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/index.js\":\"171b011dcfde1e33\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/referenceNode.js\":\"f0f304fa897e877e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/remark-reference-occurrences.js\":\"11dc65b8c0e5332a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d000ebe87afa22dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/index.js\":\"6bd9b80f90177177\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"b80c71821c4bbe55\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3efedb8c33023154\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/mergeRetargetProcessor.js\":\"3d329bc132e4d6a5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/parseFence.js\":\"31b382b8cc822b86\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referenceParser.js\":\"e233fcd66332a542\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referenceProjection.js\":\"a0db0d9791a6e638\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referencesProcessor.js\":\"48c735a9aa442959\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/renameProcessor.js\":\"7051069d9499ecce\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/spanReplacement.js\":\"961d00929c86fade\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/htmlToOutline.js\":\"0c8227751bd5457a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/index.js\":\"4d9439213d85f767\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/normalizeClipboardDom.js\":\"cc2ff30686e52306\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/pasteDecision.js\":\"cec1f8e399ec7cc5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/action.js\":\"10746d35323fcf13\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/blockIds.js\":\"ef3c294e11ca75ed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/content.js\":\"6d06fe7f3c4d3121\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/effect.js\":\"8cb70e2d59b51907\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/ids.js\":\"a8e7047e9e5dddbd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/import.js\":\"b297c836050abd08\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/index.js\":\"41a640346fa2f898\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/plan.js\":\"5ee0836efa0b59e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/plugin.js\":\"cfa0280f0b13ab70\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/promotion.js\":\"515e8dddf3db7c0c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/properties.js\":\"69ee541efafc586f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/references.js\":\"97a581ebd22ec95e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/report.js\":\"eb07bdb6fa61d86c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/roamMemo.js\":\"b698ac061bcc0181\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/runtime.js\":\"93e0d8740d208238\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/schemaReconciliation.js\":\"d19f4bd2dee2148d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/srsMarkers.js\":\"ceca2425ab175a7e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/todo.js\":\"a15fb211932ee988\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/typeCandidates.js\":\"b1a03726b750c088\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/types.js\":\"4c96b02dd1d5817a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/search-health/index.js\":\"e050df20473b6c4f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/search-health/store.js\":\"2f84d68eb6a2a7a7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/HeaderItem.js\":\"4f1ddba297cdd354\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"5c0d3d28a81f88d5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/index.js\":\"be430425a3feaa54\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/model.js\":\"77dde46963568dc0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/toggleStore.js\":\"b173e39e2c919f52\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/useKeyInspector.js\":\"ea56a1ca3e7e7cd1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"4d2d09d06f035201\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/ShellDecorator.js\":\"0244d8a7d9cdbc91\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/actions.js\":\"9880a0c0c082b8e5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/exclusionsFacet.js\":\"77e7cb30f90c9f0a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/index.js\":\"6a62a7243850f04e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/shell.js\":\"e24cba2021ccba58\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/surface.js\":\"9953541bc6990bd2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/walker.js\":\"8e26c4493870fb2e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/RescheduleToast.js\":\"6af5526a36a689b6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/dataExtension.js\":\"98f2bf9399351b0d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/index.js\":\"d42497134d7c689d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/indicator.js\":\"13f79f04db934243\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/moveSrsState.js\":\"de9ef6634446071e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"40f96acb36c36b4d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/scheduler.js\":\"fd268046616ad98f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/schema.js\":\"419a0427e47d27ab\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"528eadf981acb8f6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/srsClipboard.js\":\"900337fb3de30840\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e3fcaedf054cb783\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ec0a1149482573c1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/DeckPicker.js\":\"6e5ddc0fced53f59\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewControls.js\":\"0ed59999d53fe65e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8e6ad8b2a8b9a6bb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewSession.js\":\"65d662d7bab6d99b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/actions.js\":\"e5c4052d76057d29\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/archive.js\":\"bd1105bc1df7fdad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/dataExtension.js\":\"9fa16b53547f2382\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/deck.js\":\"29d1a7841b420d59\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/dueQuery.js\":\"f30ccf6a822344ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/gradeDecision.js\":\"542709c849d9b29d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/index.js\":\"8493ab97dbf5cf51\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/keyHints.js\":\"3ccb848e8353d927\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/reviewCardLayout.js\":\"ea2180abe9b1a1c5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/reviewProgress.js\":\"b58ed7a5a9fbf3d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/schema.js\":\"c638618ebe351139\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/useDueCards.js\":\"0c28e169c888334d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/startup-metrics/index.js\":\"49a21812122c0bd0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/startup-metrics/record.js\":\"5382420d1a53b400\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/index.js\":\"b54fdd5b1576e389\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/persistenceStatus.js\":\"bb522f00c9f6df49\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/requestAction.js\":\"457495aadb1c3ac5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/TypeChipsDecorator.js\":\"0a271712f83ebcaa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/codeMirrorExtensions.js\":\"24e50c762f9bd790\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/index.js\":\"424820b69c10260e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/typeAutocomplete.js\":\"56f572d6cd452fed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"4295bda4861a6fd0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/actions.js\":\"e54fa7584ce93f8b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/anchor.js\":\"7fe657207b35545a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/events.js\":\"ea9af3b602fa96b6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/gestureActions.js\":\"71410b4dff47b565\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/index.js\":\"ad00f3b40ecdf095\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"c8005ce3030e6890\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/collect.js\":\"81474118583b95c6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/index.js\":\"46a4c4e1381e4207\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/record.js\":\"e02a98a9a9acf94a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/RejectionDialog.js\":\"95e4891f929a7892\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/SystemStatusHeaderItem.js\":\"2009b78540ff529e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/index.js\":\"04692b606cd06acc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/model.js\":\"9ff3d9999c4c47ac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/queueCounts.js\":\"3fbee696a6fa095f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/rejectedHelpers.js\":\"2c613374c732d55d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/rematerializeAction.js\":\"7fc939fd5286ee01\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/useHysteresis.js\":\"1e142252625a0245\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/ColumnHeaders.js\":\"f3f4cec6a3128f15\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/QueryUi.js\":\"5a3fc1b45caaf831\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/TableLayout.js\":\"cf2f85b96e1b7aa4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/actions.js\":\"abf6da59f410cc21\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/cellEdits.js\":\"c963de77b1679a15\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/childrenViews.js\":\"33e8277774a6301e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/columns.js\":\"bb1246cc2961623f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/controller.js\":\"9e8bdb8bf586a97f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/convert.js\":\"4353db899e9a596b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/dataExtension.js\":\"d639246a2961f86b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/index.js\":\"ca5433ff3142f7df\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/keys.js\":\"6991fe5980162311\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/model.js\":\"22dd64bc0508e65e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/backfill.js\":\"fca29ae168dd7200\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/completion.js\":\"f9d1e440ea3498dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/format.js\":\"c8f17ee4b082839f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/parse.js\":\"e11a5dba6f9910da\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/queryValue.js\":\"de708abd6c058288\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/source.js\":\"b6ccde6c08d7f7b6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/registry.js\":\"02364fa213a57fbc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/rowGutter.js\":\"7e73376c79822269\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/rowVerbs.js\":\"a0adc71cefb207f0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/schema.js\":\"9d14a063550fa95c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/sort.js\":\"94cda05376fe2d10\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/effect.js\":\"cd9d5fcc01b0d40a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/index.js\":\"520e617f2b7896f1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/theme.js\":\"e1f67638e3eb9cbc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/actions.js\":\"d57756cb08c121df\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/dataExtension.js\":\"acd8027093bece84\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/index.js\":\"e21919ebf3b8e0bd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/schema.js\":\"76b0cf732d419cb6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/TouchSelectionLayer.js\":\"bbb4a31cdf27e24c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/actions.js\":\"64c9ebe3581a9421\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/defaultItems.js\":\"76ffd31f2c1b8c05\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/facet.js\":\"0f59e67e9c469795\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/holdRecognizer.js\":\"9061c6dd0414d6ca\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/index.js\":\"42cedf264e42f61b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/UpdateIndicator.js\":\"0a74564222824d67\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/index.js\":\"2b1dc496c535bd97\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/loadTimes.js\":\"2e01e83daa077489\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoNotesRenderer.js\":\"69559c640cbc652b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoPlayerRenderer.js\":\"f9393be6a83137dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoTimeStamp.js\":\"bdca7913794262ae\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/actions.js\":\"9c11d6be64c890ae\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/index.js\":\"a641fec1290d1140\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/markdown.js\":\"265befa53db93ff0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/notes.js\":\"b86f0418e151bbb6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/registry.js\":\"ae1b3c479fdceb22\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/remark-timestamps.js\":\"a96f99ac017860be\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/view.js\":\"072ff65ada1c90a0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/LinkHints.js\":\"62edb7f6e177ec9c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/index.js\":\"3e916e0311afabda\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/model.js\":\"e763f63623ea7319\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/settings.js\":\"fb1bada57f29cba4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/actions.js\":\"71f5c9df73afb7e4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/index.js\":\"4392562cccce20b3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/interactions.js\":\"643dfb9b18c2f575\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/workspace-header/index.js\":\"c9eba4aa16d30af8\",\"/knowledge-medium/pr-preview/pr-1876/src/registerServiceWorker.js\":\"bd762bda3c17513b\",\"/knowledge-medium/pr-preview/pr-1876/src/requestPersistentStorage.js\":\"5e80ec6cb257ef1c\",\"/knowledge-medium/pr-preview/pr-1876/src/services/authRequestDeadline.js\":\"a052ec7e26141354\",\"/knowledge-medium/pr-preview/pr-1876/src/services/authStorage.js\":\"73a578cf9bc29468\",\"/knowledge-medium/pr-preview/pr-1876/src/services/powersync.js\":\"cf509a7560880bed\",\"/knowledge-medium/pr-preview/pr-1876/src/services/supabase.js\":\"1605f89629190480\",\"/knowledge-medium/pr-preview/pr-1876/src/services/uploadErrorClassifier.js\":\"0115b8a495d28308\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/ActiveContexts.js\":\"1ff4d0210f6650ac\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/HotkeyReconciler.js\":\"25235ad8c58523d4\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/WipeLocalDataDialog.js\":\"ba757a9e158a29f8\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/actionDispatch.js\":\"f8dc49c75c3ad68a\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/actionRefItems.js\":\"5bc47b72e0e20e38\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/applyKeybindingOverrides.js\":\"0838f2ead80d0db6\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/blockActions.js\":\"c674f72f5e0450b4\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/blockMergeGesture.js\":\"32f14968e23aaa13\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/canonicalizeChord.js\":\"d6e884daf4b5707b\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/defaultContexts.js\":\"efb2f9075048d46d\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/defaultShortcuts.js\":\"1b37dc26118fbc38\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/effectiveActions.js\":\"3ae33dc5bb46f9cb\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/gestureAction.js\":\"f6afd3664a052ecc\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/gestureBinding.js\":\"5f47c2538ad3bd23\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/holdRegistry.js\":\"0d37b00942992067\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/keybindingConflicts.js\":\"efc933fe9da8d84b\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/keybindingOverrides.js\":\"4a386c54691c890d\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/pointerAction.js\":\"2424aad4504a6bc9\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/resolve.js\":\"071a15cf0399f06f\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/runAction.js\":\"ec270889a0bbe709\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/sequenceMatcher.js\":\"07e52c6730f8092d\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/types.js\":\"078b49c1c3d161f9\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/useActionContext.js\":\"17699074d1253096\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/useActionDiscovery.js\":\"56b28a6fda066ba4\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/utils.js\":\"76c2e70a925e6c8e\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/bootStore.js\":\"e1cb411397086e8a\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/previewDatabases.js\":\"e8bf91cd75c5b310\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/byteTransform.js\":\"13991f26c6759422\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/attachmentCleaner.js\":\"033f03cef313ab42\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/attachmentParts.js\":\"81229f6c3d8d99a8\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/bundleParts.js\":\"ca36d7bb8c32277b\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/bundleRecord.js\":\"ac85202714743a8c\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/manifest.js\":\"11f52472094a6b76\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/takeBundle.js\":\"bfc54e7b6db79252\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/verifyBundle.js\":\"e7c43844a2221649\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/cleaningStage.js\":\"e2185fc0117606d1\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionKey.js\":\"f8b060130973b85f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionServer.js\":\"29f6b7528f6d5486\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/flip.js\":\"65fbaa4a2d378e2d\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/flipAttempts.js\":\"55bb53c6d3d5489f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/pages.js\":\"ceebccb93653d331\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/preflight.js\":\"5ff95400fa443e93\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/reseal.js\":\"ce014f662c49345f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/runConversion.js\":\"03555cdf1240e9ca\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/runLock.js\":\"aa611b32a404966c\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/sealing.js\":\"2aa23da650faebba\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/sealingStage.js\":\"50666c654f758594\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/stage.js\":\"5fb412780d031468\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/verifyReseal.js\":\"2c12e0cbfb324628\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/aad.js\":\"e18d0a2887ec9d99\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/aead.js\":\"c1ac6fecace6c928\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/base32.js\":\"92af6c01697edf87\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/base64url.js\":\"53438c65fd9c4e26\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/binaryEnvelope.js\":\"89412a161c00ee86\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/byteAead.js\":\"4b1acdf8114ee974\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/canary.js\":\"ee82f0247693848e\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/contentHash.js\":\"feb2e5d483a69ad6\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/contentKey.js\":\"b9dbc52ab6fa11ff\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/derivedIdNamespace.js\":\"045cdf2db1fafda2\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/envelope.js\":\"e9caec099a075f69\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/hex.js\":\"071abe88d364f7ff\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/sha256Hex.js\":\"24b688b69eab4784\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/workspaceKey.js\":\"cd055294aded1727\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/conversionState.js\":\"8cd55a0ff3918ff5\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/createEncryptedWorkspace.js\":\"87864e9c40df9c0e\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/pastedKey.js\":\"f6732157c3f41827\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8ce9e4eebf775cd5\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b6c0d64fcd1d5aae\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/keyStore.js\":\"6b001d06344e83f8\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/mintWorkspaceKey.js\":\"42685f2e802c3653\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/modePin.js\":\"e6051f3f36e726c6\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/openWorkspaceKeys.js\":\"573dc2f63201c79c\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/resolveWorkspaceEntry.js\":\"f7e84a801988a475\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/resolver.js\":\"ef5ed0df548a6501\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/workspaceAccess.js\":\"2beacbc607d7c2ee\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/transform.js\":\"a436f476753724ca\",\"/knowledge-medium/pr-preview/pr-1876/src/themeBootDefaults.js\":\"c854e24a9c2cc052\",\"/knowledge-medium/pr-preview/pr-1876/src/types.js\":\"1030eef7ba7d0162\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/ClientLocalSettings.js\":\"48a33db9ab472851\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/abortableSleep.js\":\"ca5dd9b041cdf696\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/array.js\":\"cd3aa9edc2cd6882\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/backlinkAutocomplete.js\":\"8b50f73dbd55fe00\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/blockCrumbs.js\":\"89550498415b8d43\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/blockrefAutocomplete.js\":\"c84edbe09302bb9e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/cadencedIdleJob.js\":\"040c6d68c52a2cc0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/callbackSet.js\":\"435eee19b73dda0d\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/clientId.js\":\"854322ab5cda00ea\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/codemirror.js\":\"84b5a43216f021bd\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/codemirrorCompletion.js\":\"1cb1985fdb3640ea\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/copy.js\":\"6b3ea3fca48e36ec\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dailyPage.js\":\"7b8fda5937e3e83b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dbForensics.js\":\"19b8fd3996bd3052\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dbForensicsHooks.js\":\"6616193ccb280c1a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/deleteBlockThroughUi.js\":\"e8fc537ccc5c2016\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dialogs.js\":\"356d74721de93afc\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dom.js\":\"b03f02192fdb06e0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/downloadBlob.js\":\"64cbba40ef74a0b3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/drawnWalk.js\":\"0466fe9214f697d4\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/exportSqliteDb.js\":\"10e2a30799a55330\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fileSystemAccess.js\":\"4173e5ff05dd4ffb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/flipSlide.js\":\"d59b4b02dc28ba8f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fnv1a.js\":\"8e63285cf5e1c00c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/formatBytes.js\":\"aa19c27e6cd910b4\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fuzzyRank.js\":\"cb8bcedd0ac436e1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/idbKeyedStore.js\":\"70b0078d424464e2\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/idleCallbackPolyfill.js\":\"99d7eca4f7b94fac\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/keyboardAwareScroll.js\":\"67f2bedb5af6b907\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/keyboardViewport.js\":\"52ee4714e75186a8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/lastWorkspace.js\":\"384117cf50ef3ea1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutColumns.js\":\"d3931c12971864ee\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutSessionDom.js\":\"0a185203280b351b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutSessionId.js\":\"215094879536f030\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/linkClickGestures.js\":\"501c8262dd3ec0cc\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/linkTargetAutocomplete.js\":\"a6de77f75d2de8d3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/localDbCorruption.js\":\"041bd5b32b0ef020\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/localDbRecovery.js\":\"6eb3087099d2e9b3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/markdownParser.js\":\"bd10d4d36a9bffe0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/memoize.js\":\"bf0623f82afaf588\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/nameFieldCommit.js\":\"fb6cc626723261ad\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/nameList.js\":\"33b01c1bd3215270\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/navigation.js\":\"1b8981a27bf0c96c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/omnilinerNamespace.js\":\"b521be1b77267ddd\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/opfsPageScan.js\":\"a28962caaca91a49\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelClearance.js\":\"700c01d025cc6f7f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelHistory.js\":\"709e0058f38c8648\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelLanes.js\":\"256688a94dd0ab89\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelLayoutProjection.js\":\"4e026d739a816651\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelScrollAnchor.js\":\"e92bcc50db987832\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelUrlFlags.js\":\"62b4ab94d1870245\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/platform.js\":\"4cc8d312973d8f35\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/pluralize.js\":\"7d3708295b75b53f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyCreation.js\":\"2e1b67cbfafd58f2\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyNavigation.js\":\"5d078315146a8a5e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyValueContext.js\":\"6dcd8b46aafcc626\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/react.js\":\"ae18a5648a3a0f7d\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/relativeDate.js\":\"5d7d139bf8ea5fb9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/relativeTime.js\":\"849f35e8f90caa87\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/renderScope.js\":\"40ef19089bb61d3e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/resolvedThenable.js\":\"e1a8b39b142b016b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/routing.js\":\"22c52387bb66e266\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/safeMode.js\":\"6471b463f0d5b139\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/scheduleIdle.js\":\"d41d299599b32632\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/screenWakeLock.js\":\"4fb55e23d1cf3dbc\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/selection.js\":\"4bd7f6be46ce5732\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/softKeyboardGrab.js\":\"d1ffbb881b8ff9c5\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/startupTimeline.js\":\"bfd7edf189bb1818\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/state.js\":\"2f2da3bd171b2d00\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/string.js\":\"9f92c05f460c1b06\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/surfaceZoom.js\":\"70c5afe29d2f1056\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/time.js\":\"9b7d46a478a80e90\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/toast.js\":\"9cde13f7866b5464\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/toggleStore.js\":\"2ae005268d3f8e06\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/untilStopped.js\":\"45896552c256554a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/userActivity.js\":\"acc499f15bd72c15\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/viewTransition.js\":\"5ac5009784ec6e71\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/viewport.js\":\"ea50e8e43aeda2b7\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/webLock.js\":\"f0e813b687eb2420\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/workspaceRecovery.js\":\"6ea98dd4f5c08482\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/workspaceSnapshotStore.js\":\"13ddea3aabd8607b\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-compiler-runtime.js\":\"b8b1f6c2f41da49d\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-client.js\":\"313287d41e15c49a\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-server-edge.js\":\"bd56803420a78e59\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-server.js\":\"eed6c7e4c1ed7028\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-static-edge.js\":\"5081e5c378ca9bba\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-static.js\":\"c7375178f16d809b\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-test-utils.js\":\"67ab643e06ac7ef8\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom.js\":\"bc3e0073e8d3ee16\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-jsx-runtime.js\":\"4f7deda7f995fff8\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react.js\":\"4d8ccad3f45bb96f\",\"/knowledge-medium/pr-preview/pr-1876/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1876/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1876/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
