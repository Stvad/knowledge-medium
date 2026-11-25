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
		buildId: "a90fefadf515-b343a37f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1878/\":\"e81063de023a03c5\",\"/knowledge-medium/pr-preview/pr-1878/index.html\":\"e81063de023a03c5\",\"/knowledge-medium/pr-preview/pr-1878/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1878/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1878/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1878/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1878/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1878/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1878/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/pr-preview/pr-1878/assets/FacadeVFS-BP4z860E.js\":\"3d5a2b9ea34a5ffb\",\"/knowledge-medium/pr-preview/pr-1878/assets/OPFSCoopSyncVFS-WR1UwWmc.js\":\"a8d2192c47465580\",\"/knowledge-medium/pr-preview/pr-1878/assets/OPFSWriteAheadVFS-DnC6rRgP.js\":\"d8442a0b7c7481c7\",\"/knowledge-medium/pr-preview/pr-1878/assets/wa-sqlite-CG9m7OEu.js\":\"fcd3045283516788\",\"/knowledge-medium/pr-preview/pr-1878/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1878/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1878/assets/wa-sqlite-async-Ccw-DntE.js\":\"b8d11ad527437d80\",\"/knowledge-medium/pr-preview/pr-1878/assets/worker-rdJalBy5.js\":\"d53c47020235efa6\",\"/knowledge-medium/pr-preview/pr-1878/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1878/chunks/app-DjHbCwY7.js\":\"bc131de3ef6fd3b1\",\"/knowledge-medium/pr-preview/pr-1878/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1878/index.js\":\"a6c209204753eb0c\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1878/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1878/assets/AccessHandlePoolVFS-CVYaN6it.js\":\"eddf95dcf2510471\",\"/knowledge-medium/pr-preview/pr-1878/assets/IDBBatchAtomicVFS-DyEYa82L.js\":\"d6ffa598acaaa764\",\"/knowledge-medium/pr-preview/pr-1878/assets/MemoryVFS-B3AcuQo1.js\":\"f2373b9ed9e873f8\",\"/knowledge-medium/pr-preview/pr-1878/assets/mc-wa-sqlite-5dS8NHvX.js\":\"367dde92f0b41af0\",\"/knowledge-medium/pr-preview/pr-1878/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1878/assets/mc-wa-sqlite-async-CQuFl8HU.js\":\"ff014ffe9c0b12a7\",\"/knowledge-medium/pr-preview/pr-1878/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1878/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1878/chunks/AccessHandlePoolVFS-DzR7361q.js\":\"13f0249e9bc3afae\",\"/knowledge-medium/pr-preview/pr-1878/chunks/FacadeVFS-o9JT7R7C.js\":\"60a1468811fb49d7\",\"/knowledge-medium/pr-preview/pr-1878/chunks/IDBBatchAtomicVFS-CBMeSPaJ.js\":\"9b56ef521ffbe350\",\"/knowledge-medium/pr-preview/pr-1878/chunks/MemoryVFS-ChD0uWXe.js\":\"b9252b6fb6d96106\",\"/knowledge-medium/pr-preview/pr-1878/chunks/OPFSCoopSyncVFS-DASg-2mU.js\":\"6eb200f985ae9727\",\"/knowledge-medium/pr-preview/pr-1878/chunks/OPFSWriteAheadVFS-BMFUO02x.js\":\"bac5dc3092d13ef6\",\"/knowledge-medium/pr-preview/pr-1878/chunks/Preview-CjFGx2Yf.js\":\"abc428ad4934fd7e\",\"/knowledge-medium/pr-preview/pr-1878/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1878/chunks/card-BkdIA_1j.js\":\"fd82c9ada51325a5\",\"/knowledge-medium/pr-preview/pr-1878/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1878/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1878/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1878/chunks/dist-CMtqcbi0.js\":\"4caafc6b33158e65\",\"/knowledge-medium/pr-preview/pr-1878/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1878/chunks/mc-wa-sqlite-04vX3MPv.js\":\"bdedcce2d6176734\",\"/knowledge-medium/pr-preview/pr-1878/chunks/mc-wa-sqlite-async-DknR3gpr.js\":\"3235de55f99abbcf\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-BLRn9dci.js\":\"e2adf54c9c5b3993\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-Bsr15equ.js\":\"e95e1cc48e7ab6d6\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-CL-6f7x2.js\":\"69c37c17640fee38\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-CRMc9EvS.js\":\"d394b9efea142fbe\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-ChEG7MXD.js\":\"ff479580f81752bc\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-DIWzCDUf.js\":\"fc642ec0f6b29e6e\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-DIzVUj2e.js\":\"0f4e6839db2908b1\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-Y3uLDEEb.js\":\"a2e21ad630353c62\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-dom-server-legacy.browser.production-DOwMI3wm.js\":\"fdfca5f522391e8c\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-dom-server.browser.production-DvBfrpkg.js\":\"d593cd4b6312bf8b\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-dom-server.edge.production-GXajWYC9.js\":\"13947cecf21fe91c\",\"/knowledge-medium/pr-preview/pr-1878/chunks/server.browser-BDsaU9WB.js\":\"74c4d1da80358786\",\"/knowledge-medium/pr-preview/pr-1878/chunks/textarea-C238NWEY.js\":\"907df587b5c0b48a\",\"/knowledge-medium/pr-preview/pr-1878/chunks/ui-Cea6W9vH.js\":\"552a1a443f38996d\",\"/knowledge-medium/pr-preview/pr-1878/chunks/wa-sqlite-KSFBpJFU.js\":\"787190150c411d8f\",\"/knowledge-medium/pr-preview/pr-1878/chunks/wa-sqlite-async-zHq4BaBg.js\":\"a90508ff9949d480\",\"/knowledge-medium/pr-preview/pr-1878/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1878/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1878/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1878/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1878/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1878/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1878/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1878/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1878/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1878/src/App.js\":\"341d013c450a4989\",\"/knowledge-medium/pr-preview/pr-1878/src/appUpdate.js\":\"872b38e09d52a874\",\"/knowledge-medium/pr-preview/pr-1878/src/appVersion.js\":\"6dfe155d6212fbcd\",\"/knowledge-medium/pr-preview/pr-1878/src/bootstrap/initialLayout.js\":\"b3311406855f398a\",\"/knowledge-medium/pr-preview/pr-1878/src/bootstrap/openWorkspaceData.js\":\"881ac054a9cf1520\",\"/knowledge-medium/pr-preview/pr-1878/src/bootstrap/resolveWorkspace.js\":\"8d1bd4c4e5304223\",\"/knowledge-medium/pr-preview/pr-1878/src/bootstrap/workspaceBootstrap.js\":\"025a04e7a97f3a91\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockComponent.js\":\"2233b7fe2cfa7aa7\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockCrumbs.js\":\"2f0e882fefa32acd\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockEditor.js\":\"70cc27bfaf244003\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockLoadingPlaceholder.js\":\"b0bacf44a5e5a9f6\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockProperties.js\":\"05ac47559fbbff77\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockSearchPicker.js\":\"ee2372369c5c7275\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ConfirmBulkDeleteDialog.js\":\"40906706fd9cc236\",\"/knowledge-medium/pr-preview/pr-1878/src/components/DividerHandle.js\":\"f8d22b70824d08e7\",\"/knowledge-medium/pr-preview/pr-1878/src/components/DraftEditor.js\":\"145363e5fae16c52\",\"/knowledge-medium/pr-preview/pr-1878/src/components/GutterPill.js\":\"95de7ec798f06ffd\",\"/knowledge-medium/pr-preview/pr-1878/src/components/Header.js\":\"a366521305aa80dd\",\"/knowledge-medium/pr-preview/pr-1878/src/components/LazyBlockComponent.js\":\"7f53645d9bd9cee6\",\"/knowledge-medium/pr-preview/pr-1878/src/components/Login.js\":\"8edba42f334b1f96\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ZoomableSurface.js\":\"1950afad951e4321\",\"/knowledge-medium/pr-preview/pr-1878/src/components/editModeKeepalive.js\":\"82cb5437dd231c1b\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e25d24add529588c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3a0ce9577db6028e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/RefPropertyEditor.js\":\"2537cf1c7368b7e2\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/RefTargetTypePicker.js\":\"a0bb7382de0538d1\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/SelectPropertyEditor.js\":\"8a397d86d0a99666\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/TypesPropertyEditor.js\":\"6a50ef62e49b40a0\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/defaults.js\":\"50ce3d92e6a5b527\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/kernelValuePresets.js\":\"c435f8f142ca53f0\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/selectablePresets.js\":\"06dc42337aa729a1\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/typesPropertyUi.js\":\"7ceaaddcc5d0bc36\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/AddPropertyForm.js\":\"1e68b3cee4c92091\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/PropertyPicker.js\":\"a3bdb69e2e55a8b4\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/PropertyRow.js\":\"fc8e0bca44870652\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/Rows.js\":\"0b254ba0ccf80519\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/actions.js\":\"fe7e363341a52941\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/declarationOnly.js\":\"4a93d80525ef15ff\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/layout.js\":\"ffba65a3c6e26012\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/model.js\":\"243f6b0289a124ff\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/shapeUi.js\":\"84c74bcccc67ed97\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/shapes.js\":\"5c6b7e3822229271\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/usePropertyEditingActivation.js\":\"71e5403f7b7aede0\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/visibility.js\":\"4687bbb227466579\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanelSections.js\":\"9ee33f830c6e41af\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/BlockEmbed.js\":\"a23dac7eea374101\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/BlockLink.js\":\"c3feaa7dee49e80e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/BlockRef.js\":\"a9de92b455832a40\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/ReferenceLink.js\":\"563c347911755a88\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/cycleGuard.js\":\"f179905bfc5beafb\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/cycleGuardContext.js\":\"01b3997e2b15651d\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/linkInteraction.js\":\"19910285f58779df\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/referenceLayout.js\":\"4349c80262fad8b4\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/useBlockRefAncestors.js\":\"3d5b3f931d3dffde\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/BlockGutter.js\":\"bd448f37d3715cf8\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/BlockInfoDialog.js\":\"33119c6c2379c144\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/BlockTypeBlockRenderer.js\":\"41ef90956adfdf94\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/BulletHoverCard.js\":\"2384727e43c40aa6\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/CodeMirrorContentRenderer.js\":\"27a65f467a2bfc2b\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b5e0290f72d74616\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/ColumnResizeHandles.js\":\"1bde1cdfe68d57e4\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0e937911b09d3c01\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/DefaultBlockRenderer.js\":\"a08bfa5ff6f39cd2\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/LayoutRenderer.js\":\"30d2ae445b78f8af\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/MarkdownContentRenderer.js\":\"6ae9155b17b6305c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/MissingDataRenderer.js\":\"d478532d2ba32718\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/PanelRenderer.js\":\"fccd2fe4d55b4ab3\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d3eb9b17203d0185\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/TopLevelRenderer.js\":\"5b05d8310c408aa5\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/blockGutterMode.js\":\"c4a8709e935f1df8\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/blockTitleText.js\":\"78b096396a71f63e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/fieldCreationKeydown.js\":\"d3e6322a99d48318\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/layoutRootContext.js\":\"0da3ef29a13841c3\",\"/knowledge-medium/pr-preview/pr-1878/src/components/typeChip/TypeChip.js\":\"cfc7ff8586eb61bf\",\"/knowledge-medium/pr-preview/pr-1878/src/components/typeChip/chipStyle.js\":\"fa1c3db11f5d5a63\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/anchored-floating.js\":\"76cff8980ec951f6\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/button.js\":\"8b68d4153a71681f\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/card.js\":\"7454e4ad7f3ce94d\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/checkbox.js\":\"3cce31a68db7f7b0\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/collapsible.js\":\"eb36c7f1cc07c4d5\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/command.js\":\"cd095f8ee3074ec9\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/context-menu.js\":\"0ab030e1c1a01772\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/dialog.js\":\"680f7eec19f825e7\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/dropdown-menu.js\":\"526f2a825bae8652\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/floating-listbox.js\":\"83fd12026bfd24a2\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/index.js\":\"18419914748e5be7\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/input.js\":\"674220611d4e8754\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/kbd.js\":\"2fa46ab5cdf05512\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/label.js\":\"37143d35ed983789\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/textarea.js\":\"b850163635af74a9\",\"/knowledge-medium/pr-preview/pr-1878/src/components/useEditModeYieldKeepalive.js\":\"13353d90b4402c50\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/BootFallback.js\":\"ed7e552b1db57e19\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/FocusedRowLazyMount.js\":\"a7821b25b4155b92\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/LazyViewportMount.js\":\"873f95967cb1381c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/LocalDbCorruptionFallback.js\":\"c4ad638dac9f0457\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/error.js\":\"01eb7d5b63befceb\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/lazyMountRegistry.js\":\"8e550044bfe13d07\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/suspense.js\":\"6e85d66eb7ab286e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/CreateWorkspaceDialog.js\":\"51605f30603d2e3d\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/PendingInvitations.js\":\"54c81180aacad8f7\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/SyncProgress.js\":\"6cfeb21336a308f6\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/UnlockProgress.js\":\"01f605472c49e604\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/WorkspaceKeyGate.js\":\"e840a8669ab47da7\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/WorkspaceSettingsDialog.js\":\"4c918678fbbb082b\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/WorkspaceSwitcher.js\":\"3d58fecd813dbb5e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/WorkspaceSyncGate.js\":\"c05f1183d5dccadb\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/ConversionFlow.js\":\"258ca3e3bcedca48\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/ConversionFlowHost.js\":\"4b0681c3f33d4eb1\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/EncryptionSection.js\":\"850a0d7bbe951c20\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/attachmentPrompts.js\":\"25c6f85ef5a1c81d\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/bundleFolderPrompts.js\":\"7e834940c597cda0\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/conversionFlowDeps.js\":\"405cdbb450e04b27\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/conversionFlowStore.js\":\"d4f081935a0e2668\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/flowUi.js\":\"9d88567d7b14627c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/useConversionRun.js\":\"40d258cba842531c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/keyUi.js\":\"be5b0c2333ba87b3\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/useCloseOnKeyLoss.js\":\"f2edd53cbc631ed2\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/useCloseOnServerE2ee.js\":\"4f022bd69c971adc\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/workspaceUnlocked.js\":\"1112a5d4517de5a8\",\"/knowledge-medium/pr-preview/pr-1878/src/context/backgroundSubtree.js\":\"f9c72173e824f88f\",\"/knowledge-medium/pr-preview/pr-1878/src/context/block.js\":\"a767bdb8415f4ebb\",\"/knowledge-medium/pr-preview/pr-1878/src/context/layoutWsContext.js\":\"88f497c5a9dcae82\",\"/knowledge-medium/pr-preview/pr-1878/src/context/propertyDisplay.js\":\"589843413e31462d\",\"/knowledge-medium/pr-preview/pr-1878/src/context/repo.js\":\"21f9d33e021fb78d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/aliasClaim.js\":\"cee102f579384ad5\",\"/knowledge-medium/pr-preview/pr-1878/src/data/aliasSeatNamespace.js\":\"db0d13ad8eaf9e43\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/blockData.js\":\"e0b04b1b35578c38\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/blockType.js\":\"6e0d6fdaade27e33\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/changeScope.js\":\"92917f5cd867e656\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/codecs.js\":\"62e33ad01deda14d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/derivedData.js\":\"cf312fd8abed4ea7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/errors.js\":\"4985233e5c4bac58\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/events.js\":\"afa129cb2dea03f6\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/handle.js\":\"37f8177daf72b7f4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/index.js\":\"43004e9be27b6a92\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/mutator.js\":\"d5512f708945fca3\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/processor.js\":\"6b87d48abad1d9ff\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/propertySchema.js\":\"9810355bc1bcd0bf\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/query.js\":\"d6a82a28093aff08\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/sameTxProcessor.js\":\"99bb83b516829f84\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/schema.js\":\"37f8177daf72b7f4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/tx.js\":\"37f8177daf72b7f4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/typedBlockQuery.js\":\"a12ee40125f73e58\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/user.js\":\"de2e12d078c11b31\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/valuePresetCore.js\":\"fbbdd523f1111a49\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/valuePresets.js\":\"fc7dc8c5f28faa71\",\"/knowledge-medium/pr-preview/pr-1878/src/data/attachmentCleanerIOVerb.js\":\"3ad40d0f1ebc4604\",\"/knowledge-medium/pr-preview/pr-1878/src/data/block.js\":\"c5432aad58af938b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockCache.js\":\"cdd6799f15f73fe7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockId.js\":\"13ef685c921e5260\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockLiveness.js\":\"bfe71f9327f355b2\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockMerge.js\":\"017b84b4e97c0fb1\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockSchema.js\":\"ab043990be17ce67\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockTypeLookup.js\":\"16dbf8516516e35a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockTypes.js\":\"dcd2364c6dccb72e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/childrenView.js\":\"3081c5e3236cf6d8\",\"/knowledge-medium/pr-preview/pr-1878/src/data/clientContext.js\":\"3d26bdf2240d8cb7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/comparableRefTarget.js\":\"9af052dbc4613c19\",\"/knowledge-medium/pr-preview/pr-1878/src/data/dbFileSiblings.js\":\"dbd054391cf748c2\",\"/knowledge-medium/pr-preview/pr-1878/src/data/definitionSeeds.js\":\"26e45a40fdb31d17\",\"/knowledge-medium/pr-preview/pr-1878/src/data/derivedIds.js\":\"96d562ffd7698fe5\",\"/knowledge-medium/pr-preview/pr-1878/src/data/drawnSubtree.js\":\"fb27489df97ceb95\",\"/knowledge-medium/pr-preview/pr-1878/src/data/facetBridge.js\":\"93f51e3e60eb1d63\",\"/knowledge-medium/pr-preview/pr-1878/src/data/facets.js\":\"a83131284bb5df51\",\"/knowledge-medium/pr-preview/pr-1878/src/data/globalState.js\":\"c95820e77a31839a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/aliasClaimRederiveProcessor.js\":\"913fdde9ae761474\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/ancestorBatch.js\":\"d569ef674276ac44\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/blockTypeTypeifyProcessor.js\":\"ea1cad2c8662c8bb\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/clientSchema.js\":\"03376d32f52f6ad9\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/commitPipeline.js\":\"4d356eb5b1f14088\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/devAssertions.js\":\"e471d1bbe518f3a6\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/firstSync.js\":\"f8bbb8ec1c1f534d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/freshInitialLoad.js\":\"5f7850d7afc6233e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/graphBackfillClaim.js\":\"0f27ea36a908275c\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/handleStore.js\":\"0b80f28e8be978b6\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/idleMarkerJobs.js\":\"42ea0850fe042e5d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/initialDownload.js\":\"107b24a56df5c033\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/initializeClientDatabase.js\":\"2b5174ca9e5876f6\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/jsonCanonical.js\":\"b9ef6ae19cdc0221\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/kernelInvalidation.js\":\"bdce0556919ecc57\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/kernelProcessors.js\":\"cbab7cc51db71f05\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/kernelQueries.js\":\"aebb8897f1713f53\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/mergeTypeMembershipProcessor.js\":\"67ada27801e83f06\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/normalizeReferencesProcessor.js\":\"f1083520eb49bcb0\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/poolInstrumentation.js\":\"4fb7e3d9cdf1bfac\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/processorRunner.js\":\"0e6ffc304ad89599\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyCellBackfill.js\":\"9a30fc386b54c7b2\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyChildMint.js\":\"ef4ac064ce151ac4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyChildrenProcessor.js\":\"435b9afd90582b1b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyDefinitionChangeProcessor.js\":\"1ffd25935b3addc2\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyDefinitionSynthesis.js\":\"aff063dff9357f0f\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyKeyScan.js\":\"7f123bec481b1049\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertySchemaResolution.js\":\"3438b42c23c620ed\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyValueEdits.js\":\"93395f22fa2cb430\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/raiseProtocol.js\":\"dc607e28c60bcf2b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/readBatch.js\":\"c0e72f7de9807934\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/refProjection.js\":\"278675e9062a0eb8\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/referenceTargetLookups.js\":\"19d66c33c29ee9be\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/referenceTargetProcessor.js\":\"036011486da18fb7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/replayMerge.js\":\"7edc4071dce3f714\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/sqlBinds.js\":\"ba6a96b7df2d08df\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"85249739f36f275c\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/arrivalProcessors.js\":\"3d0a0a3731ee7dd7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/invalidate.js\":\"014d7cc7cede8844\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/materialize.js\":\"69d235ebca75c76c\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/observer.js\":\"93c67db8a5c87c1f\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/reconcile.js\":\"f61b7fca94b90be4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/timingMetrics.js\":\"b73622ed69d7273c\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/treeQueries.js\":\"dff26433eabba5b4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/txEngine.js\":\"b10a55b0d53f90f6\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/txSnapshots.js\":\"eae82c1637028fb0\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/typedBlockQuery.js\":\"1268bbd1c97ee753\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/undoManager.js\":\"5ac6927f912aae01\",\"/knowledge-medium/pr-preview/pr-1878/src/data/invalidation.js\":\"affd648bf1bfaf2f\",\"/knowledge-medium/pr-preview/pr-1878/src/data/kernelDataExtension.js\":\"fe5ca95eb7fc59dc\",\"/knowledge-medium/pr-preview/pr-1878/src/data/kernelPage.js\":\"c710cdfbbbfc6877\",\"/knowledge-medium/pr-preview/pr-1878/src/data/kernelValuePresetCores.js\":\"64f477eec9bbac65\",\"/knowledge-medium/pr-preview/pr-1878/src/data/localDbCorruptionSignal.js\":\"221be35cae191284\",\"/knowledge-medium/pr-preview/pr-1878/src/data/localDbStorage.js\":\"9454221e19e1e599\",\"/knowledge-medium/pr-preview/pr-1878/src/data/localDbVfs.js\":\"1b51622c3978f53e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/localSchema.js\":\"c59aa24f9792a850\",\"/knowledge-medium/pr-preview/pr-1878/src/data/maintenance.js\":\"e2451ebd3eb27bef\",\"/knowledge-medium/pr-preview/pr-1878/src/data/mergeProperties.js\":\"6d2ad22df539627b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/metricsConsoleHook.js\":\"d0b5ef77dbbdef3e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/migrationsPage.js\":\"ebadcd7960e9aefe\",\"/knowledge-medium/pr-preview/pr-1878/src/data/mutators.js\":\"f731fb2a8bc0d5cc\",\"/knowledge-medium/pr-preview/pr-1878/src/data/orderKey.js\":\"c3fe1965b1d97074\",\"/knowledge-medium/pr-preview/pr-1878/src/data/orderKeyPlacement.js\":\"431b117692ee979b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/outlineSurface.js\":\"b8f264c8349d1939\",\"/knowledge-medium/pr-preview/pr-1878/src/data/pendingEditorContent.js\":\"33da50b5fea92c8c\",\"/knowledge-medium/pr-preview/pr-1878/src/data/pendingUploadsSql.js\":\"d13a285050a8c082\",\"/knowledge-medium/pr-preview/pr-1878/src/data/pluginStateExtensions.js\":\"693ebbcc1674ddd6\",\"/knowledge-medium/pr-preview/pr-1878/src/data/powerSyncLogger.js\":\"2950792b0855ec76\",\"/knowledge-medium/pr-preview/pr-1878/src/data/projectorRuntime.js\":\"2608d698f58df2b4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/properties.js\":\"9ed1dad7f18cd1af\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertiesPage.js\":\"0ec92661748293bb\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyChildren.js\":\"6bd60b2d0ac7670e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyDefinitionFanout.js\":\"2d75d0fc799ac872\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyDefinitionMetadata.js\":\"dd2ece6efe449175\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyDefinitionRegistry.js\":\"477f545e310168de\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyDisplayMode.js\":\"f94da9cc968923a2\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyRowCreation.js\":\"ebfeebd341f267eb\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertySchemaCreation.js\":\"19c8991a97341e09\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertySeeds.js\":\"8637534c88e0cdc6\",\"/knowledge-medium/pr-preview/pr-1878/src/data/recentsPage.js\":\"a8d289711ab479a0\",\"/knowledge-medium/pr-preview/pr-1878/src/data/referenceBlock.js\":\"64f4962a3cf10d85\",\"/knowledge-medium/pr-preview/pr-1878/src/data/rejectedUploads.js\":\"2438df67496fd40b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/releasePowerSyncConnection.js\":\"6d2652839d70570d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/repo.js\":\"9f3361ee472bc767\",\"/knowledge-medium/pr-preview/pr-1878/src/data/repoProvider.js\":\"7d0c52feb7c90e19\",\"/knowledge-medium/pr-preview/pr-1878/src/data/rowProperty.js\":\"8f587d1e38f033dd\",\"/knowledge-medium/pr-preview/pr-1878/src/data/searchFilter.js\":\"2f1d4aaa0b0ac899\",\"/knowledge-medium/pr-preview/pr-1878/src/data/seedIdentityLedger.js\":\"5ec588edb84f9151\",\"/knowledge-medium/pr-preview/pr-1878/src/data/stateBlocks.js\":\"b87f4a69a547b5cf\",\"/knowledge-medium/pr-preview/pr-1878/src/data/structuralEditPolicy.js\":\"94b590c99b8eaa4a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/structuralInsert.js\":\"4e7267d1abb60ebe\",\"/knowledge-medium/pr-preview/pr-1878/src/data/subtreeDelete.js\":\"75bc526737a021dc\",\"/knowledge-medium/pr-preview/pr-1878/src/data/syncStreamLock.js\":\"956472fdee392127\",\"/knowledge-medium/pr-preview/pr-1878/src/data/syncedTableSqlRecognizer.js\":\"bc9f6ba2257c5ed7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/syncedTableWriteGuard.js\":\"119e61ac11cb490b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/targets.js\":\"e658568242a855df\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeColors.js\":\"5cf2da0e6f825e52\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeDefinitionMetadata.js\":\"da50cd425b86bdd0\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeDefinitionRegistry.js\":\"24e89db6733d2f69\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeExtraction.js\":\"9255772ad579463b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeInitialValues.js\":\"869be24b97dd4b01\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typePropertyGroups.js\":\"390e7ecfa8d8dcd2\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeSeeds.js\":\"3ad4699d8451f1d4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeTagger.js\":\"33f34291d54db1cd\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typedRecords.js\":\"6a2fb542361b805c\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typesPage.js\":\"196dc16ba9f30bcf\",\"/knowledge-medium/pr-preview/pr-1878/src/data/userPrefs.js\":\"168a8560fd637c3d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/userSchemasService.js\":\"1cd6c0e6a8023aec\",\"/knowledge-medium/pr-preview/pr-1878/src/data/userTypesService.js\":\"376c996835de304c\",\"/knowledge-medium/pr-preview/pr-1878/src/data/valuePresetRegistry.js\":\"d0875acfe8ed39c4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/visibleChildren.js\":\"080fd521c2e7f9e1\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaceConversion.js\":\"517cbec087451a26\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaceFirstSync.js\":\"d1411c694296c597\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaceIdNamespace.js\":\"ee92075da97dd9fe\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaceSchema.js\":\"f54fd38170a76c35\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaces.js\":\"9647878bb6702c95\",\"/knowledge-medium/pr-preview/pr-1878/src/data/writeAheadLog.js\":\"65b7464b8c5fba9a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/BlockPasteShellDecorator.js\":\"075278822b1b9a29\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/atTrigger.js\":\"2fad18d4f5eb56fb\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/autocomplete.js\":\"fb032f779dd5831e\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/codeMirrorExtensions.js\":\"d3bad4829e3fa11d\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/contentFlush.js\":\"eb84a47f75c7ac3d\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/defaultInteractions.js\":\"35a14f0e7c66dec7\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/editSettleSignal.js\":\"9cf3a7aafed7efdf\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/insertImage.js\":\"bf6f72f577619364\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/referenceCompletionRange.js\":\"099c254e88d8f85f\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/referenceTargetTypes.js\":\"2f3373e8cab918ee\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/syntaxContext.js\":\"fc31d510619f22bd\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/triggerMatch.js\":\"25747ee330254471\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/AppRuntimeProvider.js\":\"d5763b8e8a46028a\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/BlockFocusShellDecorator.js\":\"e77c75867d492fa6\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/ExtensionRenderBoundary.js\":\"57b1fb5e154879d7\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/PanelContentRecovery.js\":\"8ddb9a0d20ae209a\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/apiCatalog.js\":\"d03d7ec12532a8de\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/approveExtensionHere.js\":\"a72ec725fc9120e8\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/armedCutAppMount.js\":\"54730fc7c5f2deb0\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/batchableKeyedStore.js\":\"704de5cdcacf5cce\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/blockInteraction.js\":\"2263e60a18b4f81e\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/blockSelectionAction.js\":\"25e1518908fa1c1b\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/compileExtensionModule.js\":\"6411f319f60f2061\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/compiledModuleCache.js\":\"5662c0db2ae88e30\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/continuousGestures.js\":\"26697d493fb2759d\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/core.js\":\"63e43068bb9c8431\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/defaultRenderers.js\":\"2a3a22393ce81a4f\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/definitionFanoutAppMount.js\":\"e96f33e64ad3dbd9\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/dialogAppMount.js\":\"5af82b656f662e6b\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/dynamicExtensionSeeds.js\":\"0be46adce15a72e4\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/dynamicExtensions.js\":\"0c2718ffc447e465\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/exampleExtensions.js\":\"a4290e19a6eed611\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionApprovalStatus.js\":\"e0e51139a1a6ea3f\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionLoadErrorToast.js\":\"03ea1b103678f9ff\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionLoadErrors.js\":\"dc87e0fba2e3e805\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionLookup.js\":\"f447c22bd564deea\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionToggles.js\":\"4ef9a41380053f4c\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionUtilitiesCss.js\":\"3316d4206fa99804\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/kernelPageDeletionGuard.js\":\"911766ff5ea89ea5\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/liveRuntime.js\":\"28ea650fa0f564c2\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/openExtensionsSettings.js\":\"4b86069a51740a35\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/overridesCache.js\":\"047e6b2c8bd6446f\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/pluginIds.js\":\"0212b6f95122f26f\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/processorRejectionToast.js\":\"fa74e9df5904dc62\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/runtimeActions.js\":\"d6e83c7be7634e35\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/runtimeContext.js\":\"9f83e478ee0498be\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/staticAppExtensions.js\":\"9e5badd77d557960\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/staticDataExtensions.js\":\"ee88ee06175c59e3\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/toastAppMount.js\":\"befa84160b4d71cf\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/useOverrides.js\":\"8910c77f4220d7b2\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/useShortcutSurfaceActivations.js\":\"2e734fdedd2dd49b\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/discoverToggleTree.js\":\"d0bccb9daed6c272\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/facet.js\":\"7d3ecccec0c7e6ad\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/resolveAppRuntime.js\":\"0e45393c07af724c\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/runtimeEvents.js\":\"7b084de179fc678a\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/togglable.js\":\"475167f10f400e3e\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/variantFacet.js\":\"6d53d9ae25da0c0d\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/verbFacet.js\":\"a6e444d8d5a4ea66\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/block.js\":\"d7a1cb140fa2a8cd\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/focusedChild.js\":\"04117530f634b01a\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/propertySchemas.js\":\"4bf0cfeaf05c890b\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/typeRegistry.js\":\"611828baf621cc41\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useAncestorCrumbs.js\":\"877f5d7309ddd2cc\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useAutocompleteListbox.js\":\"e5e74b955695eb6a\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useDebouncedSearch.js\":\"98cd36aeb3e07271\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useDebouncedValue.js\":\"78a535057a97f5a6\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useIsFocalRender.js\":\"e3f0016c2cf68194\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useIsReadOnly.js\":\"251286cbc531fbc0\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useMaterializeBacklog.js\":\"1cb51830abb8add6\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useMinuteClock.js\":\"c233c69553975df1\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/usePanelLayoutProjection.js\":\"9bcc2e3a9affd2e6\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/usePendingInvitations.js\":\"3deccf9b8bc00382\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useRendererRegistry.js\":\"541a5309ad08419b\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useRetainedFieldRows.js\":\"0aa8d603ac5141e4\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useWorkspaces.js\":\"9b29052d8ae8c0a8\",\"/knowledge-medium/pr-preview/pr-1878/src/lib/utils.js\":\"02369a384aa2008f\",\"/knowledge-medium/pr-preview/pr-1878/src/main.js\":\"cecd58ac5f38fe4f\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/MarkdownImage.js\":\"a429e83194ae3b50\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/blockSeparators.js\":\"c2d5f1ccec0d211c\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/context.js\":\"aa21aebb1f7fd624\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/defaultMarkdownExtension.js\":\"b8082ae3de0f2212\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/extensions.js\":\"a7350161b51aa3f0\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/renderMarkdownHtml.js\":\"355a960a87703aa0\",\"/knowledge-medium/pr-preview/pr-1878/src/minimal-editor.js\":\"c5ebaf0907123d65\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/armedCut.js\":\"8c0c1c374391a66a\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/captureMediaVerb.js\":\"b1068d958bc0c543\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/clipboard.js\":\"6d8c2a22ccd06d7f\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/decision.js\":\"fe291da55ba39411\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/operations.js\":\"68e35b14ed3796ff\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/account-header/AccountHeaderItem.js\":\"c424adda40e6e83b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/account-header/index.js\":\"45d7f2dcdd576e54\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"30323dcb57243fa0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/askAgent.js\":\"f2e6cad48fa42c04\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/askedStore.js\":\"c640e7f6f271ca61\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"cabc1c8a00b83576\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/chipState.js\":\"37638c1cd266c5aa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7bd97a20bd466373\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/index.js\":\"08c181993355648d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9d2993cc0ed03134\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/schema.js\":\"24bbb583a3b0589c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/AgentTokensDialog.js\":\"dbe376b10d112cf3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/BridgePairingDialog.js\":\"e1ec6776f7750456\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/addMedia.js\":\"99f3cfc3c1ce34c9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/backlinks.js\":\"738cd244930bd4dc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/block.js\":\"6a60432198c26f66\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/context.js\":\"57ca7a2b926de9d9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/displayIds.js\":\"11060d9545e2b68b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/index.js\":\"6016cefcfa1b9b84\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/outline.js\":\"b66ecf4b459451d6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/properties.js\":\"68af0bd1a0c0f881\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/refs.js\":\"99bba163a561a767\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"69535cfac3e326ba\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/search.js\":\"a43eef87cd5afbbd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/shared.js\":\"95fe7809a9c8e9d2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"39e1f3cc24171f61\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/text.js\":\"e49a606d8bb077b9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentWrites.js\":\"536dc8932f98eaf2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/authoringCatalog.js\":\"83f2153a307d0667\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/blockRefTargets.js\":\"1d29d946dd4cfaf8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/bridge.js\":\"259d5cb5cebc6ea5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/bridgeLoop.js\":\"16b3c78e220f1cd4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/changeHistory.js\":\"d9f29c87e716f65b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/commands.js\":\"b6ba0a802190faca\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/commentsCommands.js\":\"b9eb94405ad364d3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/dataExtension.js\":\"8848dd52dfbfd746\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/dataModelGuide.js\":\"dc7a9caa99ff7479\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/describeRuntime.js\":\"99a5fcf59eb0ed09\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/extensionLint.js\":\"b3bf48dc28804693\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/grainAudit.js\":\"f406f38eb958b8be\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/healthCommand.js\":\"8f0f74df8b338c6d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/index.js\":\"326057cf76c3110d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/presetIdentity.js\":\"7ed10805be99a525\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"269fa057eacd34db\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/readMedia.js\":\"6f526cfd7113ca55\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/schema.js\":\"3f6ce30e8a08b435\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/serialization.js\":\"239a5929f92a6510\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/targets.js\":\"232ae5360360d222\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/tokens.js\":\"cc42ea0e21b215cf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/watchEvents.js\":\"79f11d9d15a898ee\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/workspaceGuard.js\":\"8045b046768ff3d3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/writeCommands.js\":\"4143d0fe26d67340\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/AliasCollisionToast.js\":\"ec91ad8aa9de91db\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/DuplicateNameBanner.js\":\"9d9eee980b6bd8cc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/collisionMerge.js\":\"6cd8b49686689ceb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/dataExtension.js\":\"ae476a461b31b9a6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/index.js\":\"392f1b53d974bbd0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/mergeCollisionAction.js\":\"6f7c872cfc1473a6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/pageStyling.js\":\"aa015af1228c8482\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/rejectionToast.js\":\"3161533af8fa92b9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/syncProcessor.js\":\"e430d3282fe9ab38\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/actions.js\":\"f3aa865ff1bf7cdd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/addComment.js\":\"5b33324701e6beaa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/anchor.js\":\"93117cf23925cd2f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/anchorState.js\":\"310ea8125533b134\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/commentLinks.js\":\"243214419b15b7c6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/confirmThreadDeletion.js\":\"c815146d7418c1d4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/container.js\":\"5dc97b211d047942\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/dataExtension.js\":\"1f658e40cd76117c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/deleteComment.js\":\"548d2f38afe73459\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/highlights.js\":\"0687af2e6706c954\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/index.js\":\"1e898a20aa8da1f6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/linkedCommentsPill.js\":\"29bd290fbee2e31c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/margin.js\":\"171d145db4f983a7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/marginAnchorLinks.js\":\"717e7ab64ab7bad5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/marginSchema.js\":\"fab7fc91df53b91c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/newComment.js\":\"9ecd34cea1a6b268\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/ownThreadPicker.js\":\"e0ab7326f7b078fa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/placement.js\":\"d68567ed20919799\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/queries.js\":\"2b7092ca8af881ef\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/quotePosition.js\":\"7735da8c6c84dc39\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/quotedIn.js\":\"a483d5c5b5d26dc3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/quotedRange.js\":\"e02e2e391995c32c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/rangeRefs.js\":\"31d11fb0d8005f06\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/readHighlights.js\":\"e673abe601d40cbb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/readSelection.js\":\"bb4b2837a9926e68\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/readSelectionUi.js\":\"bc73d7bcb6eb8223\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/reanchor.js\":\"92bb7ec92d17dbc8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/schema.js\":\"46efa2d2f74e6c36\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/scope.js\":\"acb717b4f191614f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/scopeThreads.js\":\"4360efb96cb3123a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/splitRetarget.js\":\"1eec31b7a335754a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/suggestionCard.js\":\"d61afb52fbc8600a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/suggestions.js\":\"de0b6b753174072d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/summaries.js\":\"c7f625bc2e278ce1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/summaryBatch.js\":\"494172796697faa7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/surface.js\":\"53e77c23cad4394e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/threadNavigation.js\":\"afaa26502d01e0af\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/threads.js\":\"85858ebf1dd266ca\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/ui.js\":\"4adb92cfd833ce31\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/uiStore.js\":\"ff2992bb1a2cd5d1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/app-intents/appIntents.js\":\"43e52d91699c95d2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/app-intents/index.js\":\"8b8149b1fae39299\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/app-update-prompt/index.js\":\"349dee14a79ed116\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/app-update-prompt/status.js\":\"88006e383cde9ed6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"67e44b61503b5a4d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/MediaBlockRenderer.js\":\"1b37d0cd8559d032\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/MediaDownLaneReplicator.js\":\"90bb30568e18e701\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/MediaUploadReconciler.js\":\"0384043fffac4a52\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/assetDownLane.js\":\"8567e0717c004aaa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/assetResolver.js\":\"bc42f027c6968fd6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/assetUpload.js\":\"38105966a636e32c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/attachmentCleanerIO.js\":\"6b6275f240c1884f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/supabaseAuditIO.js\":\"a73edc2ea83b4d66\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/blobStore.js\":\"82f8ff4502bc9220\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/browserMedia.js\":\"c9022584fb3f7b03\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/byteStore.js\":\"7bcc7eb55889887d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/cleanerIO.js\":\"b19518d4b01afbe9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/cleanupAttachments.js\":\"caf4f887c0b9eda6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/dataExtension.js\":\"34a6846a95754a12\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/downLane.js\":\"c370700f7f4e29c1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/index.js\":\"daf2e987511987f0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/insertImageContribution.js\":\"798539671af87607\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/laneArming.js\":\"f29b1beab47bbf8e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/laneLock.js\":\"be4ee28f7b0a84af\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaBlock.js\":\"7df2b174e9cb8f8b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaCapture.js\":\"d12a4e2db2d49315\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaLanes.js\":\"5ae6d6cb2db642b3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaViewers.js\":\"f6293c68c7ff01c1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaViewersFacet.js\":\"b5825225f9c92276\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/pasteCapture.js\":\"90ba13d33872a8c5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/resolver.js\":\"c6229af506ee3b84\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/retryUploadsAction.js\":\"ada61939f1992f0e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/storagePaths.js\":\"bae1d0bc049ab667\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadDrain.js\":\"f88f4c07de2b2760\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadLaneStatus.js\":\"bd999a0b68fd72af\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadReconcile.js\":\"5c72c8105d9d560d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadRecovery.js\":\"9071be7f49346be0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadStore.js\":\"e69bd4bc56c16c4e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/useAssetObjectUrl.js\":\"219c0c3e0d965da8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b29ae575721f4b0d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fe4b6600fcdcd847\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/facet.js\":\"a40a0edc24b4d4a7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/index.js\":\"0c33de94a88ee2a6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/prop.js\":\"b658ae3fbfd9819c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/BacklinkFilters.js\":\"18f3032d9369f0d5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a02e3e9bfd94232a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/BlockEntry.js\":\"65969d95103166f0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/LinkedReferences.js\":\"1833b76e9cf81d9d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"eafe81ce144995ff\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/dailyNoteDefaults.js\":\"c27691bb22ff3815\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/dataExtension.js\":\"5ae7eb0deaaa8c2f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/edgeExclusions.js\":\"def078bfc12c844c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/filterProperty.js\":\"aa878e118386bdb2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/index.js\":\"46386d9c289e5576\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"2ec46753cf128658\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/applies.js\":\"b9d76cedd4500f74\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/countQuery.js\":\"dbf1bc4bd37be5ef\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/expansionStore.js\":\"77d47f412a707c53\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/index.js\":\"2e3d813723f07b93\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"1b2870e799594f45\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/presentationInvalidation.js\":\"a992cd434719c566\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/propertyEditorOverride.js\":\"86c7cc0b9c3367fe\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/propertyFilter.js\":\"929773db194a6c41\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/query.js\":\"c2629f3dba9b6e85\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/resolveFilter.js\":\"0c9f00e19f68e884\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/sourceBatch.js\":\"3a5e82154ab40100\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/sources.js\":\"640941c518b14f02\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/useBacklinks.js\":\"6df51d68e7725968\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"03fbc82d5e3f8ba8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/BirthdayCelebration.js\":\"ef8443a8037ea372\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/BirthdayOverlay.js\":\"4b56751d7a7d9093\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/gate.js\":\"698bf12c4b6bc10d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/index.js\":\"4ec154ef44e3df76\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/wolfTheme.js\":\"eb7eaf28494ec309\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/BlockDragLayer.js\":\"6cd792f37beb1ce6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/dragController.js\":\"3cbcb9f1b9bed1ec\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/dropTarget.js\":\"c03afa51f558aae3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/index.js\":\"9edb4435d5cc03f2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/projection.js\":\"fb3586359bd3378e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-info/BlockMetaCard.js\":\"6f34b03e67af93ac\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-info/index.js\":\"8c5f1ec0edcc9e78\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/AddTagDialog.js\":\"91cae2ae2c31a745\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"46acc6a822262a60\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/TagNameIssueHint.js\":\"84b2e3bdc529176d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/addTagAction.js\":\"987bfb99dd7434ae\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/appendTag.js\":\"0f468c66530f4082\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/config.js\":\"c9c8bd51d246e439\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/dataExtension.js\":\"10dfcb09949c6ce5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/index.js\":\"707de16061286bb7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/propertyEditorOverride.js\":\"ea26ab85a37a89b9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c4db55eee3028345\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"93a80532a0bf71a6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8e81993bf65d048c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"38d99b1a4f8864af\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d913340c2fe01088\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/index.js\":\"4f0dd3a1a0273fec\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"ce050b533691e8ae\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/CharacterCountItem.js\":\"df75d66d9fbac134\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/ProfilePropertyEditor.js\":\"049285e67025f4cd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/actions.js\":\"b185f7051ad481b2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/blockType.js\":\"b442382b41c03dcb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/charCount.js\":\"7ff42199cd373f3b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/dataExtension.js\":\"d067fae01be7e91d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/index.js\":\"35f646c1ae77deaf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/profiles.js\":\"0780729cdce588e3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/properties.js\":\"8c814bef1a99ba02\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/textCounts.js\":\"1a01e5eb92dbb8cd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/colemak-keybindings/index.js\":\"60e8f0c6516f6eef\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/CommandPalette.js\":\"bc7a89aed3e49b4e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/HeaderItem.js\":\"30a8ad594da021de\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/context.js\":\"403f46221f9a0cf7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/index.js\":\"04bfe2d9d2500e4c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/selection.js\":\"905d95b4af18bf66\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/toggleStore.js\":\"51821e4a0d2c0c59\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/useCommandPaletteActions.js\":\"e58f9dae9a99295c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/ContributorBadges.js\":\"4f01bb051954a610\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/author.js\":\"b0eebb858ba73cbe\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/codeMirrorExtensions.js\":\"5d74e748fc0f2b91\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/dataExtension.js\":\"44564d97f09b1a88\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/index.js\":\"32a31c8c7ba96e44\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/mentionAutocomplete.js\":\"030f12fafa065167\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/processor.js\":\"d5b669b7cc5fc05d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/profiles.js\":\"7a7f86de0ec92c25\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/queries.js\":\"10c4a6deda9bde8e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/schema.js\":\"f55f6f6e12054186\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"03d019d545815408\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/followOrigin.js\":\"d8141f5daf5af88d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/index.js\":\"d8fb2bab4250a11e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0a3369016c8ede59\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"89f7445ba350fa75\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/CalendarGrid.js\":\"6d73015099f22755\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/DailyNotePicker.js\":\"9e40c07483230fe2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7452bf664b5255ee\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/DateNavDecorator.js\":\"a616d4660f189104\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/DateScrubOverlay.js\":\"f51f94a4f21072d8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/HeaderItem.js\":\"04eb01ba5ad2a2ad\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/ReschedulePicker.js\":\"f798e3103770a806\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/SpreadDatesDialog.js\":\"a5693ddaec02a5c1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/actions.js\":\"dfa1f333221d197a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/blockDateAdapter.js\":\"e937d6144e16cdf4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/calendar.js\":\"1cd632e2014b24b6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dailyNotes.js\":\"ef9e19b8116e0060\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dataExtension.js\":\"8f1786410c0fc16b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dateScrubActions.js\":\"0a30c442cabddf3c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dateScrubGesture.js\":\"6650f9997346cb3b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8ee4187633d1f434\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dateScrubRecognizer.js\":\"6ab855792b6e0bbc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/deletionGuard.js\":\"f3731aee6b6865c2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dueQuery.js\":\"d12afdae6ac92c50\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/index.js\":\"19c7404514841102\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/landing.js\":\"ce1a10297d465bc0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/localSchema.js\":\"cc09fd8c64836eb0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/referenceDateAdapter.js\":\"8bdad1dba9ba0d84\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/rescheduleAction.js\":\"ae423807c2c7e570\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/schema.js\":\"27a41d767b75e9b3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/spreadBlockDates.js\":\"76075afcf8bc31c8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/spreadDatesAction.js\":\"35b664ff52bd3010\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/today.js\":\"4c4a3be4a891740b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"239f03cdc2dff6d8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a03075043e2d22ba\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/audit.js\":\"d59f009d6cf22f7c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/auditAction.js\":\"44cb1eb13248278b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/auditRanges.js\":\"7c90efa366afb500\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/diagnosticsSource.js\":\"fa6a40ac8561f80f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/divergenceScan.js\":\"b9d8d48dd3191710\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/index.js\":\"8a20a3cf6236c2c8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/propertyChildrenChecks.js\":\"37d427dffbbbb424\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/referencesMirror.js\":\"108bfac57a0d94fc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/rowJson.js\":\"a48453e2a8039664\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/schedule.js\":\"82c248a0bfc489e4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/store.js\":\"9e6837a784d410ea\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-maintenance/action.js\":\"386100e5fa9f7715\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-maintenance/index.js\":\"4ecfe15da82f88a9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-maintenance/plugin.js\":\"2d6c2f60f69a5ee6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2b15532d0a9ef19e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/actions.js\":\"7281686042a390d3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/changeMarker.js\":\"7f9f2d7a6b031841\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/diagnostics.js\":\"c9849ab0648071bd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/fileSystemAccess.js\":\"1a1a5946e84ac382\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/filenames.js\":\"2d062a8cf6c5e2a9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/index.js\":\"02a3662fdada6069\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/mirror.js\":\"e7fc27ac34c66970\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/runLock.js\":\"f25b69bdab026420\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/runtimeHealth.js\":\"df83dd626d169bdb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/schedule.js\":\"5bbc67366f5eb0a7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/store.js\":\"df35abb8c01ae3e7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/default-themes/index.js\":\"44d9de0c9b4c51d3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/default-themes/themes.js\":\"b78309fc9c1fd6af\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/diagnostics/facet.js\":\"0660b6cfd22d6ff6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/diagnostics/useDiagnostics.js\":\"18b2305eb7ca6d70\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extension-prompts/dismissals.js\":\"1918d9381f6f26da\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extension-prompts/index.js\":\"f5feb2eac6c67450\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extension-prompts/status.js\":\"a862663e2fbe3827\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extension-prompts/store.js\":\"fea35a4a90e385c3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4074a9a0ce0d3c66\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d6ffd0092a5a16f8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/actions.js\":\"7154b89367135435\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/config.js\":\"57a67e859c9b5a64\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/dataExtension.js\":\"6361e3df49c95afc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/effect.js\":\"ff91959bdd4f59d7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/index.js\":\"bf5e2319367e893c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/propertyEditorOverride.js\":\"20250f5f769d0334\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/useToggleTree.js\":\"41fbbeb7ac0335ec\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/ExtractTypeDialog.js\":\"a5ccd46b4faeb5dd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ac13e2f518c23e69\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/PropertyShapePicker.js\":\"043f356869c7101f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/action.js\":\"f75a300313f99024\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/index.js\":\"511755fad5c5b487\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/FindReplaceDialog.js\":\"3f240e1f01764fb9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/HeaderItem.js\":\"b32af549819d1e82\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/dataExtension.js\":\"f2283c7f15de5409\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/index.js\":\"ca3cfded56f59475\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/search.js\":\"f626e8ae52e7543b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/toggleStore.js\":\"365a658019e42530\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/LocationPropertyEditor.js\":\"6a8ef7dd9cea9735\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/MapView.js\":\"99792d549f0f8bbc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/blockTypes.js\":\"cc3e21ce0d49e7a6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/codeMirrorExtensions.js\":\"7450cfefd0a53aab\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/createOrFindPlace.js\":\"2d42dd5af4db9a2e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/currentLocation.js\":\"93e1290dc81481c4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/dataExtension.js\":\"08badc0c76474ccd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/geoContentDecorator.js\":\"a055410f055c29f0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/googlePlacesClient.js\":\"fee1d54e2ee72a94\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/index.js\":\"fe0fe025ce77d433\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/locationsPage.js\":\"f5c7b6c87b05565e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/mapViewport.js\":\"f70ebdd118d4c3d3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/pickCurrentLocation.js\":\"3eeed566da63ec31\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/placeAutocomplete.js\":\"ea232f9fa9d8e205\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/placeNameCollision.js\":\"4fcbcbaa83ff4f93\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/properties.js\":\"7a64d3df416da5e8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/propertyEditorOverrides.js\":\"66d0c3e5684a3426\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/query.js\":\"ac878a26173b310a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/usePlaceSearch.js\":\"6923aeb7eb5ade9b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"80e4d3a657797b35\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ffdc8375b4c5c17b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d68058a9815acb72\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/config.js\":\"498c381104bd272f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/dataExtension.js\":\"c98820106eaf12ca\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/facet.js\":\"f44eed5ab842026a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/grouping.js\":\"e9a2889738f5b80a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/index.js\":\"b0d5e72e7e481824\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"42e7075a83586bdf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/query.js\":\"422c669d526fed63\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/resolveConfig.js\":\"2cf2ebd69b91256a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d1e3df50deabad97\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"ccedab345b43d8c0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/HtmlDocumentContent.js\":\"34be6c7c50b48ad3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/HtmlFrame.js\":\"eb2c8b8a9e7bdcf5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/actions.js\":\"d0b5e74f5e0fe223\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/blockType.js\":\"6466c43edbb31ef4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/confirmRunScripts.js\":\"2fe8cb43ec8037a4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/dataExtension.js\":\"3e05fb591124d763\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/frameAnnotations.js\":\"48938a9c0e4048c0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/frameDocument.js\":\"6232b0bd1cd1583f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/frameTheme.js\":\"f46ece782e9f0cb6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/index.js\":\"f38de3cbb49d93b2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/scriptConsent.js\":\"6d1203f0c62a012e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/sourceMap.js\":\"a799bcf1bb6b5a4c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/useDocumentScripts.js\":\"a38531d643667c04\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/index.js\":\"431724d891d62168\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/record.js\":\"4d84a2259638f131\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/recordStore.js\":\"cdc7908b2f931fd1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/responsiveness.js\":\"95921df2fe596b8b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/schedule.js\":\"b8986214fb09e52e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/sessionContext.js\":\"e2207cbf77a683d7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"a768d06836264b0a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"30c6bc1baa400993\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/actions.js\":\"ad86f3f6029dff6b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/config.js\":\"ad47c5f259c18abd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/dataExtension.js\":\"a196fa8c8700a540\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/effect.js\":\"010e4cf421a152d1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/index.js\":\"595407f61fbbd8a3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/keyCapture.js\":\"7527213e2a958f81\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/overrideStore.js\":\"55d1f04787ad9f23\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f86cd28bf106190b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/HeaderItem.js\":\"f05d52cbbd115ee8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/LeftSidebar.js\":\"3a94303be320f498\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/actions.js\":\"271e5925b3f4a80e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/facet.js\":\"38f0de97beb104fb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/index.js\":\"b6383ce4cbcf829d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/shortcuts.js\":\"94126c6a933891d5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/toggleStore.js\":\"ff6f76a3bcd92949\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/merge-blocks/MergePicker.js\":\"f4d45a526cad508a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/merge-blocks/index.js\":\"4672ce11d037fa89\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/merge-blocks/mergeAction.js\":\"fed561d073f5bb9e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/merge-blocks/strategy.js\":\"b7f6a1291cea7923\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/Button.js\":\"3ee38e67094fbe94\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"166bb0b8bd1ea45c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5d121b9c78d4d636\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/facet.js\":\"72db6d7b0cd030a8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/index.js\":\"68c4f6e7d50ead4c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b86f73b8d640654f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/actions.js\":\"9667002798d3e304\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"1e0bd748dd27efdc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/facet.js\":\"a0f2cfb40fdf3a1e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/index.js\":\"3a1b3134ba2e0b8f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ec69e0b4ef3f8238\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b4cd3a19ded22ef1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/contextMenuItem.js\":\"b53490b7bcddb076\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/index.js\":\"de401c43436c3e26\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/moveAction.js\":\"4ebafd741b717efc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/moveBlocks.js\":\"0f2dd11644fb9bb1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/selectionAfterMove.js\":\"be9116e5a195a787\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/TutorialBanner.js\":\"a0720d1c42563e23\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/action.js\":\"e2ef53731ba89ceb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/bannerDismissal.js\":\"201a76009cf664f0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/documents/cheatSheet.js\":\"23457ef3efabda26\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/index.js\":\"f7a008f9e89d5dbb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/keys.js\":\"51734b7243e9fd18\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/landing.js\":\"8ca3b29ab0732b58\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/outline.js\":\"46877d8966096816\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/seed.js\":\"e487a854ff436938\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a82df746fdbd22fb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/analyze.js\":\"a5cc190585fd023c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/diagnosticsSource.js\":\"c696522b5be8f480\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/index.js\":\"0f5fedbcb1ca9eb2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/load.js\":\"bc80065b149ea45a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/monitorRun.js\":\"6a59364d56978251\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/schedule.js\":\"c4ed9021df4d42aa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/series.js\":\"df712a5daf95a9ff\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/store.js\":\"a22b73190175fbeb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/trendAction.js\":\"79f36fcec6bdc4d1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/verdict.js\":\"3ec3af98734d1e76\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/plain-outliner/clickToEditAction.js\":\"64785cf65b666172\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/plain-outliner/index.js\":\"0df5595cbd208eb2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/plain-outliner/interactions.js\":\"0f6e75900126fb20\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"474ea75f4711756c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/MigrationGate.js\":\"998ae27b9e33cff9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/MigrationGateDialog.js\":\"237f714e740faf8d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/action.js\":\"13f4b3ec1c555118\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/index.js\":\"09901ffe3ce0ca1d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/localRunMessage.js\":\"08ef855382474269\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/plugin.js\":\"d0c5702bcd4bad2b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/progressReport.js\":\"1be79633289af7a6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/sweepProgress.js\":\"9974e53fdb8ffd61\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/FieldRowRenderer.js\":\"3b790e0ce1569ead\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/ValueRowRenderer.js\":\"70351b8cdae6d492\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/actions.js\":\"4017f9efa42ce714\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/autocomplete.js\":\"320a9d0204819099\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/fieldRow.js\":\"9aa4c6874c38a0ff\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/index.js\":\"a3c07294b39e7d08\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/referenceWarning.js\":\"cfe162f17fcd9325\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/valueAutocomplete.js\":\"67d620b482c304f2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/valueSchema.js\":\"d2ad3b6319684543\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/HeaderItem.js\":\"e631c5b5cadaf820\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/QuickFind.js\":\"09887ae9113534dc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/index.js\":\"2136608c672bb8b4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/recents.js\":\"b3c56f3f1b23938c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/resultItems.js\":\"7e5023037beeca78\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/selection.js\":\"7bd517e131229d47\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/toggleStore.js\":\"dc9b4410f2f5138b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/HeaderItem.js\":\"674630b644ddbeef\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d4da128bd38ffef7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/grouping.js\":\"25df6670a5f09005\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/index.js\":\"e0893106840c3436\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/target.js\":\"64d7916307cf35cf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/codeMirrorExtensions.js\":\"da897c5fa50b5586\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/contentPrefill.js\":\"fc1604e8fdcaeeb1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/dataExtension.js\":\"fbece7f249b9ba7f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/index.js\":\"6ac688525a78c33d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"48e5311b26f70530\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/invalidation.js\":\"bf7c7317bbc38690\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/localSchema.js\":\"6cd4a15a35ce10ab\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/blockrefs/index.js\":\"ab19023e5f2ae10f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"8b4b7bb549b9667c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/index.js\":\"7a217e03e5bc70aa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/referenceNode.js\":\"9bd31df8585602ed\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/remark-reference-occurrences.js\":\"1c1644ebaa709a85\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7b0e6855481ce20c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/wikilinks/index.js\":\"395d9cd77bbf2aa9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"bdeebff71b7bf73a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"dde79f380ced2099\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/mergeRetargetProcessor.js\":\"aebeb9b73c360d44\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/parseFence.js\":\"0d5545c29ed9488a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/referenceParser.js\":\"2c358f617ef7a4e8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/referenceProjection.js\":\"982f0750872628e3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/referencesProcessor.js\":\"21a41840ef79eb93\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/renameProcessor.js\":\"8c2f32e9d074c137\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/spanReplacement.js\":\"5ecc14a678450c9a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/rich-paste/htmlToOutline.js\":\"6709250d8f351774\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/rich-paste/index.js\":\"48d16cf03e927a9d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/rich-paste/normalizeClipboardDom.js\":\"853735c9ef65be98\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/rich-paste/pasteDecision.js\":\"a4f0a25ab6926c63\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/action.js\":\"6b61585fad94b658\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/blockIds.js\":\"f4c93eab30539b25\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/content.js\":\"10a8389633c96a8a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/effect.js\":\"888259847d7be2ad\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/ids.js\":\"8b755256b669afa3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/import.js\":\"f65cdf9b7c84bc70\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/index.js\":\"03a87e94821d0c48\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/plan.js\":\"9d3219cdffaf720a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/plugin.js\":\"3d9192c7e4ad9602\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/promotion.js\":\"867ce5ba7cbb0238\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/properties.js\":\"68d73d39c0cc17a0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/references.js\":\"02a8aca61d2520e6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/report.js\":\"e8462627545b4fb4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/roamMemo.js\":\"a9a7d835da24b3bd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/runtime.js\":\"c3b675d4ecd7a0a2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/schemaReconciliation.js\":\"0a92a3f3a8c4708f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/srsMarkers.js\":\"3b88a18b28a8c20d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/todo.js\":\"5451b275fa65f8d6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/typeCandidates.js\":\"323bb7781b34664a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/types.js\":\"75bf4aa6d6d897a0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/search-health/index.js\":\"bb35c3de5f832c91\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/search-health/store.js\":\"3112dbb0e232884b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/HeaderItem.js\":\"ef76dfbaa1177ab8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"c730c97345951711\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/index.js\":\"3166d15c7c63cff9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/model.js\":\"7946db1baf5ed341\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/toggleStore.js\":\"d69f3db0ba0fc5b5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/useKeyInspector.js\":\"b2e2b8646b81047e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"80dda8cfb1e2f852\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/ShellDecorator.js\":\"cc6a909cd9bb399d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/actions.js\":\"cc986e25580f2707\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ed74efd3d7ee694f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/index.js\":\"75553225539f9031\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/shell.js\":\"5450332317c82578\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/surface.js\":\"9294899ccfd23abf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/walker.js\":\"a800a88bc7e5fc6b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/RescheduleToast.js\":\"bf50fc5cdda9d59e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/dataExtension.js\":\"07a80259fe03aabf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/index.js\":\"cb9d118988ffec9c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/indicator.js\":\"adfdb12cbed04970\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/moveSrsState.js\":\"dce029b2829354f6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"baac38ea4c75e35f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/scheduler.js\":\"aed61cae4b897684\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/schema.js\":\"2ee095899cd7f04d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"131d7a6219221e00\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/srsClipboard.js\":\"6b1f4fcd7f8cfc87\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b5b79d309ef593c7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/DailyNoteReviewHint.js\":\"544ed71659054a7a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/DeckPicker.js\":\"6442bb70b3c8aac9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/ReviewControls.js\":\"99e988985dc85d73\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/ReviewDeckRenderer.js\":\"efca48b3a768b87c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/ReviewSession.js\":\"aeae3c0ce6db7b90\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/actions.js\":\"d7dba5e9047df7ab\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/archive.js\":\"05a897905244b31d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/dataExtension.js\":\"6c2381936e91e1bc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/deck.js\":\"fcc8c4302fc7f73a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/dueQuery.js\":\"65561253c31e5dd7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/gradeDecision.js\":\"1205fb9cc45cc2e2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/index.js\":\"f5434ee502b6cabf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/keyHints.js\":\"a66114a309ac4cdc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/reviewCardLayout.js\":\"9d411c191f61a908\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/reviewProgress.js\":\"dd4625afc49fa012\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/schema.js\":\"3b57144c6ca64930\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/useDueCards.js\":\"d12ff629233801df\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/startup-metrics/index.js\":\"bee1e716bf148b3d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/startup-metrics/record.js\":\"c8a957ce6bf4c08b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/storage-persistence/index.js\":\"1511bf4b73c82168\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/storage-persistence/persistenceStatus.js\":\"64e7a29ac146d650\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/storage-persistence/requestAction.js\":\"cb4e252d5210a1c4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/supertags/TypeChipsDecorator.js\":\"60ddee6601eb81ee\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/supertags/codeMirrorExtensions.js\":\"f25ad852cbbab13b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/supertags/index.js\":\"96a0d32522e37aca\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/supertags/typeAutocomplete.js\":\"05ab8aa74d1a5bb9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6bd4cf746617355e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/actions.js\":\"e028ebdbe6da8df4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/anchor.js\":\"8d94ae77a6023c56\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/events.js\":\"b1f579d0f296b488\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/gestureActions.js\":\"bb16c153f30d1786\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/index.js\":\"8c4dcc51c1742331\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0772ccb987ac1a96\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/sync-metrics/collect.js\":\"e7caa384619f929e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/sync-metrics/index.js\":\"4a2f94f192d21a31\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/sync-metrics/record.js\":\"1e3755551a9ae8c8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/RejectionDialog.js\":\"f01c270aea738c47\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/SystemStatusHeaderItem.js\":\"4674d728ea051522\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/index.js\":\"3b73665b2b5c4953\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/model.js\":\"5aa120414559a7c7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/queueCounts.js\":\"f5a81fa12859319b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/rejectedHelpers.js\":\"c39598df3b628659\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/rematerializeAction.js\":\"6f9295f55278f117\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/useHysteresis.js\":\"bfa6b17404198ce5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/ColumnHeaders.js\":\"6095fd4b9c199dba\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/QueryUi.js\":\"e9b79479bcf0d714\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/TableLayout.js\":\"4b8e6f344dd3233a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/actions.js\":\"90a907ee4f4c61f6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/cellEdits.js\":\"0a1c08d1a22b3582\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/childrenViews.js\":\"048ae9b724ae6712\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/columns.js\":\"4adb7330361a9da2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/controller.js\":\"6ecb7a65d34bb3f9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/convert.js\":\"3d2461635bc686a8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/dataExtension.js\":\"faec07f123da3f0a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/index.js\":\"d1722b09d5f1df95\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/keys.js\":\"cfa151a62664b8d1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/model.js\":\"45650a5c01dc3595\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/backfill.js\":\"e3c53c61b2964cef\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/completion.js\":\"267da95c601202fc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/format.js\":\"eb7a1ad3d930ffff\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/parse.js\":\"420edc93fb7d44da\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/queryValue.js\":\"156db25776e2138c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/source.js\":\"25d8ab75d14f17ad\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/registry.js\":\"548f47d855b5eb56\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/rowGutter.js\":\"ebdc534d6e9c89d2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/rowVerbs.js\":\"fcd6162cd1f57c96\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/schema.js\":\"95d62e6b5928ad72\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/sort.js\":\"76f7255deae17163\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/theme-toggle/effect.js\":\"eb9c168bd19b3280\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/theme-toggle/index.js\":\"098de0f1af5dd08c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/theme-toggle/theme.js\":\"712bad1599aa7f83\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/todo/actions.js\":\"0058733badd4499b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/todo/dataExtension.js\":\"732153a61e8fe90d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/todo/index.js\":\"5550f8541b508ecf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/todo/schema.js\":\"f439640d315283d5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/TouchSelectionLayer.js\":\"29fc890bba67af81\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/actions.js\":\"1f35d6d7d394326e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/defaultItems.js\":\"0a5b4d08e0d861d2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/facet.js\":\"54b26cf3bb0a0b04\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/holdRecognizer.js\":\"ae9420f6c94385f7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/index.js\":\"f5020da31578d605\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/update-indicator/UpdateIndicator.js\":\"df9d4bc9c8bebb3e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/update-indicator/index.js\":\"788cb0074799c32f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/update-indicator/loadTimes.js\":\"7bc29fcd874a7d96\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/VideoNotesRenderer.js\":\"756cc9550462db1a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/VideoPlayerRenderer.js\":\"fb600c2864d3df01\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/VideoTimeStamp.js\":\"223b5e952df6eed1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/actions.js\":\"77e59fd837151c69\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/index.js\":\"dca48cf1eac86f63\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/markdown.js\":\"c1b8d3e69c0a74f9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/notes.js\":\"6d00395fc1af30f5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/registry.js\":\"09f615edf7399364\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/remark-timestamps.js\":\"9c325c5bff1aaa9e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/view.js\":\"32a861718bf1134c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-link-hints/LinkHints.js\":\"e9b279e1ff2908fa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-link-hints/index.js\":\"32065c7a32210038\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-link-hints/model.js\":\"4bcbb28e5451da1a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-link-hints/settings.js\":\"b3d1d1dd481cb11f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-normal-mode/actions.js\":\"e632e8f627b25db2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-normal-mode/index.js\":\"a49b32210212bd0e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-normal-mode/interactions.js\":\"5a84247028707c97\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/workspace-header/index.js\":\"25a8106d49924024\",\"/knowledge-medium/pr-preview/pr-1878/src/registerServiceWorker.js\":\"f9d2d34865aa07c5\",\"/knowledge-medium/pr-preview/pr-1878/src/requestPersistentStorage.js\":\"5aaed9f3de2c1e45\",\"/knowledge-medium/pr-preview/pr-1878/src/services/authRequestDeadline.js\":\"119325ebea0e0abb\",\"/knowledge-medium/pr-preview/pr-1878/src/services/authStorage.js\":\"e9e310417b7bdc89\",\"/knowledge-medium/pr-preview/pr-1878/src/services/powersync.js\":\"9d75288119382cee\",\"/knowledge-medium/pr-preview/pr-1878/src/services/supabase.js\":\"7f9f900ca99d54b4\",\"/knowledge-medium/pr-preview/pr-1878/src/services/uploadErrorClassifier.js\":\"0a9f029a7d2acf27\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/ActiveContexts.js\":\"e5a98c289fe0a7a9\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/HotkeyReconciler.js\":\"ac009953bd94511d\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/WipeLocalDataDialog.js\":\"f044169f8cc1b70d\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/actionDispatch.js\":\"0aae300871dea297\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/actionRefItems.js\":\"500cf0805d38223e\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/applyKeybindingOverrides.js\":\"65e445e5821a32ca\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/blockActions.js\":\"db4d677366ef4637\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/blockMergeGesture.js\":\"43ad3ad300c83e7e\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/canonicalizeChord.js\":\"eaa5bc9b2a55554b\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/defaultContexts.js\":\"5f8d6827bbe9cc1b\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/defaultShortcuts.js\":\"4c34cb42aa75301f\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/effectiveActions.js\":\"6b2e7445ef00a315\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/gestureAction.js\":\"1343b006b05f5d04\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/gestureBinding.js\":\"3d3a7a0f11e7011d\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/holdRegistry.js\":\"65f2cfbadc7df2ee\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/keybindingConflicts.js\":\"e184770c183dadf8\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/keybindingOverrides.js\":\"fc44c1b81995775c\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/pointerAction.js\":\"f3ed064678e9815c\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/resolve.js\":\"c14fa673ef0330ef\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/runAction.js\":\"b34217903bcf0931\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/sequenceMatcher.js\":\"2deb6b0833de8eaa\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/types.js\":\"757001470cc463c0\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/useActionContext.js\":\"8483cb0aa9b8ea87\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/useActionDiscovery.js\":\"b034a952f12d8cce\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/utils.js\":\"f913678c48f8f401\",\"/knowledge-medium/pr-preview/pr-1878/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1878/src/sw/bootStore.js\":\"a4390a98431cc7bd\",\"/knowledge-medium/pr-preview/pr-1878/src/sw/previewDatabases.js\":\"1ac5b03b72ef217b\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/byteTransform.js\":\"cbaaba6e9375e3c0\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/attachmentCleaner.js\":\"f28888ed67643c72\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/attachmentParts.js\":\"5f7b20fc1b971fed\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/bundleParts.js\":\"5f3a407378d7eda3\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/bundleRecord.js\":\"93d7dd7b1041dc8f\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/manifest.js\":\"0b22ef056cc9c174\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/takeBundle.js\":\"1d5a3237de5040a4\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/verifyBundle.js\":\"51a801ab173bd718\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/cleaningStage.js\":\"d0d1fc091eb9305f\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/conversionKey.js\":\"1ad9e393fb5c7e52\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/conversionServer.js\":\"cb54d81a6bec258b\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/flip.js\":\"7d70a0335da36afb\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/flipAttempts.js\":\"1f5ddd10d331d800\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/pages.js\":\"12b348c943400e78\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/preflight.js\":\"b0930a013949f676\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/reseal.js\":\"4c35266175fde7e1\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/runConversion.js\":\"0f6042a5b23aba5c\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/runLock.js\":\"8cdd0dd4d9138262\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/sealing.js\":\"38ddce4da6c879d2\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/sealingStage.js\":\"3fecc210c84b67aa\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/stage.js\":\"f0ff8ccab6e1ccc5\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/verifyReseal.js\":\"c73b088d215ef2e5\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/aad.js\":\"71b12cbb3f46c2f7\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/aead.js\":\"9acd38079b4c0ff4\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/base32.js\":\"ef05e2d271b54396\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/base64url.js\":\"4c94cb12c9af6c3b\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/binaryEnvelope.js\":\"eba31fc7db54b5d4\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/byteAead.js\":\"d06feb4491a6f11c\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/canary.js\":\"74c374245531a788\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/contentHash.js\":\"c1c5235301f61c03\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/contentKey.js\":\"a674c6fa2d71027a\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/derivedIdNamespace.js\":\"a1b1d41286054c99\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/envelope.js\":\"fa64260c3b5aeb4a\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/hex.js\":\"6147c8c184f2edf9\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/sha256Hex.js\":\"0883d05007f8694a\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/workspaceKey.js\":\"b0e41c123b6a682e\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/conversionState.js\":\"b6c3aeb22ebfdbcf\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/flows/createEncryptedWorkspace.js\":\"ca6ab9041e86776e\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/flows/pastedKey.js\":\"fa54201b91168147\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"80a1fcc701071205\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b51e443b45612796\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/keyStore.js\":\"bbcee2afa3f17b78\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/mintWorkspaceKey.js\":\"2d762b8815ca7a1c\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/modePin.js\":\"6c4d0544f2f4a0b4\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/openWorkspaceKeys.js\":\"c224c7a5d11f42ef\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/resolveWorkspaceEntry.js\":\"5b80ffa9afdf65e1\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/resolver.js\":\"478ba1613af12013\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/workspaceAccess.js\":\"90b0770cbacd3ad2\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/transform.js\":\"37a6bb80f08c5d53\",\"/knowledge-medium/pr-preview/pr-1878/src/themeBootDefaults.js\":\"c56bf8b73b6f1d68\",\"/knowledge-medium/pr-preview/pr-1878/src/types.js\":\"e322c30939fd9d75\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/ClientLocalSettings.js\":\"315c1b719ad519bb\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/abortableSleep.js\":\"3bff4c9d37948355\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/array.js\":\"094f0b3ad3e60839\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/backlinkAutocomplete.js\":\"f25926786bbfcd9a\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/blockCrumbs.js\":\"8812d6e0c5e0b0cb\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/blockrefAutocomplete.js\":\"8870a866f43243eb\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/cadencedIdleJob.js\":\"903ba7207390c0da\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/callbackSet.js\":\"a83384898fd9c97f\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/clientId.js\":\"b0e06f96ef9134dc\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/codemirror.js\":\"6f3ffb8097be3809\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/codemirrorCompletion.js\":\"fb2788fded8054b7\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/copy.js\":\"64c5036ceef706b0\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dailyPage.js\":\"9e90285cb7b03893\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dbForensics.js\":\"e5bd82ac6553db8d\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dbForensicsHooks.js\":\"8c7265f2106913d5\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/deleteBlockThroughUi.js\":\"7075a4a30f07843c\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dialogs.js\":\"ea0d439b814da065\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dom.js\":\"16855865e21b3d07\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/downloadBlob.js\":\"0a7073612bbfd227\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/drawnWalk.js\":\"c7f4405fd2bb76ec\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/exportSqliteDb.js\":\"64d955113721b115\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/fileSystemAccess.js\":\"4a93132db57d4aef\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/flipSlide.js\":\"3957613097f2a80f\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/fnv1a.js\":\"483d53b113919665\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/formatBytes.js\":\"a323c21b6f6036e7\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/fuzzyRank.js\":\"cbec6ccbf6c82a23\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/idbKeyedStore.js\":\"8ac9d86477c5fd0e\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/idleCallbackPolyfill.js\":\"1d10dbf58181faf7\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/keyboardAwareScroll.js\":\"ae7a408623ffd3fe\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/keyboardViewport.js\":\"6b36d89c657fd3c0\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/lastWorkspace.js\":\"6fcdd861b8031ad6\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/layoutColumns.js\":\"59c1f9c69dc783ae\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/layoutSessionDom.js\":\"ea154dc4130c5768\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/layoutSessionId.js\":\"e1eb2c37b12c14a8\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/linkClickGestures.js\":\"6cde2d4dece7c393\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/linkTargetAutocomplete.js\":\"438d5085af914d01\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/localDbCorruption.js\":\"2d39dc9c63f5a048\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/localDbRecovery.js\":\"302e5018a9e8ca34\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/markdownParser.js\":\"84432df527c44368\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/memoize.js\":\"422b0688fe72f12c\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/nameFieldCommit.js\":\"6ef73a06a1dc942c\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/nameList.js\":\"f2fed26b3298cf90\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/navigation.js\":\"06247ffe2b74373c\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/omnilinerNamespace.js\":\"7aa2a5bb3bd36d3f\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/opfsPageScan.js\":\"0813c6b45ddfd839\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelClearance.js\":\"665c3f77ea472654\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelHistory.js\":\"670c5126a9fcd343\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelLanes.js\":\"471b2092e7c3834a\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelLayoutProjection.js\":\"7983485045d570c8\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelScrollAnchor.js\":\"678bfd4a0af7fd71\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelUrlFlags.js\":\"b9c801025c10c421\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/platform.js\":\"a7a817e70de523f8\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/pluralize.js\":\"228b83a19933dcca\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/propertyCreation.js\":\"9011e020acc8fdab\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/propertyNavigation.js\":\"1ad7bf7e39dbfcf5\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/propertyValueContext.js\":\"073ad45065fea547\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/react.js\":\"eb8d3b6676a81578\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/relativeDate.js\":\"e752f4501c74a2cf\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/relativeTime.js\":\"0e5c2426ef8b4c6b\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/renderScope.js\":\"4444e4f022b5f4ff\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/resolvedThenable.js\":\"c3e286cdf061e241\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/routing.js\":\"166c5d9d053071c6\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/safeMode.js\":\"634701e28d8e5f58\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/scheduleIdle.js\":\"35e4127334ceb9c3\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/screenWakeLock.js\":\"ccba151f59e3bfaf\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/selection.js\":\"1b260caa138c866d\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/softKeyboardGrab.js\":\"46348e3b37e8178b\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/startupTimeline.js\":\"911e12d01740b3e2\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/state.js\":\"b2485f860fdaf101\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/string.js\":\"f70f35db5ce063d5\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/surfaceZoom.js\":\"97bba06073a33ae9\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/time.js\":\"0a501edd23fcb493\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/toast.js\":\"c91d91d2390c7d3d\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/toggleStore.js\":\"d0fe3c7304cf74ac\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/untilStopped.js\":\"8c5b261e2dfb5e5d\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/userActivity.js\":\"fa9a28e49fae9ad3\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/viewTransition.js\":\"2e49b373287fdd62\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/viewport.js\":\"59480886e68ca0d9\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/webLock.js\":\"f62de0fde34291bc\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/workspaceRecovery.js\":\"b78928992fb2e4f4\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/workspaceSnapshotStore.js\":\"bf102e4cb405e3c6\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-compiler-runtime.js\":\"7b612d1deef62653\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-client.js\":\"be5db9ee34771b89\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-server-edge.js\":\"94c146ee659afc56\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-server.js\":\"ff678eca5205cc1a\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-static-edge.js\":\"5b45d57824259e28\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-static.js\":\"2a38b92069f89fec\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-test-utils.js\":\"06f7b5cc15795b52\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom.js\":\"c428f2553953e3a0\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-jsx-runtime.js\":\"6399d5258e68e520\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react.js\":\"b5b5fc2433240c05\",\"/knowledge-medium/pr-preview/pr-1878/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1878/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1878/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
