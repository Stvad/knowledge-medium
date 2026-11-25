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
		buildId: "375c0ae19890-04ce8910",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1880/\":\"5284160419d2ac00\",\"/knowledge-medium/pr-preview/pr-1880/index.html\":\"5284160419d2ac00\",\"/knowledge-medium/pr-preview/pr-1880/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1880/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1880/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1880/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1880/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1880/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1880/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1880/assets/FacadeVFS-CfwOIaBe.js\":\"99973ad93a0ab6a4\",\"/knowledge-medium/pr-preview/pr-1880/assets/OPFSCoopSyncVFS-CGWyHqTt.js\":\"c19da42fffc5a5f8\",\"/knowledge-medium/pr-preview/pr-1880/assets/OPFSWriteAheadVFS-DE7kQUD9.js\":\"774dcaa43a4409b9\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-BMRXrxyP.js\":\"04c74e4277906524\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-async-oSPzL-0G.js\":\"b6db167cabc22d6f\",\"/knowledge-medium/pr-preview/pr-1880/assets/worker-BFjzcqXv.js\":\"adef31055dbeaae5\",\"/knowledge-medium/pr-preview/pr-1880/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1880/chunks/app-C0Os9LLH.js\":\"228ba173861fc1c9\",\"/knowledge-medium/pr-preview/pr-1880/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1880/index.js\":\"0304693bf772fc78\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1880/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1880/assets/AccessHandlePoolVFS-CjRieX9p.js\":\"e94c682b1edc370c\",\"/knowledge-medium/pr-preview/pr-1880/assets/IDBBatchAtomicVFS-KbzNfpmF.js\":\"aa115e545fddd8fd\",\"/knowledge-medium/pr-preview/pr-1880/assets/MemoryVFS-DgvTaVxP.js\":\"78b5975b28904ac1\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-async-CWXr4pAZ.js\":\"f517bf264bab7993\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-shMFXZFp.js\":\"feb6ee6fa0f3b068\",\"/knowledge-medium/pr-preview/pr-1880/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1880/chunks/AccessHandlePoolVFS-8IbBLL2a.js\":\"3a8f09a17ba5bef5\",\"/knowledge-medium/pr-preview/pr-1880/chunks/FacadeVFS-9XbE_Rl1.js\":\"32ff6c0425d7f182\",\"/knowledge-medium/pr-preview/pr-1880/chunks/IDBBatchAtomicVFS-Bqm2Nbkt.js\":\"32aa69a97710792b\",\"/knowledge-medium/pr-preview/pr-1880/chunks/MemoryVFS-DDveZVQb.js\":\"ca8d53643066ba7b\",\"/knowledge-medium/pr-preview/pr-1880/chunks/OPFSCoopSyncVFS-WjpMepPW.js\":\"9756a5c3814556ef\",\"/knowledge-medium/pr-preview/pr-1880/chunks/OPFSWriteAheadVFS-zx1oJcPa.js\":\"76a9524985d1e9ef\",\"/knowledge-medium/pr-preview/pr-1880/chunks/Preview-CKhCiLEK.js\":\"5569af7e82848955\",\"/knowledge-medium/pr-preview/pr-1880/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1880/chunks/card-BglNXGde.js\":\"bb4051eabb9fb493\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dist-5W6yM0fj.js\":\"e71b0a1f65bc69fc\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1880/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1880/chunks/mc-wa-sqlite-C9PNh_BD.js\":\"8cbd5be27858a11c\",\"/knowledge-medium/pr-preview/pr-1880/chunks/mc-wa-sqlite-async-BfItegsD.js\":\"f38bc8aa17473799\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-64kmiGKH.js\":\"6adec497b0cc1da5\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-6AkyQ67u.js\":\"95adf4e53e848f66\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-BXk3vDJs.js\":\"29e1f17b50f209c8\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-Bmt5B4AB.js\":\"11a52a8e55a4ffbc\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-CjJSMvwl.js\":\"ae2c65519e86c2f2\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-D-CIFBUX.js\":\"dd2cb85f7ded2206\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-dom-server-legacy.browser.production-CoZJebkM.js\":\"f2990d2e89c5d277\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-dom-server.browser.production-CMEHX8fF.js\":\"f8fd2f5bdce09cee\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-dom-server.edge.production-BItronZC.js\":\"73f6f4e824cc2fcf\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-mxe2chO0.js\":\"ef193560c9e3cef8\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-uGKFr7GW.js\":\"049d97f2bac0a514\",\"/knowledge-medium/pr-preview/pr-1880/chunks/server.browser-BiO9-bm_.js\":\"a93d872a2801e968\",\"/knowledge-medium/pr-preview/pr-1880/chunks/textarea-Dtjybnkh.js\":\"a26e223339f97045\",\"/knowledge-medium/pr-preview/pr-1880/chunks/ui-YsjDtHhk.js\":\"863010f6c9cee48d\",\"/knowledge-medium/pr-preview/pr-1880/chunks/wa-sqlite-DwcZZiTk.js\":\"dd5ab6256287de95\",\"/knowledge-medium/pr-preview/pr-1880/chunks/wa-sqlite-async-Fu3buZTb.js\":\"b35b1ae066fdf5fa\",\"/knowledge-medium/pr-preview/pr-1880/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1880/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1880/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1880/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1880/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1880/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1880/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1880/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1880/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1880/src/App.js\":\"db7a9dac9c06c5b9\",\"/knowledge-medium/pr-preview/pr-1880/src/appUpdate.js\":\"72ea631d08b0b4e2\",\"/knowledge-medium/pr-preview/pr-1880/src/appVersion.js\":\"a25ae83505c00d8e\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/initialLayout.js\":\"fbaa5d867cc126c3\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/openWorkspaceData.js\":\"98cd85a84bedc5c2\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/resolveWorkspace.js\":\"977fbff560cbeeca\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/workspaceBootstrap.js\":\"92d95cd549b324fa\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockComponent.js\":\"100a930d04c09a89\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockCrumbs.js\":\"3bb751c31ee4d1cd\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockEditor.js\":\"efa272691e01b28d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockLoadingPlaceholder.js\":\"ddd5550cf86e8180\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockProperties.js\":\"6ddd979ce2819502\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockSearchPicker.js\":\"8feb5c7a390c3f72\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ConfirmBulkDeleteDialog.js\":\"e107d4aa1b2a2063\",\"/knowledge-medium/pr-preview/pr-1880/src/components/DividerHandle.js\":\"ef05d8e59aad4ffa\",\"/knowledge-medium/pr-preview/pr-1880/src/components/DraftEditor.js\":\"855c867f40455ace\",\"/knowledge-medium/pr-preview/pr-1880/src/components/GutterPill.js\":\"1f883e7e2dea4f0a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/Header.js\":\"fa87574af99d510e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/LazyBlockComponent.js\":\"c96a979bfff48f24\",\"/knowledge-medium/pr-preview/pr-1880/src/components/Login.js\":\"f758ca9fa522c3ea\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ZoomableSurface.js\":\"33926aa6a30419d4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/editModeKeepalive.js\":\"0ffb88edbf35a2ff\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyDisplay/PropertyDisplayScope.js\":\"bba14521985a5de1\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a934c6a220029ca4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/RefPropertyEditor.js\":\"6aa2426129036f09\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/RefTargetTypePicker.js\":\"d1de9acbd2c55b0a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/SelectPropertyEditor.js\":\"4f1872b346e5a810\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/TypesPropertyEditor.js\":\"be639ab88a6de225\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/defaults.js\":\"ec1701f6787dac11\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/kernelValuePresets.js\":\"356c4dd45e1eea47\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/selectablePresets.js\":\"b5611bbb39850d65\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/typesPropertyUi.js\":\"af3e3178c09f2512\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/AddPropertyForm.js\":\"24b3f65a20ee81c3\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/PropertyPicker.js\":\"adf568a15ffec96a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/PropertyRow.js\":\"269ae16a6e833ab7\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/Rows.js\":\"7ef347feed46c3b7\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/actions.js\":\"460500de2e020831\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/declarationOnly.js\":\"b7de5f78b6834398\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/layout.js\":\"3fef3bac77976cd7\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/model.js\":\"0975493a57ab3688\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/shapeUi.js\":\"6686b5525780973c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/shapes.js\":\"cdbcfbfd0ecbe1f5\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4b4fcbd0b41e3831\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/visibility.js\":\"c0d58c52b3b561a0\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanelSections.js\":\"6f0d7510ccdd1dfe\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/BlockEmbed.js\":\"3f0c2f063df7b8e0\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/BlockLink.js\":\"8fd2d7a2af7f6c7c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/BlockRef.js\":\"d5271bf2c6bf6398\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/ReferenceLink.js\":\"4204201ea70e317c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/cycleGuard.js\":\"84de614f3c6e4cf3\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/cycleGuardContext.js\":\"898d8b4456638d0f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/linkInteraction.js\":\"c8627919e7874c62\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/referenceLayout.js\":\"a23641aa8a8e4b4a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/useBlockRefAncestors.js\":\"067be42ea1d574a4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BlockGutter.js\":\"a48a37f25bd3f23b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BlockInfoDialog.js\":\"4e0c7b965e177bfc\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BlockTypeBlockRenderer.js\":\"cdf896579d04eef2\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BulletHoverCard.js\":\"f7018c42c7973ac7\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/CodeMirrorContentRenderer.js\":\"492de35a3bae550a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5d31f3f1d9772449\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/ColumnResizeHandles.js\":\"ff3ebc7a2929096d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"bd42556917579eff\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/DefaultBlockRenderer.js\":\"f2dbe6a1d67ab921\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/LayoutRenderer.js\":\"c44ff6cf28a4af8d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/MarkdownContentRenderer.js\":\"fe62bac6fdbf6be5\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/MissingDataRenderer.js\":\"b460f32b7244dbd2\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/PanelRenderer.js\":\"a86c243eca47b599\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/PropertySchemaBlockRenderer.js\":\"9d6aaf513a9061a4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/TopLevelRenderer.js\":\"14fb913cf8182d76\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/blockGutterMode.js\":\"b4d415a8e2861ecb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/blockTitleText.js\":\"7064bc14f7e24659\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/fieldCreationKeydown.js\":\"b4f007fb47d27af4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/layoutRootContext.js\":\"fe58d098c4783e2f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/typeChip/TypeChip.js\":\"8a15949998360c50\",\"/knowledge-medium/pr-preview/pr-1880/src/components/typeChip/chipStyle.js\":\"da15b61812d33c22\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/anchored-floating.js\":\"8d300575d3b2ffdf\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/button.js\":\"087876b15806e7ec\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/card.js\":\"485577eeb5ec67d4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/checkbox.js\":\"b36baa9bcfdea455\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/collapsible.js\":\"8af4e0760e47a085\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/command.js\":\"00f12cf846939904\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/context-menu.js\":\"4e2bc5c79f94055a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/dialog.js\":\"bfe05af6d56b9d5b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/dropdown-menu.js\":\"ae432995955a1ec6\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/floating-listbox.js\":\"54fa4f6857daf6fb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/index.js\":\"8a5b265da51bfa55\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/input.js\":\"6c464cafc4b5a558\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/kbd.js\":\"125fb72b6c094383\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/label.js\":\"d760e948c8da589f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/textarea.js\":\"88f6ed1f71ccff60\",\"/knowledge-medium/pr-preview/pr-1880/src/components/useEditModeYieldKeepalive.js\":\"38137f18ff02bfd4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/BootFallback.js\":\"b488a6fc73afe0be\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/FocusedRowLazyMount.js\":\"896bca8aa06eb93f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/LazyViewportMount.js\":\"a01db0184fc7aee3\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/LocalDbCorruptionFallback.js\":\"c4d508aed27a7c82\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/error.js\":\"979bf3dc7446c0fc\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/lazyMountRegistry.js\":\"d3e19d9d203763fc\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/suspense.js\":\"02239b46858bfc4c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/CreateWorkspaceDialog.js\":\"85d478909dbdb0ed\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/PendingInvitations.js\":\"383e2aa732f98df5\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/SyncProgress.js\":\"ee656ee355373dfb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/UnlockProgress.js\":\"d05463ebea8ddd7a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceKeyGate.js\":\"0d66d388d2610153\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceSettingsDialog.js\":\"3cbda80a0ff64a61\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceSwitcher.js\":\"e89e08971366612b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceSyncGate.js\":\"3728bba0791e9c6c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/ConversionFlow.js\":\"b590ab1774b81c46\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/ConversionFlowHost.js\":\"f7e744da20371719\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/EncryptionSection.js\":\"41aa1c90a5f3dc1f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/attachmentPrompts.js\":\"18978d32ebbd42d9\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6cddec27dab3427f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/conversionFlowDeps.js\":\"ffb10456dc2f1276\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/conversionFlowStore.js\":\"c231571561a662b6\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/flowUi.js\":\"2b0dce20697f7713\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/useConversionRun.js\":\"150a4db3d7a8c033\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/keyUi.js\":\"b8f5ccc2ba16dc0b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/useCloseOnKeyLoss.js\":\"19385efa30c228cf\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/useCloseOnServerE2ee.js\":\"5e96b9a9fe25c785\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/workspaceUnlocked.js\":\"64ac1686973274d6\",\"/knowledge-medium/pr-preview/pr-1880/src/context/backgroundSubtree.js\":\"dbc5a69b143942b7\",\"/knowledge-medium/pr-preview/pr-1880/src/context/block.js\":\"c5790efe6d2672a7\",\"/knowledge-medium/pr-preview/pr-1880/src/context/layoutWsContext.js\":\"55905c8339a7137f\",\"/knowledge-medium/pr-preview/pr-1880/src/context/propertyDisplay.js\":\"ea0986b8b8f2a039\",\"/knowledge-medium/pr-preview/pr-1880/src/context/repo.js\":\"b754e23885060543\",\"/knowledge-medium/pr-preview/pr-1880/src/data/aliasClaim.js\":\"e03d26f9440fb0f4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/aliasSeatNamespace.js\":\"419f61b8deb8e4ef\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/blockData.js\":\"ea6ca991ba913a1e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/blockType.js\":\"d1c10e13220dd36f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/changeScope.js\":\"16bfd12de0aed6b8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/codecs.js\":\"4e15cdb9c38c304a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/derivedData.js\":\"2047ff7d8050d218\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/errors.js\":\"0f6d0a50ecd08266\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/events.js\":\"c01c150c970fe8ae\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/handle.js\":\"bce6898864260956\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/index.js\":\"51781c4bd055a25e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/mutator.js\":\"9963accda28dcefe\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/processor.js\":\"b54205410da1eac9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/propertySchema.js\":\"5a7c1ba4b6fa4fdf\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/query.js\":\"a7f3d13daba887b0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/sameTxProcessor.js\":\"576e32267da7c1b6\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/schema.js\":\"bce6898864260956\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/tx.js\":\"bce6898864260956\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/typedBlockQuery.js\":\"a0bae86de98a0424\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/user.js\":\"bbb64371a43a2f2b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/valuePresetCore.js\":\"22e82e848c1c4b71\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/valuePresets.js\":\"a86f32f42e0ed9af\",\"/knowledge-medium/pr-preview/pr-1880/src/data/attachmentCleanerIOVerb.js\":\"0f7c92350404c2c3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/block.js\":\"04fc8822d3cbbf30\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockCache.js\":\"cdfafff597e1af32\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockId.js\":\"af70aa2ede416211\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockLiveness.js\":\"f88d09d6cff9855e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockMerge.js\":\"c1477f4f7f40f38f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockSchema.js\":\"9b0faa038a5e6812\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockTypeLookup.js\":\"d639ff85b2eabae8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockTypes.js\":\"18850104e98fcd71\",\"/knowledge-medium/pr-preview/pr-1880/src/data/childrenView.js\":\"a5cab63bea445ecd\",\"/knowledge-medium/pr-preview/pr-1880/src/data/clientContext.js\":\"3185f397a65f862b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/dbFileSiblings.js\":\"dd91319610e85607\",\"/knowledge-medium/pr-preview/pr-1880/src/data/definitionSeeds.js\":\"70ae3972b4c55359\",\"/knowledge-medium/pr-preview/pr-1880/src/data/derivedIds.js\":\"50b29ed4444d0373\",\"/knowledge-medium/pr-preview/pr-1880/src/data/drawnSubtree.js\":\"e4556def2e827423\",\"/knowledge-medium/pr-preview/pr-1880/src/data/facetBridge.js\":\"11ce4d6d332606c2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/facets.js\":\"06c68b5102888313\",\"/knowledge-medium/pr-preview/pr-1880/src/data/globalState.js\":\"2b8fd7783cc99de7\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/aliasClaimRederiveProcessor.js\":\"aacc4d9d09dd89d5\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/ancestorBatch.js\":\"f8bf634f51070c78\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/blockTypeTypeifyProcessor.js\":\"bdc2695082dbb3a4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/clientSchema.js\":\"7a5dc4209196c330\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/commitPipeline.js\":\"4c9ee5b5a8ef98ee\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/devAssertions.js\":\"489d275c0a624fde\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/firstSync.js\":\"dbf7327eafe443f7\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/freshInitialLoad.js\":\"0dde6600d71f2334\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/graphBackfillClaim.js\":\"2e01f4b59eca418e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/handleStore.js\":\"6252fdb0636df4a3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/idleMarkerJobs.js\":\"d6a52880aa8a5afb\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/initialDownload.js\":\"03956c07dbf253d6\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/initializeClientDatabase.js\":\"dd4fecaec0640de1\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/jsonCanonical.js\":\"48d24601741c78d2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/kernelInvalidation.js\":\"5c42b11db2db0b20\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/kernelProcessors.js\":\"912f16055802c058\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/kernelQueries.js\":\"900797d173922cff\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/mergeTypeMembershipProcessor.js\":\"7877f2ba53e099f3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/normalizeReferencesProcessor.js\":\"278cde3fe97bc009\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/poolInstrumentation.js\":\"8c6aed334a33a55a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/processorRunner.js\":\"99216aa2d46fa0fa\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyCellBackfill.js\":\"29478bc056e68d90\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyChildMint.js\":\"75e465d6e080bbd9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyChildrenProcessor.js\":\"d739efab43cdb339\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f00c767dfb3ddaca\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyDefinitionSynthesis.js\":\"c49fe7fd070f4a4d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyKeyScan.js\":\"6e3ab214e2b48ad6\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertySchemaResolution.js\":\"3763b6b61f494d8f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyValueEdits.js\":\"d70a419e992073db\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/raiseProtocol.js\":\"d70cba69945c3bc3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/readBatch.js\":\"0088d708bb2d3175\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/refProjection.js\":\"6340936bb66ec514\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/referenceTargetLookups.js\":\"0dda7965b96d86e9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/referenceTargetProcessor.js\":\"a096a0367b50aec2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/replayMerge.js\":\"4e9219c3183a2ef2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/sqlBinds.js\":\"61d8b968522fed5c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"624e403a51c46c27\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/arrivalProcessors.js\":\"175793a218a15bd2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/invalidate.js\":\"c8a7e0a5805d8d4d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/materialize.js\":\"d4e9291319d516bd\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/observer.js\":\"abed0623f31af51e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/reconcile.js\":\"56f98d6f76f6662b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/timingMetrics.js\":\"192074cb3dfde620\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/treeQueries.js\":\"0ba20f3b96571bd2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/txEngine.js\":\"3cb596fff63744a9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/txSnapshots.js\":\"aa57a480e2ca5e40\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/typedBlockQuery.js\":\"460a596d3ce2ae5c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/undoManager.js\":\"6b4aea3e0306044a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/invalidation.js\":\"d322282a4554afac\",\"/knowledge-medium/pr-preview/pr-1880/src/data/kernelDataExtension.js\":\"5797bf75af09c835\",\"/knowledge-medium/pr-preview/pr-1880/src/data/kernelPage.js\":\"3e9050346ef445d6\",\"/knowledge-medium/pr-preview/pr-1880/src/data/kernelValuePresetCores.js\":\"573e881de15d5da0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localDbCorruptionSignal.js\":\"37dccb7246b40035\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localDbStorage.js\":\"04658928e0335237\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localDbVfs.js\":\"4cd1375eade81189\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localSchema.js\":\"899f1a3a9d460277\",\"/knowledge-medium/pr-preview/pr-1880/src/data/maintenance.js\":\"db9e0695169dbb6d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/mergeProperties.js\":\"c5fffd4347a1e64a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/metricsConsoleHook.js\":\"31ab638aca14d05b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/migrationsPage.js\":\"6fe99aec8af64d59\",\"/knowledge-medium/pr-preview/pr-1880/src/data/mutators.js\":\"82cbabd031f9912f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/orderKey.js\":\"1b87ccf21bbbbcb2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/orderKeyPlacement.js\":\"4765d678192cde2f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/outlineSurface.js\":\"9987ea829d486d39\",\"/knowledge-medium/pr-preview/pr-1880/src/data/pendingEditorContent.js\":\"9c089f8e80e2c76f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/pendingUploadsSql.js\":\"15fefd5d9569909c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/pluginStateExtensions.js\":\"843d2d6fecd82822\",\"/knowledge-medium/pr-preview/pr-1880/src/data/powerSyncLogger.js\":\"92bbc8626aca6477\",\"/knowledge-medium/pr-preview/pr-1880/src/data/projectorRuntime.js\":\"847466972643e6eb\",\"/knowledge-medium/pr-preview/pr-1880/src/data/properties.js\":\"53b050ffca38e356\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertiesPage.js\":\"db7a03b4d5b71db9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyChildren.js\":\"0fc4e41e1c8b315d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDefinitionFanout.js\":\"9b226e23dcb85092\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDefinitionMetadata.js\":\"d166ceb77c7b7ae6\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDefinitionRegistry.js\":\"e20a0c3c939f6dc9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDisplayMode.js\":\"d45b486c575b9551\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyRowCreation.js\":\"35c685c6a546635c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertySchemaCreation.js\":\"1d63bea111cb35a4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertySeeds.js\":\"358be62e879b5965\",\"/knowledge-medium/pr-preview/pr-1880/src/data/recentsPage.js\":\"2c804831edd1851c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/referenceBlock.js\":\"106f81484fa4b016\",\"/knowledge-medium/pr-preview/pr-1880/src/data/rejectedUploads.js\":\"fe124f77e08cdbc9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/releasePowerSyncConnection.js\":\"17c69ae8c7ea6419\",\"/knowledge-medium/pr-preview/pr-1880/src/data/repo.js\":\"ac06e0267c549889\",\"/knowledge-medium/pr-preview/pr-1880/src/data/repoProvider.js\":\"3bb63ccdc3f79b94\",\"/knowledge-medium/pr-preview/pr-1880/src/data/rowProperty.js\":\"606ee2a0f37082b3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/searchFilter.js\":\"bab4365e2d2c20e9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/seedIdentityLedger.js\":\"f5b61a6759c00566\",\"/knowledge-medium/pr-preview/pr-1880/src/data/stateBlocks.js\":\"2f9ba77cb9c55f34\",\"/knowledge-medium/pr-preview/pr-1880/src/data/structuralEditPolicy.js\":\"040c4458a6748d01\",\"/knowledge-medium/pr-preview/pr-1880/src/data/structuralInsert.js\":\"ce68b57e76c52c7f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/subtreeDelete.js\":\"790621934f88a269\",\"/knowledge-medium/pr-preview/pr-1880/src/data/syncStreamLock.js\":\"b0f35722b36cfe16\",\"/knowledge-medium/pr-preview/pr-1880/src/data/syncedTableSqlRecognizer.js\":\"ec5dc6521d5624bf\",\"/knowledge-medium/pr-preview/pr-1880/src/data/syncedTableWriteGuard.js\":\"787bac9182625065\",\"/knowledge-medium/pr-preview/pr-1880/src/data/targets.js\":\"9c7f86ead20c7d33\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeColors.js\":\"0bda08ff53128be2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeDefinitionMetadata.js\":\"48793e7c1647f5f9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeDefinitionRegistry.js\":\"db8665a780f30d8f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeExtraction.js\":\"be3192e2c9285531\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeInitialValues.js\":\"606db0d605505006\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typePropertyGroups.js\":\"4b2ec246a15fef92\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeSeeds.js\":\"ba663afdf4c2ee38\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeTagger.js\":\"fb731ad7cc97f2da\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typedRecords.js\":\"13104eba4041c36f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typesPage.js\":\"e7c3518fb434f1a2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/userPrefs.js\":\"f3055822b0243625\",\"/knowledge-medium/pr-preview/pr-1880/src/data/userSchemasService.js\":\"7a96898e00687f90\",\"/knowledge-medium/pr-preview/pr-1880/src/data/userTypesService.js\":\"110f7dddd3f5ec06\",\"/knowledge-medium/pr-preview/pr-1880/src/data/valuePresetRegistry.js\":\"03bcd151b3296765\",\"/knowledge-medium/pr-preview/pr-1880/src/data/visibleChildren.js\":\"ee290381b103b1ff\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceConversion.js\":\"a562ca28274f2356\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceFirstSync.js\":\"8b4c286e2807edbb\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceIdNamespace.js\":\"6a324a98dd6acd8f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceSchema.js\":\"3adc5aa13f9d93ba\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaces.js\":\"232d72b29fa382e7\",\"/knowledge-medium/pr-preview/pr-1880/src/data/writeAheadLog.js\":\"a1cb83a9213bb11f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/BlockPasteShellDecorator.js\":\"3622ce2346937ba4\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/atTrigger.js\":\"5e2f911aebc041e9\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/autocomplete.js\":\"a5efbdb65df912c2\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/codeMirrorExtensions.js\":\"fea112e34aa2e5c3\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/contentFlush.js\":\"d8ffc006f7d6d063\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/defaultInteractions.js\":\"ff9aefc264cad176\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/editSettleSignal.js\":\"5667fb1c07ba9029\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/insertImage.js\":\"259fa3ba83a1e60d\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/referenceCompletionRange.js\":\"aeef47b3f717a3fc\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/referenceTargetTypes.js\":\"24fe5b2631838c81\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/syntaxContext.js\":\"169a365d24f97438\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/triggerMatch.js\":\"a7af8f95e991f846\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/AppRuntimeProvider.js\":\"5733af5c03bbdbf1\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/BlockFocusShellDecorator.js\":\"3fee61d3e5bc4e67\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/ExtensionRenderBoundary.js\":\"3cb85dc1c1a1827d\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/PanelContentRecovery.js\":\"68f9a1967e356ba4\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/apiCatalog.js\":\"afa81600ab36c64f\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/approveExtensionHere.js\":\"d3d370718e8bd4ec\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/armedCutAppMount.js\":\"011e47e3c84dfc22\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/batchableKeyedStore.js\":\"f331defaa944dab1\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/blockInteraction.js\":\"99edfcfaef8400a5\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/blockSelectionAction.js\":\"47535903dfef9b76\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/compileExtensionModule.js\":\"dde8cbed875fcfce\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/compiledModuleCache.js\":\"b201a1cdf0007172\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/continuousGestures.js\":\"2ecc3a152adf36ad\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/core.js\":\"66682ea4ad01f1bf\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/defaultRenderers.js\":\"e1d77e6ff7097c39\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/definitionFanoutAppMount.js\":\"39b9d7695a86c852\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/dialogAppMount.js\":\"901e17f7a04e50c0\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/dynamicExtensionSeeds.js\":\"a13989955ca14e71\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/dynamicExtensions.js\":\"e541f2011645fddf\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/exampleExtensions.js\":\"cdf697c7e72fd808\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionApprovalStatus.js\":\"2a527825ae83d716\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionLoadErrorToast.js\":\"f4cf633d1537347b\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionLoadErrors.js\":\"de0cf853f1b24231\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionLookup.js\":\"f074344214c83b09\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionToggles.js\":\"590fb589436ee1ba\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionUtilitiesCss.js\":\"0f4cfb2bf7f6902f\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/kernelPageDeletionGuard.js\":\"80d9216eb44076a2\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/liveRuntime.js\":\"4d6e2a7463d14816\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/openExtensionsSettings.js\":\"2cba816d61d219ca\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/overridesCache.js\":\"8f15a07ff8c9c9f9\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/pluginIds.js\":\"78abe6dc092fa58e\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/processorRejectionToast.js\":\"c8789d06a329b4a4\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/runtimeActions.js\":\"a4bb93256400f86f\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/runtimeContext.js\":\"5f3dcba02d36fe9a\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/staticAppExtensions.js\":\"82479703741594c9\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/staticDataExtensions.js\":\"113307d1b3250997\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/toastAppMount.js\":\"1a8b396815c719bd\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/useOverrides.js\":\"f6fe89670990524b\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/useShortcutSurfaceActivations.js\":\"b3a9e92da0f6ce7c\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/discoverToggleTree.js\":\"4ebeb2c0cd3bf759\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/facet.js\":\"ba75e5db5ac2a305\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/resolveAppRuntime.js\":\"10a1c2aba8d379af\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/runtimeEvents.js\":\"31e96515afe897f7\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/togglable.js\":\"58c375968cd570a0\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/variantFacet.js\":\"4fc58867cb9a2739\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/verbFacet.js\":\"57ce5773775d1c01\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/block.js\":\"8f5932fdc3a59a7f\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/focusedChild.js\":\"61dbcde2b651c95d\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/propertySchemas.js\":\"27ab9114d5240587\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/typeRegistry.js\":\"c4d3b0838f064e5a\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useAncestorCrumbs.js\":\"dc3814c51332e34c\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useAutocompleteListbox.js\":\"f1b082e5ccc3be0c\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useDebouncedSearch.js\":\"ec570a013a48fecf\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useDebouncedValue.js\":\"086ec1c0693c04fe\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useIsFocalRender.js\":\"53d580c44df3ef4d\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useIsReadOnly.js\":\"f1dd48b17ad51433\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useMaterializeBacklog.js\":\"13d5726bcb660117\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useMinuteClock.js\":\"b3fb90e0deaad0d6\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/usePanelLayoutProjection.js\":\"cce0e6064d6cd486\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/usePendingInvitations.js\":\"0c7b323f68760beb\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useRendererRegistry.js\":\"420b816ac2d47153\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useRetainedFieldRows.js\":\"47a38917ebe7705e\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useWorkspaces.js\":\"c0a2dd9d0ea78be6\",\"/knowledge-medium/pr-preview/pr-1880/src/lib/utils.js\":\"363922c2ed81fa3d\",\"/knowledge-medium/pr-preview/pr-1880/src/main.js\":\"ffa5887bf10a1334\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/MarkdownImage.js\":\"1e8dfe323b5d3f34\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/blockSeparators.js\":\"0ad94067b13e6e8e\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/context.js\":\"0606717d06ab60a2\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/defaultMarkdownExtension.js\":\"c5ef3a445e2887eb\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/extensions.js\":\"d3a7baef954a23a5\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/renderMarkdownHtml.js\":\"2665ea915569ab1e\",\"/knowledge-medium/pr-preview/pr-1880/src/minimal-editor.js\":\"da8410a262e5d22e\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/armedCut.js\":\"1e92f1683d82cfa8\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/captureMediaVerb.js\":\"5449fc7da65a635f\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/clipboard.js\":\"c819818f5f3b8e1c\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/decision.js\":\"2d032c1d228fa3e8\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/operations.js\":\"9456293eb27861de\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/account-header/AccountHeaderItem.js\":\"952c1ce77f57efee\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/account-header/index.js\":\"18c7c52a630daf2e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"abf7de7a2887caa6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/askAgent.js\":\"04f591de47a9fa21\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/askedStore.js\":\"bc63d25b2c4f8065\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"50ffb7d5ecf0c3c0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/chipState.js\":\"882bb914bc65e310\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/dataExtension.js\":\"205f6a2a81ca1c1b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/index.js\":\"586fe1fbbb889d4e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7e71a5fcee23eabc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/schema.js\":\"09f350637b8638f1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/AgentTokensDialog.js\":\"2239848c94706547\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/BridgePairingDialog.js\":\"31cec37e6b45c80e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/addMedia.js\":\"72f1a80365aa2cc0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/backlinks.js\":\"03ae557bead161c5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/block.js\":\"d12250fd69a44309\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/context.js\":\"c84b04c6c09ba01b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/displayIds.js\":\"64485e0108002645\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/index.js\":\"112f4be561e77ddd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/outline.js\":\"234226f636333ffd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/properties.js\":\"95d5b30316ef32cc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/refs.js\":\"30d8ba48c39f23ba\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"0433d2f05af3f66c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/search.js\":\"8bdba6a8f7262850\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/shared.js\":\"9d866f3b72e3d8cf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3961f91912d301e3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/text.js\":\"75f9d7cea28be3b1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentWrites.js\":\"4bc1fb2c20bcf384\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/authoringCatalog.js\":\"7ca14f6cd5f29977\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/blockRefTargets.js\":\"a48076b40e2a8fb9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/bridge.js\":\"2e369ee653e50535\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/bridgeLoop.js\":\"abef6e9384734595\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/changeHistory.js\":\"d33b6c2673c728c2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/commands.js\":\"c1fe42a3c6fb1e57\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/commentsCommands.js\":\"b8d1216cf7a14d96\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/dataExtension.js\":\"2773e78c38f69988\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/dataModelGuide.js\":\"fd9f00732e60b9c4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/dayPropertyInputs.js\":\"342f696783ed8521\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/describeRuntime.js\":\"408d0a04e3f47dfd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/extensionLint.js\":\"a2e5862fc751905a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/grainAudit.js\":\"a8526074f0ba21ad\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/healthCommand.js\":\"ceef1b39a0a445cb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/index.js\":\"74c0ae7497e706c6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/presetIdentity.js\":\"d407a22de84e17cd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"6aa347030a12b0eb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/readMedia.js\":\"adbed84fe53469b3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/schema.js\":\"b8e6c02851656148\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/serialization.js\":\"0c230bc378cd6117\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/targets.js\":\"82f1f0d3a3dbb1a9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/tokens.js\":\"05c0ff18777b4be5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/watchEvents.js\":\"86652b921997d662\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/workspaceGuard.js\":\"59c783c7122ec8a8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/writeCommands.js\":\"7f65e499ab6332f8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/AliasCollisionToast.js\":\"72acbe406aa503d5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/DuplicateNameBanner.js\":\"0f09595bb734511a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/collisionMerge.js\":\"95b7e1697bfdff26\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/dataExtension.js\":\"efaf0c002348b0df\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/index.js\":\"efa7d52a4bee3da6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/mergeCollisionAction.js\":\"7a8993fb06d08e90\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/pageStyling.js\":\"f3d746e0830fca95\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/rejectionToast.js\":\"163866237ea425f1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/syncProcessor.js\":\"a50d68a7f17779b6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/actions.js\":\"f0b0b1008b553aa9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/addComment.js\":\"33830683232b82df\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/anchor.js\":\"35a73f85823da34a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/anchorState.js\":\"d5ddd11eef1194ce\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/commentLinks.js\":\"c165a63e9f1062d4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/confirmThreadDeletion.js\":\"0b6a61f1231bd9c6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/container.js\":\"3cbea001a1b1a889\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/dataExtension.js\":\"57014d59875fcaf2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/deleteComment.js\":\"7949f24c0d75b95f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/highlights.js\":\"0bbd6650d510cea3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/index.js\":\"f740faaf9b438470\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/linkedCommentsPill.js\":\"cb0034b80c97161e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/margin.js\":\"5905a5e3b31c7b1d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/marginAnchorLinks.js\":\"57da275c68706939\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/marginSchema.js\":\"ed9b72ec3d7d288c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/newComment.js\":\"d247f8700eb97e40\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/ownThreadPicker.js\":\"948837a66397f558\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/placement.js\":\"abc9701ce8edf0e3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/queries.js\":\"f98c5566468ffa75\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/quotePosition.js\":\"3c311e4af949d7bd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/quotedIn.js\":\"9054ba5d92d45213\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/quotedRange.js\":\"5d4a9d7e154eb277\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/rangeRefs.js\":\"3ded9490e7d78db3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/readHighlights.js\":\"f48e53238f407682\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/readSelection.js\":\"39bd68efa52a92ca\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/readSelectionUi.js\":\"1b86dda18f4097b5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/reanchor.js\":\"c2f51e0cb4900794\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/schema.js\":\"b4d47322a9a67254\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/scope.js\":\"3b4178433217d177\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/scopeThreads.js\":\"59baa2a854b15183\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/splitRetarget.js\":\"b208e7cd86c3e8b2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/suggestionCard.js\":\"ecc20a81f320bf7b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/suggestions.js\":\"3b788b4635a95041\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/summaries.js\":\"85d4e99d390da314\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/summaryBatch.js\":\"2f966d54e5405377\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/surface.js\":\"dbdef568decba3a0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/threadNavigation.js\":\"c138c4d607d8c5ed\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/threads.js\":\"7ac60bc963d1f623\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/ui.js\":\"12f6b27b92bff01d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/uiStore.js\":\"fdf8f1f771972028\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-intents/appIntents.js\":\"94e453f567d86fd9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-intents/index.js\":\"f6215e3728099a02\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-update-prompt/index.js\":\"c1df620dbad37380\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-update-prompt/status.js\":\"3b0729b3571996df\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"0341d1c5633a21b1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/MediaBlockRenderer.js\":\"9fc88ba0f72a62b3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ff57ebccef78c463\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/MediaUploadReconciler.js\":\"ab276b86dfc94ac6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/assetDownLane.js\":\"f5f6b5431d9f728d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/assetResolver.js\":\"6b6f57bd3b5bb0f4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/assetUpload.js\":\"bf987a13f80bdd26\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/attachmentCleanerIO.js\":\"eec185c231c71ce3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/supabaseAuditIO.js\":\"5e09dcf8bc859d24\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/blobStore.js\":\"afb14d5fb0a7748a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/browserMedia.js\":\"b93c3cf63b52ebb4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/byteStore.js\":\"e2da359491a5556b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/cleanerIO.js\":\"32052486da7f3431\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/cleanupAttachments.js\":\"763b2f477d1830a5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/dataExtension.js\":\"6998591e6d9bf8c2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/downLane.js\":\"a75895637bc49463\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/index.js\":\"14ba25cebc72119e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/insertImageContribution.js\":\"2997ecbb52300b0d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/laneArming.js\":\"70f7fd78e08598d3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/laneLock.js\":\"f10a11fd9eff120e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaBlock.js\":\"db8f618ff8168f2d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaCapture.js\":\"4aa4a6cd31aab5a5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaLanes.js\":\"2a98da29bbc58967\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaViewers.js\":\"ea0a96fcbb736d43\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaViewersFacet.js\":\"da0a5738aef7ac9d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/pasteCapture.js\":\"a8a7fe3e9fb13505\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/resolver.js\":\"2c7e55fc4e8649d7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/retryUploadsAction.js\":\"a8e963b07ec71a8e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/storagePaths.js\":\"3b056c1179161df7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadDrain.js\":\"66b7382b7a1ed4a3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadLaneStatus.js\":\"3e87b94c2d177f0d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadReconcile.js\":\"e9ec403a9872b2b9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadRecovery.js\":\"7a7944743f98eb99\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadStore.js\":\"5dbf191d223f7f08\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/useAssetObjectUrl.js\":\"344d1563a3b56ffb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"e504370305aabd46\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/BacklinksViewSection.js\":\"0a08013d06e0cdcf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/facet.js\":\"c2ec908e2129a6c1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/index.js\":\"6a904f5d3aaac89a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/prop.js\":\"66e79a2ef20d52be\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/BacklinkFilters.js\":\"bd2cac0cb7b6da63\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"dac326e5ce9b6123\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/BlockEntry.js\":\"f14c485735ac1e1c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/LinkedReferences.js\":\"f8929437070e03f8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"7ceb7573adfebb1b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/dailyNoteDefaults.js\":\"581530c981e6db8d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/dataExtension.js\":\"7d9fd99c0fb12da4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/edgeExclusions.js\":\"0005c516ec131acd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/filterProperty.js\":\"3e97a6f6fad6ea4a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/index.js\":\"d6153ee9d2e18a3f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"97bebb7f50d4168c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/applies.js\":\"148a4a204aa4d0f6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/countQuery.js\":\"4215b146bca37fcf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/expansionStore.js\":\"5a6c943b0e3b3850\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/index.js\":\"cda96f3b4800a083\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d9231756e8187219\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/presentationInvalidation.js\":\"337f99206e827ad9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/propertyEditorOverride.js\":\"3627fcdc979dbec2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/propertyFilter.js\":\"ec7d39ff1a60d9a6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/query.js\":\"b505017fb915b527\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/resolveFilter.js\":\"07472c99c08f2b23\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/sourceBatch.js\":\"3049ae940b078296\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/sources.js\":\"594bc77435961985\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/useBacklinks.js\":\"12750667eca2f0f7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d07bf5838cccca1d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/BirthdayCelebration.js\":\"65b5118d22451bea\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/BirthdayOverlay.js\":\"c99bb57ca2ea4135\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/gate.js\":\"90d93d3f92086218\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/index.js\":\"6964e840392e292b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/wolfTheme.js\":\"596d7ee22717aa51\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/BlockDragLayer.js\":\"e3474af531c43dbf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/dragController.js\":\"acd39795d0f199a7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/dropTarget.js\":\"3c1104887fcddc85\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/index.js\":\"4c2c5412161d6f26\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/projection.js\":\"9d8cd33b2f3c5cde\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-info/BlockMetaCard.js\":\"6d73be589d4477b6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-info/index.js\":\"3e89865cca151db4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/AddTagDialog.js\":\"8fe97544c33601eb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a0a15f38094a21d4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/TagNameIssueHint.js\":\"8f2110a0e1bde6bb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/addTagAction.js\":\"23366bf889856a89\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/appendTag.js\":\"765bbff64c816ffd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/config.js\":\"8c2f2593eb4f1611\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/dataExtension.js\":\"046ad9335e7ac887\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/index.js\":\"dc82115bfc71ec3d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/propertyEditorOverride.js\":\"701a3c549c25af73\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/BreadcrumbList.js\":\"7c79a4c4eb00134a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a9411a2d2c0bd2c5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a6b894993692c6a6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"3598b7218a8b20dd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"5ccfa1ed181e94f1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/index.js\":\"ead468db8b26d877\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"762f216a22a28dd1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/CharacterCountItem.js\":\"493f3ef7e3b3cf7e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/ProfilePropertyEditor.js\":\"cba358679707478c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/actions.js\":\"1b103cf29124902b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/blockType.js\":\"1225921245ac334b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/charCount.js\":\"bd24103faf5cbf74\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/dataExtension.js\":\"8182d2d7a3c07b9f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/index.js\":\"1f3720b8b985c518\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/profiles.js\":\"d437efd560b9e9b5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/properties.js\":\"496e3c5f182f3f29\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/textCounts.js\":\"94a89b1d689e2d4a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/colemak-keybindings/index.js\":\"f713a1f60e535620\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/CommandPalette.js\":\"161066798c42576f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/HeaderItem.js\":\"9dc1a2cb5f15c983\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/context.js\":\"4ad8909c81c53a27\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/index.js\":\"b9549e8cb6489f96\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/selection.js\":\"b6d36809abb77d77\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/toggleStore.js\":\"a96e9e8bf194eb19\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/useCommandPaletteActions.js\":\"317cb68152d81439\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/ContributorBadges.js\":\"b1f87b3064c8f3a2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/author.js\":\"06ffdc523441e574\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/codeMirrorExtensions.js\":\"6ab592cceb3dc1d5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/dataExtension.js\":\"7794a2d2a36fd99a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/index.js\":\"f2b85b19ee23f962\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/mentionAutocomplete.js\":\"6b639f03dd2b46d6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/processor.js\":\"fee19e6bd03aba66\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/profiles.js\":\"210b40c84fbdf727\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/queries.js\":\"f8887c84028ce237\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/schema.js\":\"c7288216d185feae\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"58fa43a80a544aa6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/followOrigin.js\":\"82d0d2e6b0ab8a72\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/index.js\":\"9db95e10489652b0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"404ad8d49b1dd72e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d1d5e171e446a2f2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/CalendarGrid.js\":\"f0069db2258bb3e1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DailyNotePicker.js\":\"bbbeae142d109af1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"76f4fcc8e18c9694\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DateNavDecorator.js\":\"241afb369db6f2da\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DateScrubOverlay.js\":\"9c5434a484dd04c1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DayPropertyEditor.js\":\"93d33af961b8337b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/HeaderItem.js\":\"43e96c7b502aea57\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/ReschedulePicker.js\":\"58b18185fb78c360\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/SpreadDatesDialog.js\":\"700494a6ff2502e7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/actions.js\":\"1b1d2a4c1259541a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/blockDateAdapter.js\":\"e26569c2545c8cfc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/calendar.js\":\"5abfdbe145c41757\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dailyNotes.js\":\"540a1a6f2c892e70\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dataExtension.js\":\"643f67bfb099c373\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubActions.js\":\"a56733f3da9f9498\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubGesture.js\":\"9cacbbac32004cb8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubGestureActions.js\":\"ccf400dbfb33edf4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ea0446c7f6d2d727\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dayProperty.js\":\"1c22583d6065bd62\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/deletionGuard.js\":\"7bbe2b5181cf8bcf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dueQuery.js\":\"f29bea42cff936c3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/index.js\":\"1cd09dd52a0312c0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/landing.js\":\"fb5ca9fc2b3c894b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/localSchema.js\":\"380f3be1cf092c0c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/referenceDateAdapter.js\":\"b8a9ece01dc8c62b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/rescheduleAction.js\":\"bd74186d55831bcb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/schema.js\":\"906cf61dd67a89ec\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/spreadBlockDates.js\":\"c1c6492fe5924a6d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/spreadDatesAction.js\":\"ea03d950fb109572\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/today.js\":\"7d8d19094e0466d2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"85a10f053d0a4cb8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"85e78cc067f0718c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/audit.js\":\"f0a4c3cca80b33d1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/auditAction.js\":\"122f975d93527ac8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/auditRanges.js\":\"55515a9b66cbc327\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/diagnosticsSource.js\":\"1fc689b4f255d7c6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/divergenceScan.js\":\"d5128f5e7c64414e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/index.js\":\"5414785a0e45a148\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/propertyChildrenChecks.js\":\"f02bfb8d6e1f366b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/referencesMirror.js\":\"6683cefcbd454550\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/rowJson.js\":\"a9913fd9b5f1f342\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/schedule.js\":\"1aef778208657aec\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/store.js\":\"4e81843feb8f682c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-maintenance/action.js\":\"75b6d06db584d715\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-maintenance/index.js\":\"c865dd0cfff7acb6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-maintenance/plugin.js\":\"caa2b9ff7d6d8d66\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"938af576d3810bef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/actions.js\":\"7ab716a83a5528a3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/changeMarker.js\":\"98202fe3f3034b5c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/diagnostics.js\":\"f175cd8ad8798c6c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/fileSystemAccess.js\":\"b842402bd69f0ffd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/filenames.js\":\"e7e437f98ae7f80c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/index.js\":\"97999a20c10eb375\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/mirror.js\":\"ae1018c1c9fc82a3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/runLock.js\":\"ba6cc9706ff14d77\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/runtimeHealth.js\":\"de6e0585629a2b22\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/schedule.js\":\"80f94c70c0e22e7b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/store.js\":\"50f00742b918e13c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/default-themes/index.js\":\"986956e8c2fc50bb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/default-themes/themes.js\":\"fc819a0458ad76cf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/diagnostics/facet.js\":\"48a5a687052168cc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/diagnostics/useDiagnostics.js\":\"32f344e05364899c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/dismissals.js\":\"08f302c8046d20fd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/index.js\":\"5c6a1447edff9fed\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/status.js\":\"00ee7c179eb09703\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/store.js\":\"b4724e2830d6a44b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"cf34245756a41f02\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/ExtensionsSettings.js\":\"bafc969a34f8c44e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/actions.js\":\"81a72558dc94e22a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/config.js\":\"8eb7736fe5ebf5f2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/dataExtension.js\":\"2c859deab2fd3035\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/effect.js\":\"9884095bc9e2d976\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/index.js\":\"85479bd2f1e4a487\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/propertyEditorOverride.js\":\"18bf996c38d8b57d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/useToggleTree.js\":\"1c7c64f7d656e14c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/ExtractTypeDialog.js\":\"203369c29c1dbc2d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ded8dd133a3b4224\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/PropertyShapePicker.js\":\"5714b1dcde5497fa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/action.js\":\"728c445f4e1dfa6a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/index.js\":\"65991f6a3ded3e68\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/FindReplaceDialog.js\":\"42bdeaf940c8082a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/HeaderItem.js\":\"34905f60c8f99db8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/dataExtension.js\":\"05e88d8066ac8c2c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/index.js\":\"d984519271252f05\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/search.js\":\"baf6d1546b15a1fd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/toggleStore.js\":\"c69e3bd7ae4488dd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/LocationPropertyEditor.js\":\"1b60b5b6cfdd6edf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/MapView.js\":\"8726c40493858272\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/blockTypes.js\":\"5660269ccaaf014a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/codeMirrorExtensions.js\":\"e9bf2cb75880df0d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/createOrFindPlace.js\":\"0818cf18dbb7d115\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/currentLocation.js\":\"a20adaeb5bcffdc2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/dataExtension.js\":\"65a9d051a9e32afc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/geoContentDecorator.js\":\"5165475540ec5094\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/googlePlacesClient.js\":\"08e1e6f6f9bd65de\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/index.js\":\"a0fc613bacb440e5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/locationsPage.js\":\"cbeb7f7567056652\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/mapViewport.js\":\"203753f0f79e2670\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/pickCurrentLocation.js\":\"36916e91c236ac2b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/placeAutocomplete.js\":\"6242f4536c7dfbdb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/placeNameCollision.js\":\"0636baa0e7a2977d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/properties.js\":\"02ef4d7101c0df6c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/propertyEditorOverrides.js\":\"af246935846abe2d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/query.js\":\"8eb2f798064aeccb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/usePlaceSearch.js\":\"83efb5d824af6989\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ffbcbf3af64f6ac0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"6814f79cf20770be\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"2d5b95878855346b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/config.js\":\"1e4efb07faa2124b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/dataExtension.js\":\"755b1d12a0785a23\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/facet.js\":\"44f35f1125abbb4d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/grouping.js\":\"b694c7cc5d587afc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/index.js\":\"98d4c265903ec7c6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b0691d6bf0152d53\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/query.js\":\"f560264dedafc1bb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/resolveConfig.js\":\"89bd4132a7a45343\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"044945f27eb193f7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"49ed1b5bd13b2201\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/HtmlDocumentContent.js\":\"bdfe2d6c66e34b7e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/HtmlFrame.js\":\"7fdd63ce1f799633\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/actions.js\":\"c4c23470e167d0fc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/blockType.js\":\"0b7ccdfaedab99c7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/confirmRunScripts.js\":\"bd870ed660e19767\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/dataExtension.js\":\"f1d65ca8dae4ad5b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/frameAnnotations.js\":\"23b7bc0d233e6621\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/frameDocument.js\":\"4e90c64a7ad0c748\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/frameTheme.js\":\"ff16e55116c18bca\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/index.js\":\"f8a4ea18aef7ab50\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/scriptConsent.js\":\"7ac226b4012acc71\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/sourceMap.js\":\"4b5a507c57fe6098\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/useDocumentScripts.js\":\"c431f239fa1bef91\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/index.js\":\"c11746e8695f9288\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/record.js\":\"52cd2452afae6273\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/recordStore.js\":\"6eaa88b4c0683bb9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/responsiveness.js\":\"ded69fd4f547083a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/schedule.js\":\"8a109a0095c85ce7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/sessionContext.js\":\"c6dfe340b07c2008\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"3cf0921cc6db6dd5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3a7786fee35745d4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/actions.js\":\"512b01816bc87ba4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/config.js\":\"c567f123ecc877ec\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/dataExtension.js\":\"23c0248dff83250c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/effect.js\":\"9279bc752c24c4b7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/index.js\":\"97dc1da459632494\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/keyCapture.js\":\"69db93d07328c94a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/overrideStore.js\":\"65c556b93d13035d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"960f72820ee23d0b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/HeaderItem.js\":\"49c600f23baba8a4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/LeftSidebar.js\":\"78dc2b0e73648841\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/actions.js\":\"0b615cc93ee07d6e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/facet.js\":\"e45564b35e3f2ed0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/index.js\":\"205bb4308a14f87f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/shortcuts.js\":\"954bcd40578dd433\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/toggleStore.js\":\"a5d89485a842f63a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/MergePicker.js\":\"825c590d682c4a4d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/index.js\":\"1a455b32be368326\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/mergeAction.js\":\"fa502588ce8b102e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/strategy.js\":\"378dd0abf396f49d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/Button.js\":\"7fa78d9660581b24\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"98a9ee50fb515216\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/defaultItems.js\":\"74902d0dcd474269\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/facet.js\":\"fed03240ff3b26d8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/index.js\":\"c0f57d35dbc7a691\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"638dc11cd4298497\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/actions.js\":\"067af9de97d08c48\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"57e50f922c7fb936\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6017031957fd2897\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/index.js\":\"44a3a3399c48713f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/MoveDestinationPicker.js\":\"6e0aeba557a22893\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/blockSubtreeMembership.js\":\"5dab0bffa0bc35ec\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/contextMenuItem.js\":\"3393ea83b48182be\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/index.js\":\"ede6f6ffc4ec4b46\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/moveAction.js\":\"53bf64e79842edb4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/moveBlocks.js\":\"32ce4a874cb49b28\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/selectionAfterMove.js\":\"7359a1dc8fc15099\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/TutorialBanner.js\":\"bef73694c6ff1960\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/action.js\":\"9eb1793c2e8adfe7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/bannerDismissal.js\":\"17f6130cfb659c61\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/documents/cheatSheet.js\":\"9a59689d6ae8d950\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/index.js\":\"ab707eae8249fc61\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/keys.js\":\"6b2894bb2027482b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/landing.js\":\"e8d07ddbf7f56168\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/outline.js\":\"30aa5ffe30cf7b91\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/seed.js\":\"405e8d7aa85c7dd4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/PerfTrendDialog.js\":\"162783e3f2ed23d2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/analyze.js\":\"b586a69353650a0f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/diagnosticsSource.js\":\"86c51e34fe3a4926\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/index.js\":\"746df30d1a8e2826\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/load.js\":\"2234a73040c231b0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/monitorRun.js\":\"4ddfd827687f8da8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/schedule.js\":\"f36ffde3efe5b474\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/series.js\":\"fdf08f052adb3373\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/store.js\":\"57af9b664b55c3c4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/trendAction.js\":\"fdb32393fb8a31de\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/verdict.js\":\"c3a3825ba35b3b22\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/plain-outliner/clickToEditAction.js\":\"b7578e558a4821dc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/plain-outliner/index.js\":\"ed6a9e6ec8140e57\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/plain-outliner/interactions.js\":\"7ee94963ed5aa9d2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"753240c7ab8e53ed\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/MigrationGate.js\":\"7430f6249fd213b0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/MigrationGateDialog.js\":\"e0669ccb904c78fb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/action.js\":\"17c258e3f2931b09\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/index.js\":\"ba0c46fcc9489732\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/localRunMessage.js\":\"9d77cf9ca16c0427\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/plugin.js\":\"16af8d7df8120c0a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/progressReport.js\":\"c007d2ee1e1b2fd3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/sweepProgress.js\":\"c45a02ebf504c522\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/FieldRowRenderer.js\":\"7797bda406d3de2b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/ValueRowRenderer.js\":\"a501e2fe49f121d8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/actions.js\":\"ae41990fdf7662e9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/autocomplete.js\":\"aa7314cdd1065491\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/fieldRow.js\":\"f9a42ba2fd17576b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/index.js\":\"6543a973ac60cc9e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/referenceWarning.js\":\"ce9edc7227b07dbf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/valueAutocomplete.js\":\"cc6e9d62e2515648\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/valueSchema.js\":\"3ad44af32cf81dff\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/HeaderItem.js\":\"a3c5a6874cabe81c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/QuickFind.js\":\"785a3965080773f2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/index.js\":\"4ec648a49a7fd2c3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/recents.js\":\"d7555280a099e614\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/resultItems.js\":\"9d7bfab18f9c6fd3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/selection.js\":\"f38ac0323bde53bd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/toggleStore.js\":\"b1ca21237014601c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/HeaderItem.js\":\"fc741b6be430572e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f5494d6b4a6c34b6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/grouping.js\":\"1806165ff102d796\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/index.js\":\"9d9bf2b4c0d38f1a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/target.js\":\"3d27cde810674a2a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/codeMirrorExtensions.js\":\"ea0516037bdb7e36\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/contentPrefill.js\":\"a6c3a1543955b8e9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/dataExtension.js\":\"8db4a970d67dfafc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/index.js\":\"7565ed937eab24e6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"79ae0b833413b474\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/invalidation.js\":\"6b026bdee17f878e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/localSchema.js\":\"435744e82f9ce8e1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/blockrefs/index.js\":\"c2de9535fe1ded09\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e61c89cbf6d6a9b4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/index.js\":\"db56a0ff8adeb5a0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/referenceNode.js\":\"54233d06d3c8b7a2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/remark-reference-occurrences.js\":\"030a148aa22137f5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a12958c8e0440e1d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/index.js\":\"020e019b6677df59\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7b39b84819ab2982\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"8a8356c49bdd12b4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/mergeRetargetProcessor.js\":\"977be116934a7f79\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/parseFence.js\":\"dceeb9ae5e785769\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/referenceParser.js\":\"8af4804f687c85fe\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/referenceProjection.js\":\"6de8b7b8f0f182ca\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/referencesProcessor.js\":\"c46691c840b77629\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/renameProcessor.js\":\"15a10e0e5de6c11b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/spanReplacement.js\":\"2b4722d1fa2fe5e6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/htmlToOutline.js\":\"8207cfe7aeaa25f0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/index.js\":\"12d671db0cb8ffdb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a5be3340ec3fbf73\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/pasteDecision.js\":\"ade26844e20c238f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/action.js\":\"bb1c7ec877c3cae7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/blockIds.js\":\"83f6838235480557\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/content.js\":\"f9f7aa1a08cb1191\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/effect.js\":\"d80139150efbe0df\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/ids.js\":\"ccf599322a18bab6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/import.js\":\"38083babbdaeff20\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/index.js\":\"7c4b34a57290e6cb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/plan.js\":\"7abe0f70a5054c61\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/plugin.js\":\"5ed536769cc76a2c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/promotion.js\":\"5e3f691ba9179a78\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/properties.js\":\"ac12b8cd1b1f617b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/references.js\":\"99c714350757edb2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/report.js\":\"6579213ecbb4cb56\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/roamMemo.js\":\"4ea23d4e258539c7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/runtime.js\":\"c276b45926f74b7e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/schemaReconciliation.js\":\"629e72a2f3c9ccca\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/srsMarkers.js\":\"9c5f7fa7f6e88784\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/todo.js\":\"2dcb48032a798133\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/typeCandidates.js\":\"3b6fd2d0feda9109\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/types.js\":\"5044b1e6d82ae17a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/search-health/index.js\":\"a424e08880fb2b9a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/search-health/store.js\":\"60e409af5102df1a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/HeaderItem.js\":\"e4dcdd59cd5114cb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"8c40cc3ac4320b24\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/index.js\":\"46eace1fafacc099\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/model.js\":\"ac177f7a6aaca801\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/toggleStore.js\":\"b42d8f3535a586cb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/useKeyInspector.js\":\"c31006e2c89cac4d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"4b42f180e4fe35c1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/ShellDecorator.js\":\"1ad462d09f3c9c0a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/actions.js\":\"c2366e10beaef027\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8de3694a020a07a0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/index.js\":\"09597ebcb554f9a5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/shell.js\":\"d3fcdf1a007fad12\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/surface.js\":\"5e89dc45ab7d30d7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/walker.js\":\"fa6fd8fbcfeeb755\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/RescheduleToast.js\":\"cf21ffc05033bbbc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/dataExtension.js\":\"b0517dea018155bf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/index.js\":\"b294619ed846a99d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/indicator.js\":\"f7e899fba7d3a213\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/moveSrsState.js\":\"b171d31b441cfbed\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2c69ce704817471e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/scheduler.js\":\"44f9191d4d6e46f8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/schema.js\":\"6beb8987c4f8e163\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2562f390c6a2b1fe\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/srsClipboard.js\":\"4a5e2e3221403323\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b8e8dd690d81b97e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/DailyNoteReviewHint.js\":\"5703ddb621a4e70f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/DeckPicker.js\":\"9f078a41cc667eb9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/ReviewControls.js\":\"a01a66c795defe6e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/ReviewDeckRenderer.js\":\"96c98baa19afc436\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/ReviewSession.js\":\"85af1306a639fe45\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/actions.js\":\"d8659bf7070ec1ed\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/archive.js\":\"e82b0952f2692e72\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/dataExtension.js\":\"46737e8073593b62\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/deck.js\":\"e02aee7a1b0017d4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/dueQuery.js\":\"b827465263d01806\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/gradeDecision.js\":\"057ca959817f594f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/index.js\":\"6b63e5754a038379\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/keyHints.js\":\"76ecb0dbb5930bfe\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/reviewCardLayout.js\":\"b9fa46608d10b528\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/reviewProgress.js\":\"2746ecf33cd712b5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/schema.js\":\"43fc2de8074dac29\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/useDueCards.js\":\"f6eb58bde4f7cca8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/startup-metrics/index.js\":\"0e01479ac840a1e0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/startup-metrics/record.js\":\"d6fd8b6d98e7a6da\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/storage-persistence/index.js\":\"715f8a9453344402\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/storage-persistence/persistenceStatus.js\":\"360d13f3ff45a645\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/storage-persistence/requestAction.js\":\"0682f57a31bbd0f2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/TypeChipsDecorator.js\":\"84a086c09e3d4903\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/codeMirrorExtensions.js\":\"8f6849916cef8396\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/index.js\":\"fdcf692213b867f5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/typeAutocomplete.js\":\"dffec74567570ff8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"071ccc6e5c3d2a73\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/actions.js\":\"4f137434d5161da3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/anchor.js\":\"6c76d69e2e820128\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/events.js\":\"6d70f00c165affad\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/gestureActions.js\":\"a08f3a122fae6368\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/index.js\":\"be49adbc1fb54402\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"5ee1ef57b49cde39\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/sync-metrics/collect.js\":\"6fbcb319cd827e7e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/sync-metrics/index.js\":\"5efefbf994046610\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/sync-metrics/record.js\":\"206d5c140ad012b8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/RejectionDialog.js\":\"6659bfcf5d08e0e9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/SystemStatusHeaderItem.js\":\"7a8fcfdefa3ba07f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/index.js\":\"599e2b5bce8fcdb4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/model.js\":\"bb3034b5a42e4dbf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/queueCounts.js\":\"6855d2ff2cca6c3c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/rejectedHelpers.js\":\"987aae965ac6eae0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/rematerializeAction.js\":\"d38b970e873592bd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/useHysteresis.js\":\"a5e22402c0068300\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/ColumnHeaders.js\":\"6964ba8e80dd6557\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/QueryUi.js\":\"6b2ec89fc1a10d44\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/TableLayout.js\":\"9675b48d4c7f0989\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/actions.js\":\"2b5d6f43396b3b99\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/cellEdits.js\":\"22200ea652c1b60d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/childrenViews.js\":\"7423d26cf08a003b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/columns.js\":\"0dbe754621107a12\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/controller.js\":\"1172b3a037597c46\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/convert.js\":\"9fafd2134424d245\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/dataExtension.js\":\"fc17327801e9ba79\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/index.js\":\"bdf122f32e40c3f2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/keys.js\":\"f94e1c9a322a4459\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/model.js\":\"f019a69e103910a0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/backfill.js\":\"2b919efec00d3060\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/completion.js\":\"10bd5cd33c0fc39b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/format.js\":\"fb8508f03a2eab91\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/parse.js\":\"d9c1493fade60cf6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/queryValue.js\":\"20a889107147d295\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/registrations.js\":\"a306e5239e2e9b6e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/source.js\":\"4045c0760e063613\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/registry.js\":\"b9a30df7ab7d35ee\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/rowGutter.js\":\"ea279a1a233fc12d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/rowVerbs.js\":\"461cb063010203be\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/schema.js\":\"f52c94fc1a21d99f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/sort.js\":\"c034bd7318c5d6b0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/theme-toggle/effect.js\":\"0aa6695eddc9a1bd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/theme-toggle/index.js\":\"7a79e4526be37be2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/theme-toggle/theme.js\":\"50278df3b0664ee5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/actions.js\":\"43c6ebcfea94b423\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/dataExtension.js\":\"f25970f1e05dde1a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/index.js\":\"f1764f34dd461330\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/schema.js\":\"9cc1283c2d4c30f5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/TouchSelectionLayer.js\":\"22555ca410dbff4c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/actions.js\":\"b0b361e973f5fdc2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/defaultItems.js\":\"e2dccec2ac7e3207\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/facet.js\":\"12e697adf0a16789\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/holdRecognizer.js\":\"d252d9a88385342b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/index.js\":\"840f115de0ae04b5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/update-indicator/UpdateIndicator.js\":\"a8ba9193f16be2ef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/update-indicator/index.js\":\"9b0224e4c0c6bb2b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/update-indicator/loadTimes.js\":\"d0e0cbbda7efff4e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/VideoNotesRenderer.js\":\"17871ae7d77da2f6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/VideoPlayerRenderer.js\":\"9522943965e53ec5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/VideoTimeStamp.js\":\"f5eb3f44fef96438\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/actions.js\":\"0684deb7b2bacd84\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/index.js\":\"4750f9dbb5ed2031\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/markdown.js\":\"38191dc4214f9ea4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/notes.js\":\"9dbb8f9aab8759e9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/registry.js\":\"0e35f6d978a6cf1a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/remark-timestamps.js\":\"8f3afdd1002ffcc1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/view.js\":\"c4ff6d87f3bbe55f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/LinkHints.js\":\"39d867710e75aa8b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/index.js\":\"97fdc2fd15626098\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/model.js\":\"ab48590b9364388a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/settings.js\":\"8a2d6f2f8155939d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-normal-mode/actions.js\":\"5cb117e17644036e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-normal-mode/index.js\":\"f637af438e1a0798\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-normal-mode/interactions.js\":\"56b59c47044da955\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/workspace-header/index.js\":\"b2cfa20f388c985b\",\"/knowledge-medium/pr-preview/pr-1880/src/registerServiceWorker.js\":\"3c70b2a0b7b8d488\",\"/knowledge-medium/pr-preview/pr-1880/src/requestPersistentStorage.js\":\"c16ff3bd679518f3\",\"/knowledge-medium/pr-preview/pr-1880/src/services/authRequestDeadline.js\":\"2f9ba29013c3f59d\",\"/knowledge-medium/pr-preview/pr-1880/src/services/authStorage.js\":\"2b8ea7e02eeecbfc\",\"/knowledge-medium/pr-preview/pr-1880/src/services/powersync.js\":\"d5355095440db501\",\"/knowledge-medium/pr-preview/pr-1880/src/services/supabase.js\":\"d071270abeee9a9c\",\"/knowledge-medium/pr-preview/pr-1880/src/services/uploadErrorClassifier.js\":\"40e10d7bf7b18f5a\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/ActiveContexts.js\":\"fdb764328132bf87\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/HotkeyReconciler.js\":\"47e7da0321cd7dc7\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/WipeLocalDataDialog.js\":\"7cd9e2c44137ded5\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/actionDispatch.js\":\"df1cba00079fcdd6\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/actionRefItems.js\":\"27c167b4f294f39e\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/applyKeybindingOverrides.js\":\"fe98f73255ac63bd\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/blockActions.js\":\"d300d0b3954e2b6a\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/blockMergeGesture.js\":\"aad024ca96615142\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/canonicalizeChord.js\":\"364598398b7406b0\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/defaultContexts.js\":\"740ed87280ff2499\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/defaultShortcuts.js\":\"7d472f4c37335ee2\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/effectiveActions.js\":\"a047fc3e0e38c6d8\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/gestureAction.js\":\"130d3b6109e820ff\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/gestureBinding.js\":\"46239741b55e5bac\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/holdRegistry.js\":\"87f28d049d96e567\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/keybindingConflicts.js\":\"4a5bb19f98a3f085\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/keybindingOverrides.js\":\"0cd808e28d4a9418\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/pointerAction.js\":\"9815208d542fac1d\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/resolve.js\":\"02e9b42aadf76b15\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/runAction.js\":\"18d012308dde6a37\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/sequenceMatcher.js\":\"e65a6ed45d6f748d\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/types.js\":\"11014a26211cbdbe\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/useActionContext.js\":\"150efe612290f570\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/useActionDiscovery.js\":\"780e7a80b54215f8\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/utils.js\":\"a160df809d4d92cf\",\"/knowledge-medium/pr-preview/pr-1880/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1880/src/sw/bootStore.js\":\"6ed55d730a599f08\",\"/knowledge-medium/pr-preview/pr-1880/src/sw/previewDatabases.js\":\"8cea2246054f5ee9\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/byteTransform.js\":\"47025ab4a5601040\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/attachmentCleaner.js\":\"5620540ed56ea440\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/attachmentParts.js\":\"cdd9e5e80eaae2de\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/bundleParts.js\":\"1b6cf3bcad2078c2\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/bundleRecord.js\":\"32e84b87c084a7e4\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/manifest.js\":\"1458c777e742f071\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/takeBundle.js\":\"315cde4f760e8a0c\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/verifyBundle.js\":\"436f5945daf520b6\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/cleaningStage.js\":\"a18996b5c10984a9\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/conversionKey.js\":\"804e5d5c57180c71\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/conversionServer.js\":\"0a48be5beecbd85f\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/flip.js\":\"af771b63573eb46f\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/flipAttempts.js\":\"966ea19e898082a9\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/pages.js\":\"f58e2ee45ebafa97\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/preflight.js\":\"5bfd8bfa10b78ffc\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/reseal.js\":\"c8779dc68bfbae00\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/runConversion.js\":\"e29028627f5c5a70\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/runLock.js\":\"09d8b2fcf2967363\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/sealing.js\":\"0a684de5374b0817\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/sealingStage.js\":\"751898e576d576ac\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/stage.js\":\"09a63c619858a8c3\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/verifyReseal.js\":\"f8fb8e5a9172f279\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/aad.js\":\"6cd0bb34cb9ca228\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/aead.js\":\"0b6518ed3e9d8370\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/base32.js\":\"5a3b5c65216c9010\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/base64url.js\":\"ac3c261f30473ee1\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/binaryEnvelope.js\":\"bc9619942001018f\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/byteAead.js\":\"81241b373ea4655f\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/canary.js\":\"039507bbc4aa2b5a\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/contentHash.js\":\"9869c3412325aeca\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/contentKey.js\":\"a7579b972a4464fa\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/derivedIdNamespace.js\":\"33d4ae40322cac4f\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/envelope.js\":\"9241cf3869f928ef\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/hex.js\":\"2818b813aaf95991\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/sha256Hex.js\":\"ef9e80bf4762ceb7\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/workspaceKey.js\":\"cc6f4414a9264c6b\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/conversionState.js\":\"70ef9821cf3d61dc\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/createEncryptedWorkspace.js\":\"537ec8d11f586e96\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/pastedKey.js\":\"cb796bb035fea57d\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"1e78d4db5f66e103\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/upgradeWorkspacePin.js\":\"454eac5be3321422\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/keyStore.js\":\"0e73f9676e4a1056\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/mintWorkspaceKey.js\":\"ce9187551b058c29\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/modePin.js\":\"af3a8946b6580966\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/openWorkspaceKeys.js\":\"8963aae94175ee7b\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/resolveWorkspaceEntry.js\":\"2d0f4e0b1057ceda\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/resolver.js\":\"ec438bbc11b412ff\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/workspaceAccess.js\":\"027a7527e620459e\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/transform.js\":\"48b85dde525a3153\",\"/knowledge-medium/pr-preview/pr-1880/src/themeBootDefaults.js\":\"1b7a510338d8da5c\",\"/knowledge-medium/pr-preview/pr-1880/src/types.js\":\"649822ebaba9f1ae\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/ClientLocalSettings.js\":\"1f032c9e81704613\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/abortableSleep.js\":\"8a320b5e9db7ebf5\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/array.js\":\"6c94bb9015817de4\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/backlinkAutocomplete.js\":\"38b8d0ca6efa93d5\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/blockCrumbs.js\":\"5546c66c579377d8\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/blockrefAutocomplete.js\":\"bcd0ddd4ee7149f6\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/cadencedIdleJob.js\":\"8824edd3808981d2\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/callbackSet.js\":\"1e35e6124962b4c3\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/clientId.js\":\"5d51722155eb7332\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/codemirror.js\":\"9c0124e976afa550\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/codemirrorCompletion.js\":\"a1c2dd65b8d1f9e1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/copy.js\":\"fa7da3499f8a6b80\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dailyPage.js\":\"4d6734be038f1a64\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dbForensics.js\":\"5ae66f21f8193b96\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dbForensicsHooks.js\":\"f5904b612cbfbe1d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/deleteBlockThroughUi.js\":\"0aff5ae79cc331a4\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dialogs.js\":\"d587f5f6a3da190c\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dom.js\":\"cdde1791143e06d5\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/downloadBlob.js\":\"70eaf69c32fa6469\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/drawnWalk.js\":\"1774f35509dc519a\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/exportSqliteDb.js\":\"0b14a695ec194a7b\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/fileSystemAccess.js\":\"8358d104c96c6b88\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/flipSlide.js\":\"9d655226568f6130\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/fnv1a.js\":\"7309f9774fe51803\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/formatBytes.js\":\"82243891a82be0a1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/fuzzyRank.js\":\"3b6757db77b25ef1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/idbKeyedStore.js\":\"34cfe43b1f90f324\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/idleCallbackPolyfill.js\":\"2a2f877799ef6cb5\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/keyboardAwareScroll.js\":\"df98e85dddbe1ee5\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/keyboardViewport.js\":\"64950e0b2be0ccb2\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/lastWorkspace.js\":\"788043b614840344\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/layoutColumns.js\":\"3e5f516fa5f35f7e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/layoutSessionDom.js\":\"ba2a024ef8d55c26\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/layoutSessionId.js\":\"cca74037b23abe35\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/linkClickGestures.js\":\"d267496ee4c4e1fe\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/linkTargetAutocomplete.js\":\"947722c2b7429847\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/localDbCorruption.js\":\"f30e1c70f194c20f\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/localDbRecovery.js\":\"faa2d3b6e97491e2\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/markdownParser.js\":\"3e94af762f9a851d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/memoize.js\":\"e37b2dd7834624bd\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/nameFieldCommit.js\":\"e0469033c511b77e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/nameList.js\":\"79e186056bd1f068\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/navigation.js\":\"6aadf8e7d07a7e9f\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/omnilinerNamespace.js\":\"0cb876381f1a7597\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/opfsPageScan.js\":\"e670d28af35afaa6\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelClearance.js\":\"0bd5b43f1481ed42\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelHistory.js\":\"baa75e5c92d3990c\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelLanes.js\":\"98b421685b7fb2ad\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelLayoutProjection.js\":\"ee38d9c2e2c53d99\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelScrollAnchor.js\":\"24d22cd8e8f1bd30\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelUrlFlags.js\":\"c0725f1bbf716b75\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/platform.js\":\"41f11eb2d9447da5\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/pluralize.js\":\"62c35279acf1b52e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/propertyCreation.js\":\"96172734ec215727\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/propertyNavigation.js\":\"3acdd8710c3f8c60\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/propertyValueContext.js\":\"731113d82083ab8d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/react.js\":\"1af78cb5d6faffbb\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/relativeDate.js\":\"06474dee249c7f2c\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/relativeTime.js\":\"3c09b7569c890371\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/renderScope.js\":\"dbc5ae1324b42cf3\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/resolvedThenable.js\":\"9ad1a5a1324a6c2f\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/routing.js\":\"79c10d4d86e3b52e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/safeMode.js\":\"8f076e44361203c3\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/scheduleIdle.js\":\"5dfaf168e6878d6c\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/screenWakeLock.js\":\"c924dac6f0c1230a\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/selection.js\":\"37ade2bd7d83adb1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/softKeyboardGrab.js\":\"65e60e591fa44c33\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/startupTimeline.js\":\"58262445ab0c37c7\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/state.js\":\"507d57ab3fcf0cb9\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/string.js\":\"3b24455629631429\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/surfaceZoom.js\":\"87f88dd473f775fa\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/time.js\":\"cdd907ae22d9156e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/toast.js\":\"38e1318d1151bdb3\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/toggleStore.js\":\"fdbf88afc7356d23\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/untilStopped.js\":\"80b60cd2d2f762d0\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/userActivity.js\":\"5ad7440a7172cc09\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/viewTransition.js\":\"fd1fd1856ff6f4af\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/viewport.js\":\"b8cd327cc96b8210\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/webLock.js\":\"0dc0170eac1c622b\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/workspaceRecovery.js\":\"55f51751c666191d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/workspaceSnapshotStore.js\":\"6309c938a986950f\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-compiler-runtime.js\":\"96c5fc3355ab1565\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-client.js\":\"cb401d45c9b44634\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-server-edge.js\":\"e40ec8b5c3d6d993\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-server.js\":\"9914fec2783e313e\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-static-edge.js\":\"6b3b1d82248b0eba\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-static.js\":\"210e25abcf775789\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-test-utils.js\":\"35bb95d26d494e54\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom.js\":\"b8cf53a0fc2a7938\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-jsx-runtime.js\":\"2628b1e35da19b55\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react.js\":\"33d9011debfdbfdb\",\"/knowledge-medium/pr-preview/pr-1880/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1880/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1880/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
