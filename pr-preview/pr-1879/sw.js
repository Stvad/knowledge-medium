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
		buildId: "490a53be109d-756c0218",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1879/\":\"b2eb3cfb58b4c730\",\"/knowledge-medium/pr-preview/pr-1879/index.html\":\"b2eb3cfb58b4c730\",\"/knowledge-medium/pr-preview/pr-1879/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1879/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1879/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1879/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1879/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1879/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1879/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1879/assets/FacadeVFS-3KPqmSS1.js\":\"9caee2be2f309d97\",\"/knowledge-medium/pr-preview/pr-1879/assets/OPFSCoopSyncVFS-eDdK5pOt.js\":\"edf6c3d3480e3cc8\",\"/knowledge-medium/pr-preview/pr-1879/assets/OPFSWriteAheadVFS-C6c3p-hK.js\":\"6c8a73af640169d2\",\"/knowledge-medium/pr-preview/pr-1879/assets/wa-sqlite-CNO39PCt.js\":\"f50fd7ada9c01b76\",\"/knowledge-medium/pr-preview/pr-1879/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1879/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1879/assets/wa-sqlite-async-CNOry4Pj.js\":\"ae5fb9ef0acaad58\",\"/knowledge-medium/pr-preview/pr-1879/assets/worker-CDCWdeQ1.js\":\"c3ab3934b9aa20fb\",\"/knowledge-medium/pr-preview/pr-1879/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1879/chunks/app-8QyiJOIf.js\":\"8242e09941c9c3b4\",\"/knowledge-medium/pr-preview/pr-1879/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1879/index.js\":\"8f7a11c6c72ce30c\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1879/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1879/assets/AccessHandlePoolVFS-Cd3t_MCe.js\":\"d06e586e69a3ccd4\",\"/knowledge-medium/pr-preview/pr-1879/assets/IDBBatchAtomicVFS-CWZGG3Sc.js\":\"1ae71949fab43ea7\",\"/knowledge-medium/pr-preview/pr-1879/assets/MemoryVFS-BiNgvdiE.js\":\"c6678fc745c6221e\",\"/knowledge-medium/pr-preview/pr-1879/assets/mc-wa-sqlite-8eyGLNru.js\":\"4c72f6040bb3dd19\",\"/knowledge-medium/pr-preview/pr-1879/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1879/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1879/assets/mc-wa-sqlite-async-fWHFzOFw.js\":\"7985f85180a106f5\",\"/knowledge-medium/pr-preview/pr-1879/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1879/chunks/AccessHandlePoolVFS-9IVemhTZ.js\":\"30932c900efba558\",\"/knowledge-medium/pr-preview/pr-1879/chunks/FacadeVFS-OA5E1nmI.js\":\"185d778df5d5729d\",\"/knowledge-medium/pr-preview/pr-1879/chunks/IDBBatchAtomicVFS-BOKLX5vH.js\":\"2df8f7fab76dc346\",\"/knowledge-medium/pr-preview/pr-1879/chunks/MemoryVFS-CVenJM5X.js\":\"fa1b9dbc1e718e94\",\"/knowledge-medium/pr-preview/pr-1879/chunks/OPFSCoopSyncVFS-CWKtcaj1.js\":\"1c312b7d9ede3c12\",\"/knowledge-medium/pr-preview/pr-1879/chunks/OPFSWriteAheadVFS-CtD4eReB.js\":\"5f212432cda7c56b\",\"/knowledge-medium/pr-preview/pr-1879/chunks/Preview-FXnTSH75.js\":\"55dbcd7a9a54831c\",\"/knowledge-medium/pr-preview/pr-1879/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1879/chunks/card-C0A_c6sE.js\":\"1cd10bb9b2d9d1a2\",\"/knowledge-medium/pr-preview/pr-1879/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1879/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1879/chunks/dist-BAty3RPZ.js\":\"0274aebdbcda66b7\",\"/knowledge-medium/pr-preview/pr-1879/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1879/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1879/chunks/mc-wa-sqlite-BBa47XBt.js\":\"d49b5d5409963e04\",\"/knowledge-medium/pr-preview/pr-1879/chunks/mc-wa-sqlite-async-DiEet_vN.js\":\"70bd3976a8d203d6\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-BZUG5xRh.js\":\"c8af0c997c76b912\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-BgV3VZwV.js\":\"c668040800a79cc8\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-BpoZtReH.js\":\"fb9993eb2ca44c5e\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-CHnyT7Kp.js\":\"1cde2a8f350dab3e\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-DnN-hneX.js\":\"54a08dc98bf46be6\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-chDN2E0g.js\":\"0ef067add493499a\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-dom-server-legacy.browser.production-hWJPfcZ1.js\":\"b14dfec01dde6e49\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-dom-server.browser.production-BDrv9Z6F.js\":\"14a0a32cddab0908\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-dom-server.edge.production-BM8qGwoR.js\":\"dedeb3da9b2c28a8\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-gmICe2O5.js\":\"8c54728cd981021a\",\"/knowledge-medium/pr-preview/pr-1879/chunks/react-ysFOP3yc.js\":\"b8db5d6c6e20d6f3\",\"/knowledge-medium/pr-preview/pr-1879/chunks/server.browser-ByVbNCl1.js\":\"72d2a16d53c61546\",\"/knowledge-medium/pr-preview/pr-1879/chunks/textarea-gj2wUXW2.js\":\"9002c124b0f37c05\",\"/knowledge-medium/pr-preview/pr-1879/chunks/ui-D1BgrpYw.js\":\"b13dbd8146785640\",\"/knowledge-medium/pr-preview/pr-1879/chunks/wa-sqlite-BX9sd18l.js\":\"a7f1c41f7f2c1fa4\",\"/knowledge-medium/pr-preview/pr-1879/chunks/wa-sqlite-async-B4F1_ytC.js\":\"ee0f06b6b29a3594\",\"/knowledge-medium/pr-preview/pr-1879/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1879/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1879/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1879/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1879/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1879/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1879/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1879/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1879/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1879/src/App.js\":\"54d5ad75c46c7bef\",\"/knowledge-medium/pr-preview/pr-1879/src/appUpdate.js\":\"85402d4b2df844b7\",\"/knowledge-medium/pr-preview/pr-1879/src/appVersion.js\":\"20f3bac74549bf28\",\"/knowledge-medium/pr-preview/pr-1879/src/bootstrap/initialLayout.js\":\"2ac2853f9aadc0bf\",\"/knowledge-medium/pr-preview/pr-1879/src/bootstrap/openWorkspaceData.js\":\"de215a54dac025c0\",\"/knowledge-medium/pr-preview/pr-1879/src/bootstrap/resolveWorkspace.js\":\"44dcbf5cc7716178\",\"/knowledge-medium/pr-preview/pr-1879/src/bootstrap/workspaceBootstrap.js\":\"ee5243a2fefee5d0\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockComponent.js\":\"19a446a067d5edf5\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockCrumbs.js\":\"a2b678b82f72715f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockEditor.js\":\"4a5cdde95775412b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockLoadingPlaceholder.js\":\"b0767623483a8b41\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockProperties.js\":\"fb4193511c8e4e45\",\"/knowledge-medium/pr-preview/pr-1879/src/components/BlockSearchPicker.js\":\"cacd4a04f6203c81\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ConfirmBulkDeleteDialog.js\":\"02f609e99751a81b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/DividerHandle.js\":\"59a0bd2831ec7655\",\"/knowledge-medium/pr-preview/pr-1879/src/components/DraftEditor.js\":\"c1f21415c78d20bc\",\"/knowledge-medium/pr-preview/pr-1879/src/components/GutterPill.js\":\"1d6325da1fd5175d\",\"/knowledge-medium/pr-preview/pr-1879/src/components/Header.js\":\"c7fd5a71115aa950\",\"/knowledge-medium/pr-preview/pr-1879/src/components/LazyBlockComponent.js\":\"08c148e8b900d5b6\",\"/knowledge-medium/pr-preview/pr-1879/src/components/Login.js\":\"b4974559d6e70d82\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ZoomableSurface.js\":\"9848db17bc54929f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/editModeKeepalive.js\":\"2b499e0311a12724\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e08a64628d899593\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"cc2185d0457db1e7\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/RefPropertyEditor.js\":\"86928f274248de1e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/RefTargetTypePicker.js\":\"9b865f48db00294c\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/SelectPropertyEditor.js\":\"ef2ae582e97b8b62\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/TypesPropertyEditor.js\":\"da9ebef73b33f0d3\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/defaults.js\":\"983776f53799e24c\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/kernelValuePresets.js\":\"4a0e5da8dca441d7\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/selectablePresets.js\":\"afc41f69fb7043a8\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyEditors/typesPropertyUi.js\":\"523c4562353203c4\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/AddPropertyForm.js\":\"097f8f01e688a176\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/PropertyPicker.js\":\"502b833f58735995\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/PropertyRow.js\":\"a20486a7253a64d7\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/Rows.js\":\"5d199997fe1ecbf2\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/actions.js\":\"a9d44329bcf043ff\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/declarationOnly.js\":\"bf2bb013f65d81b8\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/layout.js\":\"41c137d1bdb89b54\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/model.js\":\"7a287b696f676f81\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/shapeUi.js\":\"64df152f3e55e396\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/shapes.js\":\"59aca71638dcc594\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9bbe44c9c1e26b00\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanel/visibility.js\":\"0075b67249dd0cba\",\"/knowledge-medium/pr-preview/pr-1879/src/components/propertyPanelSections.js\":\"b2fb69a629455031\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/BlockEmbed.js\":\"da6c83122218ac1a\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/BlockLink.js\":\"121ad6c18a16978d\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/BlockRef.js\":\"cd17561eaa30bf37\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/ReferenceLink.js\":\"e0213614a875efb2\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/cycleGuard.js\":\"80d9a69b2f5a5616\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/cycleGuardContext.js\":\"3fdf01bc8125808e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/linkInteraction.js\":\"3d9f14ee2e74c0e4\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/referenceLayout.js\":\"9a21128b9ea0fb83\",\"/knowledge-medium/pr-preview/pr-1879/src/components/references/useBlockRefAncestors.js\":\"ea8a82ce27fc8d3b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/BlockGutter.js\":\"c99e23c1a81a79b9\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/BlockInfoDialog.js\":\"deeb4a64b4cc4eb7\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/BlockTypeBlockRenderer.js\":\"fbbc0e373e110b07\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/BulletHoverCard.js\":\"c0bcd2ec57dad626\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/CodeMirrorContentRenderer.js\":\"34437f65e5272da6\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6e6bd2e11758a5a9\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/ColumnResizeHandles.js\":\"a698355a07b59266\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"082f39b8a13b10e7\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/DefaultBlockRenderer.js\":\"4ec7d438cecdbc93\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/LayoutRenderer.js\":\"74754cfe765f632b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/MarkdownContentRenderer.js\":\"1176dff1f23fb5dc\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/MissingDataRenderer.js\":\"97ce1c1d661a0cce\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/PanelRenderer.js\":\"74c8df8652a54d5d\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/PropertySchemaBlockRenderer.js\":\"50760290e2a0772a\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/TopLevelRenderer.js\":\"a71e3c0cbac4877b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/blockGutterMode.js\":\"2583ee9c7f9ad1fd\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/blockTitleText.js\":\"8445a25d513d3b4f\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/fieldCreationKeydown.js\":\"4c04083001cbe26d\",\"/knowledge-medium/pr-preview/pr-1879/src/components/renderer/layoutRootContext.js\":\"00c0e85a0fc44dc9\",\"/knowledge-medium/pr-preview/pr-1879/src/components/typeChip/TypeChip.js\":\"6b0772dda9da44ca\",\"/knowledge-medium/pr-preview/pr-1879/src/components/typeChip/chipStyle.js\":\"d8b12f8eb9d6c603\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/anchored-floating.js\":\"6ca271a33e31f644\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/button.js\":\"4d061792b89c73fc\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/card.js\":\"d06409c100137cc9\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/checkbox.js\":\"c882e0d1f9858132\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/collapsible.js\":\"68b1e627847857d5\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/command.js\":\"2c81fcb78cf18dfe\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/context-menu.js\":\"8f09375204a3d1a3\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/dialog.js\":\"0ebd9c97ba27ca65\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/dropdown-menu.js\":\"6d968b71849fd765\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/floating-listbox.js\":\"95e9ca45154d6972\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/index.js\":\"a208d77ab930bd7a\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/input.js\":\"c8c800582cf138a2\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/kbd.js\":\"a6bc40d667ede260\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/label.js\":\"dcb633d3a5a704d1\",\"/knowledge-medium/pr-preview/pr-1879/src/components/ui/textarea.js\":\"40e8598852708443\",\"/knowledge-medium/pr-preview/pr-1879/src/components/useEditModeYieldKeepalive.js\":\"fef1b576840750c0\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/BootFallback.js\":\"c5baf2ffba6b5cf6\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/FocusedRowLazyMount.js\":\"14011057378d3107\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/LazyViewportMount.js\":\"46ba0c2a02df2380\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/LocalDbCorruptionFallback.js\":\"2fa5edc12723dc67\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/error.js\":\"5a809f54578abe28\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/lazyMountRegistry.js\":\"f9bbf025e8a0b71e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/util/suspense.js\":\"2cc4a56b5c50d0e2\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/CreateWorkspaceDialog.js\":\"6c15ce66483f6439\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/PendingInvitations.js\":\"f5f3f6d1e0bc5edc\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/SyncProgress.js\":\"05d3cabe3247442b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/UnlockProgress.js\":\"fb15d56578308712\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/WorkspaceKeyGate.js\":\"64adb9420ae15e6a\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/WorkspaceSettingsDialog.js\":\"3de01c04ab88562a\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/WorkspaceSwitcher.js\":\"b4c47c97b93a8fd5\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/WorkspaceSyncGate.js\":\"4d75bf1ba45b4932\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/ConversionFlow.js\":\"0342f72b803531c3\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/ConversionFlowHost.js\":\"7898d3095e34efef\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/EncryptionSection.js\":\"06dd1bfe69153711\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/attachmentPrompts.js\":\"096f535c724b64cf\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b1819ce5652253d6\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/conversionFlowDeps.js\":\"61fe1e66586f75a1\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/conversionFlowStore.js\":\"b8a594522692b343\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/flowUi.js\":\"e8521e5d16de8643\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/conversion/useConversionRun.js\":\"0a0133dae9ab0f1b\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/keyUi.js\":\"451742e819220f55\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/useCloseOnKeyLoss.js\":\"e0fe52abdbd6e11e\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/useCloseOnServerE2ee.js\":\"dfffc62dffd91916\",\"/knowledge-medium/pr-preview/pr-1879/src/components/workspace/workspaceUnlocked.js\":\"dbbe8a1ca0bd9f67\",\"/knowledge-medium/pr-preview/pr-1879/src/context/backgroundSubtree.js\":\"0d78db761cd672f6\",\"/knowledge-medium/pr-preview/pr-1879/src/context/block.js\":\"f314bf2ba4b6e087\",\"/knowledge-medium/pr-preview/pr-1879/src/context/layoutWsContext.js\":\"4889b39a9174ab96\",\"/knowledge-medium/pr-preview/pr-1879/src/context/propertyDisplay.js\":\"88870bbaff669122\",\"/knowledge-medium/pr-preview/pr-1879/src/context/repo.js\":\"9ee674efe2c9c449\",\"/knowledge-medium/pr-preview/pr-1879/src/data/aliasClaim.js\":\"8909ab8b1a083a24\",\"/knowledge-medium/pr-preview/pr-1879/src/data/aliasSeatNamespace.js\":\"aeef7f0da47d49d3\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/blockData.js\":\"06e8ce1167bab53f\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/blockType.js\":\"55bfab3f21114527\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/changeScope.js\":\"d8fcb4ed1e17d9e0\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/codecs.js\":\"659c4f2b299b5cb1\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/derivedData.js\":\"6f18b41a5cfbccc2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/errors.js\":\"573db931786bb9f3\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/events.js\":\"580a174e2e95aaea\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/handle.js\":\"850d1b7b0dedfa75\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/index.js\":\"c782f80e416dde4a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/mutator.js\":\"e28c395228896766\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/processor.js\":\"59da5dbbe2b4b811\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/propertySchema.js\":\"a899f2da46a8e3c7\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/query.js\":\"d46ad50c87ae3181\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/sameTxProcessor.js\":\"08bf149474743f78\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/schema.js\":\"850d1b7b0dedfa75\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/tx.js\":\"850d1b7b0dedfa75\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/typedBlockQuery.js\":\"4cc7c37f01762b19\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/user.js\":\"f126a8b39ce9e104\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/valuePresetCore.js\":\"3cd53069a79ea60b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/api/valuePresets.js\":\"48ea8ad22d92d91c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/attachmentCleanerIOVerb.js\":\"44c8435db9ebaa73\",\"/knowledge-medium/pr-preview/pr-1879/src/data/block.js\":\"c99c99f2c40db312\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockCache.js\":\"7edd355b6ace9549\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockId.js\":\"b55608da0d22cf30\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockLiveness.js\":\"566639f3b60ff09d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockMerge.js\":\"1e8535c2b8319b3d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockSchema.js\":\"770381334e406606\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockTypeLookup.js\":\"5b518fe9a66549af\",\"/knowledge-medium/pr-preview/pr-1879/src/data/blockTypes.js\":\"d9596452d8877c6a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/childrenView.js\":\"f8ef5f23652491b9\",\"/knowledge-medium/pr-preview/pr-1879/src/data/clientContext.js\":\"7850d1437c2c9b2e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/dbFileSiblings.js\":\"ed056d4a2afc46ce\",\"/knowledge-medium/pr-preview/pr-1879/src/data/definitionSeeds.js\":\"dc4a3f2a1ec61797\",\"/knowledge-medium/pr-preview/pr-1879/src/data/derivedIds.js\":\"c846a424dec84e3b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/drawnSubtree.js\":\"105b923e48dc0173\",\"/knowledge-medium/pr-preview/pr-1879/src/data/facetBridge.js\":\"87a346e4480bf3a9\",\"/knowledge-medium/pr-preview/pr-1879/src/data/facets.js\":\"ab96b12e26834f42\",\"/knowledge-medium/pr-preview/pr-1879/src/data/globalState.js\":\"1b2e29b8cff11c6b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/aliasClaimRederiveProcessor.js\":\"50d4350bef9c8a35\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/ancestorBatch.js\":\"55a2354d4cfb744f\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/blockTypeTypeifyProcessor.js\":\"a407cfa2d53e4261\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/clientSchema.js\":\"aa7720a293d50358\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/commitPipeline.js\":\"e1836973f24c202f\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/devAssertions.js\":\"68b76ea20cbc468b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/firstSync.js\":\"b91c8b623a50e1ea\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/freshInitialLoad.js\":\"a730c5010d6d080f\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/graphBackfillClaim.js\":\"4e718ddc063b1dfd\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/handleStore.js\":\"4323fa67f8273a41\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/idleMarkerJobs.js\":\"899f0b03394c135c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/initialDownload.js\":\"b66468169d813592\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/initializeClientDatabase.js\":\"7276f7ddbf7bf7b4\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/jsonCanonical.js\":\"79f96f9d59c60534\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/kernelInvalidation.js\":\"27d6a1258a5300f2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/kernelProcessors.js\":\"99a5bc528d2dfcb3\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/kernelQueries.js\":\"7e196c906fba582a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/mergeTypeMembershipProcessor.js\":\"86bd728de45af77e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/normalizeReferencesProcessor.js\":\"ce43f15ebd6dd4a2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/poolInstrumentation.js\":\"78dfdb3e3c9dd553\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/processorRunner.js\":\"4a8e31f291fa7fde\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyCellBackfill.js\":\"6af194eade133fbd\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyChildMint.js\":\"4a32e034b389d63a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyChildrenProcessor.js\":\"37b954b3de57cff7\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyDefinitionChangeProcessor.js\":\"be43cf71341cdec3\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyDefinitionSynthesis.js\":\"c440659478b8d96d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyKeyScan.js\":\"8d1785e1ce2ebdbe\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertySchemaResolution.js\":\"78937663c17a9bf8\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/propertyValueEdits.js\":\"1755017d4332ca57\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/raiseProtocol.js\":\"2fd0ccc3a27208cb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/readBatch.js\":\"709815943a6b8b7d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/refProjection.js\":\"cf35f8f2fd443d5c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/referenceTargetLookups.js\":\"aa9f566fc7dc920a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/referenceTargetProcessor.js\":\"ca74c52a203bb992\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/replayMerge.js\":\"13054d3cbb787dd2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/sqlBinds.js\":\"f9bd5c7254ecccc6\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"986e565bcf38ea0d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/arrivalProcessors.js\":\"8ee0eb06a53524bd\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/invalidate.js\":\"85726d428a9552bf\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/materialize.js\":\"01748a81b0e80df5\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/observer.js\":\"acfa535a772e3795\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/syncObserver/reconcile.js\":\"19d7290ec8338488\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/timingMetrics.js\":\"f7dda8cf2a828453\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/treeQueries.js\":\"eb9fbf3336c8703a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/txEngine.js\":\"a65f4e909d5d83fd\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/txSnapshots.js\":\"cfb148439989ab33\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/typedBlockQuery.js\":\"24bc91ee13fef581\",\"/knowledge-medium/pr-preview/pr-1879/src/data/internals/undoManager.js\":\"922d0dd8039bfa90\",\"/knowledge-medium/pr-preview/pr-1879/src/data/invalidation.js\":\"8b90ee81c6cf5ed2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/kernelDataExtension.js\":\"c7044dbda4296a1e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/kernelPage.js\":\"05c3a7f472458ca9\",\"/knowledge-medium/pr-preview/pr-1879/src/data/kernelValuePresetCores.js\":\"20bd28dccc76c20e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/localDbCorruptionSignal.js\":\"f1a91b60d69b5111\",\"/knowledge-medium/pr-preview/pr-1879/src/data/localDbStorage.js\":\"45ce65b991e06b70\",\"/knowledge-medium/pr-preview/pr-1879/src/data/localDbVfs.js\":\"be5a29a0b609dbd2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/localSchema.js\":\"1034da03c277c053\",\"/knowledge-medium/pr-preview/pr-1879/src/data/maintenance.js\":\"43391807264e64a4\",\"/knowledge-medium/pr-preview/pr-1879/src/data/mergeProperties.js\":\"7447d16c2bd39ec3\",\"/knowledge-medium/pr-preview/pr-1879/src/data/metricsConsoleHook.js\":\"f4dad1633d01ef14\",\"/knowledge-medium/pr-preview/pr-1879/src/data/migrationsPage.js\":\"e03cc4a723bcb168\",\"/knowledge-medium/pr-preview/pr-1879/src/data/mutators.js\":\"17c9861f314c9e6b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/orderKey.js\":\"86e1da8e34383dbe\",\"/knowledge-medium/pr-preview/pr-1879/src/data/orderKeyPlacement.js\":\"d1b3ef3b7f01d630\",\"/knowledge-medium/pr-preview/pr-1879/src/data/outlineSurface.js\":\"044cf12462b6af77\",\"/knowledge-medium/pr-preview/pr-1879/src/data/pendingEditorContent.js\":\"1b51ea8539433e2e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/pendingUploadsSql.js\":\"12724e281a3b2a01\",\"/knowledge-medium/pr-preview/pr-1879/src/data/pluginStateExtensions.js\":\"c42eaec7ab6164e2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/powerSyncLogger.js\":\"e9bb601241ef7c94\",\"/knowledge-medium/pr-preview/pr-1879/src/data/projectorRuntime.js\":\"4ec3a509abcc0ff8\",\"/knowledge-medium/pr-preview/pr-1879/src/data/properties.js\":\"8cce4810048ae37e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertiesPage.js\":\"65e31578c567bb93\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyChildren.js\":\"455a8a1caa50c3c4\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyDefinitionFanout.js\":\"6d12156585d740c0\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyDefinitionMetadata.js\":\"73d24993ee0c3efd\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyDefinitionRegistry.js\":\"366ac9e7c6274443\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyDisplayMode.js\":\"8390dd1710280b6e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertyRowCreation.js\":\"ac1010f509870c9c\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertySchemaCreation.js\":\"328e6a0136c775b4\",\"/knowledge-medium/pr-preview/pr-1879/src/data/propertySeeds.js\":\"db0a55f896fafd91\",\"/knowledge-medium/pr-preview/pr-1879/src/data/recentsPage.js\":\"cb4c2ac742271d1f\",\"/knowledge-medium/pr-preview/pr-1879/src/data/referenceBlock.js\":\"9ef530356bcca81d\",\"/knowledge-medium/pr-preview/pr-1879/src/data/rejectedUploads.js\":\"b041b64909071b7a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/releasePowerSyncConnection.js\":\"4bc5a8a380675b13\",\"/knowledge-medium/pr-preview/pr-1879/src/data/repo.js\":\"66e224c82435857a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/repoProvider.js\":\"4177ead3a8e9c9b2\",\"/knowledge-medium/pr-preview/pr-1879/src/data/rowProperty.js\":\"89fe2ad492a25d4e\",\"/knowledge-medium/pr-preview/pr-1879/src/data/searchFilter.js\":\"b33958ff0eb021d7\",\"/knowledge-medium/pr-preview/pr-1879/src/data/seedIdentityLedger.js\":\"8b328e7237d497dc\",\"/knowledge-medium/pr-preview/pr-1879/src/data/stateBlocks.js\":\"515fa951f78032f9\",\"/knowledge-medium/pr-preview/pr-1879/src/data/structuralEditPolicy.js\":\"5dcbc69df4495fda\",\"/knowledge-medium/pr-preview/pr-1879/src/data/structuralInsert.js\":\"40bfa0b0028134fa\",\"/knowledge-medium/pr-preview/pr-1879/src/data/subtreeDelete.js\":\"67d737f891b04dcb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/syncStreamLock.js\":\"422936f11b99bf50\",\"/knowledge-medium/pr-preview/pr-1879/src/data/syncedTableSqlRecognizer.js\":\"82d03c896fe94edc\",\"/knowledge-medium/pr-preview/pr-1879/src/data/syncedTableWriteGuard.js\":\"47d464dd809c7feb\",\"/knowledge-medium/pr-preview/pr-1879/src/data/targets.js\":\"97b359dd551d5aef\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeColors.js\":\"b99cddd44c8e6f91\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeDefinitionMetadata.js\":\"310b2c26d0b39de5\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeDefinitionRegistry.js\":\"7dc038997ee38175\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeExtraction.js\":\"87445b30abc34131\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeInitialValues.js\":\"e72abe68bdd524f3\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typePropertyGroups.js\":\"9a16f2a227ea2b28\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeSeeds.js\":\"3ee5854b4fea353b\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typeTagger.js\":\"f1626da80e5405d9\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typedRecords.js\":\"0350ddac75b7b1f9\",\"/knowledge-medium/pr-preview/pr-1879/src/data/typesPage.js\":\"3682883c5137b903\",\"/knowledge-medium/pr-preview/pr-1879/src/data/userPrefs.js\":\"18bfa16b82364f1f\",\"/knowledge-medium/pr-preview/pr-1879/src/data/userSchemasService.js\":\"a176916bfdf95337\",\"/knowledge-medium/pr-preview/pr-1879/src/data/userTypesService.js\":\"5d60d0a5582b022a\",\"/knowledge-medium/pr-preview/pr-1879/src/data/valuePresetRegistry.js\":\"9f0b13d198365b38\",\"/knowledge-medium/pr-preview/pr-1879/src/data/visibleChildren.js\":\"97883e6a941e4868\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaceConversion.js\":\"1c4447301482c4cf\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaceFirstSync.js\":\"39e25afc729ca3ff\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaceIdNamespace.js\":\"8768890e6cc651e3\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaceSchema.js\":\"de429af3c59acf68\",\"/knowledge-medium/pr-preview/pr-1879/src/data/workspaces.js\":\"517d09a40e26efaa\",\"/knowledge-medium/pr-preview/pr-1879/src/data/writeAheadLog.js\":\"30dca3a3c5879198\",\"/knowledge-medium/pr-preview/pr-1879/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/BlockPasteShellDecorator.js\":\"2230da7131b0ecc6\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/atTrigger.js\":\"0e024550b02704f6\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/autocomplete.js\":\"7055ab62146786fd\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/codeMirrorExtensions.js\":\"61dafad11fce671c\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/contentFlush.js\":\"7074f10d549030f2\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/defaultInteractions.js\":\"450c8992976b1a56\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/editSettleSignal.js\":\"7aef0596c8a732c0\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/insertImage.js\":\"e993888fb93b21a4\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/referenceCompletionRange.js\":\"aea539cb65c9c59b\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/referenceTargetTypes.js\":\"a221043e2a97dd00\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/syntaxContext.js\":\"a34e665c71614eb6\",\"/knowledge-medium/pr-preview/pr-1879/src/editor/triggerMatch.js\":\"7fb0c75953335205\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/AppRuntimeProvider.js\":\"36b8668c8c56b8ae\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/BlockFocusShellDecorator.js\":\"9fabec23e1d2d7d4\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/ExtensionRenderBoundary.js\":\"c643e6580e242c55\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/PanelContentRecovery.js\":\"fcf387241bda3ec2\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/apiCatalog.js\":\"2deaecc4970aac25\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/approveExtensionHere.js\":\"2a9a78cd6144ec9e\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/armedCutAppMount.js\":\"4a9da8cd06883c38\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/batchableKeyedStore.js\":\"fd47cff259889a82\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/blockInteraction.js\":\"08c35c78948401ab\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/blockSelectionAction.js\":\"390787a1b60c888e\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/compileExtensionModule.js\":\"d0faeb158f7c1106\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/compiledModuleCache.js\":\"62e8d4a8ac14ea00\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/continuousGestures.js\":\"baf4177b4aab9de5\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/core.js\":\"26b072e27eb2167e\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/defaultRenderers.js\":\"4c24c91288624fad\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/definitionFanoutAppMount.js\":\"418b707ba3e70172\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/dialogAppMount.js\":\"926a7d60aec18952\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/dynamicExtensionSeeds.js\":\"b9abe290231a12ea\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/dynamicExtensions.js\":\"ddc075be2754d0d3\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/exampleExtensions.js\":\"b9a7911b34445da0\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionApprovalStatus.js\":\"866d1408f15d368b\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionLoadErrorToast.js\":\"f5cc6766883efe19\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionLoadErrors.js\":\"9455995bcb9b34cf\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionLookup.js\":\"4857c23844257021\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionToggles.js\":\"cd1985c2a3b7f607\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/extensionUtilitiesCss.js\":\"a0e99322c55f08d1\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/kernelPageDeletionGuard.js\":\"9e5c9c5ad0fc837a\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/liveRuntime.js\":\"3c79621d7711934d\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/openExtensionsSettings.js\":\"24a9fc2ac1ef029a\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/overridesCache.js\":\"3fd0db93cf8e437e\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/pluginIds.js\":\"9201dad7eb7dc3f4\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/processorRejectionToast.js\":\"c6ae29b7e2270dd1\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/runtimeActions.js\":\"fe831c6d5ef202ce\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/runtimeContext.js\":\"a20b39c66b5c225c\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/staticAppExtensions.js\":\"3eb7027fb0322b4b\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/staticDataExtensions.js\":\"f53fa4d3ba7caa1a\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/toastAppMount.js\":\"3df8fa34308945e8\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/useOverrides.js\":\"2a0ef732d24e1220\",\"/knowledge-medium/pr-preview/pr-1879/src/extensions/useShortcutSurfaceActivations.js\":\"89013743edf3f8ea\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/discoverToggleTree.js\":\"ecfac7562c557df1\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/facet.js\":\"0683548a1b53d97b\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/resolveAppRuntime.js\":\"9545618d6ee51b6b\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/runtimeEvents.js\":\"b2a3fd7c30060f91\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/togglable.js\":\"752a0882d617a4fd\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/variantFacet.js\":\"2398d59b735be18e\",\"/knowledge-medium/pr-preview/pr-1879/src/facets/verbFacet.js\":\"d6e49974488b0a2e\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/block.js\":\"ea90d16e0a87a0e4\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/focusedChild.js\":\"9c15d6e9a64c772e\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/propertySchemas.js\":\"2ed1cd0113a1fde8\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/typeRegistry.js\":\"3393cd3470797e1a\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useAncestorCrumbs.js\":\"db526c9fe53e5c0e\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useAutocompleteListbox.js\":\"86fbf93274fbf254\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useDebouncedSearch.js\":\"8b2ce3cb943fafae\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useDebouncedValue.js\":\"e78cef0698376baf\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useIsFocalRender.js\":\"a3f22c3693a9dfbe\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useIsReadOnly.js\":\"4e3dd972881b775e\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useMaterializeBacklog.js\":\"178499037221333e\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useMinuteClock.js\":\"3b8a5d88dbfb371c\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/usePanelLayoutProjection.js\":\"712a178c76876ccf\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/usePendingInvitations.js\":\"f0f09b8d99680b09\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useRendererRegistry.js\":\"7f75bd8c63dff4a7\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useRetainedFieldRows.js\":\"5adc977971b591fb\",\"/knowledge-medium/pr-preview/pr-1879/src/hooks/useWorkspaces.js\":\"fc3906b630176cc4\",\"/knowledge-medium/pr-preview/pr-1879/src/lib/utils.js\":\"5682649910657b24\",\"/knowledge-medium/pr-preview/pr-1879/src/main.js\":\"e3cde7538ac176b2\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/MarkdownImage.js\":\"2a85944a4160ff96\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/blockSeparators.js\":\"86817278bc1412a9\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/context.js\":\"2ab5cf4e164f7fc4\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/defaultMarkdownExtension.js\":\"2ba887da7eefb38a\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/extensions.js\":\"3882890d7ffa3f65\",\"/knowledge-medium/pr-preview/pr-1879/src/markdown/renderMarkdownHtml.js\":\"4c42b569b46d4418\",\"/knowledge-medium/pr-preview/pr-1879/src/minimal-editor.js\":\"0b97951a6d2d9f30\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/armedCut.js\":\"bdbf9ebc6daee9f0\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/captureMediaVerb.js\":\"9216d80f68537ba2\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/clipboard.js\":\"ba5b9f1a2b902c46\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/decision.js\":\"8afdd235a334b348\",\"/knowledge-medium/pr-preview/pr-1879/src/paste/operations.js\":\"ef9ab099e055bdec\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/account-header/AccountHeaderItem.js\":\"068fb1ebed3a3a9a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/account-header/index.js\":\"527bcbcc34d0438e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"dd493a2060296f6f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/askAgent.js\":\"c94a30adbac9a40a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/askedStore.js\":\"35652f69702f06a4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3964ef28d69877f3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/chipState.js\":\"88dea8f17ec94195\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/dataExtension.js\":\"d5bea85b67e7adf5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/index.js\":\"621eec94addaad21\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7ccee43d07d39191\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-dispatch-companion/schema.js\":\"03bb899e75de6c04\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6097eaae3a977d0f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ba988da8ae07b156\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/addMedia.js\":\"d9d2ceb664c2252a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/backlinks.js\":\"c747478e166c78f6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/block.js\":\"54d05786125059c1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/context.js\":\"c80464c96ed9d90b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/displayIds.js\":\"7badc86c89507c4d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/index.js\":\"da373aa98ca38d3d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/outline.js\":\"e7c627b1574573b5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/properties.js\":\"fdaa31cb33c92711\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/refs.js\":\"84997dea9ce155bc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"a30aee32f7069008\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/search.js\":\"39d3a956a0384b92\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/shared.js\":\"27f7c2fcee0cab85\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"513906da440af08f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentViews/text.js\":\"b9c29e4bb1865d45\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/agentWrites.js\":\"46938f08e6062834\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/authoringCatalog.js\":\"fd142e40b6e40b61\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/blockRefTargets.js\":\"25047af7b43fa27a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/bridge.js\":\"c4445faedd1d3f5e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/bridgeLoop.js\":\"c7ef997b6f3940dc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/changeHistory.js\":\"66c71165bdeb83ab\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/commands.js\":\"2a2fc1b9504b8702\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/commentsCommands.js\":\"a8c70b0811d354e1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/dataExtension.js\":\"8fdb86213ce82bd4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/dataModelGuide.js\":\"8bd2a4c7aebb22bc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/dayPropertyInputs.js\":\"82734ab20a45cee2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/describeRuntime.js\":\"e66bcc5289788496\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/extensionLint.js\":\"796a5a25fa5a736b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/grainAudit.js\":\"e213f6f5da68e6ed\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/healthCommand.js\":\"2c146daeecbb01fb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/index.js\":\"f1445b3d23727934\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/presetIdentity.js\":\"34d88f88171f618a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2d62a88a62074eae\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/readMedia.js\":\"efdeb87afb48cc40\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/schema.js\":\"654f8e91f8461a4c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/serialization.js\":\"aec70c9b33f8eb40\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/targets.js\":\"207a27f1e8856805\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/tokens.js\":\"0a58ceccfd31cc83\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/watchEvents.js\":\"ce3cab2f5add55ec\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/workspaceGuard.js\":\"09d707afb0d7d5de\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/agent-runtime/writeCommands.js\":\"8a231f6e68abcfa5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/AliasCollisionToast.js\":\"e4e46f012ea92e21\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/DuplicateNameBanner.js\":\"aeb7f162efc8a488\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/collisionMerge.js\":\"9a006eedf08f45bc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/dataExtension.js\":\"517220209510c7e2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/index.js\":\"44d9d0bbb9f55a9f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/mergeCollisionAction.js\":\"33954c05eae9d231\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/pageStyling.js\":\"b3ddfe4de35feae4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/rejectionToast.js\":\"2f1c620de349bad6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/alias/syncProcessor.js\":\"1776ac17b27c3828\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/actions.js\":\"657704079dcf9d37\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/addComment.js\":\"bad49aff664f6db4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/anchor.js\":\"2bc78225461b68f2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/anchorState.js\":\"7973000d0e0e632e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/commentLinks.js\":\"a72ecd6b7bc1e58b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/confirmThreadDeletion.js\":\"ac9b8e8d1312f58f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/container.js\":\"9c03ac75df294661\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/dataExtension.js\":\"29f4914df461c337\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/deleteComment.js\":\"3b103d1418863741\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/highlights.js\":\"01164f9d447d5948\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/index.js\":\"9b21ba3666aff9f5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/linkedCommentsPill.js\":\"00ddd8a8ddec63aa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/margin.js\":\"2c370b21a8a98989\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/marginAnchorLinks.js\":\"967daccbfc634438\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/marginSchema.js\":\"5b6a24942ec95f1e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/newComment.js\":\"9f0cb4929a2c2b46\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/ownThreadPicker.js\":\"c8d670bda3aec40f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/placement.js\":\"d2ab1cde7755d3b6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/queries.js\":\"4188d3223c246da1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/quotePosition.js\":\"eead662ce5bcf889\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/quotedIn.js\":\"da507df4d22954ab\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/quotedRange.js\":\"07c2d82490cbe5cd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/rangeRefs.js\":\"ba5077f1c5bf4cbe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/readHighlights.js\":\"f60fbea7bdc3958a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/readSelection.js\":\"8742c127c55fd732\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/readSelectionUi.js\":\"f78d3477f6aa9f17\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/reanchor.js\":\"473b3530b5e1c380\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/schema.js\":\"10697b27cbd83e41\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/scope.js\":\"875c7c2c9310314a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/scopeThreads.js\":\"1ec754b0e6d356c2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/splitRetarget.js\":\"8357dc7c422a78dc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/suggestionCard.js\":\"85ff6ce8d9f60bf2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/suggestions.js\":\"56c3ee261fe056e0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/summaries.js\":\"2aeff1840ffb0389\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/summaryBatch.js\":\"588284a7e3e70f4e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/surface.js\":\"efa1d717d770bbfb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/threadNavigation.js\":\"7c225b6e1a843462\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/threads.js\":\"0e21bdb235646eae\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/ui.js\":\"fec1af517edf0e17\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/annotations/uiStore.js\":\"e5e31e4303d0c758\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/app-intents/appIntents.js\":\"bc763493922a5729\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/app-intents/index.js\":\"5e9f5ff9ac4445f4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/app-update-prompt/index.js\":\"f1ceef5c57848570\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/app-update-prompt/status.js\":\"463644629949917e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"9d1fa819ff6016b2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/MediaBlockRenderer.js\":\"11711ba63855e7ec\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/MediaDownLaneReplicator.js\":\"adef1bbd5572ff6a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/MediaUploadReconciler.js\":\"a9ac486f4af43703\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/assetDownLane.js\":\"de5a22296ceae319\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/assetResolver.js\":\"7f9b74aa5b9b34a6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/assetUpload.js\":\"62268ec6ed106795\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/attachmentCleanerIO.js\":\"65b93be85006a28e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/supabaseAuditIO.js\":\"714778c762f04bb7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/blobStore.js\":\"7c8fdf340f45e88d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/browserMedia.js\":\"dc121c2e060c29d8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/byteStore.js\":\"6831dfbf01c451f3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/cleanerIO.js\":\"1c89769293b434ee\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/cleanupAttachments.js\":\"38a76b09c39491b8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/dataExtension.js\":\"4564b9ba81938004\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/downLane.js\":\"02deb4e267e5eb36\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/index.js\":\"fe12ebc27d60713c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/insertImageContribution.js\":\"3ea2c5fedd4d527a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/laneArming.js\":\"e26c803d98619861\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/laneLock.js\":\"94cccef35ba6eb66\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaBlock.js\":\"32802b184437b0e6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaCapture.js\":\"50706def1ad9a0c6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaLanes.js\":\"ac26520cab8096f5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaViewers.js\":\"291bcbe1145abfb9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/mediaViewersFacet.js\":\"213a59a23d0a524d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/pasteCapture.js\":\"fc95eb7893f3f430\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/resolver.js\":\"a05d1cf05ec8cfd2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/retryUploadsAction.js\":\"1b2aec83864bcd01\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/storagePaths.js\":\"b825b591a468d03a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadDrain.js\":\"478197ddc9f9eb93\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadLaneStatus.js\":\"1d153853b12d0c2a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadReconcile.js\":\"8afe9d5821671649\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadRecovery.js\":\"47c0c57caa8a5672\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/uploadStore.js\":\"e10c2914602bc541\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/attachments/useAssetObjectUrl.js\":\"5206cf1f20ee75a6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c18e046d35448645\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/BacklinksViewSection.js\":\"986b30d52d9303af\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/facet.js\":\"8ac4e7e0d12fe80c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/index.js\":\"b1a79eac9a0a151e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks-view/prop.js\":\"477f992b9a7c9945\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/BacklinkFilters.js\":\"1f193289ebc9b4df\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b79bb598ba18c7bd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/BlockEntry.js\":\"36b3e5f4abbe1180\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/LinkedReferences.js\":\"5488613f65247604\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"92189c276d985f0d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/dailyNoteDefaults.js\":\"5c36fb88a66eb827\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/dataExtension.js\":\"2e6a41e105587ca2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/edgeExclusions.js\":\"b7919c6e91709e2f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/filterProperty.js\":\"e04a6c7813371767\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/index.js\":\"92aa5fdf066c3a9e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e2d2dd61ec3eab20\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/applies.js\":\"2a5af84c7b4742ad\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/countQuery.js\":\"7819587f5a4eb04f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/expansionStore.js\":\"6816115d691592fe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/index.js\":\"e130fd3ffc056cca\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"47d31e55aa72ccbe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/presentationInvalidation.js\":\"abb53743ce494c1f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/propertyEditorOverride.js\":\"852387e4faed192b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/propertyFilter.js\":\"e63d196b787aa635\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/query.js\":\"00174b7077d6b45b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/resolveFilter.js\":\"3e29806f40ef6356\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/sourceBatch.js\":\"1f2be9b6ce6bd497\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/sources.js\":\"35249afc42fe7fd7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/useBacklinks.js\":\"50b304b34086a679\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"edea8b2733f874eb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/BirthdayCelebration.js\":\"5b0b6b14c36a6715\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/BirthdayOverlay.js\":\"e0c871a0d2833f2d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/gate.js\":\"43a07490558b0900\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/index.js\":\"b8926b1a30932a1d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/birthday/wolfTheme.js\":\"e97d08ff26605f60\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/BlockDragLayer.js\":\"88ccf7a056bd37e4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/dragController.js\":\"5a22eeecad5aa712\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/dropTarget.js\":\"0300bde7290ea56a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/index.js\":\"da984faa59acc718\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-drag/projection.js\":\"dc37f5876bf65be5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-info/BlockMetaCard.js\":\"3912f68c0c2294c2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-info/index.js\":\"d5af77444b862b3b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/AddTagDialog.js\":\"5ce23f8d130cdb4a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a5a8364df8e9a9fc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/TagNameIssueHint.js\":\"0b20e7afa375327e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/addTagAction.js\":\"2dbbb834b9e1d477\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/appendTag.js\":\"85185470613d952b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/config.js\":\"5866f4435d014e5c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/dataExtension.js\":\"3e441463878c0b35\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/index.js\":\"b0e268c26b1ff768\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/block-tagging/propertyEditorOverride.js\":\"57f66a78705e167d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f1c8fa684437b22c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"8314f393ad1cfa46\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/Breadcrumbs.js\":\"95b98358073b9d57\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7f98434649c3b207\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"3f1b039f58fa4063\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/index.js\":\"86d2ee3b494baa86\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1e4a7e891ea83a48\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/CharacterCountItem.js\":\"504281092e98ae98\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/ProfilePropertyEditor.js\":\"07da389e77f23ed1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/actions.js\":\"a89d909e392f1a9f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/blockType.js\":\"5e012a5512929629\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/charCount.js\":\"359c37147d35160e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/dataExtension.js\":\"e4dca5c8ab58b74e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/index.js\":\"3703b3283b89ac96\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/profiles.js\":\"23ebfbd47f974b70\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/properties.js\":\"05bd687971e0abc5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/character-counter/textCounts.js\":\"c4f4fa2d697ffea4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/colemak-keybindings/index.js\":\"cc806f7bb4f45676\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/CommandPalette.js\":\"ec1228a3b342707d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/HeaderItem.js\":\"fc324632e1ac8269\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/context.js\":\"30eed0c941ee569f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/index.js\":\"d06325e172c61ac2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/selection.js\":\"6bbd70eae76b8834\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/toggleStore.js\":\"879c9a6da1622f6a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/command-palette/useCommandPaletteActions.js\":\"3db51646df525342\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/ContributorBadges.js\":\"ee5acd01bc242d8e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/author.js\":\"5b66bae8cb1992af\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/codeMirrorExtensions.js\":\"f8402ca76b415e30\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/dataExtension.js\":\"3469a19416ff00fe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/index.js\":\"cde2eee2c34dac97\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/mentionAutocomplete.js\":\"7c7821a6638f93ea\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/processor.js\":\"5a91a02aae34a3a9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/profiles.js\":\"f04b09d9b0e9800d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/queries.js\":\"e0c38d1cb69eb594\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/contributors/schema.js\":\"06dcae123b1effb3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ac922feca8b52688\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e7f5bfb8f32c14bb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/index.js\":\"d7525307cc4637fe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"3f6f48b0a68f70c6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"046dfdb3e23e8400\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/CalendarGrid.js\":\"c647b161724267b4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DailyNotePicker.js\":\"6224bcb9fafcb464\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"776c2a3e8449bcf3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DateNavDecorator.js\":\"a639641d7821b0cc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DateScrubOverlay.js\":\"0dec878f0f2c8a72\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/DayPropertyEditor.js\":\"89e64d643adff5d7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/HeaderItem.js\":\"2e903df3056804ca\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/ReschedulePicker.js\":\"ce1b158b677010d7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/SpreadDatesDialog.js\":\"97b1cd3ccf1175f4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/actions.js\":\"77c1d4458b28fc32\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/blockDateAdapter.js\":\"5f3adfb587478e96\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/calendar.js\":\"1b94204ec56d004f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dailyNotes.js\":\"ceb705f6eb399fdd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dataExtension.js\":\"56f2d60a783c55dd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dateScrubActions.js\":\"9674e3d882276a7c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dateScrubGesture.js\":\"352a2923cf86c176\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dateScrubGestureActions.js\":\"7273ffd841753d75\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dateScrubRecognizer.js\":\"93b945935fa31fcd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dayProperty.js\":\"08fa768ee8cc9d4d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/deletionGuard.js\":\"79646abd8160578e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/dueQuery.js\":\"9d073bcd94f7f4b8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/index.js\":\"505b76355720b7e9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/landing.js\":\"b65ea7d2b74238b9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/localSchema.js\":\"4ded1bf06f037cab\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/referenceDateAdapter.js\":\"321aa9f76b5d8d57\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/rescheduleAction.js\":\"f17869344fa2b97e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/schema.js\":\"7f7cb547331e97e7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/spreadBlockDates.js\":\"f712855c3174e197\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/spreadDatesAction.js\":\"a42f127f58977300\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/today.js\":\"2b74f4644a6f5e5e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"472cebb453a4f8f3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e4a2628630f96e0f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/audit.js\":\"edd23bd2e75ff179\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/auditAction.js\":\"924e53a34a615592\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/auditRanges.js\":\"8e54b096f17df279\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/diagnosticsSource.js\":\"4cde6400e663cbb6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/divergenceScan.js\":\"c8440418f91ef3d2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/index.js\":\"ec52c681bc55124b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/propertyChildrenChecks.js\":\"7ee14bd9c74d1ed8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/referencesMirror.js\":\"e716da00c569f1e6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/rowJson.js\":\"e4c46e666cd60867\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/schedule.js\":\"c24592830d13ff1a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/data-integrity/store.js\":\"60b366ad195dacbf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-maintenance/action.js\":\"eef26fd5f04e14c4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-maintenance/index.js\":\"ef394216c9f7ffae\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-maintenance/plugin.js\":\"3b5268d89eacd1af\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"492dfc1d9d5c4281\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/actions.js\":\"04f9a1333199147a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/changeMarker.js\":\"e193cd292fa88a87\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/diagnostics.js\":\"41ab0aa52b710af4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/fileSystemAccess.js\":\"04a669615ca09c18\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/filenames.js\":\"eba0155617f2d81b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/index.js\":\"b56ae51276b49945\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/mirror.js\":\"c115e67074f10e52\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/runLock.js\":\"45dc6669697a06dd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/runtimeHealth.js\":\"b505ffd84f7ee0a1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/schedule.js\":\"da805bb70ea6a9ac\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/db-mirror/store.js\":\"15652289be2146a6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/default-themes/index.js\":\"3b82cfbc15e16e70\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/default-themes/themes.js\":\"2f13cc0798f5ca53\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/diagnostics/facet.js\":\"6ecd308f2319ae17\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/diagnostics/useDiagnostics.js\":\"b755fbf9977579c2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extension-prompts/dismissals.js\":\"4628502f3c0c89f2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extension-prompts/index.js\":\"2b1d1c72d999807c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extension-prompts/status.js\":\"bdb50886bae64322\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extension-prompts/store.js\":\"a97014d56751e322\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a42e7f2555903eb5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/ExtensionsSettings.js\":\"1809c1272f7de293\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/actions.js\":\"533873121642c02a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/config.js\":\"a22f5ca559c5fd5c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/dataExtension.js\":\"803f978a7d0a9d07\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/effect.js\":\"07a94f58b4b53c3c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/index.js\":\"cc3066896886e71f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/propertyEditorOverride.js\":\"c516ed9f9c5fd4a2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extensions-settings/useToggleTree.js\":\"e3fb1ae501aca49a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/ExtractTypeDialog.js\":\"e9ffd77b26f2f233\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ef3dc72fc654aa14\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/PropertyShapePicker.js\":\"2bec8ace3695db72\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/action.js\":\"942f42a12e72b93c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/extract-type/index.js\":\"5d38d6796da69ddd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/FindReplaceDialog.js\":\"d302ab8a95a26cba\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/HeaderItem.js\":\"34663ab91a28baca\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/dataExtension.js\":\"d1491d58a67bb553\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/index.js\":\"16a914e15ee5cb3b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/search.js\":\"d65c1bb9ac80e88b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/toggleStore.js\":\"cc506a840b22cb28\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/LocationPropertyEditor.js\":\"3cb00d9687a9be81\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/MapView.js\":\"2b672b2985f3e6c3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/blockTypes.js\":\"f37d771e8e295168\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/codeMirrorExtensions.js\":\"c5ef1f7431b9ebc1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/createOrFindPlace.js\":\"1383035e49ee11ca\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/currentLocation.js\":\"4b4b0cf6400b6a79\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/dataExtension.js\":\"6d37b8fd2db6f3fd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/geoContentDecorator.js\":\"9a23df82d4906c05\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/googlePlacesClient.js\":\"e4a863347b318692\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/index.js\":\"805f0711974b8f2c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/locationsPage.js\":\"40cf6838ceec8eae\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/mapViewport.js\":\"9a422ea91bd0d36a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/pickCurrentLocation.js\":\"25fe74b0e81c6114\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/placeAutocomplete.js\":\"a951e087c61cdce9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/placeNameCollision.js\":\"ff76e5e1e75ea240\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/properties.js\":\"3118b8079c5a9575\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/propertyEditorOverrides.js\":\"7359d7f5176e0d91\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/query.js\":\"ca53d10e50576568\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/geo/usePlaceSearch.js\":\"815ba0b246653894\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"0fe4116a26152a12\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"2916bfdc91717963\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"cca295362981718c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/config.js\":\"fd968bc9c8db4336\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/dataExtension.js\":\"2217a6cdea8ed359\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/facet.js\":\"72e45cf74ab2a96e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/grouping.js\":\"f79d72ef31c0f922\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/index.js\":\"1ffb3d416202f18e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"55145deab73a71f1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/query.js\":\"d8abbd1c1d680253\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/resolveConfig.js\":\"b89bba09e2a242d1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"bd0232382bc19c34\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"7a2017264cf49160\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/HtmlDocumentContent.js\":\"b1e0dbb95867fe21\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/HtmlFrame.js\":\"8646648a296f38d7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/actions.js\":\"082834d8b8bb7d63\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/blockType.js\":\"9b68eec4a81d4f6f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/confirmRunScripts.js\":\"9ee967038d5804b4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/dataExtension.js\":\"c9f4a2781316a36b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/frameAnnotations.js\":\"385d010de32e6563\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/frameDocument.js\":\"19e7e4e66b1c5914\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/frameTheme.js\":\"999c91c2e1aa8295\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/index.js\":\"11c169117d1e1496\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/scriptConsent.js\":\"1831c6f621b127ec\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/sourceMap.js\":\"c57aef45d3d8903e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/html-document/useDocumentScripts.js\":\"de6e9574d8b6d1a3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/index.js\":\"a12f41900455c34d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/record.js\":\"7397fc4ab660e749\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/recordStore.js\":\"2d986eb65c80dbaf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/responsiveness.js\":\"ac6fe6d650d9c9c7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/schedule.js\":\"689bf6879f22433a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/interaction-metrics/sessionContext.js\":\"a737f2f05b602935\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c8ebce1cfe97c1fb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"a0b12cafd3759d40\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/actions.js\":\"1e7b09043819b5cc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/config.js\":\"c4591f06e6002c08\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/dataExtension.js\":\"ab7f909e996fc617\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/effect.js\":\"611d5296afe0b252\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/index.js\":\"7014eee4362977ae\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/keyCapture.js\":\"96465ca79651007b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/overrideStore.js\":\"7407e2b8662bdb4b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"9ba1300a022608a2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/HeaderItem.js\":\"abe521db7acdb4aa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/LeftSidebar.js\":\"70441c4aba7d8f86\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/actions.js\":\"7693bb4786f0ca0b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/facet.js\":\"d135bd3fb4e8264d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/index.js\":\"8810c17b783d98fd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/shortcuts.js\":\"e4690938094bafa2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/left-sidebar/toggleStore.js\":\"3378e0bbc9bd90cb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/merge-blocks/MergePicker.js\":\"e78adf9fffe40559\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/merge-blocks/index.js\":\"e2c91e713cc4f82d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/merge-blocks/mergeAction.js\":\"efc782050133ace2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/merge-blocks/strategy.js\":\"7b720252fc2bdaac\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/Button.js\":\"6d42686c5fb97cab\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5e534f1c9ca3bde9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7cf571316440972c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/facet.js\":\"354acd9ce843da8b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-bottom-nav/index.js\":\"4faabfe15b69c84c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"c8c3a568241bcc80\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/actions.js\":\"ec2f3449a049b7a9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"e6046963ccbcc24d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/facet.js\":\"f6704165125e54f8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/mobile-keyboard-toolbar/index.js\":\"82986b2717bea980\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/MoveDestinationPicker.js\":\"db16787b42a8b172\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e994b841ca80044f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/contextMenuItem.js\":\"c00ade0c137aca9a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/index.js\":\"e7806f9505013f54\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/moveAction.js\":\"c533e7df243a997d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/moveBlocks.js\":\"32fb153b67f7af11\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/move-blocks/selectionAfterMove.js\":\"39c8a49ad9190c22\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/TutorialBanner.js\":\"3b2ac7a923bab191\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/action.js\":\"ae829239152181dd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/bannerDismissal.js\":\"a8b0e77a2c5fbd09\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/documents/cheatSheet.js\":\"5a9d35a7eb420452\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/index.js\":\"7e26323dc35390a1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/keys.js\":\"837f8c9d2b919318\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/landing.js\":\"b5a13fb1f6dbb978\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/outline.js\":\"b762c669748cc6cb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/onboarding/seed.js\":\"dd716fb142deb8a3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b8ecda78e1874b03\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/analyze.js\":\"0d2dae421aee5aaa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/diagnosticsSource.js\":\"a4d2de21c707de60\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/index.js\":\"ef9999cf112ce330\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/load.js\":\"74dcd5728901753e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/monitorRun.js\":\"4f368fe32d6ddfd7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/schedule.js\":\"c1481538866cf3cc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/series.js\":\"2fd7b874661db886\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/store.js\":\"8bf12b84e8099805\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/trendAction.js\":\"0a8cacb0bc98ff61\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/perf-monitor/verdict.js\":\"f3b13da3dd9d9205\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/plain-outliner/clickToEditAction.js\":\"4b371968916a0fd8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/plain-outliner/index.js\":\"0d3e7d69b548acf9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/plain-outliner/interactions.js\":\"9dcbea1ceac107e1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d678bbc2b7de84a7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/MigrationGate.js\":\"02298bfcaf322072\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/MigrationGateDialog.js\":\"bd3f6bf4ec7f14fb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/action.js\":\"8941c5d82c55d70d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/index.js\":\"8f9a94476d1088b8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/localRunMessage.js\":\"4662e60649e060d7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/plugin.js\":\"11c62210484a4eb3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/progressReport.js\":\"51788f4f9d304d3d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/properties-migration/sweepProgress.js\":\"9fc4e7a6172c7264\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/FieldRowRenderer.js\":\"965b787a54cb301c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/ValueRowRenderer.js\":\"91df29fd0c0f66ce\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/actions.js\":\"378a998ff578bbb2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/autocomplete.js\":\"b16f0ca52aa6be0d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/fieldRow.js\":\"fca83b059be1b56a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/index.js\":\"37aecf81358c4511\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/referenceWarning.js\":\"d6508ae029ad4de6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/valueAutocomplete.js\":\"496b80521a4c5b97\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/property-rows/valueSchema.js\":\"535356b78debbbab\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/HeaderItem.js\":\"a45fc024f969e8c2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/QuickFind.js\":\"78b6d7120f794fe0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/index.js\":\"857fc7d1686efb10\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/recents.js\":\"c969c37f4d775201\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/resultItems.js\":\"8d64030ca638e719\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/selection.js\":\"ac9a6917c4c94f06\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/quick-find/toggleStore.js\":\"ef0f4046a5d72d1a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/HeaderItem.js\":\"47643e811803f388\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2beac91eec49a764\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/grouping.js\":\"cad648760e346512\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/index.js\":\"e6edba580231aac3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/recents/target.js\":\"5a250a1ba3d123a2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/codeMirrorExtensions.js\":\"b65a6f1d56316089\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/contentPrefill.js\":\"4112d1e8f60dbd0d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/dataExtension.js\":\"30c1678faa7bce58\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/index.js\":\"a7b0d2449a406f0d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"bde3620dd1e09d18\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/invalidation.js\":\"d15572c433a9758c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/localSchema.js\":\"88e06f6c15434329\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/blockrefs/index.js\":\"e8429f5726fc686b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"925168785b41fccb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/index.js\":\"ff898779d2f3ed38\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/referenceNode.js\":\"473fd92e776d9353\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/remark-reference-occurrences.js\":\"2043c97dde50768f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5cc560df066f74ce\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/wikilinks/index.js\":\"a36235cfd18748f1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"1d77d96fbb0f9bb9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"cb0f9929d0dc6a0e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/mergeRetargetProcessor.js\":\"79057a482922843f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/parseFence.js\":\"c977761d3eb3e7ae\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/referenceParser.js\":\"6817551f92f7ecbb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/referenceProjection.js\":\"3702ebd6b5e775f6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/referencesProcessor.js\":\"6fc92405ac464d7c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/renameProcessor.js\":\"76f2385580630701\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/references/spanReplacement.js\":\"845b5dd3d307a383\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/rich-paste/htmlToOutline.js\":\"e2caee88696a27d0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/rich-paste/index.js\":\"5b42fdb22001f1c1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f49165a3df46026a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/rich-paste/pasteDecision.js\":\"fbee5e4eda38e9bf\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/action.js\":\"772678e919083f9d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/blockIds.js\":\"54f3259603320fa5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/content.js\":\"66c56ca4cd21a535\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/effect.js\":\"4f4872efb1086c77\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/ids.js\":\"efcca6ff3d88d149\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/import.js\":\"cdda702d2e84a0d4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/index.js\":\"8c068b3fc9453278\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/plan.js\":\"6b5dc8b2e18adb9e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/plugin.js\":\"c1dc6f7f3d481404\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/promotion.js\":\"44416a7713d3ca92\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/properties.js\":\"3c81cf84874ddfa9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/references.js\":\"06bf439800f40d12\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/report.js\":\"99ffddd0f9da1de9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/roamMemo.js\":\"504815bee2cdb117\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/runtime.js\":\"469dc4aaebd616d9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/schemaReconciliation.js\":\"a50e88eb9f0b126a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/srsMarkers.js\":\"3ed6123396d656d9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/todo.js\":\"70b3d79d24d311e3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/typeCandidates.js\":\"ae6715ebb915ce20\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/roam-import/types.js\":\"490157f4c2504ab1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/search-health/index.js\":\"fcb6146185af191c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/search-health/store.js\":\"caaeb228d1f30651\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/HeaderItem.js\":\"367cc82d6ec142c4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3aec7c4c4fe30ea9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/index.js\":\"6a0de34ba9e329b2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/model.js\":\"3de42bc9ce8c5415\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/toggleStore.js\":\"b5c27c86f4a1f9fb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/shortcut-help/useKeyInspector.js\":\"0b93737b8fb488fc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"ea297536eb2520ae\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/ShellDecorator.js\":\"def7c5ae23d62c8e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/actions.js\":\"810332f03393440c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/exclusionsFacet.js\":\"51e01ef3d65073ad\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/index.js\":\"42fcfa12a0b915fc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/shell.js\":\"3c135d17516332a5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/surface.js\":\"6f7858c140a8346d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/spatial-navigation/walker.js\":\"18cfc6db920456af\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/RescheduleToast.js\":\"10ecb244b97ef915\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/dataExtension.js\":\"fb78c18294859ba7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/index.js\":\"a8b244c3936b6b7e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/indicator.js\":\"814d658a8a6f397d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/moveSrsState.js\":\"55c945d2c3a18b92\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e9a1d2df376d0fa9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/scheduler.js\":\"efce30c15e20c5a6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/schema.js\":\"d164ebcb014c0d06\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d828e554d3f5255f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/srsClipboard.js\":\"1fb79a06c36d457e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2a870387f9efc1b7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/DailyNoteReviewHint.js\":\"eef7a2cf0649d8a4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/DeckPicker.js\":\"a42303528ee39464\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/ReviewControls.js\":\"4c4e08bf58c12ea9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/ReviewDeckRenderer.js\":\"5ad1e1f1c7dd7971\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/ReviewSession.js\":\"49aaef075359539f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/actions.js\":\"def91c99e85c0c51\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/archive.js\":\"37dec4e90204bb9f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/dataExtension.js\":\"f144c7925c8a3960\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/deck.js\":\"24dacec12c99c28e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/dueQuery.js\":\"151ca52d450afb29\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/gradeDecision.js\":\"5e000d00e97287b5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/index.js\":\"635df6f05944e2b8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/keyHints.js\":\"d0f981c9f0f06308\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/reviewCardLayout.js\":\"b4bc036bb4bb26f0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/reviewProgress.js\":\"c5f8931caec609d3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/schema.js\":\"07aa1737364d3ffd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/srs-review/useDueCards.js\":\"9e2a422025621263\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/startup-metrics/index.js\":\"f79c63780ce32e03\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/startup-metrics/record.js\":\"482b7a6a2ad981f5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/storage-persistence/index.js\":\"af9ca2d07fefe399\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/storage-persistence/persistenceStatus.js\":\"8274967d9b1c22f0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/storage-persistence/requestAction.js\":\"30eae862722ac546\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/supertags/TypeChipsDecorator.js\":\"eca3fceb9019d2e1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/supertags/codeMirrorExtensions.js\":\"3530db2c9bc33304\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/supertags/index.js\":\"10e0a5ff1f20e343\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/supertags/typeAutocomplete.js\":\"63ce20a12754f03e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"b57c08b32c569554\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/actions.js\":\"8e6abe09e3a18e3b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/anchor.js\":\"57736304fc392db9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/events.js\":\"fba3ef43260aa11d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/gestureActions.js\":\"9c49264f138e88c0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/index.js\":\"15ffaa2f48f816e7\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"d6fad1c7874dcbcb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/sync-metrics/collect.js\":\"0ea1fa1c87809ebe\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/sync-metrics/index.js\":\"9738f3f1cb96c807\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/sync-metrics/record.js\":\"17511e08cdddf0a0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/RejectionDialog.js\":\"8149702e54c71d69\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/SystemStatusHeaderItem.js\":\"7a90cc2ca3f9c9d5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/index.js\":\"7c1c3b2949974e4e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/model.js\":\"39eeb818366a795d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/queueCounts.js\":\"31a809828cbd26cc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/rejectedHelpers.js\":\"f0bdb43e32a33310\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/rematerializeAction.js\":\"ad8f94f84fe57e5c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/system-status/useHysteresis.js\":\"d2ce85ebd1de845f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/ColumnHeaders.js\":\"f87e050d05f61cb2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/QueryUi.js\":\"2f780648965686eb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/TableLayout.js\":\"5a8ef2194c273157\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/actions.js\":\"6e66d03f02aa8bb1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/cellEdits.js\":\"c7aa7fb686c4d989\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/childrenViews.js\":\"84381996b22265f2\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/columns.js\":\"8aea4bddb4b0509f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/controller.js\":\"344dbe7c33afcd14\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/convert.js\":\"cb3ef16f7de1e808\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/dataExtension.js\":\"3bad15282d13c4bc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/index.js\":\"7cb631657e944922\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/keys.js\":\"c9368286ec950222\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/model.js\":\"31dea3ed5f141af9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/backfill.js\":\"db26ac9294e95976\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/completion.js\":\"5a79b0424c0ceb40\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/format.js\":\"3f01bd48dfb47f2a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/parse.js\":\"2cd68815dfcbf48a\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/queryValue.js\":\"f512827f5adb4791\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/registrations.js\":\"3d9069e95c1ad918\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/query/source.js\":\"d1f2e6549d6fbb2f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/registry.js\":\"4571e689de2ffbd1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/rowGutter.js\":\"e965e163aa56f64f\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/rowVerbs.js\":\"ca293f74ee0c203d\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/schema.js\":\"4b2905f32c65fdfd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/tables/sort.js\":\"6279cf57301774ec\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/theme-toggle/effect.js\":\"495337fcbe6f8cd4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/theme-toggle/index.js\":\"e4ae3f8b8ab5dc74\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/theme-toggle/theme.js\":\"1605f3dd0ae76d15\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/todo/actions.js\":\"4178044c64172eb1\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/todo/dataExtension.js\":\"c4cb132af52d118b\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/todo/index.js\":\"1ccf9133b95e872c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/todo/schema.js\":\"5fa94688bf924554\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/TouchSelectionLayer.js\":\"0e82df357c2b2069\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/actions.js\":\"11feebd3c260b45c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/defaultItems.js\":\"3916a2efc26e3891\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/facet.js\":\"a9b9ac06462119c9\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/holdRecognizer.js\":\"7df802f6a6f10c2e\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/touch-selection/index.js\":\"336fdd59a5e32beb\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/update-indicator/UpdateIndicator.js\":\"f2acfa7901177afa\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/update-indicator/index.js\":\"130338343f7d54cd\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/update-indicator/loadTimes.js\":\"69e3fb51d292e2b6\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/VideoNotesRenderer.js\":\"4a17fa07e37a3941\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/VideoPlayerRenderer.js\":\"ba2d9408375c7d07\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/VideoTimeStamp.js\":\"19a59cd68600d903\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/actions.js\":\"9552973a44cae4c0\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/index.js\":\"2cd99cb559f525c3\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/markdown.js\":\"17cdeeeb2c3135d4\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/notes.js\":\"eac3da7f363275c5\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/registry.js\":\"e4bc30b458fde274\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/remark-timestamps.js\":\"a06335ed8b0b7426\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/video-player/view.js\":\"69d8fdb1ac64cb96\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-link-hints/LinkHints.js\":\"a7211fb57c462c11\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-link-hints/index.js\":\"1e7d4a3023927571\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-link-hints/model.js\":\"0edfb1f1de697c8c\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-link-hints/settings.js\":\"42f5d7cd123960fc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-normal-mode/actions.js\":\"acac4834d5ecf9d8\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-normal-mode/index.js\":\"41c093aa0be209fc\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/vim-normal-mode/interactions.js\":\"ef32bbf29dff9e35\",\"/knowledge-medium/pr-preview/pr-1879/src/plugins/workspace-header/index.js\":\"caaac6a62957ef8c\",\"/knowledge-medium/pr-preview/pr-1879/src/registerServiceWorker.js\":\"d48cacb153ff6da8\",\"/knowledge-medium/pr-preview/pr-1879/src/requestPersistentStorage.js\":\"a3e579964235cba1\",\"/knowledge-medium/pr-preview/pr-1879/src/services/authRequestDeadline.js\":\"2e2677cd9ecf587a\",\"/knowledge-medium/pr-preview/pr-1879/src/services/authStorage.js\":\"b61523a360044319\",\"/knowledge-medium/pr-preview/pr-1879/src/services/powersync.js\":\"05ec39fc9eab0511\",\"/knowledge-medium/pr-preview/pr-1879/src/services/supabase.js\":\"4239b9ba6700f57d\",\"/knowledge-medium/pr-preview/pr-1879/src/services/uploadErrorClassifier.js\":\"eaf2e163a0782c68\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/ActiveContexts.js\":\"4c06d5837bae8772\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/HotkeyReconciler.js\":\"c63fbafcf3e4ab6b\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/WipeLocalDataDialog.js\":\"e1e35e8fdb45364d\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/actionDispatch.js\":\"d14c91e3f582d361\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/actionRefItems.js\":\"2bc21d8a59c5aba2\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/applyKeybindingOverrides.js\":\"2d6dccc5590c3df0\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/blockActions.js\":\"9f82de0a275f1d03\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/blockMergeGesture.js\":\"cae6a1693c72edd8\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/canonicalizeChord.js\":\"f904637282ede5c7\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/defaultContexts.js\":\"f32cd20d105cfdb1\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/defaultShortcuts.js\":\"754e8794be4de6c9\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/effectiveActions.js\":\"1d9c89ae60fde2a8\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/gestureAction.js\":\"ba52c8ba2b39f540\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/gestureBinding.js\":\"706db350603d520e\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/holdRegistry.js\":\"63a34af61389bc5e\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/keybindingConflicts.js\":\"7ae8400fd7c821ba\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/keybindingOverrides.js\":\"4188efd54a9ce0c1\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/pointerAction.js\":\"a52519684b486fac\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/resolve.js\":\"2853f3ed855eb0ab\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/runAction.js\":\"dc12257c0f901c09\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/sequenceMatcher.js\":\"96ae9ac2036dd88b\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/types.js\":\"21be10fe8bc13e6e\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/useActionContext.js\":\"2e9e167d7e1df24f\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/useActionDiscovery.js\":\"acf9272d2375f422\",\"/knowledge-medium/pr-preview/pr-1879/src/shortcuts/utils.js\":\"b9789831623da08f\",\"/knowledge-medium/pr-preview/pr-1879/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1879/src/sw/bootStore.js\":\"1efd1832ad41a6a2\",\"/knowledge-medium/pr-preview/pr-1879/src/sw/previewDatabases.js\":\"f6e7bb67bbad3654\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/byteTransform.js\":\"a1c5276231bb4d5c\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/attachmentCleaner.js\":\"d680e500b897b849\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/attachmentParts.js\":\"eb373c9d240b4448\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/bundleParts.js\":\"c2803d631adf3e31\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/bundleRecord.js\":\"c0c5210e7df3af62\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/manifest.js\":\"e87d8742ab1669f4\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/takeBundle.js\":\"ecc00fb02b68fc1e\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/bundle/verifyBundle.js\":\"7bfcd1a60447b0eb\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/cleaningStage.js\":\"26f69b51c729e5d7\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/conversionKey.js\":\"8aea851810f98384\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/conversionServer.js\":\"b70c5cbacc47092b\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/flip.js\":\"54f8f471a9d0d77f\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/flipAttempts.js\":\"d50d1503e81165c7\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/pages.js\":\"29007ae54f2ccdf9\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/preflight.js\":\"f3eca336e469f7e3\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/reseal.js\":\"e8291db15f655826\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/runConversion.js\":\"bb7adc131eeecb55\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/runLock.js\":\"2ab1ffc6b77d3934\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/sealing.js\":\"8464f4d732f3bafb\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/sealingStage.js\":\"975e2497d32a5a67\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/stage.js\":\"8bb91ab8a46a41f6\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/conversion/verifyReseal.js\":\"be9abfe81e61de1c\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/aad.js\":\"f50b9b951fc36fe8\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/aead.js\":\"bfb820b471e33654\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/base32.js\":\"4df306ca8ea078ce\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/base64url.js\":\"14c515a8d50dd458\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/binaryEnvelope.js\":\"e57efea086289728\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/byteAead.js\":\"667ccc92aff3cdaf\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/canary.js\":\"dc6aa661607cfe9b\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/contentHash.js\":\"cb941a945bb881a1\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/contentKey.js\":\"4a7283aafe4c01ad\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/derivedIdNamespace.js\":\"91deede7e618c109\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/envelope.js\":\"fc039a6d6437a341\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/hex.js\":\"cc8bfae9e33f0f2a\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/sha256Hex.js\":\"767de855374bed3d\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/crypto/workspaceKey.js\":\"bf5586a52e459e7c\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/conversionState.js\":\"ac7949fe6c9f19d3\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/flows/createEncryptedWorkspace.js\":\"b11090d99cda9210\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/flows/pastedKey.js\":\"bc92bdc837f4fea6\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"688e1f1947e4af77\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b43f81dd4d25e204\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/keyStore.js\":\"fae34dbd5cbc1f5c\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/mintWorkspaceKey.js\":\"92846f4e46e58b1f\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/modePin.js\":\"5bd22660cfb8a4b8\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/openWorkspaceKeys.js\":\"af25a5c8b84c8e45\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/resolveWorkspaceEntry.js\":\"a54ee304eecc1be4\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/resolver.js\":\"e3da0cbb114bc135\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/keys/workspaceAccess.js\":\"e9de2872a214e05c\",\"/knowledge-medium/pr-preview/pr-1879/src/sync/transform.js\":\"9a123bd73b9e2923\",\"/knowledge-medium/pr-preview/pr-1879/src/themeBootDefaults.js\":\"cb34b7482489000b\",\"/knowledge-medium/pr-preview/pr-1879/src/types.js\":\"ec6b2b1123584aa4\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/ClientLocalSettings.js\":\"f63e58d6e8946ead\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/abortableSleep.js\":\"65e3eec06bd0e046\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/array.js\":\"147668ab0825cf02\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/backlinkAutocomplete.js\":\"430c46675bad783e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/blockCrumbs.js\":\"2730ce5d38af05f5\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/blockrefAutocomplete.js\":\"b4282815c29c946f\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/cadencedIdleJob.js\":\"f268eec1073ddd25\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/callbackSet.js\":\"0a320c28b9209efa\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/clientId.js\":\"5f4c2e8ce8252a42\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/codemirror.js\":\"5548b3e6dccd500a\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/codemirrorCompletion.js\":\"8b25ac6105c136ad\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/copy.js\":\"d33e3540e0909c54\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dailyPage.js\":\"0e51df4d0fae07bc\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dbForensics.js\":\"b345125a98862faf\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dbForensicsHooks.js\":\"181751f4f9595808\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/deleteBlockThroughUi.js\":\"614623129c7cce04\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dialogs.js\":\"c0b13221c191c2fa\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/dom.js\":\"a1ea2fde014fc135\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/downloadBlob.js\":\"61e351ab1af4df41\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/drawnWalk.js\":\"81e3d79a8c01445c\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/exportSqliteDb.js\":\"532828534bb74f4b\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/fileSystemAccess.js\":\"41e4d61353297ac6\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/flipSlide.js\":\"ed3c6a6125a1c6d5\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/fnv1a.js\":\"09ff1c9cf18203ae\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/formatBytes.js\":\"a9bea59efe04c0f3\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/fuzzyRank.js\":\"48650224d6939b4a\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/idbKeyedStore.js\":\"7461a787ec48018d\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/idleCallbackPolyfill.js\":\"d454aca6b3dddbe1\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/keyboardAwareScroll.js\":\"689810f196d5b309\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/keyboardViewport.js\":\"8d4ef3450e7a931c\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/lastWorkspace.js\":\"76539b383fc2e35c\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/layoutColumns.js\":\"35d72a1a28be6861\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/layoutSessionDom.js\":\"40fe9853b4bd37b7\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/layoutSessionId.js\":\"c107666ece32e4cf\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/linkClickGestures.js\":\"5b6187cb676aa875\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/linkTargetAutocomplete.js\":\"2fd2f0ed20801a6e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/localDbCorruption.js\":\"ce3f2cf0552c13ad\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/localDbRecovery.js\":\"bd5a637b2ce32172\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/markdownParser.js\":\"6013e2255fc6c2d1\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/memoize.js\":\"4a3309a043e233a1\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/nameFieldCommit.js\":\"1c36ee79d95133a7\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/nameList.js\":\"e5cd7364d59b707f\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/navigation.js\":\"8b658adee6a1d2b4\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/omnilinerNamespace.js\":\"0f17e7ed2bd49899\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/opfsPageScan.js\":\"9bd39092695de0ac\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelClearance.js\":\"100d6d51318d7e2e\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelHistory.js\":\"6822c63576909686\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelLanes.js\":\"35cb6477517d77a3\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelLayoutProjection.js\":\"2bbbd4449e203cbd\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelScrollAnchor.js\":\"1a86991dd160988f\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/panelUrlFlags.js\":\"4b812027623927af\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/platform.js\":\"65087aa09a9d9d07\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/pluralize.js\":\"002ae8ac8a8f6854\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/propertyCreation.js\":\"82e2bd6c42a9bc41\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/propertyNavigation.js\":\"7da9e1cf92b45e62\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/propertyValueContext.js\":\"51bc47702e5f8297\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/react.js\":\"acfc21927ae56201\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/relativeDate.js\":\"f3e926482b5aea65\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/relativeTime.js\":\"506307dedac8fb55\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/renderScope.js\":\"4d64bcb4fba03408\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/resolvedThenable.js\":\"fe9496e83c5e21a1\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/routing.js\":\"c52f37b6b5851518\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/safeMode.js\":\"2a0eb442be7ce7e4\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/scheduleIdle.js\":\"f63daa157e0f9fde\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/screenWakeLock.js\":\"f7576040c87f80ed\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/selection.js\":\"78c292359d9d2b79\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/softKeyboardGrab.js\":\"45294c7392194163\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/startupTimeline.js\":\"6f8453a7de46f928\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/state.js\":\"160a25dc2dcf9897\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/string.js\":\"0691d0e350d90aca\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/surfaceZoom.js\":\"94b0ca7f55665274\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/time.js\":\"577cad23c58860c0\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/toast.js\":\"9e389ca9e6f9b1c6\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/toggleStore.js\":\"5e924f46740f1ed6\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/untilStopped.js\":\"885c0e308255a978\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/userActivity.js\":\"dc02e12f34f1d5a7\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/viewTransition.js\":\"ee7047611a26b4c6\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/viewport.js\":\"163b087714c535b8\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/webLock.js\":\"2b20988794010531\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/workspaceRecovery.js\":\"89abdece213ee44a\",\"/knowledge-medium/pr-preview/pr-1879/src/utils/workspaceSnapshotStore.js\":\"c5f273fce487bc12\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-compiler-runtime.js\":\"56c91c10c0a50688\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-client.js\":\"528c4f38623009e6\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-server-edge.js\":\"510702eb124578b9\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-server.js\":\"9b367c4ffbb639c2\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-static-edge.js\":\"9369b29b16b32c86\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-static.js\":\"8a83c1fd88f60056\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom-test-utils.js\":\"99245dd98d653fec\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-dom.js\":\"2f77be2ffe350837\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react-jsx-runtime.js\":\"4fbdb3bd5fd7c82d\",\"/knowledge-medium/pr-preview/pr-1879/src/vendor/react.js\":\"c00e8c2dcfdb44fa\",\"/knowledge-medium/pr-preview/pr-1879/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1879/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1879/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
