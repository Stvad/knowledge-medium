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
		buildId: "3bacd0063618-562f4ca6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1879/\":\"d63a5ec2ac22ddc9\",\"/knowledge-medium/pr-preview/pr-1879/index.html\":\"d63a5ec2ac22ddc9\",\"/knowledge-medium/pr-preview/pr-1879/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1879/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1879/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1879/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1879/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1879/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1879/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1879/assets/FacadeVFS-3KPqmSS1.js\":\"9caee2be2f309d97\",\"/knowledge-medium/pr-preview/pr-1879/assets/OPFSCoopSyncVFS-eDdK5pOt.js\":\"edf6c3d3480e3cc8\",\"/knowledge-medium/pr-preview/pr-1879/assets/OPFSWriteAheadVFS-C6c3p-hK.js\":\"6c8a73af640169d2\",\"/knowledge-medium/pr-preview/pr-1879/assets/wa-sqlite-CNO39PCt.js\":\"f50fd7ada9c01b76\",\"/knowledge-medium/pr-preview/pr-1879/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1879/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1879/assets/wa-sqlite-async-CNOry4Pj.js\":\"ae5fb9ef0acaad58\",\"/knowledge-medium/pr-preview/pr-1879/assets/worker-CDCWdeQ1.js\":\"c3ab3934b9aa20fb\",\"/knowledge-medium/pr-preview/pr-1879/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1879/chunks/app-gDdb_EjD.js\":\"5cf5553f6009210f\",\"/knowledge-medium/pr-preview/pr-1879/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1879/index.js\":\"05305c669678d65e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1879/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1879/assets/AccessHandlePoolVFS-Cd3t_MCe.js\":\"d06e586e69a3ccd4\",\"/knowledge-medium/pr-preview/pr-1879/assets/IDBBatchAtomicVFS-CWZGG3Sc.js\":\"1ae71949fab43ea7\",\"/knowledge-medium/pr-preview/pr-1879/assets/MemoryVFS-BiNgvdiE.js\":\"c6678fc745c6221e\",\"/knowledge-medium/pr-preview/pr-1879/assets/mc-wa-sqlite-8eyGLNru.js\":\"4c72f6040bb3dd19\",\"/knowledge-medium/pr-preview/pr-1879/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1879/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1879/assets/mc-wa-sqlite-async-fWHFzOFw.js\":\"7985f85180a106f5\",\"/knowledge-medium/pr-preview/pr-1879/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1879/chunks/AccessHandlePoolVFS-DudbkFgO.js\":\"4aaad1bf1c9cdd20\",\"/knowledge-medium/pr-preview/pr-1879/chunks/FacadeVFS-ArI0aKQ0.js\":\"d15da57384486bc0\",\"/knowledge-medium/pr-preview/pr-1879/chunks/IDBBatchAtomicVFS-BkUZlPTo.js\":\"3d0a6f8eea069d06\",\"/knowledge-medium/pr-preview/pr-1879/chunks/MemoryVFS-9Kw_azSK.js\":\"e7ccb33a6dd19cec\",\"/knowledge-medium/pr-preview/pr-1879/chunks/OPFSCoopSyncVFS-DfEpXOxI.js\":\"91b323e7122b2e94\",\"/knowledge-medium/pr-preview/pr-1879/chunks/OPFSWriteAheadVFS-Dd7kYlwT.js\":\"a43eaefd79ba2e38\",\"/knowledge-medium/pr-preview/pr-1879/chunks/Preview-1JWV5U4E.js\":\"d42d256abffb4d1b\",\"/knowledge-medium/pr-preview/pr-1879/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1879/chunks/card-3jQazf5T.js\":\"94cd24cc241e6547\",\"/knowledge-medium/pr-preview/pr-1879/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1879/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1879/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1879/chunks/dist-Cb-Ux0L3.js\":\"5b6d6d6521783a08\",\"/knowledge-medium/pr-preview/pr-1879/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1879/chunks/mc-wa-sqlite-BBa47XBt.js\":\"d49b5d5409963e04\",\"/knowledge-medium/pr-preview/pr-1879/chunks/mc-wa-sqlite-async-DiEet_vN.js\":\"70bd3976a8d203d6\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-Bo0CypOe.js\":\"23dedd12750867d5\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-BtgR3vE8.js\":\"58ad856917f57541\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-C-lyZljI.js\":\"4c33dd5d200a5db5\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-C5_BbweK.js\":\"abd86c7207ff7b09\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-CZ7HjNyh.js\":\"68ab1a4bf47c43b4\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-Impv1O70.js\":\"8718ab9f75559f3c\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-RnsqrUPm.js\":\"87c72b74cfde1b44\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-dom-server-legacy.browser.production-D_LXj7Bb.js\":\"96d88c8dd78ca139\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-dom-server.browser.production-COl-skuE.js\":\"f55efb402c427030\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-dom-server.edge.production-kcvZZpzl.js\":\"b3d15229d5cbb698\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-hIwIiOwM.js\":\"ff4dcfa5c81da554\",\"/knowledge-medium/pr-preview/pr-1879/chunks/server.browser-3iD5sHHr.js\":\"dee049f15fd430b7\",\"/knowledge-medium/pr-preview/pr-1879/chunks/textarea-DEtVAUKF.js\":\"c35e89e48a902221\",\"/knowledge-medium/pr-preview/pr-1879/chunks/ui-CcDr1j1O.js\":\"54cf007b408eb0d7\",\"/knowledge-medium/pr-preview/pr-1879/chunks/wa-sqlite-BX9sd18l.js\":\"a7f1c41f7f2c1fa4\",\"/knowledge-medium/pr-preview/pr-1879/chunks/wa-sqlite-async-B4F1_ytC.js\":\"ee0f06b6b29a3594\",\"/knowledge-medium/pr-preview/pr-1879/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1879/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1879/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1879/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1879/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1879/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1879/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1879/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1879/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1879/src/App.js\":\"68e4e30055e05bfd\",\"/knowledge-medium/pr-preview/pr-1879/src/appUpdate.js\":\"aa8ebd511059977b\",\"/knowledge-medium/pr-preview/pr-1879/src/appVersion.js\":\"7901651ee9a358b6\",\"/knowledge-medium/pr-preview/pr-1879/src/bootstrap/initialLayout.js\":\"ce28a25e865abd34\",\"/knowledge-medium/pr-preview/pr-1879/src/bootstrap/openWorkspaceData.js\":\"e079a9eda014b963\",\"/knowledge-medium/pr-preview/pr-1879/src/bootstrap/resolveWorkspace.js\":\"8cba8c1728ff1ad5\",\"/knowledge-medium/pr-preview/pr-1879/src/bootstrap/workspaceBootstrap.js\":\"8df911e5a924f895\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockComponent.js\":\"7730a122b2c5e951\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockCrumbs.js\":\"37d3fb1ce1c94dd6\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockEditor.js\":\"8c59e876d9a6b478\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockLoadingPlaceholder.js\":\"8ece2920f91dcd78\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockProperties.js\":\"1dd1ace0f8734cff\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockSearchPicker.js\":\"bb17a76fa7e4781e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ConfirmBulkDeleteDialog.js\":\"20be14418b0ec631\",\"/knowledge-medium/pr-preview/pr-1879/src/components/DividerHandle.js\":\"db2844ca5b94a40f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/DraftEditor.js\":\"0075a4973b1b2314\",\"/knowledge-medium/pr-preview/pr-1879/src/components/GutterPill.js\":\"065abaf7673d0693\",\"/knowledge-medium/pr-preview/pr-1879/src/components/Header.js\":\"398164ee5fc3dfce\",\"/knowledge-medium/pr-preview/pr-1879/src/components/LazyBlockComponent.js\":\"c2baa4d909f8ced4\",\"/knowledge-medium/pr-preview/pr-1879/src/components/Login.js\":\"ecdd4afcefad8851\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ZoomableSurface.js\":\"f468787ccff47166\",\"/knowledge-medium/pr-preview/pr-1879/src/components/editModeKeepalive.js\":\"d0ada0b78b7bc399\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyDisplay/PropertyDisplayScope.js\":\"64331b76429b6864\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"2544d3935ff0f244\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/RefPropertyEditor.js\":\"26ba3f573c16cbad\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/RefTargetTypePicker.js\":\"fe4df745f38ec163\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/SelectPropertyEditor.js\":\"3978212d497d42bc\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/TypesPropertyEditor.js\":\"4e69579f195479c1\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/defaults.js\":\"24f4071604c8172c\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/kernelValuePresets.js\":\"efbb54d147668fb1\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/selectablePresets.js\":\"6d8ff79e26d4cd55\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/typesPropertyUi.js\":\"5cce44b495136623\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/AddPropertyForm.js\":\"8b3fa507910df790\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/PropertyPicker.js\":\"dbca0d43fa3b455b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/PropertyRow.js\":\"26f845546663d26e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/Rows.js\":\"b45dc3348ebf2185\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/actions.js\":\"78f4207560c3e857\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/declarationOnly.js\":\"cf68705f29046f89\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/layout.js\":\"a500287a298bf11c\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/model.js\":\"a39dc4fbffbba18a\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/shapeUi.js\":\"4ecf7d64e1c62aae\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/shapes.js\":\"a2d9faf15bf7d16f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/usePropertyEditingActivation.js\":\"03af282daac6597b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/visibility.js\":\"0189eaec6ccc2e56\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanelSections.js\":\"f34b27f52d177537\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/BlockEmbed.js\":\"d12ebada4adc4009\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/BlockLink.js\":\"de271fd85d3ec09c\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/BlockRef.js\":\"9d27231a18bd9c40\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/ReferenceLink.js\":\"90973ea60384d4b5\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/cycleGuard.js\":\"d3ce7d49ea0bf919\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/cycleGuardContext.js\":\"fe0192a239a12a4c\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/linkInteraction.js\":\"b6ac803dd29272f4\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/referenceLayout.js\":\"95a3de0a53e16f5d\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/useBlockRefAncestors.js\":\"e2c9df7b4cc146d7\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/BlockGutter.js\":\"dd7a4efa489edf7f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/BlockInfoDialog.js\":\"e56b5a2040673d21\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/BlockTypeBlockRenderer.js\":\"27f65872115111f6\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/BulletHoverCard.js\":\"9cc491baa0e68478\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/CodeMirrorContentRenderer.js\":\"eac0d14599ebd638\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"4333321303671b31\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/ColumnResizeHandles.js\":\"747f4d0ad6bfa4b4\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0bd76da498bde471\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/DefaultBlockRenderer.js\":\"fdf60ca43a3692b3\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/LayoutRenderer.js\":\"07c90e6bdef22d44\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/MarkdownContentRenderer.js\":\"7466c4b2711a4946\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/MissingDataRenderer.js\":\"e5457ebff9edb3c9\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/PanelRenderer.js\":\"1683b15ac1466794\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8a6aebdd472da19b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/TopLevelRenderer.js\":\"8696b402bad0a224\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/blockGutterMode.js\":\"0f391ae023cdb91e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/blockTitleText.js\":\"49caac4b6bb61104\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/fieldCreationKeydown.js\":\"019f8a9bcfd81684\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/layoutRootContext.js\":\"6ef5fa31e8b1e679\",\"/knowledge-medium/pr-preview/pr-1879/src/components/typeChip/TypeChip.js\":\"027f3c9f4b989604\",\"/knowledge-medium/pr-preview/pr-1879/src/components/typeChip/chipStyle.js\":\"9a710d9e3a4ee52e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/anchored-floating.js\":\"f735bf94cf8d972a\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/button.js\":\"cef7e95b3f915adf\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/card.js\":\"f5897f811a5ecc24\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/checkbox.js\":\"6392ae9c218f855b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/collapsible.js\":\"8430648770a9b376\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/command.js\":\"d8f5670b7b759986\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/context-menu.js\":\"a0360cb22e6939c5\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/dialog.js\":\"c36ca22119a7702f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/dropdown-menu.js\":\"d42d8fb68a341202\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/floating-listbox.js\":\"a4bf1eb1e7d97326\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/index.js\":\"1ed58b21bba2d7d8\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/input.js\":\"3af9f0df968be60e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/kbd.js\":\"5e850075d4316123\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/label.js\":\"928443bd1787abb9\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/textarea.js\":\"011416f4aec503fd\",\"/knowledge-medium/pr-preview/pr-1879/src/components/useEditModeYieldKeepalive.js\":\"af974e93d52e92e8\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/BootFallback.js\":\"2d3c6d8a2f44645b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/FocusedRowLazyMount.js\":\"7fe4cb0658c7db10\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/LazyViewportMount.js\":\"1484d52dae7b3054\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/LocalDbCorruptionFallback.js\":\"d29f67264a39d75f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/error.js\":\"b0118456392dfa5f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/lazyMountRegistry.js\":\"5f224de6a135d578\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/suspense.js\":\"aa5d69d709d596be\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/CreateWorkspaceDialog.js\":\"c2da3d9517e290fe\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/PendingInvitations.js\":\"42917dabe72e8650\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/SyncProgress.js\":\"653c6aa6724b2129\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/UnlockProgress.js\":\"d996ca559e12d0a4\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/WorkspaceKeyGate.js\":\"f302227448d01f35\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/WorkspaceSettingsDialog.js\":\"5a64b97f59f97dc3\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/WorkspaceSwitcher.js\":\"8f6b7feeaadd5c91\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/WorkspaceSyncGate.js\":\"5bdfc11d0862e29d\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/ConversionFlow.js\":\"87574fb3494eae2e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/ConversionFlowHost.js\":\"c6fb889320075916\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/EncryptionSection.js\":\"9ddf2ec7208c102b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/attachmentPrompts.js\":\"d6e926c79860de7b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9d3c4b8339bf3519\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/conversionFlowDeps.js\":\"a528ed92d3933ca5\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/conversionFlowStore.js\":\"23481ab589ec5b75\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/flowUi.js\":\"d8b46282e4acb662\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/useConversionRun.js\":\"13b8897ed0573693\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/keyUi.js\":\"128d8937766027d0\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/useCloseOnKeyLoss.js\":\"7e7f46c98a63ae16\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/useCloseOnServerE2ee.js\":\"81e0d05039a6f7e9\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/workspaceUnlocked.js\":\"0919bdb95a9cc438\",\"/knowledge-medium/pr-preview/pr-1879/src/context/backgroundSubtree.js\":\"ef0b119f5562c291\",\"/knowledge-medium/pr-preview/pr-1879/src/context/block.js\":\"5472259015898432\",\"/knowledge-medium/pr-preview/pr-1879/src/context/layoutWsContext.js\":\"937af917d36d6608\",\"/knowledge-medium/pr-preview/pr-1879/src/context/propertyDisplay.js\":\"69d01f96f16ce998\",\"/knowledge-medium/pr-preview/pr-1879/src/context/repo.js\":\"6caadf3eb2000e5b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/aliasClaim.js\":\"c9eae200acb43f05\",\"/knowledge-medium/pr-preview/pr-1879/src/data/aliasSeatNamespace.js\":\"57cb3ce0f7843381\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/blockData.js\":\"fa5f3572089a442d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/blockType.js\":\"7bc7118e4d28ed93\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/changeScope.js\":\"cd2a6f1669f3b689\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/codecs.js\":\"af27a2c2068de6e0\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/derivedData.js\":\"f99b1aa5e682ff8b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/errors.js\":\"a9bd671ea78bf53a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/events.js\":\"e5be17393c0fad8f\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/handle.js\":\"9f94caa668fb0071\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/index.js\":\"012a5028131e86a4\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/mutator.js\":\"1e7868ba4ceabb04\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/processor.js\":\"739f52dd94656658\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/propertySchema.js\":\"6ec2e65cf55ef1dc\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/query.js\":\"b7bdd4a4e177abd7\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/sameTxProcessor.js\":\"9c6897d8427ea697\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/schema.js\":\"9f94caa668fb0071\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/tx.js\":\"9f94caa668fb0071\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/typedBlockQuery.js\":\"71bd4369d8e9bfa8\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/user.js\":\"caf25b44019195e0\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/valuePresetCore.js\":\"60509adb27b46aeb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/valuePresets.js\":\"ec5876e56aa45903\",\"/knowledge-medium/pr-preview/pr-1879/src/data/attachmentCleanerIOVerb.js\":\"1357f0e9090be764\",\"/knowledge-medium/pr-preview/pr-1879/src/data/block.js\":\"83b88af334404143\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockCache.js\":\"cc0f7a5c3c935b41\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockId.js\":\"449b2c984b067cb2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockLiveness.js\":\"24809b3731e6abf8\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockMerge.js\":\"8cdacdfa5fbe08ba\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockSchema.js\":\"d0282daf4571fdca\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockTypeLookup.js\":\"d727cc72bd656bc0\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockTypes.js\":\"d344015e2267555c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/childrenView.js\":\"8bc12042f5cf6e8c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/clientContext.js\":\"ec461ab6547b20f7\",\"/knowledge-medium/pr-preview/pr-1879/src/data/dbFileSiblings.js\":\"a668a3846d801c8d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/definitionSeeds.js\":\"1a5edaba0f8534b9\",\"/knowledge-medium/pr-preview/pr-1879/src/data/derivedIds.js\":\"26950e1162e61f2d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/drawnSubtree.js\":\"df0c5ea079f312ce\",\"/knowledge-medium/pr-preview/pr-1879/src/data/facetBridge.js\":\"664f6f47eab7dd30\",\"/knowledge-medium/pr-preview/pr-1879/src/data/facets.js\":\"ca66c6032970af70\",\"/knowledge-medium/pr-preview/pr-1879/src/data/globalState.js\":\"bc2593b5a53d15bf\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/aliasClaimRederiveProcessor.js\":\"48f7608070d03bdc\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/ancestorBatch.js\":\"cdfb36b83ae165b4\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/blockTypeTypeifyProcessor.js\":\"f84c7b697adf6042\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/clientSchema.js\":\"8ae616ae0ab873cd\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/commitPipeline.js\":\"9fdc0120a1f3ccb9\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/devAssertions.js\":\"711b5679aaacc6ca\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/firstSync.js\":\"c95642723603ea9b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/freshInitialLoad.js\":\"fedacf1cd5f68ed4\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/graphBackfillClaim.js\":\"76be0bf624eea2fa\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/handleStore.js\":\"785759edc2078b42\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/idleMarkerJobs.js\":\"dc073ca56504df64\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/initialDownload.js\":\"7eea73e6da0401e1\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/initializeClientDatabase.js\":\"e5b56afafb2273b8\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/jsonCanonical.js\":\"b83b397e4e0bccba\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/kernelInvalidation.js\":\"a4fa9d941239d6f3\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/kernelProcessors.js\":\"82f493bbd2e99a32\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/kernelQueries.js\":\"9389a8a43944d23e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/mergeTypeMembershipProcessor.js\":\"1f4b6b12f47a0832\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/normalizeReferencesProcessor.js\":\"1d312445245646e9\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/poolInstrumentation.js\":\"91b123b60088d85b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/processorRunner.js\":\"48b8ed5141c308cb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyCellBackfill.js\":\"144be94a8fcfae2e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyChildMint.js\":\"9d30df715fca8d87\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyChildrenProcessor.js\":\"f81493d396771c03\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b7106600a556c898\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyDefinitionSynthesis.js\":\"1b09a3e1a396f04b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyKeyScan.js\":\"5e84bcc7326255ce\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertySchemaResolution.js\":\"7eaf57ea91fa03ca\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyValueEdits.js\":\"0bf958453a2c8a27\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/raiseProtocol.js\":\"75db0ecd11ae0272\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/readBatch.js\":\"410676884e58dde7\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/refProjection.js\":\"eec78fbab02197b4\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/referenceTargetLookups.js\":\"f1945778bbb0e8ae\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/referenceTargetProcessor.js\":\"3c5ec0e3db51e810\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/replayMerge.js\":\"8627520095575832\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/sqlBinds.js\":\"155aa0ff8b6c0752\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"797b8c979e7cf7a0\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/arrivalProcessors.js\":\"c4772e1e4e350697\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/invalidate.js\":\"ef14a00dc15abc33\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/materialize.js\":\"381c2ca6058c3c69\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/observer.js\":\"08d393580468dc9e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/reconcile.js\":\"9b49f7571a23456d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/timingMetrics.js\":\"9df5de4ca70113be\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/treeQueries.js\":\"4c6a7e1d06c182d2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/txEngine.js\":\"d4b6c8a68d0ff7db\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/txSnapshots.js\":\"f4590bdef28f1790\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/typedBlockQuery.js\":\"32ead2a926bf7a5a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/undoManager.js\":\"b541a1f53d44a9a6\",\"/knowledge-medium/pr-preview/pr-1879/src/data/invalidation.js\":\"4f8ec7e58d59a7f2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/kernelDataExtension.js\":\"fca6db7a0f376a29\",\"/knowledge-medium/pr-preview/pr-1879/src/data/kernelPage.js\":\"a4264ff42f9e64b7\",\"/knowledge-medium/pr-preview/pr-1879/src/data/kernelValuePresetCores.js\":\"6a3c33d59fe0381a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/localDbCorruptionSignal.js\":\"7fd26513d8f68f0f\",\"/knowledge-medium/pr-preview/pr-1879/src/data/localDbStorage.js\":\"299536fcfc0ba8f8\",\"/knowledge-medium/pr-preview/pr-1879/src/data/localDbVfs.js\":\"93b45bfeb7ff4e3d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/localSchema.js\":\"d51c0eec15901b22\",\"/knowledge-medium/pr-preview/pr-1879/src/data/maintenance.js\":\"167ee3f8943772f0\",\"/knowledge-medium/pr-preview/pr-1879/src/data/mergeProperties.js\":\"06d64afd7eaf43f2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/metricsConsoleHook.js\":\"15ae90454532646a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/migrationsPage.js\":\"2d835746feff5da2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/mutators.js\":\"f56122e551aeab4e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/orderKey.js\":\"0a886e34b729934e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/orderKeyPlacement.js\":\"9ebabccb7c181d3d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/outlineSurface.js\":\"0907f0bc409f5214\",\"/knowledge-medium/pr-preview/pr-1879/src/data/pendingEditorContent.js\":\"21371732ea9a5ccb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/pendingUploadsSql.js\":\"162b087d4441bc97\",\"/knowledge-medium/pr-preview/pr-1879/src/data/pluginStateExtensions.js\":\"e67784c53a7eade5\",\"/knowledge-medium/pr-preview/pr-1879/src/data/powerSyncLogger.js\":\"ece96a8e207fbe9e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/projectorRuntime.js\":\"e14add9cb7cc1a6d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/properties.js\":\"62bd48fe30161941\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertiesPage.js\":\"e2c5a3a188b4f01a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyChildren.js\":\"bedad3661be68e96\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyDefinitionFanout.js\":\"37db91df76ad96d9\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyDefinitionMetadata.js\":\"4e8b5b5a75dfbb2c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyDefinitionRegistry.js\":\"9d3400dab5fd4818\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyDisplayMode.js\":\"7c6281f07fe65504\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyRowCreation.js\":\"507cea4d0f2f953b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertySchemaCreation.js\":\"2df21fb7fdf025c1\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertySeeds.js\":\"1a817ab329681741\",\"/knowledge-medium/pr-preview/pr-1879/src/data/recentsPage.js\":\"97f1c1df280f105a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/referenceBlock.js\":\"600f6d1093d44377\",\"/knowledge-medium/pr-preview/pr-1879/src/data/rejectedUploads.js\":\"6ea76e7e769e0f2a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/releasePowerSyncConnection.js\":\"f29730ad98330c43\",\"/knowledge-medium/pr-preview/pr-1879/src/data/repo.js\":\"df5bab4b8b5ecf48\",\"/knowledge-medium/pr-preview/pr-1879/src/data/repoProvider.js\":\"e53f6cbc06766a1e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/rowProperty.js\":\"401926b4e0e72554\",\"/knowledge-medium/pr-preview/pr-1879/src/data/searchFilter.js\":\"fd98c66d003adb6a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/seedIdentityLedger.js\":\"44d4015bbe938b22\",\"/knowledge-medium/pr-preview/pr-1879/src/data/stateBlocks.js\":\"7922bebb3f97af46\",\"/knowledge-medium/pr-preview/pr-1879/src/data/structuralEditPolicy.js\":\"db57799de6f51e02\",\"/knowledge-medium/pr-preview/pr-1879/src/data/structuralInsert.js\":\"136944ad3c5b00f3\",\"/knowledge-medium/pr-preview/pr-1879/src/data/subtreeDelete.js\":\"ebb703d42e13e261\",\"/knowledge-medium/pr-preview/pr-1879/src/data/syncStreamLock.js\":\"86b65986a530fecd\",\"/knowledge-medium/pr-preview/pr-1879/src/data/syncedTableSqlRecognizer.js\":\"2459224c065e7998\",\"/knowledge-medium/pr-preview/pr-1879/src/data/syncedTableWriteGuard.js\":\"29553b9d093b6eeb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/targets.js\":\"2a53f42418fc6bd8\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeColors.js\":\"585e4039385b2258\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeDefinitionMetadata.js\":\"d75300f45de7dde1\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeDefinitionRegistry.js\":\"e24e6b6df74c75ed\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeExtraction.js\":\"aae0a8c232d9d21a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeInitialValues.js\":\"a843e426c9f1a0f9\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typePropertyGroups.js\":\"d902e20d80456228\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeSeeds.js\":\"68d5e75d1d9f62bd\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeTagger.js\":\"ac7dab965d05e990\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typedRecords.js\":\"6ac8092167ab0ca8\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typesPage.js\":\"35d9a6660e8379fb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/userPrefs.js\":\"678221a58ad21baa\",\"/knowledge-medium/pr-preview/pr-1879/src/data/userSchemasService.js\":\"7cea7778bd520cc2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/userTypesService.js\":\"fca8c6efcc707dc2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/valuePresetRegistry.js\":\"143ecacd6c032309\",\"/knowledge-medium/pr-preview/pr-1879/src/data/visibleChildren.js\":\"2abe699c07a22185\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaceConversion.js\":\"f01050688fecc6c0\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaceFirstSync.js\":\"c4983896959334e5\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaceIdNamespace.js\":\"c5a139c3ef043f84\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaceSchema.js\":\"59453a2bddb7db1d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaces.js\":\"0ba81911e502d68e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/writeAheadLog.js\":\"99a3e020b85bf617\",\"/knowledge-medium/pr-preview/pr-1879/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/BlockPasteShellDecorator.js\":\"35de74784b1ece80\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/atTrigger.js\":\"4a5f768dd4a793bd\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/autocomplete.js\":\"0c9a1aab5bce0069\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/codeMirrorExtensions.js\":\"95b7bf7f6980777f\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/contentFlush.js\":\"63fd9055cdbaeb90\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/defaultInteractions.js\":\"3df2449a199bf428\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/editSettleSignal.js\":\"5de67e2d7a87d316\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/insertImage.js\":\"c816d864231e9950\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/referenceCompletionRange.js\":\"977a78fae1914881\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/referenceTargetTypes.js\":\"34c6c49d50cef5fb\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/syntaxContext.js\":\"da8ae8f15e249951\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/triggerMatch.js\":\"c2054fb032729bc7\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/AppRuntimeProvider.js\":\"81b930fba808da6f\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/BlockFocusShellDecorator.js\":\"06a200ef313d26a6\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/ExtensionRenderBoundary.js\":\"03883e7fea361bca\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/PanelContentRecovery.js\":\"b1ccd0c8ea78c3d1\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/apiCatalog.js\":\"8005fdc0a5aa4de5\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/approveExtensionHere.js\":\"d4f1465c6a3dc64b\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/armedCutAppMount.js\":\"c83167690cc1d721\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/batchableKeyedStore.js\":\"87690348cf9953b0\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/blockInteraction.js\":\"818559dfd83a3f72\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/blockSelectionAction.js\":\"56cc16507897399d\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/compileExtensionModule.js\":\"bdda01b6e2c55ff8\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/compiledModuleCache.js\":\"a3ca9981b508db9b\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/continuousGestures.js\":\"f8d644a2512babf8\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/core.js\":\"01ffebb6bec2ae04\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/defaultRenderers.js\":\"f4bb013a286a0489\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/definitionFanoutAppMount.js\":\"316a2d35d7508737\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/dialogAppMount.js\":\"c6d4233c81fa88d1\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/dynamicExtensionSeeds.js\":\"a789749e1028809e\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/dynamicExtensions.js\":\"ffe97b912ae5343a\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/exampleExtensions.js\":\"a3139b575666f5aa\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionApprovalStatus.js\":\"9dcaf13eb067c09b\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionLoadErrorToast.js\":\"0b02aa285923b2bb\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionLoadErrors.js\":\"16db3f8468ce0bf9\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionLookup.js\":\"8a79e2c97fcd5dc8\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionToggles.js\":\"ebfb496f4e91a4fb\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionUtilitiesCss.js\":\"679b9877e92c371b\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/kernelPageDeletionGuard.js\":\"6eae80c0d32463cc\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/liveRuntime.js\":\"36b5a3f61ecf315b\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/openExtensionsSettings.js\":\"f5842194f3fb6f8e\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/overridesCache.js\":\"628f24b5de740af8\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/pluginIds.js\":\"3a34ab604d99348f\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/processorRejectionToast.js\":\"ebac7ac790f9befa\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/runtimeActions.js\":\"e19f4aaeaeb413b2\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/runtimeContext.js\":\"4f02e3a4ad6cc085\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/staticAppExtensions.js\":\"b910f7a505e54789\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/staticDataExtensions.js\":\"f2e627025e8bafc2\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/toastAppMount.js\":\"f3d7281a515bcef0\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/useOverrides.js\":\"eb340a94531950b2\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/useShortcutSurfaceActivations.js\":\"fbcf7f54626ddb32\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/discoverToggleTree.js\":\"653435de549168d1\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/facet.js\":\"385b6abeb6445166\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/resolveAppRuntime.js\":\"df9701c26f6ede76\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/runtimeEvents.js\":\"46bdc7810099d7ab\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/togglable.js\":\"fa507b3dd88d3b28\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/variantFacet.js\":\"b4ab76b34f38d11b\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/verbFacet.js\":\"31a31e5b3d947211\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/block.js\":\"73b795e3361abb26\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/focusedChild.js\":\"debcf5fe58d0d4b8\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/propertySchemas.js\":\"5fb92eee95a2b116\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/typeRegistry.js\":\"c3a33ce181a37325\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useAncestorCrumbs.js\":\"44f362a12f3112de\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useAutocompleteListbox.js\":\"9c423cc63d38628a\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useDebouncedSearch.js\":\"72ee7024ea9bd5aa\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useDebouncedValue.js\":\"58b8968485c0eeb8\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useIsFocalRender.js\":\"7a90d750525337ac\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useIsReadOnly.js\":\"589331a4a02e28ca\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useMaterializeBacklog.js\":\"62eac75d9cc53d31\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useMinuteClock.js\":\"9a7601c207e76e9b\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/usePanelLayoutProjection.js\":\"350ae115e2774cff\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/usePendingInvitations.js\":\"ab1ff2065cb662ef\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useRendererRegistry.js\":\"134385c5f27299bc\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useRetainedFieldRows.js\":\"366b4fbba270e9b5\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useWorkspaces.js\":\"50bc17794b5d2dc1\",\"/knowledge-medium/pr-preview/pr-1879/src/lib/utils.js\":\"620ac1a2e41ea761\",\"/knowledge-medium/pr-preview/pr-1879/src/main.js\":\"c378eca28993af9d\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/MarkdownImage.js\":\"6c24e5f094bd1351\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/blockSeparators.js\":\"eaa43b9537022893\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/context.js\":\"76971adf69cd7333\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/defaultMarkdownExtension.js\":\"1e73d60c8856d38d\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/extensions.js\":\"329de14593d637b5\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/renderMarkdownHtml.js\":\"d7a376d7bfc3f12c\",\"/knowledge-medium/pr-preview/pr-1879/src/minimal-editor.js\":\"be41869a33189ce2\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/armedCut.js\":\"1b4e66cea570a26f\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/captureMediaVerb.js\":\"df411dd2b5cd0e0a\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/clipboard.js\":\"853ce8a983ea73da\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/decision.js\":\"09d65909acb0acd3\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/operations.js\":\"aa0ee8fd9117c2f6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/account-header/AccountHeaderItem.js\":\"0b56bebc766486eb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/account-header/index.js\":\"9f8fbcd1b1040925\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"8554940957a4c314\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/askAgent.js\":\"f2c61338d04492e0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/askedStore.js\":\"b134204a8961128a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"cb01f60bc09ab35c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/chipState.js\":\"2d1e7996aee61980\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/dataExtension.js\":\"477dffe35cfe418e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/index.js\":\"4b8cb676ae087dd2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d7ebcfb11ab76241\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/schema.js\":\"b707d596aa6eb33a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8b337e882f735fd9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/BridgePairingDialog.js\":\"707ab3807026b652\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/addMedia.js\":\"fe2893712822259a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/backlinks.js\":\"5c3c23a65d8ac1fe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/block.js\":\"21935e62f139f478\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/context.js\":\"8dad560851a4092f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a397ea4661d0b364\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/index.js\":\"783573e0879a820a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/outline.js\":\"4bd9cf71c2025f3f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/properties.js\":\"128ce7f7b6cd2a0f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/refs.js\":\"3988091079f5d529\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"5d4131721af08ec4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/search.js\":\"5be5c5b6943669be\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/shared.js\":\"09a4306db71b10f4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"13c52fb9b0d92140\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/text.js\":\"9fa29c7785290de2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentWrites.js\":\"5e64d7c07f2622ec\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/authoringCatalog.js\":\"e45f68c6671d2f23\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/blockRefTargets.js\":\"b382995728597325\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/bridge.js\":\"ccee9bc0a9efb717\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/bridgeLoop.js\":\"4c4a9286b66685f9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/changeHistory.js\":\"4e2ae7d1aea4569f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/commands.js\":\"5a8dff7746e23100\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/commentsCommands.js\":\"fb7ab6f97d2b4c04\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/dataExtension.js\":\"8ed979846945d6b3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/dataModelGuide.js\":\"ecdb22456c3e5aa1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/dayPropertyInputs.js\":\"d7b9aa148c1159c8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/describeRuntime.js\":\"a8e69224e5773311\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/extensionLint.js\":\"24af3cc9a6a700fa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/grainAudit.js\":\"997f629aab11a380\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/healthCommand.js\":\"61fd55189a3e5dcc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/index.js\":\"43b0f27c7b8349a8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/presetIdentity.js\":\"25b1fbe2d4f72b33\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"cd35a5dba0055f81\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/readMedia.js\":\"d1d1abc8b7ebe9b9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/schema.js\":\"feb857bc7d1808e9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/serialization.js\":\"9642317355266ec9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/targets.js\":\"dd4470ad138d1c0a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/tokens.js\":\"9e7e3b8b725dbaff\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/watchEvents.js\":\"c400fed913642248\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/workspaceGuard.js\":\"88c9e5a49805b10e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/writeCommands.js\":\"0b94406ebba7e020\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/AliasCollisionToast.js\":\"e902c9f09f4201b3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/DuplicateNameBanner.js\":\"ef2de771d66728dc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/collisionMerge.js\":\"c71c843e6f57df80\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/dataExtension.js\":\"4e4ce21431e7d224\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/index.js\":\"5f0d37aeac3cd59f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/mergeCollisionAction.js\":\"30617bd7827301d2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/pageStyling.js\":\"d911ad225db6b93e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/rejectionToast.js\":\"332bb2592ee027c9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/syncProcessor.js\":\"66efac1e8b5a928a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/actions.js\":\"e9c212e3ba95cd83\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/addComment.js\":\"727faef60862fe64\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/anchor.js\":\"46f17ac3fea69fc6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/anchorState.js\":\"c710f0eab17500b7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/commentLinks.js\":\"349c6d1d1a15a8f0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/confirmThreadDeletion.js\":\"9f81c060c5bb0c29\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/container.js\":\"ea92ebea54b8ea39\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/dataExtension.js\":\"2e539bb3abfba585\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/deleteComment.js\":\"b1a6cfd07507607d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/highlights.js\":\"4c648a1db0dab449\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/index.js\":\"4da5439a12444145\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/linkedCommentsPill.js\":\"691a29c7cb9e7d22\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/margin.js\":\"c965b0d9afe043b5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/marginAnchorLinks.js\":\"92600a73956b5b70\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/marginSchema.js\":\"a1667309d0ee6f15\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/newComment.js\":\"7c36278f8d02485d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/ownThreadPicker.js\":\"9200dcc86e1e9d11\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/placement.js\":\"4ee69dffe6c3553c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/queries.js\":\"a4939a3e1728d199\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/quotePosition.js\":\"783e1a8a2c52f2fb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/quotedIn.js\":\"71d1be83ab502447\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/quotedRange.js\":\"6b18898a63ef23c0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/rangeRefs.js\":\"dd3143902b790be8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/readHighlights.js\":\"8ffba82810cfe02a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/readSelection.js\":\"e47d07c275ac6e56\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/readSelectionUi.js\":\"58581f85a5c08a2c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/reanchor.js\":\"80bd5846f0e0b205\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/schema.js\":\"3d351e44feaefa92\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/scope.js\":\"bcc345aac42eaeb0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/scopeThreads.js\":\"417d184739c3fff4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/splitRetarget.js\":\"a81d0b70ef57a904\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/suggestionCard.js\":\"c96814ddc8c628a3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/suggestions.js\":\"fdff1e076a7b5259\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/summaries.js\":\"eb59c4bb0e7f3e85\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/summaryBatch.js\":\"a9e3be582e79f8d2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/surface.js\":\"ccf6747214462066\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/threadNavigation.js\":\"97254fd28571fbde\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/threads.js\":\"ee49a08614975cfb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/ui.js\":\"f2f82e52f22bf5eb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/uiStore.js\":\"89c059e870599b98\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/app-intents/appIntents.js\":\"b22d01fcd333841d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/app-intents/index.js\":\"975a34dac6347565\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/app-update-prompt/index.js\":\"6871d89074e50930\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/app-update-prompt/status.js\":\"ceafde36b339b9f6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"cd4f0fc41956c807\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/MediaBlockRenderer.js\":\"e306fc81305f4f8e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/MediaDownLaneReplicator.js\":\"72fdd9ca2a349c02\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/MediaUploadReconciler.js\":\"13b1c721d25a19ee\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/assetDownLane.js\":\"2cc3512f496da1ef\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/assetResolver.js\":\"a8350b11bda25ff3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/assetUpload.js\":\"04063b1dea4e4cbc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/attachmentCleanerIO.js\":\"9e6ccf818e857ca0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d5b52cb63ec5aef9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/blobStore.js\":\"62b6761c22be591d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/browserMedia.js\":\"d4b45fcc7af18a84\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/byteStore.js\":\"99935d9607733054\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/cleanerIO.js\":\"2a1382ae6d9eac7f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/cleanupAttachments.js\":\"3d0d2d11bb85af9a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/dataExtension.js\":\"5a6c750cefd76312\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/downLane.js\":\"0e3e1c0f63595869\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/index.js\":\"7647d56f58957010\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/insertImageContribution.js\":\"78ebbc7304e11be0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/laneArming.js\":\"2cfd167c03916543\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/laneLock.js\":\"c87d497fba60290a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaBlock.js\":\"6040cbc6d2a922a7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaCapture.js\":\"87c322a747331f58\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaLanes.js\":\"e73effb8bb7d56cf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaViewers.js\":\"237e75a3ea9d2ab9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaViewersFacet.js\":\"1442732b762e6ee5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/pasteCapture.js\":\"58100c1cac47697e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/resolver.js\":\"848b2c2850e9f363\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/retryUploadsAction.js\":\"f5baa518a1a12c84\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/storagePaths.js\":\"79b80b6354de3403\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadDrain.js\":\"65e60bfd85bd137a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadLaneStatus.js\":\"0f0dbb753a586897\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadReconcile.js\":\"216ddbf08e3440cb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadRecovery.js\":\"ef3f8ce654fc0d7d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadStore.js\":\"9ed769f1c1855203\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/useAssetObjectUrl.js\":\"2cedde3e4fbab93b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"01647dc823c2bae1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e7035fac2faa4907\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/facet.js\":\"f9f8d132ee4f800f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/index.js\":\"4a3b550e6e8d1562\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/prop.js\":\"d5e26ff6c479556a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/BacklinkFilters.js\":\"b66aba0a99f465ca\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"f86cb6a898092aed\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/BlockEntry.js\":\"c5748aeb609c8024\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/LinkedReferences.js\":\"fcc805dbb0420847\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9740a64ef2cb267b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/dailyNoteDefaults.js\":\"6d1b84df19eb7d4b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/dataExtension.js\":\"ede2c7e7481fd65e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/edgeExclusions.js\":\"e957db70689a5c33\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/filterProperty.js\":\"8e93b3b1862d85f6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/index.js\":\"1f35a09bb93c2146\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"77c1598784daa58a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/applies.js\":\"3ac4bcde52839ee3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/countQuery.js\":\"70a1e8e934d127ad\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/expansionStore.js\":\"2ec7067930f4eee5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/index.js\":\"3f6ee2d404d777e7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"2e5a180a81a9bf42\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/presentationInvalidation.js\":\"9ebd90caad0f3e20\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/propertyEditorOverride.js\":\"53485a41deb661ce\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/propertyFilter.js\":\"0946c69809ac0a5e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/query.js\":\"b7e734a7a6870043\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/resolveFilter.js\":\"9e798e7961b459ab\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/sourceBatch.js\":\"065f1b7b5f7ae397\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/sources.js\":\"0eccd0d6e3e3b04d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/useBacklinks.js\":\"6272305f0b504c11\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"32a5a9a7498fcc1e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/BirthdayCelebration.js\":\"c9b1bf185368e93a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/BirthdayOverlay.js\":\"1a91e5525104b434\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/gate.js\":\"650a1e523d472465\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/index.js\":\"a8c196bc40353c75\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/wolfTheme.js\":\"d8e8a8570334fb25\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/BlockDragLayer.js\":\"9be3a92a008243d8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/dragController.js\":\"42cc4ca88d47fab8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/dropTarget.js\":\"a69b900954ea8f05\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/index.js\":\"e3425de8bef9e5b6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/projection.js\":\"4ffc5ebcfde748a8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-info/BlockMetaCard.js\":\"afd4d5d09362fead\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-info/index.js\":\"cc31094a37e82527\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/AddTagDialog.js\":\"4815692360bb6812\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4876b3a7ea2ff360\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/TagNameIssueHint.js\":\"5e8b8744310fdeee\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/addTagAction.js\":\"83493d864060d7d8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/appendTag.js\":\"ddaa84aa02f1fdf9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/config.js\":\"2723b692f035c271\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/dataExtension.js\":\"666d93e1c8f772e0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/index.js\":\"5da30401fabc8964\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/propertyEditorOverride.js\":\"007f643c7a9320c0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ea25493595491f53\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"6042834e548f34f9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b625a7cc7a343fe9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"77b72060f69b34f9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a09e89afba551f30\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/index.js\":\"81732b0d47bcb88d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"6227c2124fb29fbd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/CharacterCountItem.js\":\"7cfb69b55903d805\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/ProfilePropertyEditor.js\":\"83a53c5a80c0715c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/actions.js\":\"60fa2a7f77b6ca50\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/blockType.js\":\"1bced73b6b451e9b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/charCount.js\":\"cc6649818a9da66c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/dataExtension.js\":\"5200cdbb20c72c0c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/index.js\":\"e12520781c147f50\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/profiles.js\":\"08d7f80fae93c74a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/properties.js\":\"b189832f46f2905b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/textCounts.js\":\"aec1f271296dd2eb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/colemak-keybindings/index.js\":\"eac51df866cf6028\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/CommandPalette.js\":\"eb3a9d115778715e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/HeaderItem.js\":\"129bc0a4b2c53548\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/context.js\":\"697ccc12ba3ab317\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/index.js\":\"f7a8a9beaa236894\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/selection.js\":\"26c2698df7a94db5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/toggleStore.js\":\"4f7d0361a5997801\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/useCommandPaletteActions.js\":\"91dc0b5cb2495a84\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/ContributorBadges.js\":\"7ed5ea54048a0895\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/author.js\":\"aad5e77209ec0b32\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/codeMirrorExtensions.js\":\"03c2b6a36fc93ac2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/dataExtension.js\":\"0e94b4d9681d0838\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/index.js\":\"5ad0880789eeab74\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/mentionAutocomplete.js\":\"7693ce4d8d3fad2c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/processor.js\":\"d0f0641280529c9f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/profiles.js\":\"e5d8d0dd28cd1083\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/queries.js\":\"9316f48783ded433\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/schema.js\":\"368a1ad8ff0704a9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a51911b018992730\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7eba6fec745b688f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/index.js\":\"159bbcb109010db4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a913d25497d33bee\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"9adc2ae3cfb5c7c3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/CalendarGrid.js\":\"470d37c656921431\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DailyNotePicker.js\":\"cfae15387efba0e2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e676e429c498c59e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DateNavDecorator.js\":\"e2b0020ca1aecc2c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DateScrubOverlay.js\":\"88cb0b6735304f0f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DayPropertyEditor.js\":\"4b5e719d392cbff5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/HeaderItem.js\":\"0f7d034dc6891a14\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/ReschedulePicker.js\":\"d6f2cf56643da283\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/SpreadDatesDialog.js\":\"543e80a609ea4cba\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/actions.js\":\"bee3acd4bc13371a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/blockDateAdapter.js\":\"d2d4222454c2d993\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/calendar.js\":\"8297ecb123904c87\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dailyNotes.js\":\"2367f3bea39356fc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dataExtension.js\":\"eee6706347451da7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dateScrubActions.js\":\"97d71b9c07849b51\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dateScrubGesture.js\":\"0697396d1b507141\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8bb2e10d330ff33d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f3059ae446201669\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dayProperty.js\":\"de6bc5a9ef23a0a7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/deletionGuard.js\":\"410e7d565d847603\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dueQuery.js\":\"2ad29f09051ea086\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/index.js\":\"9270eaa868236c89\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/landing.js\":\"c47ea0f058f9659c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/localSchema.js\":\"29a1e5bcfb1d0cfa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/referenceDateAdapter.js\":\"98ed9fd223c5f52c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/rescheduleAction.js\":\"0d2bf18be0582e88\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/schema.js\":\"e7980dc10eb80894\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/spreadBlockDates.js\":\"6f23881acbf055ba\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/spreadDatesAction.js\":\"6dcb92b1e8e8f761\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/today.js\":\"b3669ba3c0a87771\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"26d9758d40d9715c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a97c4b5bc278c8e1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/audit.js\":\"5645ddd74058a55f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/auditAction.js\":\"3c4ebda9fba356f8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/auditRanges.js\":\"ac4b17aea07875e2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/diagnosticsSource.js\":\"39551ec4d3e1fcb1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/divergenceScan.js\":\"865f5235566145aa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/index.js\":\"04e67ca46aa25d9a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/propertyChildrenChecks.js\":\"420715750d4fb20b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/referencesMirror.js\":\"347c5d9a398a8a7c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/rowJson.js\":\"1085f0fb030f600f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/schedule.js\":\"a1f94a5f27ac6e83\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/store.js\":\"5fdf176704a2e3d3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-maintenance/action.js\":\"1c342daf77037db0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-maintenance/index.js\":\"db39828bc5201c38\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-maintenance/plugin.js\":\"507278bb33215c86\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"6dbd29f6edf426fe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/actions.js\":\"cc488032a61167d9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/changeMarker.js\":\"01b721325c67724c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/diagnostics.js\":\"fccbb9d08b97ba69\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/fileSystemAccess.js\":\"ffe2146a78f90c1f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/filenames.js\":\"e2d6dcae7f689239\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/index.js\":\"6d71863c0f27506d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/mirror.js\":\"2c81febc5d2e7d6e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/runLock.js\":\"551dda88bfdd4001\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/runtimeHealth.js\":\"1cf5c0b71cbd74a3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/schedule.js\":\"ccf67a2298c96db8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/store.js\":\"1cba2f8c46791c64\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/default-themes/index.js\":\"5f274f75d05b8f76\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/default-themes/themes.js\":\"8a163ae6e59c4184\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/diagnostics/facet.js\":\"bee78e543a16912c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/diagnostics/useDiagnostics.js\":\"8930776fa0822988\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extension-prompts/dismissals.js\":\"b54bb2dc0c49a15f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extension-prompts/index.js\":\"96de8cb8efdad044\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extension-prompts/status.js\":\"33cd67461d0241aa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extension-prompts/store.js\":\"8485c22978c32abb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"481c9e2142dbfd5a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f635e7b31ed10cc6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/actions.js\":\"044489bcbfdd8e95\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/config.js\":\"5a48006bff73ccdd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/dataExtension.js\":\"483a2c164a155659\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/effect.js\":\"bb585890aa91c49c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/index.js\":\"803bacb90f1a4295\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/propertyEditorOverride.js\":\"106ee200829faf20\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/useToggleTree.js\":\"0618091cac25fdda\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/ExtractTypeDialog.js\":\"aa44b744d557b057\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f04871a86319508b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/PropertyShapePicker.js\":\"4dffd93b64814b82\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/action.js\":\"dc7d12ac688cccd0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/index.js\":\"9ac11993d564a5b1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/FindReplaceDialog.js\":\"67c5e70e277f90b8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/HeaderItem.js\":\"6c8e4244ebb5e261\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/dataExtension.js\":\"54aab78957cbd270\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/index.js\":\"7f685ecd7031fb71\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/search.js\":\"2e3116ae4f30ed2a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/toggleStore.js\":\"80ff9c6974835621\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/LocationPropertyEditor.js\":\"c493b2555e8a9de0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/MapView.js\":\"7cc2c3d591b2728c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/blockTypes.js\":\"7bb5a25793a1976a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/codeMirrorExtensions.js\":\"172a916db806867f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/createOrFindPlace.js\":\"de26845e8ccdfea9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/currentLocation.js\":\"3960513e7226989e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/dataExtension.js\":\"4686bd3d8de02059\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/geoContentDecorator.js\":\"b10ac5861310839e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/googlePlacesClient.js\":\"69dbad1487dbc36d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/index.js\":\"184a14ea5dbe50a0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/locationsPage.js\":\"3bbb93e1900ddda9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/mapViewport.js\":\"3fadf2cc5cbd8751\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/pickCurrentLocation.js\":\"037c0abec92e763e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/placeAutocomplete.js\":\"ade9ca566f20aa9e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/placeNameCollision.js\":\"6efaad8e76993574\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/properties.js\":\"7b3ca161cd2c50d7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/propertyEditorOverrides.js\":\"3afcef39aa18ffe6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/query.js\":\"f23c3f93aacbec6f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/usePlaceSearch.js\":\"41063a7cdc7ab7a3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b28798514e68adf5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"8a430d5f0b86b835\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"58ea8ce564ea1802\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/config.js\":\"0d89ec1f69efe9e1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/dataExtension.js\":\"2f197be785127f87\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/facet.js\":\"1a7c1a177facf033\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/grouping.js\":\"cef58eb5fbd7d1a8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/index.js\":\"d1777dcd8ed88935\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"8ed07391b9dd4951\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/query.js\":\"a7a211cbe3427226\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/resolveConfig.js\":\"ce62e50d97694323\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"3af5e622792e4df2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"452ca02e7028661d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/HtmlDocumentContent.js\":\"4f8588d1b5951106\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/HtmlFrame.js\":\"6e9cc0548e409cad\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/actions.js\":\"cad984f3f4d9f574\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/blockType.js\":\"e9e1f460a9c40589\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/confirmRunScripts.js\":\"a2b6c43932e6e041\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/dataExtension.js\":\"12dbe77830cc813d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/frameAnnotations.js\":\"a66326843007c9f1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/frameDocument.js\":\"5c8209dde0175337\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/frameTheme.js\":\"e3623e8ee037d752\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/index.js\":\"1c4a86c21cbd0780\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/scriptConsent.js\":\"1f3459db6cf7fd87\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/sourceMap.js\":\"6ed17696c8407b07\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/useDocumentScripts.js\":\"31761567745618bf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/index.js\":\"54f1efd44b552059\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/record.js\":\"e394c6905b9acf7e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/recordStore.js\":\"8556e91447c6afd1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/responsiveness.js\":\"acc8164836894bdc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/schedule.js\":\"3d30098e01744846\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/sessionContext.js\":\"f07934ec410868de\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b96e285ef6099f19\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e90b975128e4ce1f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/actions.js\":\"3848d0a6a31db1cb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/config.js\":\"906abc81f5e6b4b3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/dataExtension.js\":\"32b745750d80fad1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/effect.js\":\"1e05d92ab5a5e907\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/index.js\":\"25c5b8807dcc797d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/keyCapture.js\":\"737e7bc270cff4d9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/overrideStore.js\":\"b07a7a75bb22e035\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3a451aa516ddbdf0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/HeaderItem.js\":\"2d3c2a5d626e429f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/LeftSidebar.js\":\"d1a13669fb864874\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/actions.js\":\"ee24db8ebb98f3d1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/facet.js\":\"5f4b3faf9ff60249\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/index.js\":\"b9636d804b01400a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/shortcuts.js\":\"60b2615d5b0170a5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/toggleStore.js\":\"dcb2fe94fbc9dfca\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/merge-blocks/MergePicker.js\":\"36ead0e0669ac77f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/merge-blocks/index.js\":\"d4f25c5fa774c97f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/merge-blocks/mergeAction.js\":\"c6ac21380af1fc90\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/merge-blocks/strategy.js\":\"9912bb0c7436c49f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/Button.js\":\"5c8e25b72b4df185\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e9617df243a0f3b8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/defaultItems.js\":\"44a69a05c94767cb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/facet.js\":\"247a469da82a286f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/index.js\":\"068bbc349395bd19\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"564f07bc072cddf5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e2455a6e9d897ec9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0e2bfc8c7146bc7d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/facet.js\":\"a1acf4c417d7c3b6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/index.js\":\"87f06cc7dfe74fbc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/MoveDestinationPicker.js\":\"4ebe3157690aff4f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e307cf20ff216026\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/contextMenuItem.js\":\"df5b56a7dab93a04\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/index.js\":\"d7e9af117fb53470\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/moveAction.js\":\"ec1e0cffeb7aa4b9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/moveBlocks.js\":\"b2789c00f449a76e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/selectionAfterMove.js\":\"2204ea0b1806d6ed\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/TutorialBanner.js\":\"3a9d0cfa4623d62e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/action.js\":\"4b6f59b1488ef256\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/bannerDismissal.js\":\"d68c719b0b5119db\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/documents/cheatSheet.js\":\"90c1c78e54d2f107\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/index.js\":\"36d0838f3998abae\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/keys.js\":\"068112462036e9e1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/landing.js\":\"abd0a341761b5eb1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/outline.js\":\"7c44dcc0a21cad49\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/seed.js\":\"5ac940cff82d9af7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b7516a8ed0b89cb6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/analyze.js\":\"7a1bed8796f5a1b4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/diagnosticsSource.js\":\"01b2bb70c052d7e7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/index.js\":\"89da4b56615d1fcb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/load.js\":\"1881b63dc15d28ed\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/monitorRun.js\":\"b3b30b4a3dc34cf3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/schedule.js\":\"af05794030c81722\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/series.js\":\"8e17029f1e10b3a7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/store.js\":\"8f385b5c44b65eaf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/trendAction.js\":\"c466cf9c53282766\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/verdict.js\":\"f39e117e45f1e0b7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/plain-outliner/clickToEditAction.js\":\"c7221218ac330bdd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/plain-outliner/index.js\":\"077867ae0df093dd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/plain-outliner/interactions.js\":\"cb09a805dfcc39dc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"82be05da18814f60\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/MigrationGate.js\":\"7e816a5836f8a671\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/MigrationGateDialog.js\":\"cf1d82ef1e8ef0ad\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/action.js\":\"1d7bf0a7af606502\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/index.js\":\"036b0e027215cb5a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/localRunMessage.js\":\"9ffbdcf4767a8f76\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/plugin.js\":\"56f4eec1f5d1fcec\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/progressReport.js\":\"50efcf94237a8f25\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/sweepProgress.js\":\"3fd5412e556e0b48\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/FieldRowRenderer.js\":\"92ab95a26e6f6e25\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/ValueRowRenderer.js\":\"7e6273835f52554e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/actions.js\":\"3ad0872e636347bb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/autocomplete.js\":\"7f92abac539b575a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/fieldRow.js\":\"9267e8735c9743b4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/index.js\":\"e62e07f5c2ad0807\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/referenceWarning.js\":\"b5648ab2cb2de0ff\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/valueAutocomplete.js\":\"359d10b5036bc424\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/valueSchema.js\":\"58a02b9d7a536cd3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/HeaderItem.js\":\"84ce1b364539e779\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/QuickFind.js\":\"c01c1825c018c08e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/index.js\":\"a6bf9a032919d683\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/recents.js\":\"4a16fdd2e193a3bc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/resultItems.js\":\"8809b2e3f00d3be0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/selection.js\":\"d3d64752e431ec8b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/toggleStore.js\":\"6a5cd4bb3161ce15\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/HeaderItem.js\":\"9dccd4b1b500b8c5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ad92ef53e35496ba\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/grouping.js\":\"348b64b6b39056ae\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/index.js\":\"6610dc80f3cf4b7b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/target.js\":\"36f22fe5de537c35\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/codeMirrorExtensions.js\":\"e86c591e86dd94cc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/contentPrefill.js\":\"22d0dbf396b940d8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/dataExtension.js\":\"79f4bb564274ff15\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/index.js\":\"86ba2faeac16f789\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"76cf720062e08ba8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/invalidation.js\":\"6eb362b72fb2c3d0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/localSchema.js\":\"39c02fe9707937cf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/blockrefs/index.js\":\"e1de65d511a30848\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"05167d9e61ce9917\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/index.js\":\"52f1ae554f34ac49\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/referenceNode.js\":\"1d77da7b7cd0607c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/remark-reference-occurrences.js\":\"7327f1369e4ee99c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"802489dca97f7414\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/wikilinks/index.js\":\"0313a8e349f2b1af\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"12e37649c0402536\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"9e34748cc11a8222\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/mergeRetargetProcessor.js\":\"d8ac7027f0eb54d9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/parseFence.js\":\"686b5b4b47e18997\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/referenceParser.js\":\"298e8e773643cf24\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/referenceProjection.js\":\"bfce2954dd0dbb8b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/referencesProcessor.js\":\"8a43f8d1ef805536\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/renameProcessor.js\":\"7a432f141ec91dfa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/spanReplacement.js\":\"bf51120cf487faa7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/rich-paste/htmlToOutline.js\":\"58111ddf4bfac6f9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/rich-paste/index.js\":\"02327c5761ed0b2d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/rich-paste/normalizeClipboardDom.js\":\"24edc0601cd5fa5a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/rich-paste/pasteDecision.js\":\"22469dc5f44f5cbf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/action.js\":\"99845758a8066d7c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/blockIds.js\":\"1fcda6ed7b6fc611\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/content.js\":\"84a3dc83b09c1d68\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/effect.js\":\"4a402465c8dc0137\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/ids.js\":\"935a80704388b898\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/import.js\":\"3dd87ac724ec9532\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/index.js\":\"e87679dd1b425c71\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/plan.js\":\"53b52c4cd0617cff\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/plugin.js\":\"f11eac18bd8146a4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/promotion.js\":\"19d147d01c0cded3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/properties.js\":\"161c6d48abe33d2b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/references.js\":\"bdf6bef266eb4f97\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/report.js\":\"44e462e7e02b1230\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/roamMemo.js\":\"8496ca781d9fe520\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/runtime.js\":\"c6436ca36f1f0c52\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/schemaReconciliation.js\":\"e8b33a19c7a7f9a2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/srsMarkers.js\":\"16cd5cf284265b05\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/todo.js\":\"e7a2c09415090c64\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/typeCandidates.js\":\"128898c619a8354e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/types.js\":\"2e9c25aca157a1e2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/search-health/index.js\":\"4f17df6c53e3a887\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/search-health/store.js\":\"41cc24cdf09a34a7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/HeaderItem.js\":\"a232ea1277d15922\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"cd5e0cb918491e6b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/index.js\":\"aa457fb669335f4b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/model.js\":\"75efd9965d36f742\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/toggleStore.js\":\"3de9cff1527d1815\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/useKeyInspector.js\":\"1f37e2d7c6a9645b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"82b6286d8dffe1dc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/ShellDecorator.js\":\"4d6a2060b9be5259\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/actions.js\":\"5281ed9924f4e668\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/exclusionsFacet.js\":\"163dbc7a6dadd409\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/index.js\":\"6d3a8f4e14919927\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/shell.js\":\"b6e81002c7e1831d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/surface.js\":\"94c05435a6a89070\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/walker.js\":\"0849a4a1488dda7d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f26c6fb211f6b79a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/dataExtension.js\":\"feb9a45536ed34b7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/index.js\":\"36186bc47d0abd95\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/indicator.js\":\"90daa6161de98565\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/moveSrsState.js\":\"1acd22e3175f9adf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"81bb6460de589116\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/scheduler.js\":\"b7fa25756448d8fb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/schema.js\":\"55a2e83b040b7d41\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"873b945abcbbaadf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/srsClipboard.js\":\"12fabc7cb5e0ca7d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b4a0f529af85a785\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/DailyNoteReviewHint.js\":\"67e953dfa5456a28\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/DeckPicker.js\":\"6a8fefbb95e5ae57\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/ReviewControls.js\":\"1f2768a03d8adb5a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/ReviewDeckRenderer.js\":\"4aa6fe4a348e5065\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/ReviewSession.js\":\"6b1ffa56ac72b0e5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/actions.js\":\"60f1c4232401d19b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/archive.js\":\"9db6de58c11d064c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/dataExtension.js\":\"58d07e8755d00449\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/deck.js\":\"64d05cc1f8b7f28b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/dueQuery.js\":\"4228d8150f28c49f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/gradeDecision.js\":\"eca96206cadfc6f8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/index.js\":\"4210d3c3728548c5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/keyHints.js\":\"ded1acbce99c11c1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/reviewCardLayout.js\":\"786cde4c0ddf9bbd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/reviewProgress.js\":\"668e46035199fef1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/schema.js\":\"bafbf3160793d14d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/useDueCards.js\":\"cd918b155cbf81b7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/startup-metrics/index.js\":\"0746912e69c934ae\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/startup-metrics/record.js\":\"84f3617832ea2ba8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/storage-persistence/index.js\":\"f45476454a1e2ef1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/storage-persistence/persistenceStatus.js\":\"a0220bf08d451482\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/storage-persistence/requestAction.js\":\"a0c8eac297921608\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/supertags/TypeChipsDecorator.js\":\"49810e48f5892977\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/supertags/codeMirrorExtensions.js\":\"58351562d8705a39\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/supertags/index.js\":\"dcd6453dcb5cae7d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/supertags/typeAutocomplete.js\":\"efa9c60ddb6a856f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"1708107211014dde\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/actions.js\":\"da47ce87aa97158b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/anchor.js\":\"a62e622a6f4841e3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/events.js\":\"46699b6342803828\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/gestureActions.js\":\"9923758510d7e2ec\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/index.js\":\"20449701caaa508c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"6e4ab926c9bf0d1b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/sync-metrics/collect.js\":\"2303598f4050bf28\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/sync-metrics/index.js\":\"a478c360f131b372\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/sync-metrics/record.js\":\"9c8b36a253eb2a99\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/RejectionDialog.js\":\"ca58edbc9f60bc42\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d8a7d1aa7522e50e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/index.js\":\"528bb1a1addfb655\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/model.js\":\"ed7ef0ea488b5eda\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/queueCounts.js\":\"a89d51c94c818444\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/rejectedHelpers.js\":\"1faa67c5213c2931\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/rematerializeAction.js\":\"fcfd6e392ff9b2c0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/useHysteresis.js\":\"1cdeedd819367cea\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/ColumnHeaders.js\":\"c9d9a2b6e5d8586e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/QueryUi.js\":\"b76d74ea8c89a955\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/TableLayout.js\":\"4491b23a9130811d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/actions.js\":\"ed318adb0e09a04d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/cellEdits.js\":\"13d1de21003e65ca\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/childrenViews.js\":\"5f7651de01f5c0b2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/columns.js\":\"154def904a3a38f0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/controller.js\":\"89fff0f80338fa15\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/convert.js\":\"44fab399de86202f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/dataExtension.js\":\"5aca9eb6810c8827\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/index.js\":\"d9e15698e87daac8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/keys.js\":\"48709669441b110c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/model.js\":\"2ece8f9db1445649\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/backfill.js\":\"fceb1915dad65462\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/completion.js\":\"9943ca828279fa17\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/format.js\":\"23f91d2304464974\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/parse.js\":\"0e7657ca48f32c15\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/queryValue.js\":\"c2ef4760f10f1917\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/registrations.js\":\"db7660ed374e130a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/source.js\":\"2bc95dc034f5535b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/registry.js\":\"5f2ac143e1ed8538\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/rowGutter.js\":\"278075754b9fbc68\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/rowVerbs.js\":\"32a02b30a9029190\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/schema.js\":\"e68b3cb301a57145\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/sort.js\":\"d8d3222a0e05bdc2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/theme-toggle/effect.js\":\"8f9582d533a5e320\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/theme-toggle/index.js\":\"7f45adf70c5a7c77\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/theme-toggle/theme.js\":\"fe65acbf2807abe1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/todo/actions.js\":\"01d9174e1d759fd0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/todo/dataExtension.js\":\"816563d4e3ff3b00\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/todo/index.js\":\"1be6ce6448cf9409\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/todo/schema.js\":\"e15b1e128075bbf6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/TouchSelectionLayer.js\":\"14e50426ac208f71\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/actions.js\":\"e9aa339f1a400ae3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/defaultItems.js\":\"b831226cbfe70ef9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/facet.js\":\"3f49c4bd1428bc5b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/holdRecognizer.js\":\"347381d3ef74e63b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/index.js\":\"d07b42b8fe7bb7e5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/update-indicator/UpdateIndicator.js\":\"e5bc63ac48d49a04\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/update-indicator/index.js\":\"7564af40dd79e869\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/update-indicator/loadTimes.js\":\"508e4c1c9bb81d48\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/VideoNotesRenderer.js\":\"95720d21b96d43ec\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/VideoPlayerRenderer.js\":\"5f2629b8ac8990b5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/VideoTimeStamp.js\":\"c5093dda1bea0947\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/actions.js\":\"8e32a35da84b7ef8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/index.js\":\"5777b0b81cabae96\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/markdown.js\":\"164e1e0bce5d8024\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/notes.js\":\"37f51ba54f063d0f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/registry.js\":\"e7b7b0ad60829730\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/remark-timestamps.js\":\"8af03296160375c0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/view.js\":\"36f8a82002bbd82a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-link-hints/LinkHints.js\":\"20b853981834dc64\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-link-hints/index.js\":\"4c987fa41eec016f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-link-hints/model.js\":\"ede2da5e4139c9b3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-link-hints/settings.js\":\"70caab16182b07ac\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-normal-mode/actions.js\":\"500c283824eb8537\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-normal-mode/index.js\":\"ba9ea4e65a40a055\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-normal-mode/interactions.js\":\"c9cd3d9260d39e2c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/workspace-header/index.js\":\"2ac889aed698494b\",\"/knowledge-medium/pr-preview/pr-1879/src/registerServiceWorker.js\":\"757f3091fabaa652\",\"/knowledge-medium/pr-preview/pr-1879/src/requestPersistentStorage.js\":\"59a36528cc475e04\",\"/knowledge-medium/pr-preview/pr-1879/src/services/authRequestDeadline.js\":\"1b767f56d80b1923\",\"/knowledge-medium/pr-preview/pr-1879/src/services/authStorage.js\":\"6af2955defeff1c3\",\"/knowledge-medium/pr-preview/pr-1879/src/services/powersync.js\":\"79929bc80ae643b4\",\"/knowledge-medium/pr-preview/pr-1879/src/services/supabase.js\":\"9545acf4bac111b4\",\"/knowledge-medium/pr-preview/pr-1879/src/services/uploadErrorClassifier.js\":\"c5e85101879665d5\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/ActiveContexts.js\":\"ea9171b40103356a\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/HotkeyReconciler.js\":\"eb7bbe56049b01ce\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/WipeLocalDataDialog.js\":\"9cbde09f715c32e2\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/actionDispatch.js\":\"96c722316e1d0dea\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/actionRefItems.js\":\"99c9e48e9d518128\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/applyKeybindingOverrides.js\":\"f421a73ec82f9832\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/blockActions.js\":\"670cc3b60f8a5a79\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/blockMergeGesture.js\":\"96a257b6e2ba58e2\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/canonicalizeChord.js\":\"eb75067c359c6507\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/defaultContexts.js\":\"806d3d05b5068bdb\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/defaultShortcuts.js\":\"80bcba8a5799c708\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/effectiveActions.js\":\"7c90987962ea0852\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/gestureAction.js\":\"17c505704a8ab16c\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/gestureBinding.js\":\"3bc531dc7dd9c383\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/holdRegistry.js\":\"c2da65f6dded7d23\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/keybindingConflicts.js\":\"0d2bd1cfe0da990b\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/keybindingOverrides.js\":\"212a31d47b506a7f\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/pointerAction.js\":\"79ebb8304b9bba2b\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/resolve.js\":\"66ea0cc05391a8a4\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/runAction.js\":\"b27a3a28fcced0ab\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/sequenceMatcher.js\":\"3250242e69974b82\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/types.js\":\"d99163854d858966\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/useActionContext.js\":\"62a2e38b9b02c238\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/useActionDiscovery.js\":\"4fe9077178f08295\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/utils.js\":\"08a76cd057978ffb\",\"/knowledge-medium/pr-preview/pr-1879/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1879/src/sw/bootStore.js\":\"9d8975ce3ac8f96e\",\"/knowledge-medium/pr-preview/pr-1879/src/sw/previewDatabases.js\":\"0d81512fdd54daf7\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/byteTransform.js\":\"a1432785a9e75751\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/attachmentCleaner.js\":\"89e45d15db5af488\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/attachmentParts.js\":\"058b5bc1b307fdd0\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/bundleParts.js\":\"5a4ffd1eae85ea12\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/bundleRecord.js\":\"e77d7ad60f0037f8\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/manifest.js\":\"fbe118f56be53ebf\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/takeBundle.js\":\"2a78a131e711efb0\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/verifyBundle.js\":\"69f750736d9efb92\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/cleaningStage.js\":\"6ee7a2aff4716aae\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/conversionKey.js\":\"06b7ce134532225b\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/conversionServer.js\":\"c5b5cec56a5fad28\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/flip.js\":\"5ed0e1fd5dcf91b1\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/flipAttempts.js\":\"a2646c1d136d5080\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/pages.js\":\"b97548efa405965f\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/preflight.js\":\"beb2a6b016c11903\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/reseal.js\":\"56888dc4fd26f7c1\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/runConversion.js\":\"0557283e9ce0e64e\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/runLock.js\":\"e2f0120d5260e6d6\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/sealing.js\":\"52769abedff57078\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/sealingStage.js\":\"1913ef4c8cfd9ecc\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/stage.js\":\"30b3824f6a84c36f\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/verifyReseal.js\":\"152c957c6567d015\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/aad.js\":\"22896fac9a89ebad\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/aead.js\":\"740dc9bf913137e0\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/base32.js\":\"bf015348cfadd530\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/base64url.js\":\"57d9ca8fa61c29d0\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/binaryEnvelope.js\":\"142c21dce8f55d6a\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/byteAead.js\":\"18a7f513d78fa93a\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/canary.js\":\"524361a682e3983e\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/contentHash.js\":\"3d868c8da0697bb6\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/contentKey.js\":\"1e668560580f7e01\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/derivedIdNamespace.js\":\"9abaac48c4b2be30\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/envelope.js\":\"de3138fcb8801bfd\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/hex.js\":\"a33bbcc62412587e\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/sha256Hex.js\":\"440dfc01bbf7cceb\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/workspaceKey.js\":\"faf63afd9e445f1a\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/conversionState.js\":\"89176c835f10b366\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/flows/createEncryptedWorkspace.js\":\"59bc9a4a56cfe412\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/flows/pastedKey.js\":\"7ef40712dc7a0779\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bbaf624d95547258\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/flows/upgradeWorkspacePin.js\":\"dd3b6be006471865\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/keyStore.js\":\"5f9c25c071eb6a18\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/mintWorkspaceKey.js\":\"c4ace762ffcb065f\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/modePin.js\":\"6f1eeda82d3bb6f0\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/openWorkspaceKeys.js\":\"ad6a26f6f968b5d5\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/resolveWorkspaceEntry.js\":\"967075f0a0624fb9\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/resolver.js\":\"5175cb1f59cc2771\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/workspaceAccess.js\":\"b858930494f0f22f\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/transform.js\":\"b09ec46ba383f80e\",\"/knowledge-medium/pr-preview/pr-1879/src/themeBootDefaults.js\":\"7a2c650c684533fe\",\"/knowledge-medium/pr-preview/pr-1879/src/types.js\":\"795b7fbcab766d72\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/ClientLocalSettings.js\":\"6aa9ff0cac596bae\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/abortableSleep.js\":\"3b3719f7136cd2df\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/array.js\":\"bef8aa2fdce3dcf0\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/backlinkAutocomplete.js\":\"08beb0d0982d0a8c\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/blockCrumbs.js\":\"334b3b5a4912d52b\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/blockrefAutocomplete.js\":\"5ada892e0b33fe87\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/cadencedIdleJob.js\":\"c4d3b8f8c0b30114\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/callbackSet.js\":\"2e6edcbf3ec8e26d\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/clientId.js\":\"611982108f23adad\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/codemirror.js\":\"7ddac402e61f45bb\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/codemirrorCompletion.js\":\"117b5290897c3d17\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/copy.js\":\"43f1d8c45398013a\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dailyPage.js\":\"02fb1ce555e1718f\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dbForensics.js\":\"2a2a84e6841c1ffd\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dbForensicsHooks.js\":\"0fb9f2b31bee7937\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/deleteBlockThroughUi.js\":\"3907ea5116f21317\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dialogs.js\":\"5127e7ddcf436108\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dom.js\":\"a018c863f7135eb5\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/downloadBlob.js\":\"50269afaccef73d3\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/drawnWalk.js\":\"9be8b00e0b9f8a52\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/exportSqliteDb.js\":\"9466145cfe0e4d1a\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/fileSystemAccess.js\":\"1aa4cef8caee2497\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/flipSlide.js\":\"f52e127a99199c0e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/fnv1a.js\":\"37a36998d606543e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/formatBytes.js\":\"525e1290bcd89f29\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/fuzzyRank.js\":\"1ab40cb83de61b88\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/idbKeyedStore.js\":\"f5ca6e59aa54c020\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/idleCallbackPolyfill.js\":\"ed1ff79685ca7e31\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/keyboardAwareScroll.js\":\"6f8321b36c06edae\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/keyboardViewport.js\":\"a34ffd9541a50f94\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/lastWorkspace.js\":\"09e0d072c60ab93a\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/layoutColumns.js\":\"f207fa6372e6d808\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/layoutSessionDom.js\":\"b00dff0e6a51cbbd\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/layoutSessionId.js\":\"864cfb095b9d551c\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/linkClickGestures.js\":\"40e97a4822b0f415\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/linkTargetAutocomplete.js\":\"cc1983f7e5a31333\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/localDbCorruption.js\":\"3b96e95bc775d1f8\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/localDbRecovery.js\":\"26e2656e6c8b049e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/markdownParser.js\":\"09ec4912974a01ed\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/memoize.js\":\"54c5a4abbbd9f5f2\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/nameFieldCommit.js\":\"3d45fc9b17a7141a\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/nameList.js\":\"59b33f23ed24dc1b\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/navigation.js\":\"6e1918a720e1b239\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/omnilinerNamespace.js\":\"28ef0ee62b40f9af\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/opfsPageScan.js\":\"963f77b0f6400bf0\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelClearance.js\":\"5dd0491b07513009\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelHistory.js\":\"abf78ec6f1e49c23\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelLanes.js\":\"72b4a4230bb9c596\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelLayoutProjection.js\":\"0363bcd22d4bdfd1\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelScrollAnchor.js\":\"b1639ed1a9e5948e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelUrlFlags.js\":\"6690c8b93ef01d00\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/platform.js\":\"0a324fae02c1b9f4\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/pluralize.js\":\"2e0675605828304e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/propertyCreation.js\":\"035d1ef1659e18c3\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/propertyNavigation.js\":\"063195d5e0fcca0e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/propertyValueContext.js\":\"5363f65344b33efc\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/react.js\":\"6df5df8db64e990a\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/relativeDate.js\":\"0efdae5d11ee6ca5\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/relativeTime.js\":\"ab71b16e2240e1d0\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/renderScope.js\":\"138ef00e96dee75b\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/resolvedThenable.js\":\"688f806ce0e87d3a\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/routing.js\":\"690fdabbfb644aac\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/safeMode.js\":\"2ef5aa42c81d3cf0\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/scheduleIdle.js\":\"e95a99f7f65bd6b4\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/screenWakeLock.js\":\"e556decc2a2d23e6\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/selection.js\":\"12bd988703cb8672\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/softKeyboardGrab.js\":\"d064d34987b515f0\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/startupTimeline.js\":\"bd58515fa9a6d912\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/state.js\":\"3f28ff0b4ebc0e2d\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/string.js\":\"c5b148acc251a077\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/surfaceZoom.js\":\"fb236774aa70d7ae\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/time.js\":\"3d224d6cd2755d5f\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/toast.js\":\"8cc23a3a2d4695c5\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/toggleStore.js\":\"db63c18315c30438\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/untilStopped.js\":\"85670a25a7b9895c\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/userActivity.js\":\"67eb4ec73721fadb\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/viewTransition.js\":\"a18eb876f78cef2b\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/viewport.js\":\"1ee7c3cc6a70d38b\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/webLock.js\":\"6b175410f459319f\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/workspaceRecovery.js\":\"6a27da1bde475b65\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/workspaceSnapshotStore.js\":\"fe8dfe6e9ce97f44\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-compiler-runtime.js\":\"546ca86377081dc3\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-client.js\":\"956ceb35218c4eb4\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-server-edge.js\":\"e18a50e4ed0891e9\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-server.js\":\"0e14d62168658313\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-static-edge.js\":\"6b0959b584a0b8c2\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-static.js\":\"17f53210861b8b31\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-test-utils.js\":\"85b1ba9941c19a21\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom.js\":\"6c3aa3ebd964bc6b\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-jsx-runtime.js\":\"e13987af1d4cef4f\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react.js\":\"22a3496d4ae8771f\",\"/knowledge-medium/pr-preview/pr-1879/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1879/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1879/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
