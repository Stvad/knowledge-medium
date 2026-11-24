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
		buildId: "a9c39a98754a-d4badc52",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/\":\"a250fb48cd3aae39\",\"/knowledge-medium/pr-preview/pr-1876/index.html\":\"a250fb48cd3aae39\",\"/knowledge-medium/pr-preview/pr-1876/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1876/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1876/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1876/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1876/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/app.css\":\"e0e07bf319c24087\",\"/knowledge-medium/pr-preview/pr-1876/assets/FacadeVFS-QjCi6DWI.js\":\"5e5274e12fa22bc2\",\"/knowledge-medium/pr-preview/pr-1876/assets/OPFSCoopSyncVFS-wxp1Uqdx.js\":\"26e3c44a3087f499\",\"/knowledge-medium/pr-preview/pr-1876/assets/OPFSWriteAheadVFS-CVFEYFmB.js\":\"9c0c063f0b0aca04\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-8TWgCfd6.js\":\"a9534c7c077aec29\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-async-Dzf0FjH0.js\":\"cc0155b76245b694\",\"/knowledge-medium/pr-preview/pr-1876/assets/worker-CedGonAS.js\":\"f8bbe6a306fb4ba6\",\"/knowledge-medium/pr-preview/pr-1876/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1876/chunks/app-BWe5Hqcj.js\":\"68723204294c584a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1876/index.js\":\"00df70f3d0717c2c\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1876/assets/AccessHandlePoolVFS-Dia6ZnV6.js\":\"5a4b19079172a975\",\"/knowledge-medium/pr-preview/pr-1876/assets/IDBBatchAtomicVFS-CP0iq6pd.js\":\"11d774c0189783d6\",\"/knowledge-medium/pr-preview/pr-1876/assets/MemoryVFS-X1IFqAfC.js\":\"1e75a85b7e069894\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-BpOZgN39.js\":\"ce63225182905fa2\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-async-N55meU-N.js\":\"328756d3ba260649\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1876/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1876/chunks/AccessHandlePoolVFS-C8iV85eq.js\":\"cd340ed2ffa6a506\",\"/knowledge-medium/pr-preview/pr-1876/chunks/FacadeVFS-CvnujecD.js\":\"282d757934860245\",\"/knowledge-medium/pr-preview/pr-1876/chunks/IDBBatchAtomicVFS-D72Hu6qa.js\":\"addf9acfc4d798a8\",\"/knowledge-medium/pr-preview/pr-1876/chunks/MemoryVFS-C3yT7dO2.js\":\"99ba7aee8fd540dd\",\"/knowledge-medium/pr-preview/pr-1876/chunks/OPFSCoopSyncVFS-BWSuHG6_.js\":\"735c1ddff8b7f284\",\"/knowledge-medium/pr-preview/pr-1876/chunks/OPFSWriteAheadVFS-DHSSU8XI.js\":\"7aeb46478950aa9f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/Preview-a_gQ-hOP.js\":\"1ca1ad789e47e0f0\",\"/knowledge-medium/pr-preview/pr-1876/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/card-DyvDxT8o.js\":\"259b21cb5b92a645\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-CILQPytC.js\":\"b463cc2fc5e91c6c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1876/chunks/mc-wa-sqlite-B72rlJkn.js\":\"e0d08bce43e37242\",\"/knowledge-medium/pr-preview/pr-1876/chunks/mc-wa-sqlite-async-eLVkrJOT.js\":\"f049793fdf76158f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-B-qqRelM.js\":\"eb470efd2ddd5c6c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-B_BZFLyx.js\":\"193e5c687b39606e\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-CEX2HVUh.js\":\"94d9d08dc2d52734\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-CFgWG9KI.js\":\"4a9aaf62cc45ecdb\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-D20i5Xx6.js\":\"6961f67cd3a068a4\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-Pp4h1zc2.js\":\"e37cfe7404a49086\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dS2namiS.js\":\"abeb65b11c0030a5\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server-legacy.browser.production-DzPnDJny.js\":\"2a212bac097e87c2\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server.browser.production-DPmb3dgB.js\":\"61c041740f3a553c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server.edge.production-CBSw4abo.js\":\"fe156d2f2b3642b5\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-p1ltcXsk.js\":\"6b54d73127f3c94f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/server.browser-C4dqK0ZW.js\":\"31718a2e21f2e5a7\",\"/knowledge-medium/pr-preview/pr-1876/chunks/textarea-B0AtScKU.js\":\"21a318ca6e711a65\",\"/knowledge-medium/pr-preview/pr-1876/chunks/ui-DH68XhF3.js\":\"5a145b248fba3021\",\"/knowledge-medium/pr-preview/pr-1876/chunks/wa-sqlite-Cb0EYRpo.js\":\"5fb4e94cb4b50c1a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/wa-sqlite-async-BZU99hzR.js\":\"bed609b4f46da444\",\"/knowledge-medium/pr-preview/pr-1876/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1876/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1876/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1876/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1876/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1876/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1876/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1876/src/App.js\":\"882a4795b4ab45a2\",\"/knowledge-medium/pr-preview/pr-1876/src/appUpdate.js\":\"95b32ad64f4b5efd\",\"/knowledge-medium/pr-preview/pr-1876/src/appVersion.js\":\"ed72bd88cc14cc84\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/initialLayout.js\":\"e6dd3aed9c6c0962\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/openWorkspaceData.js\":\"321d9f2ac53ad889\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/resolveWorkspace.js\":\"9203071a27612932\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/workspaceBootstrap.js\":\"171bf6eb68fb1b93\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockComponent.js\":\"4aa12bb3c3f5b330\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockCrumbs.js\":\"be07156a4a00c32a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockEditor.js\":\"91a602176a6a9195\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockLoadingPlaceholder.js\":\"9fd6266d2adb4395\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockProperties.js\":\"1604bb3bd90a00fa\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockSearchPicker.js\":\"2c8b8369480f20c8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ConfirmBulkDeleteDialog.js\":\"498b3428c2b1d6e5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/DividerHandle.js\":\"ae58e996936d26e6\",\"/knowledge-medium/pr-preview/pr-1876/src/components/DraftEditor.js\":\"25e8c893640a259c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/GutterPill.js\":\"027ac392d12370d1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/Header.js\":\"dfb2a4e7f7ef69ef\",\"/knowledge-medium/pr-preview/pr-1876/src/components/LazyBlockComponent.js\":\"8b17c516c3bb9160\",\"/knowledge-medium/pr-preview/pr-1876/src/components/Login.js\":\"01fb5da410edae4f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ZoomableSurface.js\":\"2276cad120772e9a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/editModeKeepalive.js\":\"f411f27b9674febb\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyDisplay/PropertyDisplayScope.js\":\"aec50a282fe4ba89\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e1dd806f274bb953\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/RefPropertyEditor.js\":\"6818fa5ef765cb7c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/RefTargetTypePicker.js\":\"09d787618fba10d4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/SelectPropertyEditor.js\":\"be127891131fdba5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/TypesPropertyEditor.js\":\"b1370a9955f1d0aa\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/defaults.js\":\"b62cf56185741526\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/kernelValuePresets.js\":\"30a91a1688317b36\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/selectablePresets.js\":\"72607062652b1da5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/typesPropertyUi.js\":\"ce09c122b8d277a8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/AddPropertyForm.js\":\"1eaf9f209743ed10\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/PropertyPicker.js\":\"9b857852c7fdc973\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/PropertyRow.js\":\"eb4b8f1d7e7a2dd1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/Rows.js\":\"57d5cdaebea96395\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/actions.js\":\"15e7c577b3e486da\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/declarationOnly.js\":\"3b2b535e166098e9\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/layout.js\":\"f904abac3c85796b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/model.js\":\"59164ac8c88aeede\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/shapeUi.js\":\"4eb9b5575f678a21\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/shapes.js\":\"481841fb5cd8db3f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/usePropertyEditingActivation.js\":\"40233b40be1ea8e0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/visibility.js\":\"e90d2904ade1e491\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanelSections.js\":\"a44ea01052081530\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockEmbed.js\":\"bdd365b0f2635e1a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockLink.js\":\"6c0fa7d2090096e5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockRef.js\":\"6893128fbcbedf36\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/ReferenceLink.js\":\"78d5f82fceeef260\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/cycleGuard.js\":\"e895171aaaf8d0d3\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/cycleGuardContext.js\":\"e902c2a228c544c6\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/linkInteraction.js\":\"cdccdd25efb27e04\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/referenceLayout.js\":\"88d1fc73bedf39fc\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/useBlockRefAncestors.js\":\"6007c8784ac6b725\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockGutter.js\":\"ae2377bc6140f6f6\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockInfoDialog.js\":\"87360e996af3a395\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockTypeBlockRenderer.js\":\"6aa6aaa3199df792\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BulletHoverCard.js\":\"e0197ed961b25ef4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/CodeMirrorContentRenderer.js\":\"ad773d6365e44a91\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c2fff6e567d0dbb5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/ColumnResizeHandles.js\":\"5ca222adfa14163c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"7c0d12af96f9fbd9\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/DefaultBlockRenderer.js\":\"7a423a7765798973\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/LayoutRenderer.js\":\"64605073c713e89c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/MarkdownContentRenderer.js\":\"f331e54482ec4382\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/MissingDataRenderer.js\":\"c598b4f97f9c7501\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/PanelRenderer.js\":\"6c07007b333013cc\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/PropertySchemaBlockRenderer.js\":\"eb997a51f075811b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/TopLevelRenderer.js\":\"ec8c99b7e2b25715\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/blockGutterMode.js\":\"d34e38ae5a554b79\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/blockTitleText.js\":\"2e1f71de7a9aab1d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/fieldCreationKeydown.js\":\"c47278bf29e440c0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/layoutRootContext.js\":\"2d7fcb8773f58938\",\"/knowledge-medium/pr-preview/pr-1876/src/components/typeChip/TypeChip.js\":\"5081f1e301fff670\",\"/knowledge-medium/pr-preview/pr-1876/src/components/typeChip/chipStyle.js\":\"024bf397a03e73c5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/anchored-floating.js\":\"c32448776e840777\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/button.js\":\"75a81a400b34770e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/card.js\":\"79de63316a0c452a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/checkbox.js\":\"cf6b35e738ac9610\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/collapsible.js\":\"3f2dc0eb3e99d566\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/command.js\":\"d318f7b453ec333e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/context-menu.js\":\"cf962ab78fb6d336\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/dialog.js\":\"11f3ba87810921c9\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/dropdown-menu.js\":\"c8d7adaf117594c7\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/floating-listbox.js\":\"7f2f57ce5df48c13\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/index.js\":\"126cd5b39d2fea13\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/input.js\":\"6ee2b6f83deb08e1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/kbd.js\":\"335b3768de2bc92e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/label.js\":\"e383e0d358c4d362\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/textarea.js\":\"d71cf1bf4fed5e40\",\"/knowledge-medium/pr-preview/pr-1876/src/components/useEditModeYieldKeepalive.js\":\"af31ff75aa5c3923\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/BootFallback.js\":\"4f7d26cd1c563ab0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/FocusedRowLazyMount.js\":\"f03cd3ba500a733a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/LazyViewportMount.js\":\"283abfc722a8acb8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/LocalDbCorruptionFallback.js\":\"daae26b26b1dd788\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/error.js\":\"6627274ad0fbf022\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/lazyMountRegistry.js\":\"51ddef3de6be8fbb\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/suspense.js\":\"7a35003aa03c1ff8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/CreateWorkspaceDialog.js\":\"bed77067e2aa3889\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/PendingInvitations.js\":\"7a88ce719677eeb5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/SyncProgress.js\":\"c4d195b5628d2b57\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/UnlockProgress.js\":\"e292c95e1ac131eb\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceKeyGate.js\":\"9ebe5fdc83bde868\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSettingsDialog.js\":\"fee4ccb7b9dc224c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSwitcher.js\":\"0897e837b00103b8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSyncGate.js\":\"fba4f314277fcdc4\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/ConversionFlow.js\":\"ae1104ca400c2902\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/ConversionFlowHost.js\":\"4963010aef68f576\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/EncryptionSection.js\":\"405334ce94f338ef\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/attachmentPrompts.js\":\"646fded40778a109\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/bundleFolderPrompts.js\":\"afef9ca50d465f7e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/conversionFlowDeps.js\":\"c4725b3e4976ba58\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/conversionFlowStore.js\":\"2febd3d6c271888d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/flowUi.js\":\"a7f6be1f461d8ed0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/useConversionRun.js\":\"a054233e99e43de2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/keyUi.js\":\"dae11d54fc5752ed\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/useCloseOnKeyLoss.js\":\"81be8bf1861c5b8e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/useCloseOnServerE2ee.js\":\"85caafecbc85bfd8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/workspaceUnlocked.js\":\"a31108a8dc4d0f4a\",\"/knowledge-medium/pr-preview/pr-1876/src/context/backgroundSubtree.js\":\"6059277a4b9c244e\",\"/knowledge-medium/pr-preview/pr-1876/src/context/block.js\":\"c75442d574f056f1\",\"/knowledge-medium/pr-preview/pr-1876/src/context/layoutWsContext.js\":\"63dee970b8a04e17\",\"/knowledge-medium/pr-preview/pr-1876/src/context/propertyDisplay.js\":\"01459df33e287f6f\",\"/knowledge-medium/pr-preview/pr-1876/src/context/repo.js\":\"e22a443cb54731d0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/aliasClaim.js\":\"81b0f42116cf40d6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/aliasSeatNamespace.js\":\"c1edad2b2d7e7110\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/blockData.js\":\"49230c7c87104a62\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/blockType.js\":\"5dabf5c6f906297a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/changeScope.js\":\"6324eaeec0d1b81c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/codecs.js\":\"d84fdc5f21ef0e61\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/derivedData.js\":\"c2793fed3f7f80c4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/errors.js\":\"542a24cbd8a5c9b9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/events.js\":\"2fb9f3321441938e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/handle.js\":\"5b7d6d4c4e8bc1cb\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/index.js\":\"f8591e63df299432\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/mutator.js\":\"66c0470518733bcc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/processor.js\":\"a8a3d39bfbb3a42d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/propertySchema.js\":\"8c0591ea20444acd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/query.js\":\"f61c9f929a1880e7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/sameTxProcessor.js\":\"2b2bec48a7ae52b0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/schema.js\":\"5b7d6d4c4e8bc1cb\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/tx.js\":\"5b7d6d4c4e8bc1cb\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/typedBlockQuery.js\":\"29fb94db0348872c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/user.js\":\"d3b9857dee53d893\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/valuePresetCore.js\":\"a9aff16284b52898\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/valuePresets.js\":\"038a5688eb759625\",\"/knowledge-medium/pr-preview/pr-1876/src/data/attachmentCleanerIOVerb.js\":\"11dbfd6cf20e1b78\",\"/knowledge-medium/pr-preview/pr-1876/src/data/block.js\":\"b14b0c5fb3776f59\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockCache.js\":\"7df6833b80831e60\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockId.js\":\"294cbe6e5a3fbe9d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockLiveness.js\":\"adc2fa57445f1117\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockMerge.js\":\"f0e4c86e75033b75\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockSchema.js\":\"58c2a2e8fe804645\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockTypeLookup.js\":\"73b55fb2b041712d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockTypes.js\":\"790d4900a25172d7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/childrenView.js\":\"19b9c88ca99da9c3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/clientContext.js\":\"40a8a8939d8a9f30\",\"/knowledge-medium/pr-preview/pr-1876/src/data/dbFileSiblings.js\":\"8fe02b3307a33ff4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/definitionSeeds.js\":\"c25576080b183157\",\"/knowledge-medium/pr-preview/pr-1876/src/data/derivedIds.js\":\"00a6f7c91336af64\",\"/knowledge-medium/pr-preview/pr-1876/src/data/drawnSubtree.js\":\"2ccce6441d3f62c8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/facetBridge.js\":\"990110b5b4af26db\",\"/knowledge-medium/pr-preview/pr-1876/src/data/facets.js\":\"7435a7392d34fea8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/globalState.js\":\"69661d65a74f513e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/aliasClaimRederiveProcessor.js\":\"606f082046bb1f83\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/ancestorBatch.js\":\"f9ce3249648ebabd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/blockTypeTypeifyProcessor.js\":\"53d636ea67e0c53c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/clientSchema.js\":\"e86e2eef20e7604e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/commitPipeline.js\":\"d39c2b47dd22ede1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/devAssertions.js\":\"194a56ae54f27949\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/firstSync.js\":\"55d3bf716bd4b1e9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/freshInitialLoad.js\":\"560401341de34f94\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/graphBackfillClaim.js\":\"0dae59fd6e7daa62\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/handleStore.js\":\"24eac8c5543d415c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/idleMarkerJobs.js\":\"79614a26cd054389\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/initialDownload.js\":\"cadfa63bfba707d3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/initializeClientDatabase.js\":\"733147866f17096e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/jsonCanonical.js\":\"9ee3712ff8efad82\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelInvalidation.js\":\"83e6c18e57f8fc7c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelProcessors.js\":\"99b065b722880bf5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelQueries.js\":\"c292ec646791aaf3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/mergeTypeMembershipProcessor.js\":\"4742ff5426e63607\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/normalizeReferencesProcessor.js\":\"d5a3975d2baf041b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/poolInstrumentation.js\":\"861edb3871c28973\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/processorRunner.js\":\"165e43d91e238674\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyCellBackfill.js\":\"81ced8996a545bcd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyChildMint.js\":\"8d6a6f78d4a1d07a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyChildrenProcessor.js\":\"226d97d9c23412e7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyDefinitionChangeProcessor.js\":\"76097610ace201c1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyDefinitionSynthesis.js\":\"78741e3e4e0cd526\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyKeyScan.js\":\"e7d0053fbe225e9e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertySchemaResolution.js\":\"ae8dea90a690bd19\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyValueEdits.js\":\"246151860ca7f88a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/raiseProtocol.js\":\"502a8caed3715c25\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/readBatch.js\":\"1b9099527a1d8c2c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/refProjection.js\":\"6425daba007ac6c0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/referenceTargetLookups.js\":\"0b9062a7a5737920\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/referenceTargetProcessor.js\":\"0557bcf4d900331b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/replayMerge.js\":\"aa135211d6b651c1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/sqlBinds.js\":\"bb75177b029a96ef\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b67a49daea06c1d3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/arrivalProcessors.js\":\"14444e16cc30269a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/invalidate.js\":\"090956db9398a2fa\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/materialize.js\":\"4e7901da03419d96\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/observer.js\":\"5a2ddfa4e9791d31\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/reconcile.js\":\"87734777312c692c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/timingMetrics.js\":\"bd9b8773cb4de279\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/treeQueries.js\":\"854772e5a939d1aa\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/txEngine.js\":\"84737a995206dac4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/txSnapshots.js\":\"347e1344b3349fae\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/typedBlockQuery.js\":\"7a2016bc784d75b4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/undoManager.js\":\"affb03920b0a0685\",\"/knowledge-medium/pr-preview/pr-1876/src/data/invalidation.js\":\"c9e279d3ee8c2358\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelDataExtension.js\":\"b3eff16b48fd6885\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelPage.js\":\"6835b13bd1bce870\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelValuePresetCores.js\":\"03f27be3dd1969ad\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbCorruptionSignal.js\":\"efc15eeae2aad0b2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbStorage.js\":\"2d6cf8af0ad6f1ea\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbVfs.js\":\"310adc59d3df0d43\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localSchema.js\":\"ff1e5f7759794bd7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/maintenance.js\":\"073e224fd4761141\",\"/knowledge-medium/pr-preview/pr-1876/src/data/mergeProperties.js\":\"8942217b2046edc1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/metricsConsoleHook.js\":\"2de7ae9b0604576c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/migrationsPage.js\":\"36834015fe53d829\",\"/knowledge-medium/pr-preview/pr-1876/src/data/mutators.js\":\"7055d26a01c864ae\",\"/knowledge-medium/pr-preview/pr-1876/src/data/orderKey.js\":\"6ceffdbb7c52e129\",\"/knowledge-medium/pr-preview/pr-1876/src/data/orderKeyPlacement.js\":\"69425baa68d5d5c9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/outlineSurface.js\":\"ebcdfc1ccefc0c8a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pendingEditorContent.js\":\"bf9732efd39523ee\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pendingUploadsSql.js\":\"b74ce0bf9701de5d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pluginStateExtensions.js\":\"075ec92136b4dce7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/powerSyncLogger.js\":\"7b8ddfc8e19412a5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/projectorRuntime.js\":\"b7cca65d10fd63f1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/properties.js\":\"c7107cfa620e7a9f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertiesPage.js\":\"b4d1d0a2f52d3b24\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyChildren.js\":\"694d3d7eb0bf5224\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionFanout.js\":\"8158bf948ad3231e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionMetadata.js\":\"f072652f4254845f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionRegistry.js\":\"19f0b56035b8f764\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDisplayMode.js\":\"e78bccc59f378ef1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyRowCreation.js\":\"05fc6dfe25fd6efd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertySchemaCreation.js\":\"0ff28b271c767620\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertySeeds.js\":\"f504d012516ae807\",\"/knowledge-medium/pr-preview/pr-1876/src/data/recentsPage.js\":\"d486fea1d4952b47\",\"/knowledge-medium/pr-preview/pr-1876/src/data/referenceBlock.js\":\"225ed680e6c5552d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/rejectedUploads.js\":\"14b620c7e4b7d749\",\"/knowledge-medium/pr-preview/pr-1876/src/data/releasePowerSyncConnection.js\":\"d723dab119af99a0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/repo.js\":\"533426888bea2545\",\"/knowledge-medium/pr-preview/pr-1876/src/data/repoProvider.js\":\"6be758f74f910af4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/rowProperty.js\":\"c71d5a3a254ae1ed\",\"/knowledge-medium/pr-preview/pr-1876/src/data/searchFilter.js\":\"247f5c0cd96016c8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/seedIdentityLedger.js\":\"4b2c1b89c7226882\",\"/knowledge-medium/pr-preview/pr-1876/src/data/stateBlocks.js\":\"fe5240d323e38f17\",\"/knowledge-medium/pr-preview/pr-1876/src/data/structuralEditPolicy.js\":\"07b9275072df644c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/structuralInsert.js\":\"0f12f05627e4dd5d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/subtreeDelete.js\":\"df6e8e95b11990e5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncStreamLock.js\":\"4bdcaf1920b97c0b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncedTableSqlRecognizer.js\":\"9a7b812036b13b19\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncedTableWriteGuard.js\":\"c8d7e55859781e8d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/targets.js\":\"7993cc36ed0afc21\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeColors.js\":\"31edff6e8f86e5cf\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeDefinitionMetadata.js\":\"9a0e720986d305a5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeDefinitionRegistry.js\":\"735b1541cf05979f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeExtraction.js\":\"169bc0699977ef3e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeInitialValues.js\":\"e1bc80f724f767dc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typePropertyGroups.js\":\"ece4930171d47aac\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeSeeds.js\":\"13915f984138d329\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeTagger.js\":\"7abc8ec91c314427\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typedRecords.js\":\"c69532c8877f2520\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typesPage.js\":\"b0024a4a08c61543\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userPrefs.js\":\"c834880b877e720d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userSchemasService.js\":\"2fdc45d2f4008c2a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userTypesService.js\":\"c7fa6fbc63deac15\",\"/knowledge-medium/pr-preview/pr-1876/src/data/valuePresetRegistry.js\":\"7ef0550f803d8e1f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/visibleChildren.js\":\"22db9932fb327cec\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceConversion.js\":\"e0350ff299e1aa6e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceFirstSync.js\":\"89f1f5baa215c50b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceIdNamespace.js\":\"e0373e57f3a3a70b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceSchema.js\":\"5fb461dcd3c091b7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaces.js\":\"8cd2d67e04732f02\",\"/knowledge-medium/pr-preview/pr-1876/src/data/writeAheadLog.js\":\"02af54c5aa02e605\",\"/knowledge-medium/pr-preview/pr-1876/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/BlockPasteShellDecorator.js\":\"948fceb945471ae7\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/atTrigger.js\":\"ceeb6198ccc55097\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/autocomplete.js\":\"cda097a9f0f25635\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/codeMirrorExtensions.js\":\"a95318d0b96efb58\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/contentFlush.js\":\"959c20a21e699483\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/defaultInteractions.js\":\"62b183a317d20512\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/editSettleSignal.js\":\"7d51363f271fc7ff\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/insertImage.js\":\"5cfa62b3587e8f3f\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/referenceCompletionRange.js\":\"2ebecd26632d20cb\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/referenceTargetTypes.js\":\"3a4e5e60d41b60db\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/syntaxContext.js\":\"6b195d22227372d4\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/triggerMatch.js\":\"bc5a4ee706b0f4c5\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/AppRuntimeProvider.js\":\"e27c7a1528a29b81\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/BlockFocusShellDecorator.js\":\"794d0d0447ec11b8\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/ExtensionRenderBoundary.js\":\"ccb1acee6da46a5c\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/PanelContentRecovery.js\":\"bb843a98533a55f0\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/apiCatalog.js\":\"e699aa2e78de1583\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/approveExtensionHere.js\":\"2d94b710041f1d71\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/armedCutAppMount.js\":\"ffdef95c6d0126fb\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/batchableKeyedStore.js\":\"c81bff69bbd27121\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/blockInteraction.js\":\"40f45fcc78ab1f9a\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/blockSelectionAction.js\":\"1b56a5456b10bed1\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/compileExtensionModule.js\":\"5be06146ca42d491\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/compiledModuleCache.js\":\"e9cd0318e4acc6d1\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/continuousGestures.js\":\"b4ebd69b4dda9aca\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/core.js\":\"eb81409819069c54\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/defaultRenderers.js\":\"a94f6538a148bedd\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/definitionFanoutAppMount.js\":\"2b544c4b5ac5fdd0\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dialogAppMount.js\":\"6378849f05381e1a\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dynamicExtensionSeeds.js\":\"54083af4e2b64849\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dynamicExtensions.js\":\"a15066a9a9d58259\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/exampleExtensions.js\":\"818273eab5a70ec2\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionApprovalStatus.js\":\"e333ac849e9b3577\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLoadErrorToast.js\":\"ff89d256ee4ee732\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLoadErrors.js\":\"5b46f53df24e980b\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLookup.js\":\"d906a358fb4f04b7\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionToggles.js\":\"55172f4a2c4b7c08\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionUtilitiesCss.js\":\"c89413329fcac8a8\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/kernelPageDeletionGuard.js\":\"b22afc13f27c075d\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/liveRuntime.js\":\"cd950537d9a5a03f\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/openExtensionsSettings.js\":\"300596dfe74aae58\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/overridesCache.js\":\"93674a2ca6ef54a0\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/pluginIds.js\":\"d89c5de2e9f4bcca\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/processorRejectionToast.js\":\"bd4a2c5fe6379529\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/runtimeActions.js\":\"391e7f9ebff943e2\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/runtimeContext.js\":\"77006b430aa7ca61\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/staticAppExtensions.js\":\"52d9a5b345170370\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/staticDataExtensions.js\":\"27a5b17a0020e0ec\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/toastAppMount.js\":\"616f763021fefb14\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/useOverrides.js\":\"006b18f864f184a3\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/useShortcutSurfaceActivations.js\":\"4d2be7f153075edc\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/discoverToggleTree.js\":\"7300a7bf53c558d0\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/facet.js\":\"51b37fee4bb00680\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/resolveAppRuntime.js\":\"9a7e21a74b030f78\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/runtimeEvents.js\":\"12313dcf74d9e751\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/togglable.js\":\"87fd1b64636f61fb\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/variantFacet.js\":\"368478640f4a752b\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/verbFacet.js\":\"2db88ea7eda62d29\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/block.js\":\"af2131c6a85b64a5\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/focusedChild.js\":\"edddd42e9520bf13\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/propertySchemas.js\":\"359268a0a96755d4\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/typeRegistry.js\":\"f1a1cfe786a02389\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useAncestorCrumbs.js\":\"6c75ff5aba23b63f\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useAutocompleteListbox.js\":\"6cc9dff6837b44f2\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useDebouncedSearch.js\":\"7ee3c220bf95bc5a\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useDebouncedValue.js\":\"d5a601c7ac108966\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useIsFocalRender.js\":\"c8fe323b9421d11e\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useIsReadOnly.js\":\"fcbd6efc6d226975\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useMaterializeBacklog.js\":\"8fc3c2195281506f\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useMinuteClock.js\":\"ea43ea4e50756070\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/usePanelLayoutProjection.js\":\"c30c303c225bcad7\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/usePendingInvitations.js\":\"3a690525fc9ada66\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useRendererRegistry.js\":\"01dc5c0a710ff70f\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useRetainedFieldRows.js\":\"ce9eccc662e6d226\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useWorkspaces.js\":\"b8369466dcc23a2a\",\"/knowledge-medium/pr-preview/pr-1876/src/lib/utils.js\":\"95efd409b74290bb\",\"/knowledge-medium/pr-preview/pr-1876/src/main.js\":\"40123f91ebcdf7f2\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/MarkdownImage.js\":\"4fdd19ebaf1cec61\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/blockSeparators.js\":\"a5f44e352ae23004\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/context.js\":\"0533614a52e8ef3d\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/defaultMarkdownExtension.js\":\"f46510a474891a68\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/extensions.js\":\"d33944e2f58c5b34\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/renderMarkdownHtml.js\":\"8a60502a6360b775\",\"/knowledge-medium/pr-preview/pr-1876/src/minimal-editor.js\":\"da061e2c7a993d13\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/armedCut.js\":\"276f4ec4f61594ae\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/captureMediaVerb.js\":\"eaa3f8fdd4e9aabb\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/clipboard.js\":\"8604eed9e0cfed82\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/decision.js\":\"5657e1267bb2e3b6\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/operations.js\":\"cb5b9cbae61fd912\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/account-header/AccountHeaderItem.js\":\"99a3c092a2938926\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/account-header/index.js\":\"957f7821bb583a46\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"0880ce0217f42515\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/askAgent.js\":\"831d95172e65618b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/askedStore.js\":\"dba4fa36c75276ce\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0c2d525d55ebee2b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/chipState.js\":\"526b78ac3b377416\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4a87486f7e738b93\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/index.js\":\"7f4321e83684f42e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"0b9a0ead714e894d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/schema.js\":\"588b0d397c83cc06\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/AgentTokensDialog.js\":\"bd7621727bd66725\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/BridgePairingDialog.js\":\"07c1d1bc1362a888\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/addMedia.js\":\"8552d352a08b33e3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/backlinks.js\":\"c0fd387f3761b668\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/block.js\":\"97e06cd75eecf820\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/context.js\":\"002ae179c1f9a59f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b4a5d63794426f2a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/index.js\":\"55071c91199fe7b0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/outline.js\":\"298c9ed777b7c754\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/properties.js\":\"2724eb71f7b3e935\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/refs.js\":\"207d0aec4364c73e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"72c0b19b3788a081\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/search.js\":\"09600ce7bcb79626\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/shared.js\":\"cec4c2500095fa5b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ce9a0e827872d31c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/text.js\":\"b829d4d3bc28ba6f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentWrites.js\":\"1de10cfba81a4f23\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/authoringCatalog.js\":\"96337f4171b80e44\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/blockRefTargets.js\":\"7a055e7c672e0037\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/bridge.js\":\"8197371cd6ebf5f3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/bridgeLoop.js\":\"5504e16992dcd0b6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/changeHistory.js\":\"6e73d84ef704bc08\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/commands.js\":\"4cb1c05dca71820c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/commentsCommands.js\":\"576349a3daddf19d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/dataExtension.js\":\"4ac2506b2057415c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/dataModelGuide.js\":\"f7be303d5107c608\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/describeRuntime.js\":\"aedb869c4d47b140\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/extensionLint.js\":\"9d1a96ba360bfa2b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/grainAudit.js\":\"0fcf8ab131265260\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/healthCommand.js\":\"1e795f84a26e2fe2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/index.js\":\"74785f8d8a67bc54\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/presetIdentity.js\":\"7e940b283fd1f8bd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"eeefcdc1ca0b096d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/readMedia.js\":\"07f3650ae0fac6cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/schema.js\":\"d08f99790f3bda08\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/serialization.js\":\"87170173f90bfce6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/targets.js\":\"cb8030f6ab9f849f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/tokens.js\":\"30e5d1566be90d50\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/watchEvents.js\":\"d504819b4b49faf9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/workspaceGuard.js\":\"c04f18351fd5c1a2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/writeCommands.js\":\"26f3346c50d70899\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/AliasCollisionToast.js\":\"eca32665abf5b3d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/DuplicateNameBanner.js\":\"8c1ec0de247d8c3b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/collisionMerge.js\":\"c0ef858e6481bc18\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/dataExtension.js\":\"ec55aaeebce3088e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/index.js\":\"26d977688eba2626\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/mergeCollisionAction.js\":\"0a78b55ba1af6192\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/pageStyling.js\":\"31b7066e402b8855\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/rejectionToast.js\":\"c6d90e93b7cb8b82\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/syncProcessor.js\":\"197f120d40578797\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/actions.js\":\"bdf1de8335942929\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/addComment.js\":\"9ad2b43783c5b4b3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/anchor.js\":\"1fc76e525be9c37b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/anchorState.js\":\"fdc02167603898de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/commentLinks.js\":\"249542b06d06d4ca\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/confirmThreadDeletion.js\":\"92f9ded1b5234903\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/container.js\":\"7efa37270ed29f98\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/dataExtension.js\":\"a21a95f2ab951227\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/deleteComment.js\":\"514ccf2a2217d07a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/highlights.js\":\"a2e495eec883127a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/index.js\":\"a9ca49216978b8f6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/linkedCommentsPill.js\":\"d8266c9229f04f6d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/margin.js\":\"cfd3832b5c0617d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/marginAnchorLinks.js\":\"7f94a45e96119c1d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/marginSchema.js\":\"bd786ea57a8b9beb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/newComment.js\":\"9da46edc0fa61b29\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/ownThreadPicker.js\":\"0fdc0cdf3591ea94\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/placement.js\":\"cecdc5d5a6fe3f9e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/queries.js\":\"d779c205df39e1b3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotePosition.js\":\"1836a8b8aceebb57\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotedIn.js\":\"a4ede5227eb05322\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotedRange.js\":\"eae7c7f362d0dcfb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/rangeRefs.js\":\"b708723f1dfaca4b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readHighlights.js\":\"0d8f1177c1acc137\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readSelection.js\":\"762af111e4398e90\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readSelectionUi.js\":\"49a3a1f623f9b2bb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/reanchor.js\":\"e225bf537ebe1c29\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/schema.js\":\"afa9c5fba321fe30\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/scope.js\":\"8cd6688b6519ec85\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/scopeThreads.js\":\"5110a3e93449cde5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/splitRetarget.js\":\"d72775ad3940a664\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/suggestionCard.js\":\"d07d2307dab3ea97\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/suggestions.js\":\"ce1b1b04665ff823\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/summaries.js\":\"0a9323b1d8f67732\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/summaryBatch.js\":\"21d461f716af52be\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/surface.js\":\"9ebb5667bde47127\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/threadNavigation.js\":\"556bfe3264b6dbbc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/threads.js\":\"654dc2525a94b3ff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/ui.js\":\"095c98baa77748ca\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/uiStore.js\":\"420725c9c83e5155\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-intents/appIntents.js\":\"ae962924c5566ac9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-intents/index.js\":\"2e096e7ce9713fcd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-update-prompt/index.js\":\"9d1579592e11a007\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-update-prompt/status.js\":\"771fe00a712806f4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"ae9f129c476d1208\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaBlockRenderer.js\":\"cebd4013fcf654a4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaDownLaneReplicator.js\":\"a5914bdb224843ea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaUploadReconciler.js\":\"750cfc19c56ef694\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetDownLane.js\":\"06128bfbca8ddd5f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetResolver.js\":\"87f4b624b36e1fdf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetUpload.js\":\"5256d56561b82b5e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/attachmentCleanerIO.js\":\"8893e02b75e37f99\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/supabaseAuditIO.js\":\"632633b54ef216de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/blobStore.js\":\"08e86842f61e9170\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/browserMedia.js\":\"f8b5e0b622b6fc21\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/byteStore.js\":\"d6b8029f59728d23\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/cleanerIO.js\":\"bc5135a18e67040b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/cleanupAttachments.js\":\"a5e19280cdd7bab0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/dataExtension.js\":\"c4c397fb0b96af04\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/downLane.js\":\"b92afa48cabe19d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/index.js\":\"1f843a349052a0ab\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/insertImageContribution.js\":\"118c5c8c0f1df2a6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/laneArming.js\":\"46a98be63dd4a912\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/laneLock.js\":\"005fceb567be0d72\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaBlock.js\":\"47888ceb8d4e23cc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaCapture.js\":\"9c651c05b8b595c9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaLanes.js\":\"f9dacfa06a6dc536\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaViewers.js\":\"e07a4959009487ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaViewersFacet.js\":\"e3d23dacca545f83\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/pasteCapture.js\":\"e4d36f356a2e0237\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/resolver.js\":\"d35169750955a2bd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/retryUploadsAction.js\":\"ea48d6002bbea83f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/storagePaths.js\":\"ac3580c4ffd37d1e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadDrain.js\":\"11c4296226979c4a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadLaneStatus.js\":\"30343d2242c70e8a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadReconcile.js\":\"a7e9aaa0ace98bd4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadRecovery.js\":\"d92a8015cb774b83\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadStore.js\":\"2e18b1b7d771830a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/useAssetObjectUrl.js\":\"962c2e8d8b58c7e3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ace720a6428a9017\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/BacklinksViewSection.js\":\"076d61533e822313\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/facet.js\":\"75627061435bc6d7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/index.js\":\"4f30b9606ec7b80a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/prop.js\":\"7efce5ffaaf73bb2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BacklinkFilters.js\":\"75a41da36164cdb1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ca29460435f7fe4e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BlockEntry.js\":\"8630ea1ae9a82195\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/LinkedReferences.js\":\"0cf868d38b70d15e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c56aa04397f70c16\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/dailyNoteDefaults.js\":\"4683b99567f980e3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/dataExtension.js\":\"94bb814571c56413\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/edgeExclusions.js\":\"c200d81b3c16700b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/filterProperty.js\":\"f99f7c0e1e36f380\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/index.js\":\"40220f25e0395730\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"6fa5cc2bf21cc0df\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/applies.js\":\"1ac1fe511436a1be\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/countQuery.js\":\"a4a48e7858f4177f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f641c374d8ed6c15\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/index.js\":\"cb4f9263e54eeac0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"c9263ff77ddb61f7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/presentationInvalidation.js\":\"1909f73798e0ba43\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/propertyEditorOverride.js\":\"cc0367a5b018a20d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/propertyFilter.js\":\"ead78267fe8e2ee7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/query.js\":\"bcd44d2d663bafb4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/resolveFilter.js\":\"8e2e39d07faf3de2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/sourceBatch.js\":\"52e7eaba49350d21\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/sources.js\":\"1f51e6aa80c167b5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/useBacklinks.js\":\"b6559e46acaaa234\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2a66215f96b0c9f7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/BirthdayCelebration.js\":\"d645b0e418302618\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/BirthdayOverlay.js\":\"08ddfa2ea90a1488\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/gate.js\":\"55736550d111c1a9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/index.js\":\"9bbca2d2cd5abbfd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/wolfTheme.js\":\"0350b4efb4a5ffa8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/BlockDragLayer.js\":\"65d8df73918bc0ac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/dragController.js\":\"77419cc86661c4dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/dropTarget.js\":\"707593f72200287f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/index.js\":\"ef8dc43091f6f1b4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/projection.js\":\"3438ef691fcbc081\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-info/BlockMetaCard.js\":\"565ea62c07529d87\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-info/index.js\":\"cfdeaa9044a554e0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/AddTagDialog.js\":\"d19ff5c96c117ccc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c4a3795f100da018\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/TagNameIssueHint.js\":\"6cddabb154f30cb6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/addTagAction.js\":\"e821722f23fb677d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/appendTag.js\":\"5291f63951ae9f96\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/config.js\":\"57a2b08e68b64e3f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/dataExtension.js\":\"eddcc63773b1e422\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/index.js\":\"aaf2b2ed8e8903b8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/propertyEditorOverride.js\":\"7cbee2d255e436c1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/BreadcrumbList.js\":\"85eda4b898b7eac3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"58498e20ac599f01\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5d10534e2728e1c8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c86a17caa19b3cc5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8e45016098e131de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/index.js\":\"0c9618a84099efde\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"889a55ff1991295a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/CharacterCountItem.js\":\"9744e64c5c69069d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/ProfilePropertyEditor.js\":\"ec983c364af3044b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/actions.js\":\"d21c59b644ac9af2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/blockType.js\":\"6879ee92b75ed3c3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/charCount.js\":\"2410d7359bcbc0c9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/dataExtension.js\":\"59a1104899eb9d2a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/index.js\":\"1625f1ca59172562\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/profiles.js\":\"efe48410c978c4fb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/properties.js\":\"8bf6ee99a9a07eca\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/textCounts.js\":\"9d7306c3686d0454\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/colemak-keybindings/index.js\":\"0f314673c3a36fc7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/CommandPalette.js\":\"4f9aa10d98bae212\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/HeaderItem.js\":\"12ae5154874d20f3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/context.js\":\"96ce77850bd7d2c7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/index.js\":\"ead65d74f77de29d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/selection.js\":\"20910f5a0b3b8883\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/toggleStore.js\":\"ab853f7fa137eda6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/useCommandPaletteActions.js\":\"70180082dd05de40\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/ContributorBadges.js\":\"58d244fe72bc9c6e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/author.js\":\"8ec941dbc9a9b31f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/codeMirrorExtensions.js\":\"bcc94ddacf1dc77f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/dataExtension.js\":\"6e292c2000bb9e45\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/index.js\":\"15b340118d8f425d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/mentionAutocomplete.js\":\"51b1903e283a1aaa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/processor.js\":\"0d3663d475bc9d83\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/profiles.js\":\"bcc15c939b4841dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/queries.js\":\"6b0aa436fc133099\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/schema.js\":\"a236e2d71417a3af\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c336207bbcffe9b4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/followOrigin.js\":\"3af26c98018c80e8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/index.js\":\"5befc534a28e0007\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"91999feca1c5807c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"211b673291c210ff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/CalendarGrid.js\":\"ce85994024de788b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DailyNotePicker.js\":\"c97d558babf4a5d8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"da9707a4314aecd8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateNavDecorator.js\":\"a9fd984dc0343007\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateScrubOverlay.js\":\"e925db38ec081232\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/HeaderItem.js\":\"8883ac6833d7fb31\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/ReschedulePicker.js\":\"a5ba768a2ab90639\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/SpreadDatesDialog.js\":\"cfa9717a8e02b365\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/actions.js\":\"2369194a6e97736b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/blockDateAdapter.js\":\"5a1aa8ce335208e9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/calendar.js\":\"0c5608081d8c5169\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dailyNotes.js\":\"d949e164419666cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dataExtension.js\":\"734e746d77e05751\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubActions.js\":\"790d6af988d58cd4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubGesture.js\":\"cef5003d5d8f9398\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubGestureActions.js\":\"df4b47728afb57be\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4a2dc73c0958d0d6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/deletionGuard.js\":\"2aa8d8c760c3deba\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dueQuery.js\":\"feba469f9229db37\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/index.js\":\"fb02a783dec4dd1e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/landing.js\":\"8666ed563de6eafb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/localSchema.js\":\"51bd6da79936e432\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/referenceDateAdapter.js\":\"dd1b1d83acc273f8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/rescheduleAction.js\":\"79511a7fe13dbf1e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/schema.js\":\"4bb8a2aaf309b640\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/spreadBlockDates.js\":\"e9491d9699f6e3fa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/spreadDatesAction.js\":\"a182d35a2199e293\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/today.js\":\"449a1661dac1813a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"8f19ec9452d8ed60\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"afba17736b591ceb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/audit.js\":\"61f8e3599ae5b71d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/auditAction.js\":\"7421ea229ba30ec0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/auditRanges.js\":\"15e6f9c1eeba5d05\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/diagnosticsSource.js\":\"2079712edba76567\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/divergenceScan.js\":\"f59d7cc57cf1f4fd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/index.js\":\"54c6123c4d42c7bd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/propertyChildrenChecks.js\":\"2982c59bfff3e81a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/referencesMirror.js\":\"4bcb9e33c557198e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/rowJson.js\":\"0efdd2af3ccc5cbb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/schedule.js\":\"acfdd84043421ade\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/store.js\":\"67b8e3aec5954157\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/action.js\":\"bf5f88597e21b1a6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/index.js\":\"22bce2b0c2a928f1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/plugin.js\":\"79b6aef57c77873a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"332f1a537f923966\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/actions.js\":\"272f8a3b8d466ce9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/changeMarker.js\":\"c599593002bcd9d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/diagnostics.js\":\"40ab6a5acc2c977f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/fileSystemAccess.js\":\"73ea8cc74740f969\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/filenames.js\":\"7b8a9a2945d43f4b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/index.js\":\"34ecc9ecdb15587c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/mirror.js\":\"7ddb7cb377003e10\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/runLock.js\":\"f49a9dd8900c12e6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/runtimeHealth.js\":\"34523b8f59501cbc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/schedule.js\":\"b36cab2f988961fb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/store.js\":\"ce8710287136ef07\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/default-themes/index.js\":\"a0cbdc9a97d7a4c0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/default-themes/themes.js\":\"359b9ddc77f509bf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/diagnostics/facet.js\":\"46388c468b64945b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/diagnostics/useDiagnostics.js\":\"766b569f9740588b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/dismissals.js\":\"cb6e597fc7a8d3ec\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/index.js\":\"b68a02eddefefc40\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/status.js\":\"f1ec700922e122e9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/store.js\":\"647eedef263f105a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7d7c4634e7cc79f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d50472a160eb0e55\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/actions.js\":\"053ee98f2664e61c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/config.js\":\"8b7faa347a94a67a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/dataExtension.js\":\"7ce3615b6c0863a4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/effect.js\":\"63dc511ffe778a33\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/index.js\":\"dfcdc9bfa18280ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/propertyEditorOverride.js\":\"24d4a859634084e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/useToggleTree.js\":\"6c3a3c2e260ca766\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/ExtractTypeDialog.js\":\"cd7b7ce1fbafdf4a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"56309dae7b1ddf05\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/PropertyShapePicker.js\":\"f1bddc72bc8cf2d9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/action.js\":\"5fe1a13b22fb8586\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/index.js\":\"20b6db780f5e7fed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/FindReplaceDialog.js\":\"f647923c286d9d18\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/HeaderItem.js\":\"529676c6138c043f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/dataExtension.js\":\"d3437d935cdee059\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/index.js\":\"63edde2584408bc9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/search.js\":\"9dee5ff1e2f758db\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/toggleStore.js\":\"c625b7ed8e6f3407\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/LocationPropertyEditor.js\":\"dd11131af8e3ded0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/MapView.js\":\"45be70a52494678f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/blockTypes.js\":\"91f386c2a2ce4ddd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/codeMirrorExtensions.js\":\"b35813e6f6f6afd8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/createOrFindPlace.js\":\"913aa23e3c4971f1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/currentLocation.js\":\"5cb67abb768b27e4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/dataExtension.js\":\"57c8e0b48a18a5a1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/geoContentDecorator.js\":\"2d08ff1534eacc7b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/googlePlacesClient.js\":\"1ca33136a1a6526c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/index.js\":\"642840eb11c4346e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/locationsPage.js\":\"25299ecddf0e8c27\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/mapViewport.js\":\"652f6e2a306bae37\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/pickCurrentLocation.js\":\"1df69cb5864fc733\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/placeAutocomplete.js\":\"8d7a15141febca57\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/placeNameCollision.js\":\"2d71e13df8453077\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/properties.js\":\"e0f739f166daf8dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/propertyEditorOverrides.js\":\"7dcab9c01cb76b3b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/query.js\":\"21818b3bbdaf3f59\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/usePlaceSearch.js\":\"845cd64568516f27\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"718f1626f1f2c4f8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0a0d84405288156c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"5b8c29d3bbf19fd2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/config.js\":\"1d7d1f015923f051\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/dataExtension.js\":\"6ce55b9164b73805\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/facet.js\":\"ee46761e3f8ec246\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/grouping.js\":\"10318dff7acf9ba5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/index.js\":\"0e2d9748cc5f8934\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4390d3cd4adf9553\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/query.js\":\"272db7ae941f1e58\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/resolveConfig.js\":\"f1fbaf3905380201\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"54d28c7056b0b3d6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"718dc8edb63119f3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/HtmlDocumentContent.js\":\"436fa284afd5ea2f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/HtmlFrame.js\":\"61ab3e0d73e7656c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/actions.js\":\"a705450d6fd0bb17\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/blockType.js\":\"eac9b621df9f25bc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/confirmRunScripts.js\":\"26212292cc02434d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/dataExtension.js\":\"5ca061aa4561d533\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameAnnotations.js\":\"8760672094856f58\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameDocument.js\":\"55cdf35cbd8087be\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameTheme.js\":\"167b5a0c9804f829\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/index.js\":\"95ec61e9b9936a57\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/scriptConsent.js\":\"2277bef71fe83a8d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/sourceMap.js\":\"280bf1ed5bd3c43a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/useDocumentScripts.js\":\"c669f38d3f09acad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/index.js\":\"7283a13fb3ee32da\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/record.js\":\"926c74ef0ce58031\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/recordStore.js\":\"0058027d58a23a71\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/responsiveness.js\":\"1d136fd5f7708412\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/schedule.js\":\"d34504a02b82c7fb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/sessionContext.js\":\"75aa76a895f52614\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"dcf2b8decf4f6643\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"31a1df93215adf0e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/actions.js\":\"d60b477ec0a19bbf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/config.js\":\"7a4b38526d2a9ad0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/dataExtension.js\":\"1650ea9addfdb90d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/effect.js\":\"a5f543fb352a340b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/index.js\":\"33d41cd6484db657\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/keyCapture.js\":\"eb43c2c5fcd6fdf2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/overrideStore.js\":\"a470789a754bad04\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3361e0f451e6aa70\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/HeaderItem.js\":\"86c5bbada28d6540\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/LeftSidebar.js\":\"ad5b143a19f10f7f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/actions.js\":\"ebe3e6abbd20ee22\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/facet.js\":\"6be5e79d07b2b837\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/index.js\":\"cd54208d5792854e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/shortcuts.js\":\"3c788170f5490791\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/toggleStore.js\":\"c1ae9654e2bf338b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/MergePicker.js\":\"36145369301bb95e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/index.js\":\"1973daccf3cf3801\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/mergeAction.js\":\"0c61b3e28f02e3af\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/strategy.js\":\"a9b72d986dad3a08\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/Button.js\":\"6ca3bcfadd9540ac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"34fc2f329a603536\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/defaultItems.js\":\"eaf107d4d5f5e834\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/facet.js\":\"02d986d5cca3484f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/index.js\":\"89d05a7a95b543bd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"8ff799780f06ec9d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/actions.js\":\"47b1000b3be5cfa5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"933268f9e0b65b7b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/facet.js\":\"198a14ba646d4c6d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/index.js\":\"4b612dc9ecf21eeb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/MoveDestinationPicker.js\":\"b959834a558218bd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c05db428de64d68b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/contextMenuItem.js\":\"5c6135c64b4482ba\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/index.js\":\"30d4a92aaf0343e8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/moveAction.js\":\"6d2543aa80108e8e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/moveBlocks.js\":\"058b191ee1fe3a01\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/selectionAfterMove.js\":\"715695a90bcf134c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/TutorialBanner.js\":\"74b07f6f74105bad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/action.js\":\"3ab1202c0d7b746a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/bannerDismissal.js\":\"ccf31857415fa181\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/documents/cheatSheet.js\":\"b0f0c20ce04b5a61\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/index.js\":\"af8cfa9928038ce8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/keys.js\":\"88e210634d44631d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/landing.js\":\"bc4d5d830d776cbc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/outline.js\":\"1c91bd09c0f24c1c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/seed.js\":\"1b526b3079843cb3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8ca88b72f3e2acf7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/analyze.js\":\"470b43412c004f6c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/diagnosticsSource.js\":\"37dfdcb3697ba1ee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/index.js\":\"eec309b71c94d736\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/load.js\":\"d020e392a8b15712\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/monitorRun.js\":\"0e6959b96a06cbfb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/schedule.js\":\"87f2e5c4ca33af37\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/series.js\":\"f1f1393f7b7d1816\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/store.js\":\"ffbd0995292b1a89\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/trendAction.js\":\"c44a64a323619333\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/verdict.js\":\"9b093b6a1a647fed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/clickToEditAction.js\":\"74fb8e2d5e9c26db\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/index.js\":\"94986337fc2f7934\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/interactions.js\":\"7c96cf92fcd66514\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5f6e731ad7aa6f44\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/MigrationGate.js\":\"78f1dff429b5836e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/MigrationGateDialog.js\":\"3a6d4b3465406a09\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/action.js\":\"e7bf0885250fe740\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/index.js\":\"ac82a8924bfeb7fd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/localRunMessage.js\":\"cee934e4669e832d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/plugin.js\":\"02ca4a33d04347b9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/progressReport.js\":\"5e2f708c0a9e18b0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/sweepProgress.js\":\"5083d07d420f593e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/FieldRowRenderer.js\":\"093cd7bbd90fdc16\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/ValueRowRenderer.js\":\"8deb73af1cac1d5b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/actions.js\":\"2ab7246d4a31eba6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/autocomplete.js\":\"0bb31b5cc67fdfa1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/fieldRow.js\":\"0e7013541b603beb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/index.js\":\"5867866b7c0cf208\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/referenceWarning.js\":\"1945c880110cb744\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/valueAutocomplete.js\":\"57c9087f17329fb7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/valueSchema.js\":\"378e30fe37ead231\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/HeaderItem.js\":\"e351d6979823f28a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/QuickFind.js\":\"8f79199e0e6390da\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/index.js\":\"8f350f6f0ef42706\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/recents.js\":\"4f6f365ad5970dc8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/resultItems.js\":\"56f4b438222ac777\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/selection.js\":\"a21661ea33d4c82c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/toggleStore.js\":\"03126ca58a43b254\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/HeaderItem.js\":\"6f1a528c9c3b687f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/RecentsPageBlockRenderer.js\":\"fd47ead49d96aa2d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/grouping.js\":\"84f81a49d866849a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/index.js\":\"690bed55aadce80c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/target.js\":\"2cd2877ac4dbdc88\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/codeMirrorExtensions.js\":\"e83d0c3f30ed6e50\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/contentPrefill.js\":\"7b689da50079041f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/dataExtension.js\":\"9c3007813918f1a3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/index.js\":\"c5542653b2d6371a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"c9a0b437758f8ddc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/invalidation.js\":\"67f4a448686c49ce\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/localSchema.js\":\"a3a064f28957fb51\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/blockrefs/index.js\":\"d704fe4668cf5ed2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"804cda25c700f31e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/index.js\":\"aa273ed0ce66eb1d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/referenceNode.js\":\"cd3f6f629a4f16d1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/remark-reference-occurrences.js\":\"4b5d757295788511\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"e88f930c1cb4e76d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/index.js\":\"911d497c0fc1b3ec\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7c18e4a48f856878\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"48195fc12d52bd03\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/mergeRetargetProcessor.js\":\"694e396f3bd4139a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/parseFence.js\":\"e2dbdb47da4ef703\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referenceParser.js\":\"49aad534ecda6772\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referenceProjection.js\":\"51a9a287948da9cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referencesProcessor.js\":\"22ff2679b1011083\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/renameProcessor.js\":\"0df85f929d27ad33\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/spanReplacement.js\":\"e38f6501e5594dbe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/htmlToOutline.js\":\"9fa7cd63e87b9c18\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/index.js\":\"0da14b478f208ace\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/normalizeClipboardDom.js\":\"19beb2c7e051d9b6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/pasteDecision.js\":\"452a0d2e7a288a62\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/action.js\":\"ecd8c3741cab335d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/blockIds.js\":\"62337b529e3c7748\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/content.js\":\"ac0aa225ee9186e5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/effect.js\":\"e4b8343c2981c794\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/ids.js\":\"652b3083f014ce4a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/import.js\":\"96cbede669d7947d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/index.js\":\"e82605ef7beceb0f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/plan.js\":\"99d47fc9fac7f111\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/plugin.js\":\"e2735c12208fd8d7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/promotion.js\":\"0a66af054cc04a96\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/properties.js\":\"e40e8243121ecf97\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/references.js\":\"c1956971c8e10274\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/report.js\":\"5c6f3f7ec1002049\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/roamMemo.js\":\"ea3ae5a099142a68\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/runtime.js\":\"0be11d03f974bb92\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/schemaReconciliation.js\":\"50087d5137a5dbf3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/srsMarkers.js\":\"b64e1be6a8c9a924\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/todo.js\":\"04daaca5f8346a25\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/typeCandidates.js\":\"7e0a03d2cb376493\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/types.js\":\"d8ae7d10a051f6d1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/search-health/index.js\":\"1ef2912b11bc7a48\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/search-health/store.js\":\"61b5cf52695e2884\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/HeaderItem.js\":\"b1ea791683920471\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"839d42503f3e2037\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/index.js\":\"5d03d440a2698463\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/model.js\":\"c853686028795c81\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/toggleStore.js\":\"6e1e97cf5a5609eb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/useKeyInspector.js\":\"0942f3a70c8942f7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"b42492d68104f129\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/ShellDecorator.js\":\"aec0cc7514ea4beb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/actions.js\":\"91a15d6bef75be94\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/exclusionsFacet.js\":\"4c6d73dc0deb0127\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/index.js\":\"f42a9c17af2cfb91\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/shell.js\":\"3b9ceed4de7e5b4e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/surface.js\":\"0f184d60371bebbe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/walker.js\":\"166450022ebd95a6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/RescheduleToast.js\":\"3649df7429dc8dc5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/dataExtension.js\":\"15a39eece65c3c73\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/index.js\":\"1e6959e8fd69eabd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/indicator.js\":\"3ebad39453c2dfd9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/moveSrsState.js\":\"23575c43587fa2f1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"561350e1feb64aaa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/scheduler.js\":\"a3fe4ad513895f41\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/schema.js\":\"a2b15800d44da178\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"4b0c7ce8a5b758de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/srsClipboard.js\":\"17eb39022e575f1a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ec2faa62cde73c32\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4b549e953641c37f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/DeckPicker.js\":\"8d4d51099c92a4f0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewControls.js\":\"33257f847d5c6674\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8d8dc542b1989111\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewSession.js\":\"8ce0dfeb7333e101\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/actions.js\":\"3a7f2877b2d6ba28\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/archive.js\":\"877fa881e04908a5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/dataExtension.js\":\"4a0b5d5c29fcbd5e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/deck.js\":\"fa7f10e16d85e2f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/dueQuery.js\":\"0d1cbdbeed670606\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/gradeDecision.js\":\"7b8afeea05351a1c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/index.js\":\"1fcb290d2337c3cb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/keyHints.js\":\"54b83a69e9b47339\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/reviewCardLayout.js\":\"c0e9d8ecb3cf799a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/reviewProgress.js\":\"f5aa69c10c46c26f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/schema.js\":\"67350b857ce33d08\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/useDueCards.js\":\"4ccd5b1e709fe00e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/startup-metrics/index.js\":\"ab47464c57e0219e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/startup-metrics/record.js\":\"118f0a25fff09870\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/index.js\":\"44f52de773c9e689\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/persistenceStatus.js\":\"d636517382446a41\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/requestAction.js\":\"05f02aa4f7bcdbe4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/TypeChipsDecorator.js\":\"082212ff2f6a2376\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/codeMirrorExtensions.js\":\"74a99ee81b5d94c6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/index.js\":\"e8bd62da4507e46b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/typeAutocomplete.js\":\"efc8cea7cd600038\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a711c75233ce4e03\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/actions.js\":\"ea0aaee51d74d480\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/anchor.js\":\"0cd6a2656e74e20b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/events.js\":\"67403db6ef63f4d9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/gestureActions.js\":\"bfd556f9c1ec867f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/index.js\":\"98d1f69197d003b6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"23f89064fe45377d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/collect.js\":\"2396ab2e624ba2f3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/index.js\":\"4e41c0f251fe202f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/record.js\":\"ac8029bff13c9162\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/RejectionDialog.js\":\"5dbe26017a90d761\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/SystemStatusHeaderItem.js\":\"15827e1aba22aff9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/index.js\":\"4bf8929049e9e418\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/model.js\":\"a6b8b780a7142e5b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/queueCounts.js\":\"c485a2434ab827b5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/rejectedHelpers.js\":\"401c1a5be3d4832d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/rematerializeAction.js\":\"a0c0cefc7b683403\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/useHysteresis.js\":\"289d13c9cd089411\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/ColumnHeaders.js\":\"839464da289dc5aa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/QueryUi.js\":\"d7dcd0c3d102d261\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/TableLayout.js\":\"e3e8d59e4537147f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/actions.js\":\"a5a29ac33626c38f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/cellEdits.js\":\"711d6b54990318f9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/childrenViews.js\":\"e03553d45feda8e2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/columns.js\":\"1322434f4cdc0b5c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/controller.js\":\"fe53399ef14db87f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/convert.js\":\"aee55ed227d4bd27\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/dataExtension.js\":\"4782fdbd20f8ff6a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/index.js\":\"a8142abd867d78f4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/keys.js\":\"3bec44258918e02e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/model.js\":\"b268eec178ff7ccf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/backfill.js\":\"c8e57830d743a8b1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/completion.js\":\"e2ce52df0641fec0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/format.js\":\"ad4733ffbea310c9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/parse.js\":\"7074ebf1176aece5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/queryValue.js\":\"3488c2156f3e0cd2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/source.js\":\"d45a09a8a8375f1c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/registry.js\":\"7c84c9621603fadb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/rowGutter.js\":\"89dc26ced21feb4d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/rowVerbs.js\":\"037435daee3e5b12\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/schema.js\":\"2e01539d1e7d385a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/sort.js\":\"1491770fc4d846d7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/effect.js\":\"e35a69023bc8fdee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/index.js\":\"9431c7c05a40e8d0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/theme.js\":\"7f630b208c840425\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/actions.js\":\"afc8084760d41618\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/dataExtension.js\":\"ce2cba3cb91efb12\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/index.js\":\"1630d8dcbcb25f1f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/schema.js\":\"1e14e47962ce0b85\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/TouchSelectionLayer.js\":\"3421d7b6e61189d8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/actions.js\":\"aaba6f5f0bbdc967\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/defaultItems.js\":\"5a4558c72d4960f3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/facet.js\":\"697d29dfe1251d92\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/holdRecognizer.js\":\"97bbe837a949e7b5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/index.js\":\"f07c1fa16e303caa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/UpdateIndicator.js\":\"22520575666fd8fa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/index.js\":\"8d51cf4376225464\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/loadTimes.js\":\"babdb6dec9909c52\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoNotesRenderer.js\":\"3ada27edd42d8e1e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoPlayerRenderer.js\":\"aa568b78246f81e3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoTimeStamp.js\":\"5641f1eb6410967f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/actions.js\":\"0fb7fffadbb1c2dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/index.js\":\"cdeff30774c1f000\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/markdown.js\":\"fc598ffea671d76e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/notes.js\":\"9fbb4fab2c783f48\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/registry.js\":\"3c933b23471c168d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/remark-timestamps.js\":\"ac6d1be9bb9ea559\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/view.js\":\"dcf859ff2a63d23c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/LinkHints.js\":\"b237daf4d5e0a1ae\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/index.js\":\"30b56857b735a14e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/model.js\":\"7d90fa1ce2647e7a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/settings.js\":\"4a766e295195c69d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/actions.js\":\"7c147a726372ee88\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/index.js\":\"de0ca448798bebd2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/interactions.js\":\"8993864545bce5c2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/workspace-header/index.js\":\"587d36759080e6fa\",\"/knowledge-medium/pr-preview/pr-1876/src/registerServiceWorker.js\":\"92099a66b1e079be\",\"/knowledge-medium/pr-preview/pr-1876/src/requestPersistentStorage.js\":\"ea10ec3fec132640\",\"/knowledge-medium/pr-preview/pr-1876/src/services/authRequestDeadline.js\":\"a792561d4512a8d8\",\"/knowledge-medium/pr-preview/pr-1876/src/services/authStorage.js\":\"08c4978c7b9141c6\",\"/knowledge-medium/pr-preview/pr-1876/src/services/powersync.js\":\"b7cf322b1cd9aa13\",\"/knowledge-medium/pr-preview/pr-1876/src/services/supabase.js\":\"be5e201a85772097\",\"/knowledge-medium/pr-preview/pr-1876/src/services/uploadErrorClassifier.js\":\"8eaa93bbc994949f\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/ActiveContexts.js\":\"b16d643261b08b65\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/HotkeyReconciler.js\":\"e799196e46d50a3e\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/WipeLocalDataDialog.js\":\"ce9b50e30fe0c51d\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/actionDispatch.js\":\"3b0b9bc2793674fa\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/actionRefItems.js\":\"8c1d00ce10026215\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/applyKeybindingOverrides.js\":\"6437f0085477f21f\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/blockActions.js\":\"4cf04fe4c4be4039\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/blockMergeGesture.js\":\"784c47163b03a818\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/canonicalizeChord.js\":\"643ef4d2493d4229\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/defaultContexts.js\":\"eb3e71a2889230db\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/defaultShortcuts.js\":\"e4e2172bafa0b391\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/effectiveActions.js\":\"6724321ae51f4cfe\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/gestureAction.js\":\"93acb7303e578e05\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/gestureBinding.js\":\"48d547e159c06f4d\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/holdRegistry.js\":\"3102ca0fdb757442\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/keybindingConflicts.js\":\"1c75541e3017ebc7\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/keybindingOverrides.js\":\"e24c3ce9e48343cb\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/pointerAction.js\":\"586289d1bccbe4e8\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/resolve.js\":\"fb9e2f25cf21a4cc\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/runAction.js\":\"4c3be1aff032cb79\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/sequenceMatcher.js\":\"911d85581a6caaff\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/types.js\":\"4145e208aa6ba98e\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/useActionContext.js\":\"3d5e3bdb90acbfb0\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/useActionDiscovery.js\":\"1f34da3fc832835b\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/utils.js\":\"eb9b81e6c7f1d3a5\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/bootStore.js\":\"992d44949353d3a5\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/previewDatabases.js\":\"60d182f4789e4b78\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/byteTransform.js\":\"eb575397bee7b753\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/attachmentCleaner.js\":\"98d3e3681c3ddb97\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/attachmentParts.js\":\"2dacd264f6edd1d9\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/bundleParts.js\":\"67bfdb2b444d6802\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/bundleRecord.js\":\"d4e01eb909047cec\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/manifest.js\":\"49e0f0ef39dfc32a\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/takeBundle.js\":\"3042db0d92389dff\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/verifyBundle.js\":\"40780fdf7370310f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/cleaningStage.js\":\"a810f87c736e6dca\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionKey.js\":\"5e89cca8a3348f09\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionServer.js\":\"5f9500d0ebf4e6d2\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/flip.js\":\"dd726a001e702c28\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/flipAttempts.js\":\"19bfc620862056ba\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/pages.js\":\"1518be67973cdf49\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/preflight.js\":\"c9aacbe4540c3662\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/reseal.js\":\"f96f43cf12a72b96\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/runConversion.js\":\"4f8157a7e7b4b031\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/runLock.js\":\"147288c303215068\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/sealing.js\":\"b7ade1fd922bca64\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/sealingStage.js\":\"224cdd590211ae93\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/stage.js\":\"f59c08936fbd0139\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/verifyReseal.js\":\"2fe4f76c7a3ef007\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/aad.js\":\"cde0508051ff6176\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/aead.js\":\"082827cd629f94ed\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/base32.js\":\"546cecee394f0f7b\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/base64url.js\":\"b8f3d189beaa09de\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/binaryEnvelope.js\":\"db4c5877e7ac0534\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/byteAead.js\":\"f44a31e444360d75\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/canary.js\":\"c4f037d71db24118\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/contentHash.js\":\"aa2aeca4d292c052\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/contentKey.js\":\"ac4b88e10057dac4\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/derivedIdNamespace.js\":\"98fa5427b6bad530\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/envelope.js\":\"2c29ab0253757d37\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/hex.js\":\"29f12d49c13551e6\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/sha256Hex.js\":\"62b661418ae8a29b\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/workspaceKey.js\":\"98d0f591e67fa4ac\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/conversionState.js\":\"9a7bae453b0d0b05\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9097348fc4e489fc\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/pastedKey.js\":\"76500d438aa8dfc7\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"e9d37625b25101dc\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/upgradeWorkspacePin.js\":\"455f6188ba6fbea5\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/keyStore.js\":\"1f91658aa20a47dc\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/mintWorkspaceKey.js\":\"649c5cd3066ac4e0\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/modePin.js\":\"e211dfef5dc6d3ed\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/openWorkspaceKeys.js\":\"e84d1a382ad48669\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/resolveWorkspaceEntry.js\":\"d71dcfc8e1d8ac85\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/resolver.js\":\"ad8accb7bb946180\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/workspaceAccess.js\":\"713dc34bbe4630e4\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/transform.js\":\"436080a386df460e\",\"/knowledge-medium/pr-preview/pr-1876/src/themeBootDefaults.js\":\"181012fb6e89ebea\",\"/knowledge-medium/pr-preview/pr-1876/src/types.js\":\"16f7dab588937986\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/ClientLocalSettings.js\":\"d193684b84b5b2ed\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/abortableSleep.js\":\"1dadc4bb7709f9a3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/array.js\":\"6fd200023c00fca5\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/backlinkAutocomplete.js\":\"2ae3df7161c717ca\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/blockCrumbs.js\":\"1add78cd9e5a3dbc\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/blockrefAutocomplete.js\":\"197e68d39d4b66c4\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/cadencedIdleJob.js\":\"a908507f6bcbf5ad\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/callbackSet.js\":\"7818cb38b6e24e52\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/clientId.js\":\"56b127e86cb55123\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/codemirror.js\":\"9911b19481162fce\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/codemirrorCompletion.js\":\"04d5abf55b3bff74\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/copy.js\":\"cff1c96eb00e1112\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dailyPage.js\":\"eb542718edd37534\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dbForensics.js\":\"0bd86223d38846a3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dbForensicsHooks.js\":\"04d11a0d8beb774a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/deleteBlockThroughUi.js\":\"50db44ff0cf6555d\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dialogs.js\":\"eb1ee864faafc3bb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dom.js\":\"4d5a34d077ab18fc\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/downloadBlob.js\":\"7b8707d77ffdbf1b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/drawnWalk.js\":\"185ae0fdfff900a3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/exportSqliteDb.js\":\"1bd3e9cfeddcbd57\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fileSystemAccess.js\":\"b652e37d9fc5263a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/flipSlide.js\":\"e7819643a773f38a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fnv1a.js\":\"d4cf25a23ee3d6d9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/formatBytes.js\":\"20f3282efbff5209\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fuzzyRank.js\":\"94800342e57db6e7\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/idbKeyedStore.js\":\"91ccfa15e133f99e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/idleCallbackPolyfill.js\":\"a8764e0741b1318c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/keyboardAwareScroll.js\":\"4c73d1d867349986\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/keyboardViewport.js\":\"4907a000dec4983d\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/lastWorkspace.js\":\"0736f55b995712cb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutColumns.js\":\"b617c61e18487617\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutSessionDom.js\":\"81070c23b6be1e0d\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutSessionId.js\":\"212e9bca9a25deca\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/linkClickGestures.js\":\"3ff007218b1a684c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/linkTargetAutocomplete.js\":\"02d88035db05d153\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/localDbCorruption.js\":\"4c7471ef8ff9651e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/localDbRecovery.js\":\"96d768d95374853e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/markdownParser.js\":\"46b22d57565b75d2\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/memoize.js\":\"0590bd90f6cca7cc\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/nameFieldCommit.js\":\"aef559b6ccb123ac\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/nameList.js\":\"474deb932d65897d\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/navigation.js\":\"6c83ebd97f9b215f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/omnilinerNamespace.js\":\"3a0828a9cfc080fe\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/opfsPageScan.js\":\"648d7f47c188bc7c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelClearance.js\":\"37478994e4e719db\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelHistory.js\":\"0b4b1377c01bd330\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelLanes.js\":\"a1950513b5dd2d53\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelLayoutProjection.js\":\"ae36136b62700459\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelScrollAnchor.js\":\"1f4f8a248e3f1993\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelUrlFlags.js\":\"94c1d4dc80d36306\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/platform.js\":\"5c86538a12a20e5c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/pluralize.js\":\"0d5b21c0798236db\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyCreation.js\":\"90d3e9300aa50ee7\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyNavigation.js\":\"48283c67386e8c6d\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyValueContext.js\":\"24373ffacd406b38\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/react.js\":\"ee40f9ecb7f8c3be\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/relativeDate.js\":\"15664d5218806cf5\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/relativeTime.js\":\"de01388d69a4b7af\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/renderScope.js\":\"e49f64ba9f97b50e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/resolvedThenable.js\":\"7120e29170aae9b6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/routing.js\":\"6ee365542802e60e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/safeMode.js\":\"46ac4ca0c3aa2b39\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/scheduleIdle.js\":\"1ecdfedc7759f07a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/screenWakeLock.js\":\"852cd707beaf12db\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/selection.js\":\"7fb53fbe1baea9be\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/softKeyboardGrab.js\":\"b0918cb580aecc5e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/startupTimeline.js\":\"197f92d4172744ae\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/state.js\":\"8f4b7e33ccf62c2b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/string.js\":\"75df264077faa021\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/surfaceZoom.js\":\"dba47bc20a49a2e8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/time.js\":\"e807939b0e8ef072\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/toast.js\":\"f05a46747d6025b5\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/toggleStore.js\":\"9a3b6d7c0412f066\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/untilStopped.js\":\"0884d90fcc3219a5\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/userActivity.js\":\"8ede0db4f38103f0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/viewTransition.js\":\"fb782455e42a08b7\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/viewport.js\":\"512d91841873ebc6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/webLock.js\":\"7ad9bf8746556982\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/workspaceRecovery.js\":\"17752c18b5185630\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/workspaceSnapshotStore.js\":\"3045b165b25d7aeb\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-compiler-runtime.js\":\"87a4345318f81423\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-client.js\":\"2caa121a215c1a34\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-server-edge.js\":\"ab1b19fe9eb173a2\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-server.js\":\"2f2e382741343230\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-static-edge.js\":\"d2ecfb6665b3ee61\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-static.js\":\"26b7855aa4a6bc0f\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-test-utils.js\":\"af9abdfa61be394b\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom.js\":\"ccfcb27fec6b6399\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-jsx-runtime.js\":\"ade16b380f7e0449\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react.js\":\"5bfc53b3ddfd92c5\",\"/knowledge-medium/pr-preview/pr-1876/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1876/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1876/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
