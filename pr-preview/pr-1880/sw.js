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
		buildId: "e30896726ddb-8bb60987",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1880/\":\"3955106c81e9195d\",\"/knowledge-medium/pr-preview/pr-1880/index.html\":\"3955106c81e9195d\",\"/knowledge-medium/pr-preview/pr-1880/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1880/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1880/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1880/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1880/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1880/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1880/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1880/assets/FacadeVFS-CfwOIaBe.js\":\"99973ad93a0ab6a4\",\"/knowledge-medium/pr-preview/pr-1880/assets/OPFSCoopSyncVFS-CGWyHqTt.js\":\"c19da42fffc5a5f8\",\"/knowledge-medium/pr-preview/pr-1880/assets/OPFSWriteAheadVFS-DE7kQUD9.js\":\"774dcaa43a4409b9\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-BMRXrxyP.js\":\"04c74e4277906524\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-async-oSPzL-0G.js\":\"b6db167cabc22d6f\",\"/knowledge-medium/pr-preview/pr-1880/assets/worker-BFjzcqXv.js\":\"adef31055dbeaae5\",\"/knowledge-medium/pr-preview/pr-1880/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1880/chunks/app-0K6X37p7.js\":\"3f39211ee9013a97\",\"/knowledge-medium/pr-preview/pr-1880/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1880/index.js\":\"d7b91dcfc149cc0e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1880/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1880/assets/AccessHandlePoolVFS-CjRieX9p.js\":\"e94c682b1edc370c\",\"/knowledge-medium/pr-preview/pr-1880/assets/IDBBatchAtomicVFS-KbzNfpmF.js\":\"aa115e545fddd8fd\",\"/knowledge-medium/pr-preview/pr-1880/assets/MemoryVFS-DgvTaVxP.js\":\"78b5975b28904ac1\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-async-CWXr4pAZ.js\":\"f517bf264bab7993\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-shMFXZFp.js\":\"feb6ee6fa0f3b068\",\"/knowledge-medium/pr-preview/pr-1880/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1880/chunks/AccessHandlePoolVFS-CwzNNB12.js\":\"c7d77bad81b60eed\",\"/knowledge-medium/pr-preview/pr-1880/chunks/FacadeVFS-9Z6cBbOl.js\":\"ec4bf6409f31a745\",\"/knowledge-medium/pr-preview/pr-1880/chunks/IDBBatchAtomicVFS-BDgsuoBR.js\":\"4c6f04ebb894d115\",\"/knowledge-medium/pr-preview/pr-1880/chunks/MemoryVFS-Dk9Lo8As.js\":\"0d09a3da046e685f\",\"/knowledge-medium/pr-preview/pr-1880/chunks/OPFSCoopSyncVFS-Cei6vv1T.js\":\"29a8c9f4005cf1b3\",\"/knowledge-medium/pr-preview/pr-1880/chunks/OPFSWriteAheadVFS-BbsRr_Fx.js\":\"327741ada206ae91\",\"/knowledge-medium/pr-preview/pr-1880/chunks/Preview-Ca2b8bQj.js\":\"0a8671ff5b87414f\",\"/knowledge-medium/pr-preview/pr-1880/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1880/chunks/card-CRbI54p1.js\":\"da94393dd518e02b\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dist-Bbp9lw7O.js\":\"166608b705f70e49\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1880/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1880/chunks/mc-wa-sqlite-C9PNh_BD.js\":\"8cbd5be27858a11c\",\"/knowledge-medium/pr-preview/pr-1880/chunks/mc-wa-sqlite-async-BfItegsD.js\":\"f38bc8aa17473799\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-B6wKoWsA.js\":\"f8babdf72314f510\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-BPn9mwZn.js\":\"13651814b7cfb837\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-BUnPIVCo.js\":\"729d513b96636c96\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-Boicu-jm.js\":\"51b94cdbb09920b2\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-BtnGSG2w.js\":\"4b5cf3e763d22c46\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-CHwAV7SC.js\":\"42bc0a8b491cb1d6\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-HfWLGa8v.js\":\"b3eb203d7d13fe7b\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-dom-server-legacy.browser.production-Bews0kGg.js\":\"d2d56c3bbcbdcad2\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-dom-server.browser.production-Dm3aGT8h.js\":\"c9bca5b81b3527a4\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-dom-server.edge.production-D47YGyKm.js\":\"abef48a4d46484c4\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-ml-OmO92.js\":\"e9fa59ea6043e1a5\",\"/knowledge-medium/pr-preview/pr-1880/chunks/server.browser-BGSyaD0v.js\":\"71bba14656210601\",\"/knowledge-medium/pr-preview/pr-1880/chunks/textarea-CuBMKYUA.js\":\"acc59b1e685a8801\",\"/knowledge-medium/pr-preview/pr-1880/chunks/ui-DeIzOikb.js\":\"74d49290a4bca59a\",\"/knowledge-medium/pr-preview/pr-1880/chunks/wa-sqlite-DwcZZiTk.js\":\"dd5ab6256287de95\",\"/knowledge-medium/pr-preview/pr-1880/chunks/wa-sqlite-async-Fu3buZTb.js\":\"b35b1ae066fdf5fa\",\"/knowledge-medium/pr-preview/pr-1880/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1880/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1880/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1880/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1880/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1880/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1880/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1880/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1880/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1880/src/App.js\":\"79533d93ec82488f\",\"/knowledge-medium/pr-preview/pr-1880/src/appUpdate.js\":\"4f382d69dc975a21\",\"/knowledge-medium/pr-preview/pr-1880/src/appVersion.js\":\"8c50934d9c5e42bb\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/initialLayout.js\":\"3887e63d193ee541\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/openWorkspaceData.js\":\"b8997eda7957a5d0\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/resolveWorkspace.js\":\"ba4788d5499a6cd1\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/workspaceBootstrap.js\":\"1c25ce298c2bbeb9\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockComponent.js\":\"e3df01fd4409c219\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockCrumbs.js\":\"15431b786dc73e9c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockEditor.js\":\"fe292518fa93d9eb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockLoadingPlaceholder.js\":\"012434eb7a9f8727\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockProperties.js\":\"04e8bc6d69e545ca\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockSearchPicker.js\":\"ca7da9fd4d9f67ea\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ConfirmBulkDeleteDialog.js\":\"6d256e20cf399b27\",\"/knowledge-medium/pr-preview/pr-1880/src/components/DividerHandle.js\":\"74a23010aacb7a7b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/DraftEditor.js\":\"57bceadd41faeb3b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/GutterPill.js\":\"084b9c0fbc41f7b9\",\"/knowledge-medium/pr-preview/pr-1880/src/components/Header.js\":\"fb6b015ad5b6d532\",\"/knowledge-medium/pr-preview/pr-1880/src/components/LazyBlockComponent.js\":\"f4b227583375100a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/Login.js\":\"4750f05c14026b28\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ZoomableSurface.js\":\"83e5d5314c3819dc\",\"/knowledge-medium/pr-preview/pr-1880/src/components/editModeKeepalive.js\":\"0673780b85f8055a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c87668b6031dfa79\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"cfed430d8dd3f070\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/RefPropertyEditor.js\":\"b5faf7495f8aa926\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/RefTargetTypePicker.js\":\"6648cb4cffa317b8\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/SelectPropertyEditor.js\":\"f0b537a013fb4d23\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/TypesPropertyEditor.js\":\"c1f53ca34be17912\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/defaults.js\":\"5cfe232b76941229\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/kernelValuePresets.js\":\"de9c1c87486a4f92\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/selectablePresets.js\":\"570095834d740f19\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/typesPropertyUi.js\":\"412cadf50515d602\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/AddPropertyForm.js\":\"7546de016f38b7c6\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/PropertyPicker.js\":\"24ed76f40cc18854\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/PropertyRow.js\":\"8a377abeb2e0b404\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/Rows.js\":\"a83f1d6b41acb97b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/actions.js\":\"c96cb3c7341ccf78\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/declarationOnly.js\":\"12053a551932b58f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/layout.js\":\"7fcbe9693923047a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/model.js\":\"9f569b4697c9f79f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/shapeUi.js\":\"215d5e378927008e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/shapes.js\":\"9ccf414b079d0cc9\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/usePropertyEditingActivation.js\":\"129209cb7a77108d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/visibility.js\":\"e07f86674a336f98\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanelSections.js\":\"480bc3afbf049027\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/BlockEmbed.js\":\"b6bff837405b6221\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/BlockLink.js\":\"d9193635c59f2271\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/BlockRef.js\":\"1fc1686675f659cb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/ReferenceLink.js\":\"1fdf881a8f8e7759\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/cycleGuard.js\":\"7cfe5e4e58aab0b0\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/cycleGuardContext.js\":\"81a2f48075148e34\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/linkInteraction.js\":\"633ea87f6416f6aa\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/referenceLayout.js\":\"40c5b2352a0ec75f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/useBlockRefAncestors.js\":\"2fcca94dbefa5bdc\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BlockGutter.js\":\"c51f1ce9182c68e8\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BlockInfoDialog.js\":\"a0240c17006f662e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BlockTypeBlockRenderer.js\":\"f49b1d1f06b03110\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BulletHoverCard.js\":\"ecfea24d2228cac3\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/CodeMirrorContentRenderer.js\":\"8b539066d8c5fccb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0fdb8cedef95101b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/ColumnResizeHandles.js\":\"aeca5bd3efb13bd6\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"205d18870ce9aa1f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/DefaultBlockRenderer.js\":\"262b1d601ddc1665\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/LayoutRenderer.js\":\"67d8cc8048d280bb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/MarkdownContentRenderer.js\":\"205c212baf179e59\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/MissingDataRenderer.js\":\"ce474a582c947262\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/PanelRenderer.js\":\"4bbe349b99446c1f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/PropertySchemaBlockRenderer.js\":\"41a66a5988731a2a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/TopLevelRenderer.js\":\"0262e46dc4be06b0\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/blockGutterMode.js\":\"29ec56a0314e014d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/blockTitleText.js\":\"0b9a972772498211\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/fieldCreationKeydown.js\":\"4a253e5b17813b96\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/layoutRootContext.js\":\"21292b9e23f1a44e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/typeChip/TypeChip.js\":\"3a18e954d7f2b985\",\"/knowledge-medium/pr-preview/pr-1880/src/components/typeChip/chipStyle.js\":\"1c19a7219e78bdb6\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/anchored-floating.js\":\"f2a640b2408d4df1\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/button.js\":\"9568bbe1956c611c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/card.js\":\"14599dace206f477\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/checkbox.js\":\"3cd579b77d564432\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/collapsible.js\":\"3081accb3afeae03\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/command.js\":\"1a624c13b8bfdf9d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/context-menu.js\":\"1aabee222e1a237c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/dialog.js\":\"abde5fa16557d44c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/dropdown-menu.js\":\"591c375d581ef108\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/floating-listbox.js\":\"4b5cfa92d7f8cf34\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/index.js\":\"02237b60be3b87fa\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/input.js\":\"13585be84bfede6b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/kbd.js\":\"7bd22e59d59da512\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/label.js\":\"9e91226078ffcf11\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/textarea.js\":\"42617853dba5649a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/useEditModeYieldKeepalive.js\":\"b9c64d032f853aae\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/BootFallback.js\":\"ad94260ae71871c6\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/FocusedRowLazyMount.js\":\"f2a38393aa1c8d13\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/LazyViewportMount.js\":\"882ca8981a302738\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/LocalDbCorruptionFallback.js\":\"05b9a89d2138491c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/error.js\":\"257e203314e36813\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/lazyMountRegistry.js\":\"0fdf4c29c5bc5b97\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/suspense.js\":\"64e85810f978b99f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/CreateWorkspaceDialog.js\":\"f12580a1aeceb342\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/PendingInvitations.js\":\"95660c0fffe99d21\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/SyncProgress.js\":\"f38bc281ccf439c7\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/UnlockProgress.js\":\"585de66ae2e80c80\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceKeyGate.js\":\"c7970a26353d11e0\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceSettingsDialog.js\":\"0e0493706d616f69\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceSwitcher.js\":\"2725ae9d534b1227\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceSyncGate.js\":\"3aeeb3deb6c5ce43\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/ConversionFlow.js\":\"03d99bb7237929ed\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/ConversionFlowHost.js\":\"7f50ba8dff75f375\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/EncryptionSection.js\":\"47b9bd447220bacf\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/attachmentPrompts.js\":\"30959c72e7b6a76c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/bundleFolderPrompts.js\":\"01c74cbb57a9bc55\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/conversionFlowDeps.js\":\"02255cbe32b56662\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/conversionFlowStore.js\":\"d665f3de48251eeb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/flowUi.js\":\"b6aa83ae10e02a49\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/useConversionRun.js\":\"d7ff82594b552cdb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/keyUi.js\":\"d49c23205e9c452e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/useCloseOnKeyLoss.js\":\"f32ada44090e2356\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/useCloseOnServerE2ee.js\":\"d083e1e2f2124d80\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/workspaceUnlocked.js\":\"2977b9d3bd9542f1\",\"/knowledge-medium/pr-preview/pr-1880/src/context/backgroundSubtree.js\":\"fc3a40f1caff0476\",\"/knowledge-medium/pr-preview/pr-1880/src/context/block.js\":\"a80df2b3776cc3ff\",\"/knowledge-medium/pr-preview/pr-1880/src/context/layoutWsContext.js\":\"eee696e7f5c69126\",\"/knowledge-medium/pr-preview/pr-1880/src/context/propertyDisplay.js\":\"176504b45d1e7944\",\"/knowledge-medium/pr-preview/pr-1880/src/context/repo.js\":\"b25deb1f75d074e0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/aliasClaim.js\":\"073c4862cb529b35\",\"/knowledge-medium/pr-preview/pr-1880/src/data/aliasSeatNamespace.js\":\"c02402ed88dc4f42\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/blockData.js\":\"f274b7b149a75f38\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/blockType.js\":\"20b8bf68f90d67ea\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/changeScope.js\":\"74f4ab8decda5cfc\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/codecs.js\":\"7e8177a948183992\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/derivedData.js\":\"fafe5f56aaad0ce3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/errors.js\":\"a84f946c9e9032a0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/events.js\":\"b3e8d9dba89a68bd\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/handle.js\":\"9a9b3578bd3d147e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/index.js\":\"b9842465d393af24\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/mutator.js\":\"c6c21d10405fd259\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/processor.js\":\"f279f257bb6331e4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/propertySchema.js\":\"81235c8b10b3571b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/query.js\":\"48b6a9e052047aba\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/sameTxProcessor.js\":\"af47a82ffb25f667\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/schema.js\":\"9a9b3578bd3d147e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/tx.js\":\"9a9b3578bd3d147e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/typedBlockQuery.js\":\"0c65194c773e9b0d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/user.js\":\"992ea6fe30326646\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/valuePresetCore.js\":\"f9c3ced7f523c052\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/valuePresets.js\":\"e66e207e771ba6df\",\"/knowledge-medium/pr-preview/pr-1880/src/data/attachmentCleanerIOVerb.js\":\"7c3bd75afabdcade\",\"/knowledge-medium/pr-preview/pr-1880/src/data/block.js\":\"74b6db01fdb9d452\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockCache.js\":\"a5e24e44004018d1\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockId.js\":\"f58091f22da8154e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockLiveness.js\":\"3a6613568dd92824\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockMerge.js\":\"ecedc00f98d8d1cb\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockSchema.js\":\"49e405cc9052da0a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockTypeLookup.js\":\"ece18eb24fe9f9b7\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockTypes.js\":\"b3d4e7b8b671c674\",\"/knowledge-medium/pr-preview/pr-1880/src/data/childrenView.js\":\"1aa2fade35e2bf04\",\"/knowledge-medium/pr-preview/pr-1880/src/data/clientContext.js\":\"7fdfc9e5e2e59c23\",\"/knowledge-medium/pr-preview/pr-1880/src/data/dbFileSiblings.js\":\"1094321f2162f4ce\",\"/knowledge-medium/pr-preview/pr-1880/src/data/definitionSeeds.js\":\"51f63a55b470b025\",\"/knowledge-medium/pr-preview/pr-1880/src/data/derivedIds.js\":\"7ebfada3e4be0dbd\",\"/knowledge-medium/pr-preview/pr-1880/src/data/drawnSubtree.js\":\"96352af4478e38dd\",\"/knowledge-medium/pr-preview/pr-1880/src/data/facetBridge.js\":\"11238521cf4f5ab8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/facets.js\":\"8215aba871710285\",\"/knowledge-medium/pr-preview/pr-1880/src/data/globalState.js\":\"55455193ac6ada5e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/aliasClaimRederiveProcessor.js\":\"781e94a7a830e950\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/ancestorBatch.js\":\"9e5ef227227c7a1f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/blockTypeTypeifyProcessor.js\":\"bc7714d46b5c8c41\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/clientSchema.js\":\"f3220e25204e1927\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/commitPipeline.js\":\"2991d141c3d5f874\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/devAssertions.js\":\"f81edf397c393b5e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/firstSync.js\":\"d6c6ac7ecd362fe5\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/freshInitialLoad.js\":\"9576fe36efb18970\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/graphBackfillClaim.js\":\"70d89a5ac96d7945\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/handleStore.js\":\"e90aa4ea05b5ea83\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/idleMarkerJobs.js\":\"d2d69110322576b5\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/initialDownload.js\":\"c12337c3c46fd527\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/initializeClientDatabase.js\":\"35415b5143bc27a3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/jsonCanonical.js\":\"19f96eb6de39e4f0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/kernelInvalidation.js\":\"d80336ccfbcf6f6d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/kernelProcessors.js\":\"0ba00047d816162a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/kernelQueries.js\":\"7b59da999c401f06\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/mergeTypeMembershipProcessor.js\":\"d9780965172e5f9a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/normalizeReferencesProcessor.js\":\"96b5540c7871c652\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/poolInstrumentation.js\":\"3cfe6c1f934da2f3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/processorRunner.js\":\"118f77346380f483\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyCellBackfill.js\":\"2acf36362eab5ce4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyChildMint.js\":\"680c16758a705b95\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyChildrenProcessor.js\":\"050b0998c378df11\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8f388d877391af18\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyDefinitionSynthesis.js\":\"11e461f643cd8ed6\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyKeyScan.js\":\"78745ceadf82926e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertySchemaResolution.js\":\"eaee55e660ee9154\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyValueEdits.js\":\"66ab98c7338e00f2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/raiseProtocol.js\":\"556dddec28eef8f2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/readBatch.js\":\"51facb0fa0342d30\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/refProjection.js\":\"74e14d6682a6b5b2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/referenceTargetLookups.js\":\"90aa820810b6fa86\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/referenceTargetProcessor.js\":\"a16f32950aa814e8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/replayMerge.js\":\"92cd1266346f32e2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/sqlBinds.js\":\"eeca027a31022f1d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"a88d5329a1dc6e32\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/arrivalProcessors.js\":\"d2226b454a8253aa\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/invalidate.js\":\"c2d553d55e8b0c9f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/materialize.js\":\"115795063061e9c1\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/observer.js\":\"7c579668b81a17bb\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/reconcile.js\":\"d5b83a42da1620b3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/timingMetrics.js\":\"9cf34e74d36302d7\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/treeQueries.js\":\"4048dd610a4760aa\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/txEngine.js\":\"6071217f92952c92\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/txSnapshots.js\":\"f17b67726412b983\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/typedBlockQuery.js\":\"59d601e2e2e0e4ef\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/undoManager.js\":\"56ab5dc2d08fb1be\",\"/knowledge-medium/pr-preview/pr-1880/src/data/invalidation.js\":\"affff1926a2dc813\",\"/knowledge-medium/pr-preview/pr-1880/src/data/kernelDataExtension.js\":\"8830569f8ecbad85\",\"/knowledge-medium/pr-preview/pr-1880/src/data/kernelPage.js\":\"46bc3a0ec0b4b490\",\"/knowledge-medium/pr-preview/pr-1880/src/data/kernelValuePresetCores.js\":\"b2f9ccfdec74a92e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localDbCorruptionSignal.js\":\"711ff4606a2a6cd9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localDbStorage.js\":\"cd0ea208ba87cf85\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localDbVfs.js\":\"31d17b5aa4177b82\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localSchema.js\":\"257fd89984073d6e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/maintenance.js\":\"db66044982454c27\",\"/knowledge-medium/pr-preview/pr-1880/src/data/mergeProperties.js\":\"89b5b39b612ef040\",\"/knowledge-medium/pr-preview/pr-1880/src/data/metricsConsoleHook.js\":\"e369c86bd457fb3f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/migrationsPage.js\":\"6789254266617bd4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/mutators.js\":\"4972d222c7d027ce\",\"/knowledge-medium/pr-preview/pr-1880/src/data/orderKey.js\":\"7f1075a62b31c7a9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/orderKeyPlacement.js\":\"c4ccb46f1e113d75\",\"/knowledge-medium/pr-preview/pr-1880/src/data/outlineSurface.js\":\"dbdefebd240aa42f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/pendingEditorContent.js\":\"e5e3bf2bda733ac1\",\"/knowledge-medium/pr-preview/pr-1880/src/data/pendingUploadsSql.js\":\"32473bf509eea085\",\"/knowledge-medium/pr-preview/pr-1880/src/data/pluginStateExtensions.js\":\"4d2a8191f8dd989d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/powerSyncLogger.js\":\"fb5d0574ff72bd65\",\"/knowledge-medium/pr-preview/pr-1880/src/data/projectorRuntime.js\":\"41652f03731e7cfd\",\"/knowledge-medium/pr-preview/pr-1880/src/data/properties.js\":\"503e50e19fd9ace5\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertiesPage.js\":\"242facaaf482130f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyChildren.js\":\"22ff8d970529069e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDefinitionFanout.js\":\"ed5e655830c44b8f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDefinitionMetadata.js\":\"dbd06c0a6f0f7ada\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDefinitionRegistry.js\":\"e75ca1d33f1d127c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDisplayMode.js\":\"fc7427b511761020\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyRowCreation.js\":\"576d6fb9325a895b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertySchemaCreation.js\":\"a4397612b11b93f4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertySeeds.js\":\"a1e487c2c1a6c792\",\"/knowledge-medium/pr-preview/pr-1880/src/data/recentsPage.js\":\"c46bb2c644d5bef8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/referenceBlock.js\":\"5520c6571ca167c8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/rejectedUploads.js\":\"f262c03a0bafba2b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/releasePowerSyncConnection.js\":\"8038e806cf8167ae\",\"/knowledge-medium/pr-preview/pr-1880/src/data/repo.js\":\"a639534167f5b650\",\"/knowledge-medium/pr-preview/pr-1880/src/data/repoProvider.js\":\"925d27ff8672e38f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/rowProperty.js\":\"cc0c5e1b6aff781b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/searchFilter.js\":\"28ae6eaeaeb5da7c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/seedIdentityLedger.js\":\"a35aea3c64b64fdb\",\"/knowledge-medium/pr-preview/pr-1880/src/data/stateBlocks.js\":\"74375eb673ea9e81\",\"/knowledge-medium/pr-preview/pr-1880/src/data/structuralEditPolicy.js\":\"ca8dba7d87d6e395\",\"/knowledge-medium/pr-preview/pr-1880/src/data/structuralInsert.js\":\"664281fb57831001\",\"/knowledge-medium/pr-preview/pr-1880/src/data/subtreeDelete.js\":\"2497137b608e0f94\",\"/knowledge-medium/pr-preview/pr-1880/src/data/syncStreamLock.js\":\"0f610a1de120eb3f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/syncedTableSqlRecognizer.js\":\"eca1d99f3704634a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/syncedTableWriteGuard.js\":\"2e611b4ea3f9f77a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/targets.js\":\"5b71f3656122080f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeColors.js\":\"77816a32e9b1b3f9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeDefinitionMetadata.js\":\"d6caa968546dd5cd\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeDefinitionRegistry.js\":\"887c9c5d3cc4a3a4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeExtraction.js\":\"d164848f0b9dfb93\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeInitialValues.js\":\"c9a9491e1144cada\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typePropertyGroups.js\":\"9cb6179d3329b7df\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeSeeds.js\":\"04624c262d8fea33\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeTagger.js\":\"ae138d117bb4cf26\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typedRecords.js\":\"05237ea5b46d4f19\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typesPage.js\":\"cc5dc1bade723589\",\"/knowledge-medium/pr-preview/pr-1880/src/data/userPrefs.js\":\"0bb30bbb603d8c18\",\"/knowledge-medium/pr-preview/pr-1880/src/data/userSchemasService.js\":\"e45c63cec92cc12d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/userTypesService.js\":\"4d70111734f3f04b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/valuePresetRegistry.js\":\"b76590f87d413612\",\"/knowledge-medium/pr-preview/pr-1880/src/data/visibleChildren.js\":\"4de2e251449e38e3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceConversion.js\":\"d0df135de8bbd236\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceFirstSync.js\":\"77709eef28a806fa\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceIdNamespace.js\":\"7196879501720b4d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceSchema.js\":\"8e487d0fe1297b9f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaces.js\":\"534200e34a73ce21\",\"/knowledge-medium/pr-preview/pr-1880/src/data/writeAheadLog.js\":\"7b26bd72c88ead26\",\"/knowledge-medium/pr-preview/pr-1880/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/BlockPasteShellDecorator.js\":\"d3095a681f658b50\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/atTrigger.js\":\"8adc094d793d6df3\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/autocomplete.js\":\"538c7b1e78706cd1\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/codeMirrorExtensions.js\":\"0211568999844d07\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/contentFlush.js\":\"9966818ac1e52ea9\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/defaultInteractions.js\":\"47dcc378b4c4c7e8\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/editSettleSignal.js\":\"420f1467ddc06119\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/insertImage.js\":\"6b8ad0e344fc3274\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/referenceCompletionRange.js\":\"0190f516604bd9e5\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/referenceTargetTypes.js\":\"c0c5c2ba5b44311c\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/syntaxContext.js\":\"20f76f6a469a09d8\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/triggerMatch.js\":\"159ef81db3fb6351\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/AppRuntimeProvider.js\":\"c17e91c6e437cbf7\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/BlockFocusShellDecorator.js\":\"8f5f6a26e1275787\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/ExtensionRenderBoundary.js\":\"ff5bb15935e9b842\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/PanelContentRecovery.js\":\"44bbe5d5bb935709\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/apiCatalog.js\":\"5edfc808cac07773\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/approveExtensionHere.js\":\"8437f697969bcaee\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/armedCutAppMount.js\":\"cadb373857ae4033\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/batchableKeyedStore.js\":\"73e6907a200f8e48\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/blockInteraction.js\":\"a25d0af53260d9d6\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/blockSelectionAction.js\":\"f446205dc1ad8c7c\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/compileExtensionModule.js\":\"20677fd90c4b331d\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/compiledModuleCache.js\":\"b2523736bf9105b9\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/continuousGestures.js\":\"1369aa724a8a7639\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/core.js\":\"65537a4ecac08f28\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/defaultRenderers.js\":\"50d94b7ecc242df4\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/definitionFanoutAppMount.js\":\"a8e6a01fa8a63141\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/dialogAppMount.js\":\"9f7b5fa8cba8924e\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/dynamicExtensionSeeds.js\":\"f4b1632df488c5e0\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/dynamicExtensions.js\":\"f51cb31227899592\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/exampleExtensions.js\":\"7d30ab1351317be1\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionApprovalStatus.js\":\"526f68f4e7e1fe49\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionLoadErrorToast.js\":\"7873cb16be8fc14c\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionLoadErrors.js\":\"3487b7c8d517063b\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionLookup.js\":\"4599c6a04ef18be5\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionToggles.js\":\"9a75631db981b268\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionUtilitiesCss.js\":\"d9aef7ab05cc3fdd\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/kernelPageDeletionGuard.js\":\"6159fb4b17db7cf6\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/liveRuntime.js\":\"84761d0ce140c23c\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/openExtensionsSettings.js\":\"df104018eb4ef74a\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/overridesCache.js\":\"17138c9f3b4b7205\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/pluginIds.js\":\"60762a8b9285ca19\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/processorRejectionToast.js\":\"9a23d728b91869b9\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/runtimeActions.js\":\"24c8194776f70201\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/runtimeContext.js\":\"fef9b9d2831da53d\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/staticAppExtensions.js\":\"da1e2fdfc2a286e0\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/staticDataExtensions.js\":\"aa6f6089e0b03a95\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/toastAppMount.js\":\"8a869d2167f8e08b\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/useOverrides.js\":\"a47922ea2c0dc731\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/useShortcutSurfaceActivations.js\":\"800afb20a1497d09\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/discoverToggleTree.js\":\"6e84f1b37988edc7\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/facet.js\":\"d2d9468a6a66cbc3\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/resolveAppRuntime.js\":\"2d3e352bbd29b0eb\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/runtimeEvents.js\":\"04f0fb1f0b2ec036\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/togglable.js\":\"435594ddafd60b7d\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/variantFacet.js\":\"0e49a1474c5ce4fb\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/verbFacet.js\":\"87a0c249e5a071d6\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/block.js\":\"155916cd541f50a5\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/focusedChild.js\":\"82589ee06c0e80a4\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/propertySchemas.js\":\"7259ee7e5b0a0edb\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/typeRegistry.js\":\"8dc76981205bc156\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useAncestorCrumbs.js\":\"2b6b0c9d8ccd4fd7\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useAutocompleteListbox.js\":\"a27ba7286230bd19\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useDebouncedSearch.js\":\"79703c963c5ebefc\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useDebouncedValue.js\":\"86cccb06730c4aaa\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useIsFocalRender.js\":\"2d27b30006d36b11\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useIsReadOnly.js\":\"5454e0adda5ed55a\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useMaterializeBacklog.js\":\"7bf7c871dc3e6086\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useMinuteClock.js\":\"00fc1394e93b1935\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/usePanelLayoutProjection.js\":\"6da1ec0d1fbc357d\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/usePendingInvitations.js\":\"72514114037afa25\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useRendererRegistry.js\":\"911b823540c0c6b1\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useRetainedFieldRows.js\":\"5b7fd5a4088ae627\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useWorkspaces.js\":\"2325cef8ba013257\",\"/knowledge-medium/pr-preview/pr-1880/src/lib/utils.js\":\"4e5807096341038f\",\"/knowledge-medium/pr-preview/pr-1880/src/main.js\":\"0107fa2ff4e4066d\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/MarkdownImage.js\":\"0a8cc234e75a6cb2\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/blockSeparators.js\":\"d01eddc4715af2cf\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/context.js\":\"7d86e49bd482e2e0\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/defaultMarkdownExtension.js\":\"418ac8b6725bada5\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/extensions.js\":\"9874616cb690a15a\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/renderMarkdownHtml.js\":\"6a4c437e0bd47ac5\",\"/knowledge-medium/pr-preview/pr-1880/src/minimal-editor.js\":\"bc21d7540a48ac31\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/armedCut.js\":\"f0a1de99ae9d3fe8\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/captureMediaVerb.js\":\"f77f2a555199e98a\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/clipboard.js\":\"b889a9bf977a3813\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/decision.js\":\"d90c7068cb88b4d5\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/operations.js\":\"a81981a7295d6252\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/account-header/AccountHeaderItem.js\":\"0ba0d7bb87365f8e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/account-header/index.js\":\"92e6e8f5a137159d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"8f45a83ff34717bc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/askAgent.js\":\"3a8f915acf6bb27e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/askedStore.js\":\"6a1951129542da5f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"a442349c5f89c1bd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/chipState.js\":\"592f84d0a5c69630\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/dataExtension.js\":\"cf09d6bf7ba972bb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/index.js\":\"af5837d92607b97e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"3850f0bd603f4db0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/schema.js\":\"03c7c8e778fb2263\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/AgentTokensDialog.js\":\"604fe08ad7e9ed1f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/BridgePairingDialog.js\":\"d768a75550c98a6a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/addMedia.js\":\"34befe8c2a0201b9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/backlinks.js\":\"d4fc9fad0aedb35f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/block.js\":\"095f86a4f5e92676\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/context.js\":\"add9028eeff70632\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f14d3b7e5762e387\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/index.js\":\"def6b915be69b588\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/outline.js\":\"7946e976d9cd7feb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/properties.js\":\"d58def25a75b0826\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/refs.js\":\"3601ff75c0ae033e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"92562246fd12daeb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/search.js\":\"0a82db2d22cb008b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/shared.js\":\"6221c36730a832a9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3e49a2fc3404034e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/text.js\":\"913e225a2e5e4823\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentWrites.js\":\"3fe971d5ec5bbc88\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/authoringCatalog.js\":\"3f9dba2be8e6e8c9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/blockRefTargets.js\":\"6717ec97fc710b74\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/bridge.js\":\"f068ce07b71f93dd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/bridgeLoop.js\":\"7f28963636637170\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/changeHistory.js\":\"9ca3e8fac74c5225\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/commands.js\":\"7d649e426b667260\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/commentsCommands.js\":\"d47a2658844dd2c8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/dataExtension.js\":\"1d77c4f463f27d4f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/dataModelGuide.js\":\"763442d6935873ac\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/dayPropertyInputs.js\":\"45ffaf8f8bf7b1ce\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/describeRuntime.js\":\"175383fc5415a27e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/extensionLint.js\":\"fd787d4ea4f489f0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/grainAudit.js\":\"6ef97e90f1ba6957\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/healthCommand.js\":\"55ae89be0d982668\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/index.js\":\"8113182e08a1175e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/presetIdentity.js\":\"ac1a29fd7affa222\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a2a3dca7ecddc52e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/readMedia.js\":\"78d51f8b4278ea83\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/schema.js\":\"5c948e29123d46dc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/serialization.js\":\"f763bacaea78c5b9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/targets.js\":\"10fa5cb9115fd0ff\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/tokens.js\":\"0ff57a90a94d926a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/watchEvents.js\":\"a096ac7972fdd846\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/workspaceGuard.js\":\"835a513590f7bb40\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/writeCommands.js\":\"7b7783713d55fdd9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/AliasCollisionToast.js\":\"feb479056b387178\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/DuplicateNameBanner.js\":\"cc4801578fcf0f2d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/collisionMerge.js\":\"d4776f1181531183\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/dataExtension.js\":\"43d19076b581a739\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/index.js\":\"b21da023eb32513b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/mergeCollisionAction.js\":\"88ad3d5747ec19f4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/pageStyling.js\":\"12dc1977c68923c5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/rejectionToast.js\":\"8df1e0ddb793e916\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/syncProcessor.js\":\"6e983a42689a5858\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/actions.js\":\"18eabeafb07471c3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/addComment.js\":\"c8d38cca8fc5b5af\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/anchor.js\":\"83b4e1120e19e771\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/anchorState.js\":\"a475c3b8b992da65\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/commentLinks.js\":\"97f56606e0fb30d5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/confirmThreadDeletion.js\":\"1fcdfaac5c8b54b4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/container.js\":\"83e3d10ebb082e10\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/dataExtension.js\":\"6db99031326c305c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/deleteComment.js\":\"ca1c7cc87f319303\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/highlights.js\":\"98ffe965a8f88873\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/index.js\":\"b1c630b8586f5e7f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/linkedCommentsPill.js\":\"8607439715bdb7d3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/margin.js\":\"332ba89fea697838\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/marginAnchorLinks.js\":\"8c041996ab582e0d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/marginSchema.js\":\"fd93a439e066c510\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/newComment.js\":\"ae747503f41d6f7b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/ownThreadPicker.js\":\"970120d02c4d9490\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/placement.js\":\"5ec91565d6294366\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/queries.js\":\"e03124517b0df105\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/quotePosition.js\":\"a9ce43ed9ba590a5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/quotedIn.js\":\"aeb0f8cdde6a455e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/quotedRange.js\":\"68836f095290d54a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/rangeRefs.js\":\"c604dd7457185e8b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/readHighlights.js\":\"145de6fa5a3f42bd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/readSelection.js\":\"d036ef2d30922f54\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/readSelectionUi.js\":\"83126c8f2cf42a2d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/reanchor.js\":\"ce56d0acc7117224\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/schema.js\":\"4da3ffccc9bc9bd3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/scope.js\":\"4bde75bcbf8124bb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/scopeThreads.js\":\"06ab3950c2788afc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/splitRetarget.js\":\"d7006f75b416ae89\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/suggestionCard.js\":\"d2a7d612cb5bdb3d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/suggestions.js\":\"d8bbe047f0976ae1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/summaries.js\":\"97bb76de8141ee34\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/summaryBatch.js\":\"7119402c27008d0d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/surface.js\":\"d267b3d322fb47c5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/threadNavigation.js\":\"add59561829fdf2a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/threads.js\":\"1e1f9a83fa08cb15\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/ui.js\":\"b4e7a34b2c03568b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/uiStore.js\":\"964371a278044dc5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-intents/appIntents.js\":\"8810f5c7a8bd72ad\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-intents/index.js\":\"9c4e4e3b61f6a905\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-update-prompt/index.js\":\"8d5e63480d469dd9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-update-prompt/status.js\":\"5d5f253928bd4042\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"30fdee68c96bbe3e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/MediaBlockRenderer.js\":\"bf0f44d6b5d05998\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/MediaDownLaneReplicator.js\":\"498f8bedc4a38d27\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/MediaUploadReconciler.js\":\"d4030c135ca804e3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/assetDownLane.js\":\"d5aea6c84a66cd73\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/assetResolver.js\":\"73ff6cc6553816e3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/assetUpload.js\":\"edde9beb773f6d02\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/attachmentCleanerIO.js\":\"35f944f8687d8ea9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/supabaseAuditIO.js\":\"a0cafb03834a44cf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/blobStore.js\":\"e37aab278e0accd9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/browserMedia.js\":\"8732c79dd8e0cb1c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/byteStore.js\":\"2a5e1fabffcff966\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/cleanerIO.js\":\"4ebf32b84f423e39\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/cleanupAttachments.js\":\"a51f31f278931595\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/dataExtension.js\":\"1ac0fd29223ad91b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/downLane.js\":\"a2b072a552ae4bff\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/index.js\":\"29c9d6482d402624\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/insertImageContribution.js\":\"38b1b9530d250a63\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/laneArming.js\":\"61be3894c19a1dad\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/laneLock.js\":\"5562fb47b8ceaaef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaBlock.js\":\"932a0a90c54f5e56\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaCapture.js\":\"abe76be21b1c54bc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaLanes.js\":\"dd7f2fd15d892aeb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaViewers.js\":\"b5bef3785879158b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaViewersFacet.js\":\"eece0b88555f1364\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/pasteCapture.js\":\"5f5ee6eb331dd374\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/resolver.js\":\"7316e3f36355de8b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/retryUploadsAction.js\":\"a4432e12c8a405c7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/storagePaths.js\":\"13dbc9433f7a49b3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadDrain.js\":\"87d3fe46b8f8548e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadLaneStatus.js\":\"0646a0b060bb3cde\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadReconcile.js\":\"f6a1099cca651f71\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadRecovery.js\":\"d02f51732436c5e0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadStore.js\":\"90206d17e4195752\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/useAssetObjectUrl.js\":\"c7e6a8cb3e4c68b9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"beba2d445ddd64b7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5f8dcbb15970e73b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/facet.js\":\"9169a37bd88f701a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/index.js\":\"395f8bd05d54edef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/prop.js\":\"eed79c9616c5ae36\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/BacklinkFilters.js\":\"fe061535f7ce3a06\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"59c81223d577c78a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/BlockEntry.js\":\"f5c25959fecddc5a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/LinkedReferences.js\":\"5daab21daad7fd5c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"cdec0a6c55832ca2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/dailyNoteDefaults.js\":\"9e294462a0eaf6d2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/dataExtension.js\":\"800084ad56f878fa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/edgeExclusions.js\":\"81a92cf7c557c8cd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/filterProperty.js\":\"8acf661ee17a0c9b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/index.js\":\"35e1db7eeb4d2894\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ba97dae58b5311bd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/applies.js\":\"2370e085da8adec6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/countQuery.js\":\"a90eb38a12e96e5a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/expansionStore.js\":\"94f30e3604cd0377\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/index.js\":\"01531c6eec99a201\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"500a120f406ca166\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/presentationInvalidation.js\":\"2851a8d6086bc013\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/propertyEditorOverride.js\":\"afbf3a7b4927bbc3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/propertyFilter.js\":\"b4a7a958abc74b22\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/query.js\":\"394910e18477ca01\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/resolveFilter.js\":\"d683f299e6fb1ca5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/sourceBatch.js\":\"d5958ef16320080b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/sources.js\":\"7269895c2e50a553\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/useBacklinks.js\":\"6e2ada352626fdce\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b3cc390101abfb33\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/BirthdayCelebration.js\":\"6e7b558203b01570\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/BirthdayOverlay.js\":\"b755f79d93c460d1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/gate.js\":\"6a3f744d813d213a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/index.js\":\"62097654e89eb795\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/wolfTheme.js\":\"66845449f6f92be4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/BlockDragLayer.js\":\"a6df803b1e446981\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/dragController.js\":\"5df8670cf9d6d277\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/dropTarget.js\":\"d74bd5a528f2501c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/index.js\":\"71833fda6ecb6ed7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/projection.js\":\"301cab425fff256c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-info/BlockMetaCard.js\":\"b8e8c6ad21ceb9b2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-info/index.js\":\"057d79962a7c01fa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/AddTagDialog.js\":\"c03f74408c17fbbb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"89c869e9ab3a6ddf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/TagNameIssueHint.js\":\"b0e85d63ecfc962d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/addTagAction.js\":\"9cc2c041d2c7f521\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/appendTag.js\":\"7edb55295bb88d96\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/config.js\":\"9aae3afbda6039de\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/dataExtension.js\":\"81a8db6dfa41603e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/index.js\":\"32f30af4c5c2a769\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/propertyEditorOverride.js\":\"ae5cea283c55c918\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f1fdd4d4a95ca85a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"827be5c46d76878a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/Breadcrumbs.js\":\"7dbd1188ac840d74\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e9f046fa52b08073\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"39296b42b8334514\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/index.js\":\"245c3e659f3e3c68\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"158b1f9f5de8e928\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/CharacterCountItem.js\":\"3fe0a3d56ad761c0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e559e9aeaf3ed1ac\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/actions.js\":\"07c155046fe0ed9a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/blockType.js\":\"846f83942f7d176d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/charCount.js\":\"a0d9d769973d4eea\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/dataExtension.js\":\"c380e6f4213ac8f7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/index.js\":\"e93545e560c4d1fa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/profiles.js\":\"5062e6b5cc440eb6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/properties.js\":\"75e23d59a298089b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/textCounts.js\":\"2e0ec93fff6942f9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/colemak-keybindings/index.js\":\"1a29c671b0e7617d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/CommandPalette.js\":\"26968ade1af8451a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/HeaderItem.js\":\"20a5e914e32731f0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/context.js\":\"a442a9d3b9ce30e1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/index.js\":\"95f021505a19abc5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/selection.js\":\"e1f0e2d7c7c438b3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/toggleStore.js\":\"ba4a9908f99f6896\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/useCommandPaletteActions.js\":\"a6b2446361d2e00c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/ContributorBadges.js\":\"8997fb8012b7037f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/author.js\":\"295e23da8ab007e5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/codeMirrorExtensions.js\":\"37cd963fd25c092c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/dataExtension.js\":\"05b2584037a20d46\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/index.js\":\"15a8c76adc8ca049\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/mentionAutocomplete.js\":\"d30c386e63eb6225\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/processor.js\":\"a566ee614d501b14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/profiles.js\":\"ce5b23bbf14de421\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/queries.js\":\"29f6c592011ca138\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/schema.js\":\"75be78f2ee3d6a52\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9656adfe360b487b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/followOrigin.js\":\"68dadcf9c336f906\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/index.js\":\"9fc7d5d6e5e3cd9c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"fc866325edda0ab5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f11ce3139041a5f7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/CalendarGrid.js\":\"e9864ea581f18329\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DailyNotePicker.js\":\"385017ff5c2b6c21\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ea8c7ef649f4af8d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DateNavDecorator.js\":\"a4bc7d35480d367b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DateScrubOverlay.js\":\"9cfa2140a32e2be5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DayPropertyEditor.js\":\"ceba473e0544e856\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/HeaderItem.js\":\"5f8ccf9a64a231af\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/ReschedulePicker.js\":\"9a994bf0265b45df\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/SpreadDatesDialog.js\":\"6fecd2335404a5cb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/actions.js\":\"d6b81baf3581685a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/blockDateAdapter.js\":\"401a762ec6aa2a00\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/calendar.js\":\"9d5188c1ef4ba2fc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dailyNotes.js\":\"d57d75d430df7b35\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dataExtension.js\":\"d5cb69875f8cfcb1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubActions.js\":\"11b9447f3810e77f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubGesture.js\":\"a91fa6053a653583\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubGestureActions.js\":\"93eab7dda83be766\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e4c29bd51b4e9b68\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dayProperty.js\":\"fc555304f87be1c0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/deletionGuard.js\":\"db5a22f8d14faf12\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dueQuery.js\":\"a2b83cf66e587d93\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/index.js\":\"2afd124875c8aa1f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/landing.js\":\"0305d57f04464fb4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/localSchema.js\":\"164d096485df54c5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/referenceDateAdapter.js\":\"8f15ed21beba7044\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/rescheduleAction.js\":\"de2d409590505bb0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/schema.js\":\"953e868b843e54f4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/spreadBlockDates.js\":\"f3f430ea89c9ccfc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/spreadDatesAction.js\":\"975e46212c2f37a0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/today.js\":\"0c36d9118282dc6d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"282cf401861b4b1d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"39e07ba2b118347e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/audit.js\":\"a999c5326d4f2455\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/auditAction.js\":\"dd12f3d64d7f01e7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/auditRanges.js\":\"8c92d8e708d59ed3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/diagnosticsSource.js\":\"4cd4b6a620da938d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/divergenceScan.js\":\"c2b412bec29c0ac7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/index.js\":\"bea2a7c0f2f6d47e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/propertyChildrenChecks.js\":\"422cdc24a071d7d0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/referencesMirror.js\":\"cd3d938e6d0a4414\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/rowJson.js\":\"f4d3031ab4f49ef6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/schedule.js\":\"65682a255a246748\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/store.js\":\"e57def70d5d2f325\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-maintenance/action.js\":\"770692c99861a7e9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-maintenance/index.js\":\"5e45a66da322f05b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-maintenance/plugin.js\":\"5c2b07c8141547c9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"04e4bcf0d591628a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/actions.js\":\"7c3dba529969891b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/changeMarker.js\":\"b74a91822e4f7ea0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/diagnostics.js\":\"bbd9da1233c5c771\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/fileSystemAccess.js\":\"1b027ac163664b10\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/filenames.js\":\"8052c12e8af35d6f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/index.js\":\"27a503f4b127c3a9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/mirror.js\":\"8137e0b6246c5db5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/runLock.js\":\"8c2b0452b9d338fa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/runtimeHealth.js\":\"70fe4bea7793535d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/schedule.js\":\"932c6d91bca94283\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/store.js\":\"4a5e8d1dda2d7282\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/default-themes/index.js\":\"6fde30092fe73843\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/default-themes/themes.js\":\"3a2ed1d7c7ac1316\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/diagnostics/facet.js\":\"9e50caa802bd6088\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/diagnostics/useDiagnostics.js\":\"227ced21cd057762\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/dismissals.js\":\"66a8970e7ae7395b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/index.js\":\"b456d3df3a05eb18\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/status.js\":\"79486fde5b1663e0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/store.js\":\"93be97a214f221d1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7dc6844e194a2a60\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/ExtensionsSettings.js\":\"12908b33cbcfd883\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/actions.js\":\"dd186306d18ef2d4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/config.js\":\"e7f0d008b5c05594\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/dataExtension.js\":\"c5e7f1b3b48446d2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/effect.js\":\"722158d256ec95eb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/index.js\":\"a448a68d3ca70d02\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/propertyEditorOverride.js\":\"c609b15c7494d9f6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/useToggleTree.js\":\"f748dffa02d042d1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/ExtractTypeDialog.js\":\"006619c40c0ea56c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"81f84e59864311b1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/PropertyShapePicker.js\":\"965e46b0b8fb70c8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/action.js\":\"081dd535c0122395\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/index.js\":\"a061eb36931c7e81\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/FindReplaceDialog.js\":\"8790a2fde1e07438\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/HeaderItem.js\":\"27e93b4bf2b8c4ae\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/dataExtension.js\":\"e5a92f781bd90418\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/index.js\":\"0fa7aeaff9acfd5a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/search.js\":\"1f11a4e406027538\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/toggleStore.js\":\"e168b842857bceee\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/LocationPropertyEditor.js\":\"ea11f19bf29095d3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/MapView.js\":\"80bab6bb7b4de981\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/blockTypes.js\":\"c23c280d6c080924\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/codeMirrorExtensions.js\":\"fe0b045f34b71a5d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/createOrFindPlace.js\":\"7efb3c7d96beec41\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/currentLocation.js\":\"276f0106abbf040b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/dataExtension.js\":\"9ab5c219b1ad38ef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/geoContentDecorator.js\":\"adffa4f323b37da3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/googlePlacesClient.js\":\"7f94e0fea66c9f28\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/index.js\":\"574ef19c5dd6b2be\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/locationsPage.js\":\"fbe53dc8682234f4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/mapViewport.js\":\"b72ecf3f4a3c3293\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/pickCurrentLocation.js\":\"efb72d808899588d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/placeAutocomplete.js\":\"6024af28a2f2aa4f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/placeNameCollision.js\":\"666b5ac313f034c1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/properties.js\":\"e71b44da211bb347\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/propertyEditorOverrides.js\":\"8d49105c44fa35fe\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/query.js\":\"16e588ba1631b206\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/usePlaceSearch.js\":\"6027d853d391b73b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"58ed3286ab17f6ac\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d9cb9851028457ef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ead2fef8e3997631\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/config.js\":\"f155e64c168fca87\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/dataExtension.js\":\"89d1fc8bad975c8f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/facet.js\":\"5feffe2ef269cb95\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/grouping.js\":\"07ba80a98e5abc1f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/index.js\":\"25264cc088e2c05c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"be12cc22f697f9a3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/query.js\":\"01d8a818bed6dff7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/resolveConfig.js\":\"980206765b46028e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"43858bb8431d5367\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"cf521596c2017afd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/HtmlDocumentContent.js\":\"124c67bb3a665c51\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/HtmlFrame.js\":\"f27d2b958a36ae8c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/actions.js\":\"00e256d45c45fde8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/blockType.js\":\"1e2b34f48508bcaa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/confirmRunScripts.js\":\"1f103148e846720b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/dataExtension.js\":\"d1f15c24d494d5df\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/frameAnnotations.js\":\"c412eb17756a8491\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/frameDocument.js\":\"905166b1af9a70f0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/frameTheme.js\":\"5dea5c6f476f0b28\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/index.js\":\"8239b5a0a4960cd4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/scriptConsent.js\":\"23c96e1946ee6530\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/sourceMap.js\":\"d4eae55f02eff973\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/useDocumentScripts.js\":\"799bc36bdd4a9f2b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/index.js\":\"0a702e170469e202\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/record.js\":\"65db7396bf1fa989\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/recordStore.js\":\"2b1fdb2fde13c780\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/responsiveness.js\":\"7695bbdf2386f4c0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/schedule.js\":\"7233e1b3edc363ea\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/sessionContext.js\":\"4037690382fb86f8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d7fcb0998a786b2b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"b0241f9c91f3332a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/actions.js\":\"2432be1a63a175ac\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/config.js\":\"2d1448a9292b6c0d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/dataExtension.js\":\"11b2e8d3e996c592\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/effect.js\":\"c0c122852c66f234\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/index.js\":\"6c365373c2d8127c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/keyCapture.js\":\"b7da00cad5a588c6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/overrideStore.js\":\"844beeb1b23d1540\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"52ec4221f5fc4963\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/HeaderItem.js\":\"f9501eea8bbcc564\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/LeftSidebar.js\":\"133240f7213df6dd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/actions.js\":\"0fff06c3e2e28354\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/facet.js\":\"28d23af6929a10de\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/index.js\":\"a8a34f80d3c6cb80\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/shortcuts.js\":\"140f165b5ea8b453\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/toggleStore.js\":\"0bf6262153e3d424\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/MergePicker.js\":\"c7c7e6fc3a9de5eb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/index.js\":\"26c1bf562c7f2e66\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/mergeAction.js\":\"7d42aab233ad6be4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/strategy.js\":\"162cd53ec8c83a64\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/Button.js\":\"7ba044a4a93148b6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"786450677e8e0599\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/defaultItems.js\":\"4178ee1d5d5cc971\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/facet.js\":\"8d5c56880e5d58b5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/index.js\":\"40ff4b6fa1834d42\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a9374467d1c1d215\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/actions.js\":\"7ef644349f2cc2f2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"a4bb4201b57d191d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/facet.js\":\"1d7f69a8ddbfeeb2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/index.js\":\"6c225fd57d3e3428\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5fac0f7861a0ceac\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/blockSubtreeMembership.js\":\"f9929e80e042922d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/contextMenuItem.js\":\"68159295f5c4df0e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/index.js\":\"2e2dea01a9f436df\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/moveAction.js\":\"b3c959a18489bb90\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/moveBlocks.js\":\"8631ebf5d2670a1b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/selectionAfterMove.js\":\"f89e49ccea0d0076\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/TutorialBanner.js\":\"719a8cacc97c8fcd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/action.js\":\"b5548e0119e54dab\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/bannerDismissal.js\":\"9bc7ebd0ddc65472\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/documents/cheatSheet.js\":\"f047e00557b72f04\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/index.js\":\"c56deeaba4a28dd6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/keys.js\":\"c63219b16f528116\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/landing.js\":\"ae961db3c9a62dcb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/outline.js\":\"d9d5fd6ef8c4b4f6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/seed.js\":\"a958ff5103d7bafe\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8728d01a4e773ae7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/analyze.js\":\"15623af0e2cd7232\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/diagnosticsSource.js\":\"6236bccfaa010ea9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/index.js\":\"58ac20c7d3adcf6e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/load.js\":\"9783373f817c5abc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/monitorRun.js\":\"74f51751557cca1d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/schedule.js\":\"86e1c326beb1f11f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/series.js\":\"43621ff2311b5d1a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/store.js\":\"1d555bd782f515a7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/trendAction.js\":\"ced1712f9a7da89f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/verdict.js\":\"297dbb5daf7b8b55\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/plain-outliner/clickToEditAction.js\":\"2d2c73e99b9f8034\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/plain-outliner/index.js\":\"8a4d442953c3594a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/plain-outliner/interactions.js\":\"028af41fc4dbedd9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"585ca352183e7086\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/MigrationGate.js\":\"0935ea82b89bf4e7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/MigrationGateDialog.js\":\"4a2bfc4e0128a732\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/action.js\":\"41c22921193c8cc2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/index.js\":\"1a5a777cbd99674c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/localRunMessage.js\":\"84547970f9f7d301\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/plugin.js\":\"0a46c8f878842b65\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/progressReport.js\":\"3af23800461720c1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/sweepProgress.js\":\"ee4eb3daa9d8ed3a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/FieldRowRenderer.js\":\"98bd59eab351dc7f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/ValueRowRenderer.js\":\"1b3aeb6389a155ca\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/actions.js\":\"3812a8fcfa532c7c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/autocomplete.js\":\"1a2577fa097dcf4d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/fieldRow.js\":\"71d35ee38e17a32e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/index.js\":\"91de18f011f279ff\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/referenceWarning.js\":\"c1bdca1089d290c8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/valueAutocomplete.js\":\"b51bd8b90cd91f15\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/valueSchema.js\":\"a50c2ac5e2c97ba0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/HeaderItem.js\":\"47eb20172a9f6b78\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/QuickFind.js\":\"0cbc62e93476c714\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/index.js\":\"bdcd1016f68c06e4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/recents.js\":\"b02eb3be1add1974\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/resultItems.js\":\"c9ed6521f311fa64\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/selection.js\":\"87f93c1d39745b4a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/toggleStore.js\":\"0baa351a4f19337a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/HeaderItem.js\":\"2fb77cbf9dbb8042\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4a2011c8a143d56a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/grouping.js\":\"6258cd1b4aa50cd1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/index.js\":\"02b8f962d29343bb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/target.js\":\"8a3f67c535974028\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/codeMirrorExtensions.js\":\"b3346c14987e1054\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/contentPrefill.js\":\"7c275ef137a666fa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/dataExtension.js\":\"5afd16749725f71e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/index.js\":\"804081bba77459a2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"31b10726bba1b366\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/invalidation.js\":\"dff39b1e8edcc7a0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/localSchema.js\":\"1120c4b3345fb0a4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/blockrefs/index.js\":\"28b43a69a314139a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"8161ab3ea58949ca\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/index.js\":\"ff2ad78bc34cc3ee\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/referenceNode.js\":\"121dc50a2e14aba1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/remark-reference-occurrences.js\":\"fcfffe4d0a22da59\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c6e892263007d19b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/index.js\":\"cf4e5844dedeaec3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"66381265c7c46f0b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d7813081160a4349\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/mergeRetargetProcessor.js\":\"1e4d7a87243d7bac\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/parseFence.js\":\"a369359416bf2856\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/referenceParser.js\":\"b866f206bd96bb19\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/referenceProjection.js\":\"8863ef6fd5a61cca\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/referencesProcessor.js\":\"013621f00fdc6b36\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/renameProcessor.js\":\"2537f2a7058807d5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/spanReplacement.js\":\"f4ff7562e8aebd19\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/htmlToOutline.js\":\"8ec838fd951b5c00\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/index.js\":\"a5a66342fab42193\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f41b624ffee27d33\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/pasteDecision.js\":\"b8b983aaba2fe900\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/action.js\":\"aef83eec53b5d395\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/blockIds.js\":\"8f63104cdd584c86\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/content.js\":\"411aa791bfd83028\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/effect.js\":\"cd4a7cbf0a9365ba\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/ids.js\":\"62acebe7cedb1553\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/import.js\":\"6451a22f8340974a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/index.js\":\"36d5fdc6293940ad\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/plan.js\":\"2bae76c9cc9f5f9b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/plugin.js\":\"8df874b9e3e7bdfe\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/promotion.js\":\"ab59bcc2e789e02d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/properties.js\":\"f000edb828addd6a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/references.js\":\"cdbcd075e2ff766f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/report.js\":\"9c344ee2d65abfda\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/roamMemo.js\":\"f07f51ea4ad62772\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/runtime.js\":\"63b5c7fa2a783e51\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/schemaReconciliation.js\":\"1835e583840163a5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/srsMarkers.js\":\"b29d4ef7054c7749\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/todo.js\":\"a40ee9cd1ad4c74f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/typeCandidates.js\":\"fb230588a5694b19\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/types.js\":\"fdfede8990ffc1a4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/search-health/index.js\":\"0b4e8a7195a787f2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/search-health/store.js\":\"d369f91b01f2e891\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/HeaderItem.js\":\"5a2e009f282ec895\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"46167a3b5a6ad34a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/index.js\":\"5310d6c0a26a38ad\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/model.js\":\"ebd84c54530becd5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/toggleStore.js\":\"f9631e0b2f63ddab\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/useKeyInspector.js\":\"0814c9d923f7f8f4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"4313fe318a8a276f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/ShellDecorator.js\":\"11d8d606cbf4d147\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/actions.js\":\"72bc4aaeebff81a3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/exclusionsFacet.js\":\"16efb01a94fbd5f7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/index.js\":\"bd6a79f21ea7890b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/shell.js\":\"04a6bfdb89682e45\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/surface.js\":\"0588b39512f8cd84\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/walker.js\":\"653d5fcb0ecb0b1b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/RescheduleToast.js\":\"9155504f569f192e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/dataExtension.js\":\"cc3a9cd4e1fffe3e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/index.js\":\"4f8c6b4cc3e50f9c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/indicator.js\":\"4c32f46ebeaff48d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/moveSrsState.js\":\"559f47bfc7cd44f3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"73be609b2fd25406\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/scheduler.js\":\"e54c3e25fa38e5e7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/schema.js\":\"ae819bf69ad112fb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"54ab05d6b247df74\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/srsClipboard.js\":\"c4ab21701e3f876a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ee4d8cae254f36b4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/DailyNoteReviewHint.js\":\"beaa7ca0645dca61\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/DeckPicker.js\":\"5203a003d6cf01a4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/ReviewControls.js\":\"b9f788a2dd806b5a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/ReviewDeckRenderer.js\":\"5767a858f2a7474b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/ReviewSession.js\":\"faa7feebf13c488a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/actions.js\":\"633ed2f0d71175c0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/archive.js\":\"772dd0cdb5ce4880\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/dataExtension.js\":\"5848bdcc58fb9f84\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/deck.js\":\"09f6a35d26bc6694\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/dueQuery.js\":\"5871d7cdec9d6532\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/gradeDecision.js\":\"180e64cdf8e6cc6a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/index.js\":\"ad2931cd62a056c1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/keyHints.js\":\"7c818ee30b10ce9c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/reviewCardLayout.js\":\"59442052e902d7c5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/reviewProgress.js\":\"ecb747da4cebeb2c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/schema.js\":\"e585d61a59b8445b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/useDueCards.js\":\"4a4b0cd2918f8689\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/startup-metrics/index.js\":\"047accfd574da471\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/startup-metrics/record.js\":\"5f275471b3c407f9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/storage-persistence/index.js\":\"34012f74abaaabcd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/storage-persistence/persistenceStatus.js\":\"052894da3324091f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/storage-persistence/requestAction.js\":\"60370a9a4011fe74\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/TypeChipsDecorator.js\":\"c6c15f987eeac0ee\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/codeMirrorExtensions.js\":\"f425cc0986d4fb4a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/index.js\":\"2b32adfe6a36a6e7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/typeAutocomplete.js\":\"4c3bcbe8400604fa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"2ea1c829e7ad3935\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/actions.js\":\"4d2fd2a80addd1f9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/anchor.js\":\"bca2fe0ce04ff995\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/events.js\":\"c5152582e3c183c6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/gestureActions.js\":\"c2fd090eadacf8ea\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/index.js\":\"860a1d6f5a49fd52\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"04a9e1fa35d3385d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/sync-metrics/collect.js\":\"56ffdd64d1d4fb1e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/sync-metrics/index.js\":\"adcf523744a66dbf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/sync-metrics/record.js\":\"2cce9f7096594626\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/RejectionDialog.js\":\"f9abae23de09cc77\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/SystemStatusHeaderItem.js\":\"4a05c3227b5d58e5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/index.js\":\"36f2b808b6be641e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/model.js\":\"b8a5fae2d7dcf9fa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/queueCounts.js\":\"57c1aa9fc4854947\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/rejectedHelpers.js\":\"56acd5c4b7baaa7f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/rematerializeAction.js\":\"bcf7ff43927a04d5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/useHysteresis.js\":\"0ac6e30229757a6f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/ColumnHeaders.js\":\"40b3b5b61b262ec7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/QueryUi.js\":\"d158151b3d6ad47a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/TableLayout.js\":\"57eb5926672521aa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/actions.js\":\"8ae4cbc1f99dcb03\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/cellEdits.js\":\"c9a95b98add333e9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/childrenViews.js\":\"fc17cd247ef115f0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/columns.js\":\"16003c08ed437527\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/controller.js\":\"c6b7fde34d189417\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/convert.js\":\"b07279e3b4c275b2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/dataExtension.js\":\"b3ce7416d0d992e7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/index.js\":\"98a1d99ba80b2050\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/keys.js\":\"52ab972e23bf5e4b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/model.js\":\"751d0dde2d967259\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/backfill.js\":\"fdadf76ed3db601e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/completion.js\":\"dea6447776655c65\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/format.js\":\"4bdd0e9a81bcb908\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/parse.js\":\"5c15a3a7511d4aba\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/queryValue.js\":\"617607e869a8b5cb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/registrations.js\":\"b7a5d89d06e57e40\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/source.js\":\"b100a64d1f381445\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/registry.js\":\"6f88549e89e3d672\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/rowGutter.js\":\"a16def5ce30f22d8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/rowVerbs.js\":\"768482bb4ced347a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/schema.js\":\"d6e0b4eddb9efd1d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/sort.js\":\"a64d02b2fe624f07\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/theme-toggle/effect.js\":\"aeade463627fce85\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/theme-toggle/index.js\":\"a1696f2638caec9c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/theme-toggle/theme.js\":\"49cf51e126377b7a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/actions.js\":\"3e214e45b8017372\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/dataExtension.js\":\"0a01bf2701f1860b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/index.js\":\"759a060551186bbe\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/schema.js\":\"01efe26cec5e9be7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/TouchSelectionLayer.js\":\"82e6cffc4d0347c9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/actions.js\":\"e32e4c6a52354027\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/defaultItems.js\":\"180f68468ac4455f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/facet.js\":\"2e510179cc3ded15\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/holdRecognizer.js\":\"5931432475670064\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/index.js\":\"482f2ff55e42136b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/update-indicator/UpdateIndicator.js\":\"28770818ddc4a8fc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/update-indicator/index.js\":\"2210c4942dafd50d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/update-indicator/loadTimes.js\":\"3ed27d69608483db\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/VideoNotesRenderer.js\":\"161ff64cc2bd86e6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/VideoPlayerRenderer.js\":\"bb7269dbebe20488\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/VideoTimeStamp.js\":\"c036b2a648e8192b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/actions.js\":\"a0960a8fafd147d4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/index.js\":\"b4c541d1bcb4988e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/markdown.js\":\"d1865a8c93275370\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/notes.js\":\"bcf9b77b6b625ec8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/registry.js\":\"6df9b3562fa82951\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/remark-timestamps.js\":\"3e5160d4968ff713\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/view.js\":\"46c548e4cb0d5d60\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/LinkHints.js\":\"b28972b8905a8588\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/index.js\":\"97384c56df8e9e8d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/model.js\":\"11d5ed7064df92e7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/settings.js\":\"68e5948854b58cbf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-normal-mode/actions.js\":\"7dd4405d14f35895\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-normal-mode/index.js\":\"8e931cb51fc34457\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-normal-mode/interactions.js\":\"801dabadbe7f9ea8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/workspace-header/index.js\":\"b5a52e945ff4842f\",\"/knowledge-medium/pr-preview/pr-1880/src/registerServiceWorker.js\":\"3066108856f44af8\",\"/knowledge-medium/pr-preview/pr-1880/src/requestPersistentStorage.js\":\"17851b76363fef7a\",\"/knowledge-medium/pr-preview/pr-1880/src/services/authRequestDeadline.js\":\"b0c216c46c944260\",\"/knowledge-medium/pr-preview/pr-1880/src/services/authStorage.js\":\"96d13cbc7efac2bc\",\"/knowledge-medium/pr-preview/pr-1880/src/services/powersync.js\":\"acc65bd3d7c9f614\",\"/knowledge-medium/pr-preview/pr-1880/src/services/supabase.js\":\"229bdd9774f32cb3\",\"/knowledge-medium/pr-preview/pr-1880/src/services/uploadErrorClassifier.js\":\"ac1b16550e568ee5\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/ActiveContexts.js\":\"5d3874765b9ac8e9\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/HotkeyReconciler.js\":\"df43f01739c55108\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/WipeLocalDataDialog.js\":\"6798aa660be9716b\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/actionDispatch.js\":\"21c62076ad8db03d\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/actionRefItems.js\":\"b2f23f805a6d5384\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/applyKeybindingOverrides.js\":\"c25977ac1231201b\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/blockActions.js\":\"87d610c11074b24d\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/blockMergeGesture.js\":\"16b6b56151b4e1d8\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/canonicalizeChord.js\":\"147ac3d4a0eb10b7\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/defaultContexts.js\":\"68183b50285c489b\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/defaultShortcuts.js\":\"f58f19a50139399a\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/effectiveActions.js\":\"27e910163bdea11a\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/gestureAction.js\":\"34675720e5e300a3\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/gestureBinding.js\":\"9981d88033417f45\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/holdRegistry.js\":\"58c8c04d0f08ea2f\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/keybindingConflicts.js\":\"c4f7e79903bbafdb\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/keybindingOverrides.js\":\"6a0d42bb3006e5a3\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/pointerAction.js\":\"2382ff3b47f04649\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/resolve.js\":\"13b2183910567d2e\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/runAction.js\":\"42ac475ee0844a91\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/sequenceMatcher.js\":\"596572bcf9a11f9b\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/types.js\":\"682a57b06f90a960\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/useActionContext.js\":\"d9af8077803cf879\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/useActionDiscovery.js\":\"f483c56a70393d0f\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/utils.js\":\"9270a224291be198\",\"/knowledge-medium/pr-preview/pr-1880/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1880/src/sw/bootStore.js\":\"04c29f963ed7aa70\",\"/knowledge-medium/pr-preview/pr-1880/src/sw/previewDatabases.js\":\"5b5c57c6a26bebf6\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/byteTransform.js\":\"5275f8c52053f570\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/attachmentCleaner.js\":\"e11b7ee3d12a10bd\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/attachmentParts.js\":\"371edd6c70702813\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/bundleParts.js\":\"d17e8bc83a939002\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/bundleRecord.js\":\"b03f39361ee4902e\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/manifest.js\":\"9ebd3c4bd5e0e60b\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/takeBundle.js\":\"e81f25f6e179be22\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/verifyBundle.js\":\"fabc62a4c029d16a\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/cleaningStage.js\":\"7c7e48fb6591e7ab\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/conversionKey.js\":\"4298cec83fa149db\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/conversionServer.js\":\"bbd2500509480904\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/flip.js\":\"9fe455e940c96213\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/flipAttempts.js\":\"e236016d5706cbc6\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/pages.js\":\"5dc127c6953895b1\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/preflight.js\":\"3f6252e77e566bf1\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/reseal.js\":\"570a640384f741cd\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/runConversion.js\":\"2e7eaead7771bcbb\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/runLock.js\":\"0dd07846223da3ac\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/sealing.js\":\"af4cb218f718d3de\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/sealingStage.js\":\"e905c713b23674f6\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/stage.js\":\"19d20457fea2812f\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/verifyReseal.js\":\"a56d3595170826ec\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/aad.js\":\"2b72e33a13ae91ff\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/aead.js\":\"d87da0940ceb5f37\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/base32.js\":\"d426b7a0af9ff4db\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/base64url.js\":\"50f5d21a06ebd3a1\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/binaryEnvelope.js\":\"9a15ec7ad5998d45\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/byteAead.js\":\"b544dea0587b45e0\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/canary.js\":\"fdddce46a121ed7b\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/contentHash.js\":\"ac67528f7c24fae0\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/contentKey.js\":\"9b88391113a681e2\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/derivedIdNamespace.js\":\"d30365a0dd387952\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/envelope.js\":\"28d3fe0f289ea369\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/hex.js\":\"c925cd77daaf82cd\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/sha256Hex.js\":\"b85606aef3f0a492\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/workspaceKey.js\":\"1a98f0f6b26bbcb5\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/conversionState.js\":\"91b4aa81f5dfb74a\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/createEncryptedWorkspace.js\":\"1c3e111bdbf1f21a\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/pastedKey.js\":\"c0d10f71b7418a3e\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"52d44163f8c7bc8b\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/upgradeWorkspacePin.js\":\"35a03a0048b30458\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/keyStore.js\":\"e6134026e42a9705\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/mintWorkspaceKey.js\":\"eea591d36a94e5b3\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/modePin.js\":\"444ca2f68b415791\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/openWorkspaceKeys.js\":\"2c18a4d91a6774d7\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/resolveWorkspaceEntry.js\":\"c5786508a2b86b87\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/resolver.js\":\"6914d0da6ffeddd1\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/workspaceAccess.js\":\"6fab270441d00c2d\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/transform.js\":\"f91fbe98453a9cee\",\"/knowledge-medium/pr-preview/pr-1880/src/themeBootDefaults.js\":\"99c2f1e3163a50df\",\"/knowledge-medium/pr-preview/pr-1880/src/types.js\":\"af3788c2b0cb4bca\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/ClientLocalSettings.js\":\"16c4489a31151930\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/abortableSleep.js\":\"19bebca880bf8f5a\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/array.js\":\"2a527025b6aa0c35\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/backlinkAutocomplete.js\":\"7739300104b3e0e9\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/blockCrumbs.js\":\"05905ed63683357d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/blockrefAutocomplete.js\":\"30eb10f0cac40ab5\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/cadencedIdleJob.js\":\"4f12f325f9565729\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/callbackSet.js\":\"fd51c5a30ded6649\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/clientId.js\":\"3c4ff24cabc40b1b\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/codemirror.js\":\"99f4456b8ed0fe5c\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/codemirrorCompletion.js\":\"66b432edc2e769a5\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/copy.js\":\"b6b16ea952192941\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dailyPage.js\":\"c0f736799603b178\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dbForensics.js\":\"c91c0fb03884101d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dbForensicsHooks.js\":\"c0daf4c6f62c463e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/deleteBlockThroughUi.js\":\"a2dd5e0a09049453\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dialogs.js\":\"83687403cc8440a4\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dom.js\":\"d6a28b6d4fba49eb\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/downloadBlob.js\":\"4660aa8416d2e752\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/drawnWalk.js\":\"89d6169a08734218\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/exportSqliteDb.js\":\"14596db3d1b55788\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/fileSystemAccess.js\":\"25d9d78a61468bc6\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/flipSlide.js\":\"4e7f58c911d2277b\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/fnv1a.js\":\"8dfef44d7d0e615f\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/formatBytes.js\":\"e986bc0d4c6aca39\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/fuzzyRank.js\":\"1236dd4ed1b66a79\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/idbKeyedStore.js\":\"5af1b3478d95adec\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/idleCallbackPolyfill.js\":\"aa26e584639107fa\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/keyboardAwareScroll.js\":\"356743dbe55f5d52\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/keyboardViewport.js\":\"844961312f7f37f8\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/lastWorkspace.js\":\"6e7514c6bc51df6c\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/layoutColumns.js\":\"797362909700690a\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/layoutSessionDom.js\":\"162c7aab2e4a75ae\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/layoutSessionId.js\":\"20a2170b541fc194\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/linkClickGestures.js\":\"e6a635a7a975fcb4\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/linkTargetAutocomplete.js\":\"7c817cfb5c917352\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/localDbCorruption.js\":\"3f6ec508cfeb250b\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/localDbRecovery.js\":\"ed3211e07f393c85\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/markdownParser.js\":\"d69627cd972d7a5e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/memoize.js\":\"c08ee51b98f854af\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/nameFieldCommit.js\":\"3610d222e995b994\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/nameList.js\":\"1f93b8a7c2c54774\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/navigation.js\":\"2eb40176525fba92\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/omnilinerNamespace.js\":\"29f6f5af0d45ebda\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/opfsPageScan.js\":\"afdfdbf16ab96382\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelClearance.js\":\"6777dee257d3d093\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelHistory.js\":\"34fe78bafae70139\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelLanes.js\":\"11f112217edaf887\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelLayoutProjection.js\":\"32d6bdacb1540e4f\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelScrollAnchor.js\":\"11e253943b109618\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelUrlFlags.js\":\"8c694ca82c59804e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/platform.js\":\"3290f0ea0a815110\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/pluralize.js\":\"2f5593aa6a0bfff6\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/propertyCreation.js\":\"f8e76bf0771cdc57\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/propertyNavigation.js\":\"0bb439a28ea76d6f\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/propertyValueContext.js\":\"c62bc270755f3f1b\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/react.js\":\"3f08213fc60a84c1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/relativeDate.js\":\"0c34fd7794afb682\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/relativeTime.js\":\"8c22daf30878a6e8\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/renderScope.js\":\"f5f8e05bd64c85cc\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/resolvedThenable.js\":\"bade7013ba5cb260\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/routing.js\":\"6df255cc102f7daf\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/safeMode.js\":\"51007417b30e66e6\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/scheduleIdle.js\":\"71ae57c478cc25b3\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/screenWakeLock.js\":\"e4e3194ac006e9f7\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/selection.js\":\"3bb7cbaf8935e5c9\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/softKeyboardGrab.js\":\"f1cb206b65fa79dd\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/startupTimeline.js\":\"df3481a74ffa0e5c\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/state.js\":\"12981b01280ea2f5\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/string.js\":\"a278717e50e3a2e1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/surfaceZoom.js\":\"2ce9b867f8e30554\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/time.js\":\"664444638e67f513\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/toast.js\":\"7e4176222813e723\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/toggleStore.js\":\"0f3cfb3e2aecb113\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/untilStopped.js\":\"af26fdafbae7828d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/userActivity.js\":\"141f6aeb963ff8ec\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/viewTransition.js\":\"fcc39a775c02eb6d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/viewport.js\":\"2138c0a03f713609\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/webLock.js\":\"bd69606d9d1990bb\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/workspaceRecovery.js\":\"e920a206ee44b445\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/workspaceSnapshotStore.js\":\"47a5de54b8051460\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-compiler-runtime.js\":\"8e59130df03cf988\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-client.js\":\"82209fb0beea8cfb\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-server-edge.js\":\"aca22791a0a2eb44\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-server.js\":\"bbf276968feeb39b\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-static-edge.js\":\"384d75361a4fe550\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-static.js\":\"ed6674d47c6e4cf5\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-test-utils.js\":\"0791a61baab93329\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom.js\":\"96d004ee04b54a89\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-jsx-runtime.js\":\"3bd89e0232e72382\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react.js\":\"f2e989c84b3796d0\",\"/knowledge-medium/pr-preview/pr-1880/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1880/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1880/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
