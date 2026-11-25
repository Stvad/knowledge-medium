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
		buildId: "8d686acd3bcc-7ffb6b39",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1879/\":\"fcf2bb9fbbccb9c4\",\"/knowledge-medium/pr-preview/pr-1879/index.html\":\"fcf2bb9fbbccb9c4\",\"/knowledge-medium/pr-preview/pr-1879/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1879/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1879/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1879/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1879/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1879/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1879/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1879/assets/FacadeVFS-3KPqmSS1.js\":\"9caee2be2f309d97\",\"/knowledge-medium/pr-preview/pr-1879/assets/OPFSCoopSyncVFS-eDdK5pOt.js\":\"edf6c3d3480e3cc8\",\"/knowledge-medium/pr-preview/pr-1879/assets/OPFSWriteAheadVFS-C6c3p-hK.js\":\"6c8a73af640169d2\",\"/knowledge-medium/pr-preview/pr-1879/assets/wa-sqlite-CNO39PCt.js\":\"f50fd7ada9c01b76\",\"/knowledge-medium/pr-preview/pr-1879/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1879/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1879/assets/wa-sqlite-async-CNOry4Pj.js\":\"ae5fb9ef0acaad58\",\"/knowledge-medium/pr-preview/pr-1879/assets/worker-CDCWdeQ1.js\":\"c3ab3934b9aa20fb\",\"/knowledge-medium/pr-preview/pr-1879/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1879/chunks/app-VgMHfoOf.js\":\"90200ecaf6ea1bde\",\"/knowledge-medium/pr-preview/pr-1879/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1879/index.js\":\"ec0d7b5f0463be6b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1879/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1879/assets/AccessHandlePoolVFS-Cd3t_MCe.js\":\"d06e586e69a3ccd4\",\"/knowledge-medium/pr-preview/pr-1879/assets/IDBBatchAtomicVFS-CWZGG3Sc.js\":\"1ae71949fab43ea7\",\"/knowledge-medium/pr-preview/pr-1879/assets/MemoryVFS-BiNgvdiE.js\":\"c6678fc745c6221e\",\"/knowledge-medium/pr-preview/pr-1879/assets/mc-wa-sqlite-8eyGLNru.js\":\"4c72f6040bb3dd19\",\"/knowledge-medium/pr-preview/pr-1879/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1879/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1879/assets/mc-wa-sqlite-async-fWHFzOFw.js\":\"7985f85180a106f5\",\"/knowledge-medium/pr-preview/pr-1879/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1879/chunks/AccessHandlePoolVFS-CX66mAyV.js\":\"2ca78ce2a74613fc\",\"/knowledge-medium/pr-preview/pr-1879/chunks/FacadeVFS-D5CwcY2k.js\":\"3286c0bbfc6c4d85\",\"/knowledge-medium/pr-preview/pr-1879/chunks/IDBBatchAtomicVFS-Bzc2Olbg.js\":\"c3b0177481a1111d\",\"/knowledge-medium/pr-preview/pr-1879/chunks/MemoryVFS-BUozS7N7.js\":\"3f75738bd2b841b4\",\"/knowledge-medium/pr-preview/pr-1879/chunks/OPFSCoopSyncVFS-CPOYiWkC.js\":\"d82e4b8163d34f7c\",\"/knowledge-medium/pr-preview/pr-1879/chunks/OPFSWriteAheadVFS-0sXq6QjJ.js\":\"b39e4da9f8ceeffb\",\"/knowledge-medium/pr-preview/pr-1879/chunks/Preview-CQwFQWjQ.js\":\"0258117fc2c16969\",\"/knowledge-medium/pr-preview/pr-1879/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1879/chunks/card-BXPN8qT7.js\":\"db9893837334e92a\",\"/knowledge-medium/pr-preview/pr-1879/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1879/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1879/chunks/dist-BIjifbjX.js\":\"73cc29a28cd5eb75\",\"/knowledge-medium/pr-preview/pr-1879/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1879/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1879/chunks/mc-wa-sqlite-BBa47XBt.js\":\"d49b5d5409963e04\",\"/knowledge-medium/pr-preview/pr-1879/chunks/mc-wa-sqlite-async-DiEet_vN.js\":\"70bd3976a8d203d6\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-BDcBZCQh.js\":\"d0ca9ac8b0868ba4\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-Bcs44tOl.js\":\"60b5da44ad555994\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-Br8vZmTj.js\":\"762e4a1fc5177efb\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-CIi5hpQu.js\":\"0ba50acc3e5c4aba\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-D7NUxmQL.js\":\"968f6d7ea359b8e3\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-KIFdhozD.js\":\"d10fd5c5a02b3488\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-NqTMeAL3.js\":\"5932c59e01b2fc26\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-dom-server-legacy.browser.production-CRb4SRev.js\":\"80d8d50660dbbdec\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-dom-server.browser.production-DvWBfB6e.js\":\"f2422e1422745c2f\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-dom-server.edge.production-5fd9CnSp.js\":\"3f22a993aab1587a\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-jVpY0CWK.js\":\"586afce7f5b12e4d\",\"/knowledge-medium/pr-preview/pr-1879/chunks/server.browser-CVk8n1O6.js\":\"d3e832cf77aa1749\",\"/knowledge-medium/pr-preview/pr-1879/chunks/textarea-DVMkOVxT.js\":\"1da1b68c525e43df\",\"/knowledge-medium/pr-preview/pr-1879/chunks/ui-D72TyaeG.js\":\"49eb9c82b04453e8\",\"/knowledge-medium/pr-preview/pr-1879/chunks/wa-sqlite-BX9sd18l.js\":\"a7f1c41f7f2c1fa4\",\"/knowledge-medium/pr-preview/pr-1879/chunks/wa-sqlite-async-B4F1_ytC.js\":\"ee0f06b6b29a3594\",\"/knowledge-medium/pr-preview/pr-1879/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1879/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1879/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1879/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1879/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1879/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1879/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1879/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1879/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1879/src/App.js\":\"c376a6f8113c09fd\",\"/knowledge-medium/pr-preview/pr-1879/src/appUpdate.js\":\"7895d82894c4f0fa\",\"/knowledge-medium/pr-preview/pr-1879/src/appVersion.js\":\"8a6615bfa2a161e0\",\"/knowledge-medium/pr-preview/pr-1879/src/bootstrap/initialLayout.js\":\"65a29988c0c0db90\",\"/knowledge-medium/pr-preview/pr-1879/src/bootstrap/openWorkspaceData.js\":\"d91980675d37c26d\",\"/knowledge-medium/pr-preview/pr-1879/src/bootstrap/resolveWorkspace.js\":\"dbf6f57a355edb6c\",\"/knowledge-medium/pr-preview/pr-1879/src/bootstrap/workspaceBootstrap.js\":\"aba66f0b25f7c10e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockComponent.js\":\"b6b7c01b71e2cb57\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockCrumbs.js\":\"7a512891e95df519\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockEditor.js\":\"6e3278bbe246d7af\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockLoadingPlaceholder.js\":\"f41cf25a3eb09f10\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockProperties.js\":\"a59f9ba3142ce052\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockSearchPicker.js\":\"dcc0ad0a1a793efa\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ConfirmBulkDeleteDialog.js\":\"e9768b71bff9a7d6\",\"/knowledge-medium/pr-preview/pr-1879/src/components/DividerHandle.js\":\"771550b72cb000b8\",\"/knowledge-medium/pr-preview/pr-1879/src/components/DraftEditor.js\":\"5b45b5ba6bb40f3a\",\"/knowledge-medium/pr-preview/pr-1879/src/components/GutterPill.js\":\"45d6865525a7a162\",\"/knowledge-medium/pr-preview/pr-1879/src/components/Header.js\":\"caa8943eb0b2957e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/LazyBlockComponent.js\":\"ff1af04d0b8c1070\",\"/knowledge-medium/pr-preview/pr-1879/src/components/Login.js\":\"b4dfab93a995896e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ZoomableSurface.js\":\"84d5013486e84374\",\"/knowledge-medium/pr-preview/pr-1879/src/components/editModeKeepalive.js\":\"f79580d8a8f87109\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyDisplay/PropertyDisplayScope.js\":\"62519f7d7331f82f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1f2cc8cb2908b645\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/RefPropertyEditor.js\":\"aab1dfccdb24a1b1\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/RefTargetTypePicker.js\":\"7a550aebe331d2b6\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/SelectPropertyEditor.js\":\"f239dc52336f15a9\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/TypesPropertyEditor.js\":\"b256f73fd3416e96\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/defaults.js\":\"354e245aff70c47b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/kernelValuePresets.js\":\"8f2e10f7f1272e6e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/selectablePresets.js\":\"fbcbce6f85b407d5\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/typesPropertyUi.js\":\"a89c76fe4a77328f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/AddPropertyForm.js\":\"1fce02cb3c56b8dd\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/PropertyPicker.js\":\"767d21ba964f0521\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/PropertyRow.js\":\"bae1a2f5f096cdc4\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/Rows.js\":\"0fbdcbc6a55e9b33\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/actions.js\":\"7cb3a461f915d33b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/declarationOnly.js\":\"bea5ef2e012df123\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/layout.js\":\"78a4294c42c3987f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/model.js\":\"1ffed0850154cef6\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/shapeUi.js\":\"772a5c001c63d95a\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/shapes.js\":\"f494df178ecfdc2d\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e47248179384bc5a\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/visibility.js\":\"dd602e2e154158ec\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanelSections.js\":\"cd10d63b47cf5697\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/BlockEmbed.js\":\"3deb25e5cc440cde\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/BlockLink.js\":\"0f07ce5bf8d667bb\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/BlockRef.js\":\"4fa2db37c051edb0\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/ReferenceLink.js\":\"a231304018150e63\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/cycleGuard.js\":\"a81e5c66b9f900f1\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/cycleGuardContext.js\":\"b7759ff7834abeca\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/linkInteraction.js\":\"b8b481acd0d95ac7\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/referenceLayout.js\":\"f4ffd750a3218efb\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/useBlockRefAncestors.js\":\"648dc2b18bfd6869\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/BlockGutter.js\":\"2e0bae68ef901d63\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/BlockInfoDialog.js\":\"23375ada8dc0afc5\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/BlockTypeBlockRenderer.js\":\"84da2b73ba36e6db\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/BulletHoverCard.js\":\"3e6cf3ce701ad2b3\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/CodeMirrorContentRenderer.js\":\"7d081d9faf04e6c0\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2d61f9be27da11fe\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/ColumnResizeHandles.js\":\"352da11f920cbcfb\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f16b47d2f5424305\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/DefaultBlockRenderer.js\":\"b6d860402ab4675e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/LayoutRenderer.js\":\"07bb952a11fd35c9\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/MarkdownContentRenderer.js\":\"44abade956f2c7d9\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/MissingDataRenderer.js\":\"28f372b3336e4429\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/PanelRenderer.js\":\"ace5a4b90f9c01ca\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/PropertySchemaBlockRenderer.js\":\"30b549daa6503f18\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/TopLevelRenderer.js\":\"22f6726e8df810eb\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/blockGutterMode.js\":\"e991814aaf821213\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/blockTitleText.js\":\"ffd3384eb0417e3e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/fieldCreationKeydown.js\":\"6b854d24421d307d\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/layoutRootContext.js\":\"5e6ef613a9f28d1f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/typeChip/TypeChip.js\":\"df9906470a7164bc\",\"/knowledge-medium/pr-preview/pr-1879/src/components/typeChip/chipStyle.js\":\"c2b6ded0e85c69f8\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/anchored-floating.js\":\"b5278233b13beb8b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/button.js\":\"e43890a36e6f69c4\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/card.js\":\"9eaf3a1ab742cf0a\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/checkbox.js\":\"17a22af583d34349\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/collapsible.js\":\"10ae87f3912d274d\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/command.js\":\"24a47c6ff57f97f5\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/context-menu.js\":\"1b679998130d8be2\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/dialog.js\":\"6c9bb13b5a72cc4f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/dropdown-menu.js\":\"c42d0054ee57e63c\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/floating-listbox.js\":\"0f6ca6b10214c140\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/index.js\":\"cc44be5c3252dc51\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/input.js\":\"04d8691ec1c5d373\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/kbd.js\":\"77a663de816dcc0c\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/label.js\":\"2bd1b9a7213c8262\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/textarea.js\":\"df689837e9b56055\",\"/knowledge-medium/pr-preview/pr-1879/src/components/useEditModeYieldKeepalive.js\":\"a10d35b3cd0da96b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/BootFallback.js\":\"de1227a89790e21d\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/FocusedRowLazyMount.js\":\"a9396d598ab89f2f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/LazyViewportMount.js\":\"a2dd718569d7727e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/LocalDbCorruptionFallback.js\":\"ce8b40e5e03849a2\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/error.js\":\"b2d9dd997d125ca8\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/lazyMountRegistry.js\":\"87e3e8f11a116776\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/suspense.js\":\"ee091c9c653d4819\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/CreateWorkspaceDialog.js\":\"27f26e00100ec5b5\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/PendingInvitations.js\":\"19d5ca94589fba2c\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/SyncProgress.js\":\"c03d4d8ed3e791ca\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/UnlockProgress.js\":\"ddbd9ac8e96a47dc\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/WorkspaceKeyGate.js\":\"80023ae0d9a27de7\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/WorkspaceSettingsDialog.js\":\"96ab2a62de2ee4a7\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/WorkspaceSwitcher.js\":\"8e046948172e939e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/WorkspaceSyncGate.js\":\"97d45f122852a4a4\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/ConversionFlow.js\":\"4d8843143fc4d15d\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/ConversionFlowHost.js\":\"437df2c5e244c553\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/EncryptionSection.js\":\"2d5602df3419eb4e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/attachmentPrompts.js\":\"e2f763fe7f46bf52\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/bundleFolderPrompts.js\":\"2c56e22ca42896dc\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/conversionFlowDeps.js\":\"0a9bd7c55f5764c9\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/conversionFlowStore.js\":\"2ba6f482016ec477\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/flowUi.js\":\"26f7681627e087f6\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/useConversionRun.js\":\"75f58fc10c2fb2c9\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/keyUi.js\":\"bd7da557e5653cc0\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/useCloseOnKeyLoss.js\":\"e4d76aca25db3aac\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/useCloseOnServerE2ee.js\":\"adeee6a93661769a\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/workspaceUnlocked.js\":\"ae32cb330681751c\",\"/knowledge-medium/pr-preview/pr-1879/src/context/backgroundSubtree.js\":\"68a2f81352b802b9\",\"/knowledge-medium/pr-preview/pr-1879/src/context/block.js\":\"4e65ea972629ab8f\",\"/knowledge-medium/pr-preview/pr-1879/src/context/layoutWsContext.js\":\"7be4836f8e7b76d6\",\"/knowledge-medium/pr-preview/pr-1879/src/context/propertyDisplay.js\":\"680801867a98de30\",\"/knowledge-medium/pr-preview/pr-1879/src/context/repo.js\":\"de8225e923240488\",\"/knowledge-medium/pr-preview/pr-1879/src/data/aliasClaim.js\":\"09b09fbd689eb46e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/aliasSeatNamespace.js\":\"b76239a61664b08b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/blockData.js\":\"9dbb2743bc69aee4\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/blockType.js\":\"017730a56a03a16c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/changeScope.js\":\"d35489a301457a3c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/codecs.js\":\"d906de775ad4f311\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/derivedData.js\":\"ba7af1f033c4ea6d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/errors.js\":\"ac53e93f36be0504\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/events.js\":\"1f57739b0b84cb6e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/handle.js\":\"48f59aff90a6291a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/index.js\":\"6273f5a60a310368\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/mutator.js\":\"47a795d365273beb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/processor.js\":\"8744c1944a9722c8\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/propertySchema.js\":\"c1b510d4d2341e6f\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/query.js\":\"66e8e57280751b15\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/sameTxProcessor.js\":\"dfc124f4dd5174f8\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/schema.js\":\"48f59aff90a6291a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/tx.js\":\"48f59aff90a6291a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/typedBlockQuery.js\":\"f0df6c03a01e9048\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/user.js\":\"64ab16e59a3ca403\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/valuePresetCore.js\":\"6cc4349d519acd73\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/valuePresets.js\":\"2b2f2dc0eec15b0c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/attachmentCleanerIOVerb.js\":\"ad27c110daf85a25\",\"/knowledge-medium/pr-preview/pr-1879/src/data/block.js\":\"789f43a83f4a4fe2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockCache.js\":\"27b47118bad5191f\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockId.js\":\"5cd1993a224c3165\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockLiveness.js\":\"f442914393eec9ee\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockMerge.js\":\"571081bb98b176e1\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockSchema.js\":\"7f3a5af2e1ca8912\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockTypeLookup.js\":\"ab15aab8a1651375\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockTypes.js\":\"1a6fd60fb26a3940\",\"/knowledge-medium/pr-preview/pr-1879/src/data/childrenView.js\":\"8639326a0849e395\",\"/knowledge-medium/pr-preview/pr-1879/src/data/clientContext.js\":\"04b93d334b5115ef\",\"/knowledge-medium/pr-preview/pr-1879/src/data/dbFileSiblings.js\":\"83190b69b49821c3\",\"/knowledge-medium/pr-preview/pr-1879/src/data/definitionSeeds.js\":\"bded248018323034\",\"/knowledge-medium/pr-preview/pr-1879/src/data/derivedIds.js\":\"a75602a2cf7efede\",\"/knowledge-medium/pr-preview/pr-1879/src/data/drawnSubtree.js\":\"b729e57eff53f257\",\"/knowledge-medium/pr-preview/pr-1879/src/data/facetBridge.js\":\"399ac18f0503df10\",\"/knowledge-medium/pr-preview/pr-1879/src/data/facets.js\":\"98211c5013f070df\",\"/knowledge-medium/pr-preview/pr-1879/src/data/globalState.js\":\"013da2270ffca1f8\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/aliasClaimRederiveProcessor.js\":\"648416fe636215bb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/ancestorBatch.js\":\"af7035d6e332fc04\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/blockTypeTypeifyProcessor.js\":\"0f35289f3e11ab8d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/clientSchema.js\":\"8b73884867e29590\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/commitPipeline.js\":\"00edf4f0aa69ddfd\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/devAssertions.js\":\"07cc8dc6d6c13298\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/firstSync.js\":\"6e2e899774d79118\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/freshInitialLoad.js\":\"09717bc3ce3174cc\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/graphBackfillClaim.js\":\"36b9ce1b6adabde3\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/handleStore.js\":\"a76ccfa684e2ea1b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/idleMarkerJobs.js\":\"416652ded30dbc8c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/initialDownload.js\":\"7555bbf6a5b4fe21\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/initializeClientDatabase.js\":\"9c3f799115c774d0\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/jsonCanonical.js\":\"121ea85a118264f0\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/kernelInvalidation.js\":\"359708645647bc13\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/kernelProcessors.js\":\"2a28d5fd92b39ce5\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/kernelQueries.js\":\"0178046e8c6a4af9\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/mergeTypeMembershipProcessor.js\":\"7de1af7e48f4bfdd\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/normalizeReferencesProcessor.js\":\"fc72f8920bdaeeca\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/poolInstrumentation.js\":\"f5b3ec743bcf9123\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/processorRunner.js\":\"e5be0d9be20de5bb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyCellBackfill.js\":\"90a9c02504b72370\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyChildMint.js\":\"ad052eed852fa41a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyChildrenProcessor.js\":\"a7deb93bcc08f354\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyDefinitionChangeProcessor.js\":\"340d24b648ab8f32\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyDefinitionSynthesis.js\":\"79817b4b4a9818fb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyKeyScan.js\":\"9eb21dfe84aabe4c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertySchemaResolution.js\":\"d1787ff6d7bf2151\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyValueEdits.js\":\"8ea06df1b6826a19\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/raiseProtocol.js\":\"4094749dfef37247\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/readBatch.js\":\"fd1dc95b02389e82\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/refProjection.js\":\"a25029f2732b50f6\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/referenceTargetLookups.js\":\"ce33f037e2fabb10\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/referenceTargetProcessor.js\":\"490ff338956e96e6\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/replayMerge.js\":\"36fd699ba6b0f2df\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/sqlBinds.js\":\"af2038e7fc561e6e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0ee957b9680d28dc\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/arrivalProcessors.js\":\"28e878a297acc923\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/invalidate.js\":\"25994dadbd890327\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/materialize.js\":\"a43b555d04fa6798\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/observer.js\":\"f4af611c3112a90c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/reconcile.js\":\"a9b38ada50f72142\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/timingMetrics.js\":\"756974a21436554e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/treeQueries.js\":\"e4bf337918120aa1\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/txEngine.js\":\"dedc704d55df078d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/txSnapshots.js\":\"88f99592bd6f256e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/typedBlockQuery.js\":\"48eb5a5eec3ea1fb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/undoManager.js\":\"d3ce702237ca1acc\",\"/knowledge-medium/pr-preview/pr-1879/src/data/invalidation.js\":\"2a50c7a68bcef015\",\"/knowledge-medium/pr-preview/pr-1879/src/data/kernelDataExtension.js\":\"a4f85294689a24a3\",\"/knowledge-medium/pr-preview/pr-1879/src/data/kernelPage.js\":\"5c38f5a9612efcef\",\"/knowledge-medium/pr-preview/pr-1879/src/data/kernelValuePresetCores.js\":\"03c873238b338166\",\"/knowledge-medium/pr-preview/pr-1879/src/data/localDbCorruptionSignal.js\":\"918d5c5bba6b44e2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/localDbStorage.js\":\"cd841fe77af04c71\",\"/knowledge-medium/pr-preview/pr-1879/src/data/localDbVfs.js\":\"de272d5e918001a4\",\"/knowledge-medium/pr-preview/pr-1879/src/data/localSchema.js\":\"abec9949d1652f6d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/maintenance.js\":\"93e43b2adb1e5869\",\"/knowledge-medium/pr-preview/pr-1879/src/data/mergeProperties.js\":\"f8f1961cbe431956\",\"/knowledge-medium/pr-preview/pr-1879/src/data/metricsConsoleHook.js\":\"a2a3037fe0bdb8bc\",\"/knowledge-medium/pr-preview/pr-1879/src/data/migrationsPage.js\":\"aa3e55d3f166e883\",\"/knowledge-medium/pr-preview/pr-1879/src/data/mutators.js\":\"ed121563bd271bf3\",\"/knowledge-medium/pr-preview/pr-1879/src/data/orderKey.js\":\"28f8eb9af684df3e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/orderKeyPlacement.js\":\"482fe9bc72cc363e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/outlineSurface.js\":\"dfd059d791b8157d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/pendingEditorContent.js\":\"1d26b8b25a7fefad\",\"/knowledge-medium/pr-preview/pr-1879/src/data/pendingUploadsSql.js\":\"4fed88fab3cbd1a6\",\"/knowledge-medium/pr-preview/pr-1879/src/data/pluginStateExtensions.js\":\"09122761d99a5d19\",\"/knowledge-medium/pr-preview/pr-1879/src/data/powerSyncLogger.js\":\"f7760f4c7c74e45e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/projectorRuntime.js\":\"55e5885537e9bd45\",\"/knowledge-medium/pr-preview/pr-1879/src/data/properties.js\":\"91bb19dc717e6f20\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertiesPage.js\":\"cb08451bb45482e1\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyChildren.js\":\"c445af883c4ac90e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyDefinitionFanout.js\":\"4c6e129fa9285dff\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyDefinitionMetadata.js\":\"ff58d481532eac54\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyDefinitionRegistry.js\":\"3ec6312e9a8454ab\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyDisplayMode.js\":\"6d4a058e1283f5eb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyRowCreation.js\":\"76dba9d1b2b06e11\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertySchemaCreation.js\":\"e19248f55643f8ed\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertySeeds.js\":\"9e82b0bd3462ee02\",\"/knowledge-medium/pr-preview/pr-1879/src/data/recentsPage.js\":\"2cd7f7e1eb8e879a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/refTargetComparableProperty.js\":\"c32fcaad233bfe93\",\"/knowledge-medium/pr-preview/pr-1879/src/data/referenceBlock.js\":\"ee3da9fbdd2e6ccd\",\"/knowledge-medium/pr-preview/pr-1879/src/data/rejectedUploads.js\":\"3df62a3211fcee2f\",\"/knowledge-medium/pr-preview/pr-1879/src/data/releasePowerSyncConnection.js\":\"f8951027b241cba5\",\"/knowledge-medium/pr-preview/pr-1879/src/data/repo.js\":\"de2dbbe7dbc38372\",\"/knowledge-medium/pr-preview/pr-1879/src/data/repoProvider.js\":\"573e1b03007824e1\",\"/knowledge-medium/pr-preview/pr-1879/src/data/rowProperty.js\":\"65d9ca309c2e24bf\",\"/knowledge-medium/pr-preview/pr-1879/src/data/searchFilter.js\":\"037579d758a5b75f\",\"/knowledge-medium/pr-preview/pr-1879/src/data/seedIdentityLedger.js\":\"92c3307455b0085f\",\"/knowledge-medium/pr-preview/pr-1879/src/data/stateBlocks.js\":\"6b2ccc54fd968f12\",\"/knowledge-medium/pr-preview/pr-1879/src/data/structuralEditPolicy.js\":\"336f5576b7753d2a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/structuralInsert.js\":\"a6b1bc7cc7023621\",\"/knowledge-medium/pr-preview/pr-1879/src/data/subtreeDelete.js\":\"7879d40e989e9e0c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/syncStreamLock.js\":\"7ab4ff1914e168cb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/syncedTableSqlRecognizer.js\":\"29ae195b3ab67f4e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/syncedTableWriteGuard.js\":\"1b26b7c81de5f95c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/targets.js\":\"d9348d46f9e2e507\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeColors.js\":\"3a3b7ad6549cb976\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeDefinitionMetadata.js\":\"017e158c07d736e0\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeDefinitionRegistry.js\":\"5f8ea307fe365d68\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeExtraction.js\":\"8791e20ec549ed3a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeInitialValues.js\":\"360c9d1ff0fccef4\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typePropertyGroups.js\":\"8301412adc5f8346\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeSeeds.js\":\"d64509eccdc60436\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeTagger.js\":\"5cd5dfea9dc0d459\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typedRecords.js\":\"4d971868d31e8a24\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typesPage.js\":\"98234230a5d92b29\",\"/knowledge-medium/pr-preview/pr-1879/src/data/userPrefs.js\":\"a66b295f27273048\",\"/knowledge-medium/pr-preview/pr-1879/src/data/userSchemasService.js\":\"71dc3726b8b2058b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/userTypesService.js\":\"8bffef8f966f84ff\",\"/knowledge-medium/pr-preview/pr-1879/src/data/valuePresetRegistry.js\":\"297d8e71f8606f46\",\"/knowledge-medium/pr-preview/pr-1879/src/data/visibleChildren.js\":\"f575809f57f4d0a5\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaceConversion.js\":\"9cecf4cf902b2ccf\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaceFirstSync.js\":\"140d3c6fc25aa256\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaceIdNamespace.js\":\"b2d06b3aaa4b1678\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaceSchema.js\":\"8292a6f7dea85592\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaces.js\":\"6289b4777a448fbf\",\"/knowledge-medium/pr-preview/pr-1879/src/data/writeAheadLog.js\":\"69bf9c9e67f4c244\",\"/knowledge-medium/pr-preview/pr-1879/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/BlockPasteShellDecorator.js\":\"6bf44442e2f94bf3\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/atTrigger.js\":\"d73a33507e7fa05a\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/autocomplete.js\":\"7f272b6af98fcd6f\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/codeMirrorExtensions.js\":\"c79dcaaf684341bb\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/contentFlush.js\":\"2930b59c9af84a7f\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/defaultInteractions.js\":\"f042bc9c45e82373\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/editSettleSignal.js\":\"b2e049e54168708f\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/insertImage.js\":\"ad034439d405680e\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/referenceCompletionRange.js\":\"a63d30b6d3b82ab0\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/referenceTargetTypes.js\":\"dfaf12884c06354a\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/syntaxContext.js\":\"fa4153d1b552acb1\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/triggerMatch.js\":\"827b90069be0de8c\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/AppRuntimeProvider.js\":\"de1ec019dc664d49\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/BlockFocusShellDecorator.js\":\"a6480a18f5d97125\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/ExtensionRenderBoundary.js\":\"e41e2c124a7a3b74\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/PanelContentRecovery.js\":\"9d5b79f373740b41\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/apiCatalog.js\":\"09f052f7b4abd8a8\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/approveExtensionHere.js\":\"975d4a3e02f45470\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/armedCutAppMount.js\":\"ad30d8514c975c80\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/batchableKeyedStore.js\":\"a44f5d896c78b177\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/blockInteraction.js\":\"3a0c9f74d72e3763\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/blockSelectionAction.js\":\"9c6de7c8347c011e\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/compileExtensionModule.js\":\"8a7309b7758a3829\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/compiledModuleCache.js\":\"79180369c2f1fdcb\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/continuousGestures.js\":\"d7d613d41aeafe1b\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/core.js\":\"1fb8b1111aa0b11b\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/defaultRenderers.js\":\"fa9048f00e4005d2\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/definitionFanoutAppMount.js\":\"034c5d2bf250390d\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/dialogAppMount.js\":\"b26665ebaa934a00\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/dynamicExtensionSeeds.js\":\"5d0cdc3bc0e50597\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/dynamicExtensions.js\":\"1120914c944da6e9\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/exampleExtensions.js\":\"f81d8740a6ac3d9b\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionApprovalStatus.js\":\"c8a0a0edd98e4a05\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionLoadErrorToast.js\":\"f62910770085acca\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionLoadErrors.js\":\"b5bbc8cbd4ffdac1\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionLookup.js\":\"5052ed5be6562520\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionToggles.js\":\"779a19eba340b457\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionUtilitiesCss.js\":\"58ebdfc0cee2aaf8\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/kernelPageDeletionGuard.js\":\"65aba791aea9fedd\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/liveRuntime.js\":\"7ac61c69e77bf4f3\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/openExtensionsSettings.js\":\"f20d92ab97d889ab\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/overridesCache.js\":\"7c74342bd0c0b56c\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/pluginIds.js\":\"813717b815f9a80d\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/processorRejectionToast.js\":\"f70ed74e3adcfa78\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/runtimeActions.js\":\"0d7d3e7c2b982933\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/runtimeContext.js\":\"2b90615bab5f8a66\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/staticAppExtensions.js\":\"0c9f7a65fbd4742a\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/staticDataExtensions.js\":\"151f73dc1388a29f\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/toastAppMount.js\":\"0a29584f9ef5c6c4\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/useOverrides.js\":\"237662b88af0f3c2\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/useShortcutSurfaceActivations.js\":\"4c64d8047057bf0d\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/discoverToggleTree.js\":\"c20441241da25368\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/facet.js\":\"538b0f5c6af2da06\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/resolveAppRuntime.js\":\"5cd982b0d98b30b3\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/runtimeEvents.js\":\"167d1b740639cb70\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/togglable.js\":\"e51ea35468ec7cfe\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/variantFacet.js\":\"ec4f8f134d2815fe\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/verbFacet.js\":\"0af2a8393f9703cb\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/block.js\":\"b63af8bee90ad7c4\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/focusedChild.js\":\"3b41a0f6f2fbc736\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/propertySchemas.js\":\"824f098d663b6b57\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/typeRegistry.js\":\"ef82a5a877db0e5c\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useAncestorCrumbs.js\":\"802908725a0c21f7\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useAutocompleteListbox.js\":\"6659300715bc0ebb\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useDebouncedSearch.js\":\"eca49def224f009a\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useDebouncedValue.js\":\"c724304a9aff732f\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useFacetValue.js\":\"3e233e8a657f2974\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useIsFocalRender.js\":\"107779fe8e04332d\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useIsReadOnly.js\":\"b1b564ba1e6f54c2\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useMaterializeBacklog.js\":\"18215467dea87cd5\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useMinuteClock.js\":\"0bdb7ee092ef2636\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/usePanelLayoutProjection.js\":\"f113805f5a83dfe5\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/usePendingInvitations.js\":\"3b65c096df1c8034\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useRendererRegistry.js\":\"252fdfc20840f929\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useRetainedFieldRows.js\":\"51afb3e0aa706693\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useWorkspaces.js\":\"0fb00f36bcbb295f\",\"/knowledge-medium/pr-preview/pr-1879/src/lib/utils.js\":\"06e00cbb21d488bc\",\"/knowledge-medium/pr-preview/pr-1879/src/main.js\":\"3db2bf517a47eba1\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/MarkdownImage.js\":\"220ea542eeb1973b\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/blockSeparators.js\":\"620f363472af5f76\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/context.js\":\"a4450d2719268028\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/defaultMarkdownExtension.js\":\"5eaeb286368f3f83\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/extensions.js\":\"5a56480b5e0e6c10\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/renderMarkdownHtml.js\":\"a140659d38c9451d\",\"/knowledge-medium/pr-preview/pr-1879/src/minimal-editor.js\":\"414aef0d75a9f0ec\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/armedCut.js\":\"7509d348941f88e4\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/captureMediaVerb.js\":\"081cd114e45b1703\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/clipboard.js\":\"4a1e34b2200f7b2d\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/decision.js\":\"2d02212b15f34b71\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/operations.js\":\"8241c63a81011ce4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/account-header/AccountHeaderItem.js\":\"8c5831638e510d0b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/account-header/index.js\":\"d9f2037162cdb133\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"d8e86908ade8661d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/askAgent.js\":\"a0c94a53a66894be\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/askedStore.js\":\"642add3c51e588fa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"51bd3b33b7eb19e7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/chipState.js\":\"59eabe3fb04dfaa9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/dataExtension.js\":\"bf6080b864830e02\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/index.js\":\"91f3d15cf334b9a9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"56ad318d8b808eea\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/schema.js\":\"2051b2419b7dd3d4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c2d3776c45983ce7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/BridgePairingDialog.js\":\"d82c938bf03e095a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/addMedia.js\":\"deac77e5a9214feb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9a7ae5950bef8dab\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/block.js\":\"7669add4f74dac46\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/context.js\":\"789356be93a4bdd0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/displayIds.js\":\"be7420329fa757b6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/index.js\":\"1389e9df64b308b9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/outline.js\":\"e397b2399f7abf33\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/properties.js\":\"c93f9d737bebca5d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/refs.js\":\"08f445caa19fc5ea\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"20aab5adc1771ab1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/search.js\":\"df493486cf0741d5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/shared.js\":\"098dc28ba657ee82\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"8a537e6d30ca2d16\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/text.js\":\"53bfc319e2356f96\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentWrites.js\":\"5472c6f2aa45acf2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/authoringCatalog.js\":\"6d4f3678fea10838\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/blockRefTargets.js\":\"07800caad7e91472\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/bridge.js\":\"37c0f4b1eab61940\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/bridgeLoop.js\":\"f0eac48777d0523c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/changeHistory.js\":\"386ae65df810b561\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/commands.js\":\"e3855aa8d0c5eb9b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/commentsCommands.js\":\"2f9085385efb1dfc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/dataExtension.js\":\"6cd5fdccf60ebb74\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/dataModelGuide.js\":\"665fbe234f7c787d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/dayPropertyInputs.js\":\"734113077173bfa0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/describeRuntime.js\":\"0da5694f8b056c48\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/extensionLint.js\":\"ec5078e5484575a4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/grainAudit.js\":\"dfc8168639dc0099\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/healthCommand.js\":\"668a2067be5b1571\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/index.js\":\"f81ee466f3d83dd8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/presetIdentity.js\":\"73d2aa171b1d0195\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b2f9a3f94ec83966\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/readMedia.js\":\"eff8f3fab8b91954\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/schema.js\":\"271519061de80bc4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/serialization.js\":\"8d31d16eb62c48c7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/targets.js\":\"364e83cae64ad435\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/tokens.js\":\"5394e43b690f810a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/watchEvents.js\":\"1c7dca48791e1c1a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/workspaceGuard.js\":\"4afa559c111a33cd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/writeCommands.js\":\"0d81b61131f107dd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/AliasCollisionToast.js\":\"6ecf86307170a8da\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/DuplicateNameBanner.js\":\"f4ce634f983dbc2f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/collisionMerge.js\":\"cf11bfe600f8b698\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/dataExtension.js\":\"ba0987e70c9b8fa0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/index.js\":\"d9fe4de9754c9ee2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/mergeCollisionAction.js\":\"e9189d9d742d2dfe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/pageStyling.js\":\"1ded0073905c990b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/rejectionToast.js\":\"4edc669d1f3fadc9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/syncProcessor.js\":\"680d7a0bc8580560\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/actions.js\":\"01027d50619de40a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/addComment.js\":\"8fd8d7c847e3026f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/anchor.js\":\"2d3521ab76e0eff7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/anchorState.js\":\"7d5872733908be01\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/commentLinks.js\":\"ad82a8b2358dd504\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/confirmThreadDeletion.js\":\"7b4becb7c40ab91b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/container.js\":\"e60acce07c9ff426\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/dataExtension.js\":\"60ae8308bcd8ccb1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/deleteComment.js\":\"dabd9f486ea9fc75\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/highlights.js\":\"555f687c5626e990\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/index.js\":\"6286f49eae5f925d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/linkedCommentsPill.js\":\"03e15513a1161619\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/margin.js\":\"366e77631bd781f9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/marginAnchorLinks.js\":\"7c00069eafc1aca6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/marginSchema.js\":\"cbd2c1fa4b8c05cc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/newComment.js\":\"f72f426385752114\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/ownThreadPicker.js\":\"75dec9e10555fb48\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/placement.js\":\"f4f8988842651802\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/queries.js\":\"dbeb3afe4c102ba4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/quotePosition.js\":\"5d69719992d3972b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/quotedIn.js\":\"29265bea9aeb1a3f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/quotedRange.js\":\"10d472e6040ac30f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/rangeRefs.js\":\"4f184530b8c14069\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/readHighlights.js\":\"2d0e3e57b0611bee\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/readSelection.js\":\"23a59a198dc01215\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/readSelectionUi.js\":\"fec6220d89b4b000\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/reanchor.js\":\"d058f82019e46218\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/schema.js\":\"b663fc4bd8448ac1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/scope.js\":\"5a6adbc0ed5c4a3d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/scopeThreads.js\":\"49682b6373405558\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/splitRetarget.js\":\"eb493f9da1ad5747\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/suggestionCard.js\":\"aec5ec49a08c65b1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/suggestions.js\":\"bd104f2e07399fb9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/summaries.js\":\"31a7f0f93a02d456\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/summaryBatch.js\":\"3d154806ff7f057e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/surface.js\":\"fb6530f90f5e1fb3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/threadNavigation.js\":\"cf364d8127486d1e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/threads.js\":\"238efd1d8f4b54ce\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/ui.js\":\"81c78bc570843ed8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/uiStore.js\":\"513508ea2c912430\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/app-intents/appIntents.js\":\"c527ef50adae513b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/app-intents/index.js\":\"a10aa086372c1cb8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/app-update-prompt/index.js\":\"49a69b6f85b19404\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/app-update-prompt/status.js\":\"cdc47fcfeb3b2135\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e2fe6ffaa728f520\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/MediaBlockRenderer.js\":\"30b1f5e9fc9a353e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c0468172491bb737\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/MediaUploadReconciler.js\":\"bcbf9a23898fbc56\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/assetDownLane.js\":\"2b50bfda33d3f5d8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/assetResolver.js\":\"5804ae13a0f4f473\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/assetUpload.js\":\"873a78a2921d7956\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/attachmentCleanerIO.js\":\"6d811c2407dcb7d7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/supabaseAuditIO.js\":\"70aa94f001cbb4b0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/blobStore.js\":\"378aa580008da5dd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/browserMedia.js\":\"1d58d2c0dd37d488\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/byteStore.js\":\"1313d9642fbae197\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/cleanerIO.js\":\"a7a9492e2d9c412b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/cleanupAttachments.js\":\"61bc8f6370cf2470\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/dataExtension.js\":\"c48be9f6bc4c84ea\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/downLane.js\":\"0c2506c0cad5dac8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/index.js\":\"bf2249b9a819dfd6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/insertImageContribution.js\":\"7aaf1e894e2a6620\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/laneArming.js\":\"bab38ec2d85786f1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/laneLock.js\":\"bee33e8f4a516c3c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaBlock.js\":\"cf76824d4eeab06b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaCapture.js\":\"1f1f76a986e313c3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaLanes.js\":\"3674b99d94e6a597\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaViewers.js\":\"963ca4500e69fac4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaViewersFacet.js\":\"205da3ce31b18439\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/pasteCapture.js\":\"f5956b8bc9e7d4c0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/resolver.js\":\"5abdf357282843cf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/retryUploadsAction.js\":\"e2a8d63dfd30734d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/storagePaths.js\":\"895e8dc24e7ed82b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadDrain.js\":\"6f7ace5ebc3267f7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadLaneStatus.js\":\"31ee39b0461c5d07\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadReconcile.js\":\"3ee15ae4161a15c9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadRecovery.js\":\"cc7ab02d1b81cc3a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadStore.js\":\"d1c5f41873730f80\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/useAssetObjectUrl.js\":\"0c753291c3fc15bd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"15515d3e94eaa811\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/BacklinksViewSection.js\":\"dc3d4e80b44e1ff8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/facet.js\":\"fc22570d73ea6dfa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/index.js\":\"fba323f77a6d12e0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/prop.js\":\"245e8a3b6dbb2688\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/BacklinkFilters.js\":\"49bf0a112d6f2695\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"438203790c464502\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/BlockEntry.js\":\"2a9f942dffc3811c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/LinkedReferences.js\":\"ff76b93967e1f8d2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"2d6a65317e829421\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/dailyNoteDefaults.js\":\"2c2a96e4e843f91c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/dataExtension.js\":\"79b3a54790196588\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/edgeExclusions.js\":\"10a0f3e0a0e9432a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/filterProperty.js\":\"3b07316833275922\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/index.js\":\"1901c3ce7cc64c37\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ed99ce5ab589a321\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/applies.js\":\"0a8b141a4886cb57\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/countQuery.js\":\"64069bda98d7ba78\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/expansionStore.js\":\"2396b7ac31417da7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/index.js\":\"d832ab38f61d4ddd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"1ae1b42291b2575d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/presentationInvalidation.js\":\"7c1e1d23a48d0dfa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/propertyEditorOverride.js\":\"d75bdf819fe351af\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/propertyFilter.js\":\"e6f3081543500314\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/query.js\":\"814363aea2959985\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/resolveFilter.js\":\"d3d0b0789ab55acf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/sourceBatch.js\":\"d7ecd249c148b12a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/sources.js\":\"f96dc5d728eaca8d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/useBacklinks.js\":\"f7cd85bcc7a1831f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d2445b6be55f2b72\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/BirthdayCelebration.js\":\"1d098e87a868676b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/BirthdayOverlay.js\":\"8b3055904d0923c3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/gate.js\":\"69b651be5b42fdaf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/index.js\":\"3ce4439e363bf974\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/wolfTheme.js\":\"2a8ed666b8c63a4d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/BlockDragLayer.js\":\"d72de6aeabe03979\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/dragController.js\":\"548a073c03541be7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/dropTarget.js\":\"1a51d381721f90f7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/index.js\":\"51d164904bcaa733\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/projection.js\":\"8bc509cf740965a5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-info/BlockMetaCard.js\":\"5564c2082b93847f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-info/index.js\":\"9200b5cbab01971b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/AddTagDialog.js\":\"687d34d688149850\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"cfad3e26fd4e4f4f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/TagNameIssueHint.js\":\"68ad7d80c2506f40\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/addTagAction.js\":\"cba9ff5095bc916f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/appendTag.js\":\"10b5dc35def36ca3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/config.js\":\"b2fcf889a8cdf1f3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/dataExtension.js\":\"f790e21b8251dc64\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/index.js\":\"d12f8e89d69874fb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/propertyEditorOverride.js\":\"6f345ce75eeabafc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e3659d39b8fd306a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"99a6d2d703ab0a4e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b8fb31caeffcddf8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2b1fa52816952c20\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"36268745aa12e56f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/index.js\":\"999435ae86918232\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"89ad21c5b9728abe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/CharacterCountItem.js\":\"abbf91e2049d6649\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5aefcd4241548353\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/actions.js\":\"72f22a017d55a76a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/blockType.js\":\"64cbb7f8993d3039\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/charCount.js\":\"a54d6921eeae8cfb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/dataExtension.js\":\"e1a080ef08073a4f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/index.js\":\"09592f1215a5faac\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/profiles.js\":\"0532917e47c9b52f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/properties.js\":\"cdf8b7bde236606f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/textCounts.js\":\"d75a2cd27936aea5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/colemak-keybindings/index.js\":\"720f4797933f1499\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/CommandPalette.js\":\"04327ebf6ac5c94b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/HeaderItem.js\":\"191e158d487c3893\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/context.js\":\"3d8a98dcfd6c4ef2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/index.js\":\"71830c81e7e829cb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/selection.js\":\"0c67034e7fdb9867\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/toggleStore.js\":\"4d5a17ef188db0a3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/useCommandPaletteActions.js\":\"9ae7ff16a7e6434d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/ContributorBadges.js\":\"bc4f1c960b6d4293\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/author.js\":\"ecc2b85eb6e2dc9d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/codeMirrorExtensions.js\":\"7b792d0e40ba7c6e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/dataExtension.js\":\"91930464beb55c35\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/index.js\":\"df8584a339842258\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/mentionAutocomplete.js\":\"c60695a15dbd6e83\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/processor.js\":\"43c2034bf8e82da8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/profiles.js\":\"d2edf3b9ab9e4d6f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/queries.js\":\"8d83da3bdeaed640\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/schema.js\":\"2b2c6d653f2f75e9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"75afe2df93842a2b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a922a7dfb2670eb5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/index.js\":\"1e79f3c516ef30fc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"77bdb9af8e6e8308\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0cc8720f19e34aab\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/CalendarGrid.js\":\"a11c15cfb5b0fffe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DailyNotePicker.js\":\"bf8d28c4f478cf22\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"19152d788e833b72\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DateNavDecorator.js\":\"33cd2dea56b8acfc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DateScrubOverlay.js\":\"346455f2b0061e89\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DayPropertyEditor.js\":\"e7575a531daa623c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/HeaderItem.js\":\"f0b7c867071e6175\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/ReschedulePicker.js\":\"d0dfaf3c09b15c98\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/SpreadDatesDialog.js\":\"e6801cce0f657d4b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/actions.js\":\"631a2c2f342ffd31\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/blockDateAdapter.js\":\"48310bebcf78110f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/calendar.js\":\"522456e79f5f8d79\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dailyNotes.js\":\"1fb0707cb4a943e4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dataExtension.js\":\"237df00ecd32d496\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dateScrubActions.js\":\"fe42cf2c46465c50\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dateScrubGesture.js\":\"bfe3ab9c7ef20b96\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dateScrubGestureActions.js\":\"867e579d6af3ae1e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f972b4cf7dcb4f2c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dayProperty.js\":\"0fa9dc539eb0ee8b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/deletionGuard.js\":\"e690d31403813067\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dueQuery.js\":\"bb3e67626c113088\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/index.js\":\"4e7484035baadb29\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/landing.js\":\"d439c2418cbe1012\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/localSchema.js\":\"60e59193f2aa8c98\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/referenceDateAdapter.js\":\"72415b8a33b6adb8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/rescheduleAction.js\":\"235dd2aca8175a4d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/schema.js\":\"6616094b4cb4d7af\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/spreadBlockDates.js\":\"5210a525bbd90792\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/spreadDatesAction.js\":\"f7920e4c4d4a7033\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/today.js\":\"282095f33e522d5b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"89b6c51fc9c9ad36\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"0c5b187980eebbb6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/audit.js\":\"d7f2ecc99a43efbc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/auditAction.js\":\"6a5b6ce8f6d20711\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/auditRanges.js\":\"6f95ef35964eb0d3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/diagnosticsSource.js\":\"5f6e652436590d23\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/divergenceScan.js\":\"8ed8a2a7f731bcd5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/index.js\":\"1a15411f0d9d0ab6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/propertyChildrenChecks.js\":\"eae4b419cd28ce47\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/referencesMirror.js\":\"775147caf2a2e3f5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/rowJson.js\":\"7e10129450fb4c95\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/schedule.js\":\"33fdbb633fb0a918\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/store.js\":\"56dd6d9043dbf528\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-maintenance/action.js\":\"66ae1799dc0f665b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-maintenance/index.js\":\"830b6830b5d9aa3e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-maintenance/plugin.js\":\"02e9d2ec9f635464\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"047d81c20a7a8dae\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/actions.js\":\"665a4ddc414b54d3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/changeMarker.js\":\"45df7afecfa535ed\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/diagnostics.js\":\"eab5788130348492\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/fileSystemAccess.js\":\"a5d05b02e2e3eec5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/filenames.js\":\"56826fec90c6c138\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/index.js\":\"852d7ceb17d0250f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/mirror.js\":\"6eefa7dc9b6b3572\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/runLock.js\":\"cd826d4c1c388a8a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/runtimeHealth.js\":\"5d0b5b8b32399283\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/schedule.js\":\"1715f427a66ecbb3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/store.js\":\"10787e2ed84c68da\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/default-themes/index.js\":\"c68946e2d57ec2d7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/default-themes/themes.js\":\"f7294d6e7a97c767\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/diagnostics/facet.js\":\"92077769049c687c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/diagnostics/useDiagnostics.js\":\"2c1461447ac9fd93\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extension-prompts/dismissals.js\":\"083e9d8ac2825c79\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extension-prompts/index.js\":\"a20e640658a6834a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extension-prompts/status.js\":\"fd0422c875c53c41\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extension-prompts/store.js\":\"e28c1005f060a3cc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"046189071e966884\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ea6d58c67b68c545\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/actions.js\":\"73602e704d99eb80\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/config.js\":\"f804a3465f6f9760\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/dataExtension.js\":\"551c6755546aaeed\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/effect.js\":\"16cfbdab89639599\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/index.js\":\"a59fff8fb61fd8f6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7ba04fa68f35a757\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/useToggleTree.js\":\"75006c3118e7c516\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/ExtractTypeDialog.js\":\"08d57c47517c155d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"dd657873d8e1f08a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/PropertyShapePicker.js\":\"061d5ae65c100954\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/action.js\":\"c395bd5045925cce\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/index.js\":\"58003b80b4b29edf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/FindReplaceDialog.js\":\"38be90aeb38fa1bc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/HeaderItem.js\":\"0b6b653a84bdb77d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/dataExtension.js\":\"0295964f6ac82ac4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/index.js\":\"e54ae29e38711ca0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/search.js\":\"a917dc8949210cd5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/toggleStore.js\":\"665ee00be52a92de\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/LocationPropertyEditor.js\":\"093ab67eafe31277\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/MapView.js\":\"ad6375243d3c4092\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/blockTypes.js\":\"dc5c68170c785a0d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/codeMirrorExtensions.js\":\"c5bf8e1c819e57f1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/createOrFindPlace.js\":\"517e2d2fa07f85d7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/currentLocation.js\":\"53cde097b574d7bc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/dataExtension.js\":\"5a657dc96a231870\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/geoContentDecorator.js\":\"509f232eb61f5513\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/googlePlacesClient.js\":\"4328b5199a48bd73\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/index.js\":\"e1074a5d5aec194c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/locationsPage.js\":\"0274a5429bcaf1a9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/mapViewport.js\":\"49b60445869780b5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/pickCurrentLocation.js\":\"6f6d1b08c57223d7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/placeAutocomplete.js\":\"485a08a6513defe0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/placeNameCollision.js\":\"1138a2d7e39c1abf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/properties.js\":\"8c53125acd72aeda\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/propertyEditorOverrides.js\":\"f0c4c3c4cb8a3722\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/query.js\":\"d362f12fcf6f43fe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/usePlaceSearch.js\":\"209835553f54d786\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"09b54b65771c5630\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"98f594b6422cf25a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"83cfdae1fcd85f12\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/config.js\":\"4ee09d9c03f6f00c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/dataExtension.js\":\"439350a7534ccf14\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/facet.js\":\"ffc0ccf0b5cc30f0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/grouping.js\":\"0a2e9abb745b64c6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/index.js\":\"8661f8312e879656\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"be434a7282b7befb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/query.js\":\"5219b6cb78a97849\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/resolveConfig.js\":\"103d2e1d7b51d630\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9e76bb80fffaaebc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b3e9e717af438819\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/HtmlDocumentContent.js\":\"220f1ca2ef666500\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/HtmlFrame.js\":\"e6d5ad1a7eba9ba0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/actions.js\":\"0e34005bae803304\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/blockType.js\":\"c8da96b52495be6e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/confirmRunScripts.js\":\"ca6b152b34e06430\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/dataExtension.js\":\"4044cbea4698fb95\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/frameAnnotations.js\":\"8a3e97f09b9ef0fe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/frameDocument.js\":\"9653fafb4f08dad8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/frameTheme.js\":\"68948b8a18054ac1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/index.js\":\"7a512efbea245fd8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/scriptConsent.js\":\"9f36234684eaea75\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/sourceMap.js\":\"89c4f4386a5d4ae6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/useDocumentScripts.js\":\"4ad283a8e0fdfb8a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/index.js\":\"f6d46e647cc7d525\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/record.js\":\"6f06c2a96208a48d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/recordStore.js\":\"9ed2555b9b92835c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/responsiveness.js\":\"04cc655c9a2e8cc0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/schedule.js\":\"17cefb4a48cbd5fa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/sessionContext.js\":\"cbafb66ea1300dfb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"3ccb17c61af4875c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"113385c07167b056\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/actions.js\":\"318ffcbc18277427\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/config.js\":\"8387d605c4fce2a8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/dataExtension.js\":\"4693c680562a56f6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/effect.js\":\"323c2c53f32f922e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/index.js\":\"f9f52edd81e26aca\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/keyCapture.js\":\"8e1bc304581edf87\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/overrideStore.js\":\"0aa321ea7d2712dc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"14079e8e2a1a3030\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/HeaderItem.js\":\"0125da9745eb6b07\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/LeftSidebar.js\":\"99e20daa7a483f2f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/actions.js\":\"36b56b7419b0c3e0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/facet.js\":\"401be7544bb588e9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/index.js\":\"26192bb51fc33818\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/shortcuts.js\":\"32bb5036016b0ccb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/toggleStore.js\":\"4b0c1d10b393b6d8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/merge-blocks/MergePicker.js\":\"2c25887e6ed10708\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/merge-blocks/index.js\":\"e8d8b3a553d98233\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/merge-blocks/mergeAction.js\":\"f6ee8c38cc65848a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/merge-blocks/strategy.js\":\"4a8455122679e295\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/Button.js\":\"19e1b471bfce403b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"33ce3f24a0d8e004\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/defaultItems.js\":\"25318cd7b87d848a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/facet.js\":\"ed587ecaa5f0525e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/index.js\":\"6cecbde35078f06a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"aa6d3b18727c8faa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2700c3a7f413cebe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"2971222549be35b1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/facet.js\":\"08f03860708d8aaf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/index.js\":\"57695a2d1bffb4ee\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/MoveDestinationPicker.js\":\"73bf902a092817f3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d9c536aaf4f25649\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/contextMenuItem.js\":\"fc7c096fda7ce618\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/index.js\":\"00b8606479dafd40\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/moveAction.js\":\"b553042d4b34d41f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/moveBlocks.js\":\"d09ec5fb7fdcb3ce\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/selectionAfterMove.js\":\"d372f6b9853f1f16\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/TutorialBanner.js\":\"928dabe22aaa76e5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/action.js\":\"6f0f7e2ee9b06d7c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/bannerDismissal.js\":\"d0ea0fff6cac28da\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/documents/cheatSheet.js\":\"34fb73b684d956e8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/index.js\":\"b25ff72ac626aaa3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/keys.js\":\"b58b7fb7676c7f5d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/landing.js\":\"c8ed82d6018b188f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/outline.js\":\"d96eea47cb27eb4d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/seed.js\":\"24a3af9079697268\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/PerfTrendDialog.js\":\"771bea183b0f4c8b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/analyze.js\":\"1430a2946ce13e73\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/diagnosticsSource.js\":\"f307a77b8395cacf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/index.js\":\"2e584fac72ec107a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/load.js\":\"236befd0006b16b8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/monitorRun.js\":\"34eb47cf92285bab\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/schedule.js\":\"abf1353041ed39b6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/series.js\":\"2396621d1eeb938f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/store.js\":\"1cf1ea8727b099c6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/trendAction.js\":\"3a69953fb91f569b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/verdict.js\":\"6e35b5b7cd2af900\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/plain-outliner/clickToEditAction.js\":\"cd923c24f9714c39\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/plain-outliner/index.js\":\"3ab3e0a145001383\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/plain-outliner/interactions.js\":\"dae80c774fee466d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5745670e78ffbf3d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/MigrationGate.js\":\"65704571d12d5926\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/MigrationGateDialog.js\":\"37b79f0e6415f12d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/action.js\":\"44d243d1abfed09e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/index.js\":\"2987f2efbb32cc9a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/localRunMessage.js\":\"cbb3dc67fd74dda1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/plugin.js\":\"56e65a8caac63ffd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/progressReport.js\":\"6894cb16770d2807\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/sweepProgress.js\":\"86936f243deaf61b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/FieldRowRenderer.js\":\"2d98d8560b8e2b6a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/ValueRowRenderer.js\":\"a44fb083456bdc1e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/actions.js\":\"8cb0bb41d701a266\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/autocomplete.js\":\"e4f0a0a4257c689e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/fieldRow.js\":\"b60aa96ebdbd8fbe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/index.js\":\"b3443858c8c1d2de\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/referenceWarning.js\":\"54594549a23257f8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/valueAutocomplete.js\":\"478ff5522791f6cb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/valueSchema.js\":\"c9f6a280eaae184a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/HeaderItem.js\":\"073c1c5efe27ed1a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/QuickFind.js\":\"dd39e4e744d5c269\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/index.js\":\"81306c589be8eb59\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/recents.js\":\"3f592dcb4381b245\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/resultItems.js\":\"57199cba254ed56e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/selection.js\":\"63ec0c1e9e51c6bb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/toggleStore.js\":\"60c8808532659c86\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/HeaderItem.js\":\"afe7a7974502a7c1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/RecentsPageBlockRenderer.js\":\"3911871c5fd03991\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/grouping.js\":\"f3a341d2f2a4739c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/index.js\":\"101234904e594294\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/target.js\":\"d565b202d0274cf0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/codeMirrorExtensions.js\":\"4b857febab27a383\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/contentPrefill.js\":\"b1abda73a1be80a7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/dataExtension.js\":\"0f0e0ee910ab445b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/index.js\":\"2444457b540c45fd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0315d077df3208ab\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/invalidation.js\":\"5c051cc2257845d2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/localSchema.js\":\"61e4a4734c3ce799\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/blockrefs/index.js\":\"b04afdf057fc0d45\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"08789d8437fce610\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/index.js\":\"ba6bb4565e823ec3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/referenceNode.js\":\"2590ea53eb1c97ee\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/remark-reference-occurrences.js\":\"976c1d4bf92b3911\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"3dbdf725d525ae90\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/wikilinks/index.js\":\"d9ee38a63aa05bd3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"63cc6fa1a8ef30b5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"81188c44fa09ece7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/mergeRetargetProcessor.js\":\"66b58560cc39ec88\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/parseFence.js\":\"8adaad89bf458db8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/referenceParser.js\":\"eed82a8767425f98\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/referenceProjection.js\":\"6fc796e557522668\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/referencesProcessor.js\":\"a982387477a99c9d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/renameProcessor.js\":\"6590f400c3206b72\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/spanReplacement.js\":\"c79ae54162f47b4e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/rich-paste/htmlToOutline.js\":\"866f66bf5cb8c4ca\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/rich-paste/index.js\":\"da4cf2758b7caeba\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/rich-paste/normalizeClipboardDom.js\":\"9236a27fecb8e1c3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/rich-paste/pasteDecision.js\":\"61ffa41ffc6f0f3b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/action.js\":\"4ccfc1ea2c4a6316\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/blockIds.js\":\"f9789eeffd7235bb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/content.js\":\"14ced6379ff197cc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/effect.js\":\"884c9c3aee43222d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/ids.js\":\"dc6fc9fdcb2f0156\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/import.js\":\"b9c87676794e3171\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/index.js\":\"f2f5fd2465768ddb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/plan.js\":\"a41f9faf356c3dc6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/plugin.js\":\"233ab4c8d1b65973\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/promotion.js\":\"d74175c5f89aecdd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/properties.js\":\"bff1ae96e824de06\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/references.js\":\"4adfa0b9350266c7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/report.js\":\"c9616c84bd0e7a9f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/roamMemo.js\":\"320a8f8a72443cae\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/runtime.js\":\"c029c1eeb7b59e62\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/schemaReconciliation.js\":\"46793cbcf2cadd0f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/srsMarkers.js\":\"7822f8018f636364\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/todo.js\":\"adc70ed05d679c17\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/typeCandidates.js\":\"943e851fd5bb5c4f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/types.js\":\"fa847699b37c7ea5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/search-health/index.js\":\"382c5b0ca1e62c69\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/search-health/store.js\":\"464de54c3a339610\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/HeaderItem.js\":\"6e5bf726274504fc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"71257473aa5b96ac\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/index.js\":\"1494297e0e55866f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/model.js\":\"91430fb35add7ce2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/toggleStore.js\":\"44ca8b7fe4622ee6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/useKeyInspector.js\":\"aecfeded970fd1d5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5f0bbc660db76224\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/ShellDecorator.js\":\"9b74c15087cbf97d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/actions.js\":\"043d2384ce93e0b1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/exclusionsFacet.js\":\"28914e068da8d510\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/index.js\":\"d71470ab9aa737c9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/shell.js\":\"836603ce36882651\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/surface.js\":\"ef5ac015d14bdb30\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/walker.js\":\"59b06b7812a9b31f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/RescheduleToast.js\":\"965b77c1a0b61358\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/dataExtension.js\":\"1981682272813b0d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/index.js\":\"1ab2ea9280e2ffd8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/indicator.js\":\"ce810e8fd1dfa75f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/moveSrsState.js\":\"7ed76914e785e51d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0cb25df97efd8e2d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/scheduler.js\":\"184478e8fe6d4c4f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/schema.js\":\"153ef838d9c94882\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"482541afc695015d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/srsClipboard.js\":\"c40593acc3e9ad83\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"6d4924dc233b46a7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4e9f93b8a186f761\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/DeckPicker.js\":\"129d2d7c0bb36c22\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/ReviewControls.js\":\"6c334ac65f1f1c2e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/ReviewDeckRenderer.js\":\"36952001d723a311\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/ReviewSession.js\":\"85c70802810d8386\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/actions.js\":\"8a79609af67a6e55\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/archive.js\":\"eefb4e6aaf2a49fd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/dataExtension.js\":\"2440fe00939d77c5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/deck.js\":\"6a6822651a37feb0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/dueQuery.js\":\"87fe8e3c89cf7825\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/gradeDecision.js\":\"69599d08eedabd8a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/index.js\":\"3ecd779bb0b757ba\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/keyHints.js\":\"64ae7808776e8e23\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/reviewCardLayout.js\":\"f1ef6d3308f142ab\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/reviewProgress.js\":\"0d0e3a3e2dc2a075\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/schema.js\":\"a46c726b50ef6f75\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/useDueCards.js\":\"dfb6e9020848df7d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/startup-metrics/index.js\":\"fb50204f83897a5d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/startup-metrics/record.js\":\"63b278fc50842329\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/storage-persistence/index.js\":\"90d57dcdb7bb9f5a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/storage-persistence/persistenceStatus.js\":\"b1f11e3fe7102393\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/storage-persistence/requestAction.js\":\"d0c31f5d4806fb3c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/supertags/TypeChipsDecorator.js\":\"0d2e22225f01f88e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/supertags/codeMirrorExtensions.js\":\"b41b42205714e134\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/supertags/index.js\":\"2360ec46436dfa57\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/supertags/typeAutocomplete.js\":\"fba0c844a963bd11\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"13ea20784e07716b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/actions.js\":\"e49634755cf43300\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/anchor.js\":\"f85340aab2258023\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/events.js\":\"54adbdea7d7147a0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/gestureActions.js\":\"6923c3c7694c9110\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/index.js\":\"78111adebc6c6679\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"b35cca802b03c3c0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/sync-metrics/collect.js\":\"7b4e270481fa16d5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/sync-metrics/index.js\":\"99798cb3c93a17e9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/sync-metrics/record.js\":\"da19d278782d594a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/RejectionDialog.js\":\"e7d3f48b3fcd4a6e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/SystemStatusHeaderItem.js\":\"4372dc55c8788248\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/index.js\":\"b44337c692ba8101\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/model.js\":\"af56f1cd6b51a245\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/queueCounts.js\":\"57a28f3c53e3181d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/rejectedHelpers.js\":\"933c7bc3c96dbb8c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/rematerializeAction.js\":\"0330ab14982f7c5d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/useHysteresis.js\":\"c48675e5d3792f18\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/ColumnHeaders.js\":\"b4dc429850ae821e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/QueryUi.js\":\"1da252e7dd7a7e2d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/TableLayout.js\":\"3b2265725a9ab316\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/actions.js\":\"60ff5100e8c3170c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/cellEdits.js\":\"1e0dee9040fb6e7b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/childrenViews.js\":\"8cad49f22d568a70\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/columns.js\":\"b1f47b170fd6a6cf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/controller.js\":\"a06de08e94801ae3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/convert.js\":\"338dbf94f06486ca\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/dataExtension.js\":\"298d94d606dbb839\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/index.js\":\"22a22868233f153d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/keys.js\":\"d53609b74c6bed0c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/model.js\":\"3bdfd2de05758cc8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/backfill.js\":\"406cd422a122e44f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/completion.js\":\"8cc37b3d5c19ff01\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/format.js\":\"9307e6ef57b2800c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/parse.js\":\"6747b140685b3581\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/queryValue.js\":\"f6991cf4b9fcbb9e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/registrations.js\":\"ee2e115048187746\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/source.js\":\"1e4fbac63308bb0f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/registry.js\":\"32cc50d05db5ec91\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/rowGutter.js\":\"9397bbb41378368f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/rowVerbs.js\":\"cc54f768ad2bce13\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/schema.js\":\"46fb978be71ee044\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/sort.js\":\"328827766a11d842\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/theme-toggle/effect.js\":\"cd426a58567b2ee6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/theme-toggle/index.js\":\"abb0354b95610707\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/theme-toggle/theme.js\":\"6a603d9fb57ea6f5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/todo/actions.js\":\"2337a0ffa1ae5411\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/todo/dataExtension.js\":\"91c1ba17f08a58ba\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/todo/index.js\":\"8d5e08d4cef6648b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/todo/schema.js\":\"134b6ec42760a211\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/TouchSelectionLayer.js\":\"cfeb86612a94a518\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/actions.js\":\"1c1e8be4962d8953\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/defaultItems.js\":\"23e640d64b08173f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/facet.js\":\"597025001a0879e5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/holdRecognizer.js\":\"5200eb198b21ee48\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/index.js\":\"ddd8717469adbfbc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/update-indicator/UpdateIndicator.js\":\"5da719777060e719\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/update-indicator/index.js\":\"868855fc48b55225\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/update-indicator/loadTimes.js\":\"15d32c6c6cf8c506\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/VideoNotesRenderer.js\":\"1e7a4aa4be83565f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/VideoPlayerRenderer.js\":\"31c7802777b0c00c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/VideoTimeStamp.js\":\"4541c1e4f665cf2a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/actions.js\":\"18d63d145d09519a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/index.js\":\"d8105348d858c082\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/markdown.js\":\"2ea71081c9a20500\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/notes.js\":\"7aaab3d681859e56\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/registry.js\":\"40e40165dceec8b5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/remark-timestamps.js\":\"e46f6c7ff9e4b17a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/view.js\":\"5fd47e570bf8bab5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-link-hints/LinkHints.js\":\"dd55dd858dc56d6e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-link-hints/index.js\":\"0b33750babba0557\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-link-hints/model.js\":\"bb3a36c753e5ac40\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-link-hints/settings.js\":\"f587b35832e54ef5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-normal-mode/actions.js\":\"513eb59b3dcd3857\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-normal-mode/index.js\":\"2bed994af9c5a0d6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-normal-mode/interactions.js\":\"6182d8b955e3834d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/workspace-header/index.js\":\"9c5cfb3bbab0703b\",\"/knowledge-medium/pr-preview/pr-1879/src/registerServiceWorker.js\":\"5f931ec412870160\",\"/knowledge-medium/pr-preview/pr-1879/src/requestPersistentStorage.js\":\"6e456b95812b377e\",\"/knowledge-medium/pr-preview/pr-1879/src/services/authRequestDeadline.js\":\"067c89e96ca5a138\",\"/knowledge-medium/pr-preview/pr-1879/src/services/authStorage.js\":\"7292079a2c96fecf\",\"/knowledge-medium/pr-preview/pr-1879/src/services/powersync.js\":\"35505029936abcd6\",\"/knowledge-medium/pr-preview/pr-1879/src/services/supabase.js\":\"1df2d1252ee84feb\",\"/knowledge-medium/pr-preview/pr-1879/src/services/uploadErrorClassifier.js\":\"52e2e99a34200630\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/ActiveContexts.js\":\"2de7671658d72f4d\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/HotkeyReconciler.js\":\"515c132eb682e6a4\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/WipeLocalDataDialog.js\":\"c161e70f3a19fc9a\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/actionDispatch.js\":\"17ff2f3d603ae0f9\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/actionRefItems.js\":\"f742c76626448e1c\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/applyKeybindingOverrides.js\":\"b26d14b92648a4b3\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/blockActions.js\":\"0060f1aa3a126821\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/blockMergeGesture.js\":\"84bac147b3d0da6f\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/canonicalizeChord.js\":\"895e02e91b871898\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/defaultContexts.js\":\"3240f25ac88b7463\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/defaultShortcuts.js\":\"7e0e4c0ac2bccfc7\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/effectiveActions.js\":\"17abddf7a562bf7c\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/gestureAction.js\":\"8cf7a2616ac62111\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/gestureBinding.js\":\"c43bd0b1d73a470a\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/holdRegistry.js\":\"82bc13c61b183300\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/keybindingConflicts.js\":\"7e1faf56603aa855\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/keybindingOverrides.js\":\"83d67a520db419a6\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/pointerAction.js\":\"1fe125e1737c6a46\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/resolve.js\":\"25ee75733c6dc71a\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/runAction.js\":\"67a432c84a80772a\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/sequenceMatcher.js\":\"ed2fd320ca643c64\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/types.js\":\"5edc43aaec1ff655\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/useActionContext.js\":\"cca30b1976543f9c\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/useActionDiscovery.js\":\"7034dd1fa6238cd8\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/utils.js\":\"442ba247594a5340\",\"/knowledge-medium/pr-preview/pr-1879/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1879/src/sw/bootStore.js\":\"eab36127f33eeaa2\",\"/knowledge-medium/pr-preview/pr-1879/src/sw/previewDatabases.js\":\"2e4b134609e61885\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/byteTransform.js\":\"34ab7fa0e547ac45\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/attachmentCleaner.js\":\"1826b49148d70ba6\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/attachmentParts.js\":\"7c6608a062f2016b\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/bundleParts.js\":\"dbd1c84af0ba0bf9\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/bundleRecord.js\":\"f5bb1cbc8abcd2b7\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/manifest.js\":\"f92c364888f2ed26\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/takeBundle.js\":\"a8d436408d0399ab\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/verifyBundle.js\":\"56b9ce0ae7c08f7e\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/cleaningStage.js\":\"1b956d2f63d07d11\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/conversionKey.js\":\"d717f3b208867398\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/conversionServer.js\":\"088375d2b47126e5\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/flip.js\":\"8e3dce4af3e5a2a0\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/flipAttempts.js\":\"34d9e903db6d8095\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/pages.js\":\"b9570b9ccc2e9733\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/preflight.js\":\"dd5b5ee412fa30b5\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/reseal.js\":\"c10bb4edbbce6942\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/runConversion.js\":\"270b2aa9a2a0c4ac\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/runLock.js\":\"154eb97838b6a276\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/sealing.js\":\"f56274962841059e\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/sealingStage.js\":\"d0913af043680813\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/stage.js\":\"54033cac721c51e7\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/verifyReseal.js\":\"41e5121da057c5a2\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/aad.js\":\"228443d58a867c87\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/aead.js\":\"808c8b77eb21faa2\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/base32.js\":\"2cc3e65f6ade4e52\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/base64url.js\":\"2b544cdfd8d133dc\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/binaryEnvelope.js\":\"bb71088f3a76d621\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/byteAead.js\":\"6b9e0281193473ee\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/canary.js\":\"09509975c73c0242\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/contentHash.js\":\"d8bae3c3be4393ca\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/contentKey.js\":\"ff7460c1b020dcce\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/derivedIdNamespace.js\":\"9642d48f542ce887\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/envelope.js\":\"022a504451aa870c\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/hex.js\":\"15d5f4028c2c3cee\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/sha256Hex.js\":\"c4ad622803584c75\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/workspaceKey.js\":\"5d442d29ea7a618e\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/conversionState.js\":\"ae9c39ea69871dee\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e93509ba688830df\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/flows/pastedKey.js\":\"c08041ef793066c5\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b60ca3c88e200809\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d19a812b55dbfe33\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/keyStore.js\":\"1ed0e2624779e85e\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/mintWorkspaceKey.js\":\"100063145ca46b66\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/modePin.js\":\"c8f275cd68bc8894\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/openWorkspaceKeys.js\":\"ea5003859161200f\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/resolveWorkspaceEntry.js\":\"5efb949d777a6c86\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/resolver.js\":\"6562c38b55685029\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/workspaceAccess.js\":\"5ae7fd16bd77e331\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/transform.js\":\"7ab8128e05ab4dae\",\"/knowledge-medium/pr-preview/pr-1879/src/themeBootDefaults.js\":\"ac92022e412e84fc\",\"/knowledge-medium/pr-preview/pr-1879/src/types.js\":\"d3c5d4a911642311\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/ClientLocalSettings.js\":\"88116d987059e0fe\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/abortableSleep.js\":\"c9bf17bee38010ad\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/array.js\":\"0bb2017d0264ba50\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/backlinkAutocomplete.js\":\"ed81a02d2105d9f2\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/blockCrumbs.js\":\"5f5b80180c0d58d3\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/blockrefAutocomplete.js\":\"d47937ea6594107e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/cadencedIdleJob.js\":\"e93023f95116d4ad\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/callbackSet.js\":\"d72569ac44318ec3\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/clientId.js\":\"3dd6587924174987\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/codemirror.js\":\"c7d07f75b133498e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/codemirrorCompletion.js\":\"d26c2c8ae58b0f0d\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/copy.js\":\"51091e0e871d0b53\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dailyPage.js\":\"7b3e5f25b5cf5ef6\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dbForensics.js\":\"8e029ebc111b788c\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dbForensicsHooks.js\":\"7df7de0235761830\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/deleteBlockThroughUi.js\":\"7c12393b3fa2c361\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dialogs.js\":\"95370910f19ac1a2\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dom.js\":\"46a1d1ab353e96b6\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/downloadBlob.js\":\"3796e9f709ec1754\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/drawnWalk.js\":\"3162c636295cb08a\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/exportSqliteDb.js\":\"eb1f84cbac93f81c\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/fileSystemAccess.js\":\"2726c3d237e1a8c4\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/flipSlide.js\":\"9f06721fbc93cc8e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/fnv1a.js\":\"c2a20b4e06e2c730\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/formatBytes.js\":\"e355978843494d34\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/fuzzyRank.js\":\"1423e79008f3b1b9\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/idbKeyedStore.js\":\"4354bca1d46790b2\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/idleCallbackPolyfill.js\":\"d207bb3b44221b8d\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/keyboardAwareScroll.js\":\"b6d5309f1074dee3\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/keyboardViewport.js\":\"0882b6790f60eb6b\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/lastWorkspace.js\":\"e06011540738508c\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/layoutColumns.js\":\"9fc3b7c78d71047c\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/layoutSessionDom.js\":\"5e7f55aa826e8292\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/layoutSessionId.js\":\"0b10606e9c14ab1b\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/linkClickGestures.js\":\"5514f8a25c1ca36d\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/linkTargetAutocomplete.js\":\"143de5ad62663b96\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/localDbCorruption.js\":\"d0269a5b99b53856\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/localDbRecovery.js\":\"bb375abcfdf9b811\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/markdownParser.js\":\"f8e4bc8c01159a9b\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/memoize.js\":\"99e6def1b232a086\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/nameFieldCommit.js\":\"7181f87dfa5bdbb8\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/nameList.js\":\"90a20a04f06c6a53\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/navigation.js\":\"3344655aee6d9a61\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/omnilinerNamespace.js\":\"c07c1b1f0f8ba491\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/opfsPageScan.js\":\"7b1d6cb5a0994a6b\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelClearance.js\":\"503951ea79a52305\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelHistory.js\":\"ce54ffa05c37d22f\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelLanes.js\":\"3ba757f0477cda19\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelLayoutProjection.js\":\"b0e1df6cec3c4523\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelScrollAnchor.js\":\"daac2790d084a311\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelUrlFlags.js\":\"965cd305cb2d8e5f\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/platform.js\":\"1d4baf30e3d27bdd\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/pluralize.js\":\"943defaf0c4103b4\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/propertyCreation.js\":\"4f5ddc4fb0878bc8\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/propertyNavigation.js\":\"96807dbc8939e01e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/propertyValueContext.js\":\"5a9da49377a38e32\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/react.js\":\"017b532b529c00e1\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/relativeDate.js\":\"ad4013a61e4ad973\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/relativeTime.js\":\"50d86e483a51eeae\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/renderScope.js\":\"3d295aba395c6bcb\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/resolvedThenable.js\":\"24036f526b390f82\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/routing.js\":\"38a9fb9917a7c8c6\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/safeMode.js\":\"5cb8c1a98715e472\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/scheduleIdle.js\":\"6e4db64eaa0c5c7c\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/screenWakeLock.js\":\"70ba76b3bcc716b5\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/selection.js\":\"bd6c129b4d9cdc90\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/softKeyboardGrab.js\":\"3c19d99fa12c366a\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/startupTimeline.js\":\"7e9fa9fa01263f8d\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/state.js\":\"072c6c16297eaf6d\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/string.js\":\"6fce234ddd5a8c98\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/surfaceZoom.js\":\"16cd9c1b7b4bdd62\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/time.js\":\"769129ca2cd1e06e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/toast.js\":\"6cc238c03865029a\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/toggleStore.js\":\"53adece4efea0c7e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/untilStopped.js\":\"b2c4f120e108555d\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/userActivity.js\":\"38f216e3d002419c\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/viewTransition.js\":\"ca9fb6833450630c\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/viewport.js\":\"29489b93d1b77e8e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/webLock.js\":\"30b00911523690bc\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/workspaceRecovery.js\":\"447f6b8ff30fa881\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/workspaceSnapshotStore.js\":\"d8e11902fa4d5267\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-compiler-runtime.js\":\"17a8971dcd98655e\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-client.js\":\"1fd01cb961af8e67\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-server-edge.js\":\"97b9956208a1a9ca\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-server.js\":\"3b41555bf898be75\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-static-edge.js\":\"00165cb6403ceb15\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-static.js\":\"104aa6cf2d3960a0\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-test-utils.js\":\"52fdb4f865a21a1d\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom.js\":\"a7bb11e9a94588dc\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-jsx-runtime.js\":\"8f9727b9159f0059\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react.js\":\"4e0fd3ea4e866159\",\"/knowledge-medium/pr-preview/pr-1879/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1879/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1879/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
