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
		buildId: "6a12f0e93962-2058e680",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1878/\":\"1cadaf6c778a3e05\",\"/knowledge-medium/pr-preview/pr-1878/index.html\":\"1cadaf6c778a3e05\",\"/knowledge-medium/pr-preview/pr-1878/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1878/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1878/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1878/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1878/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1878/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1878/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/pr-preview/pr-1878/assets/FacadeVFS-BP4z860E.js\":\"3d5a2b9ea34a5ffb\",\"/knowledge-medium/pr-preview/pr-1878/assets/OPFSCoopSyncVFS-WR1UwWmc.js\":\"a8d2192c47465580\",\"/knowledge-medium/pr-preview/pr-1878/assets/OPFSWriteAheadVFS-DnC6rRgP.js\":\"d8442a0b7c7481c7\",\"/knowledge-medium/pr-preview/pr-1878/assets/wa-sqlite-CG9m7OEu.js\":\"fcd3045283516788\",\"/knowledge-medium/pr-preview/pr-1878/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1878/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1878/assets/wa-sqlite-async-Ccw-DntE.js\":\"b8d11ad527437d80\",\"/knowledge-medium/pr-preview/pr-1878/assets/worker-rdJalBy5.js\":\"d53c47020235efa6\",\"/knowledge-medium/pr-preview/pr-1878/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1878/chunks/app-CAUeBPwl.js\":\"7b7e1327b3882e07\",\"/knowledge-medium/pr-preview/pr-1878/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1878/index.js\":\"42d2705004c23537\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1878/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1878/assets/AccessHandlePoolVFS-CVYaN6it.js\":\"eddf95dcf2510471\",\"/knowledge-medium/pr-preview/pr-1878/assets/IDBBatchAtomicVFS-DyEYa82L.js\":\"d6ffa598acaaa764\",\"/knowledge-medium/pr-preview/pr-1878/assets/MemoryVFS-B3AcuQo1.js\":\"f2373b9ed9e873f8\",\"/knowledge-medium/pr-preview/pr-1878/assets/mc-wa-sqlite-5dS8NHvX.js\":\"367dde92f0b41af0\",\"/knowledge-medium/pr-preview/pr-1878/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1878/assets/mc-wa-sqlite-async-CQuFl8HU.js\":\"ff014ffe9c0b12a7\",\"/knowledge-medium/pr-preview/pr-1878/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1878/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1878/chunks/AccessHandlePoolVFS-DbvCvQtI.js\":\"6c1f46ac98ec3f22\",\"/knowledge-medium/pr-preview/pr-1878/chunks/FacadeVFS-CscDc0vg.js\":\"0da0eb099ce450c1\",\"/knowledge-medium/pr-preview/pr-1878/chunks/IDBBatchAtomicVFS-T96VvUi4.js\":\"60bff460ececdfc5\",\"/knowledge-medium/pr-preview/pr-1878/chunks/MemoryVFS-GS9HjA_j.js\":\"644a0fd9441f2d35\",\"/knowledge-medium/pr-preview/pr-1878/chunks/OPFSCoopSyncVFS-C4cmDPZc.js\":\"f6bb37c434941cab\",\"/knowledge-medium/pr-preview/pr-1878/chunks/OPFSWriteAheadVFS-DsTzf1Ln.js\":\"9767ba253900912c\",\"/knowledge-medium/pr-preview/pr-1878/chunks/Preview-CyA8vZWl.js\":\"099ca1cd8bc3c83f\",\"/knowledge-medium/pr-preview/pr-1878/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1878/chunks/card-btqRRh6Y.js\":\"548348f78ac2b07f\",\"/knowledge-medium/pr-preview/pr-1878/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1878/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1878/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1878/chunks/dist-C0U_45-N.js\":\"3a64896ede145ac4\",\"/knowledge-medium/pr-preview/pr-1878/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1878/chunks/mc-wa-sqlite-04vX3MPv.js\":\"bdedcce2d6176734\",\"/knowledge-medium/pr-preview/pr-1878/chunks/mc-wa-sqlite-async-DknR3gpr.js\":\"3235de55f99abbcf\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-2e3BTQ9f.js\":\"b08f297d7a878cd9\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-BVob9EsB.js\":\"23b9c32fa5dd556d\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-D8VXWveO.js\":\"92046c3fe4d799af\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-DA6Om_d1.js\":\"8cf3379e39df5acc\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-Dq4XSHbi.js\":\"edb4cdade1496944\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-DzBdb4Dk.js\":\"e56adf7f21ed34e4\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-PB8JhUOF.js\":\"5b2aa38634c602a4\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-bczWuOmr.js\":\"d6c563670a11b1fe\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-dom-server-legacy.browser.production-Be3y7tQT.js\":\"d20971996785f3fa\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-dom-server.browser.production-C9TIYnA-.js\":\"41e380988652aa78\",\"/knowledge-medium/pr-preview/pr-1878/chunks/react-dom-server.edge.production-rItJgikl.js\":\"7e203ac3831bea3f\",\"/knowledge-medium/pr-preview/pr-1878/chunks/server.browser-muaoh_0o.js\":\"758c3ac32006196c\",\"/knowledge-medium/pr-preview/pr-1878/chunks/textarea-uARGkO1F.js\":\"950789c3f4b00335\",\"/knowledge-medium/pr-preview/pr-1878/chunks/ui-CcEdSthg.js\":\"5e4b17eb10af962a\",\"/knowledge-medium/pr-preview/pr-1878/chunks/wa-sqlite-KSFBpJFU.js\":\"787190150c411d8f\",\"/knowledge-medium/pr-preview/pr-1878/chunks/wa-sqlite-async-zHq4BaBg.js\":\"a90508ff9949d480\",\"/knowledge-medium/pr-preview/pr-1878/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1878/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1878/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1878/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1878/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1878/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1878/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1878/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1878/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1878/src/App.js\":\"6e94c91e14282a63\",\"/knowledge-medium/pr-preview/pr-1878/src/appUpdate.js\":\"fcf7c55e5ea9d3ca\",\"/knowledge-medium/pr-preview/pr-1878/src/appVersion.js\":\"0301943b5da7edfa\",\"/knowledge-medium/pr-preview/pr-1878/src/bootstrap/initialLayout.js\":\"6b23bb34de75a0e7\",\"/knowledge-medium/pr-preview/pr-1878/src/bootstrap/openWorkspaceData.js\":\"8c3180e3639a4a9a\",\"/knowledge-medium/pr-preview/pr-1878/src/bootstrap/resolveWorkspace.js\":\"4d6f17ae1bd81273\",\"/knowledge-medium/pr-preview/pr-1878/src/bootstrap/workspaceBootstrap.js\":\"54696681ac4e8c22\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockComponent.js\":\"4a9abd5a422bde8a\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockCrumbs.js\":\"55a0b037a67affd0\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockEditor.js\":\"699043734f0eddf4\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockLoadingPlaceholder.js\":\"91a1aeeeb7aee723\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockProperties.js\":\"6ed52dadccbbbe44\",\"/knowledge-medium/pr-preview/pr-1878/src/components/BlockSearchPicker.js\":\"b9aa3b0152357056\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ConfirmBulkDeleteDialog.js\":\"2683c8dc8aacc2d2\",\"/knowledge-medium/pr-preview/pr-1878/src/components/DividerHandle.js\":\"e6eec6ac69d3dfe6\",\"/knowledge-medium/pr-preview/pr-1878/src/components/DraftEditor.js\":\"be6d60b5c79bd22f\",\"/knowledge-medium/pr-preview/pr-1878/src/components/GutterPill.js\":\"fe36cad5085d8c94\",\"/knowledge-medium/pr-preview/pr-1878/src/components/Header.js\":\"eeef541ede213e50\",\"/knowledge-medium/pr-preview/pr-1878/src/components/LazyBlockComponent.js\":\"e184540f7ed37a02\",\"/knowledge-medium/pr-preview/pr-1878/src/components/Login.js\":\"57fda41049bd4c9f\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ZoomableSurface.js\":\"4b34d677ac7723d6\",\"/knowledge-medium/pr-preview/pr-1878/src/components/editModeKeepalive.js\":\"8746bd5291acef7e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c1f64c6212b57333\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"81cadf3fe006d906\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/RefPropertyEditor.js\":\"8a94fc41f7138610\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/RefTargetTypePicker.js\":\"81d83b01e4a26186\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/SelectPropertyEditor.js\":\"639f565ab9fc01d2\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/TypesPropertyEditor.js\":\"3f39fae003ce7dcb\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/defaults.js\":\"01b92b3d8da75087\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/kernelValuePresets.js\":\"132f34e718dfb122\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/selectablePresets.js\":\"9dd3541cb1111388\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyEditors/typesPropertyUi.js\":\"d7750ffca1169cb8\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/AddPropertyForm.js\":\"21a0664dadd5690e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/PropertyPicker.js\":\"c93be8374e1cb2b1\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/PropertyRow.js\":\"e78378a38934f6e0\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/Rows.js\":\"91ac7d7dafbbc8be\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/actions.js\":\"a879bc6034426de4\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/declarationOnly.js\":\"327cd8a9af510eeb\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/layout.js\":\"c2f0b62dc401687e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/model.js\":\"5e3387b23e1d5cd9\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/shapeUi.js\":\"9e0daa24430257a8\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/shapes.js\":\"c5f2dde0bde2df04\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c81d4d71f86ab1ba\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanel/visibility.js\":\"16dae6d86806b0f7\",\"/knowledge-medium/pr-preview/pr-1878/src/components/propertyPanelSections.js\":\"508259677d218022\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/BlockEmbed.js\":\"1584e8a804a8e061\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/BlockLink.js\":\"3324e2d704236949\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/BlockRef.js\":\"f0e638023fd0ce48\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/ReferenceLink.js\":\"f6564acd77d4bc3f\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/cycleGuard.js\":\"9078af7927087822\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/cycleGuardContext.js\":\"3241360bc74f56d7\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/linkInteraction.js\":\"c10c9ad13894bf5e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/referenceLayout.js\":\"555cc7846b74246a\",\"/knowledge-medium/pr-preview/pr-1878/src/components/references/useBlockRefAncestors.js\":\"04497204f8095a32\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/BlockGutter.js\":\"fd9ee29b2997a5ef\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/BlockInfoDialog.js\":\"b8291c232274f11c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/BlockTypeBlockRenderer.js\":\"a0404b051914b707\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/BulletHoverCard.js\":\"e35c6e4267fa000c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/CodeMirrorContentRenderer.js\":\"ac09c09dbb3afa7f\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8cb8c9473e8d7629\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/ColumnResizeHandles.js\":\"cd3ca69a09e41485\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"75cbc6f31e398692\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/DefaultBlockRenderer.js\":\"273ef9322b912298\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/LayoutRenderer.js\":\"bdad66c2a9356064\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/MarkdownContentRenderer.js\":\"4e53b335015138ae\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/MissingDataRenderer.js\":\"0b9f7ff01608a2fb\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/PanelRenderer.js\":\"99a979244f069329\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/PropertySchemaBlockRenderer.js\":\"3724c247a2b65672\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/TopLevelRenderer.js\":\"b08aa71a1a3e44cd\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/blockGutterMode.js\":\"6ff2964f35ad9121\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/blockTitleText.js\":\"dddf8bccb1878923\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/fieldCreationKeydown.js\":\"7925528e6fd9ce14\",\"/knowledge-medium/pr-preview/pr-1878/src/components/renderer/layoutRootContext.js\":\"053844392580cbe9\",\"/knowledge-medium/pr-preview/pr-1878/src/components/typeChip/TypeChip.js\":\"06c8f4e4c8915efc\",\"/knowledge-medium/pr-preview/pr-1878/src/components/typeChip/chipStyle.js\":\"8033d9876c50a42b\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/anchored-floating.js\":\"bb33b750c641df1c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/button.js\":\"a22773e5142717ca\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/card.js\":\"7bbd2fc657f37373\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/checkbox.js\":\"eeac55baf760ba9e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/collapsible.js\":\"7352d1acc0200c55\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/command.js\":\"5dc6418904ae03bd\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/context-menu.js\":\"21c7fb910201dd24\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/dialog.js\":\"785571d272202c2d\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/dropdown-menu.js\":\"f5fe5b8ff8866f9f\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/floating-listbox.js\":\"4ea756d838dcb76d\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/index.js\":\"e033ba18c6e536f7\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/input.js\":\"0131919bd0dac56e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/kbd.js\":\"f1470ae057c68c91\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/label.js\":\"ba24acc2f16c9c2f\",\"/knowledge-medium/pr-preview/pr-1878/src/components/ui/textarea.js\":\"c8ab6231788aa6bc\",\"/knowledge-medium/pr-preview/pr-1878/src/components/useEditModeYieldKeepalive.js\":\"baac584b5e0f832e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/BootFallback.js\":\"424bd36cd93ad182\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/FocusedRowLazyMount.js\":\"212b439a6aa1737e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/LazyViewportMount.js\":\"571ac54f6b09dc1c\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/LocalDbCorruptionFallback.js\":\"a634463e12ff883b\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/error.js\":\"5d0a27c5413aeb51\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/lazyMountRegistry.js\":\"60c7620bf50c15e8\",\"/knowledge-medium/pr-preview/pr-1878/src/components/util/suspense.js\":\"ace60d438dda5c67\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/CreateWorkspaceDialog.js\":\"3e2c26f33bb484cd\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/PendingInvitations.js\":\"790db83c28ad1551\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/SyncProgress.js\":\"8180528c19a0b4cc\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/UnlockProgress.js\":\"4ba55d6bf436960b\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/WorkspaceKeyGate.js\":\"e9dfccce44c386fa\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/WorkspaceSettingsDialog.js\":\"4c12365b65615479\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/WorkspaceSwitcher.js\":\"5d67e1a5fb8ccbc0\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/WorkspaceSyncGate.js\":\"1110a20c5ad7288e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/ConversionFlow.js\":\"6194c95941c3d5b3\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/ConversionFlowHost.js\":\"ca03df27c2895168\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/EncryptionSection.js\":\"94e696f048a07752\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/attachmentPrompts.js\":\"5462c337c1bc084d\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d3f0b6aaadce6c20\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/conversionFlowDeps.js\":\"17e7e9762782d9f8\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/conversionFlowStore.js\":\"1626f7b264a1b93b\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/flowUi.js\":\"4a1fa133825fa268\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/conversion/useConversionRun.js\":\"07628357ef6bc05e\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/keyUi.js\":\"72d865962de0ebb2\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/useCloseOnKeyLoss.js\":\"15ce38391535f2b1\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/useCloseOnServerE2ee.js\":\"0b9b062949055591\",\"/knowledge-medium/pr-preview/pr-1878/src/components/workspace/workspaceUnlocked.js\":\"e66624b4b5f3af7b\",\"/knowledge-medium/pr-preview/pr-1878/src/context/backgroundSubtree.js\":\"cdd2f8a1af1634e4\",\"/knowledge-medium/pr-preview/pr-1878/src/context/block.js\":\"0a31aa008d7a48d3\",\"/knowledge-medium/pr-preview/pr-1878/src/context/layoutWsContext.js\":\"b2d36b6d8859836b\",\"/knowledge-medium/pr-preview/pr-1878/src/context/propertyDisplay.js\":\"dc7fb900736327b1\",\"/knowledge-medium/pr-preview/pr-1878/src/context/repo.js\":\"6f572180df7acc2d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/aliasClaim.js\":\"342f52e6c2a49eea\",\"/knowledge-medium/pr-preview/pr-1878/src/data/aliasSeatNamespace.js\":\"ca0ecc62d5ea935d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/blockData.js\":\"e8968a7f6341b16a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/blockType.js\":\"09cb875692dd52b5\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/changeScope.js\":\"16e0277ecd375d18\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/codecs.js\":\"3c06bce65f32e685\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/derivedData.js\":\"dca9f5ce593f3011\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/errors.js\":\"6010f7d5b2311c5b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/events.js\":\"307b0b20fae95a90\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/handle.js\":\"973d41f4aa4309ad\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/index.js\":\"8f8639ef33ce8b68\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/mutator.js\":\"78d911511d86b49d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/processor.js\":\"0fe3c63ab0f03aa6\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/propertySchema.js\":\"665739338dad64ef\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/query.js\":\"87bf7495bf273b28\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/sameTxProcessor.js\":\"bffb1644fc35e890\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/schema.js\":\"973d41f4aa4309ad\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/tx.js\":\"973d41f4aa4309ad\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/typedBlockQuery.js\":\"0715ed5bd0fed472\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/user.js\":\"ac55b21e7311a025\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/valuePresetCore.js\":\"c625bb63dcbbc2cf\",\"/knowledge-medium/pr-preview/pr-1878/src/data/api/valuePresets.js\":\"2453edaad2b69223\",\"/knowledge-medium/pr-preview/pr-1878/src/data/attachmentCleanerIOVerb.js\":\"729307f0df0b7f22\",\"/knowledge-medium/pr-preview/pr-1878/src/data/block.js\":\"97d04759d92a44b0\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockCache.js\":\"f06444f13dd0eeb6\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockId.js\":\"d7d65f781adcde8d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockLiveness.js\":\"56484ce4e86a4da2\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockMerge.js\":\"d2cfbf922adddabc\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockSchema.js\":\"321b86dd23907ef1\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockTypeLookup.js\":\"f76be6c1aaf81c84\",\"/knowledge-medium/pr-preview/pr-1878/src/data/blockTypes.js\":\"477f54c0f22540fc\",\"/knowledge-medium/pr-preview/pr-1878/src/data/childrenView.js\":\"91c7b4f10f2b102b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/clientContext.js\":\"16f51d2cf5c7cd33\",\"/knowledge-medium/pr-preview/pr-1878/src/data/dbFileSiblings.js\":\"614ae216f925dbd1\",\"/knowledge-medium/pr-preview/pr-1878/src/data/definitionSeeds.js\":\"9e8a3d7fe324a947\",\"/knowledge-medium/pr-preview/pr-1878/src/data/derivedIds.js\":\"485a9b172f1dc7fa\",\"/knowledge-medium/pr-preview/pr-1878/src/data/drawnSubtree.js\":\"9ee1ae970d8f1c7d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/facetBridge.js\":\"d429e4d66fc32898\",\"/knowledge-medium/pr-preview/pr-1878/src/data/facets.js\":\"e14b28a86595c8bd\",\"/knowledge-medium/pr-preview/pr-1878/src/data/globalState.js\":\"b0fe739857a76ff4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/aliasClaimRederiveProcessor.js\":\"42ed3dd8c0f3db7d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/ancestorBatch.js\":\"134fe97030b40113\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/blockTypeTypeifyProcessor.js\":\"7d67e240cf9d646f\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/clientSchema.js\":\"125c3962bfe5e65b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/commitPipeline.js\":\"3afcc5d7334fd4a9\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/devAssertions.js\":\"56d6a2ef0c199d68\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/firstSync.js\":\"3c60bdd6378ffbad\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/freshInitialLoad.js\":\"a0a44425937759b1\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/graphBackfillClaim.js\":\"f9ce676dd49f39ba\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/handleStore.js\":\"64e3335f11319b0c\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/idleMarkerJobs.js\":\"62d801de255c4ff3\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/initialDownload.js\":\"ecab5f75843afb49\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/initializeClientDatabase.js\":\"e2f345b42ef92f51\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/jsonCanonical.js\":\"5e72f271eaee9036\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/kernelInvalidation.js\":\"96caa0f0d439b3a7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/kernelProcessors.js\":\"bac1ef329a4f8960\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/kernelQueries.js\":\"e6fd0a1c74332be7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/mergeTypeMembershipProcessor.js\":\"b2b6af8ed08a142b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/normalizeReferencesProcessor.js\":\"432fec17bce478ab\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/poolInstrumentation.js\":\"b6a397d2f437d279\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/processorRunner.js\":\"9d6b0e544cce3010\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyCellBackfill.js\":\"0905ae57e4b9dcc1\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyChildMint.js\":\"5549817a376e0b4a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyChildrenProcessor.js\":\"9f979f7affa96330\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f0f304d4c7e0b27e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyDefinitionSynthesis.js\":\"9008c4d028e19b89\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyKeyScan.js\":\"b15975fd1f585fde\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertySchemaResolution.js\":\"fdc317acadeea51e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/propertyValueEdits.js\":\"ed8df21f50f1cdd6\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/raiseProtocol.js\":\"cd1462bae21e27a8\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/readBatch.js\":\"fe5b961eb0d43242\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/refProjection.js\":\"e2ffb2c016e20512\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/referenceTargetLookups.js\":\"bddf62597d92cdfb\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/referenceTargetProcessor.js\":\"450353aef90fff69\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/replayMerge.js\":\"ce15a55e69d1eba7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/sqlBinds.js\":\"380d7865d3544be4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"1218b34257f5786a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/arrivalProcessors.js\":\"cab1599168879182\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/invalidate.js\":\"83dff2ae82fb9af1\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/materialize.js\":\"2b033ef7a97ba865\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/observer.js\":\"c64524d2219108d4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/syncObserver/reconcile.js\":\"5def3cda12eda0ac\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/timingMetrics.js\":\"8f3475238a18d444\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/treeQueries.js\":\"db28471dd39a622e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/txEngine.js\":\"83c1bc1697720f94\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/txSnapshots.js\":\"b71ab3d60a1acaa4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/typedBlockQuery.js\":\"5752ae1a53e411d0\",\"/knowledge-medium/pr-preview/pr-1878/src/data/internals/undoManager.js\":\"018ad5f6e2822bd0\",\"/knowledge-medium/pr-preview/pr-1878/src/data/invalidation.js\":\"56098d1e502ce693\",\"/knowledge-medium/pr-preview/pr-1878/src/data/kernelDataExtension.js\":\"d7fc8b33e0ba4df3\",\"/knowledge-medium/pr-preview/pr-1878/src/data/kernelPage.js\":\"8f1a3c56433f6122\",\"/knowledge-medium/pr-preview/pr-1878/src/data/kernelValuePresetCores.js\":\"9bf2ebdb0dfdb819\",\"/knowledge-medium/pr-preview/pr-1878/src/data/localDbCorruptionSignal.js\":\"ce79caaf43c98cbf\",\"/knowledge-medium/pr-preview/pr-1878/src/data/localDbStorage.js\":\"6e3361b0b4cd58ac\",\"/knowledge-medium/pr-preview/pr-1878/src/data/localDbVfs.js\":\"ec8582dfb391f18a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/localSchema.js\":\"d1c74f01cfa3a3a0\",\"/knowledge-medium/pr-preview/pr-1878/src/data/maintenance.js\":\"3c9b8be7771bb5c8\",\"/knowledge-medium/pr-preview/pr-1878/src/data/mergeProperties.js\":\"8fd5da67e0284199\",\"/knowledge-medium/pr-preview/pr-1878/src/data/metricsConsoleHook.js\":\"2d4fd16a18ed1abe\",\"/knowledge-medium/pr-preview/pr-1878/src/data/migrationsPage.js\":\"47e1862c929b26ee\",\"/knowledge-medium/pr-preview/pr-1878/src/data/mutators.js\":\"897e60c19af03231\",\"/knowledge-medium/pr-preview/pr-1878/src/data/orderKey.js\":\"fff858accd666235\",\"/knowledge-medium/pr-preview/pr-1878/src/data/orderKeyPlacement.js\":\"877003c8a746a839\",\"/knowledge-medium/pr-preview/pr-1878/src/data/outlineSurface.js\":\"1d7ae939972cbbb5\",\"/knowledge-medium/pr-preview/pr-1878/src/data/pendingEditorContent.js\":\"d5ad5b6decd61abb\",\"/knowledge-medium/pr-preview/pr-1878/src/data/pendingUploadsSql.js\":\"dab105a735f1eff4\",\"/knowledge-medium/pr-preview/pr-1878/src/data/pluginStateExtensions.js\":\"50127366a3af66c1\",\"/knowledge-medium/pr-preview/pr-1878/src/data/powerSyncLogger.js\":\"2f10e013c8ced7cc\",\"/knowledge-medium/pr-preview/pr-1878/src/data/projectorRuntime.js\":\"b37255128600c1e7\",\"/knowledge-medium/pr-preview/pr-1878/src/data/properties.js\":\"f552720077a379d5\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertiesPage.js\":\"803ae3027e64be15\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyChildren.js\":\"308089e20f367cd9\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyDefinitionFanout.js\":\"bf115a9cd16c014e\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyDefinitionMetadata.js\":\"a404edb4552cad3a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyDefinitionRegistry.js\":\"af40a1a1ac721e04\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyDisplayMode.js\":\"8912e8341a7dc2bf\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertyRowCreation.js\":\"86bf7b338c848b67\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertySchemaCreation.js\":\"438d66de31d8c851\",\"/knowledge-medium/pr-preview/pr-1878/src/data/propertySeeds.js\":\"18125c7d8f02d463\",\"/knowledge-medium/pr-preview/pr-1878/src/data/recentsPage.js\":\"341e7e4622377356\",\"/knowledge-medium/pr-preview/pr-1878/src/data/referenceBlock.js\":\"3e7e7078aa6993c1\",\"/knowledge-medium/pr-preview/pr-1878/src/data/rejectedUploads.js\":\"7d3ee58fd9575bbc\",\"/knowledge-medium/pr-preview/pr-1878/src/data/releasePowerSyncConnection.js\":\"14e7c8b76695e511\",\"/knowledge-medium/pr-preview/pr-1878/src/data/repo.js\":\"a9b41a4695cb5efd\",\"/knowledge-medium/pr-preview/pr-1878/src/data/repoProvider.js\":\"c16f223087f8782a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/rowProperty.js\":\"21dc16b0aec2170a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/searchFilter.js\":\"f6ca8a73237adaa8\",\"/knowledge-medium/pr-preview/pr-1878/src/data/seedIdentityLedger.js\":\"858081b0f1bef34a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/stateBlocks.js\":\"a91940ea710a7bcd\",\"/knowledge-medium/pr-preview/pr-1878/src/data/structuralEditPolicy.js\":\"6623da09ffe7636d\",\"/knowledge-medium/pr-preview/pr-1878/src/data/structuralInsert.js\":\"177ad3da913346cc\",\"/knowledge-medium/pr-preview/pr-1878/src/data/subtreeDelete.js\":\"973bd3f55a05de07\",\"/knowledge-medium/pr-preview/pr-1878/src/data/syncStreamLock.js\":\"27ccf9eaa499a307\",\"/knowledge-medium/pr-preview/pr-1878/src/data/syncedTableSqlRecognizer.js\":\"84abf46a6de9c596\",\"/knowledge-medium/pr-preview/pr-1878/src/data/syncedTableWriteGuard.js\":\"fa284a885996faac\",\"/knowledge-medium/pr-preview/pr-1878/src/data/targets.js\":\"6be78a5b9a6eba03\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeColors.js\":\"6eef84b1a70734da\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeDefinitionMetadata.js\":\"c5f27390e2434e64\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeDefinitionRegistry.js\":\"61a71e1ce12ad544\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeExtraction.js\":\"f63d4f92ff083afe\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeInitialValues.js\":\"ee6c310ea10d1551\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typePropertyGroups.js\":\"3be67b8ee7176e88\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeSeeds.js\":\"b570e824ecaeb077\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typeTagger.js\":\"17b0d84b390ea306\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typedRecords.js\":\"5923dcd515d2cf35\",\"/knowledge-medium/pr-preview/pr-1878/src/data/typesPage.js\":\"fc9a974f7a94840a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/userPrefs.js\":\"86b6b09ebbf3801b\",\"/knowledge-medium/pr-preview/pr-1878/src/data/userSchemasService.js\":\"7d8b6183e0c74ee3\",\"/knowledge-medium/pr-preview/pr-1878/src/data/userTypesService.js\":\"632d061cd9808868\",\"/knowledge-medium/pr-preview/pr-1878/src/data/valuePresetRegistry.js\":\"7b0cc308ffeb0f90\",\"/knowledge-medium/pr-preview/pr-1878/src/data/visibleChildren.js\":\"038a0f5f5967e8d2\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaceConversion.js\":\"5ac73f90ae3d59cb\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaceFirstSync.js\":\"c83e557a627f213c\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaceIdNamespace.js\":\"5a20f2513df77cff\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaceSchema.js\":\"5e2ddd46f2f17e57\",\"/knowledge-medium/pr-preview/pr-1878/src/data/workspaces.js\":\"ffb35248c4e3f3aa\",\"/knowledge-medium/pr-preview/pr-1878/src/data/writeAheadLog.js\":\"e905fe1bcb29cb6a\",\"/knowledge-medium/pr-preview/pr-1878/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/BlockPasteShellDecorator.js\":\"c7fae5e28d571703\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/atTrigger.js\":\"5bd0d2802eb99aa6\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/autocomplete.js\":\"81c5aecabf1d2d18\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/codeMirrorExtensions.js\":\"c7221b855ff19403\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/contentFlush.js\":\"39380284de8d1cd1\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/defaultInteractions.js\":\"7b18ac5d6a44ae8c\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/editSettleSignal.js\":\"68dfc034e0ddb41e\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/insertImage.js\":\"a650037464f350d0\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/referenceCompletionRange.js\":\"9fbbef6dd1271beb\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/referenceTargetTypes.js\":\"ec78496cdc78ce27\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/syntaxContext.js\":\"a92d25593b2c232f\",\"/knowledge-medium/pr-preview/pr-1878/src/editor/triggerMatch.js\":\"9b8df26574894e4e\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/AppRuntimeProvider.js\":\"52832ca5779a2baf\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/BlockFocusShellDecorator.js\":\"60f4757a6076dc23\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/ExtensionRenderBoundary.js\":\"64621d1155230b4c\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/PanelContentRecovery.js\":\"e6743c7b7978b42f\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/apiCatalog.js\":\"b4686ddd97ebb4fd\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/approveExtensionHere.js\":\"9c8e02853ae92b69\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/armedCutAppMount.js\":\"1122564414b4e815\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/batchableKeyedStore.js\":\"7d3adc3ae90bf273\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/blockInteraction.js\":\"561976ccca44ab6b\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/blockSelectionAction.js\":\"bee8057f8d2d7cb6\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/compileExtensionModule.js\":\"a36958802bed064b\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/compiledModuleCache.js\":\"c1377f2fb3230e83\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/continuousGestures.js\":\"2929a47d1adf5439\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/core.js\":\"785e28254d82c6f3\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/defaultRenderers.js\":\"05379dd952992f05\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/definitionFanoutAppMount.js\":\"fe4c130c8fc8e46d\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/dialogAppMount.js\":\"cbbec43c3b60a7e8\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/dynamicExtensionSeeds.js\":\"fcffd34ee13323df\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/dynamicExtensions.js\":\"ba0088fb0d6a4ca8\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/exampleExtensions.js\":\"0b361930e1834a38\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionApprovalStatus.js\":\"035ba3fe839d275b\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionLoadErrorToast.js\":\"1db5bea9901bc8c4\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionLoadErrors.js\":\"872e9eda263be276\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionLookup.js\":\"f40b007dd7e2baf8\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionToggles.js\":\"811caac1c6704cbe\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/extensionUtilitiesCss.js\":\"c028c153b8b82cde\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/kernelPageDeletionGuard.js\":\"cc2bb26f85fd063c\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/liveRuntime.js\":\"7dbc22658f9267a9\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/openExtensionsSettings.js\":\"0e507f0f58a13b33\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/overridesCache.js\":\"6f69bf4a49f28640\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/pluginIds.js\":\"fe9902a8eb6e898f\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/processorRejectionToast.js\":\"97ede2361b202f23\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/runtimeActions.js\":\"5dbf2fed5461ee6d\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/runtimeContext.js\":\"cdfba2ed47d80ebb\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/staticAppExtensions.js\":\"125e29b32edecd06\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/staticDataExtensions.js\":\"1d2c7b5244d5bbe4\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/toastAppMount.js\":\"11257a6b8cb9938a\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/useOverrides.js\":\"be6e885fb2551cac\",\"/knowledge-medium/pr-preview/pr-1878/src/extensions/useShortcutSurfaceActivations.js\":\"f760ffec91dbaa51\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/discoverToggleTree.js\":\"718a7622b3006095\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/facet.js\":\"c1a014c64675164d\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/resolveAppRuntime.js\":\"5888015abb1aa629\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/runtimeEvents.js\":\"648f7e072a93a5b1\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/togglable.js\":\"2d196c6d62ad0c04\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/variantFacet.js\":\"d37b435e20ff1d59\",\"/knowledge-medium/pr-preview/pr-1878/src/facets/verbFacet.js\":\"0d598f818ac4bf74\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/block.js\":\"f20b8d6965ef0b15\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/focusedChild.js\":\"f3c33901b3fdef43\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/propertySchemas.js\":\"bdb4b6a635cc6c2e\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/typeRegistry.js\":\"e536af9945d99ca5\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useAncestorCrumbs.js\":\"fa91953267a7e3b4\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useAutocompleteListbox.js\":\"b79ab304847482b0\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useDebouncedSearch.js\":\"0bc68295836c1849\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useDebouncedValue.js\":\"377f754bcf9503da\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useIsFocalRender.js\":\"c6d47e93b86dfe03\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useIsReadOnly.js\":\"db1527cdc18e5649\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useMaterializeBacklog.js\":\"250435de4ef16f58\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useMinuteClock.js\":\"b3996b32b834dbb5\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/usePanelLayoutProjection.js\":\"ba6bae3dbb44c4e5\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/usePendingInvitations.js\":\"ca703d7cc0f7bea1\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useRendererRegistry.js\":\"524570ec5e87c5c9\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useRetainedFieldRows.js\":\"ab56e0b72144bc51\",\"/knowledge-medium/pr-preview/pr-1878/src/hooks/useWorkspaces.js\":\"2cee68db1a270e3a\",\"/knowledge-medium/pr-preview/pr-1878/src/lib/utils.js\":\"848a2de17d851fcd\",\"/knowledge-medium/pr-preview/pr-1878/src/main.js\":\"cec5d87110e2f5c1\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/MarkdownImage.js\":\"8fcbb7e2dc3297b8\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/blockSeparators.js\":\"2e270164d50c03e1\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/context.js\":\"8c21ecd85257ff34\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/defaultMarkdownExtension.js\":\"0786e9aa701a69e9\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/extensions.js\":\"f09a112bd6a2f765\",\"/knowledge-medium/pr-preview/pr-1878/src/markdown/renderMarkdownHtml.js\":\"b06b189e5cc8c915\",\"/knowledge-medium/pr-preview/pr-1878/src/minimal-editor.js\":\"22a6a3ee9ed6c1dc\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/armedCut.js\":\"fa46e3a11985f8ed\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/captureMediaVerb.js\":\"051faea7ff983fea\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/clipboard.js\":\"8b578e34f7f38f52\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/decision.js\":\"e31c4cde558a1d8d\",\"/knowledge-medium/pr-preview/pr-1878/src/paste/operations.js\":\"04fb9d6795985513\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/account-header/AccountHeaderItem.js\":\"d5f627778852c10b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/account-header/index.js\":\"28af696d35c3209e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"998dfc41faa2720a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/askAgent.js\":\"7943e8cc9986e353\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/askedStore.js\":\"fa4086fe72089fb4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"96991d0cd297c9b7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/chipState.js\":\"6ecc4ea1e22ec996\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8ab501ca3932fbb0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/index.js\":\"cd940542ce09e5bf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"298424b22d34106b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-dispatch-companion/schema.js\":\"590a2a38fccaf900\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/AgentTokensDialog.js\":\"7d33089261af4187\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/BridgePairingDialog.js\":\"34da727310a645d1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/addMedia.js\":\"27f2048390e6f7a8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/backlinks.js\":\"bcef83925962545b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/block.js\":\"5aeb1d040f5e2eea\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/context.js\":\"ff63a74963bb358e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/displayIds.js\":\"2d8f3ac12146d777\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/index.js\":\"f9bded6b4733024b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/outline.js\":\"d291ed4177395168\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/properties.js\":\"353dfab62754b674\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/refs.js\":\"ee7342e6d69d30ea\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"4258a3d33fd76c09\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/search.js\":\"625a9df1461f5f66\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/shared.js\":\"a8799bfd64c28167\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6f46e824552dbd03\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentViews/text.js\":\"fcec72d675a40280\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/agentWrites.js\":\"41af37981057ea28\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/authoringCatalog.js\":\"74a408c340d87385\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/blockRefTargets.js\":\"49bad21cc7e41d64\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/bridge.js\":\"0110b1e09269a79b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/bridgeLoop.js\":\"6c823458d148e6d2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/changeHistory.js\":\"e68f67338d6bd1e5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/commands.js\":\"c62fd2ff2572d37d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/commentsCommands.js\":\"d1476cb3886e8b6e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/dataExtension.js\":\"9eb53768ec296709\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/dataModelGuide.js\":\"9db732a7f827a799\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/describeRuntime.js\":\"2345c84e325be7cc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/extensionLint.js\":\"970e933faaa8ea01\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/grainAudit.js\":\"45a58822d8a5ec47\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/healthCommand.js\":\"51c224bd20841fd1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/index.js\":\"c0faece11e6bee8e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/presetIdentity.js\":\"46fb12d49b718cbb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b9768f58862cdaec\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/readMedia.js\":\"c99a063b69ebbcd2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/schema.js\":\"502664cabb55dcbb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/serialization.js\":\"75c5ccd338d5cb22\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/targets.js\":\"ef9f9eedb5576288\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/tokens.js\":\"6ca9e0efc169ca3d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/watchEvents.js\":\"b61dc0c1b2137575\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/workspaceGuard.js\":\"0459aa6a7318fd12\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/agent-runtime/writeCommands.js\":\"569f96bde2b53240\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/AliasCollisionToast.js\":\"a2c09fb2fd81501b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/DuplicateNameBanner.js\":\"3c32835c1454c42c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/collisionMerge.js\":\"26b03660ef1f0b84\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/dataExtension.js\":\"1f973281bd06dc2e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/index.js\":\"86f3f8be2111e4d1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/mergeCollisionAction.js\":\"fa26308b8f224022\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/pageStyling.js\":\"61c7bcd038738a2b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/rejectionToast.js\":\"ba64f20d23653cc7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/alias/syncProcessor.js\":\"b3a44154a598cd23\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/actions.js\":\"76983bfa683097e4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/addComment.js\":\"282dc3d03cf704d2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/anchor.js\":\"b759747c1ba7075c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/anchorState.js\":\"1583d70ddf1ff3b9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/commentLinks.js\":\"e1d11640904111b2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/confirmThreadDeletion.js\":\"f59df8c09c3e7277\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/container.js\":\"076f4c328b5c080a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/dataExtension.js\":\"a4b8946263d90a80\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/deleteComment.js\":\"d60792e56aa41b50\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/highlights.js\":\"0325ac3f6fc31bf9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/index.js\":\"bea0c518b15bff45\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/linkedCommentsPill.js\":\"b9c8cf3c14ef8dce\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/margin.js\":\"e789f90a1e51047e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/marginAnchorLinks.js\":\"93be86ca23c7a4f8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/marginSchema.js\":\"c687edb2a2f50b83\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/newComment.js\":\"3e3d7a2f4ea4ee0f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/ownThreadPicker.js\":\"d1045e0709647028\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/placement.js\":\"4e6df1d483bd450c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/queries.js\":\"72cb0e75972eec47\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/quotePosition.js\":\"0ebae3b131bd22ef\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/quotedIn.js\":\"9762f0da06e486b8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/quotedRange.js\":\"b3276ad416e2bb41\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/rangeRefs.js\":\"880570259e32087c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/readHighlights.js\":\"434ae01e03869fc2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/readSelection.js\":\"f2180875726449fd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/readSelectionUi.js\":\"89b36d503ff24df0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/reanchor.js\":\"99771af136be93a8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/schema.js\":\"f48d507f9294665c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/scope.js\":\"52f47e14fe01483d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/scopeThreads.js\":\"7432b16f11e0c44b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/splitRetarget.js\":\"aa451348fca3a389\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/suggestionCard.js\":\"884e3325f54e6c6f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/suggestions.js\":\"a785598a00256ed1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/summaries.js\":\"d95543c93b054876\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/summaryBatch.js\":\"e5b6b89cbe57aeb6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/surface.js\":\"cd63e92d4b77e1dd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/threadNavigation.js\":\"c5ad25991712abd5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/threads.js\":\"569cb61764a7f265\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/ui.js\":\"8d41fa502a72f73f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/annotations/uiStore.js\":\"2978e565775b02a4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/app-intents/appIntents.js\":\"603f3ce3aedda01c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/app-intents/index.js\":\"76f5377d2f80fc9b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/app-update-prompt/index.js\":\"3cddbf1cd4cf25b5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/app-update-prompt/status.js\":\"b1119c8e095ef853\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"28db0bcea8fde5d8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/MediaBlockRenderer.js\":\"5b7d9e3277174592\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e9ba0d8f08f58d01\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/MediaUploadReconciler.js\":\"3b7c9bea72aaef75\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/assetDownLane.js\":\"fded6589d9387112\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/assetResolver.js\":\"81a68d778e95ec71\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/assetUpload.js\":\"1d8d497559a1d7d1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/attachmentCleanerIO.js\":\"4ec0fd421f4875d0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/supabaseAuditIO.js\":\"bd1bf9c12ef0369a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/blobStore.js\":\"3a4af25477a60190\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/browserMedia.js\":\"344cd98706698441\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/byteStore.js\":\"7bb73fdd476e8b62\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/cleanerIO.js\":\"be74cab8b8d0feb1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/cleanupAttachments.js\":\"0c1fde4da06ae38a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/dataExtension.js\":\"c953004666a27c05\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/downLane.js\":\"88f9b0753283f157\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/index.js\":\"4047e458e57832a4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/insertImageContribution.js\":\"04c2a07f63dfb5e3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/laneArming.js\":\"5325dfc856c9929f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/laneLock.js\":\"9801277c8de2df15\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaBlock.js\":\"7d11e212d8a9dabf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaCapture.js\":\"6e39d4da1acbce54\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaLanes.js\":\"becc2097a06d64fb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaViewers.js\":\"3ebf058a9e30ab44\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/mediaViewersFacet.js\":\"d8c4cff06def616e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/pasteCapture.js\":\"f76ae298aa6503ed\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/resolver.js\":\"77701c89f56327e3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/retryUploadsAction.js\":\"089eda0fcd0d9235\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/storagePaths.js\":\"16365da586c39e1c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadDrain.js\":\"1550ac608fb9827f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadLaneStatus.js\":\"f0cf6a2ae82295bb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadReconcile.js\":\"e9e362f941e4a3cd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadRecovery.js\":\"ff6981315f448e3d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/uploadStore.js\":\"bc88b1d0736359aa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/attachments/useAssetObjectUrl.js\":\"29b9d69889e8c8dd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"756cab8aacd83c78\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/BacklinksViewSection.js\":\"719885021a4f95e5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/facet.js\":\"7cdd8e1045e6f5fc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/index.js\":\"fe06379af4627183\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks-view/prop.js\":\"ffca0dd8e19d32f0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/BacklinkFilters.js\":\"40986a1c9f8a950e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"c8d96205b635159a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/BlockEntry.js\":\"6a83ce1f42567ea4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/LinkedReferences.js\":\"df489d3917354e08\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9b6f8b71f4c0b458\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/dailyNoteDefaults.js\":\"f0d6048289645db4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/dataExtension.js\":\"1a982593acddaf70\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/edgeExclusions.js\":\"3d7f84d4dd33a3eb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/filterProperty.js\":\"77bf113fd0b340bb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/index.js\":\"56eddbd4669d9e8b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"3277d75f465a3121\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/applies.js\":\"d77bb3fe7133197c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/countQuery.js\":\"8da06952bbf23e1c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/expansionStore.js\":\"38a039dffbe604df\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/index.js\":\"643f61bf4ddc18e1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a056349cc760cc06\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/presentationInvalidation.js\":\"cd4f0349b2159a7e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/propertyEditorOverride.js\":\"febca723bf8a3f6b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/propertyFilter.js\":\"10a972283d80f36e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/query.js\":\"a65b2235398aeaf6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/resolveFilter.js\":\"3cad5f7340b9d46b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/sourceBatch.js\":\"c884fff3c637dd70\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/sources.js\":\"c32112ae52b602c8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/useBacklinks.js\":\"240c5d41887d0996\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"8025f3dd0bbf7e54\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/BirthdayCelebration.js\":\"e1f64372a6d94a96\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/BirthdayOverlay.js\":\"0921e099d67a9198\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/gate.js\":\"1d55f37381d6119d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/index.js\":\"7b51d0bddb1df5b6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/birthday/wolfTheme.js\":\"c7cfa5ba08f9d6ef\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/BlockDragLayer.js\":\"4ba16773dc038971\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/dragController.js\":\"abc54271a79b4ba3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/dropTarget.js\":\"9ace18b2079e1347\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/index.js\":\"726a413f2eae3576\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-drag/projection.js\":\"d9c2d24ac1889de3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-info/BlockMetaCard.js\":\"484b78b1bad8f1bc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-info/index.js\":\"705969f8b9cf2b50\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/AddTagDialog.js\":\"b340402e63299ae4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f7e79854988ae4cb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/TagNameIssueHint.js\":\"b04e1d629442d2f7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/addTagAction.js\":\"1997d89f8d71868a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/appendTag.js\":\"77fdd060d8e72ea2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/config.js\":\"b7476baaf169e198\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/dataExtension.js\":\"ea562be480f147cd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/index.js\":\"693a04c70897b923\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/block-tagging/propertyEditorOverride.js\":\"609f632b725d41ca\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/BreadcrumbList.js\":\"2bf1edb123645178\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"1dc8f6bc439804af\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/Breadcrumbs.js\":\"ccc02d07da197539\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"75e31f0406a85486\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"67f83d66c41c36af\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/index.js\":\"39e169698217edd5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d92f6917c93f2f65\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/CharacterCountItem.js\":\"8e09f6f004ead38e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/ProfilePropertyEditor.js\":\"bebd84f5f7f4fb55\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/actions.js\":\"8edea6d699519879\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/blockType.js\":\"2f40248e8f198303\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/charCount.js\":\"0622b9a0bc2ba3fc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/dataExtension.js\":\"6a3c6b778e04ef25\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/index.js\":\"ad006ed550ccc6d9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/profiles.js\":\"756fdcc354f922ca\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/properties.js\":\"5485012ea0f869c4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/character-counter/textCounts.js\":\"93137b2d68ae09c1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/colemak-keybindings/index.js\":\"aa93d1b8d23b0ce7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/CommandPalette.js\":\"eb037a7c5a3a365b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/HeaderItem.js\":\"f328d078a3aef237\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/context.js\":\"f1ced2898d595d7a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/index.js\":\"fd1ffb7b6c895656\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/selection.js\":\"46856cd2dd65a75f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/toggleStore.js\":\"bdc6073853d2b980\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/command-palette/useCommandPaletteActions.js\":\"1e8abfe77ae7d214\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/ContributorBadges.js\":\"0b3709da11917576\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/author.js\":\"26d8827ff622c512\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/codeMirrorExtensions.js\":\"f1ef856f7df80233\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/dataExtension.js\":\"6e1895887a468487\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/index.js\":\"c9f6dacce9598d65\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/mentionAutocomplete.js\":\"d30c9e4ec01e22a4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/processor.js\":\"afaf127dfebd93bb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/profiles.js\":\"40f4ef0c4030780d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/queries.js\":\"fa7efc7a1abf4257\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/contributors/schema.js\":\"b4fbb4603ddef8ca\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"6af9ae507f6e715b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/followOrigin.js\":\"344dfc7a5ac02c7c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/index.js\":\"a72fc6e7793c39d6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"fb125ccf040db69a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7fa7df0546db2508\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/CalendarGrid.js\":\"5078b3b0a71604e2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/DailyNotePicker.js\":\"95e5c0eb5020a4a1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"6424c9307efb926b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/DateNavDecorator.js\":\"573778fabfe1731c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/DateScrubOverlay.js\":\"c876cd1317b70a32\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/HeaderItem.js\":\"adb66ae834d24367\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/ReschedulePicker.js\":\"08e00186758b70e9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/SpreadDatesDialog.js\":\"e0060a170606f86e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/actions.js\":\"321e357400e2c3c4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/blockDateAdapter.js\":\"3c91f4eeb39a7618\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/calendar.js\":\"4fabd31e837c186a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dailyNotes.js\":\"1dbb89df4a0a303f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dataExtension.js\":\"78d5fbc99735fe40\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dateScrubActions.js\":\"391b8f8fd62d263a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dateScrubGesture.js\":\"88a3307d4883ec85\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dateScrubGestureActions.js\":\"ff5cc78b55296aee\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c3e314cbdab605e1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/deletionGuard.js\":\"bdde8a702aa6e73d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/dueQuery.js\":\"865e955c964eea4b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/index.js\":\"1c217ce9e204bcfe\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/landing.js\":\"e6d970a9f0b47ea1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/localSchema.js\":\"87a7edac2d40f861\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/referenceDateAdapter.js\":\"78f02158cbfb8a1d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/rescheduleAction.js\":\"f7bfe42135adc537\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/schema.js\":\"65863a27bfee4e80\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/spreadBlockDates.js\":\"337752fbe49c0b70\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/spreadDatesAction.js\":\"ccff1013bd40242d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/today.js\":\"48af93a5910d0508\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c1e598c2f533b01e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b417e229176dc4b2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/audit.js\":\"05919fa99aac2a0d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/auditAction.js\":\"8d7ab6cdafbe6539\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/auditRanges.js\":\"4c08c6dd80afc1b8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/diagnosticsSource.js\":\"6e1e011bd059b9bf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/divergenceScan.js\":\"fc577e28d81d2959\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/index.js\":\"93d073286fbbb449\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d1adb38c7856cf52\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/referencesMirror.js\":\"0a79b0369ad3127a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/rowJson.js\":\"c828752058125915\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/schedule.js\":\"cfb1573df3d05738\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/data-integrity/store.js\":\"6df58b7abb666862\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-maintenance/action.js\":\"51fa0053a2f846c5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-maintenance/index.js\":\"a57afde857affc45\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-maintenance/plugin.js\":\"04bdaaaca2d41c48\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"bb029854b385f43a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/actions.js\":\"a32f733adb9fc232\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/changeMarker.js\":\"15b591b6883f9a33\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/diagnostics.js\":\"88a9b515b5444bb6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/fileSystemAccess.js\":\"d66642ef05a5b729\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/filenames.js\":\"1ad9a5f53c1773d5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/index.js\":\"605aaa4625127938\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/mirror.js\":\"2f2e57aa93737ab7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/runLock.js\":\"ec4b2599d1d988ec\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/runtimeHealth.js\":\"b803b695f964360a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/schedule.js\":\"78176449ae163497\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/db-mirror/store.js\":\"e31bbed96782ff9b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/default-themes/index.js\":\"37ebdfe07d8f0ae2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/default-themes/themes.js\":\"a10134bf7e603f1e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/diagnostics/facet.js\":\"0f6ab13fad2a2bbb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/diagnostics/useDiagnostics.js\":\"ff0d5f9b6f5bbad4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extension-prompts/dismissals.js\":\"323338054a5f1a10\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extension-prompts/index.js\":\"dc0f7470f386dcc2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extension-prompts/status.js\":\"96c314ade32156d6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extension-prompts/store.js\":\"d5d7e82153489668\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"8f2145cd35874b2b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f3969c1b5bf50c98\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/actions.js\":\"5b9a0eff273f71a0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/config.js\":\"ad6a73a279be6aaa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/dataExtension.js\":\"a71577577315d384\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/effect.js\":\"12858e9cb30c0ede\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/index.js\":\"e4585931a053f1ef\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/propertyEditorOverride.js\":\"71f47c7962c7f6d9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extensions-settings/useToggleTree.js\":\"93194e77f7fde4ed\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/ExtractTypeDialog.js\":\"ec2f67627d389b18\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b85a661699096859\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/PropertyShapePicker.js\":\"1c6d2e76ea831ea3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/action.js\":\"1f4fc122d1902d08\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/extract-type/index.js\":\"d076f3a037982cfd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/FindReplaceDialog.js\":\"8fe502dbd0ace8c9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/HeaderItem.js\":\"fba06ca690df7e04\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/dataExtension.js\":\"ab8b672ec0b95b58\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/index.js\":\"6fa0733d3e10a2e8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/search.js\":\"84b24496ebf823b5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/toggleStore.js\":\"858b79c36504ab5a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/LocationPropertyEditor.js\":\"e0ea1c2f4699c55a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/MapView.js\":\"f77d8c90cb5ec7a7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/blockTypes.js\":\"5254a88a8692d6c7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/codeMirrorExtensions.js\":\"1bf3c357fb62a012\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/createOrFindPlace.js\":\"60079c87698a71df\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/currentLocation.js\":\"03fe9866d4ab6856\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/dataExtension.js\":\"f461aa1600019cea\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/geoContentDecorator.js\":\"47a9b32c28891a77\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/googlePlacesClient.js\":\"f73cd591f7b9fd47\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/index.js\":\"235bfa4ee97b8b5a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/locationsPage.js\":\"b583d86f42affab4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/mapViewport.js\":\"0fead4f6ba7765ab\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/pickCurrentLocation.js\":\"809f0c2ea0699f73\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/placeAutocomplete.js\":\"c98fb824d56ee619\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/placeNameCollision.js\":\"350532fda98a93ef\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/properties.js\":\"c8a2f02bdecf3d6b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/propertyEditorOverrides.js\":\"dccc0198274bb66d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/query.js\":\"5b6969a91a4d3fc9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/geo/usePlaceSearch.js\":\"cd87877f0a4c9168\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f222fe1007311611\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"808217094408019e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"94c14e59dd8f88ba\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/config.js\":\"8f17212c85a5e468\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/dataExtension.js\":\"bf69839faf1906da\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/facet.js\":\"0ab31f3d39c96cca\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/grouping.js\":\"f4115e51ce7a8a10\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/index.js\":\"2f50301ec08742b3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"db0f79e632a0e103\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/query.js\":\"3e86d9970ceda979\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/resolveConfig.js\":\"34a7705cd3ee0fa8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9dce642488828e59\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b0d4fa6333318b88\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/HtmlDocumentContent.js\":\"ff015453e15d2bba\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/HtmlFrame.js\":\"66e311fbac643220\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/actions.js\":\"db9f7079ef04da3a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/blockType.js\":\"e6dba1b6b78f9933\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/confirmRunScripts.js\":\"829aeb9177399c38\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/dataExtension.js\":\"603ecb4a8966e99e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/frameAnnotations.js\":\"aed094816cb19af6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/frameDocument.js\":\"faf98e35a2b1ef26\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/frameTheme.js\":\"77418aaacb264936\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/index.js\":\"c3fc53f0cd5daa25\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/scriptConsent.js\":\"c917813fb48d2f5d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/sourceMap.js\":\"aa6e1a1d9ad47fbf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/html-document/useDocumentScripts.js\":\"59e4a4c804c25e7b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/index.js\":\"3bcf3d51da617699\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/record.js\":\"c74be29b8b7694d8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/recordStore.js\":\"a4cc854d10564be2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/responsiveness.js\":\"29f33d3d3f11c993\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/schedule.js\":\"d035c6a1cc0761ba\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/interaction-metrics/sessionContext.js\":\"4602c647aec00760\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"6b470bf619e8477b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"6734f03fefbb3643\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/actions.js\":\"f150533f7ecc203b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/config.js\":\"c7667afb0f123615\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/dataExtension.js\":\"39e94a100d221b64\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/effect.js\":\"c1b802f6aec5d8f2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/index.js\":\"1a4c1519f4a1c52e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/keyCapture.js\":\"4228a391026eed25\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/overrideStore.js\":\"9b5829985d121051\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d6fda66e3257f8b5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/HeaderItem.js\":\"cee04477f10d8597\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/LeftSidebar.js\":\"25adbff8e9b12345\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/actions.js\":\"ddf57c276cd6d2f0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/facet.js\":\"6d5dd68166d61a55\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/index.js\":\"2f406a21fcb96066\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/shortcuts.js\":\"6208725812abb102\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/left-sidebar/toggleStore.js\":\"d4073b020f16c81a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/merge-blocks/MergePicker.js\":\"17e581592a5adeea\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/merge-blocks/index.js\":\"7be86cac01d29f77\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/merge-blocks/mergeAction.js\":\"34ca7e9f791eee2c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/merge-blocks/strategy.js\":\"8b65a5e5b35b4494\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/Button.js\":\"125ef520322f8a62\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"90927286eb450961\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/defaultItems.js\":\"cf132e34b3124be2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/facet.js\":\"ae59ba3a4b11c0ff\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-bottom-nav/index.js\":\"f4b36aaa42a7839b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"c186aa438c10b995\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/actions.js\":\"249ef6eb5fc1cab3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f0498323121ae951\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/facet.js\":\"621c64ccc4014cf2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/mobile-keyboard-toolbar/index.js\":\"9ae68eff0ff4593a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a9a34e2da1caf0d1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/blockSubtreeMembership.js\":\"75a8e1cb62477fb6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/contextMenuItem.js\":\"0a33d49c3eae536d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/index.js\":\"d97c6bdc3b2afd2a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/moveAction.js\":\"8ca3e6145333f61c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/moveBlocks.js\":\"a016fdef531fe515\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/move-blocks/selectionAfterMove.js\":\"7a5bc91830561cce\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/TutorialBanner.js\":\"0047211e2ca05ef6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/action.js\":\"7b286322fb661a39\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/bannerDismissal.js\":\"86bd39a67e8d322b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/documents/cheatSheet.js\":\"6af8424b06795e74\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/index.js\":\"fbeb9029e3ccf270\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/keys.js\":\"98437efd77f5fd93\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/landing.js\":\"5366c5b1de7af51b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/outline.js\":\"f74f0bc213dfe6ec\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/onboarding/seed.js\":\"eced4fa8059aae23\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/PerfTrendDialog.js\":\"12472ae775e73901\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/analyze.js\":\"8339099c79c2f3be\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/diagnosticsSource.js\":\"574ec03b8475ffcb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/index.js\":\"10cc443a927dc1ec\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/load.js\":\"761438e1feac34d4\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/monitorRun.js\":\"1a975fc3e4e4dddc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/schedule.js\":\"964a1b66979fb2e6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/series.js\":\"160e1645109f3945\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/store.js\":\"46ee10e9a1664e33\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/trendAction.js\":\"9e1a6e351b2147cf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/perf-monitor/verdict.js\":\"b7708c7717b43f53\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/plain-outliner/clickToEditAction.js\":\"952a379b91f1a61c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/plain-outliner/index.js\":\"1b5e4f31f1441291\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/plain-outliner/interactions.js\":\"ac85485340ae7bca\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"928574e6d22ce9de\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/MigrationGate.js\":\"65e9dff20aaaa26f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/MigrationGateDialog.js\":\"2116921dce75a77c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/action.js\":\"8f99bd6f5c4b5c0d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/index.js\":\"43eb2540fa2508ab\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/localRunMessage.js\":\"0cf521171786f3cd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/plugin.js\":\"8111546b8223a3a8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/progressReport.js\":\"7459ca9f6dd684b1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/properties-migration/sweepProgress.js\":\"3f80e9f2c0a3a1f7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/FieldRowRenderer.js\":\"4a90d38781397ebf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/ValueRowRenderer.js\":\"3f68b5f84c9bc318\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/actions.js\":\"6b8246ded89dd1dc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/autocomplete.js\":\"6820e0ca788136cd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/fieldRow.js\":\"ab7742aacd49703e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/index.js\":\"3895eb6a3c4d698d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/referenceWarning.js\":\"af68c3be66b27065\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/valueAutocomplete.js\":\"2d0495bb1ceb1fba\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/property-rows/valueSchema.js\":\"a6c38b063ed5a9ae\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/HeaderItem.js\":\"dc94d2e87fc311ee\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/QuickFind.js\":\"79f98118b04ddb2d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/index.js\":\"205196723c49a31e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/recents.js\":\"09d4baa7ebc6fb93\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/resultItems.js\":\"2299ff393a973717\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/selection.js\":\"6cb07fd2e9ea10cf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/quick-find/toggleStore.js\":\"9de08311d2f2e446\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/HeaderItem.js\":\"41456bd3f5cee2a2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/RecentsPageBlockRenderer.js\":\"fb243fc73cd1cceb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/grouping.js\":\"9299a344adf43f37\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/index.js\":\"a7d656e23522093f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/recents/target.js\":\"c53c697963b3ec1b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/codeMirrorExtensions.js\":\"65a7929c3e4ca162\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/contentPrefill.js\":\"48d918f4bf16070c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/dataExtension.js\":\"5ce460731c942523\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/index.js\":\"097e6f2d5ca45554\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a17caef61b62c48d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/invalidation.js\":\"b588685ed631b163\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/localSchema.js\":\"7bd86890d5d8aeb6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/blockrefs/index.js\":\"3f4f185ca61b2951\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f9af005ba322be64\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/index.js\":\"b3e8c5b4679d3b35\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/referenceNode.js\":\"3b701306e6afdd84\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/remark-reference-occurrences.js\":\"887bbc4f4d60ee6b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"03d3700f59f26bd0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/wikilinks/index.js\":\"9d172e9af990dced\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"0aae2a76b00624ed\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"63b844aeaf2b9f30\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/mergeRetargetProcessor.js\":\"ae2de44114c1afaa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/parseFence.js\":\"96c95a14c4ef6a3c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/referenceParser.js\":\"f034954752765fb5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/referenceProjection.js\":\"9db3f82731ff7a48\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/referencesProcessor.js\":\"749e4376f9167218\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/renameProcessor.js\":\"e01e695e3c0b6723\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/references/spanReplacement.js\":\"f3732f839fa7b549\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/rich-paste/htmlToOutline.js\":\"1a47c3321a58d714\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/rich-paste/index.js\":\"4e6c3e06bac5e8dd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/rich-paste/normalizeClipboardDom.js\":\"fcfd2a9c92932473\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/rich-paste/pasteDecision.js\":\"2768a9e2d22750b0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/action.js\":\"1df35c2f12db2989\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/blockIds.js\":\"9259286c70aa39ea\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/content.js\":\"28903a5f4f9a3373\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/effect.js\":\"0d5e247da8ba5183\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/ids.js\":\"50be78e96cfc5b3e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/import.js\":\"0f43cd3b6e8b5c57\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/index.js\":\"fc75fa87c0aff714\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/plan.js\":\"434f3beb488a634f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/plugin.js\":\"6f44c429b04d2f14\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/promotion.js\":\"bcc3f8598c8c2b30\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/properties.js\":\"cfc76dccc7e240c6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/references.js\":\"9cab51a4c80bc709\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/report.js\":\"e443fd47a1a634aa\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/roamMemo.js\":\"ad5103162cb4c78f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/runtime.js\":\"74c5d94995015f30\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/schemaReconciliation.js\":\"9634c7b588d6051e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/srsMarkers.js\":\"586816efe4513bf0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/todo.js\":\"fc04a5d13d86720b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/typeCandidates.js\":\"214e27618ce23d87\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/roam-import/types.js\":\"0b5dcce25bf8e385\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/search-health/index.js\":\"ba1a05714ca977c1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/search-health/store.js\":\"3adc76c46149a4a8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/HeaderItem.js\":\"cf99cc03f52b34cb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"10964f1d06ede207\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/index.js\":\"e1047f270bb82e32\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/model.js\":\"9b41a819a56b7f77\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/toggleStore.js\":\"b35c19169dbdb0e0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/shortcut-help/useKeyInspector.js\":\"3f31bb47e10dda8e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c0d04f3f90cc8531\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/ShellDecorator.js\":\"c63e67830e76c49e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/actions.js\":\"95df31a13f87fdfc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/exclusionsFacet.js\":\"448d81547da58f06\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/index.js\":\"21bef31229873b79\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/shell.js\":\"c90034e6d6cb428d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/surface.js\":\"dffcbaf4071be9d7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/spatial-navigation/walker.js\":\"bf9bc0b3b516a756\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/RescheduleToast.js\":\"2d3ace03fe45cb44\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/dataExtension.js\":\"6d366aab59291075\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/index.js\":\"90d2eb075d6075c6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/indicator.js\":\"a0855b60a7e3af88\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/moveSrsState.js\":\"e6f8bfa0d4a700ef\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9042188504a5d0ca\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/scheduler.js\":\"380ada8a860f0cd2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/schema.js\":\"3ef9f1e0a59af616\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"4f02fcd15a9ae7b8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/srsClipboard.js\":\"d8fcda6b6bcf4fbe\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"39338fa6e75f9848\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9ea9e4515e69acf5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/DeckPicker.js\":\"633f167a75bc1b21\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/ReviewControls.js\":\"7f5072ac4f41a286\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/ReviewDeckRenderer.js\":\"eb07a13925f8f4da\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/ReviewSession.js\":\"76f32bbf337e02d1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/actions.js\":\"49db99d8c24392c7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/archive.js\":\"083bf847de1afa34\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/dataExtension.js\":\"5ac782899be6e0d8\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/deck.js\":\"35c43049ac4ac0e1\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/dueQuery.js\":\"6e5727df0e8b09d5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/gradeDecision.js\":\"cfcdeade1c2e7f8c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/index.js\":\"fd1815e6cc389cfb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/keyHints.js\":\"4faa8a83cb3418fd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/reviewCardLayout.js\":\"0ecd9308bed451e0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/reviewProgress.js\":\"c560882a8955dab7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/schema.js\":\"62906547be2ec060\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/srs-review/useDueCards.js\":\"63f4a67954f22694\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/startup-metrics/index.js\":\"343ac6e7ef8900a5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/startup-metrics/record.js\":\"d625bb039ea0ea0d\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/storage-persistence/index.js\":\"b74836d338d4edc7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/storage-persistence/persistenceStatus.js\":\"1a35a25f8b8baf85\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/storage-persistence/requestAction.js\":\"58b87db128a4bca9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/supertags/TypeChipsDecorator.js\":\"acabde6e52904fbb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/supertags/codeMirrorExtensions.js\":\"788871f793345b45\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/supertags/index.js\":\"33ab0e261b40052f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/supertags/typeAutocomplete.js\":\"e4825ed97ae306f9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d6fa7eda4ac424f7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/actions.js\":\"96cfb036d37cb7c7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/anchor.js\":\"9ce2a98392d7fa83\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/events.js\":\"0c896383cc73f9a3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/gestureActions.js\":\"5938d05abe0e70a9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/index.js\":\"c045d9942119b8cf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1d1a416aafcb2e76\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/sync-metrics/collect.js\":\"c6625ffcae2129a2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/sync-metrics/index.js\":\"22e94907b3d2cae9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/sync-metrics/record.js\":\"d38a353ba44362d2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/RejectionDialog.js\":\"3afe451088f65e6b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/SystemStatusHeaderItem.js\":\"04747eafaaa5be7f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/index.js\":\"90031715781daf2b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/model.js\":\"2eaf333b2968d7e0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/queueCounts.js\":\"c1485ad1670450f7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/rejectedHelpers.js\":\"dbc69e76e64fcbbb\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/rematerializeAction.js\":\"158854d8ace01b09\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/system-status/useHysteresis.js\":\"d3b5bf4250f7ba57\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/ColumnHeaders.js\":\"9df6b84e294ad3c7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/QueryUi.js\":\"39334c5f077e48c6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/TableLayout.js\":\"dff4010af61ae202\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/actions.js\":\"6b5cabc2f42c9a86\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/cellEdits.js\":\"08cca6a91dbc1f3b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/childrenViews.js\":\"b725eeea9bfda405\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/columns.js\":\"875ece541f4d8623\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/controller.js\":\"6b76998d985ec521\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/convert.js\":\"3aee7e19afcd4bcf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/dataExtension.js\":\"b7d6cdad92765d76\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/index.js\":\"c25414d127c4aa90\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/keys.js\":\"5e3a6cecd7d98233\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/model.js\":\"d9c929532a6cc6b7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/backfill.js\":\"8e32ef16b3e5e8bf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/completion.js\":\"92c0ae2f0df1e960\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/format.js\":\"4d230f6c817ea653\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/parse.js\":\"83e715270eeb4e01\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/queryValue.js\":\"40f30864de192fc0\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/registrations.js\":\"f1eb02e100fc6faf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/query/source.js\":\"2dd62cf4404bfbf6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/registry.js\":\"482140262651f173\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/rowGutter.js\":\"581289153308bbde\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/rowVerbs.js\":\"9c5f47a6b9a97de5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/schema.js\":\"b65cf49f6dc4580f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/tables/sort.js\":\"108ef71df990cfaf\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/theme-toggle/effect.js\":\"8e477a3288debd52\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/theme-toggle/index.js\":\"0420c4098e227bf7\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/theme-toggle/theme.js\":\"7b52a18604855e1c\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/todo/actions.js\":\"a795e9572554f9fd\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/todo/dataExtension.js\":\"229444b329898270\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/todo/index.js\":\"92b5890a2e79b25e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/todo/schema.js\":\"4b7e20cd8d311cb2\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b47646435a9add58\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/actions.js\":\"200da563b808f23e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/defaultItems.js\":\"a90e6a3d4a367bb9\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/facet.js\":\"483a5c7d1327d937\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/holdRecognizer.js\":\"cb82e179b26e364f\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/touch-selection/index.js\":\"6b314e5883dc4ee5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/update-indicator/UpdateIndicator.js\":\"dbbab5420d9751b5\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/update-indicator/index.js\":\"fcb09c37c55a7263\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/update-indicator/loadTimes.js\":\"5bd52f6671f8de90\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/VideoNotesRenderer.js\":\"74d9c390b2bb0551\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/VideoPlayerRenderer.js\":\"1866f90f88a397d3\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/VideoTimeStamp.js\":\"91232489555e3019\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/actions.js\":\"4e53621ac0a06f20\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/index.js\":\"6a397af877835a53\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/markdown.js\":\"368a44894249c2da\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/notes.js\":\"a748929e44c0a28a\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/registry.js\":\"63866401278e9f28\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/remark-timestamps.js\":\"46b5708b0f29675b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/video-player/view.js\":\"4f020037532c66dc\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-link-hints/LinkHints.js\":\"e54afcca03c1ac0e\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-link-hints/index.js\":\"826d7bd7a6908b70\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-link-hints/model.js\":\"6a109c12d5ce5bde\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-link-hints/settings.js\":\"9c0fea1115a9560b\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-normal-mode/actions.js\":\"aa340afb6db87896\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-normal-mode/index.js\":\"7a087043078c9b41\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/vim-normal-mode/interactions.js\":\"44944124aa3bead6\",\"/knowledge-medium/pr-preview/pr-1878/src/plugins/workspace-header/index.js\":\"fb9f82666f6a8568\",\"/knowledge-medium/pr-preview/pr-1878/src/registerServiceWorker.js\":\"c9d394aca9b71f31\",\"/knowledge-medium/pr-preview/pr-1878/src/requestPersistentStorage.js\":\"6522b52733bec657\",\"/knowledge-medium/pr-preview/pr-1878/src/services/authRequestDeadline.js\":\"45698d3b2730a99e\",\"/knowledge-medium/pr-preview/pr-1878/src/services/authStorage.js\":\"2f1ed1d52564a1c4\",\"/knowledge-medium/pr-preview/pr-1878/src/services/powersync.js\":\"54c567a1431e08cb\",\"/knowledge-medium/pr-preview/pr-1878/src/services/supabase.js\":\"8425076d0b7f10ad\",\"/knowledge-medium/pr-preview/pr-1878/src/services/uploadErrorClassifier.js\":\"1bb636325fdcb1f7\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/ActiveContexts.js\":\"2ba641e1ff717704\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/HotkeyReconciler.js\":\"928ed7d189c4fb94\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/WipeLocalDataDialog.js\":\"60f4a7742e4372b6\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/actionDispatch.js\":\"a87b4aa8a34422b0\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/actionRefItems.js\":\"7e0901e7314a96d3\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/applyKeybindingOverrides.js\":\"e5ab9fc1392dfec0\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/blockActions.js\":\"7c156b23ef11d2d1\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/blockMergeGesture.js\":\"f81d5f4068be56b3\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/canonicalizeChord.js\":\"e205ee256a4326d7\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/defaultContexts.js\":\"86954e3c35d75116\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/defaultShortcuts.js\":\"768cb4e22417d95e\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/effectiveActions.js\":\"1c0a1c6fd185be73\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/gestureAction.js\":\"5f2236f368cd9df2\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/gestureBinding.js\":\"17b20b4abe60e229\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/holdRegistry.js\":\"f786b9b8ca0874ca\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/keybindingConflicts.js\":\"ab3b6af9726df24a\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/keybindingOverrides.js\":\"93d5045ebf7e137b\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/pointerAction.js\":\"7e6b719fb51fc154\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/resolve.js\":\"733e90e770aac1b6\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/runAction.js\":\"abe7dec72e344ce1\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/sequenceMatcher.js\":\"620e8b61b29a5003\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/types.js\":\"dc77a58bdf280239\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/useActionContext.js\":\"25d2c401bd5528f8\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/useActionDiscovery.js\":\"5fe10804a78ad6f8\",\"/knowledge-medium/pr-preview/pr-1878/src/shortcuts/utils.js\":\"58d512c7f13c9262\",\"/knowledge-medium/pr-preview/pr-1878/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1878/src/sw/bootStore.js\":\"bff5ac0739bf6e91\",\"/knowledge-medium/pr-preview/pr-1878/src/sw/previewDatabases.js\":\"986450d31025d465\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/byteTransform.js\":\"3fdeaea9c4c44cc4\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/attachmentCleaner.js\":\"1e86f8a0344b9e7b\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/attachmentParts.js\":\"457f6cba90807535\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/bundleParts.js\":\"9dfa2e72a6571f9d\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/bundleRecord.js\":\"304d399fcbe3ef0f\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/manifest.js\":\"fe7e8d2a1f6a0515\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/takeBundle.js\":\"5b4fd0fd6cf8004b\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/bundle/verifyBundle.js\":\"4cef3505ef1b23ba\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/cleaningStage.js\":\"1f33e6e31a6625ec\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/conversionKey.js\":\"2f9c68d2ffd9811a\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/conversionServer.js\":\"4033d3550a2b38db\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/flip.js\":\"447655bfc4580071\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/flipAttempts.js\":\"dd2c46fb9767236f\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/pages.js\":\"16f6281b76a2ff60\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/preflight.js\":\"3781f59b84e5dcdf\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/reseal.js\":\"e10058bfd701ad21\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/runConversion.js\":\"40578d8992f3b390\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/runLock.js\":\"cb22aaa8a2acc2f5\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/sealing.js\":\"2234044766a39c44\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/sealingStage.js\":\"8feefbdf435648ad\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/stage.js\":\"30e6e4fb6aae3248\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/conversion/verifyReseal.js\":\"36819ef088316f52\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/aad.js\":\"eaa48a3410324822\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/aead.js\":\"1eaa7884d1d9363d\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/base32.js\":\"d11c9a27cd48556d\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/base64url.js\":\"3ab9dc09138884c3\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/binaryEnvelope.js\":\"b3bfaab7875a29d3\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/byteAead.js\":\"bb3b93ce46496011\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/canary.js\":\"3a28df1995e5b641\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/contentHash.js\":\"2cc7d8001d90765c\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/contentKey.js\":\"0289963eeda89ff9\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/derivedIdNamespace.js\":\"ffd3a73262e7daf3\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/envelope.js\":\"4137aad46a1db3d0\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/hex.js\":\"ce4a5e8f0e499722\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/sha256Hex.js\":\"f37565ef9b98e593\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/crypto/workspaceKey.js\":\"23c84e11b0eab8dd\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/conversionState.js\":\"a0e95c2ed91227b2\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/flows/createEncryptedWorkspace.js\":\"b02cfb2325ea8cf3\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/flows/pastedKey.js\":\"1c9eedb3b7980d6d\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bfff13fd0aff19ac\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/flows/upgradeWorkspacePin.js\":\"05681ee66b99b983\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/keyStore.js\":\"d7af37683c5aec94\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/mintWorkspaceKey.js\":\"8e31115f0bea8b1f\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/modePin.js\":\"017f4143cbb73fb4\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/openWorkspaceKeys.js\":\"819caa6e4543419f\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/resolveWorkspaceEntry.js\":\"7976b2d86587b262\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/resolver.js\":\"36ce89a4fcaf49e6\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/keys/workspaceAccess.js\":\"f848de0f81f09166\",\"/knowledge-medium/pr-preview/pr-1878/src/sync/transform.js\":\"49849e94dc96e522\",\"/knowledge-medium/pr-preview/pr-1878/src/themeBootDefaults.js\":\"b88bf52b51f4d576\",\"/knowledge-medium/pr-preview/pr-1878/src/types.js\":\"a0fe13d6dfc37dc0\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/ClientLocalSettings.js\":\"2a598c668e327e36\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/abortableSleep.js\":\"4aa9fc5ededa2056\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/array.js\":\"7483e09255e62d4c\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/backlinkAutocomplete.js\":\"59f8ade23657b78f\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/blockCrumbs.js\":\"43d337df9681db18\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/blockrefAutocomplete.js\":\"f81b9a3598c8165a\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/cadencedIdleJob.js\":\"a2d18f73d59f00fd\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/callbackSet.js\":\"13e1e8de302e251b\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/clientId.js\":\"77268621be9ba771\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/codemirror.js\":\"8fbcdca5f09aa3dc\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/codemirrorCompletion.js\":\"7bb585d03c1f7bc4\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/copy.js\":\"1db143ebdcd88adc\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dailyPage.js\":\"b073666c02c3b37a\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dbForensics.js\":\"812ad50722887381\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dbForensicsHooks.js\":\"9ff23b2e3c67ea89\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/deleteBlockThroughUi.js\":\"f066cb6c1998e40d\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dialogs.js\":\"d8b666c6b3003a16\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/dom.js\":\"ee30de57ed78eaf9\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/downloadBlob.js\":\"66044eed88420b71\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/drawnWalk.js\":\"1d05ce323f49f85e\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/exportSqliteDb.js\":\"aa69803842f0f37e\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/fileSystemAccess.js\":\"ebe2b87c90e24956\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/flipSlide.js\":\"459d10291354065f\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/fnv1a.js\":\"c31314fa380929b9\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/formatBytes.js\":\"6afb2279a703a7e9\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/fuzzyRank.js\":\"ab89b013b0c2a3a8\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/idbKeyedStore.js\":\"442da36cafabcf77\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/idleCallbackPolyfill.js\":\"b2f50111e07e0697\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/keyboardAwareScroll.js\":\"b05d61bcfc0294f4\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/keyboardViewport.js\":\"d398cf86425030e2\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/lastWorkspace.js\":\"5584cdeeb2f2b573\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/layoutColumns.js\":\"e42fa023f9110f41\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/layoutSessionDom.js\":\"7454c6c293493ba7\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/layoutSessionId.js\":\"36da14da7f649ae1\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/linkClickGestures.js\":\"a553ae1480cf769a\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/linkTargetAutocomplete.js\":\"b42ffe8e5adb3a5e\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/localDbCorruption.js\":\"cf63b4a53481ff2c\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/localDbRecovery.js\":\"e288419e45f15b47\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/markdownParser.js\":\"c172f1ac0b787365\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/memoize.js\":\"3874e16ced2a8bbc\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/nameFieldCommit.js\":\"8310166ed29c3e05\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/nameList.js\":\"b8b24191726dac63\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/navigation.js\":\"e4db23812ffdc041\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/omnilinerNamespace.js\":\"6142357e5bdcd18e\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/opfsPageScan.js\":\"f411a04410b84696\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelClearance.js\":\"ae8f2b554ebb8727\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelHistory.js\":\"5046e15dd51b006e\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelLanes.js\":\"4024f93ceb3175e5\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelLayoutProjection.js\":\"c5546d219cb9e8b4\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelScrollAnchor.js\":\"bb54358f78d77197\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/panelUrlFlags.js\":\"cc73e367935b0080\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/platform.js\":\"530be0b9ca6db576\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/pluralize.js\":\"f1e10841933af458\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/propertyCreation.js\":\"572b48b554927f6f\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/propertyNavigation.js\":\"aa516dbf88d1487c\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/propertyValueContext.js\":\"e128b14e52e73699\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/react.js\":\"f486a367671f7a76\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/relativeDate.js\":\"e55274914592c1a9\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/relativeTime.js\":\"579741bdeb6fbe31\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/renderScope.js\":\"549e8dda8a0fc468\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/resolvedThenable.js\":\"7205f9742036d79a\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/routing.js\":\"71964289af929383\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/safeMode.js\":\"36cc6bb44c835e8c\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/scheduleIdle.js\":\"40b763c99f840b8a\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/screenWakeLock.js\":\"1a5eaf154a5e3f91\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/selection.js\":\"76494b59e36d5847\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/softKeyboardGrab.js\":\"5accec4dcccb24bb\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/startupTimeline.js\":\"0609c7521919c1cf\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/state.js\":\"bbc75f6d8a7c3513\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/string.js\":\"d5b244ebb0ffea94\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/surfaceZoom.js\":\"59e841374d3db566\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/time.js\":\"8da5f5ce6af639b0\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/toast.js\":\"303800808e210749\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/toggleStore.js\":\"6a8076a7a343c7e0\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/untilStopped.js\":\"063130e991b7fa88\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/userActivity.js\":\"b8d5fba963419a32\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/viewTransition.js\":\"2bd39a31193672a8\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/viewport.js\":\"0f9b09c79c312ff7\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/webLock.js\":\"8673f315c03bb1f7\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/workspaceRecovery.js\":\"ac208537c4471989\",\"/knowledge-medium/pr-preview/pr-1878/src/utils/workspaceSnapshotStore.js\":\"3f968fd2d01e1a65\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-compiler-runtime.js\":\"488909538d786988\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-client.js\":\"cf5cfb5f4a0fe83a\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-server-edge.js\":\"51a13fae15ca182e\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-server.js\":\"42175d8cda23e389\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-static-edge.js\":\"5c901a730a374444\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-static.js\":\"f38b55404605f614\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom-test-utils.js\":\"e2599ca481430104\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-dom.js\":\"dd943cc487ca9666\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react-jsx-runtime.js\":\"76a5c3cd170a4743\",\"/knowledge-medium/pr-preview/pr-1878/src/vendor/react.js\":\"8747b7ec2f26c98a\",\"/knowledge-medium/pr-preview/pr-1878/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1878/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1878/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
