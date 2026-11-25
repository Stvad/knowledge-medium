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
		buildId: "0b0a8a9c9f23-a49bfb3f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1878/\":\"7d20bdba0d7118a6\",\"/knowledge-medium/pr-preview/pr-1878/index.html\":\"7d20bdba0d7118a6\",\"/knowledge-medium/pr-preview/pr-1878/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1878/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1878/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1878/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1878/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1878/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1878/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/pr-preview/pr-1878/assets/FacadeVFS-BP4z860E.js\":\"3d5a2b9ea34a5ffb\",\"/knowledge-medium/pr-preview/pr-1878/assets/OPFSCoopSyncVFS-WR1UwWmc.js\":\"a8d2192c47465580\",\"/knowledge-medium/pr-preview/pr-1878/assets/OPFSWriteAheadVFS-DnC6rRgP.js\":\"d8442a0b7c7481c7\",\"/knowledge-medium/pr-preview/pr-1878/assets/wa-sqlite-CG9m7OEu.js\":\"fcd3045283516788\",\"/knowledge-medium/pr-preview/pr-1878/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1878/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1878/assets/wa-sqlite-async-Ccw-DntE.js\":\"b8d11ad527437d80\",\"/knowledge-medium/pr-preview/pr-1878/assets/worker-rdJalBy5.js\":\"d53c47020235efa6\",\"/knowledge-medium/pr-preview/pr-1878/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1878/chunks/app-DGGB3esD.js\":\"e14136c13319b3ba\",\"/knowledge-medium/pr-preview/pr-1878/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1878/index.js\":\"964ea0788f3fea93\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1878/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1878/assets/AccessHandlePoolVFS-CVYaN6it.js\":\"eddf95dcf2510471\",\"/knowledge-medium/pr-preview/pr-1878/assets/IDBBatchAtomicVFS-DyEYa82L.js\":\"d6ffa598acaaa764\",\"/knowledge-medium/pr-preview/pr-1878/assets/MemoryVFS-B3AcuQo1.js\":\"f2373b9ed9e873f8\",\"/knowledge-medium/pr-preview/pr-1878/assets/mc-wa-sqlite-5dS8NHvX.js\":\"367dde92f0b41af0\",\"/knowledge-medium/pr-preview/pr-1878/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1878/assets/mc-wa-sqlite-async-CQuFl8HU.js\":\"ff014ffe9c0b12a7\",\"/knowledge-medium/pr-preview/pr-1878/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1878/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1878/chunks/AccessHandlePoolVFS-BzmE1dbm.js\":\"8416031a03036ae9\",\"/knowledge-medium/pr-preview/pr-1878/chunks/FacadeVFS-1hTjuqds.js\":\"724b742c524e53b6\",\"/knowledge-medium/pr-preview/pr-1878/chunks/IDBBatchAtomicVFS-C8h9UnTt.js\":\"6ea7efe4f994c520\",\"/knowledge-medium/pr-preview/pr-1878/chunks/MemoryVFS-BjVm-l1Z.js\":\"bca56b002a7ebd43\",\"/knowledge-medium/pr-preview/pr-1878/chunks/OPFSCoopSyncVFS-BaIQyX5S.js\":\"fc83a213f1fdb557\",\"/knowledge-medium/pr-preview/pr-1878/chunks/OPFSWriteAheadVFS-Byjr7lQv.js\":\"cb27c0bace18f028\",\"/knowledge-medium/pr-preview/pr-1878/chunks/Preview-B1jYKO3s.js\":\"fa34a4c06688a9dd\",\"/knowledge-medium/pr-preview/pr-1878/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1878/chunks/card-djkGliL5.js\":\"695cd4f8479e218d\",\"/knowledge-medium/pr-preview/pr-1878/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1878/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1878/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1878/chunks/dist-DyOVCFrp.js\":\"fc91df1b625b66f2\",\"/knowledge-medium/pr-preview/pr-1878/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1878/chunks/mc-wa-sqlite-04vX3MPv.js\":\"bdedcce2d6176734\",\"/knowledge-medium/pr-preview/pr-1878/chunks/mc-wa-sqlite-async-DknR3gpr.js\":\"3235de55f99abbcf\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-7jJkUz_m.js\":\"6246c38de915731e\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-B9s0dBlA.js\":\"f7894ea4fdf96940\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-BH1wFr03.js\":\"98d3dae352fd40c2\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-BZs17nLU.js\":\"c10677de692490db\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-Bk4_hPXr.js\":\"87307102ef21bf6b\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-CrJOPRSs.js\":\"b8cdd2fbf7f1ee04\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-D4N6Sksw.js\":\"d4a038e4abe4c763\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-DX0Yg0dW.js\":\"edee5fcd36c0f592\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-dom-server-legacy.browser.production-DTi4GTNI.js\":\"35d57108f4df3e45\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-dom-server.browser.production-Cg4_r6J4.js\":\"a4663e918b65cdbc\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-dom-server.edge.production-BT3p-akC.js\":\"2b27c606222bd23a\",\"/knowledge-medium/pr-preview/pr-1878/chunks/server.browser-BGzMoDqW.js\":\"eb2c8c6722b035a4\",\"/knowledge-medium/pr-preview/pr-1878/chunks/textarea-DVlkeP8B.js\":\"ce2b9f4ba2778cab\",\"/knowledge-medium/pr-preview/pr-1878/chunks/ui-bAkvWUtF.js\":\"47b28eed94b3b73b\",\"/knowledge-medium/pr-preview/pr-1878/chunks/wa-sqlite-KSFBpJFU.js\":\"787190150c411d8f\",\"/knowledge-medium/pr-preview/pr-1878/chunks/wa-sqlite-async-zHq4BaBg.js\":\"a90508ff9949d480\",\"/knowledge-medium/pr-preview/pr-1878/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1878/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1878/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1878/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1878/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1878/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1878/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1878/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1878/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1878/src/App.js\":\"f1b444b463d869bd\",\"/knowledge-medium/pr-preview/pr-1878/src/appUpdate.js\":\"952396d11af1d0fd\",\"/knowledge-medium/pr-preview/pr-1878/src/appVersion.js\":\"4ee634f2eacbf6bc\",\"/knowledge-medium/pr-preview/pr-1878/src/bootstrap/initialLayout.js\":\"34f2ec13de4bcd65\",\"/knowledge-medium/pr-preview/pr-1878/src/bootstrap/openWorkspaceData.js\":\"0d476ca19c63eb7d\",\"/knowledge-medium/pr-preview/pr-1878/src/bootstrap/resolveWorkspace.js\":\"934759f91bb0a319\",\"/knowledge-medium/pr-preview/pr-1878/src/bootstrap/workspaceBootstrap.js\":\"0873957ecd681b91\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockComponent.js\":\"70a58d463b9805ef\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockCrumbs.js\":\"6641bdb6a7d2191e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockEditor.js\":\"8b88276f7a5c93d3\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockLoadingPlaceholder.js\":\"6c830b9574eaeaf3\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockProperties.js\":\"f02e9bb3c3d69cfc\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockSearchPicker.js\":\"e7eec6cb9f828b6f\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ConfirmBulkDeleteDialog.js\":\"876b462d09ca1225\",\"/knowledge-medium/pr-preview/pr-1878/src/components/DividerHandle.js\":\"65c2330e93b58279\",\"/knowledge-medium/pr-preview/pr-1878/src/components/DraftEditor.js\":\"7e0ae63e7b01e606\",\"/knowledge-medium/pr-preview/pr-1878/src/components/GutterPill.js\":\"54c056ef0c0c173a\",\"/knowledge-medium/pr-preview/pr-1878/src/components/Header.js\":\"fb7db77402558a49\",\"/knowledge-medium/pr-preview/pr-1878/src/components/LazyBlockComponent.js\":\"12042658ff6da5fc\",\"/knowledge-medium/pr-preview/pr-1878/src/components/Login.js\":\"9726ad97bdfd8046\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ZoomableSurface.js\":\"9bcf28e1cd515d45\",\"/knowledge-medium/pr-preview/pr-1878/src/components/editModeKeepalive.js\":\"f2b222f7e76fa6e7\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyDisplay/PropertyDisplayScope.js\":\"fb270888192f328c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"18013ffe98762fa0\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/RefPropertyEditor.js\":\"fba85ba625eeed7e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/RefTargetTypePicker.js\":\"dde339e34224497f\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/SelectPropertyEditor.js\":\"b51c6a6df728c2fb\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/TypesPropertyEditor.js\":\"5db2090eff52ef7a\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/defaults.js\":\"84102fbe85a8ecf6\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/kernelValuePresets.js\":\"6c1ac4e25a294d4d\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/selectablePresets.js\":\"bc8d9d3968259047\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/typesPropertyUi.js\":\"d7e45394388b78c5\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/AddPropertyForm.js\":\"464a1bf8eac150fd\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/PropertyPicker.js\":\"f4ab2ff63971ed60\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/PropertyRow.js\":\"c715fdb7e087f99e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/Rows.js\":\"6d8df2e73a0e8704\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/actions.js\":\"6a77024a6ca53a3d\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/declarationOnly.js\":\"f55fe3ac7132e4c6\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/layout.js\":\"64d9dbeaa89ebe2a\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/model.js\":\"cb33fc9e9a093846\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/shapeUi.js\":\"b2c9a18031343097\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/shapes.js\":\"ecc31a4e2045ff5b\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b83dc8a3187be9e5\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/visibility.js\":\"f832e3d7b9a1980d\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanelSections.js\":\"ac62e82fb2a8c264\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/BlockEmbed.js\":\"4996d2058e370d23\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/BlockLink.js\":\"6985b488570f137c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/BlockRef.js\":\"a0d72930fef0e73c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/ReferenceLink.js\":\"55a95f8ef783ee7c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/cycleGuard.js\":\"302033e8e3b4b1ff\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/cycleGuardContext.js\":\"08601c5e1daf37b8\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/linkInteraction.js\":\"9bec4f40fa7e2963\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/referenceLayout.js\":\"2be6a13ed9571fd8\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/useBlockRefAncestors.js\":\"ce6b9702a7839ba8\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/BlockGutter.js\":\"8a3032f375550955\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/BlockInfoDialog.js\":\"50622dbc1e314f96\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/BlockTypeBlockRenderer.js\":\"928608ab4aaad56f\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/BulletHoverCard.js\":\"397108f60aa219ee\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/CodeMirrorContentRenderer.js\":\"024708d01b98c667\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"af846c9cd6433edf\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/ColumnResizeHandles.js\":\"0a56ec7dfe24ee3e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0ad2531023a13753\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/DefaultBlockRenderer.js\":\"53606b05075e1d15\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/LayoutRenderer.js\":\"9f66a95963096677\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/MarkdownContentRenderer.js\":\"b3fb15a24994e352\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/MissingDataRenderer.js\":\"54781dc957b48f51\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/PanelRenderer.js\":\"79c3c1837968cd66\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/PropertySchemaBlockRenderer.js\":\"fc42fabb5851f53f\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/TopLevelRenderer.js\":\"a82b4cc7e8adcde2\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/blockGutterMode.js\":\"e4c51032d80d60c2\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/blockTitleText.js\":\"16d7183f4da63bc6\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/fieldCreationKeydown.js\":\"813f2d6e5db53773\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/layoutRootContext.js\":\"f8e03b299f56fc87\",\"/knowledge-medium/pr-preview/pr-1878/src/components/typeChip/TypeChip.js\":\"8b95e379ad7ac490\",\"/knowledge-medium/pr-preview/pr-1878/src/components/typeChip/chipStyle.js\":\"dedf60686131dc8f\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/anchored-floating.js\":\"001b543cf6185395\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/button.js\":\"83b44136aa54b9a4\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/card.js\":\"a291c2887825cf62\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/checkbox.js\":\"493be98356811b29\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/collapsible.js\":\"4fac3bbea5eaa5fd\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/command.js\":\"65eab7abf5a8cd78\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/context-menu.js\":\"a0697dc5bba7c0b7\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/dialog.js\":\"1680d6af5390a02c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/dropdown-menu.js\":\"b1f83beedaaed1ac\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/floating-listbox.js\":\"eddba5df0805b270\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/index.js\":\"ff7927a084bdb77b\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/input.js\":\"143dcaa6c57e6109\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/kbd.js\":\"e8cd61a14fdaca66\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/label.js\":\"4733c99e4eb3781a\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/textarea.js\":\"1eafdf4787218db7\",\"/knowledge-medium/pr-preview/pr-1878/src/components/useEditModeYieldKeepalive.js\":\"79e330756f328897\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/BootFallback.js\":\"e9c389c548763f57\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/FocusedRowLazyMount.js\":\"46cc1d44fdf59c25\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/LazyViewportMount.js\":\"cc8c313a0855fa0d\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/LocalDbCorruptionFallback.js\":\"805acdafad33b830\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/error.js\":\"12df457168102a4f\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/lazyMountRegistry.js\":\"d99457b3aadbdd51\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/suspense.js\":\"db8fce91adced7cf\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/CreateWorkspaceDialog.js\":\"79b6eb68ceb81283\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/PendingInvitations.js\":\"5622aba4bae33ff8\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/SyncProgress.js\":\"c9a01f019086763b\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/UnlockProgress.js\":\"0372a788bd65678d\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/WorkspaceKeyGate.js\":\"8da1818431a81410\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/WorkspaceSettingsDialog.js\":\"41b892f35b7e7ab7\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/WorkspaceSwitcher.js\":\"6e3b95c8f01cd594\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/WorkspaceSyncGate.js\":\"d3b014ea737c9a65\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/ConversionFlow.js\":\"4a36b19993aefb7c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/ConversionFlowHost.js\":\"9b9c57f79662d3ae\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/EncryptionSection.js\":\"c6039dde621d5ff1\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/attachmentPrompts.js\":\"d4a969671dc25250\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9f82e012309d0a5b\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/conversionFlowDeps.js\":\"ea86f519bfe052b0\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/conversionFlowStore.js\":\"fb1ad59272fcee64\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/flowUi.js\":\"357eddd4cacf14e2\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/useConversionRun.js\":\"ab304c17da331e41\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/keyUi.js\":\"b68ea3cd454956fd\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/useCloseOnKeyLoss.js\":\"2d7df9d47c6565cd\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/useCloseOnServerE2ee.js\":\"1b3aaad7dd370a70\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/workspaceUnlocked.js\":\"c246c2b688154164\",\"/knowledge-medium/pr-preview/pr-1878/src/context/backgroundSubtree.js\":\"99db75dd628eb933\",\"/knowledge-medium/pr-preview/pr-1878/src/context/block.js\":\"c243e69b1b1491f0\",\"/knowledge-medium/pr-preview/pr-1878/src/context/layoutWsContext.js\":\"4c7571430cfc021d\",\"/knowledge-medium/pr-preview/pr-1878/src/context/propertyDisplay.js\":\"beb068a6b2332285\",\"/knowledge-medium/pr-preview/pr-1878/src/context/repo.js\":\"6fea919abb9cd25e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/aliasClaim.js\":\"0dc2492dc213d0b9\",\"/knowledge-medium/pr-preview/pr-1878/src/data/aliasSeatNamespace.js\":\"56c1c128c127af55\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/blockData.js\":\"fce022d1f7a4ecc7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/blockType.js\":\"82d6143432c1136b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/changeScope.js\":\"c43d91d6d858e617\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/codecs.js\":\"73cf5b63ee43de70\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/derivedData.js\":\"2a28d3841e12e512\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/errors.js\":\"623ca14564a908f2\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/events.js\":\"e268448dad6d6669\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/handle.js\":\"0e12019e9540ee08\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/index.js\":\"de76cea89487bf10\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/mutator.js\":\"375157636d706f68\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/processor.js\":\"fbe041d66edcc2b5\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/propertySchema.js\":\"c142f00849dd1e92\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/query.js\":\"3fd584aeb9980cbf\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/sameTxProcessor.js\":\"7ee305dcac4e59ab\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/schema.js\":\"0e12019e9540ee08\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/tx.js\":\"0e12019e9540ee08\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/typedBlockQuery.js\":\"b1b8ddc4b86285d3\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/user.js\":\"8c0fac4aa2a04ee5\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/valuePresetCore.js\":\"ad1e740a4d4587e9\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/valuePresets.js\":\"f8eab8675113a544\",\"/knowledge-medium/pr-preview/pr-1878/src/data/attachmentCleanerIOVerb.js\":\"fdd499611b52ffe7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/block.js\":\"d71217bfa4911f67\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockCache.js\":\"9335292da08f9a0b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockId.js\":\"c575327a04fffcb1\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockLiveness.js\":\"9279227ef6514a56\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockMerge.js\":\"46c4a0f464165309\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockSchema.js\":\"e09e6deb7cc05d78\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockTypeLookup.js\":\"1aa7ba661a4a8003\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockTypes.js\":\"704a7fc536562c8e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/childrenView.js\":\"8284ace28a60cec6\",\"/knowledge-medium/pr-preview/pr-1878/src/data/clientContext.js\":\"3295b803c3d751e3\",\"/knowledge-medium/pr-preview/pr-1878/src/data/dbFileSiblings.js\":\"c0c60e8f105eb58b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/definitionSeeds.js\":\"54362533c3eccc47\",\"/knowledge-medium/pr-preview/pr-1878/src/data/derivedIds.js\":\"63d2fc079c9cb895\",\"/knowledge-medium/pr-preview/pr-1878/src/data/drawnSubtree.js\":\"a4ac35a842f5fcb8\",\"/knowledge-medium/pr-preview/pr-1878/src/data/facetBridge.js\":\"7683eecd0392e37d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/facets.js\":\"d06651d1a5819b1a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/globalState.js\":\"b7ece9610f72caea\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/aliasClaimRederiveProcessor.js\":\"128176f572c08767\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/ancestorBatch.js\":\"036157f93b9f22e4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/blockTypeTypeifyProcessor.js\":\"70b58b488f1f9aed\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/clientSchema.js\":\"64d955c84fbdc966\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/commitPipeline.js\":\"593c77a7a4e62c20\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/devAssertions.js\":\"1b3ddcdb07cb4738\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/firstSync.js\":\"a2fd98dac9a2dfa5\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/freshInitialLoad.js\":\"00edbe330b01e2d7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/graphBackfillClaim.js\":\"50a2cd12d5de6029\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/handleStore.js\":\"8b6c730187b6482f\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/idleMarkerJobs.js\":\"e0c7ca39b0a2bd0d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/initialDownload.js\":\"b597c4ea5fc2719a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/initializeClientDatabase.js\":\"e44cb556cd8d7940\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/jsonCanonical.js\":\"de3717d7c5bc5c6c\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/kernelInvalidation.js\":\"d0484d0af5bc9d45\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/kernelProcessors.js\":\"105dd965aa17b39d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/kernelQueries.js\":\"07fa59f57e9d8cf3\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/mergeTypeMembershipProcessor.js\":\"7f7864de3542870e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/normalizeReferencesProcessor.js\":\"5c508d2a0f6523e7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/poolInstrumentation.js\":\"ba24c2dbd35f271a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/processorRunner.js\":\"068f5090bcce04f1\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyCellBackfill.js\":\"a7176096276fe866\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyChildMint.js\":\"8c7288a73827b70b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyChildrenProcessor.js\":\"62931f8fed90b84d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9eff0b6cb232e211\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyDefinitionSynthesis.js\":\"ca7388942a9bbb50\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyKeyScan.js\":\"a02650ba432e3470\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertySchemaResolution.js\":\"8372e4c9d5e9b240\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyValueEdits.js\":\"bb97c55921b18bce\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/raiseProtocol.js\":\"9ae0e9946b3b9c15\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/readBatch.js\":\"40a6ffac7e6b8b20\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/refProjection.js\":\"346891f3e5b0f37d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/referenceTargetLookups.js\":\"c148bbd7ab2e4221\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/referenceTargetProcessor.js\":\"74ae0050d16d084d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/replayMerge.js\":\"3f0f0890ab205fc6\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/sqlBinds.js\":\"fe3d983b173c1d41\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"8453176af2939144\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/arrivalProcessors.js\":\"34e7ec827b5e9ce4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/invalidate.js\":\"a03b93eea7db71bc\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/materialize.js\":\"64b4957b1f14b380\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/observer.js\":\"21b71d05bf6c2104\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/reconcile.js\":\"ceaf1d392385a4c2\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/timingMetrics.js\":\"7e08fadd0f06ae3d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/treeQueries.js\":\"0c5f2bc5d6f9e096\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/txEngine.js\":\"41ce641d621bfd98\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/txSnapshots.js\":\"9f501dfc3a3f2543\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/typedBlockQuery.js\":\"14699b4eef4ef393\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/undoManager.js\":\"a601621988ea7f7e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/invalidation.js\":\"be2d6e5e1d62f501\",\"/knowledge-medium/pr-preview/pr-1878/src/data/kernelDataExtension.js\":\"85d13150b3a397d7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/kernelPage.js\":\"5c3659f2991c107a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/kernelValuePresetCores.js\":\"7b528914dc88e8ad\",\"/knowledge-medium/pr-preview/pr-1878/src/data/localDbCorruptionSignal.js\":\"66db7bdd92306640\",\"/knowledge-medium/pr-preview/pr-1878/src/data/localDbStorage.js\":\"63566cec0b444782\",\"/knowledge-medium/pr-preview/pr-1878/src/data/localDbVfs.js\":\"95028d5103d7c52b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/localSchema.js\":\"283c175371485c41\",\"/knowledge-medium/pr-preview/pr-1878/src/data/maintenance.js\":\"bf7fdd5efa90bf27\",\"/knowledge-medium/pr-preview/pr-1878/src/data/mergeProperties.js\":\"64b5e465afb3ce65\",\"/knowledge-medium/pr-preview/pr-1878/src/data/metricsConsoleHook.js\":\"3228920a50cdc7e8\",\"/knowledge-medium/pr-preview/pr-1878/src/data/migrationsPage.js\":\"486af9568ab39f8d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/mutators.js\":\"7ae6da0821bfc313\",\"/knowledge-medium/pr-preview/pr-1878/src/data/orderKey.js\":\"1bafe1b8e1c887d6\",\"/knowledge-medium/pr-preview/pr-1878/src/data/orderKeyPlacement.js\":\"56cc6fb65c3ffe4d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/outlineSurface.js\":\"8eae873c26163d42\",\"/knowledge-medium/pr-preview/pr-1878/src/data/pendingEditorContent.js\":\"f1c79c21098956cc\",\"/knowledge-medium/pr-preview/pr-1878/src/data/pendingUploadsSql.js\":\"c4c0cf8ec76affdc\",\"/knowledge-medium/pr-preview/pr-1878/src/data/pluginStateExtensions.js\":\"b582ce8ffd4e4942\",\"/knowledge-medium/pr-preview/pr-1878/src/data/powerSyncLogger.js\":\"2f107f5129d58131\",\"/knowledge-medium/pr-preview/pr-1878/src/data/projectorRuntime.js\":\"75dda3be1b914956\",\"/knowledge-medium/pr-preview/pr-1878/src/data/properties.js\":\"cd6f14c4fa960f12\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertiesPage.js\":\"3b75d30e5cf81111\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyChildren.js\":\"f55d67787dab0ac5\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyDefinitionFanout.js\":\"c5b4a88e8ae6f2e8\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyDefinitionMetadata.js\":\"92df133eca8f987f\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyDefinitionRegistry.js\":\"fd5462b7ab106efd\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyDisplayMode.js\":\"0ef1ea8610838de2\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyRowCreation.js\":\"99e47b1f9de3cc49\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertySchemaCreation.js\":\"e479b896de4af096\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertySeeds.js\":\"7a0f02cbf04faad2\",\"/knowledge-medium/pr-preview/pr-1878/src/data/recentsPage.js\":\"cd8e4df3a6739819\",\"/knowledge-medium/pr-preview/pr-1878/src/data/refTargetComparableProperty.js\":\"6d0e1ee928c98900\",\"/knowledge-medium/pr-preview/pr-1878/src/data/referenceBlock.js\":\"5ccb8baa4e9ffa9c\",\"/knowledge-medium/pr-preview/pr-1878/src/data/rejectedUploads.js\":\"37e0e80522d012f0\",\"/knowledge-medium/pr-preview/pr-1878/src/data/releasePowerSyncConnection.js\":\"7be5db4a93d0587d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/repo.js\":\"3cc466c6880e88d3\",\"/knowledge-medium/pr-preview/pr-1878/src/data/repoProvider.js\":\"89fd72f2941ec874\",\"/knowledge-medium/pr-preview/pr-1878/src/data/rowProperty.js\":\"bf36c06495a106db\",\"/knowledge-medium/pr-preview/pr-1878/src/data/searchFilter.js\":\"5c0593d2d610e805\",\"/knowledge-medium/pr-preview/pr-1878/src/data/seedIdentityLedger.js\":\"a890053ad7aa8da3\",\"/knowledge-medium/pr-preview/pr-1878/src/data/stateBlocks.js\":\"8556c489b7fcd09c\",\"/knowledge-medium/pr-preview/pr-1878/src/data/structuralEditPolicy.js\":\"2f0250b15815b8bb\",\"/knowledge-medium/pr-preview/pr-1878/src/data/structuralInsert.js\":\"726be1486869e37e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/subtreeDelete.js\":\"7de933b029d8a095\",\"/knowledge-medium/pr-preview/pr-1878/src/data/syncStreamLock.js\":\"23823d6247af0d71\",\"/knowledge-medium/pr-preview/pr-1878/src/data/syncedTableSqlRecognizer.js\":\"69e55f3074c707e3\",\"/knowledge-medium/pr-preview/pr-1878/src/data/syncedTableWriteGuard.js\":\"c52927776d4e3456\",\"/knowledge-medium/pr-preview/pr-1878/src/data/targets.js\":\"5acf66c6abc861f0\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeColors.js\":\"3b28d062db83d483\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeDefinitionMetadata.js\":\"d8723a1014c319e7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeDefinitionRegistry.js\":\"9058bb60f893ed1f\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeExtraction.js\":\"751994b88ff1b958\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeInitialValues.js\":\"e81feb443ec256ad\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typePropertyGroups.js\":\"1b3934244174b7f8\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeSeeds.js\":\"c5a8ee23e28d802f\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeTagger.js\":\"ec52bf7b3edf625f\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typedRecords.js\":\"ce8a5baf68e90dc1\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typesPage.js\":\"a539eaa17d3a79f5\",\"/knowledge-medium/pr-preview/pr-1878/src/data/userPrefs.js\":\"6600a676b014d5a0\",\"/knowledge-medium/pr-preview/pr-1878/src/data/userSchemasService.js\":\"889c18f23b808152\",\"/knowledge-medium/pr-preview/pr-1878/src/data/userTypesService.js\":\"44e09e23aeb434f1\",\"/knowledge-medium/pr-preview/pr-1878/src/data/valuePresetRegistry.js\":\"c18f51c4da0f6085\",\"/knowledge-medium/pr-preview/pr-1878/src/data/visibleChildren.js\":\"f31e91f069b937a7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaceConversion.js\":\"2a5b99f363fafc10\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaceFirstSync.js\":\"f642251f52ca7ac2\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaceIdNamespace.js\":\"3378e0537f3b8942\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaceSchema.js\":\"0217634e17a15803\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaces.js\":\"bf396fd147ef0c67\",\"/knowledge-medium/pr-preview/pr-1878/src/data/writeAheadLog.js\":\"9b2c5dc9df1b801b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/BlockPasteShellDecorator.js\":\"86a480732096a2fc\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/atTrigger.js\":\"621a3dbad438aab5\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/autocomplete.js\":\"6cf39caef8a2c2e7\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/codeMirrorExtensions.js\":\"63248057218f12c1\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/contentFlush.js\":\"90033665dfbd2372\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/defaultInteractions.js\":\"08c33b6ad51560c1\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/editSettleSignal.js\":\"4f0841ebc230ee63\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/insertImage.js\":\"98ab2f5cdc83750b\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/referenceCompletionRange.js\":\"7638f5b858c321c4\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/referenceTargetTypes.js\":\"7c8d0af389f3bb74\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/syntaxContext.js\":\"0f99f13370d137d1\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/triggerMatch.js\":\"f150e44dceb2e28f\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/AppRuntimeProvider.js\":\"8bc262d9c3be170f\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/BlockFocusShellDecorator.js\":\"dc5be7cc8737313e\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/ExtensionRenderBoundary.js\":\"305fca379e2f08e5\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/PanelContentRecovery.js\":\"1e3ca06a963f93db\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/apiCatalog.js\":\"f8fed7b46b0d0393\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/approveExtensionHere.js\":\"0d0655e2ecb8871d\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/armedCutAppMount.js\":\"07b0af64cfebdf53\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/batchableKeyedStore.js\":\"c0c7f3da24c6fc5d\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/blockInteraction.js\":\"9b702ec79eb83396\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/blockSelectionAction.js\":\"886e37ada2d997c1\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/compileExtensionModule.js\":\"95fdc604162ee390\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/compiledModuleCache.js\":\"d947ed3213f73de3\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/continuousGestures.js\":\"bcc427b2b8d02b66\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/core.js\":\"a2291bb916617e0d\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/defaultRenderers.js\":\"6ebfbd09e0a609f4\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/definitionFanoutAppMount.js\":\"42fc55fb8e9a08ac\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/dialogAppMount.js\":\"11324a97c1fd5b01\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/dynamicExtensionSeeds.js\":\"8e4f065b99cda1ae\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/dynamicExtensions.js\":\"079a30c1b47aae9a\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/exampleExtensions.js\":\"55be647f3ddb86a4\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionApprovalStatus.js\":\"074b59545a727717\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionLoadErrorToast.js\":\"e3c4d868aff05c1b\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionLoadErrors.js\":\"175e9ffc12a550db\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionLookup.js\":\"1c7bae16c7221512\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionToggles.js\":\"714a171e56060a7b\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionUtilitiesCss.js\":\"7e0bed40be38c2ee\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/kernelPageDeletionGuard.js\":\"156e5d957f19be34\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/liveRuntime.js\":\"ce203897d71a2075\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/openExtensionsSettings.js\":\"975c62704f325733\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/overridesCache.js\":\"5a14621eb913f13e\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/pluginIds.js\":\"816466bd2c117720\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/processorRejectionToast.js\":\"2cf2d6f3694b9afd\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/runtimeActions.js\":\"3d1ed8f0c6d15f74\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/runtimeContext.js\":\"774b267f6b35d163\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/staticAppExtensions.js\":\"1277fe5170848f86\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/staticDataExtensions.js\":\"71f9d3bf91fa782d\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/toastAppMount.js\":\"162b73ed2d888287\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/useOverrides.js\":\"8a1197155522faa0\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/useShortcutSurfaceActivations.js\":\"f33549c53dff12b8\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/discoverToggleTree.js\":\"43afcf24db58f0ef\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/facet.js\":\"c7c1e6e3b746f6e1\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/resolveAppRuntime.js\":\"7a929571ddf6613d\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/runtimeEvents.js\":\"49487c71b0e8be3d\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/togglable.js\":\"af7dba9ec67d46f2\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/variantFacet.js\":\"1c66aad3d4202be9\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/verbFacet.js\":\"0aad2ae578a37e07\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/block.js\":\"6efee7b1f9dd766c\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/focusedChild.js\":\"353210930a998147\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/propertySchemas.js\":\"5ad720c3b9c0d0f3\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/typeRegistry.js\":\"8f42bbf03d863399\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useAncestorCrumbs.js\":\"307c3f30b041f4de\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useAutocompleteListbox.js\":\"92d90416c2e56cd3\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useDebouncedSearch.js\":\"a2ee3069e5b720ef\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useDebouncedValue.js\":\"653c160b60705e9a\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useFacetValue.js\":\"fbafbdad659bcc08\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useIsFocalRender.js\":\"ed0fbf9c95e33d2a\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useIsReadOnly.js\":\"4ba60226b16e5209\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useMaterializeBacklog.js\":\"8e59b93d33e42bc2\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useMinuteClock.js\":\"dbd4da7aeef2a4ee\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/usePanelLayoutProjection.js\":\"c36913879068966d\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/usePendingInvitations.js\":\"018f59bd87baa3d9\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useRendererRegistry.js\":\"57f0c238a09c8d9e\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useRetainedFieldRows.js\":\"7f37431ab8fd2ccf\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useWorkspaces.js\":\"9cdd5a745e2327d9\",\"/knowledge-medium/pr-preview/pr-1878/src/lib/utils.js\":\"c6f4cd06508dc269\",\"/knowledge-medium/pr-preview/pr-1878/src/main.js\":\"0daf153cbcf7574c\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/MarkdownImage.js\":\"e9b58760b45099f3\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/blockSeparators.js\":\"ed9b748377862c6c\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/context.js\":\"6e328dc560e8c37f\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/defaultMarkdownExtension.js\":\"a0133630b4e66c4b\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/extensions.js\":\"46bab65be3a325e7\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/renderMarkdownHtml.js\":\"0344805daa69f10a\",\"/knowledge-medium/pr-preview/pr-1878/src/minimal-editor.js\":\"93cd2e77da518bd9\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/armedCut.js\":\"d44a980ffbdc54dd\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/captureMediaVerb.js\":\"6ab801a1fdab00ae\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/clipboard.js\":\"9e1b2fe7c9adc1f2\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/decision.js\":\"3ea8835455b6ccb0\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/operations.js\":\"b80431156a171227\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/account-header/AccountHeaderItem.js\":\"9806a09ea39fda70\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/account-header/index.js\":\"f963cac3714bce79\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"60592f0b2c8faeee\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/askAgent.js\":\"071cbfca9515bda3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/askedStore.js\":\"f68604e080212235\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"fc0bf45e8d0bbe4a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/chipState.js\":\"394bb8cffb3d2441\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/dataExtension.js\":\"fb82bdf6b5fe27c5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/index.js\":\"a184674be7130e3a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"bbec47542d9d9318\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/schema.js\":\"6afe3529578e3751\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/AgentTokensDialog.js\":\"55b2cdf3bcee57f7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ade5a7d4167a260a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/addMedia.js\":\"a87927ad4d8e268d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/backlinks.js\":\"68944cfdc5396196\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/block.js\":\"0ce9d5ef4956877c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/context.js\":\"e446504762573d3e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5ee04b48531c57f9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/index.js\":\"e94b86c31af4daa0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/outline.js\":\"a2d0da73eef73e77\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/properties.js\":\"e92a08e012d7d987\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/refs.js\":\"450cdadccbb3b14d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"dc8aa5743d1f34e3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/search.js\":\"ff5abfd13e28545f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/shared.js\":\"ffb841ffac2b249e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8ef236dbc7708828\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/text.js\":\"f574208d973ea8f7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentWrites.js\":\"d3d063153df8a953\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/authoringCatalog.js\":\"f291bfb8eb2a5d8f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/blockRefTargets.js\":\"64c4086909aab4fa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/bridge.js\":\"cd86e429ad880228\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/bridgeLoop.js\":\"2f658c5795ad7325\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/changeHistory.js\":\"c6dd2c755aa99b3e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/commands.js\":\"d4c6c2b45aea501e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/commentsCommands.js\":\"410894427581d615\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/dataExtension.js\":\"afe7fb37bc3d54cd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/dataModelGuide.js\":\"c741ccf0ddbf6153\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/describeRuntime.js\":\"4a7c8bd428741a01\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/extensionLint.js\":\"6cfc5753b358e0d1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/grainAudit.js\":\"c8dc29e3a0180b47\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/healthCommand.js\":\"3e97b7b514013a9d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/index.js\":\"a71db6db354c6361\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/presetIdentity.js\":\"84f662acbabe1ea2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"41fb125ba88a64d2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/readMedia.js\":\"f289b0de6a206348\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/schema.js\":\"8ed1c1664da98b68\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/serialization.js\":\"d2daea48590ff131\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/targets.js\":\"283c2667331b94cc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/tokens.js\":\"61d0740d6b542196\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/watchEvents.js\":\"bee5fdfb1c24ed3b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/workspaceGuard.js\":\"d9681948eb3707bc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/writeCommands.js\":\"cc612086b8ab8f12\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/AliasCollisionToast.js\":\"e091828e099e78ee\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/DuplicateNameBanner.js\":\"ff159dad275a97a1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/collisionMerge.js\":\"3cb087b4c8cb4c1f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/dataExtension.js\":\"fba5fd8f7ecfe171\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/index.js\":\"31cf2a81822630b1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/mergeCollisionAction.js\":\"40a922b55680dd8b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/pageStyling.js\":\"1b09a5db60edd169\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/rejectionToast.js\":\"d3c70ccd954224fa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/syncProcessor.js\":\"bcb9b50e674e260f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/actions.js\":\"be4da559b6c67c9b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/addComment.js\":\"02aed83e8b866461\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/anchor.js\":\"167a85c143623234\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/anchorState.js\":\"3ab8b84eaaedd2e4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/commentLinks.js\":\"4c0be3b826701a17\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/confirmThreadDeletion.js\":\"2e29dbf4e22e94ce\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/container.js\":\"851c19aeceaed062\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/dataExtension.js\":\"26ae31359ec72942\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/deleteComment.js\":\"b349323288b3d3b2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/highlights.js\":\"b20e37b0c9a1f4ce\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/index.js\":\"178d9e5808b578e8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/linkedCommentsPill.js\":\"012699c299d1e06a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/margin.js\":\"f18ab96656975fec\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/marginAnchorLinks.js\":\"b1e73df13f54818c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/marginSchema.js\":\"d72b5b9b05dc82c5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/newComment.js\":\"a57bff9c47af5c7e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/ownThreadPicker.js\":\"658644ebee1187ce\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/placement.js\":\"10fd1b1940f787ee\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/queries.js\":\"2eb8ba4a64e5d510\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/quotePosition.js\":\"cbdf7880902b2b88\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/quotedIn.js\":\"00ca662cf8544818\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/quotedRange.js\":\"8ed376e10dbe781f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/rangeRefs.js\":\"8640bf5253a1b20b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/readHighlights.js\":\"905bc0783fcae253\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/readSelection.js\":\"fa9ea2577e055860\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/readSelectionUi.js\":\"98263601fb241c66\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/reanchor.js\":\"e2bf5700c1ac2a79\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/schema.js\":\"12a23f7d643b8749\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/scope.js\":\"409c7725059b4828\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/scopeThreads.js\":\"54d7e91ad4f8f008\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/splitRetarget.js\":\"739fd428f4cbb1f5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/suggestionCard.js\":\"4f78449bc08406b0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/suggestions.js\":\"aae455aa25361eaf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/summaries.js\":\"9310d273b4c9fb2d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/summaryBatch.js\":\"430150e5aea4403b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/surface.js\":\"96964a27b31fbb06\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/threadNavigation.js\":\"76f2300ded202efe\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/threads.js\":\"96f0bbbd51257f5c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/ui.js\":\"2f1975e0d14673b6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/uiStore.js\":\"7349fe9331a34d12\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/app-intents/appIntents.js\":\"d66570cc3854f9de\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/app-intents/index.js\":\"14522449a0ca591c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/app-update-prompt/index.js\":\"f2009c697d55c90b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/app-update-prompt/status.js\":\"de384ef45415ec39\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"09576bc787ffb203\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/MediaBlockRenderer.js\":\"c7acb6680a065e86\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/MediaDownLaneReplicator.js\":\"90985f37907b37f2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/MediaUploadReconciler.js\":\"1594cff92a8586b6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/assetDownLane.js\":\"7dc0177c5a2765a9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/assetResolver.js\":\"97267546ee6c9863\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/assetUpload.js\":\"a3de5d406ec42c37\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/attachmentCleanerIO.js\":\"c6ea9fb8db0d152a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f38ca20b587a7c4b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/blobStore.js\":\"bc416ef4c0f7e460\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/browserMedia.js\":\"0da8c3117b50df8c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/byteStore.js\":\"d4fb79f8e118d5f5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/cleanerIO.js\":\"c13d68d460ccea35\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/cleanupAttachments.js\":\"a499beb480277b12\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/dataExtension.js\":\"dcbdc1faac8b572d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/downLane.js\":\"2007fac73c2568bf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/index.js\":\"9de82758d3c1b768\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/insertImageContribution.js\":\"86568922a6a05770\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/laneArming.js\":\"892cbb6206abee1b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/laneLock.js\":\"f3029fd11a830d06\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaBlock.js\":\"ea68fab76f97c66b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaCapture.js\":\"ec221a9f24c40088\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaLanes.js\":\"77be601c839ebe22\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaViewers.js\":\"ab6daf0ef1616dd9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaViewersFacet.js\":\"531fe716b16de45c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/pasteCapture.js\":\"c7690cd91901fe7a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/resolver.js\":\"832e1e0ebcb2b540\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/retryUploadsAction.js\":\"280edf2c617213c3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/storagePaths.js\":\"2b858f23e88200c9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadDrain.js\":\"d9278d3b03a615e7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadLaneStatus.js\":\"929bf643ba9e642a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadReconcile.js\":\"f1035fa0131a7f51\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadRecovery.js\":\"fcd658d856e04c45\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadStore.js\":\"bf5cd4c38e3a4731\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/useAssetObjectUrl.js\":\"900d2905355b3ab2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"fc17e6c66702f453\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/BacklinksViewSection.js\":\"1ed33f67cbc12546\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/facet.js\":\"2231c4a361e04c14\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/index.js\":\"16e3b67ed09aefb3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/prop.js\":\"91035f05de61993c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/BacklinkFilters.js\":\"cc1d0f093c5fa3c6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"3b66152a9fddbfaf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/BlockEntry.js\":\"4b69cb046f205991\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/LinkedReferences.js\":\"7b61b1462b15dfd9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e771dcfc91b0c93c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/dailyNoteDefaults.js\":\"eb6bca61ef5a8b9f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/dataExtension.js\":\"1fa2f091eaba88b5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/edgeExclusions.js\":\"3e6eebf935b06d8b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/filterProperty.js\":\"cd3b4923c3c8b882\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/index.js\":\"8e993774080b0afb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f213e3214b2d3ae5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/applies.js\":\"0e5996d43e682e66\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/countQuery.js\":\"8a1d8f3c3425ecfb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/expansionStore.js\":\"5bd3d358c1a15193\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/index.js\":\"f36950da8385afc7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f02e0eee2349abfb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/presentationInvalidation.js\":\"30ffb46922384f04\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/propertyEditorOverride.js\":\"60dabd8348747b03\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/propertyFilter.js\":\"090faca3304ace6b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/query.js\":\"daefb0450e94022c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/resolveFilter.js\":\"03985df60c5ca127\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/sourceBatch.js\":\"a6fbbd8ff4f28167\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/sources.js\":\"c562dfba0be6b2d6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/useBacklinks.js\":\"b050b98e36fa1259\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"970d734a7717cf49\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/BirthdayCelebration.js\":\"3c5a9810729831d4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/BirthdayOverlay.js\":\"b50749c5fd8d6573\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/gate.js\":\"3fffe629f407973a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/index.js\":\"d0bc83249add89b5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/wolfTheme.js\":\"db11a6810c4efcb4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/BlockDragLayer.js\":\"3f22cfca23255518\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/dragController.js\":\"ad3043ff7e56652e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/dropTarget.js\":\"0f0fbd4295d3d485\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/index.js\":\"dbbdb01e1e49b98a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/projection.js\":\"7c87298980cd041f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-info/BlockMetaCard.js\":\"ccecc5eb3c93ab30\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-info/index.js\":\"c9077c8e55f04d25\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/AddTagDialog.js\":\"fe1317ee9d555d3a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"898c3d143c9ce4b8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/TagNameIssueHint.js\":\"bbd5f1ae86f6de8f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/addTagAction.js\":\"7d9a4852cc362e67\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/appendTag.js\":\"a349d721aca4441b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/config.js\":\"3c1f67be1ed96cd2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/dataExtension.js\":\"e6152b85ce69a51b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/index.js\":\"1c538856ef56b4d7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/propertyEditorOverride.js\":\"24683b563f897be2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/BreadcrumbList.js\":\"4876b95d2ef0682e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"2afcc057d22c1185\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8d040e4124c70f03\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b08ca76536e5dc46\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8bd972eb7ee8817c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/index.js\":\"e2c49c0ff03ad5e9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"ebf4eadcb714188d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/CharacterCountItem.js\":\"06b723d6f4e4366b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/ProfilePropertyEditor.js\":\"30b39864c7378913\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/actions.js\":\"7c04f32369e82854\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/blockType.js\":\"1462fe9b58cc0837\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/charCount.js\":\"db8c7d06e8a6f072\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/dataExtension.js\":\"203637df812f76eb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/index.js\":\"ab520e3af406662c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/profiles.js\":\"c6785d9f7e5c3180\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/properties.js\":\"d8bfe63deaaf7e57\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/textCounts.js\":\"aab432d2aec99252\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/colemak-keybindings/index.js\":\"74c8da6c82500287\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/CommandPalette.js\":\"60ed34673948ef92\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/HeaderItem.js\":\"a9ff7c44b0c23223\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/context.js\":\"e96b9effe4e81c05\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/index.js\":\"d50c36261cf7b7a3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/selection.js\":\"e168b7557b27e4e8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/toggleStore.js\":\"37945e1ca13b8dda\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/useCommandPaletteActions.js\":\"38961a754287a790\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/ContributorBadges.js\":\"744dbf1b1bccec07\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/author.js\":\"8a8efbec7c73064a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/codeMirrorExtensions.js\":\"a66cc5cf6f081a37\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/dataExtension.js\":\"4dd39459832f6384\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/index.js\":\"a42d66b1be665938\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/mentionAutocomplete.js\":\"5e4d360c9d4d4286\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/processor.js\":\"bb8e44a1714dda59\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/profiles.js\":\"a219cc96e17150aa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/queries.js\":\"d72e60d63daf3988\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/schema.js\":\"e807f2b6b1a80803\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"57685e6292dfb9de\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/followOrigin.js\":\"9f1484006e8f6adf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/index.js\":\"e2636c9d66091991\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"4165ae545a92b3ac\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"4017e67768c19b18\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/CalendarGrid.js\":\"f63e5816f597e405\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/DailyNotePicker.js\":\"8eeeb98f4eb1ab4e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3eb20fa17dc1d51e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/DateNavDecorator.js\":\"d4fe43634df0d393\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/DateScrubOverlay.js\":\"0f3d2247fbff9fda\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/HeaderItem.js\":\"4d1d00d696e1b408\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/ReschedulePicker.js\":\"a1a381ade2c15344\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b20c42172f5ebd02\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/actions.js\":\"c02a656a99ca41c9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/blockDateAdapter.js\":\"caf096d5fcf7fe56\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/calendar.js\":\"d62e61fb18a76684\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dailyNotes.js\":\"5ebcc806bb06ec5b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dataExtension.js\":\"e72967e1cb20bf64\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dateScrubActions.js\":\"3d70b01524c88e13\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dateScrubGesture.js\":\"bc2ffdddce722369\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dateScrubGestureActions.js\":\"558c76c58a268eac\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ae1b54daded38aa3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/deletionGuard.js\":\"291402b4136b0027\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dueQuery.js\":\"bfa183b7f3fea15c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/index.js\":\"e5628a459240842f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/landing.js\":\"cb63bed8b766b042\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/localSchema.js\":\"8396ee5c6f1340e9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/referenceDateAdapter.js\":\"3c98b13dac92979a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/rescheduleAction.js\":\"ad7e286bcbbc34ac\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/schema.js\":\"f8c7e2830227ff67\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/spreadBlockDates.js\":\"2b15d8d3d7a65e36\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/spreadDatesAction.js\":\"b60eb34f7a81fefb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/today.js\":\"c904d9ce2d71d536\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"43e5c2dc2c82c881\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"4b1f8eb6826157e5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/audit.js\":\"d6056e6cb69c3a1a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/auditAction.js\":\"33e4f60eeb3fc06b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/auditRanges.js\":\"18a6d8786145cb81\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/diagnosticsSource.js\":\"6522c2fb175bfd14\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/divergenceScan.js\":\"1069c4abba616a4b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/index.js\":\"bab029770ebf37f3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/propertyChildrenChecks.js\":\"51dc725e0f7ab526\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/referencesMirror.js\":\"4ea7236b33bd7df0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/rowJson.js\":\"d1250ac7db2b4ad2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/schedule.js\":\"38d0ecf49d49defa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/store.js\":\"0e9bca4fd4b4d8a7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-maintenance/action.js\":\"779651a55c68982c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-maintenance/index.js\":\"defd3ee9a0c9b6e8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-maintenance/plugin.js\":\"ac55696af1744879\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"bb3dc58179c10b7c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/actions.js\":\"19c31d6e6e8acf40\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/changeMarker.js\":\"1e7489a9eee1ef64\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/diagnostics.js\":\"87339a1d9bbaafb9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/fileSystemAccess.js\":\"3d91b8853a2954cd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/filenames.js\":\"d94783d3db680dc1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/index.js\":\"87f2a1e94cf4cde7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/mirror.js\":\"f80cd884b15c71e1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/runLock.js\":\"8c079f42e79f30b7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/runtimeHealth.js\":\"2c12b3646d10c97f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/schedule.js\":\"0e948ca3809ec518\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/store.js\":\"e7e78d4587991e51\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/default-themes/index.js\":\"fc141f153f086361\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/default-themes/themes.js\":\"254d77bdabfd5af1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/diagnostics/facet.js\":\"8772ce1b7061d94a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/diagnostics/useDiagnostics.js\":\"e2535be969a29709\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extension-prompts/dismissals.js\":\"7e675f0a7da5505f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extension-prompts/index.js\":\"8688fd5a804f3936\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extension-prompts/status.js\":\"ee530ccb56df9f53\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extension-prompts/store.js\":\"671ed35ae1612d10\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"ebf297fa4803a366\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/ExtensionsSettings.js\":\"2b6e194c9e4ea943\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/actions.js\":\"94915776b8d197b5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/config.js\":\"3854afd395721d6b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/dataExtension.js\":\"484ec61bf037ccd2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/effect.js\":\"dbb8933efb5e2626\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/index.js\":\"e3fa1bbe0aa491b6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/propertyEditorOverride.js\":\"c0314218ad6b4a55\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/useToggleTree.js\":\"9a6dd35e0fa9039c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/ExtractTypeDialog.js\":\"81bc1955f9487b1d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"776859753864ec94\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/PropertyShapePicker.js\":\"b11d1dededa4512a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/action.js\":\"6815857664effc00\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/index.js\":\"afe00365f0165df7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/FindReplaceDialog.js\":\"d9713888e0389acf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/HeaderItem.js\":\"1bab1f63b7cd041c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/dataExtension.js\":\"56a92fdab81d5b57\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/index.js\":\"14abcc0d86fac39b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/search.js\":\"fa6faa54fc44aa19\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/toggleStore.js\":\"95afa3496de81283\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/LocationPropertyEditor.js\":\"5f2be6759d180df5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/MapView.js\":\"33d7419a943e5109\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/blockTypes.js\":\"087c33e6deef67f0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/codeMirrorExtensions.js\":\"db2fc3e538c7849d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/createOrFindPlace.js\":\"6885e1cd2a6ccdf1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/currentLocation.js\":\"84751fe595b78ecd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/dataExtension.js\":\"b088576ec3b2bea4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/geoContentDecorator.js\":\"7c49dc6d22ac6996\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/googlePlacesClient.js\":\"5a25d625df59f23c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/index.js\":\"af0eec908d8524e7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/locationsPage.js\":\"f3c6ed4e44ca4c53\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/mapViewport.js\":\"830071363740189d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/pickCurrentLocation.js\":\"0e9b7f5df3adde80\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/placeAutocomplete.js\":\"1a7a5a44906eb60b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/placeNameCollision.js\":\"2572a8a605091847\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/properties.js\":\"58cc2d4ca5c0bb37\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/propertyEditorOverrides.js\":\"35ea8b1552b16961\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/query.js\":\"8364086a2f4cf807\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/usePlaceSearch.js\":\"450ec4c481fca5e2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"eed5803e09d3c631\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d80711cbdd13263f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6b31d57dfe3c51ef\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/config.js\":\"3ca7f4cb29611c37\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/dataExtension.js\":\"82207b523f987192\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/facet.js\":\"a9cc338b02657c95\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/grouping.js\":\"5402eac6b62acc8d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/index.js\":\"7655259baf9fc736\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4c98fd2ae3f3b55c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/query.js\":\"d61244638d35dae8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/resolveConfig.js\":\"30eb2b22d5c1c317\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"5ad9ff38902463d8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e8f99b21ff8f8456\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/HtmlDocumentContent.js\":\"393f726ea047f818\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/HtmlFrame.js\":\"5300b06d87290359\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/actions.js\":\"af92823efdd1426a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/blockType.js\":\"d681041233d1b5a8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/confirmRunScripts.js\":\"539f05464ff6d8fd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/dataExtension.js\":\"a5430ea85272de77\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/frameAnnotations.js\":\"371d14f13aa6b717\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/frameDocument.js\":\"312760e9f692b92f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/frameTheme.js\":\"19bf40f0d7c3d49e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/index.js\":\"52a5761c378ff4e7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/scriptConsent.js\":\"7539530dc5e8eba9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/sourceMap.js\":\"9fe6b809ef5bf0f2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/useDocumentScripts.js\":\"9f2a5ae50fac3a08\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/index.js\":\"6e86b3e34e84ed61\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/record.js\":\"e2d6c2c1c863d239\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/recordStore.js\":\"ba03c2699e37be3c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/responsiveness.js\":\"67ec1db73efbfa6a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/schedule.js\":\"babf187efc510477\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/sessionContext.js\":\"057a9e54de2c02ba\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"31e5307fbba12d38\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"de0adce603b41890\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/actions.js\":\"830bfa740e9d1c4d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/config.js\":\"62b256648508893f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/dataExtension.js\":\"c390baa36410cfe2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/effect.js\":\"413c20b359205235\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/index.js\":\"19381352d9add620\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/keyCapture.js\":\"01c0294e8bf078ba\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/overrideStore.js\":\"31d5930bfd4b0e1e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"1f9417f1aad801fd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/HeaderItem.js\":\"ed4aa14f9635cf1f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/LeftSidebar.js\":\"af3ffbbb8c292284\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/actions.js\":\"11097cc4272a8f31\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/facet.js\":\"508344bc0ae61eea\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/index.js\":\"416943d09ccd9492\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/shortcuts.js\":\"33edeb09aa94cde8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/toggleStore.js\":\"4ba5a325a5f2900f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/merge-blocks/MergePicker.js\":\"3348232bf03660f9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/merge-blocks/index.js\":\"8f5a424931abe50a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/merge-blocks/mergeAction.js\":\"bae06542331fc64e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/merge-blocks/strategy.js\":\"831f038d01a55354\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/Button.js\":\"6594a8852878f0c4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b80cd8c65bd8d444\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f26e3c930e94f159\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/facet.js\":\"56999583fc28da18\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/index.js\":\"fab848a39e74e9a0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d5396f86665fd462\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/actions.js\":\"25da73eb4015dc50\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ef4d1557ffcc6acf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ebfb72e2d4a90e5f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/index.js\":\"bd4c60ef2a506b55\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/MoveDestinationPicker.js\":\"750100d3c77ba95c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/blockSubtreeMembership.js\":\"45ca25fe792d2dfa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/contextMenuItem.js\":\"56acb34cd8b6fa4d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/index.js\":\"ba8f978c6ebaa3e9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/moveAction.js\":\"2674d680d0b2adbd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/moveBlocks.js\":\"036bb71f173c4cab\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/selectionAfterMove.js\":\"731539d75099e0a8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/TutorialBanner.js\":\"79dc99b8562a4253\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/action.js\":\"8deef0f5d9742fb2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/bannerDismissal.js\":\"5e50c47ee1c06f82\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/documents/cheatSheet.js\":\"2c153fa55890bc20\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/index.js\":\"a8a6c91b435c1426\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/keys.js\":\"b4b27c2887338d47\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/landing.js\":\"8f7b3b2fb8572518\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/outline.js\":\"889ae672333da79f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/seed.js\":\"d34845fc394243a2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/PerfTrendDialog.js\":\"2c68ca151dc7c687\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/analyze.js\":\"6fc3e93b4d16c64c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/diagnosticsSource.js\":\"26e845e62a63af5a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/index.js\":\"b7ebe0c6c1569e41\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/load.js\":\"8354396b7892b649\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/monitorRun.js\":\"c21315c33682ab8d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/schedule.js\":\"b90e4e4424cc38df\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/series.js\":\"422abe53f0bf62cb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/store.js\":\"1deb742d8ed74ae4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/trendAction.js\":\"9640047a95aacda2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/verdict.js\":\"491f09fca56cc275\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/plain-outliner/clickToEditAction.js\":\"b24603f7e3d7b463\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/plain-outliner/index.js\":\"fe780995fb2a0f84\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/plain-outliner/interactions.js\":\"8cc2cac42a501e9e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"179802cbe6b29919\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/MigrationGate.js\":\"42282418cafb2f4d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/MigrationGateDialog.js\":\"521e7c37fa12951e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/action.js\":\"f175f4ce92284c78\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/index.js\":\"dfa47da27f9af4e0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/localRunMessage.js\":\"3c3cc0dfd943ac3c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/plugin.js\":\"9891e9d14a2ad453\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/progressReport.js\":\"7b39b58fcd7fd500\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/sweepProgress.js\":\"263e7a7f612c979d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/FieldRowRenderer.js\":\"3c56872803f592fd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/ValueRowRenderer.js\":\"cd0f7e8412a8d23d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/actions.js\":\"1a059d7e0dd538dc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/autocomplete.js\":\"071e2380d9608d7d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/fieldRow.js\":\"9f674f49fdcf551f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/index.js\":\"bef52a381a62629a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/referenceWarning.js\":\"cb43b8c8e666d80a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/valueAutocomplete.js\":\"5c0c87df1259702a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/valueSchema.js\":\"67a86ff2f5db3a99\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/HeaderItem.js\":\"093a0510c7b624c4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/QuickFind.js\":\"0b2786da1fcad207\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/index.js\":\"7d360d1ded8d59f5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/recents.js\":\"7a8d4c10da4bf531\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/resultItems.js\":\"63825294839c37bb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/selection.js\":\"4eb920f761747410\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/toggleStore.js\":\"d08d6faacd4b6e93\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/HeaderItem.js\":\"13618fbb1e6a418a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b376f0cad409758e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/grouping.js\":\"752e1aa2dc694e16\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/index.js\":\"6a71e8b2293a17d9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/target.js\":\"8cb7716499e75d56\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/codeMirrorExtensions.js\":\"1197acccc5cc470f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/contentPrefill.js\":\"463cecdeb59351cc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/dataExtension.js\":\"d88238bb9e8796b1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/index.js\":\"c3975e4a4628756b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a5187c43dbb141a5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/invalidation.js\":\"3efc7e9a8cbedf54\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/localSchema.js\":\"9f59584bc112a6d4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/blockrefs/index.js\":\"77336aafcfcadb17\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e777c86be4147c8c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/index.js\":\"322d406d618338f8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/referenceNode.js\":\"5c5243f64394b91c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b4ce5b13dd899fd7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"608340f02be355b6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/wikilinks/index.js\":\"26a00d64e69b57e7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3592caf6516aca9c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"72b246604f9ca79d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/mergeRetargetProcessor.js\":\"e09b4e57fe035e1b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/parseFence.js\":\"f605adc615b4e668\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/referenceParser.js\":\"24b9b976b4ef0728\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/referenceProjection.js\":\"8ce1e8950042a603\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/referencesProcessor.js\":\"0980f524668f91a9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/renameProcessor.js\":\"a2be2aa9d640bf72\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/spanReplacement.js\":\"04ab28f60e77fd11\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/rich-paste/htmlToOutline.js\":\"177523b954e11f57\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/rich-paste/index.js\":\"96f4c156812403ee\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/rich-paste/normalizeClipboardDom.js\":\"402b77bbd80f28d1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/rich-paste/pasteDecision.js\":\"84c533ee42caf8fe\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/action.js\":\"1e3197fcdc1217ca\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/blockIds.js\":\"a573382a4c86a65f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/content.js\":\"95930740de2d0e65\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/effect.js\":\"1591b189e121e7bd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/ids.js\":\"0b06de1ba4a746d2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/import.js\":\"9e0a515f8eeefc76\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/index.js\":\"4002b5012f9e5fa7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/plan.js\":\"e3b19d2a817777a0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/plugin.js\":\"5cae2797395665bf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/promotion.js\":\"0b32bc3a911cf0ed\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/properties.js\":\"5bc309f170ca23bd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/references.js\":\"590fbf727297649f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/report.js\":\"258436c5cf2a6811\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/roamMemo.js\":\"e466e49131ee6cf6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/runtime.js\":\"273f7a6fc362c23c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/schemaReconciliation.js\":\"de10e78649da470c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/srsMarkers.js\":\"0e16fdbfe4e32f60\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/todo.js\":\"a7adbe4b18320cd7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/typeCandidates.js\":\"a2ea4041440bbc8c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/types.js\":\"2e88d5526befff2c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/search-health/index.js\":\"997ebbed4b6b735b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/search-health/store.js\":\"b6af8e1fad4d1c50\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/HeaderItem.js\":\"ee7afa79b47f8d87\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"d22adebd7aa32d3c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/index.js\":\"da2aaefcd4206c7d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/model.js\":\"aca4177a3f8f34ab\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/toggleStore.js\":\"aeb4ed74da5882dc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/useKeyInspector.js\":\"24da3f23211ef947\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"60144ff3730e99f1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/ShellDecorator.js\":\"ff11a272170e625d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/actions.js\":\"b64d918c77936faf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/exclusionsFacet.js\":\"9e166117bc0afb5f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/index.js\":\"c8ac1662b23f9c79\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/shell.js\":\"e6752fc7562b2d52\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/surface.js\":\"93ce198a2a10b0f6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/walker.js\":\"76e0fe09c2be2e37\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/RescheduleToast.js\":\"636aad32d24e096e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/dataExtension.js\":\"e35235c9e7464745\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/index.js\":\"0c3c0c55428f5b3f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/indicator.js\":\"d89a4bfc8deb0157\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/moveSrsState.js\":\"fea6c93a65944ee2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9012034a13d68f1e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/scheduler.js\":\"1be8347c5c233242\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/schema.js\":\"20eec66cc9af4331\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"35fa80ca1ae7189b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/srsClipboard.js\":\"f97bcd04ac448267\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"44253846c315d5f1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/DailyNoteReviewHint.js\":\"28493157effa23ae\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/DeckPicker.js\":\"e3c3ba91a7fb59f0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/ReviewControls.js\":\"50b2477a6b05c00f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2d9b34ad72462d1a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/ReviewSession.js\":\"1710b951be723370\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/actions.js\":\"939d775692b24c01\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/archive.js\":\"944b052cab770fb9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/dataExtension.js\":\"1969fe0c86ed562e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/deck.js\":\"9493b02e23238030\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/dueQuery.js\":\"ed690cc7b996b0db\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/gradeDecision.js\":\"d5e9989a945f9df9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/index.js\":\"2cb078c9314626f3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/keyHints.js\":\"cbc645a86b853b5c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/reviewCardLayout.js\":\"2f1925132dd07b4d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/reviewProgress.js\":\"fc69fe4a92bbfb5f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/schema.js\":\"9f943c11201afeaf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/useDueCards.js\":\"ea969f841772066a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/startup-metrics/index.js\":\"3a9f30b74ff4d9a7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/startup-metrics/record.js\":\"91b055e5da4caf5a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/storage-persistence/index.js\":\"9aa4416fb6d47cd9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/storage-persistence/persistenceStatus.js\":\"ca30d8f8b389127c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/storage-persistence/requestAction.js\":\"3ed0f3fba107d0f0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/supertags/TypeChipsDecorator.js\":\"4d768e53aabfa526\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/supertags/codeMirrorExtensions.js\":\"fa393c8d8ae2a035\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/supertags/index.js\":\"b5780e3c93bf7077\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/supertags/typeAutocomplete.js\":\"0bfd01d0ff781c3f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8d8c6c55fd328ddf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/actions.js\":\"aca9d06b47feb2a2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/anchor.js\":\"703c2c29c601bb76\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/events.js\":\"1c6a1f81d1b59aa7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/gestureActions.js\":\"82d597783259e646\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/index.js\":\"64fd97edec1971e8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"3c7ee769e90c752a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/sync-metrics/collect.js\":\"3ef7c659941b5b53\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/sync-metrics/index.js\":\"7eb6f0766c13523f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/sync-metrics/record.js\":\"5bda92f79a51a85a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/RejectionDialog.js\":\"e25f2892810b6d28\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/SystemStatusHeaderItem.js\":\"e8b5743468f794a4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/index.js\":\"38b9256ff3ce0cf3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/model.js\":\"151666a7e0d866f2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/queueCounts.js\":\"7a5cbaa9b8745145\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/rejectedHelpers.js\":\"b7b09df36f739fb6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/rematerializeAction.js\":\"b0e7bcf1c0702452\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/useHysteresis.js\":\"926d098d4b392f15\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/ColumnHeaders.js\":\"9e0cb8b6f3da6867\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/QueryUi.js\":\"00d799d9832a04de\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/TableLayout.js\":\"1702aa2f17746516\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/actions.js\":\"654ff7d8179992d6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/cellEdits.js\":\"e3bdc2b22b000b74\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/childrenViews.js\":\"d65323212ade28d2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/columns.js\":\"00bc231dcc9fc395\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/controller.js\":\"3df6189aa52ab1fd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/convert.js\":\"1df497308af5cd95\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/dataExtension.js\":\"2fc09881e8acd9b1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/index.js\":\"2ef8c019986c273b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/keys.js\":\"6efc6ba25f890764\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/model.js\":\"29c75d3ecdff73b1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/backfill.js\":\"5563ac66c485ba65\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/completion.js\":\"40b3e5ede8c8ba7d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/format.js\":\"3f126f33cdd0b036\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/parse.js\":\"4a60d1949e8509e7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/queryValue.js\":\"2952d2e2ee9ff8bf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/registrations.js\":\"0d6da34336c3c956\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/source.js\":\"b81418d3f4d42214\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/registry.js\":\"681d21589dae1cc0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/rowGutter.js\":\"7e9299da85987164\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/rowVerbs.js\":\"6c08dd8520417ea0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/schema.js\":\"d2d83c051b611d11\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/sort.js\":\"ab3013ca7f32a703\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/theme-toggle/effect.js\":\"4dcf1a81055f2111\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/theme-toggle/index.js\":\"2d57e0a96b40baa9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/theme-toggle/theme.js\":\"6b60c49039422ed0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/todo/actions.js\":\"f85bd32b140102a3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/todo/dataExtension.js\":\"80986efddc1f7150\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/todo/index.js\":\"7452786cd96c780a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/todo/schema.js\":\"f508fe730f93fac2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/TouchSelectionLayer.js\":\"260ac50dab7b82cc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/actions.js\":\"279b657c4fa31731\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/defaultItems.js\":\"621e7f5782e9ee28\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/facet.js\":\"6bccac172328cef7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/holdRecognizer.js\":\"22d0b11d54ee7818\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/index.js\":\"c93a33d503fe3479\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/update-indicator/UpdateIndicator.js\":\"ef55751fc3d0b97f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/update-indicator/index.js\":\"b906fc4855d4c310\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/update-indicator/loadTimes.js\":\"f1b77bb010be1283\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/VideoNotesRenderer.js\":\"02c919b711c2c427\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/VideoPlayerRenderer.js\":\"4692f223cbc692be\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/VideoTimeStamp.js\":\"978b335fe15b9e3a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/actions.js\":\"eb31442b701bbef0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/index.js\":\"a52aac9965bfdb61\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/markdown.js\":\"802ffe1218599b65\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/notes.js\":\"e1310609ce48f696\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/registry.js\":\"70b1a55f40444e45\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/remark-timestamps.js\":\"4211fa74313abc6a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/view.js\":\"8e8a4b97fe5b5743\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-link-hints/LinkHints.js\":\"bdccf672520e5b5c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-link-hints/index.js\":\"0fed789329b1e8ef\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-link-hints/model.js\":\"c18e247ba5518aa0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-link-hints/settings.js\":\"c5ba1297f8828b47\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-normal-mode/actions.js\":\"25fcc66fbd9b1d80\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-normal-mode/index.js\":\"80a938c1b0acdd53\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-normal-mode/interactions.js\":\"a0c3246b2206e76e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/workspace-header/index.js\":\"c0bd6413e9e92979\",\"/knowledge-medium/pr-preview/pr-1878/src/registerServiceWorker.js\":\"24a362db610571bf\",\"/knowledge-medium/pr-preview/pr-1878/src/requestPersistentStorage.js\":\"c2ac36c76ba97118\",\"/knowledge-medium/pr-preview/pr-1878/src/services/authRequestDeadline.js\":\"ae59577d892284eb\",\"/knowledge-medium/pr-preview/pr-1878/src/services/authStorage.js\":\"9230b2fcc4bf0407\",\"/knowledge-medium/pr-preview/pr-1878/src/services/powersync.js\":\"df1b50352ff372f0\",\"/knowledge-medium/pr-preview/pr-1878/src/services/supabase.js\":\"84178b6414582fd2\",\"/knowledge-medium/pr-preview/pr-1878/src/services/uploadErrorClassifier.js\":\"02691912713bec40\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/ActiveContexts.js\":\"29c82444ad5b52ae\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/HotkeyReconciler.js\":\"d882a5e56b1964b7\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/WipeLocalDataDialog.js\":\"963d07055afded5d\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/actionDispatch.js\":\"89c75160a8b692d4\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/actionRefItems.js\":\"03478d0ace8ca6e7\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/applyKeybindingOverrides.js\":\"469199d5d160d1de\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/blockActions.js\":\"30feece18bd62238\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/blockMergeGesture.js\":\"35c48cf2ba3b7a29\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/canonicalizeChord.js\":\"53bbd632cb603e01\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/defaultContexts.js\":\"1864e22bd638b3b3\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/defaultShortcuts.js\":\"9862b6ee4ad60b38\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/effectiveActions.js\":\"8e6f32cc29546fff\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/gestureAction.js\":\"8186bcd0606cc984\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/gestureBinding.js\":\"a47532b1d9aa47f1\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/holdRegistry.js\":\"233f203d1e758803\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/keybindingConflicts.js\":\"9b5eef690d139121\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/keybindingOverrides.js\":\"e11af1fd5297a574\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/pointerAction.js\":\"bf68d39cb7048a7c\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/resolve.js\":\"e1ebb0ee80d85d5f\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/runAction.js\":\"0402764912c0f505\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/sequenceMatcher.js\":\"0b7682d3d244620a\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/types.js\":\"7cf59a4a85c82466\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/useActionContext.js\":\"8acfe39eff294938\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/useActionDiscovery.js\":\"497dcf047e4965dc\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/utils.js\":\"1cf1b18b8a972c15\",\"/knowledge-medium/pr-preview/pr-1878/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1878/src/sw/bootStore.js\":\"135b7f9b53ce3ae3\",\"/knowledge-medium/pr-preview/pr-1878/src/sw/previewDatabases.js\":\"5450662daf487b74\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/byteTransform.js\":\"f0bbc7f8b6b815fb\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/attachmentCleaner.js\":\"4054f5f3e92a968c\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/attachmentParts.js\":\"7bdea612d0eadfb9\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/bundleParts.js\":\"e9a072358ca63e49\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/bundleRecord.js\":\"11a24f6e4a839465\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/manifest.js\":\"dbcd41535c038829\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/takeBundle.js\":\"845eb611494b447a\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/verifyBundle.js\":\"ec9d2f315f0ff2df\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/cleaningStage.js\":\"36a3a7530783eef4\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/conversionKey.js\":\"07795cb879ccf504\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/conversionServer.js\":\"0919fb7cfac44ad0\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/flip.js\":\"7ec9407639b5c08b\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/flipAttempts.js\":\"9b06fb2dbcb82254\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/pages.js\":\"f4288a7b3bb6a8ce\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/preflight.js\":\"45ffe9656e9760e3\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/reseal.js\":\"e9fe2e54fe3529ce\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/runConversion.js\":\"53d5c4e8ef33104f\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/runLock.js\":\"b1c48fe2dcf7eaec\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/sealing.js\":\"93d13338739473ba\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/sealingStage.js\":\"f4f0926c7b0d15b7\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/stage.js\":\"df60a474a4077c53\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/verifyReseal.js\":\"2cede066f2d9ff1e\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/aad.js\":\"7cc613792f9625bf\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/aead.js\":\"95e50b13de64c6d0\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/base32.js\":\"b1301fa30c1e85af\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/base64url.js\":\"32570f5b10f6ce41\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/binaryEnvelope.js\":\"78e5b1639ccd4411\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/byteAead.js\":\"401c449ac4a8e22a\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/canary.js\":\"43ce72e4a546d79e\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/contentHash.js\":\"1a973ad3bfc6cae6\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/contentKey.js\":\"af4be40dd2cbc84b\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/derivedIdNamespace.js\":\"996941b1ff0eab92\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/envelope.js\":\"304e83be083d8a39\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/hex.js\":\"5b17766f6217bba1\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/sha256Hex.js\":\"ecbc40e61ac67552\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/workspaceKey.js\":\"f920f595c96f3f46\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/conversionState.js\":\"e1b19bf0e9dfbab1\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/flows/createEncryptedWorkspace.js\":\"c1a98da2c84f004a\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/flows/pastedKey.js\":\"387645b754722b01\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"26ed51b7ec3e0a23\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d0f66f07eeaa583a\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/keyStore.js\":\"5ad00a52f69a0e71\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/mintWorkspaceKey.js\":\"793d37b39e512998\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/modePin.js\":\"04c1104bc9d5a072\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/openWorkspaceKeys.js\":\"e07ec6b5293928c1\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/resolveWorkspaceEntry.js\":\"9c3a0afcc4344caa\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/resolver.js\":\"c47a88757fb9810a\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/workspaceAccess.js\":\"a44da2197deb69e7\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/transform.js\":\"dd24884e4a54350f\",\"/knowledge-medium/pr-preview/pr-1878/src/themeBootDefaults.js\":\"862c065cee4b9af1\",\"/knowledge-medium/pr-preview/pr-1878/src/types.js\":\"f7677e61bc83201d\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/ClientLocalSettings.js\":\"2ab3b94755bc4a5b\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/abortableSleep.js\":\"7161916575782b91\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/array.js\":\"e4079b2c114f0863\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/backlinkAutocomplete.js\":\"066c239f3ef889d6\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/blockCrumbs.js\":\"96e44b81cf789d1d\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/blockrefAutocomplete.js\":\"4f587cc3cf4e783c\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/cadencedIdleJob.js\":\"b8b8fc403f531ce0\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/callbackSet.js\":\"265fe63d0eef04c6\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/clientId.js\":\"8b7b4ec8434a5c5a\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/codemirror.js\":\"217fd6157d8cb8df\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/codemirrorCompletion.js\":\"adffed98148bee5d\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/copy.js\":\"9b2952e576c0beef\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dailyPage.js\":\"eb46ea4e0e2b706d\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dbForensics.js\":\"085d7b69e05ad25e\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dbForensicsHooks.js\":\"30b2e4a3e05ca656\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/deleteBlockThroughUi.js\":\"ffbf3363d6abcdaf\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dialogs.js\":\"8a7f7fbcfbb99228\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dom.js\":\"98f090fa4a6b8778\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/downloadBlob.js\":\"22e24c64a5e837e9\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/drawnWalk.js\":\"83456cbf02436d37\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/exportSqliteDb.js\":\"b43da35af28625bf\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/fileSystemAccess.js\":\"62afad99619667b7\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/flipSlide.js\":\"8b05aa45e09c119a\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/fnv1a.js\":\"788a073e06f2ff85\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/formatBytes.js\":\"1a620ac9eee3972f\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/fuzzyRank.js\":\"9ee29ca5bbf3b404\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/idbKeyedStore.js\":\"dc496961724492bb\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/idleCallbackPolyfill.js\":\"80043e46ca762692\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/keyboardAwareScroll.js\":\"83c24a4f366a8c52\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/keyboardViewport.js\":\"a33dfa143606648a\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/lastWorkspace.js\":\"5a78b82f7407870a\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/layoutColumns.js\":\"58380a1fa3bfdf0f\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/layoutSessionDom.js\":\"d4998c3d0113d64e\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/layoutSessionId.js\":\"7bf83582528b985b\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/linkClickGestures.js\":\"ebcddbe51b6d70e8\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/linkTargetAutocomplete.js\":\"7c784f3d0dbdba5e\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/localDbCorruption.js\":\"57a3adc5d5ba8d93\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/localDbRecovery.js\":\"830409a6d1256ff9\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/markdownParser.js\":\"76506b421d90061f\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/memoize.js\":\"cbaf3b324df9e121\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/nameFieldCommit.js\":\"dacf7bf712b40339\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/nameList.js\":\"4efe0216621ac456\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/navigation.js\":\"f2ff6e9ceffe12b5\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/omnilinerNamespace.js\":\"a4f41797dc76fe1b\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/opfsPageScan.js\":\"25042a294d764c06\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelClearance.js\":\"9548633a3337ec8d\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelHistory.js\":\"6a74935fcd8fc4c9\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelLanes.js\":\"f2581b8fd143aaec\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelLayoutProjection.js\":\"998021c47dc2b7d3\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelScrollAnchor.js\":\"e811fd514d8be14f\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelUrlFlags.js\":\"9f23014d00a111fd\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/platform.js\":\"fef19f9946e17116\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/pluralize.js\":\"a82cda56dcb7c07e\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/propertyCreation.js\":\"4a5766c5fbfc8bf0\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/propertyNavigation.js\":\"fe5a8601d5a9c0a1\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/propertyValueContext.js\":\"50caa990dd99b915\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/react.js\":\"c4011d6a518d95b7\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/relativeDate.js\":\"c8ec38238cb46f74\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/relativeTime.js\":\"78e1164bef3c5d2c\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/renderScope.js\":\"465303214223b3fa\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/resolvedThenable.js\":\"78753cac83826172\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/routing.js\":\"8919e4971816e1eb\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/safeMode.js\":\"3ae750aa358a94ea\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/scheduleIdle.js\":\"8a4be958c1cc47aa\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/screenWakeLock.js\":\"dd0684a994c3693f\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/selection.js\":\"aa688edb7870c151\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/softKeyboardGrab.js\":\"9fde722af1c9cec0\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/startupTimeline.js\":\"c1d8881cd9728d56\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/state.js\":\"f8a2f0e10da9ea5e\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/string.js\":\"9b9c6cc30f1d93af\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/surfaceZoom.js\":\"7e9e60988c838bba\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/time.js\":\"e00b4f6d772e91ee\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/toast.js\":\"e8bbb0399cc78af0\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/toggleStore.js\":\"a4a9083de817b259\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/untilStopped.js\":\"d3ca5e66ef114afb\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/userActivity.js\":\"6d7d07e2c3c947f5\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/viewTransition.js\":\"6d4f2c8b4e35e05f\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/viewport.js\":\"a713937025fc3bf2\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/webLock.js\":\"b6e5c06af8e5b944\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/workspaceRecovery.js\":\"461cd13695d5a925\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/workspaceSnapshotStore.js\":\"5812677352f26afb\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-compiler-runtime.js\":\"e61444772d34f11a\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-client.js\":\"9d07235d8da0c64e\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-server-edge.js\":\"871a2813dc34c552\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-server.js\":\"35b13bae2869810a\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-static-edge.js\":\"af27c851772cc74f\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-static.js\":\"bf16140086e9a574\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-test-utils.js\":\"0c178dd1a93b1b45\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom.js\":\"cc6b4afd8cb74789\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-jsx-runtime.js\":\"374cf72bba4e307e\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react.js\":\"665f5f332e209f23\",\"/knowledge-medium/pr-preview/pr-1878/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1878/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1878/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
