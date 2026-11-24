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
		buildId: "34b640db7752-26826d79",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/\":\"9ef16055d57240d1\",\"/knowledge-medium/pr-preview/pr-1876/index.html\":\"9ef16055d57240d1\",\"/knowledge-medium/pr-preview/pr-1876/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1876/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1876/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1876/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1876/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/pr-preview/pr-1876/assets/FacadeVFS-QjCi6DWI.js\":\"5e5274e12fa22bc2\",\"/knowledge-medium/pr-preview/pr-1876/assets/OPFSCoopSyncVFS-wxp1Uqdx.js\":\"26e3c44a3087f499\",\"/knowledge-medium/pr-preview/pr-1876/assets/OPFSWriteAheadVFS-CVFEYFmB.js\":\"9c0c063f0b0aca04\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-8TWgCfd6.js\":\"a9534c7c077aec29\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1876/assets/wa-sqlite-async-Dzf0FjH0.js\":\"cc0155b76245b694\",\"/knowledge-medium/pr-preview/pr-1876/assets/worker-CedGonAS.js\":\"f8bbe6a306fb4ba6\",\"/knowledge-medium/pr-preview/pr-1876/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1876/chunks/app-CCbHr6Sr.js\":\"2c20bde502025927\",\"/knowledge-medium/pr-preview/pr-1876/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1876/index.js\":\"fe029bd2af536592\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1876/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1876/assets/AccessHandlePoolVFS-Dia6ZnV6.js\":\"5a4b19079172a975\",\"/knowledge-medium/pr-preview/pr-1876/assets/IDBBatchAtomicVFS-CP0iq6pd.js\":\"11d774c0189783d6\",\"/knowledge-medium/pr-preview/pr-1876/assets/MemoryVFS-X1IFqAfC.js\":\"1e75a85b7e069894\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-BpOZgN39.js\":\"ce63225182905fa2\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-async-N55meU-N.js\":\"328756d3ba260649\",\"/knowledge-medium/pr-preview/pr-1876/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1876/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1876/chunks/AccessHandlePoolVFS--GSjXhjc.js\":\"576d3de887009f5d\",\"/knowledge-medium/pr-preview/pr-1876/chunks/FacadeVFS-BeUUX5Gi.js\":\"c56543329f267ece\",\"/knowledge-medium/pr-preview/pr-1876/chunks/IDBBatchAtomicVFS-BeBQAkfL.js\":\"71bc829800578b3d\",\"/knowledge-medium/pr-preview/pr-1876/chunks/MemoryVFS-Bn8_N4HQ.js\":\"23da4b7cf5818aaf\",\"/knowledge-medium/pr-preview/pr-1876/chunks/OPFSCoopSyncVFS-B9eJUo7W.js\":\"3657752d9fdc4e77\",\"/knowledge-medium/pr-preview/pr-1876/chunks/OPFSWriteAheadVFS-O2jwWatX.js\":\"050947960991c0b2\",\"/knowledge-medium/pr-preview/pr-1876/chunks/Preview-BRwIqu6N.js\":\"a8838201bab2da32\",\"/knowledge-medium/pr-preview/pr-1876/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/card-Dva5jI4W.js\":\"436223c39bd1a465\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-3piG2_Ke.js\":\"afeb2fbfe38ea9ba\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1876/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1876/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1876/chunks/mc-wa-sqlite-B72rlJkn.js\":\"e0d08bce43e37242\",\"/knowledge-medium/pr-preview/pr-1876/chunks/mc-wa-sqlite-async-eLVkrJOT.js\":\"f049793fdf76158f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-BBpy-ysQ.js\":\"65439120af3baca3\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-BKUTRIW8.js\":\"fe2afb3d00ebaac1\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-BfpQEn_Y.js\":\"92f4851e82ad91e8\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-CZVW8fR4.js\":\"15746af113d7ee02\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-D_UkEXQw.js\":\"3e1e558119df2c8f\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-DfVYmQMy.js\":\"d8b8cc135e35074e\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-DhGkzHhz.js\":\"6c090b08aa8fa46c\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-TlOtnaAe.js\":\"e4b4d04d02fdf9d0\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server-legacy.browser.production-CZC6wQq8.js\":\"cedbe1f47f04f13d\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server.browser.production-Dn__dF-0.js\":\"d765f80e8e6f6aab\",\"/knowledge-medium/pr-preview/pr-1876/chunks/react-dom-server.edge.production-CrMdlW3X.js\":\"ee74e75cc8f9e885\",\"/knowledge-medium/pr-preview/pr-1876/chunks/server.browser-D9cyQoM7.js\":\"dee9e918125a542a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/textarea-DxLlHoR-.js\":\"c88c20dcf4c74848\",\"/knowledge-medium/pr-preview/pr-1876/chunks/ui-B90oRyny.js\":\"d178fb0b957570e0\",\"/knowledge-medium/pr-preview/pr-1876/chunks/wa-sqlite-Cb0EYRpo.js\":\"5fb4e94cb4b50c1a\",\"/knowledge-medium/pr-preview/pr-1876/chunks/wa-sqlite-async-BZU99hzR.js\":\"bed609b4f46da444\",\"/knowledge-medium/pr-preview/pr-1876/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1876/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1876/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1876/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1876/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1876/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1876/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1876/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1876/src/App.js\":\"78f79ad1272ffcf7\",\"/knowledge-medium/pr-preview/pr-1876/src/appUpdate.js\":\"86d3e5323a4f388b\",\"/knowledge-medium/pr-preview/pr-1876/src/appVersion.js\":\"d750192907d93a98\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/initialLayout.js\":\"25ea6dc6234dd71f\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/openWorkspaceData.js\":\"cb9edf011ccceec9\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/resolveWorkspace.js\":\"3045971324f70a56\",\"/knowledge-medium/pr-preview/pr-1876/src/bootstrap/workspaceBootstrap.js\":\"cd3f9a0a0f6e4fe0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockComponent.js\":\"f988604649a88ab6\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockCrumbs.js\":\"dcc765dd5fd201de\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockEditor.js\":\"8258018c7b3e2258\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockLoadingPlaceholder.js\":\"b93960b61b8be5db\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockProperties.js\":\"58470f0c68f776dd\",\"/knowledge-medium/pr-preview/pr-1876/src/components/BlockSearchPicker.js\":\"7ee52080aab38e22\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ConfirmBulkDeleteDialog.js\":\"568bef5065cd1f92\",\"/knowledge-medium/pr-preview/pr-1876/src/components/DividerHandle.js\":\"0658a26a3d4a9be7\",\"/knowledge-medium/pr-preview/pr-1876/src/components/DraftEditor.js\":\"ba820d8664876245\",\"/knowledge-medium/pr-preview/pr-1876/src/components/GutterPill.js\":\"4c73cc5645580f7a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/Header.js\":\"4abd7011cf71967c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/LazyBlockComponent.js\":\"fda2ab74aec2a2cc\",\"/knowledge-medium/pr-preview/pr-1876/src/components/Login.js\":\"adcb20697e4df26f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ZoomableSurface.js\":\"e4b6027607528a4a\",\"/knowledge-medium/pr-preview/pr-1876/src/components/editModeKeepalive.js\":\"bf80c982c2753ea8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyDisplay/PropertyDisplayScope.js\":\"f694cea5535c754b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"6632dd8d27d326ee\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/RefPropertyEditor.js\":\"37c78e4658475efe\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/RefTargetTypePicker.js\":\"1512814e2601dab7\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/SelectPropertyEditor.js\":\"5cb1d2f94814edf8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/TypesPropertyEditor.js\":\"2ab4962381266eb0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/defaults.js\":\"4e84af32f3fcc04e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/kernelValuePresets.js\":\"6ce58f3d9d6528c3\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/selectablePresets.js\":\"41d6ae3871b2e14c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyEditors/typesPropertyUi.js\":\"d063af3c51c39c1f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/AddPropertyForm.js\":\"da7369dbbf45fb98\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/PropertyPicker.js\":\"620c292c8b762af2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/PropertyRow.js\":\"36bd3b58fbbecca5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/Rows.js\":\"4113232c6a16474e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/actions.js\":\"6ec2aafeda18bff1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/declarationOnly.js\":\"312a32829eefd5f6\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/layout.js\":\"a2f4338872cfcc12\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/model.js\":\"178f413eba5c7d6f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/shapeUi.js\":\"cf5680b9e0d00065\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/shapes.js\":\"ee36c57c4b970264\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/usePropertyEditingActivation.js\":\"917ebddea86080cf\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanel/visibility.js\":\"f199f03066cb6424\",\"/knowledge-medium/pr-preview/pr-1876/src/components/propertyPanelSections.js\":\"7243fe3352bb163f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockEmbed.js\":\"1087f11d487ad601\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockLink.js\":\"bf48c443149b4f04\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/BlockRef.js\":\"47ca91fdfab9d9b8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/ReferenceLink.js\":\"0dbeda819971e7df\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/cycleGuard.js\":\"c03fa7532a143c11\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/cycleGuardContext.js\":\"25e79d5da60bf61f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/linkInteraction.js\":\"c4f77c2128fb4adb\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/referenceLayout.js\":\"9883b2c6ab497cf0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/references/useBlockRefAncestors.js\":\"c3a09045f097f91f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockGutter.js\":\"88f7814b7ea03795\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockInfoDialog.js\":\"a3f6b97215142c1c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BlockTypeBlockRenderer.js\":\"ef1ea9deab2fae12\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/BulletHoverCard.js\":\"e38b1cff4e505f3b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/CodeMirrorContentRenderer.js\":\"66f017514e0c00bc\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"81e5d47b86ab16d0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/ColumnResizeHandles.js\":\"af24c6bcef7a50fa\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c46338692b488fa3\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/DefaultBlockRenderer.js\":\"9c3d1bf069faec69\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/LayoutRenderer.js\":\"4e5645137b07fa27\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/MarkdownContentRenderer.js\":\"137343e35f69c694\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/MissingDataRenderer.js\":\"f509cb9701698fe3\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/PanelRenderer.js\":\"79fbc465385f81af\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e6c23c234f4d155b\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/TopLevelRenderer.js\":\"1fbef90ff0bf17b7\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/blockGutterMode.js\":\"ea5d65f4699fdaad\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/blockTitleText.js\":\"d3a913c9ccbb584c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/fieldCreationKeydown.js\":\"eb46406833302553\",\"/knowledge-medium/pr-preview/pr-1876/src/components/renderer/layoutRootContext.js\":\"deaba5ce155db330\",\"/knowledge-medium/pr-preview/pr-1876/src/components/typeChip/TypeChip.js\":\"bcbc1c980b71e3ae\",\"/knowledge-medium/pr-preview/pr-1876/src/components/typeChip/chipStyle.js\":\"a100e72bf1f7bf99\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/anchored-floating.js\":\"4cb5a40dde38385d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/button.js\":\"a2875129fa308ecf\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/card.js\":\"a077a9edb81386b6\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/checkbox.js\":\"0e885fc6f2206d8c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/collapsible.js\":\"7cabad1f13617f90\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/command.js\":\"ee1eed6b400dc43f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/context-menu.js\":\"28123a4337644634\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/dialog.js\":\"880962cb7c9c7426\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/dropdown-menu.js\":\"fb3ef74c714bdcbb\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/floating-listbox.js\":\"426b82f4ecf5e042\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/index.js\":\"9ca987eef9f84ef6\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/input.js\":\"b94a44c481b7aace\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/kbd.js\":\"9c4c6c1ae2336d67\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/label.js\":\"68aebf31d0203bd5\",\"/knowledge-medium/pr-preview/pr-1876/src/components/ui/textarea.js\":\"5d5ebc64fc3b9fc2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/useEditModeYieldKeepalive.js\":\"c7228ed64f6aa69c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/BootFallback.js\":\"db683267c91259b7\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/FocusedRowLazyMount.js\":\"d309b51ec4828f86\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/LazyViewportMount.js\":\"7a8145210f7dd98c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/LocalDbCorruptionFallback.js\":\"286687a8dae358f0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/error.js\":\"7ab48d5622c9e125\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/lazyMountRegistry.js\":\"85499c2a9f8d3211\",\"/knowledge-medium/pr-preview/pr-1876/src/components/util/suspense.js\":\"cb7feddeca57eeb2\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/CreateWorkspaceDialog.js\":\"135962b47a2ae71c\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/PendingInvitations.js\":\"b65ab11503e10d08\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/SyncProgress.js\":\"62cc94c26dc3d641\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/UnlockProgress.js\":\"1d6e50b79f34ca21\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceKeyGate.js\":\"c7ece98e93f775e7\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSettingsDialog.js\":\"e3418e67ff0077ea\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSwitcher.js\":\"d24dd471ff6049d0\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/WorkspaceSyncGate.js\":\"da12690cedd789ae\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/ConversionFlow.js\":\"c19c5d01748524e8\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/ConversionFlowHost.js\":\"8388108cdb9ff5a1\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/EncryptionSection.js\":\"381298c3ba2e8f91\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/attachmentPrompts.js\":\"a89c0d146395f98f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9cd7208dd00b3686\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/conversionFlowDeps.js\":\"df07bed8fbf6621e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/conversionFlowStore.js\":\"c772cb85fa75d27e\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/flowUi.js\":\"b9c7aecaaf646c2d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/conversion/useConversionRun.js\":\"500e5651b8aaee3d\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/keyUi.js\":\"33f6013bdf388702\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/useCloseOnKeyLoss.js\":\"c0797ea1c13e298f\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/useCloseOnServerE2ee.js\":\"8f70545b165cec34\",\"/knowledge-medium/pr-preview/pr-1876/src/components/workspace/workspaceUnlocked.js\":\"1780ab462ce41c14\",\"/knowledge-medium/pr-preview/pr-1876/src/context/backgroundSubtree.js\":\"f3ac332527ac2411\",\"/knowledge-medium/pr-preview/pr-1876/src/context/block.js\":\"805e440e9f6fff47\",\"/knowledge-medium/pr-preview/pr-1876/src/context/layoutWsContext.js\":\"60f21a3b4cb31764\",\"/knowledge-medium/pr-preview/pr-1876/src/context/propertyDisplay.js\":\"71c64540ec41b79c\",\"/knowledge-medium/pr-preview/pr-1876/src/context/repo.js\":\"ccb277ab333f7b20\",\"/knowledge-medium/pr-preview/pr-1876/src/data/aliasClaim.js\":\"e40b731c1c42d818\",\"/knowledge-medium/pr-preview/pr-1876/src/data/aliasSeatNamespace.js\":\"8d341665e3cfdc90\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/blockData.js\":\"48ab4e875108011f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/blockType.js\":\"7d9e254b5f96c22c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/changeScope.js\":\"c14161f3929295f6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/codecs.js\":\"852cf2196d580341\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/derivedData.js\":\"6667de510023ca58\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/errors.js\":\"f0d54bd3e3c27bfe\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/events.js\":\"99402bcaf3741260\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/handle.js\":\"3d0178b42fd0ed0c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/index.js\":\"cad71b8a980ae676\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/mutator.js\":\"77ef578d33ee94b4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/processor.js\":\"b5664e6569350025\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/propertySchema.js\":\"9e3ccd5e59456fed\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/query.js\":\"ff659720bbc021e0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/sameTxProcessor.js\":\"3b0eff6415f54fba\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/schema.js\":\"3d0178b42fd0ed0c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/tx.js\":\"3d0178b42fd0ed0c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/typedBlockQuery.js\":\"b294f3f38f33a4b3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/user.js\":\"7beb390d42875654\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/valuePresetCore.js\":\"f817906f5b7bfa70\",\"/knowledge-medium/pr-preview/pr-1876/src/data/api/valuePresets.js\":\"9a4b08ad720c2e9d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/attachmentCleanerIOVerb.js\":\"dfb6f02504d88449\",\"/knowledge-medium/pr-preview/pr-1876/src/data/block.js\":\"ea7372c3b5e9860b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockCache.js\":\"0c0daaf49710a23c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockId.js\":\"31f2b76eb44c15dc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockLiveness.js\":\"286a1c799caf6899\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockMerge.js\":\"d080a38e98c728aa\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockSchema.js\":\"c1a8aba040e348e7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockTypeLookup.js\":\"cba0a4c5697d6832\",\"/knowledge-medium/pr-preview/pr-1876/src/data/blockTypes.js\":\"249056aac21498a1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/childrenView.js\":\"3c1bdbbb17a620e6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/clientContext.js\":\"e7edab4800c594d0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/dbFileSiblings.js\":\"3261a9b924e3fb4e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/definitionSeeds.js\":\"65aef12be0d1f1e5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/derivedIds.js\":\"760595f189f4eeee\",\"/knowledge-medium/pr-preview/pr-1876/src/data/drawnSubtree.js\":\"5a78af29a9e2478d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/facetBridge.js\":\"8b4e5a672c0e11f6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/facets.js\":\"748e6873c0adebc1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/globalState.js\":\"429d4d4d8dda3320\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/aliasClaimRederiveProcessor.js\":\"a5d0364497aa2adf\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/ancestorBatch.js\":\"0d9fc8d1b6856aab\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/blockTypeTypeifyProcessor.js\":\"c11330ec22393d33\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/clientSchema.js\":\"97185197f144066b\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/commitPipeline.js\":\"8cd0f2f3b15609d2\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/devAssertions.js\":\"057228deb4859a09\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/firstSync.js\":\"51e26af59e8c93a6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/freshInitialLoad.js\":\"e50e13a946305fcc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/graphBackfillClaim.js\":\"02d3c760a4ba29ac\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/handleStore.js\":\"ea06c52583dbc5ba\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/idleMarkerJobs.js\":\"7ed9274dd8a972cf\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/initialDownload.js\":\"55bea611a6274fbb\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/initializeClientDatabase.js\":\"8ed0922ef76ddef5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/jsonCanonical.js\":\"f96b349042b83168\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelInvalidation.js\":\"0e716bbb6443b7d5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelProcessors.js\":\"691320b5bcb38b67\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/kernelQueries.js\":\"5f3c9eda1125aec6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/mergeTypeMembershipProcessor.js\":\"64bcd9d125f9a42c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/normalizeReferencesProcessor.js\":\"ab4c66d2171ac7e1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/poolInstrumentation.js\":\"56503fb8388da859\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/processorRunner.js\":\"c0848115c95ac0df\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyCellBackfill.js\":\"93097f75c76f8468\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyChildMint.js\":\"c50c0d093ee9b7ac\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyChildrenProcessor.js\":\"947e7a17dedd35a5\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e752aae9e7955bcd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyDefinitionSynthesis.js\":\"9542eca148dc1271\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyKeyScan.js\":\"43267567dac2f29d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertySchemaResolution.js\":\"8ebebae4545d7689\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/propertyValueEdits.js\":\"0a3098150212f361\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/raiseProtocol.js\":\"a8f15a65d6351dfc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/readBatch.js\":\"45bbceb89f8d16bd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/refProjection.js\":\"faacb37191f449c8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/referenceTargetLookups.js\":\"0012a8115428492d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/referenceTargetProcessor.js\":\"f9ebb746bbf327e7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/replayMerge.js\":\"56e6e0c20394191d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/sqlBinds.js\":\"71a71b0d2610a14d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0c2be58fb8b5c9e0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/arrivalProcessors.js\":\"b7119f7ca91914aa\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/invalidate.js\":\"ce9473b6139fd9bf\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/materialize.js\":\"87fdea31acf8af53\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/observer.js\":\"b16935df6679f6cd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/syncObserver/reconcile.js\":\"5c3e765366026493\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/timingMetrics.js\":\"f72a2d037e68c14c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/treeQueries.js\":\"7ea9f4071418d2f3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/txEngine.js\":\"bcc7a9f969a81776\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/txSnapshots.js\":\"3de98c365e04357a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/typedBlockQuery.js\":\"e12f3a3d2254eb12\",\"/knowledge-medium/pr-preview/pr-1876/src/data/internals/undoManager.js\":\"7bb5fbfa731d398d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/invalidation.js\":\"10b22a32704c3010\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelDataExtension.js\":\"a8c3149617982883\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelPage.js\":\"06e849cf0e538607\",\"/knowledge-medium/pr-preview/pr-1876/src/data/kernelValuePresetCores.js\":\"72de0824ba69fe50\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbCorruptionSignal.js\":\"201218c39db3ac4c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbStorage.js\":\"93edabeceb4ae0f3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localDbVfs.js\":\"b260942597c2e2df\",\"/knowledge-medium/pr-preview/pr-1876/src/data/localSchema.js\":\"474a76ec75904463\",\"/knowledge-medium/pr-preview/pr-1876/src/data/maintenance.js\":\"f579a647896287ad\",\"/knowledge-medium/pr-preview/pr-1876/src/data/mergeProperties.js\":\"0b0ec48b1e402fe9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/metricsConsoleHook.js\":\"15df2a85b802ca10\",\"/knowledge-medium/pr-preview/pr-1876/src/data/migrationsPage.js\":\"c5736f218fdfef32\",\"/knowledge-medium/pr-preview/pr-1876/src/data/mutators.js\":\"ccd525fa31765843\",\"/knowledge-medium/pr-preview/pr-1876/src/data/orderKey.js\":\"ee8c769996b5a11a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/orderKeyPlacement.js\":\"a2430d0ae27695da\",\"/knowledge-medium/pr-preview/pr-1876/src/data/outlineSurface.js\":\"5663fa36c81b016d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pendingEditorContent.js\":\"2d983d91361d315e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pendingUploadsSql.js\":\"e586f86b1bd41209\",\"/knowledge-medium/pr-preview/pr-1876/src/data/pluginStateExtensions.js\":\"88514bb0927f2fb0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/powerSyncLogger.js\":\"e7fd9a720c0561cb\",\"/knowledge-medium/pr-preview/pr-1876/src/data/projectorRuntime.js\":\"f3ac7d27c4086a91\",\"/knowledge-medium/pr-preview/pr-1876/src/data/properties.js\":\"8b92872c27c913f6\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertiesPage.js\":\"faac331311928060\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyChildren.js\":\"c101db73577c1bf7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionFanout.js\":\"bd5784a08704e9a3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionMetadata.js\":\"1acb5cf6df84a019\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDefinitionRegistry.js\":\"ca699797a719327e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyDisplayMode.js\":\"ec086eb89129a1cc\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertyRowCreation.js\":\"ad5b37cac85eceb0\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertySchemaCreation.js\":\"0c3459f8abd8dc86\",\"/knowledge-medium/pr-preview/pr-1876/src/data/propertySeeds.js\":\"ac8df144160fe20a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/recentsPage.js\":\"a7e128889415f471\",\"/knowledge-medium/pr-preview/pr-1876/src/data/referenceBlock.js\":\"f0028c25b2eef479\",\"/knowledge-medium/pr-preview/pr-1876/src/data/rejectedUploads.js\":\"3b9870992d6e556c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/releasePowerSyncConnection.js\":\"fbae1663bd9845ba\",\"/knowledge-medium/pr-preview/pr-1876/src/data/repo.js\":\"cd7eeaa43ebb8caa\",\"/knowledge-medium/pr-preview/pr-1876/src/data/repoProvider.js\":\"437cea0e3ef5bb01\",\"/knowledge-medium/pr-preview/pr-1876/src/data/rowProperty.js\":\"668d4ca580d60eed\",\"/knowledge-medium/pr-preview/pr-1876/src/data/searchFilter.js\":\"85faa8189d52ba49\",\"/knowledge-medium/pr-preview/pr-1876/src/data/seedIdentityLedger.js\":\"1093e8fe8157a3fe\",\"/knowledge-medium/pr-preview/pr-1876/src/data/stateBlocks.js\":\"0899af95d4cf67e1\",\"/knowledge-medium/pr-preview/pr-1876/src/data/structuralEditPolicy.js\":\"38e9a3e772664dd4\",\"/knowledge-medium/pr-preview/pr-1876/src/data/structuralInsert.js\":\"d981f266d840b156\",\"/knowledge-medium/pr-preview/pr-1876/src/data/subtreeDelete.js\":\"623bfabae9109564\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncStreamLock.js\":\"08cea6eac3b01605\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncedTableSqlRecognizer.js\":\"140b29f3d01024b3\",\"/knowledge-medium/pr-preview/pr-1876/src/data/syncedTableWriteGuard.js\":\"726f841e8bc05b83\",\"/knowledge-medium/pr-preview/pr-1876/src/data/targets.js\":\"3d52cae6288d038d\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeColors.js\":\"91c754e6b8d0b04a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeDefinitionMetadata.js\":\"1a4c54a18485a3a8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeDefinitionRegistry.js\":\"1527108a5de95200\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeExtraction.js\":\"d3dfdea6729c9497\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeInitialValues.js\":\"02bb744d0b3e519c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typePropertyGroups.js\":\"22282c43655f374c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeSeeds.js\":\"bf1bfc04656d7e54\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typeTagger.js\":\"2c45f614951cd8ec\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typedRecords.js\":\"b91bceb8708ea40a\",\"/knowledge-medium/pr-preview/pr-1876/src/data/typesPage.js\":\"0060393d84d2788e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userPrefs.js\":\"d908e278d2dc99cd\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userSchemasService.js\":\"dd5968c5398b6e17\",\"/knowledge-medium/pr-preview/pr-1876/src/data/userTypesService.js\":\"daf42da98700d5ce\",\"/knowledge-medium/pr-preview/pr-1876/src/data/valuePresetRegistry.js\":\"d45668fbb9b4efd9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/visibleChildren.js\":\"38179d8995697db8\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceConversion.js\":\"838c7495ee7a5fed\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceFirstSync.js\":\"35eee3f8c938077e\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceIdNamespace.js\":\"b18b7cd5f1f98c5c\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaceSchema.js\":\"6dd1b00da00802a9\",\"/knowledge-medium/pr-preview/pr-1876/src/data/workspaces.js\":\"787293094585c9e7\",\"/knowledge-medium/pr-preview/pr-1876/src/data/writeAheadLog.js\":\"f1a60705cfb2ee9f\",\"/knowledge-medium/pr-preview/pr-1876/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/BlockPasteShellDecorator.js\":\"e82e9bf35f465b23\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/atTrigger.js\":\"adb20a0d239d88bd\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/autocomplete.js\":\"538cb098d374b902\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/codeMirrorExtensions.js\":\"a8ff0ef8ac288cb1\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/contentFlush.js\":\"912473684b8bf3d3\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/defaultInteractions.js\":\"d59ddac5d2ed6a8d\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/editSettleSignal.js\":\"e16427b94dd4242d\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/insertImage.js\":\"b5086195ac8678c5\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/referenceCompletionRange.js\":\"1d2a580baf7292af\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/referenceTargetTypes.js\":\"d644b3ada60f62c8\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/syntaxContext.js\":\"8d54cd9936011c06\",\"/knowledge-medium/pr-preview/pr-1876/src/editor/triggerMatch.js\":\"c0164f09a4c49c1e\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/AppRuntimeProvider.js\":\"86b86dad4e8a80a5\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/BlockFocusShellDecorator.js\":\"7c885e8c00bf0200\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/ExtensionRenderBoundary.js\":\"67fb04c82b168029\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/PanelContentRecovery.js\":\"ed52154efd050cb9\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/apiCatalog.js\":\"8287d56b46dc3e33\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/approveExtensionHere.js\":\"a2d31f28db440533\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/armedCutAppMount.js\":\"b9dc07e3786e23f0\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/batchableKeyedStore.js\":\"e1f21badba711768\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/blockInteraction.js\":\"65ef2a38dcc5b4c8\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/blockSelectionAction.js\":\"15824809f35a64b4\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/compileExtensionModule.js\":\"28f3bc482d4742d9\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/compiledModuleCache.js\":\"4cd2a9572072cf3d\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/continuousGestures.js\":\"b72170c3bfe99a4c\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/core.js\":\"99b1e1b4b56b250e\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/defaultRenderers.js\":\"0677b879717775b2\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/definitionFanoutAppMount.js\":\"84a0ecd321abbf4b\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dialogAppMount.js\":\"ba02bdab46c63c56\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dynamicExtensionSeeds.js\":\"c5c0f0bcb853dac0\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/dynamicExtensions.js\":\"68920dbf3156e0f3\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/exampleExtensions.js\":\"ca32bece8f629b3b\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionApprovalStatus.js\":\"f844a39583ec8aec\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLoadErrorToast.js\":\"6d62d6676fc58268\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLoadErrors.js\":\"aaf5e91ed8bbcd8a\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionLookup.js\":\"1badcfc24fbc202b\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionToggles.js\":\"d95bc758d9e939e2\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/extensionUtilitiesCss.js\":\"ce7f54086a79aeac\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/kernelPageDeletionGuard.js\":\"02404f9fe09d284e\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/liveRuntime.js\":\"ca1fb1d8563cbfde\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/openExtensionsSettings.js\":\"990d3d912b82f7c3\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/overridesCache.js\":\"56c0f3ba78127ce5\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/pluginIds.js\":\"90ff44883bb0c017\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/processorRejectionToast.js\":\"8b2da799bba67b21\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/runtimeActions.js\":\"97eb956f0f57bd78\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/runtimeContext.js\":\"adf69766a0222b32\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/staticAppExtensions.js\":\"1590acd692f27d0f\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/staticDataExtensions.js\":\"9c829de3bbf28c96\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/toastAppMount.js\":\"0b44d437c39a285d\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/useOverrides.js\":\"1eaf1a2f237114a3\",\"/knowledge-medium/pr-preview/pr-1876/src/extensions/useShortcutSurfaceActivations.js\":\"e204c9665d4c3cdd\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/discoverToggleTree.js\":\"36fcbcba80855ee6\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/facet.js\":\"0c19d5d854a4d60d\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/resolveAppRuntime.js\":\"28d15f31a2e7e8bf\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/runtimeEvents.js\":\"00c05db0fd9f27a1\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/togglable.js\":\"190d8ca5e49dce2c\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/variantFacet.js\":\"3aa0f201338e7879\",\"/knowledge-medium/pr-preview/pr-1876/src/facets/verbFacet.js\":\"170abb14ea319d04\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/block.js\":\"38e796a7d7631426\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/focusedChild.js\":\"e337d1de4051273b\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/propertySchemas.js\":\"c73c838864bdd5dd\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/typeRegistry.js\":\"d74d372e9b60e821\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useAncestorCrumbs.js\":\"65e1aa574ed4a792\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useAutocompleteListbox.js\":\"6f41c0211439a1f9\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useDebouncedSearch.js\":\"ffb38914493d8c70\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useDebouncedValue.js\":\"f1f40f20316b3c58\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useIsFocalRender.js\":\"3196f6f3c96d35d4\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useIsReadOnly.js\":\"5541bfa5c581ab5a\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useMaterializeBacklog.js\":\"010a198e82a7a430\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useMinuteClock.js\":\"a17038d71a6e66ab\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/usePanelLayoutProjection.js\":\"5a6749c7383b89aa\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/usePendingInvitations.js\":\"e190aeaae3eccabd\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useRendererRegistry.js\":\"7b74c9dd3a549569\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useRetainedFieldRows.js\":\"41fa02068a3c32dc\",\"/knowledge-medium/pr-preview/pr-1876/src/hooks/useWorkspaces.js\":\"5371e25196bac6d4\",\"/knowledge-medium/pr-preview/pr-1876/src/lib/utils.js\":\"0b3b9577dc32c6f8\",\"/knowledge-medium/pr-preview/pr-1876/src/main.js\":\"61e10cbf66be325d\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/MarkdownImage.js\":\"09d30201e25c4f51\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/blockSeparators.js\":\"0ee10519751b786c\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/context.js\":\"053300f9cfa18908\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/defaultMarkdownExtension.js\":\"e15144ff30295c3c\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/extensions.js\":\"7c5de995735f605b\",\"/knowledge-medium/pr-preview/pr-1876/src/markdown/renderMarkdownHtml.js\":\"fad4cec3327005bd\",\"/knowledge-medium/pr-preview/pr-1876/src/minimal-editor.js\":\"0c3999b7d03b5f35\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/armedCut.js\":\"71a5f599c1f6feb0\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/captureMediaVerb.js\":\"fb61193bcdef9490\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/clipboard.js\":\"39638811a8e9977d\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/decision.js\":\"2bb678365572389f\",\"/knowledge-medium/pr-preview/pr-1876/src/paste/operations.js\":\"33560cca1d6e6daf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/account-header/AccountHeaderItem.js\":\"8e6aeb3942203f18\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/account-header/index.js\":\"28383aad1cd36a31\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"31d8f095e79d7721\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/askAgent.js\":\"bdc49c870afca79e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/askedStore.js\":\"a8a031080901c40d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0abc1fc036f33b4d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/chipState.js\":\"477899f06582a910\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/dataExtension.js\":\"a63b877aae9741c9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/index.js\":\"a197011cb16f5868\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"1fcf37bc1cb42be8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-dispatch-companion/schema.js\":\"a35a9eac00e26efe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e0fa7602f714a6c3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/BridgePairingDialog.js\":\"43ed8548d4c37299\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/addMedia.js\":\"04877de1d7d20dee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6af7c7f30590a556\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/block.js\":\"1a199141d3d6e3a6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/context.js\":\"db916c1451425f39\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/displayIds.js\":\"0010ba3708331e24\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/index.js\":\"da1f35672ac1795f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/outline.js\":\"a7c7464f5b820cf0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/properties.js\":\"353d62e765418b92\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/refs.js\":\"46967d6819422e9c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"abaacf4cdd50a5d9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/search.js\":\"c42244138fcfafa9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/shared.js\":\"94b26a8fa651b1ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"73545bd58ac90d14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentViews/text.js\":\"9bd128d64467a3d9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/agentWrites.js\":\"1424d88254105879\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/authoringCatalog.js\":\"3e02288692a9770e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/blockRefTargets.js\":\"49f15a968e17a1cb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/bridge.js\":\"4b5c593299c666ff\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/bridgeLoop.js\":\"c08f459a79d73ed7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/changeHistory.js\":\"4262fa4686ce6b0b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/commands.js\":\"a1303db05d1b4259\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/commentsCommands.js\":\"52772083f096fac2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/dataExtension.js\":\"d74822317a13d13f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/dataModelGuide.js\":\"755a6af1c7992458\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/describeRuntime.js\":\"9f511c11bb25fd03\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/extensionLint.js\":\"1909bd0992e57e0f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/grainAudit.js\":\"32133669af929e1b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/healthCommand.js\":\"159c7b317b61183e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/index.js\":\"f6e731e182005846\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/presetIdentity.js\":\"3def683a8f0178b9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"836f6f47c24d72b7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/readMedia.js\":\"058a5dc29d0359f8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/schema.js\":\"1c48153f61b662e6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/serialization.js\":\"c5b292e8e4832cd3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/targets.js\":\"fe9de95e9a3eab2d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/tokens.js\":\"8dd1695e8ca31fda\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/watchEvents.js\":\"9f212c9a6d1439d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/workspaceGuard.js\":\"5cf8c56278d3a99b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/agent-runtime/writeCommands.js\":\"d4dd80312b5394a0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/AliasCollisionToast.js\":\"8c1d1434c1c17d05\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/DuplicateNameBanner.js\":\"feb597b451601719\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/collisionMerge.js\":\"2b83ec66e969dec3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/dataExtension.js\":\"02dcb247867ffb0e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/index.js\":\"2c99635931612a0e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/mergeCollisionAction.js\":\"892cf31c5d1fc5c5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/pageStyling.js\":\"7e5aed8b284a4e8c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/rejectionToast.js\":\"87221bbbcb3538cb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/alias/syncProcessor.js\":\"e32cab0cc92a0299\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/actions.js\":\"4840d8b9c344c8d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/addComment.js\":\"49450ca0097bfc69\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/anchor.js\":\"1287649602fd26c3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/anchorState.js\":\"399eb1f856411fa6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/commentLinks.js\":\"4266066379dca877\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/confirmThreadDeletion.js\":\"7d981dc0d7179c96\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/container.js\":\"56552fa8e7e712ea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/dataExtension.js\":\"549cd93503513b7d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/deleteComment.js\":\"6b00f178c2cf7349\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/highlights.js\":\"d43f5ce3607b3999\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/index.js\":\"e4cad9c7f337b1de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/linkedCommentsPill.js\":\"5308abfe3148c11a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/margin.js\":\"b8eb06021082ae2c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/marginAnchorLinks.js\":\"2acc03a608d0367f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/marginSchema.js\":\"b5e37d0788ed18df\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/newComment.js\":\"68370e031054c119\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/ownThreadPicker.js\":\"309b148e9b1593ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/placement.js\":\"fa45d150809cd436\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/queries.js\":\"50bff9e6459e97ee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotePosition.js\":\"ef68111db8954505\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotedIn.js\":\"00c9da362b6567f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/quotedRange.js\":\"61d0308cacb271c7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/rangeRefs.js\":\"939acc79cffe03e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readHighlights.js\":\"90ae000060b2c797\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readSelection.js\":\"de10998a4341da3b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/readSelectionUi.js\":\"5e64ddba49e5581e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/reanchor.js\":\"db56a8e480a65230\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/schema.js\":\"afa1bbb02040b64c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/scope.js\":\"95726c99c7f4af63\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/scopeThreads.js\":\"2ac91ac141df48af\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/splitRetarget.js\":\"6dddca6f5f36b2df\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/suggestionCard.js\":\"76022efbd5e23809\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/suggestions.js\":\"c7f4b88e33c172de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/summaries.js\":\"7d4186050203130b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/summaryBatch.js\":\"b639515d454c912d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/surface.js\":\"9c1f0599cac82aa1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/threadNavigation.js\":\"181575fc92924d6b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/threads.js\":\"c818916ed0517d29\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/ui.js\":\"dbfa3f423169c4db\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/annotations/uiStore.js\":\"e86fb49fa1fdb066\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-intents/appIntents.js\":\"d2ae2b76b5e85b6d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-intents/index.js\":\"cbb144cb270f7189\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-update-prompt/index.js\":\"a76f03c50ca34cfe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/app-update-prompt/status.js\":\"c3ec866118ce2d1a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"be5dbe5f362b412a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaBlockRenderer.js\":\"8e2e65b25809ba99\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9435f6444f44c0d4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/MediaUploadReconciler.js\":\"060d9a236de1791b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetDownLane.js\":\"f4905320f0f1ccb8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetResolver.js\":\"39c53ebfaf9e6be5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/assetUpload.js\":\"c2a350bc31d80837\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/attachmentCleanerIO.js\":\"9efc442cdf86601c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2f403ce09d16b596\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/blobStore.js\":\"6abb1a4f732bd660\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/browserMedia.js\":\"10924ae5f7c3f655\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/byteStore.js\":\"cd72136331253db4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/cleanerIO.js\":\"d10af7cfca871b3b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/cleanupAttachments.js\":\"60fb9723531a0970\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/dataExtension.js\":\"b0809763f1ecc3b5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/downLane.js\":\"6186e92aa945bc83\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/index.js\":\"8f1e25c021c26bca\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/insertImageContribution.js\":\"2d423224b655b196\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/laneArming.js\":\"9e0f12c69525a8a9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/laneLock.js\":\"ce9ee2f317364935\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaBlock.js\":\"ac7df4c4d627762c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaCapture.js\":\"3b10f3d3f0932cc8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaLanes.js\":\"c9781ba16f8aee82\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaViewers.js\":\"7a80c235cad266fa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/mediaViewersFacet.js\":\"6d7d8238832dbb4c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/pasteCapture.js\":\"97ca66c1b0b4c9de\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/resolver.js\":\"2137f4203c4028c9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/retryUploadsAction.js\":\"8030c49a15b6f0bc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/storagePaths.js\":\"e7e32ec010973642\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadDrain.js\":\"6ac529424740ef25\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadLaneStatus.js\":\"f9fbf3114d188a7d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadReconcile.js\":\"0afc48da866f92ec\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadRecovery.js\":\"49a2a8d50c8f46ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/uploadStore.js\":\"d07528e867a41625\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/attachments/useAssetObjectUrl.js\":\"bdab97bfaecdcdf3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a6f366544cc1d1b8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/BacklinksViewSection.js\":\"2dfe0eb22cc87a8e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/facet.js\":\"c52fd3782e59acc9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/index.js\":\"486053e08ae15868\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks-view/prop.js\":\"811323e68aeaef82\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BacklinkFilters.js\":\"752266918f577d66\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"400ca0361f3abee0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/BlockEntry.js\":\"8dd18afe498b8e00\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/LinkedReferences.js\":\"bbf09c90344551fa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"275ac84069857551\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/dailyNoteDefaults.js\":\"f5b1fb55e6615072\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/dataExtension.js\":\"3fba66600954677a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/edgeExclusions.js\":\"a2cefa0e0fbc985a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/filterProperty.js\":\"9c153007c94e5c4a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/index.js\":\"4e63fb4f31d3ce3d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"222db0dce1b285f3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/applies.js\":\"77d42d78260efe92\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/countQuery.js\":\"30d8d3dd4e4628ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7e8be7145a43e57c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/index.js\":\"d7a1986236df2f8d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"fb1379f6d27bd4ae\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/presentationInvalidation.js\":\"6289497eb0a97bb2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/propertyEditorOverride.js\":\"df4ee58f9ef1f729\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/propertyFilter.js\":\"5d39c89d8466a44c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/query.js\":\"1bb990cc22bd1d26\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/resolveFilter.js\":\"d7f8fc2161b20fb2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/sourceBatch.js\":\"e816003360a20769\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/sources.js\":\"6e1f5b828c140f76\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/useBacklinks.js\":\"5d6e8fe8290e9505\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d70f9bd446ee381b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/BirthdayCelebration.js\":\"8fa2abc4e1c81781\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/BirthdayOverlay.js\":\"862fc6ec9b73275e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/gate.js\":\"ca4fc387f1b470fa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/index.js\":\"5a122d8409fe8240\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/birthday/wolfTheme.js\":\"311bb16020652f72\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/BlockDragLayer.js\":\"f6f37f60ab6f74ba\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/dragController.js\":\"a09d91474579679c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/dropTarget.js\":\"33d2d1bc21f035cb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/index.js\":\"34656eac369abaf5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-drag/projection.js\":\"71271aaa6c60145a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-info/BlockMetaCard.js\":\"80e1905b278f4b24\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-info/index.js\":\"f0e3cad52d861455\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/AddTagDialog.js\":\"dfeed80acb060958\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"67124bf85b7609cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/TagNameIssueHint.js\":\"fec5487827194fb7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/addTagAction.js\":\"3d2b2aeff369902a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/appendTag.js\":\"707a39da0daf1b51\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/config.js\":\"10f156959d89be10\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/dataExtension.js\":\"ce06a992f356fe03\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/index.js\":\"3c4f48f0c25960ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/block-tagging/propertyEditorOverride.js\":\"fea491904cbd16dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/BreadcrumbList.js\":\"d2ed2010047093d0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"4e419464d2eabb05\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c88d3dc05a5441df\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"76c4e4e671ab8427\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"82b334a7b2f7df4c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/index.js\":\"4a7e14747b56f0b1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"b8a562c25f928930\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/CharacterCountItem.js\":\"4dc8b4d50e63d5d6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/ProfilePropertyEditor.js\":\"da3ce37839ec55c3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/actions.js\":\"1a9cf6b371cf64d2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/blockType.js\":\"1a379db3654565dc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/charCount.js\":\"d179c8d5b66871af\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/dataExtension.js\":\"16a7a563e93fec3f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/index.js\":\"d6726a247a39ec8b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/profiles.js\":\"39540de01d6c05cb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/properties.js\":\"bb1216bc86a34cd8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/character-counter/textCounts.js\":\"2aaa07fb6f7ff844\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/colemak-keybindings/index.js\":\"4f8d59083e7a964b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/CommandPalette.js\":\"11835e0718e70308\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/HeaderItem.js\":\"3bbbe9787fc992a6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/context.js\":\"243641547ad110fa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/index.js\":\"3a40f89be00bca91\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/selection.js\":\"34859570267edcc7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/toggleStore.js\":\"53582770cf252397\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/command-palette/useCommandPaletteActions.js\":\"839cb80da808064f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/ContributorBadges.js\":\"3c48b47c51365635\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/author.js\":\"510a626036d59781\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/codeMirrorExtensions.js\":\"90288a58a735e84c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/dataExtension.js\":\"45643232331df5d4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/index.js\":\"645d2f9da9e55cda\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/mentionAutocomplete.js\":\"a4e32a49035c3376\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/processor.js\":\"01ead61bc0219dfb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/profiles.js\":\"27be43a4e3962cfb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/queries.js\":\"07745c7c252b0797\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/contributors/schema.js\":\"964d5d23ec979b8a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c159d0e6ac876995\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/followOrigin.js\":\"0bd136b86c0e5a03\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/index.js\":\"9b11b82129552d08\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"bd155891bf464638\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"da0cc1d26c90610f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/CalendarGrid.js\":\"1117b870eb78810b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DailyNotePicker.js\":\"b1b92afd20726e07\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"cb9c6d3b15202330\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateNavDecorator.js\":\"3c51a173a869ccf3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/DateScrubOverlay.js\":\"721c87aa45fde98f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/HeaderItem.js\":\"2d84a6395f1381cf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/ReschedulePicker.js\":\"1ebdc64897eea1a2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/SpreadDatesDialog.js\":\"53a7aae0217baa52\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/actions.js\":\"2321d1ccb802e43b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/blockDateAdapter.js\":\"9e0c1a95cf608811\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/calendar.js\":\"3cb725c1788bcaca\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dailyNotes.js\":\"db11b82b3f4019cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dataExtension.js\":\"f6aad04c7cc1c87f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubActions.js\":\"13d8b8b05e67ff04\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubGesture.js\":\"e483ceb8899a7add\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubGestureActions.js\":\"4d02cc680325b353\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dateScrubRecognizer.js\":\"250e3c6cbffd0afd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/deletionGuard.js\":\"3ef507ffc62bacf1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/dueQuery.js\":\"15addd0bac8081f4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/index.js\":\"ebd306d868d1d485\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/landing.js\":\"6cf75e508847b870\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/localSchema.js\":\"a2e10dd5a4a39a3d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/referenceDateAdapter.js\":\"667a1452a8e9e243\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/rescheduleAction.js\":\"783b2ecad7f62803\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/schema.js\":\"7150668d209e2368\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/spreadBlockDates.js\":\"503446b3b69f3c29\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/spreadDatesAction.js\":\"a3dbc2722637f92f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/today.js\":\"5143cfaef8208ca0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e674119fd772e752\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"36688be7fcd7ef79\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/audit.js\":\"7280342d19407630\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/auditAction.js\":\"aac10a07de47631c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/auditRanges.js\":\"0bd53b1720681cf7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/diagnosticsSource.js\":\"1cb8a62293e6a242\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/divergenceScan.js\":\"a69f8b9bf0dd2fc3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/index.js\":\"6bb857dc7710a65d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/propertyChildrenChecks.js\":\"508274652d2552ec\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/referencesMirror.js\":\"1591ed89bb6b03df\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/rowJson.js\":\"5ecf9a6597196368\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/schedule.js\":\"b74a7174d8a40718\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/data-integrity/store.js\":\"6f0332f6e3c6cefc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/action.js\":\"b69de41fa76e47b0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/index.js\":\"70224abed1b3aba7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-maintenance/plugin.js\":\"72563001eb4e8801\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0565e468b2a64775\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/actions.js\":\"d934036054d9827f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/changeMarker.js\":\"bf30d79aff5f559e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/diagnostics.js\":\"842db78be1ac80a9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/fileSystemAccess.js\":\"36de6873b22851a9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/filenames.js\":\"19df27201b812e75\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/index.js\":\"2df5155f7389e7e6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/mirror.js\":\"520a8ec345b4cf1f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/runLock.js\":\"6a04acb275399c0c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/runtimeHealth.js\":\"72658df714349b78\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/schedule.js\":\"5228e7a95916f739\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/db-mirror/store.js\":\"f26e49ffe82a2649\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/default-themes/index.js\":\"eb6b8f82f7046bd2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/default-themes/themes.js\":\"9ea946cd1cc5e085\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/diagnostics/facet.js\":\"92411ea88a8ba249\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/diagnostics/useDiagnostics.js\":\"99ea05f4549d8e4e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/dismissals.js\":\"52f258fff355b809\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/index.js\":\"cd3ee8d83c2b6d99\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/status.js\":\"fe49a91ec613729d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extension-prompts/store.js\":\"7f16353c65fe3752\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9db3735e9b7d081c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8b6b2b84dd4ce63d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/actions.js\":\"c6ed1f6bc3ec1ccf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/config.js\":\"e37d4729912b60d4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/dataExtension.js\":\"a6afd84f82ab620e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/effect.js\":\"23cf2498a1635d09\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/index.js\":\"aa73f8071278739e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/propertyEditorOverride.js\":\"aa8b8010360ad6f1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extensions-settings/useToggleTree.js\":\"2e5fd5e0b6df372a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/ExtractTypeDialog.js\":\"f4c2be99e3e29575\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"70483a88b18f9c29\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/PropertyShapePicker.js\":\"dfc8b0bd8e72a848\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/action.js\":\"093b65b32a26b6bd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/extract-type/index.js\":\"2cce59198c3b483e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/FindReplaceDialog.js\":\"9e9523ac5f9002ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/HeaderItem.js\":\"48a717c0c3df3d16\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/dataExtension.js\":\"e0c7ad3dfd011116\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/index.js\":\"085c2a732011d78a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/search.js\":\"0e0049f5d3d21654\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/toggleStore.js\":\"b69b9a40cbf3cdad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/LocationPropertyEditor.js\":\"0886d247a86c4178\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/MapView.js\":\"10b1c898a0e0925d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/blockTypes.js\":\"82dd335a405b47ea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/codeMirrorExtensions.js\":\"13ffe067babe7289\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/createOrFindPlace.js\":\"b69f32d9b18035eb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/currentLocation.js\":\"53ae595840282bb9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/dataExtension.js\":\"36a6bc95e22cb0f4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/geoContentDecorator.js\":\"aa42306c80c9f636\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/googlePlacesClient.js\":\"8aa6548cd20d6701\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/index.js\":\"ed4acf3803c8e598\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/locationsPage.js\":\"8fd6c6335e9afe3a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/mapViewport.js\":\"f86b73d9bd1740b3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/pickCurrentLocation.js\":\"2ada4c36684cca9f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/placeAutocomplete.js\":\"8d330e313f727c2b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/placeNameCollision.js\":\"f3d5e390316176ea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/properties.js\":\"9f63a551987bd73e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/propertyEditorOverrides.js\":\"a3893c5e5504bdc8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/query.js\":\"63d240798e1b6be9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/geo/usePlaceSearch.js\":\"f99e028ba3905d0d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"78e4d6ff247e91d8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1bcd892c5cb41dde\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"95104cffa7b2eae5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/config.js\":\"d8df5a019e00bc4c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/dataExtension.js\":\"7cdae400298e3b56\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/facet.js\":\"69abe9429a9063fd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/grouping.js\":\"81e787dac98181bc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/index.js\":\"e41de36176392d3d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"a3f8ea2818cbd8d6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/query.js\":\"2434fb925b3f925b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/resolveConfig.js\":\"d72fd74773b86aac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"1fe476173a5e4593\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e2fd09486040f20d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/HtmlDocumentContent.js\":\"f53f2b1f3786a456\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/HtmlFrame.js\":\"d75362aa41719d3f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/actions.js\":\"399445772721adc9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/blockType.js\":\"b6ee1eea477df691\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/confirmRunScripts.js\":\"3938e0010896be3d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/dataExtension.js\":\"94b70b4b62a80af4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameAnnotations.js\":\"156d36b2dd31efc6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameDocument.js\":\"66979c692954e91f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/frameTheme.js\":\"b6e0e92b1dbaef03\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/index.js\":\"4a4921f2dc499a23\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/scriptConsent.js\":\"6fc93874bb4543a0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/sourceMap.js\":\"6c78bd99961f2655\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/html-document/useDocumentScripts.js\":\"6867597d2aca6488\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/index.js\":\"a8fa7d78cc44fb26\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/record.js\":\"e72c9d396c25279f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/recordStore.js\":\"e47c9fd80deea6a1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/responsiveness.js\":\"dfc9409e3753d316\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/schedule.js\":\"8e27871d05586ff7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/interaction-metrics/sessionContext.js\":\"0497624850cd6255\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9ca97e4107c92d0e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"27cd1e57715cf3ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/actions.js\":\"53cd76ac6ebfc6d7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/config.js\":\"06ff56007bee1046\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/dataExtension.js\":\"113312cfee950e6f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/effect.js\":\"4d89e6fc6917d897\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/index.js\":\"686fae48253055ea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/keyCapture.js\":\"9851290ec404b513\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/overrideStore.js\":\"52204c7dd2ba383e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"cd411bc22af15f25\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/HeaderItem.js\":\"85200d0d64b0fc43\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/LeftSidebar.js\":\"777319136d1600b1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/actions.js\":\"43db33c5835c5b1c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/facet.js\":\"b187c07e961509e2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/index.js\":\"90dbe685b1b7de21\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/shortcuts.js\":\"f5e22226209b9578\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/left-sidebar/toggleStore.js\":\"344d9da46d3f1e8a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/MergePicker.js\":\"fff9d213cc42f5f2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/index.js\":\"0503d0b10cd79aee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/mergeAction.js\":\"f159f2bd040abde9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/merge-blocks/strategy.js\":\"314eccd596da976f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/Button.js\":\"cb367003b84b31f3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5413a8cfb74cb2b5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/defaultItems.js\":\"fb5f33f9f8bac429\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/facet.js\":\"c11425b59c606cf9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-bottom-nav/index.js\":\"b42043f11ac78030\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d8f1230727d86dbd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f7407b161030aa55\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"cfeb08bb79a3aa63\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/facet.js\":\"864c829579ed3fa4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/mobile-keyboard-toolbar/index.js\":\"01604c8e69462fac\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ba54b72ccb528a17\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/blockSubtreeMembership.js\":\"199aa88254dce2c9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/contextMenuItem.js\":\"cc4ab5e269989adb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/index.js\":\"1eaee6a2cb6f4c84\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/moveAction.js\":\"ad7330804b85b523\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/moveBlocks.js\":\"2f66a8dcb2eee88a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/move-blocks/selectionAfterMove.js\":\"2e5b81759d21d84d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/TutorialBanner.js\":\"b372cf284efab1f1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/action.js\":\"04fc30fb27a1eaf7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/bannerDismissal.js\":\"1126eddb0a04e690\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/documents/cheatSheet.js\":\"8000b2a291234557\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/index.js\":\"dd62e9da451d7fef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/keys.js\":\"1486865ba3289260\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/landing.js\":\"9081c24b7dac5805\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/outline.js\":\"f9fff29d6ba0a8b5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/onboarding/seed.js\":\"071e65bdfb4db8ef\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ebf4bdebd21c0b4d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/analyze.js\":\"061abbdf0877ca1b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/diagnosticsSource.js\":\"3a764d7a612856cc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/index.js\":\"dcc4d1819772881e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/load.js\":\"ebd5ab24dc1c457b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/monitorRun.js\":\"d9c69d3c7c2ea3ea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/schedule.js\":\"2911dca0ea63272e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/series.js\":\"642ad45627fac453\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/store.js\":\"953dd7527f4c60d5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/trendAction.js\":\"159c1ba2684f7f02\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/perf-monitor/verdict.js\":\"e05bb70e8667773b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/clickToEditAction.js\":\"297243b7b7fc1fe4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/index.js\":\"2bc83dec3c55cfe1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/plain-outliner/interactions.js\":\"343e641e51f70106\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"fe37a0052ebc3177\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/MigrationGate.js\":\"f07bca9f871b1dfb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/MigrationGateDialog.js\":\"c11fb82902428570\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/action.js\":\"f9ec127aff524ff5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/index.js\":\"eb61abcf11fc0b8c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/localRunMessage.js\":\"d546e1301218cf4c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/plugin.js\":\"3bfd2adce3f08e6f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/progressReport.js\":\"7a91c999d10598af\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/properties-migration/sweepProgress.js\":\"619b41c780ceccea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/FieldRowRenderer.js\":\"c78a790f1da7e11f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/ValueRowRenderer.js\":\"ef28971678fef10b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/actions.js\":\"242f3cc610f3132f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/autocomplete.js\":\"3a6fffb3ed7b9e82\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/fieldRow.js\":\"d40fae94a98a59d0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/index.js\":\"0c7f453f3ae9c3d7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/referenceWarning.js\":\"d3757be15891fc59\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/valueAutocomplete.js\":\"a4ba73445054dda4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/property-rows/valueSchema.js\":\"85c87dbea99f5188\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/HeaderItem.js\":\"264d76e836bbb5a6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/QuickFind.js\":\"ef45f914f0388b6c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/index.js\":\"0a34813d95dfb864\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/recents.js\":\"6b941698cea2ea36\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/resultItems.js\":\"9733432244ecbc0a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/selection.js\":\"0897584880d7b76d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/quick-find/toggleStore.js\":\"1bfa061e7e37f7f5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/HeaderItem.js\":\"7d83f7a1633bd668\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/RecentsPageBlockRenderer.js\":\"7f321a6c80ff93bc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/grouping.js\":\"20f3d39cdc5e6222\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/index.js\":\"4276d7ac7ee1b2a4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/recents/target.js\":\"c86d6d75a00b5716\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/codeMirrorExtensions.js\":\"0d8356c5cc1f2bda\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/contentPrefill.js\":\"ef9cbc5f52fd6301\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/dataExtension.js\":\"406955553525f76b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/index.js\":\"a90ba3cfae3db483\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e6bfba8e1dacc925\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/invalidation.js\":\"14dfe6a9c060d542\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/localSchema.js\":\"3119fc1cbb61d2df\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/blockrefs/index.js\":\"26e77daa0a2606c1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"60bf639b97fc53c6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/index.js\":\"218b26c2a31a7224\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/referenceNode.js\":\"236336fc1cd9c4cd\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/remark-reference-occurrences.js\":\"06850e545e8bb801\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"37b6da1c2df0ebbb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/index.js\":\"284270eee29c1f19\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"4a39ec84458ea134\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d04133e0a26f1253\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/mergeRetargetProcessor.js\":\"34731ea08658ee51\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/parseFence.js\":\"97f204ac42f0cd9f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referenceParser.js\":\"a2e74939bdb6548a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referenceProjection.js\":\"d49cb046c8f310c7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/referencesProcessor.js\":\"0e06f66a305efcdf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/renameProcessor.js\":\"e479f5f20f7e1bf6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/references/spanReplacement.js\":\"f0a6c83d045af13b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/htmlToOutline.js\":\"bbfc4ce8c4d2a58c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/index.js\":\"b81c3223673e385a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/normalizeClipboardDom.js\":\"88c51147664ad22f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/rich-paste/pasteDecision.js\":\"e859c1379ccdff03\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/action.js\":\"d4a2acb6c661d568\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/blockIds.js\":\"85ce922f626b890f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/content.js\":\"7a0407ab9bc6d452\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/effect.js\":\"846bff4aee502271\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/ids.js\":\"05f23d7b91109d89\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/import.js\":\"978e3f824ee0d0a3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/index.js\":\"7f8e71d576635456\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/plan.js\":\"cb8b23d79512066c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/plugin.js\":\"b6f5a91072ed44a0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/promotion.js\":\"84b45dbc053ac710\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/properties.js\":\"08c7409de79ea6cf\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/references.js\":\"606e394091380a77\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/report.js\":\"039faa2c202b05d3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/roamMemo.js\":\"6648b46b676be766\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/runtime.js\":\"d62656635490b3e1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/schemaReconciliation.js\":\"b595531645b71344\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/srsMarkers.js\":\"b63ba55400adefb5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/todo.js\":\"e01d8978528b013d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/typeCandidates.js\":\"2fbef38e0d87b899\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/roam-import/types.js\":\"44b84c573587eb75\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/search-health/index.js\":\"de179f2e5d7bb64c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/search-health/store.js\":\"870d97f721ca9482\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/HeaderItem.js\":\"29fb12c537716caa\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e18f8e7dc7508100\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/index.js\":\"2a41cdaba18e5c6e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/model.js\":\"969c83d70336c92a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/toggleStore.js\":\"e006af8e668b689f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/shortcut-help/useKeyInspector.js\":\"f73b83dae88e7059\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"517cae559fd3b422\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/ShellDecorator.js\":\"1faab9832ac12cb1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/actions.js\":\"1bb6680ff24dd5e3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/exclusionsFacet.js\":\"021f373138a3c37a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/index.js\":\"a0b8ad1cc52f485f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/shell.js\":\"12e555045a2b0455\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/surface.js\":\"e9e62fa2de898389\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/spatial-navigation/walker.js\":\"896ba407e4ca6a92\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/RescheduleToast.js\":\"2329f98548159679\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/dataExtension.js\":\"b36a140f92be82c1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/index.js\":\"1dafee00b3df94ee\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/indicator.js\":\"3b706bf3f72bc253\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/moveSrsState.js\":\"fa100bf512830515\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"638183d98c9a4f0a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/scheduler.js\":\"eda5aa08d861395f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/schema.js\":\"0b979e9c934fc4b8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3b5b46f3bf3ba6a8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/srsClipboard.js\":\"c315736c87fe1667\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"49842c8e2a9ea4ed\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/DailyNoteReviewHint.js\":\"203e9a3a1ac3bcbc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/DeckPicker.js\":\"17c9b579693960d7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewControls.js\":\"d99d5ef9e7665564\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewDeckRenderer.js\":\"230e98e1cf2ecc40\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/ReviewSession.js\":\"8ff2af99ed5587b4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/actions.js\":\"6c4e3d2a52e2e213\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/archive.js\":\"12e79af20aa467f6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/dataExtension.js\":\"4e2ef86634da4062\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/deck.js\":\"3c59352cbaa43851\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/dueQuery.js\":\"46e5b71a8c7f6901\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/gradeDecision.js\":\"59fa7bf46d2265b9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/index.js\":\"25093e2552c69ca7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/keyHints.js\":\"bb1fe75854cee387\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/reviewCardLayout.js\":\"febe9e3f598ec4e3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/reviewProgress.js\":\"0eee323350b74484\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/schema.js\":\"890d01eceaea182a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/srs-review/useDueCards.js\":\"06e89b467a664c9f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/startup-metrics/index.js\":\"18b1fc96023ba1d4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/startup-metrics/record.js\":\"7cb1eee7255e2cab\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/index.js\":\"51d398c9b6c74de2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/persistenceStatus.js\":\"68d6607d5d99d03f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/storage-persistence/requestAction.js\":\"58f754179a496137\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/TypeChipsDecorator.js\":\"fc142ff7102ed008\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/codeMirrorExtensions.js\":\"6a0903918bd8e14f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/index.js\":\"d828b913a45067af\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/supertags/typeAutocomplete.js\":\"6cba5b9c0aea61d0\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a0ac93838bf51e9b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/actions.js\":\"950008c54ee740e5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/anchor.js\":\"005af0660ee36f29\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/events.js\":\"ae68dbb1836c8738\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/gestureActions.js\":\"c9b7afc52b327e78\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/index.js\":\"2b7e8a528833fdf7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"b9642edf873c6e7d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/collect.js\":\"635f5961e03d1904\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/index.js\":\"d901997d3b37ee67\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/sync-metrics/record.js\":\"4fbcb777f40a9208\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/RejectionDialog.js\":\"6c91e41b59a1ca21\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a730f6780aa2049c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/index.js\":\"d771f600ffe6121c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/model.js\":\"46991ee508e8c384\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/queueCounts.js\":\"fa22add24c4a2854\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/rejectedHelpers.js\":\"c1e4b24fb7fd5856\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/rematerializeAction.js\":\"d0bf91733ac677ad\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/system-status/useHysteresis.js\":\"aed1cf01adf63c1e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/ColumnHeaders.js\":\"e7647cb8b26ca6fe\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/QueryUi.js\":\"1c0dbe26ce26501a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/TableLayout.js\":\"48e776c9ba543011\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/actions.js\":\"3f0194788e38d30f\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/cellEdits.js\":\"e248f8655959d0e5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/childrenViews.js\":\"c86a9c89a4e139fb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/columns.js\":\"c5b8c9110d941660\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/controller.js\":\"d533796bb246546c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/convert.js\":\"2680de4329bfcb18\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/dataExtension.js\":\"ce883ca3ee04256c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/index.js\":\"71102eb91d4c99c7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/keys.js\":\"84e97243dde37e3e\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/model.js\":\"c1226d1f9a8d5ca2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/backfill.js\":\"d1f1289bc2288bb4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/completion.js\":\"ffa980f3fb09aff9\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/format.js\":\"f988a323dfeef8d4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/parse.js\":\"8659db3f1413bd1a\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/queryValue.js\":\"8dee7c876698e061\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/query/source.js\":\"efcf105ae7dba254\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/registry.js\":\"e77d3c60016f9c14\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/rowGutter.js\":\"bf9d822a20e9f57d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/rowVerbs.js\":\"c96177dc81806058\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/schema.js\":\"c88ca1601b605115\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/tables/sort.js\":\"270af891b1f2b2c3\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/effect.js\":\"20b991a37b817d7b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/index.js\":\"8b44e3cecec4d3e8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/theme-toggle/theme.js\":\"992d0f5caf39e799\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/actions.js\":\"c4c11ec7cd3d8deb\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/dataExtension.js\":\"503e1a66eedb943d\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/index.js\":\"eaa53596e76dc07c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/todo/schema.js\":\"54b2105fb496a518\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c53bb95de7695622\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/actions.js\":\"9eca574d4e4d2ce4\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/defaultItems.js\":\"5502ffa59135f4b7\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/facet.js\":\"f1f773dc9fb79f84\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/holdRecognizer.js\":\"97225b4a26481ff1\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/touch-selection/index.js\":\"b6a4ec6326f1cafc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/UpdateIndicator.js\":\"a20d509fd9ebe0d8\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/index.js\":\"882eea6778e94e0b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/update-indicator/loadTimes.js\":\"90254a3fc406b09c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoNotesRenderer.js\":\"2cb90a5dfe318351\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoPlayerRenderer.js\":\"ecdc08b234fe3a3b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/VideoTimeStamp.js\":\"ae9c0ff7f9849828\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/actions.js\":\"5ae8f78305264d17\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/index.js\":\"92f6d582a2916233\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/markdown.js\":\"56ad2dae3322e722\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/notes.js\":\"483c78ed3d97892b\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/registry.js\":\"70db8d6f53ac3dea\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/remark-timestamps.js\":\"4696df8c16c2a418\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/video-player/view.js\":\"6fad58fe5beea2a6\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/LinkHints.js\":\"a6bd6ae742936882\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/index.js\":\"f2731b97c0193ce5\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/model.js\":\"2f35350a60713996\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-link-hints/settings.js\":\"c96ca8a640bb1cd2\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/actions.js\":\"4606a12cbef980fc\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/index.js\":\"dc99c8dc0ce4408c\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/vim-normal-mode/interactions.js\":\"6af0759df57d6d80\",\"/knowledge-medium/pr-preview/pr-1876/src/plugins/workspace-header/index.js\":\"5de10fdb6fa52a5d\",\"/knowledge-medium/pr-preview/pr-1876/src/registerServiceWorker.js\":\"3e2a75dd1d8afc8b\",\"/knowledge-medium/pr-preview/pr-1876/src/requestPersistentStorage.js\":\"73d3d40e1300c32f\",\"/knowledge-medium/pr-preview/pr-1876/src/services/authRequestDeadline.js\":\"4ede3b26c9a6781a\",\"/knowledge-medium/pr-preview/pr-1876/src/services/authStorage.js\":\"dd497fdacb54103b\",\"/knowledge-medium/pr-preview/pr-1876/src/services/powersync.js\":\"2ba7eb82ca7ac396\",\"/knowledge-medium/pr-preview/pr-1876/src/services/supabase.js\":\"2f20b183abd86021\",\"/knowledge-medium/pr-preview/pr-1876/src/services/uploadErrorClassifier.js\":\"41205694a06a6805\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/ActiveContexts.js\":\"d54f85d5a2c9d06c\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/HotkeyReconciler.js\":\"afff6fa57882bd9b\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/WipeLocalDataDialog.js\":\"58891e8a84008b4f\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/actionDispatch.js\":\"a7488dead23cb416\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/actionRefItems.js\":\"60017d4da4d0db89\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/applyKeybindingOverrides.js\":\"d645a123140a951e\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/blockActions.js\":\"8d8957d55deee237\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/blockMergeGesture.js\":\"2595986d9280d48b\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/canonicalizeChord.js\":\"f06994814de7a1eb\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/defaultContexts.js\":\"49d212d8246f40ce\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/defaultShortcuts.js\":\"df0457cbcb33aaff\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/effectiveActions.js\":\"40e9647552230c93\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/gestureAction.js\":\"2875f5924c2aee48\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/gestureBinding.js\":\"a08c7020cf4491b9\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/holdRegistry.js\":\"7120b6b4ca3f826c\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/keybindingConflicts.js\":\"e3373872ab4d8519\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/keybindingOverrides.js\":\"e573fdade27c8e5d\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/pointerAction.js\":\"088d8429a30336bb\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/resolve.js\":\"81d36e852ec0b464\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/runAction.js\":\"8cc2c3697cebaa92\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/sequenceMatcher.js\":\"46e6425edbf01a2d\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/types.js\":\"fad852348994e437\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/useActionContext.js\":\"ea58df3734567b10\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/useActionDiscovery.js\":\"32610cf8f1cadf7f\",\"/knowledge-medium/pr-preview/pr-1876/src/shortcuts/utils.js\":\"250c03b2644f5b90\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/bootStore.js\":\"d04b39a36d9237c1\",\"/knowledge-medium/pr-preview/pr-1876/src/sw/previewDatabases.js\":\"d84811c1d59bb1c5\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/byteTransform.js\":\"d7926f4846340d3d\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/attachmentCleaner.js\":\"c686977704ca1512\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/attachmentParts.js\":\"e96e9ca423276411\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/bundleParts.js\":\"31dc8dbde73748ae\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/bundleRecord.js\":\"4529bea9f41d68d2\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/manifest.js\":\"f62c7889e8608a1f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/takeBundle.js\":\"744a5ec3172b30d5\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/bundle/verifyBundle.js\":\"b5175442e4fa4216\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/cleaningStage.js\":\"3ac37fc8f4d65a74\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionKey.js\":\"7577068fbf822f42\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/conversionServer.js\":\"d97aeec8428c36a1\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/flip.js\":\"89a62dccaff9346c\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/flipAttempts.js\":\"382a6720998c939e\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/pages.js\":\"5a618280ec5fc44c\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/preflight.js\":\"d5ef46dc757f4504\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/reseal.js\":\"a063d3ce472e86f4\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/runConversion.js\":\"4288c421768e36e5\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/runLock.js\":\"9cc0fa18ebc9e9d3\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/sealing.js\":\"e18fb0c47e412f3e\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/sealingStage.js\":\"f44166900a373924\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/stage.js\":\"fb537b2b895aefa7\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/conversion/verifyReseal.js\":\"9443794d4eb46eed\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/aad.js\":\"3b899b4427a4bd4d\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/aead.js\":\"e38e6432cb980035\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/base32.js\":\"52ba25f85b785eeb\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/base64url.js\":\"f988349a8f57df04\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/binaryEnvelope.js\":\"6465ff5f4d0306fe\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/byteAead.js\":\"38489adec6a3fd5a\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/canary.js\":\"a214804e8e2da8db\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/contentHash.js\":\"3b8ffc0cd5b5ba01\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/contentKey.js\":\"9d545149cd1aacc8\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/derivedIdNamespace.js\":\"6523e0ec94cdc897\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/envelope.js\":\"f271cb91d80ad771\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/hex.js\":\"1f70cd73f9ba8b02\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/sha256Hex.js\":\"c85863b460eb6477\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/crypto/workspaceKey.js\":\"e7319751693d1d2f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/conversionState.js\":\"c694e577e7956ad4\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/createEncryptedWorkspace.js\":\"bb8e6b6f0cf5786a\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/pastedKey.js\":\"19a8c9cf1d7e7225\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"577336716e147c41\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b84317d15ecefd67\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/keyStore.js\":\"287b587e33611436\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/mintWorkspaceKey.js\":\"a9ebdc752a8ed992\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/modePin.js\":\"800689bffc4e4244\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/openWorkspaceKeys.js\":\"c72643ee1cd737d2\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/resolveWorkspaceEntry.js\":\"15f9eb575043749c\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/resolver.js\":\"1d54a578f1e2c4cf\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/keys/workspaceAccess.js\":\"a4463072a0cc0b9f\",\"/knowledge-medium/pr-preview/pr-1876/src/sync/transform.js\":\"b2ba91b571d0371f\",\"/knowledge-medium/pr-preview/pr-1876/src/themeBootDefaults.js\":\"ed25f3e2bfed574a\",\"/knowledge-medium/pr-preview/pr-1876/src/types.js\":\"df638ab10efa0ffd\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/ClientLocalSettings.js\":\"a0c4d9f2579794d3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/abortableSleep.js\":\"6338baae8ff3d2cc\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/array.js\":\"5c84b4f03badd1e0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/backlinkAutocomplete.js\":\"9140e631d5d7c61e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/blockCrumbs.js\":\"670cea3fabcbcf20\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/blockrefAutocomplete.js\":\"6446144a4067dbb6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/cadencedIdleJob.js\":\"452a8058200b88fb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/callbackSet.js\":\"dc859d862b9d63ed\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/clientId.js\":\"b062d9e3aefbf132\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/codemirror.js\":\"d462e703a135261a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/codemirrorCompletion.js\":\"a4c753cf19206e1f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/copy.js\":\"9a60797b98628ec1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dailyPage.js\":\"375a2a97addafb53\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dbForensics.js\":\"c25c5b2efefb1466\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dbForensicsHooks.js\":\"03d5cf9f58c18316\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/deleteBlockThroughUi.js\":\"53bb9730e8d0596b\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dialogs.js\":\"fb92d25c3b0c36d1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/dom.js\":\"48969f2f51b3553a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/downloadBlob.js\":\"ec56e1c3950871eb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/drawnWalk.js\":\"1247bddb37bf9c2a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/exportSqliteDb.js\":\"a8e206651590225c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fileSystemAccess.js\":\"3ad1b60a9c4c5356\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/flipSlide.js\":\"43cafd18b73054c6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fnv1a.js\":\"92f563c6bc2853a9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/formatBytes.js\":\"8a39e17b81daf9ee\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/fuzzyRank.js\":\"daebe71860003335\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/idbKeyedStore.js\":\"b9410c61b4f8ec64\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/idleCallbackPolyfill.js\":\"bd1f489a71e4a725\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/keyboardAwareScroll.js\":\"83ccb38c64d0f623\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/keyboardViewport.js\":\"de612738b4e247fa\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/lastWorkspace.js\":\"035948fde4228f8e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutColumns.js\":\"7111f7cd515928e1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutSessionDom.js\":\"80bc961c2ef414b9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/layoutSessionId.js\":\"5b571a24eb3c0c36\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/linkClickGestures.js\":\"0ef182b18a3fe0f7\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/linkTargetAutocomplete.js\":\"cd421cdcaa3a67d4\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/localDbCorruption.js\":\"629f2ae01eb9eaf9\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/localDbRecovery.js\":\"8a62c913ae6b44c8\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/markdownParser.js\":\"40cb36e9685ce319\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/memoize.js\":\"019ed347c0249a7f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/nameFieldCommit.js\":\"6ec411cd4212c0c4\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/nameList.js\":\"c78fe7b1f6363c64\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/navigation.js\":\"58dbcc3851cadd26\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/omnilinerNamespace.js\":\"1c31de0d370558f3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/opfsPageScan.js\":\"80cca7f102a19870\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelClearance.js\":\"d32202fd6b890cc6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelHistory.js\":\"62c342807248e08a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelLanes.js\":\"630a6d2b1373fd5e\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelLayoutProjection.js\":\"58d2c61e29ad1243\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelScrollAnchor.js\":\"62d55cf77e5086c3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/panelUrlFlags.js\":\"cd743b51f619a149\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/platform.js\":\"80f13f50044b1567\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/pluralize.js\":\"dc575e0dfe076514\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyCreation.js\":\"b977e1d92db9df45\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyNavigation.js\":\"7c83d30f24d794eb\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/propertyValueContext.js\":\"4eff44bdf561bf85\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/react.js\":\"dbbc1dd9bd0b3faa\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/relativeDate.js\":\"b4905f8eccb39d38\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/relativeTime.js\":\"ba49b2fd0aa5f947\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/renderScope.js\":\"e6aa96122675226f\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/resolvedThenable.js\":\"bf89d196a0787ccf\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/routing.js\":\"2b7f69f0152bf17c\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/safeMode.js\":\"c7d4107bff1076a4\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/scheduleIdle.js\":\"a4cf419ec70fef56\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/screenWakeLock.js\":\"5389d03a8e28ebf5\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/selection.js\":\"15adb7aaaf1bddbc\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/softKeyboardGrab.js\":\"109f29999a1ab740\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/startupTimeline.js\":\"b07abf14cf2aa047\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/state.js\":\"f5df2361e6a51f30\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/string.js\":\"97006771733cc210\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/surfaceZoom.js\":\"bfe5b1dd9c146a12\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/time.js\":\"503871904b9f7bab\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/toast.js\":\"755352ddd32921d1\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/toggleStore.js\":\"237952063987f779\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/untilStopped.js\":\"b1e632da210ba069\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/userActivity.js\":\"03461ec73386d70a\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/viewTransition.js\":\"bbb7e7019f7d2fc0\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/viewport.js\":\"2042512dc7685dd3\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/webLock.js\":\"ed013e953c636c01\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/workspaceRecovery.js\":\"56156d215c555ecc\",\"/knowledge-medium/pr-preview/pr-1876/src/utils/workspaceSnapshotStore.js\":\"83ca4e28f186c385\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-compiler-runtime.js\":\"af4f7a4f968eb5be\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-client.js\":\"1fa03824907764fc\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-server-edge.js\":\"aa2cc295ce8b1e03\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-server.js\":\"2b0c05d23ede4007\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-static-edge.js\":\"acee123f849a7d86\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-static.js\":\"16489dbd47a99f6f\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom-test-utils.js\":\"c3dccd827c56962f\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-dom.js\":\"36caf6f7308d2a05\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react-jsx-runtime.js\":\"84064c51b5eb56a6\",\"/knowledge-medium/pr-preview/pr-1876/src/vendor/react.js\":\"249748b2ed6fce21\",\"/knowledge-medium/pr-preview/pr-1876/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1876/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1876/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
