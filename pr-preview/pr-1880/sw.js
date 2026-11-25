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
		buildId: "af10bede1527-953aa887",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1880/\":\"e9fdfc78b0283e37\",\"/knowledge-medium/pr-preview/pr-1880/index.html\":\"e9fdfc78b0283e37\",\"/knowledge-medium/pr-preview/pr-1880/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1880/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1880/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1880/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1880/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1880/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1880/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1880/assets/FacadeVFS-CfwOIaBe.js\":\"99973ad93a0ab6a4\",\"/knowledge-medium/pr-preview/pr-1880/assets/OPFSCoopSyncVFS-CGWyHqTt.js\":\"c19da42fffc5a5f8\",\"/knowledge-medium/pr-preview/pr-1880/assets/OPFSWriteAheadVFS-DE7kQUD9.js\":\"774dcaa43a4409b9\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-BMRXrxyP.js\":\"04c74e4277906524\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-async-oSPzL-0G.js\":\"b6db167cabc22d6f\",\"/knowledge-medium/pr-preview/pr-1880/assets/worker-BFjzcqXv.js\":\"adef31055dbeaae5\",\"/knowledge-medium/pr-preview/pr-1880/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1880/chunks/app-BGIYDMNR.js\":\"214de4b2429cb552\",\"/knowledge-medium/pr-preview/pr-1880/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1880/index.js\":\"d1319dde36945531\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1880/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1880/assets/AccessHandlePoolVFS-CjRieX9p.js\":\"e94c682b1edc370c\",\"/knowledge-medium/pr-preview/pr-1880/assets/IDBBatchAtomicVFS-KbzNfpmF.js\":\"aa115e545fddd8fd\",\"/knowledge-medium/pr-preview/pr-1880/assets/MemoryVFS-DgvTaVxP.js\":\"78b5975b28904ac1\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-async-CWXr4pAZ.js\":\"f517bf264bab7993\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-shMFXZFp.js\":\"feb6ee6fa0f3b068\",\"/knowledge-medium/pr-preview/pr-1880/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1880/chunks/AccessHandlePoolVFS-Bl0RCdgy.js\":\"80d48846441efccb\",\"/knowledge-medium/pr-preview/pr-1880/chunks/FacadeVFS-JmKW3b16.js\":\"4d06004bb204172d\",\"/knowledge-medium/pr-preview/pr-1880/chunks/IDBBatchAtomicVFS-CFWzq3GY.js\":\"afbc6ba027c72f8e\",\"/knowledge-medium/pr-preview/pr-1880/chunks/MemoryVFS-BsGHtWFu.js\":\"ddcef1167a7f6e49\",\"/knowledge-medium/pr-preview/pr-1880/chunks/OPFSCoopSyncVFS-UYG1qlCW.js\":\"82252bdac249266f\",\"/knowledge-medium/pr-preview/pr-1880/chunks/OPFSWriteAheadVFS-HR-ZYl9l.js\":\"c179e85aa70419fc\",\"/knowledge-medium/pr-preview/pr-1880/chunks/Preview-wlS7eEjS.js\":\"bfb3aedca89c9cca\",\"/knowledge-medium/pr-preview/pr-1880/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1880/chunks/card-BRi3raY7.js\":\"6ac3919f7dbcbfe0\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dist-DicvL8qG.js\":\"b9c48e4f994ba774\",\"/knowledge-medium/pr-preview/pr-1880/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1880/chunks/mc-wa-sqlite-C9PNh_BD.js\":\"8cbd5be27858a11c\",\"/knowledge-medium/pr-preview/pr-1880/chunks/mc-wa-sqlite-async-BfItegsD.js\":\"f38bc8aa17473799\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-ByLUVKU9.js\":\"2525ce93a148ea14\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-CVGXPetE.js\":\"edfeed96ec4cdb39\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-DFL8XEI5.js\":\"550ce451d32f6d03\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-DPnwnud2.js\":\"2b24137c07d8a82d\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-Du9MxRrs.js\":\"327dc4b20a261fe4\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-HccF4yL5.js\":\"bfd07cf4ea691cbc\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-dom-server-legacy.browser.production-6VlQM3h7.js\":\"851b07f07c220e05\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-dom-server.browser.production-Bzgbjcd-.js\":\"517aae18823af1fe\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-dom-server.edge.production-Brype7cm.js\":\"77dfbdb124ed801d\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-hSy76IGk.js\":\"0c0f55235d283118\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-wljcARWJ.js\":\"f349d8f437d8a09e\",\"/knowledge-medium/pr-preview/pr-1880/chunks/server.browser-CBA_M6Qd.js\":\"d24c5307bb494ebf\",\"/knowledge-medium/pr-preview/pr-1880/chunks/textarea-DJRLXmQJ.js\":\"324ee8b909438033\",\"/knowledge-medium/pr-preview/pr-1880/chunks/ui-CgR3WAbR.js\":\"5ae5b1fd1b21caf5\",\"/knowledge-medium/pr-preview/pr-1880/chunks/wa-sqlite-DwcZZiTk.js\":\"dd5ab6256287de95\",\"/knowledge-medium/pr-preview/pr-1880/chunks/wa-sqlite-async-Fu3buZTb.js\":\"b35b1ae066fdf5fa\",\"/knowledge-medium/pr-preview/pr-1880/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1880/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1880/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1880/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1880/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1880/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1880/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1880/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1880/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1880/src/App.js\":\"028afebc392d0221\",\"/knowledge-medium/pr-preview/pr-1880/src/appUpdate.js\":\"9a33598dc2173116\",\"/knowledge-medium/pr-preview/pr-1880/src/appVersion.js\":\"6a14a94d5d4e5dda\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/initialLayout.js\":\"e8972115d4c209cd\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/openWorkspaceData.js\":\"b22a6873a9be9983\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/resolveWorkspace.js\":\"67c4e180d5d11ccc\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/workspaceBootstrap.js\":\"741fa49d5bf1bb03\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockComponent.js\":\"4f2636b9de7766e5\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockCrumbs.js\":\"cdc1e5f6364d1a3a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockEditor.js\":\"7f96da96b142af1d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockLoadingPlaceholder.js\":\"0e71e65081f7440d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockProperties.js\":\"c4739471a847140d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockSearchPicker.js\":\"7828e5960b708ccb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ConfirmBulkDeleteDialog.js\":\"2ba087c40e55da23\",\"/knowledge-medium/pr-preview/pr-1880/src/components/DividerHandle.js\":\"c1d9a91d61b5d25f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/DraftEditor.js\":\"3acd25b7c675a045\",\"/knowledge-medium/pr-preview/pr-1880/src/components/GutterPill.js\":\"7cc859ae7ddcdbbb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/Header.js\":\"769b66da61cb92d9\",\"/knowledge-medium/pr-preview/pr-1880/src/components/LazyBlockComponent.js\":\"cb948703bab2def7\",\"/knowledge-medium/pr-preview/pr-1880/src/components/Login.js\":\"300dc4bc3fd5a62f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ZoomableSurface.js\":\"5edbf68eb74a6d0f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/editModeKeepalive.js\":\"0e3a4209f0e57064\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d56bfe99f205dbc3\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0b1a4126f325eba6\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/RefPropertyEditor.js\":\"49ac2b0a90b6878e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/RefTargetTypePicker.js\":\"1a9e29f3991add8e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/SelectPropertyEditor.js\":\"7b65b28666348b96\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/TypesPropertyEditor.js\":\"68493d6994f85b8a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/defaults.js\":\"f2055facd4d9129d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/kernelValuePresets.js\":\"61e1d2701e997d98\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/selectablePresets.js\":\"e15c0012f0c5a656\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/typesPropertyUi.js\":\"a70f19e5209ce9db\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/AddPropertyForm.js\":\"5413bc730bbf8f48\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/PropertyPicker.js\":\"e08ca2b7e32414d1\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/PropertyRow.js\":\"3427c1c03eac3321\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/Rows.js\":\"cecc3feb9fd729e9\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/actions.js\":\"ce9c2a39072c71cb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/declarationOnly.js\":\"b82d35c0063f2a9d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/layout.js\":\"c578945d23ec0d0e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/model.js\":\"c56deda06fd8c25c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/shapeUi.js\":\"0bac2917707a812d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/shapes.js\":\"bd6dbafedfb19102\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2c59a6ee4035c912\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/visibility.js\":\"d55f8cdfdb3786cd\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanelSections.js\":\"2e6d91a1c6051332\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/BlockEmbed.js\":\"45b4b3e53dc0999d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/BlockLink.js\":\"bf04a1e7727895b1\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/BlockRef.js\":\"d1a7467b310aad8e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/ReferenceLink.js\":\"008f174718213f97\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/cycleGuard.js\":\"8ef2a90f42669b86\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/cycleGuardContext.js\":\"2c025de681f96703\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/linkInteraction.js\":\"df547cfe8439dd98\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/referenceLayout.js\":\"3ab68665bfcc755e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/useBlockRefAncestors.js\":\"0509bd22ef9e8352\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BlockGutter.js\":\"c3a27d4a6a7a405b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BlockInfoDialog.js\":\"2955a00128c4e505\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BlockTypeBlockRenderer.js\":\"fced1276f5baf23b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BulletHoverCard.js\":\"f3c05fa58f52f3db\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/CodeMirrorContentRenderer.js\":\"7883a5152e6cc1ca\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6dc6ae59f0a9027b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/ColumnResizeHandles.js\":\"12286b3d51018a7a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"60cc6af316642431\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/DefaultBlockRenderer.js\":\"5bff400c5283efb1\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/LayoutRenderer.js\":\"cb4c651f8006b634\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/MarkdownContentRenderer.js\":\"4ec4dbf96ac1e529\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/MissingDataRenderer.js\":\"c613160d4f6dbbcc\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/PanelRenderer.js\":\"a74276ba40071436\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c4c4615fb0e2d405\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/TopLevelRenderer.js\":\"e18fc8e5d6b28c37\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/blockGutterMode.js\":\"920449dae1f60905\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/blockTitleText.js\":\"49f247ab0152a305\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/fieldCreationKeydown.js\":\"6fd892a1fac0bbe4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/layoutRootContext.js\":\"7fb242374360ebc4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/typeChip/TypeChip.js\":\"25db9830a6e1d4ef\",\"/knowledge-medium/pr-preview/pr-1880/src/components/typeChip/chipStyle.js\":\"35008de4e812a207\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/anchored-floating.js\":\"7d4d5df4e7862804\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/button.js\":\"e972b5e49ed9a106\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/card.js\":\"b9bd890664767d79\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/checkbox.js\":\"641aeab9667636d3\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/collapsible.js\":\"8939f623d95c4816\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/command.js\":\"db34b9024ccc9969\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/context-menu.js\":\"81409ace7d287eea\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/dialog.js\":\"1790c69e5c0676bf\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/dropdown-menu.js\":\"5ae90fb0ee1cc878\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/floating-listbox.js\":\"e775e8544d2761ec\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/index.js\":\"9b5d174eeb1d3212\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/input.js\":\"7dba45838134d17d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/kbd.js\":\"f5419fb3dbe16e25\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/label.js\":\"c43d08100fe53c68\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/textarea.js\":\"d41af902f3981640\",\"/knowledge-medium/pr-preview/pr-1880/src/components/useEditModeYieldKeepalive.js\":\"3ed48301955179b0\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/BootFallback.js\":\"9b58373d0234cd56\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/FocusedRowLazyMount.js\":\"32a46c8c8b9b471b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/LazyViewportMount.js\":\"03eb2748c277ae68\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/LocalDbCorruptionFallback.js\":\"6b449c6b2d350278\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/error.js\":\"e5c572c187ddba3c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/lazyMountRegistry.js\":\"1a5e877b3222cb40\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/suspense.js\":\"dbbc790660b8dfd0\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/CreateWorkspaceDialog.js\":\"446516ac5b349edf\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/PendingInvitations.js\":\"128cf35fbb7f0c3b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/SyncProgress.js\":\"3640d709c8690608\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/UnlockProgress.js\":\"b302762a89b43bd4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceKeyGate.js\":\"7e03cc284b5c59ce\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceSettingsDialog.js\":\"780797a14676d8a3\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceSwitcher.js\":\"b31d834518dcba0f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceSyncGate.js\":\"b63f1dca148ecc04\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/ConversionFlow.js\":\"d8b3399a4380d535\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/ConversionFlowHost.js\":\"c9217ed852240b76\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/EncryptionSection.js\":\"57a40477d920ab64\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/attachmentPrompts.js\":\"f9871cde38416072\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/bundleFolderPrompts.js\":\"de01d1874b44c945\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/conversionFlowDeps.js\":\"34c29d9ab2e797f2\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/conversionFlowStore.js\":\"d10f3420c381e415\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/flowUi.js\":\"25b9a6a9e6f5d96c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/useConversionRun.js\":\"077f0d4b14f9f40d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/keyUi.js\":\"112b9a77fb378673\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/useCloseOnKeyLoss.js\":\"2a6d650e1afcd1eb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/useCloseOnServerE2ee.js\":\"262ed9b70500c757\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/workspaceUnlocked.js\":\"aa6c85c08215f484\",\"/knowledge-medium/pr-preview/pr-1880/src/context/backgroundSubtree.js\":\"e368df2f51b3eeab\",\"/knowledge-medium/pr-preview/pr-1880/src/context/block.js\":\"b9b5e3dfc5504948\",\"/knowledge-medium/pr-preview/pr-1880/src/context/layoutWsContext.js\":\"dbab32826a19ab44\",\"/knowledge-medium/pr-preview/pr-1880/src/context/propertyDisplay.js\":\"9e0171b50d5babe2\",\"/knowledge-medium/pr-preview/pr-1880/src/context/repo.js\":\"c7144eb6746d4d14\",\"/knowledge-medium/pr-preview/pr-1880/src/data/aliasClaim.js\":\"f507b488dee8ecc8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/aliasSeatNamespace.js\":\"d2f8fd6094ddc32f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/blockData.js\":\"b06d278352c0f1a5\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/blockType.js\":\"73dbf5f9c219a5cb\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/changeScope.js\":\"bd66021a6ea9de64\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/codecs.js\":\"eda5710680041bad\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/derivedData.js\":\"36a6b4cefdc3b679\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/errors.js\":\"699bd29629e843ca\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/events.js\":\"c7c9cd5ae127ba48\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/handle.js\":\"2da25bc4ac355665\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/index.js\":\"4de7bad5e469f31c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/mutator.js\":\"d2273acc967a088e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/processor.js\":\"734ac6c75c2f087d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/propertySchema.js\":\"31fe7a25dbe93422\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/query.js\":\"e81e9886596413f3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/sameTxProcessor.js\":\"2a58ef94c35dd096\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/schema.js\":\"2da25bc4ac355665\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/tx.js\":\"2da25bc4ac355665\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/typedBlockQuery.js\":\"cc0a2ee8d0bb41d3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/user.js\":\"4a89f67a9a02d639\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/valuePresetCore.js\":\"3936963a723d3d10\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/valuePresets.js\":\"a265fd779b688615\",\"/knowledge-medium/pr-preview/pr-1880/src/data/attachmentCleanerIOVerb.js\":\"5a9cb63196222fb6\",\"/knowledge-medium/pr-preview/pr-1880/src/data/block.js\":\"b696af0b598e5b28\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockCache.js\":\"6ab2f32749775411\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockId.js\":\"1b942759e84949d4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockLiveness.js\":\"d41d018ac2e0362e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockMerge.js\":\"6d495cf1b9b1ed40\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockSchema.js\":\"17018bf3641ec2b1\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockTypeLookup.js\":\"615ba2e12c4b70cb\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockTypes.js\":\"63b2fd0fa21c95b6\",\"/knowledge-medium/pr-preview/pr-1880/src/data/childrenView.js\":\"93f0116368277997\",\"/knowledge-medium/pr-preview/pr-1880/src/data/clientContext.js\":\"0f3a40bc295453d7\",\"/knowledge-medium/pr-preview/pr-1880/src/data/dbFileSiblings.js\":\"5843373ce2e99991\",\"/knowledge-medium/pr-preview/pr-1880/src/data/definitionSeeds.js\":\"083db892fdb396e0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/derivedIds.js\":\"58bcf92c6a0e25d5\",\"/knowledge-medium/pr-preview/pr-1880/src/data/drawnSubtree.js\":\"bfed0c2e7bc89bf6\",\"/knowledge-medium/pr-preview/pr-1880/src/data/facetBridge.js\":\"c214f9b39c821c01\",\"/knowledge-medium/pr-preview/pr-1880/src/data/facets.js\":\"897dd1001b558ac9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/globalState.js\":\"97fcf3247b08a241\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/aliasClaimRederiveProcessor.js\":\"c4cbdf2c9f6c7202\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/ancestorBatch.js\":\"b8b9fca06bf65242\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/blockTypeTypeifyProcessor.js\":\"6366626519879934\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/clientSchema.js\":\"0e646ae33ad76701\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/commitPipeline.js\":\"af23f7f8ca80fa12\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/devAssertions.js\":\"bf05b50002b86377\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/firstSync.js\":\"62e4cc46143f268d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/freshInitialLoad.js\":\"35912b6794d529af\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/graphBackfillClaim.js\":\"62b54d32bb471ef0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/handleStore.js\":\"b6a89b39eb5f427d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/idleMarkerJobs.js\":\"8bb20e6d4f1088eb\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/initialDownload.js\":\"86448b7c375fcdd3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/initializeClientDatabase.js\":\"f73c8e7bfec1ce84\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/jsonCanonical.js\":\"c449816802c8e7e2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/kernelInvalidation.js\":\"4faa5c00f3b2c7e0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/kernelProcessors.js\":\"1f87049037ae1157\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/kernelQueries.js\":\"a594357be6935593\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/mergeTypeMembershipProcessor.js\":\"7a95986b4d946af7\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/normalizeReferencesProcessor.js\":\"5507eb264ef17213\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/poolInstrumentation.js\":\"223495ff99a30f1d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/processorRunner.js\":\"66b08a3edd162bb9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyCellBackfill.js\":\"1a335972af76c12f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyChildMint.js\":\"2e39ed0c1e80e7d3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyChildrenProcessor.js\":\"16a107e86df8db1f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f3be71c3ec9a0346\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyDefinitionSynthesis.js\":\"24c85d0f28ae8aba\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyKeyScan.js\":\"05d38468429818e8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertySchemaResolution.js\":\"c7ec7ae5cf1591a8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyValueEdits.js\":\"0c98075a2fcdce66\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/raiseProtocol.js\":\"323809cb7fb83183\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/readBatch.js\":\"3de3cbc201bc99c9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/refProjection.js\":\"c055e9f500525491\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/referenceTargetLookups.js\":\"c4ba791f87ab8fe9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/referenceTargetProcessor.js\":\"20f43a4a4322009b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/replayMerge.js\":\"83695a72bac3e6ae\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/sqlBinds.js\":\"e58a72ec848fafa2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b56ce7ff00cfa0ea\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/arrivalProcessors.js\":\"6f02504973205bf8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/invalidate.js\":\"1c204faabe41e8ee\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/materialize.js\":\"09fec83ce4eddc1e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/observer.js\":\"8e394bbcebedcd47\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/reconcile.js\":\"c345bce507791647\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/timingMetrics.js\":\"18f35c75a3899b4b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/treeQueries.js\":\"b1a7c97fa4c0c417\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/txEngine.js\":\"e777499345b78789\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/txSnapshots.js\":\"a692c431892207bc\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/typedBlockQuery.js\":\"d242f8dfb498b79d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/undoManager.js\":\"2c4fcc627892935c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/invalidation.js\":\"880c2e487eff8438\",\"/knowledge-medium/pr-preview/pr-1880/src/data/kernelDataExtension.js\":\"e0bd16849dc0983d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/kernelPage.js\":\"61aa7c69de6f9632\",\"/knowledge-medium/pr-preview/pr-1880/src/data/kernelValuePresetCores.js\":\"291a1ec31de3d757\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localDbCorruptionSignal.js\":\"797406fc79ff9b72\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localDbStorage.js\":\"74fc6ef347f9085e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localDbVfs.js\":\"043692fd1b66340e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localSchema.js\":\"f17728bf306f0205\",\"/knowledge-medium/pr-preview/pr-1880/src/data/maintenance.js\":\"63755b4074b18733\",\"/knowledge-medium/pr-preview/pr-1880/src/data/mergeProperties.js\":\"fb1f4e8eb37ddd24\",\"/knowledge-medium/pr-preview/pr-1880/src/data/metricsConsoleHook.js\":\"d66484ef3415bff5\",\"/knowledge-medium/pr-preview/pr-1880/src/data/migrationsPage.js\":\"3fde0f5296f132ff\",\"/knowledge-medium/pr-preview/pr-1880/src/data/mutators.js\":\"5f2d2fd8415f9e1e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/orderKey.js\":\"b34d0ef6fa2a7e61\",\"/knowledge-medium/pr-preview/pr-1880/src/data/orderKeyPlacement.js\":\"c99885ee6f6407ce\",\"/knowledge-medium/pr-preview/pr-1880/src/data/outlineSurface.js\":\"bb8a9b56dea67cd2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/pendingEditorContent.js\":\"7cda98e0c84ecf08\",\"/knowledge-medium/pr-preview/pr-1880/src/data/pendingUploadsSql.js\":\"6ab08d09f6efec45\",\"/knowledge-medium/pr-preview/pr-1880/src/data/pluginStateExtensions.js\":\"42b74e665c329d14\",\"/knowledge-medium/pr-preview/pr-1880/src/data/powerSyncLogger.js\":\"ee108914184396e8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/projectorRuntime.js\":\"0db3cdaab0c8b549\",\"/knowledge-medium/pr-preview/pr-1880/src/data/properties.js\":\"12bd93ac14628bc4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertiesPage.js\":\"cfd87d218dbb39be\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyChildren.js\":\"0282ca787d70dc46\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDefinitionFanout.js\":\"a631eeabc8c234a0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDefinitionMetadata.js\":\"0e7e1931705eee7f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDefinitionRegistry.js\":\"bcccefa7e7f4cca7\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDisplayMode.js\":\"f7ac68b5d5a9d4a8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyRowCreation.js\":\"a1572a9a1c0b3d31\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertySchemaCreation.js\":\"b39fdb8336b79090\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertySeeds.js\":\"e779b1b1531ba83d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/recentsPage.js\":\"84c12937f88628c3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/referenceBlock.js\":\"f9633b0286cec588\",\"/knowledge-medium/pr-preview/pr-1880/src/data/rejectedUploads.js\":\"9f234982a790aac8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/releasePowerSyncConnection.js\":\"9196a76bbe633047\",\"/knowledge-medium/pr-preview/pr-1880/src/data/repo.js\":\"91e9d15f970d3267\",\"/knowledge-medium/pr-preview/pr-1880/src/data/repoProvider.js\":\"c8fdff1bf729f6f0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/rowProperty.js\":\"263d628378c9b4b5\",\"/knowledge-medium/pr-preview/pr-1880/src/data/searchFilter.js\":\"db76e604971ab79c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/seedIdentityLedger.js\":\"e96c2dd990a7682d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/stateBlocks.js\":\"564a71555ab79acd\",\"/knowledge-medium/pr-preview/pr-1880/src/data/structuralEditPolicy.js\":\"c3ab3d42975aa8ff\",\"/knowledge-medium/pr-preview/pr-1880/src/data/structuralInsert.js\":\"09dff38f829bbf3f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/subtreeDelete.js\":\"bd7655709179f5e0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/syncStreamLock.js\":\"2186a523b6da20e3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/syncedTableSqlRecognizer.js\":\"031833decec2ccc1\",\"/knowledge-medium/pr-preview/pr-1880/src/data/syncedTableWriteGuard.js\":\"9bba61957564fc1b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/targets.js\":\"8a7e8823170bcc4a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeColors.js\":\"9bd385aca31a38ca\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeDefinitionMetadata.js\":\"93ebf1f1ebb6e96a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeDefinitionRegistry.js\":\"0fe1761993448c54\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeExtraction.js\":\"4a82d9f1bec58a5b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeInitialValues.js\":\"74594f2544837459\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typePropertyGroups.js\":\"d7b3f583f6aadc0b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeSeeds.js\":\"bd3c19f02fe3dca2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeTagger.js\":\"a704a4a5c04cf17a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typedRecords.js\":\"c74d9fd070f6ebd0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typesPage.js\":\"3d4148df79cd9d89\",\"/knowledge-medium/pr-preview/pr-1880/src/data/userPrefs.js\":\"8d3fa734e0836a21\",\"/knowledge-medium/pr-preview/pr-1880/src/data/userSchemasService.js\":\"36bd0ac313cb0796\",\"/knowledge-medium/pr-preview/pr-1880/src/data/userTypesService.js\":\"b37ed13c9e77498e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/valuePresetRegistry.js\":\"0f0618c7cbed219d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/visibleChildren.js\":\"b52120586693af5c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceConversion.js\":\"2f5b21489a1ea8ad\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceFirstSync.js\":\"405982a3a7d7754d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceIdNamespace.js\":\"78f4d31318936eef\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceSchema.js\":\"0f2e246d4a6cf96b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaces.js\":\"d9f46c63736dc1d7\",\"/knowledge-medium/pr-preview/pr-1880/src/data/writeAheadLog.js\":\"369f6a58470c46a3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/BlockPasteShellDecorator.js\":\"781fe200f94dd9b9\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/atTrigger.js\":\"c6305a8b679ba602\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/autocomplete.js\":\"36395ebdaf2af347\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/codeMirrorExtensions.js\":\"28327b5bd5858fdc\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/contentFlush.js\":\"f59aa3e6456581eb\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/defaultInteractions.js\":\"8b0284d80225e1c1\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/editSettleSignal.js\":\"07b7aafd9f189d2a\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/insertImage.js\":\"373c3a7238c38867\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/referenceCompletionRange.js\":\"e369e393f8f28ba8\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/referenceTargetTypes.js\":\"c2bc598a8a6d6e22\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/syntaxContext.js\":\"6574dffabf0314c0\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/triggerMatch.js\":\"1fd4b332621601c5\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/AppRuntimeProvider.js\":\"9556a22886e2ac53\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/BlockFocusShellDecorator.js\":\"c845509ae933f7f4\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/ExtensionRenderBoundary.js\":\"75c4c29d5b0595db\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/PanelContentRecovery.js\":\"a0f4f784a434fbbd\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/apiCatalog.js\":\"54d8af567d1ae224\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/approveExtensionHere.js\":\"e849d9a0094ea3ec\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/armedCutAppMount.js\":\"0f08b3e34a810228\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/batchableKeyedStore.js\":\"535a095c5a2414cc\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/blockInteraction.js\":\"0d3a63f24f57a366\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/blockSelectionAction.js\":\"3ccf3bb8f044ab5a\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/compileExtensionModule.js\":\"dff6b6f2a897bd12\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/compiledModuleCache.js\":\"59b9750d96f51393\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/continuousGestures.js\":\"1ab620429026e685\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/core.js\":\"2a655a68f42d2403\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/defaultRenderers.js\":\"5674c46bd1fcd4ec\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/definitionFanoutAppMount.js\":\"706d3516d0242042\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/dialogAppMount.js\":\"d34fbc81bf6d1d59\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/dynamicExtensionSeeds.js\":\"f28ff818ec07b0e6\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/dynamicExtensions.js\":\"c3e9a3b7335b77fe\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/exampleExtensions.js\":\"cde1f7fbd12384f7\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionApprovalStatus.js\":\"94237f10cd221930\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionLoadErrorToast.js\":\"3c5c1d398d008ec8\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionLoadErrors.js\":\"ebf9cb29092f9830\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionLookup.js\":\"89a09bffb5e29d3c\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionToggles.js\":\"0ebaf38f0e1dcec0\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionUtilitiesCss.js\":\"eac7d209ead40789\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/kernelPageDeletionGuard.js\":\"461614684beb3bc5\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/liveRuntime.js\":\"246df2c4fe3c2cdc\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/openExtensionsSettings.js\":\"00a1c23d17e9f192\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/overridesCache.js\":\"7f755ff28f283c7b\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/pluginIds.js\":\"a02d8575aa71d59a\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/processorRejectionToast.js\":\"6cc0af8920ff73fd\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/runtimeActions.js\":\"997f3fa708b75c44\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/runtimeContext.js\":\"5d2632639f1bfa36\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/staticAppExtensions.js\":\"53531529c9187fdf\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/staticDataExtensions.js\":\"b08ad05f0c3e4121\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/toastAppMount.js\":\"a48b5f551ca6eb6d\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/useOverrides.js\":\"84e90f344ab4ea44\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/useShortcutSurfaceActivations.js\":\"36bfec7b57d69000\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/discoverToggleTree.js\":\"ccb7e975f5903ab7\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/facet.js\":\"4b10ce04d0c813f1\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/resolveAppRuntime.js\":\"670d50f652c665d0\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/runtimeEvents.js\":\"0930a15815961213\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/togglable.js\":\"12f3def654221a78\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/variantFacet.js\":\"d679f6d2e61e1138\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/verbFacet.js\":\"f84bbf4cdd6660c9\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/block.js\":\"168fd946c700101a\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/focusedChild.js\":\"7077314dc6f6c33d\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/propertySchemas.js\":\"9018104169500026\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/typeRegistry.js\":\"a3190a4ac41ebf24\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useAncestorCrumbs.js\":\"395174606be708ba\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useAutocompleteListbox.js\":\"fd8a7cc4089328f3\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useDebouncedSearch.js\":\"a40f309e93115be5\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useDebouncedValue.js\":\"5fe808d23baf97d5\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useIsFocalRender.js\":\"adfb461cbfec42ac\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useIsReadOnly.js\":\"0ac3e4280a3f4674\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useMaterializeBacklog.js\":\"2c6cf0141d59a32d\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useMinuteClock.js\":\"33187819ad9c4e8f\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/usePanelLayoutProjection.js\":\"6fd251458658ef7c\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/usePendingInvitations.js\":\"28243a0a689c53d2\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useRendererRegistry.js\":\"3c6f8fddcb50bba1\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useRetainedFieldRows.js\":\"10c3469de5dc0271\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useWorkspaces.js\":\"8451de7a15c6f483\",\"/knowledge-medium/pr-preview/pr-1880/src/lib/utils.js\":\"4564b642cbad2d7f\",\"/knowledge-medium/pr-preview/pr-1880/src/main.js\":\"18c7f6efd4947586\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/MarkdownImage.js\":\"6a3b2c42a19f4dc8\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/blockSeparators.js\":\"60c30eb2a6c4b5b8\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/context.js\":\"b054995019d7fd35\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/defaultMarkdownExtension.js\":\"ce205c94c9cf8fcb\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/extensions.js\":\"993060d5b946a3cb\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/renderMarkdownHtml.js\":\"b5e116d54573d08d\",\"/knowledge-medium/pr-preview/pr-1880/src/minimal-editor.js\":\"2b38ea6e6064d4ac\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/armedCut.js\":\"a1d8b060a29d3e99\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/captureMediaVerb.js\":\"2ab348f773461c1e\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/clipboard.js\":\"98d0dbef1c403b4a\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/decision.js\":\"22a8563942e69e2f\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/operations.js\":\"0cedb7d0da061fe0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/account-header/AccountHeaderItem.js\":\"e51c740b441d0640\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/account-header/index.js\":\"e84cbfd6868d67ac\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"96e8c2cd8ef4b2b0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/askAgent.js\":\"4886b00b7b431e78\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/askedStore.js\":\"f2019c66e96cd2a6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"c79aa5e868070773\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/chipState.js\":\"1d69a48cd9b59c79\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/dataExtension.js\":\"116ecc8e9d67fdf1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/index.js\":\"9d11dda4bb86d821\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"227dc262a68fbbd1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/schema.js\":\"810c40109a6cb68f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/AgentTokensDialog.js\":\"fc33f01dfd013d51\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/BridgePairingDialog.js\":\"06bf3d07f7db2940\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/addMedia.js\":\"e7ffb39887e51f41\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/backlinks.js\":\"1cd90485cbe4ac5c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/block.js\":\"772a81609e2a44b7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/context.js\":\"e50bc0d3453cd498\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5156a02cbff027db\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/index.js\":\"3450c6253d784026\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/outline.js\":\"a664f259dadee7fe\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/properties.js\":\"8f6f559b2f1df96c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/refs.js\":\"37c56c819cc0e962\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"1ad6ac94c19c2fb1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/search.js\":\"e02467c94f6dfa6a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/shared.js\":\"92c64dedea20c33d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"dcbd602d17144f0e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/text.js\":\"105b7660209f3376\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentWrites.js\":\"12a4430055844ec6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/authoringCatalog.js\":\"e6035101a92ba962\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/blockRefTargets.js\":\"1499c60812cc6e9d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/bridge.js\":\"1b01c8e82d1de656\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/bridgeLoop.js\":\"9752a11e8b8b6275\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/changeHistory.js\":\"1e2e33dedeff64c9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/commands.js\":\"d410a636bd873a7d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/commentsCommands.js\":\"3d811be10deb4fde\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/dataExtension.js\":\"6d25a3665a6959cf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/dataModelGuide.js\":\"ca9a30ee43c8e5b8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/dayPropertyInputs.js\":\"6d4fd3adddf4a56c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/describeRuntime.js\":\"308156074b03dd4e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/extensionLint.js\":\"dc510dbaf6625b01\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/grainAudit.js\":\"23162393749b01e0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/healthCommand.js\":\"a9f92684221d5f23\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/index.js\":\"dafc1daee09a1482\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/presetIdentity.js\":\"d0ffc84dbab50ae1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a9eec7e7bb12ca02\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/readMedia.js\":\"2c8e34b725b172b2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/schema.js\":\"46e8e2a33afa5272\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/serialization.js\":\"fb38bc0de98d4aac\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/targets.js\":\"6de03cafc5ebd797\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/tokens.js\":\"07fd3a2105c8cf31\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/watchEvents.js\":\"e8975a0befae526b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/workspaceGuard.js\":\"90342226b8df23ba\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/writeCommands.js\":\"04e72da87331e0fd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/AliasCollisionToast.js\":\"63d9a29b00ff6836\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/DuplicateNameBanner.js\":\"10d2acd8759cf70a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/collisionMerge.js\":\"c060b6a7476f2177\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/dataExtension.js\":\"9d5a977c4e3b3f64\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/index.js\":\"ecf5e06e260fb2b8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/mergeCollisionAction.js\":\"e6fb57321ac9bc6e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/pageStyling.js\":\"9bb33c15ef777977\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/rejectionToast.js\":\"f8e4704aa408de5f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/syncProcessor.js\":\"1abafa718463f8b2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/actions.js\":\"ac50753d4cdad530\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/addComment.js\":\"6b3c2ed52bb4d502\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/anchor.js\":\"9862d8b91c22e460\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/anchorState.js\":\"f42ef61a79f0ffdb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/commentLinks.js\":\"767e2a56c13cbe6c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/confirmThreadDeletion.js\":\"3ebeb4791d4529c0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/container.js\":\"3566950dbd7ca3d5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/dataExtension.js\":\"0ec51d90f537e4ec\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/deleteComment.js\":\"08921f941fb884d6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/highlights.js\":\"8fe7297cf5ec56f7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/index.js\":\"b6bae0f5745b10eb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/linkedCommentsPill.js\":\"c2b96556b41d69f7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/margin.js\":\"f0687b14b0378ce1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/marginAnchorLinks.js\":\"1d7b871a538b5d8e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/marginSchema.js\":\"0e78d6be76e874e2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/newComment.js\":\"450f7b5eba8e95c0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/ownThreadPicker.js\":\"40b80d1d731e8460\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/placement.js\":\"aef480284422d232\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/queries.js\":\"de5594df7a386d99\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/quotePosition.js\":\"d1397533351e2fb7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/quotedIn.js\":\"f6e9588c0b7fa8cd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/quotedRange.js\":\"d6c5b612648bc380\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/rangeRefs.js\":\"a6ee4d756e83b1b9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/readHighlights.js\":\"d2409426ed64adb9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/readSelection.js\":\"58324a60cbaaba96\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/readSelectionUi.js\":\"2233e578b4f33572\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/reanchor.js\":\"bdf3e01e0d91d7db\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/schema.js\":\"8e791093b7679fc9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/scope.js\":\"80d28e099917249b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/scopeThreads.js\":\"cf37e374e627e496\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/splitRetarget.js\":\"ed842cbd58644c53\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/suggestionCard.js\":\"b1b801c79a0dc1dd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/suggestions.js\":\"e59bb6cb32a9fd3d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/summaries.js\":\"b963ff2ab7f4e8db\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/summaryBatch.js\":\"7bf0b4f93713d9bf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/surface.js\":\"910eed1a53f86dae\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/threadNavigation.js\":\"d26a81214d0076cf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/threads.js\":\"35e53eeb71056485\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/ui.js\":\"1180dc26a21a96a9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/uiStore.js\":\"23df36f199e6a26b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-intents/appIntents.js\":\"061c180d4493fb51\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-intents/index.js\":\"07d17312905204d5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-update-prompt/index.js\":\"636640ec7282abae\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-update-prompt/status.js\":\"8e0ec742a92ba826\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"4980f7035e61a5a0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/MediaBlockRenderer.js\":\"a642a4b980c548c1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/MediaDownLaneReplicator.js\":\"bd5bf7948fe77675\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/MediaUploadReconciler.js\":\"fbe766ae887a0ade\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/assetDownLane.js\":\"b6f26d17626a6263\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/assetResolver.js\":\"3f9e3c6dbd3af551\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/assetUpload.js\":\"98d094cbfb05a789\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/attachmentCleanerIO.js\":\"545f6b5b74591ce7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4ded6082d24867ee\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/blobStore.js\":\"b1cf5856c00bcf11\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/browserMedia.js\":\"b08cea3877888f56\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/byteStore.js\":\"f75c77616f06218c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/cleanerIO.js\":\"e648743855e454e4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/cleanupAttachments.js\":\"428b4a39910adf7d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/dataExtension.js\":\"c45aba0498f858a2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/downLane.js\":\"daef0802df7bc84f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/index.js\":\"73bca7b76ecd0598\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/insertImageContribution.js\":\"c4db8b4c8bc755df\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/laneArming.js\":\"1855a74d84fe58f4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/laneLock.js\":\"c5954b11906efafb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaBlock.js\":\"28fcc4060ec7661d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaCapture.js\":\"92b2713491c1a082\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaLanes.js\":\"236d88dc541fdb13\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaViewers.js\":\"6e671203be868334\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaViewersFacet.js\":\"3c46ec1fc86ccd49\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/pasteCapture.js\":\"4c0d153f0957ee2e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/resolver.js\":\"150bf67763dbb5f3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/retryUploadsAction.js\":\"56be0759d821a152\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/storagePaths.js\":\"e46667fba792373d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadDrain.js\":\"556d0be51e9dba0a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadLaneStatus.js\":\"e900b81ac30a73e9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadReconcile.js\":\"3e806b250c394d29\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadRecovery.js\":\"23c3aa3c4db1fc5a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadStore.js\":\"d644aaeaba6e9b62\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/useAssetObjectUrl.js\":\"0d0721355116e521\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"4c230db42fe2b167\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d20c4565c147dbc6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/facet.js\":\"9c08e1fbc94e3fbe\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/index.js\":\"8f145f665a59774c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/prop.js\":\"eb1e3f44d348ec0b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/BacklinkFilters.js\":\"baa6e5ab20e5f066\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e565243c65cb2075\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/BlockEntry.js\":\"8c090f766a641bb1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/LinkedReferences.js\":\"9e8eaf14bd229f2d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"99b0085536b4f802\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/dailyNoteDefaults.js\":\"0c1078d5f0e3ac04\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/dataExtension.js\":\"3fbe90757b961bf2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/edgeExclusions.js\":\"ebfef5468d243602\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/filterProperty.js\":\"ce05db3d60e29ee8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/index.js\":\"93faa7b4b31e115f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"98cf63cdefd0b895\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/applies.js\":\"7a4302589eaa1b30\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/countQuery.js\":\"ae1098456d2f904a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d67ea9c624861c23\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/index.js\":\"dc951eae6003deaa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"c4fc05cc7a26b6ee\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/presentationInvalidation.js\":\"9082d5026c5aa7e4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/propertyEditorOverride.js\":\"73faeceb8e69515b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/propertyFilter.js\":\"f7fece8293a99750\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/query.js\":\"9fd407e9e0bb0c1d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/resolveFilter.js\":\"39ff8a378d085a48\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/sourceBatch.js\":\"9b05e01de94e081d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/sources.js\":\"a10279a612dd34c3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/useBacklinks.js\":\"46f472e796cca19b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"48e972652d3dbf14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/BirthdayCelebration.js\":\"a9e8a2b5e51cb635\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/BirthdayOverlay.js\":\"7e76cd0432dc680e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/gate.js\":\"f3dbac29fc3397c3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/index.js\":\"2cc60d82904dca37\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/wolfTheme.js\":\"b4ebb67279f5249b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/BlockDragLayer.js\":\"3f5e2a716c762ce9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/dragController.js\":\"5bc3ab19248d010f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/dropTarget.js\":\"1f9ff027379a4325\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/index.js\":\"0923785c260960c4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/projection.js\":\"57f902dee63ab611\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-info/BlockMetaCard.js\":\"bb1ec13489b3ee17\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-info/index.js\":\"fc59e4718b357f32\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/AddTagDialog.js\":\"b69822f5b6741637\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"dad3ae806f586a77\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/TagNameIssueHint.js\":\"9de883a7a35af476\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/addTagAction.js\":\"6196b31df376b0c9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/appendTag.js\":\"008fbafe4cb33c84\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/config.js\":\"80f1983bd8898750\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/dataExtension.js\":\"b382a3a554263cb3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/index.js\":\"7c30d1ac7171f325\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/propertyEditorOverride.js\":\"8b442fba471cb46c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/BreadcrumbList.js\":\"1801f09d8736c386\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"59d579c40a0dafc3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/Breadcrumbs.js\":\"9fd4659e7ee1f1d3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8d5ce147b8041638\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"7eaf3af9142daa79\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/index.js\":\"8599a9289bc6b6c5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"e74d516541bf9273\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/CharacterCountItem.js\":\"f0118db7612f4984\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/ProfilePropertyEditor.js\":\"ef4db2969ef72e38\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/actions.js\":\"67ef8b0baed07299\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/blockType.js\":\"1db5ab78a28d8126\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/charCount.js\":\"5c7b4d3a0f62a9f0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/dataExtension.js\":\"49301bf488e6eb00\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/index.js\":\"69ab845d698667bd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/profiles.js\":\"9336f5cf07b91f05\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/properties.js\":\"0caeccdc97c274b9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/textCounts.js\":\"61792cb4084ee8db\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/colemak-keybindings/index.js\":\"8d928876e0285b1b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/CommandPalette.js\":\"d8761f1f919ce11c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/HeaderItem.js\":\"c43c1ffcf24ad2ee\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/context.js\":\"80d5db5abd787737\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/index.js\":\"405f61c934c18102\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/selection.js\":\"ba37b842d45e3fb6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/toggleStore.js\":\"ffb8f02939653853\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/useCommandPaletteActions.js\":\"028f12e9a47376ff\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/ContributorBadges.js\":\"c1e8c58cf6063a89\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/author.js\":\"382622391aa25327\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/codeMirrorExtensions.js\":\"b4b4337b075ae7a5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/dataExtension.js\":\"86dd0b8a01eb8557\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/index.js\":\"445542ef6f7f6003\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/mentionAutocomplete.js\":\"11209e533487d507\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/processor.js\":\"321c2e3b0048a75f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/profiles.js\":\"34e4726ca9ced3f1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/queries.js\":\"cef44def6a7bbffa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/schema.js\":\"256f174a6fbaedb9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"578626d8209b5f67\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/followOrigin.js\":\"502662927ce8fc27\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/index.js\":\"0119cf05569f9d01\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0afff33efc5f4205\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"fc248d9206abc321\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/CalendarGrid.js\":\"398196ffc72a3eaf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DailyNotePicker.js\":\"bfa5f5a796cc590d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9adac18b0b13087e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DateNavDecorator.js\":\"e01313b36efea430\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DateScrubOverlay.js\":\"195ec01ca30b3b95\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DayPropertyEditor.js\":\"41775da3c9979f67\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/HeaderItem.js\":\"93aff349424b513e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/ReschedulePicker.js\":\"628fbda0df10b683\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d5cce180be9e888f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/actions.js\":\"2580fc7c1ed7bbc7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/blockDateAdapter.js\":\"e79957288ccfc973\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/calendar.js\":\"7f73cc29359b9665\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dailyNotes.js\":\"f90708bc5feeffc1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dataExtension.js\":\"44da5daa29851ece\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubActions.js\":\"4c471312f084bf16\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubGesture.js\":\"c2e189da19453fe9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubGestureActions.js\":\"ece800479e853d82\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ae516d2f871242e7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dayProperty.js\":\"82a2ebc3bb21aa88\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/deletionGuard.js\":\"26c7b12b394e97f6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dueQuery.js\":\"4e83dca0d1b3938b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/index.js\":\"b06baafd53a69b0d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/landing.js\":\"d2228575a8f6a624\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/localSchema.js\":\"bef624da4ac268de\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/referenceDateAdapter.js\":\"6f01ad08362d3a39\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/rescheduleAction.js\":\"0201af64bb0431b2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/schema.js\":\"2e68f2b6fb2837fd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/spreadBlockDates.js\":\"0758c8c3a033b260\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/spreadDatesAction.js\":\"4be3328127340f9d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/today.js\":\"bed10757ef3d523b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"5b7871db9bb0b0cd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"945b4e200842d52a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/audit.js\":\"89df8a1b6bf24a5e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/auditAction.js\":\"987d72120cfc8ec3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/auditRanges.js\":\"abe41154607712dc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/diagnosticsSource.js\":\"0cb2a990f3a63485\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/divergenceScan.js\":\"4d5fd146eead69ab\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/index.js\":\"26cb76dde59954a1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/propertyChildrenChecks.js\":\"875c864888cf6ddc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/referencesMirror.js\":\"13a0bedb583428c5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/rowJson.js\":\"b69b1b66bf1326e2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/schedule.js\":\"5fb4bc81bd1e53d5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/store.js\":\"68b02b08c933ba82\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-maintenance/action.js\":\"3bb350a0b20c14b2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-maintenance/index.js\":\"5b9d407845304652\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-maintenance/plugin.js\":\"e3a1dc592f03264c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"60761b4b490fe0b7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/actions.js\":\"bdaf1d46ec3ca9ca\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/changeMarker.js\":\"2ae4c537eb7abb40\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/diagnostics.js\":\"e41479dfdac75dc2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/fileSystemAccess.js\":\"7f6886a27854b92e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/filenames.js\":\"1957c3e67dbc221a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/index.js\":\"a93eed28bbc264a9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/mirror.js\":\"c655f8e6b88528a3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/runLock.js\":\"6aee72ba53213b4f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/runtimeHealth.js\":\"4b6c6d4cae787c67\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/schedule.js\":\"1cc0ea482be011d4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/store.js\":\"30308f86519e530c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/default-themes/index.js\":\"2940859479ac5cd5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/default-themes/themes.js\":\"31599da2375104c2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/diagnostics/facet.js\":\"cb8df1aca8527263\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/diagnostics/useDiagnostics.js\":\"e0041500491a8d44\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/dismissals.js\":\"8927257c2803b309\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/index.js\":\"23ac3d7ab6c8a2fd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/status.js\":\"1e4a1b2df7ec90ef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/store.js\":\"ce32d5a6ed2b79e3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d6064f6dc2fd796b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b18f3508a00a1c8a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/actions.js\":\"7751ed68fc2b97c9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/config.js\":\"8836644f915cc696\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/dataExtension.js\":\"33f81a65ad35610b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/effect.js\":\"05fa1855a4615f50\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/index.js\":\"89776953c19027ac\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f031cb5f578caef1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/useToggleTree.js\":\"2204f9c1b655f8d3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/ExtractTypeDialog.js\":\"561fe05ca9966a1b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"af6dc9956fd56a9b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/PropertyShapePicker.js\":\"04c14fe86fa5aa22\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/action.js\":\"6e39f3dcd49825b2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/index.js\":\"60a993a0fc8f9fe3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/FindReplaceDialog.js\":\"8bac512f9082e4d9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/HeaderItem.js\":\"794ee0900f3236dd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/dataExtension.js\":\"fffae29127b7b62e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/index.js\":\"16791a4532c809ab\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/search.js\":\"0d7663874409e6dc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/toggleStore.js\":\"3554e36fe7767f9c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/LocationPropertyEditor.js\":\"fccbb910e2c30b9f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/MapView.js\":\"cf7e42cc02ea96d7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/blockTypes.js\":\"7554519748ec917d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/codeMirrorExtensions.js\":\"0aa698c10f20a52c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/createOrFindPlace.js\":\"ea741e9ac23282d9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/currentLocation.js\":\"4ce0c161042ad19b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/dataExtension.js\":\"28f0e54d715bb9d2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/geoContentDecorator.js\":\"6e267b0e0a85cbaf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/googlePlacesClient.js\":\"62b27dff7868020b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/index.js\":\"6861f93e869808ec\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/locationsPage.js\":\"69efe818566a00a9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/mapViewport.js\":\"e6207c782a836e13\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/pickCurrentLocation.js\":\"2e654e39c68d11a7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/placeAutocomplete.js\":\"26930bfca76cb8e5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/placeNameCollision.js\":\"e67610ebccae7b1d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/properties.js\":\"18cf74644d49976f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/propertyEditorOverrides.js\":\"c965143dca5b7438\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/query.js\":\"86e0b7716b6e4de6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/usePlaceSearch.js\":\"02f2da82adb68478\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"987b7929d3b37009\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b91a5e759e84a850\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"f5dd957b8f574dc9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/config.js\":\"bd31b30900e1bf1f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/dataExtension.js\":\"78d4a3f2cddf51d5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/facet.js\":\"a40a7b33df8d565c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/grouping.js\":\"68d07bf729ced5b2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/index.js\":\"54844278791a8830\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b4b0ebf33513e1ac\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/query.js\":\"51c16ddf8f371c87\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/resolveConfig.js\":\"566cc30915b3f31c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"f2a136421656e5e4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"46c6ddad0f5f0799\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/HtmlDocumentContent.js\":\"58bd314d97cba594\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/HtmlFrame.js\":\"50bf0b8bd57aabc4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/actions.js\":\"e649e0efc9023013\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/blockType.js\":\"8b69e16792dbdb31\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/confirmRunScripts.js\":\"8a9ac0a397452b30\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/dataExtension.js\":\"6c24cab0d353cf5f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/frameAnnotations.js\":\"96bd734f46839301\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/frameDocument.js\":\"dfaeb50d37f65a6a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/frameTheme.js\":\"cade20bc39ef33be\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/index.js\":\"82e76f184d8c6893\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/scriptConsent.js\":\"56c83a536c8bd1a3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/sourceMap.js\":\"60225e942f0dec76\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/useDocumentScripts.js\":\"ea21d8b3dd5a726e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/index.js\":\"1010313568f6b353\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/record.js\":\"1e2a5682b100571d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/recordStore.js\":\"f1e242eaa866c7eb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/responsiveness.js\":\"eaeed3eedaa223a2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/schedule.js\":\"8a31d8cd2d74870b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/sessionContext.js\":\"148624f9c4f995b8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"4a81f8df6d414336\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"255d0d18f62c47fe\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/actions.js\":\"2a674e7d11e7c1f9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/config.js\":\"ac0d7aeb86d5c45d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/dataExtension.js\":\"2cd2010dcd22acbd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/effect.js\":\"5bdbe7299a5f58c9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/index.js\":\"9b9840f5a9927bf2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/keyCapture.js\":\"4143707c373c6d0f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/overrideStore.js\":\"9aeba0b02461452c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"cc01becefe01f4ff\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/HeaderItem.js\":\"215eaf47a25ea6bf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/LeftSidebar.js\":\"f29665a487f6cf23\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/actions.js\":\"4d477cd134ab33cb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/facet.js\":\"7ddaf95c54509d2a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/index.js\":\"9eef2dbff104e723\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/shortcuts.js\":\"aa2fb48b632a8f43\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/toggleStore.js\":\"6ef938d6cebd9666\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/MergePicker.js\":\"27271794831d1fc7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/index.js\":\"40ca51fae493489d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/mergeAction.js\":\"2427b3605421754d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/strategy.js\":\"2624ab3bb962e113\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/Button.js\":\"b8445af2cdd6a2cc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1c288d34d61a3a1d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/defaultItems.js\":\"dd98df3ff2416b96\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/facet.js\":\"607d348bf6ae90da\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/index.js\":\"aa6f134fb43949f0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b82652fe4b67462f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/actions.js\":\"3e32b7e59876f3e0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"48b98f411d941d0c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/facet.js\":\"2e9f28dd6f21de5b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/index.js\":\"a6ab3ed9554433b5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/MoveDestinationPicker.js\":\"d95d15a5af36bc20\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/blockSubtreeMembership.js\":\"77cf759b9130efd0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/contextMenuItem.js\":\"a0cca8edbfbc3109\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/index.js\":\"57aebaf5d8060dd8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/moveAction.js\":\"43143542c4d06989\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/moveBlocks.js\":\"0ca290b786a482dd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/selectionAfterMove.js\":\"16795b28e301b6ff\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/TutorialBanner.js\":\"f562711b3c5a86a8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/action.js\":\"1b92d9ea441191fc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/bannerDismissal.js\":\"46b365204cf75d5a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/documents/cheatSheet.js\":\"784d2893c4f3a825\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/index.js\":\"b43018676e71dbd5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/keys.js\":\"9e399484e26be766\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/landing.js\":\"1c98990be533920e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/outline.js\":\"62e404f3ab3a7576\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/seed.js\":\"303bd8cec6a5e6e1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8748b529d82cf0a2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/analyze.js\":\"06870ad377baaccb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/diagnosticsSource.js\":\"eff18b6c044e1658\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/index.js\":\"6ee93f7348d75149\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/load.js\":\"c8292fb04f5c107e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/monitorRun.js\":\"ac57b230266aaa70\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/schedule.js\":\"ecb141532b18a420\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/series.js\":\"75b241742129cfee\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/store.js\":\"3f56742d0738661c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/trendAction.js\":\"19566d259866cc3d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/verdict.js\":\"16cda027793ead6e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/plain-outliner/clickToEditAction.js\":\"97383bc6830713ad\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/plain-outliner/index.js\":\"1fb79312d9a7f816\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/plain-outliner/interactions.js\":\"d3f403c3fd3a95a4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"fd3b3536ba300368\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/MigrationGate.js\":\"7a722fe3ec04f804\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/MigrationGateDialog.js\":\"7c2f0ae46daf25de\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/action.js\":\"85075a7a83926fc2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/index.js\":\"d6be8c9643993b1c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/localRunMessage.js\":\"ce095c8f52e47ee2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/plugin.js\":\"4ff1e16bfb5a080f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/progressReport.js\":\"ab5af73c5b1f1300\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/sweepProgress.js\":\"8475b79d846f32ea\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/FieldRowRenderer.js\":\"062bf937b37e7223\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/ValueRowRenderer.js\":\"1c12ed2a5e340096\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/actions.js\":\"23d60b0f8070912b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/autocomplete.js\":\"6b10e5dea02bac68\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/fieldRow.js\":\"7cd50906b7527cd5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/index.js\":\"90124b9ddedfa0e7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/referenceWarning.js\":\"0f13bc4b259436e6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/valueAutocomplete.js\":\"e990a0224f1643f9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/valueSchema.js\":\"bbbe8169ab16219d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/HeaderItem.js\":\"500f90e895f3e17d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/QuickFind.js\":\"9faa6c815b72b2d6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/index.js\":\"99f6ddc0c8001f82\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/recents.js\":\"e9fbb377374401a9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/resultItems.js\":\"64b9497876b5ec75\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/selection.js\":\"495a54239c40cdc1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/toggleStore.js\":\"29dd237217150abf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/HeaderItem.js\":\"1248a92108a34eb7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b49ee576651f4f0b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/grouping.js\":\"5d555907b90086c7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/index.js\":\"71d338dd4b132fbb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/target.js\":\"ea385c1fdb1f7890\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/codeMirrorExtensions.js\":\"7dce7d92e73c79e5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/contentPrefill.js\":\"7a8ab2c99d3e06de\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/dataExtension.js\":\"823bd7d97c53fa7b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/index.js\":\"43d6e614d8a384a1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e97ae1efae576866\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/invalidation.js\":\"f4532933a7c63db7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/localSchema.js\":\"6119e8358a968bb6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/blockrefs/index.js\":\"91ca43b11ebb053a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"624be1360daa8458\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/index.js\":\"a85d738dd89d92cd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/referenceNode.js\":\"640b8ed3da0f3063\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b65730a9df598f0b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a6d5ea5bfb2ad39f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/index.js\":\"7e5029c1a9e7c6eb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c61aca7d5cafc18c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"8422371f4b05383b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/mergeRetargetProcessor.js\":\"ffa1c398bcb6ada4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/parseFence.js\":\"cd42134f420374e5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/referenceParser.js\":\"bda4e593bc7fcf73\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/referenceProjection.js\":\"30863a98671da110\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/referencesProcessor.js\":\"cedfb4e23e1b2399\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/renameProcessor.js\":\"a415ddf97b434aa7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/spanReplacement.js\":\"a78468d144ff8314\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/htmlToOutline.js\":\"50dee47108745850\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/index.js\":\"5d4120d29f0768c1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/normalizeClipboardDom.js\":\"269326c4e4b02696\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/pasteDecision.js\":\"e1fb6c73444479a9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/action.js\":\"134406942da336c0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/blockIds.js\":\"47b70cd4793cf061\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/content.js\":\"ca0592a9da045433\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/effect.js\":\"86b331c17962fde4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/ids.js\":\"1359f5871caf0ec8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/import.js\":\"6f13733391ff37a7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/index.js\":\"eef79379cfc0051f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/plan.js\":\"6d7ad79af6b621af\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/plugin.js\":\"b95c874902dc1435\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/promotion.js\":\"57c813b7a17eed46\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/properties.js\":\"0a10a798cd330ffa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/references.js\":\"7268dc8b6d158540\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/report.js\":\"e4008e4b4e2424e5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/roamMemo.js\":\"bc97d06b6ba41a9c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/runtime.js\":\"a94dc7474ccc3439\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/schemaReconciliation.js\":\"258a76a8f5df10bb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/srsMarkers.js\":\"413014cc1a4ed37f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/todo.js\":\"161a65dc82e191a7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/typeCandidates.js\":\"d6df9c81ce2f3a4b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/types.js\":\"bfdd5285e4a7646f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/search-health/index.js\":\"837a2ac59673b979\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/search-health/store.js\":\"ae11cc822f8a46a4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/HeaderItem.js\":\"c83f1a4286c33a15\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a67e6ce94c81115f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/index.js\":\"d6ff569b7683ef58\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/model.js\":\"ed7187394e3f0a1b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/toggleStore.js\":\"26f2e0660d14d9c7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/useKeyInspector.js\":\"a236782fc6961fac\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e7082abe09337a4b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/ShellDecorator.js\":\"524a802c6dbae0b1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/actions.js\":\"613778c2d4f173aa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/exclusionsFacet.js\":\"693abf93bb509908\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/index.js\":\"e8cbcd652f3b86cd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/shell.js\":\"a149d16d8c65fd53\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/surface.js\":\"60a93bc9c5acae39\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/walker.js\":\"c077e238fb357fc0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/RescheduleToast.js\":\"54ee66a2bf0c3415\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/dataExtension.js\":\"0cc36999a49233cf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/index.js\":\"d72a3ab4d673ec4a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/indicator.js\":\"d6bb8984aeb15077\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/moveSrsState.js\":\"b6bd6abb473889e9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"309dd9ba2449d40e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/scheduler.js\":\"f7cc916fd630d89e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/schema.js\":\"817400275747a454\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"cca2380ad6296acb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/srsClipboard.js\":\"f48116e1e69aa82d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"33790e4575f64a71\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/DailyNoteReviewHint.js\":\"984011ebb0660318\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/DeckPicker.js\":\"e41639ce942fdca3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/ReviewControls.js\":\"9d2e0a5eacdbbdfd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8a8e00b2c649feba\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/ReviewSession.js\":\"09b24502ecf2b515\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/actions.js\":\"f8ecf367d0d21a91\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/archive.js\":\"4fa9ff6158ead2f5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/dataExtension.js\":\"424358654273ca71\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/deck.js\":\"bca257b4501a8691\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/dueQuery.js\":\"91a39d0fdf30e58a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/gradeDecision.js\":\"c45aa2571a4eeb23\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/index.js\":\"a5dabf3368090a3c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/keyHints.js\":\"076fcfff5931f7f1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/reviewCardLayout.js\":\"ba785647dea77971\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/reviewProgress.js\":\"67e6f6b652271bfa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/schema.js\":\"717bfdaec25f049c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/useDueCards.js\":\"0ff1fa8b32e697bb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/startup-metrics/index.js\":\"8cf828d4be3b58d3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/startup-metrics/record.js\":\"609e112f8c386599\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/storage-persistence/index.js\":\"00927d3cbc835070\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/storage-persistence/persistenceStatus.js\":\"644b821c01a3c4fd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/storage-persistence/requestAction.js\":\"12394bd97e4bf2c8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/TypeChipsDecorator.js\":\"e8f17a50d05e34c5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/codeMirrorExtensions.js\":\"f53e97be65ac7b6a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/index.js\":\"45d52f64d09e56df\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/typeAutocomplete.js\":\"878d2447a5468baa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d03a96cf01e8bc63\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/actions.js\":\"1cf67712e14928e4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/anchor.js\":\"cb5b95a2bad3fa2f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/events.js\":\"434f0b5c32353dc2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/gestureActions.js\":\"7a76e7de4004dcf3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/index.js\":\"7d29491f1476e955\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"2eb3bbe33c967793\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/sync-metrics/collect.js\":\"7ca0c1f2d867d2e3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/sync-metrics/index.js\":\"65f425a785ffb4c0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/sync-metrics/record.js\":\"f152550a965b55a5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/RejectionDialog.js\":\"b52ce423a2cc4ad9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c9c5672f8a16100b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/index.js\":\"85fc752e2c7883e2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/model.js\":\"10cb01c8ea2fd092\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/queueCounts.js\":\"f03cd4cfadbfcd8b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/rejectedHelpers.js\":\"c9e43fa570f58b1d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/rematerializeAction.js\":\"fb2266b9a7fd9f62\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/useHysteresis.js\":\"f2d001cd3826af97\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/ColumnHeaders.js\":\"58235a4e12c2621f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/QueryUi.js\":\"70be2cc83565e846\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/TableLayout.js\":\"495fec87218714a6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/actions.js\":\"1424f5cc3d127587\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/cellEdits.js\":\"4840484519869291\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/childrenViews.js\":\"70fb9476f48e9af6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/columns.js\":\"40feee7d52e143e5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/controller.js\":\"74f6e0a88922ce0e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/convert.js\":\"d55ebc9cfe383238\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/dataExtension.js\":\"e04c01857e902903\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/index.js\":\"ff9a3a8213f3ab4a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/keys.js\":\"b0b2c9acb9f22e51\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/model.js\":\"149d3effee469bf1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/backfill.js\":\"7ca011f24bebe5ea\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/completion.js\":\"213afaeab741ed50\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/format.js\":\"c2c6178688b8b768\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/parse.js\":\"0b0768a5d686ca6a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/queryValue.js\":\"7f4b72406c97e763\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/registrations.js\":\"4281b820a0bcd419\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/source.js\":\"691a3b1e7ebf8a00\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/registry.js\":\"fb0486b54ff64dc5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/rowGutter.js\":\"b1742144059db1e6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/rowVerbs.js\":\"7ca6bb0b19f619e0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/schema.js\":\"c2468b1a9d79b542\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/sort.js\":\"4e0533f12d3b87e3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/theme-toggle/effect.js\":\"fb4c46c848c6cc28\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/theme-toggle/index.js\":\"c0498320a5a9c34a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/theme-toggle/theme.js\":\"da8f5ce5ca9e9c11\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/actions.js\":\"50f17d773e55fb03\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/dataExtension.js\":\"46aba4d17eeff15d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/index.js\":\"2e766d07b2efae75\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/schema.js\":\"4960ec15590a69d2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b6662f241e2f441c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/actions.js\":\"9a21308b2fae35d2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/defaultItems.js\":\"1dd7c52f14a9e1ab\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/facet.js\":\"58a2c8b318550693\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/holdRecognizer.js\":\"61f1cfc035fbbce0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/index.js\":\"c8414fc10146cea2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/update-indicator/UpdateIndicator.js\":\"09db6a918771e3b9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/update-indicator/index.js\":\"3b9f3123a7e3cd5b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/update-indicator/loadTimes.js\":\"510d655f78168ab9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/VideoNotesRenderer.js\":\"c9d9bbb0a61ff038\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/VideoPlayerRenderer.js\":\"86719790b86d65f6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/VideoTimeStamp.js\":\"e301b5db37214bbb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/actions.js\":\"9fcf6d5d08e2a80f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/index.js\":\"4a70735d1cc8fedd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/markdown.js\":\"325704f084526b03\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/notes.js\":\"ddefd8bcc94d7f9f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/registry.js\":\"3a7338c41206a3ff\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/remark-timestamps.js\":\"d457c71339544932\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/view.js\":\"2e5c4f4460672574\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/LinkHints.js\":\"4e4033fd0849f593\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/index.js\":\"46496995d2149e24\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/model.js\":\"8eff4e6c9aaf4535\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/settings.js\":\"994e110fbb863e5d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-normal-mode/actions.js\":\"dbc7f66b34a25e84\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-normal-mode/index.js\":\"e5e2a29b116f5d43\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-normal-mode/interactions.js\":\"70eeb26b652efc93\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/workspace-header/index.js\":\"8b0877d33aa9c3af\",\"/knowledge-medium/pr-preview/pr-1880/src/registerServiceWorker.js\":\"d9ed63ec33eed270\",\"/knowledge-medium/pr-preview/pr-1880/src/requestPersistentStorage.js\":\"067cc634d948d370\",\"/knowledge-medium/pr-preview/pr-1880/src/services/authRequestDeadline.js\":\"fe0b05469d9a2f91\",\"/knowledge-medium/pr-preview/pr-1880/src/services/authStorage.js\":\"19431061e9a7a6dc\",\"/knowledge-medium/pr-preview/pr-1880/src/services/powersync.js\":\"e16e7982d2c34470\",\"/knowledge-medium/pr-preview/pr-1880/src/services/supabase.js\":\"20f23224987c12af\",\"/knowledge-medium/pr-preview/pr-1880/src/services/uploadErrorClassifier.js\":\"af961eaa9877b537\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/ActiveContexts.js\":\"99fd7601f44ba558\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/HotkeyReconciler.js\":\"2d21f69228603f6b\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/WipeLocalDataDialog.js\":\"2f8f32b49a213910\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/actionDispatch.js\":\"48b75a835f267fcd\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/actionRefItems.js\":\"fe9ec3ba4d664c6e\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/applyKeybindingOverrides.js\":\"0971c33f1da5e1ee\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/blockActions.js\":\"7d150e4bcc5eb60d\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/blockMergeGesture.js\":\"3a446ffb333398a5\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/canonicalizeChord.js\":\"a04d20bd7dcac491\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/defaultContexts.js\":\"6915f2d5a9eef11b\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/defaultShortcuts.js\":\"66447ad635dd5fc8\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/effectiveActions.js\":\"199aab94879ae772\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/gestureAction.js\":\"7c26529e832eacec\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/gestureBinding.js\":\"8de21ee9e0f04d65\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/holdRegistry.js\":\"581fbd1f722c63d5\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/keybindingConflicts.js\":\"fe57ea21f4257b4e\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/keybindingOverrides.js\":\"d9d0205db917124b\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/pointerAction.js\":\"bb91c4be4b2a095b\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/resolve.js\":\"c28e3e3e92786507\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/runAction.js\":\"1ce8a68b449112e5\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/sequenceMatcher.js\":\"17628717adb38c45\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/types.js\":\"5cb7a61292a92a81\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/useActionContext.js\":\"56ca839615099b5d\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/useActionDiscovery.js\":\"d3ee4abfc43dc761\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/utils.js\":\"059be727051d4a5f\",\"/knowledge-medium/pr-preview/pr-1880/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1880/src/sw/bootStore.js\":\"3d0b5684163fc9a0\",\"/knowledge-medium/pr-preview/pr-1880/src/sw/previewDatabases.js\":\"d474822f3325c1f1\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/byteTransform.js\":\"3ad527cddfbb1460\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/attachmentCleaner.js\":\"c77e47ac37d4b449\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/attachmentParts.js\":\"415eb164f8f2d032\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/bundleParts.js\":\"cf97274673128fc4\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/bundleRecord.js\":\"68be0b1b2c1a8643\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/manifest.js\":\"ee4a9c8c441a9856\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/takeBundle.js\":\"71937a5a6cc1a87d\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/verifyBundle.js\":\"2693db82d9cba14e\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/cleaningStage.js\":\"d2bdb7f54ba9cfa8\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/conversionKey.js\":\"a9436857f53f7703\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/conversionServer.js\":\"0bf9a7b3e2b43a15\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/flip.js\":\"86073560ebe9ed8d\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/flipAttempts.js\":\"5bfc87fa367bd341\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/pages.js\":\"7c268d634c91e6a8\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/preflight.js\":\"6c70921a650276f5\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/reseal.js\":\"8b31edbc0d07d7e8\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/runConversion.js\":\"9fcba66b7f574229\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/runLock.js\":\"35a0e98cf02fc513\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/sealing.js\":\"625208382ef23087\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/sealingStage.js\":\"68c31dd39282641e\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/stage.js\":\"42996e3af1b82a5b\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/verifyReseal.js\":\"a251bafc3cca363d\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/aad.js\":\"57d1f55e9d999eb5\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/aead.js\":\"131dc5a9a68d1c6e\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/base32.js\":\"daa972e372db1a47\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/base64url.js\":\"8d6ac4b1fed97072\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/binaryEnvelope.js\":\"8c78d397511f5cef\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/byteAead.js\":\"91b83e31229111ba\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/canary.js\":\"a241c5e722ca992f\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/contentHash.js\":\"5e5e790eae84f644\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/contentKey.js\":\"f94fec038a1af942\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/derivedIdNamespace.js\":\"8ba2991566a6e0f1\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/envelope.js\":\"dcd7e10e5cf2fea5\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/hex.js\":\"99505ef4c1d4524a\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/sha256Hex.js\":\"8d524e8ed39e75e1\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/workspaceKey.js\":\"fe39b52216944b15\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/conversionState.js\":\"14549f1f10dd4c3a\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/createEncryptedWorkspace.js\":\"16f89e2a1f045bb8\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/pastedKey.js\":\"52bf4f7927484327\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"d98e72ac8b10d8af\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/upgradeWorkspacePin.js\":\"f3219d2a95a66d69\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/keyStore.js\":\"cd59e7197ec5bdf2\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/mintWorkspaceKey.js\":\"9b81c493d82d66c2\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/modePin.js\":\"2e64df36b1fc41f0\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/openWorkspaceKeys.js\":\"aefe6619055270bd\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/resolveWorkspaceEntry.js\":\"8b9a255a7c694f17\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/resolver.js\":\"fe87f572b9b93acf\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/workspaceAccess.js\":\"c096c31273285e9e\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/transform.js\":\"7e5e3fe3d36820ad\",\"/knowledge-medium/pr-preview/pr-1880/src/themeBootDefaults.js\":\"0ee13bd3f363ee7b\",\"/knowledge-medium/pr-preview/pr-1880/src/types.js\":\"3d83c5d9aef915da\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/ClientLocalSettings.js\":\"59eaf6119642877d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/abortableSleep.js\":\"0c66027a7e26ccd6\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/array.js\":\"f159ea473b124bc1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/backlinkAutocomplete.js\":\"b411cb9252b93b08\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/blockCrumbs.js\":\"aaa2f17952207842\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/blockrefAutocomplete.js\":\"fdd861d74c7d9b9e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/cadencedIdleJob.js\":\"05eace799024c1d9\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/callbackSet.js\":\"6bcbc468757e3676\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/clientId.js\":\"21864b6ca8b2829d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/codemirror.js\":\"35619249513992a1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/codemirrorCompletion.js\":\"b205cb32e63d942f\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/copy.js\":\"d9f3a91983f5b6f1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dailyPage.js\":\"623bdf05293efc99\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dbForensics.js\":\"4310cbba59707cf7\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dbForensicsHooks.js\":\"b2d4bbc8f38d6913\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/deleteBlockThroughUi.js\":\"5cdb619897cc5c59\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dialogs.js\":\"f01179b7400570e1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dom.js\":\"87e987ddf490cf43\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/downloadBlob.js\":\"46eace9992a0afe0\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/drawnWalk.js\":\"52a4215d3545150e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/exportSqliteDb.js\":\"aa77e1216c7db114\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/fileSystemAccess.js\":\"a14a65062e786292\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/flipSlide.js\":\"6a33ecbc41d213d3\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/fnv1a.js\":\"6873b604e029ecd2\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/formatBytes.js\":\"47993f14867ae352\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/fuzzyRank.js\":\"deecab07cd70fb8b\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/idbKeyedStore.js\":\"a05eb1fe291828dc\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/idleCallbackPolyfill.js\":\"54aa9512c4e577eb\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/keyboardAwareScroll.js\":\"010426da2370a610\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/keyboardViewport.js\":\"604626e06ccfebce\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/lastWorkspace.js\":\"0d386879da187063\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/layoutColumns.js\":\"1ddc697c0547ca20\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/layoutSessionDom.js\":\"44baf17d9a686b6b\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/layoutSessionId.js\":\"f3cee41b2748a445\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/linkClickGestures.js\":\"31feeb9d702e04f9\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/linkTargetAutocomplete.js\":\"ffa33c29ad302e76\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/localDbCorruption.js\":\"9f485faab71cf668\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/localDbRecovery.js\":\"b0d2d79bd567c826\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/markdownParser.js\":\"555c7c6d2bbf5558\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/memoize.js\":\"8157565802aeac77\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/nameFieldCommit.js\":\"ae392580e8c36294\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/nameList.js\":\"98c5fb01c02da42d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/navigation.js\":\"ec776c6157c7756a\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/omnilinerNamespace.js\":\"d70b6052304f95e1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/opfsPageScan.js\":\"9ae3d0160fd90905\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelClearance.js\":\"9cdd7707c5172fb1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelHistory.js\":\"f66044d3426fa1b4\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelLanes.js\":\"1271ac1c28eea5d1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelLayoutProjection.js\":\"ddf314ea0421726c\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelScrollAnchor.js\":\"e5cba43c8437f606\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelUrlFlags.js\":\"a28a3017658dfec6\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/platform.js\":\"d910c291ff6305ec\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/pluralize.js\":\"117cfb33b10addf3\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/propertyCreation.js\":\"640d81a3959638f0\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/propertyNavigation.js\":\"1fac57d8995c7f62\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/propertyValueContext.js\":\"31416d18b3232c00\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/react.js\":\"b82f7b23d0faba43\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/relativeDate.js\":\"a79538508273b8f1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/relativeTime.js\":\"576b8debc4cd9265\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/renderScope.js\":\"30f6a5cab52176b7\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/resolvedThenable.js\":\"b6913eb2495f5eba\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/routing.js\":\"1c4ac466be488666\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/safeMode.js\":\"dfe4ff039427bcec\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/scheduleIdle.js\":\"0361d05626a5064e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/screenWakeLock.js\":\"ef21130e6c285e19\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/selection.js\":\"3c0843cadb55da4d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/softKeyboardGrab.js\":\"2c10c4a687266fe3\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/startupTimeline.js\":\"618ca3ad480e4900\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/state.js\":\"e4c5f59c7e22fcaa\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/string.js\":\"c276729126428d47\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/surfaceZoom.js\":\"920913b1f5991b42\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/time.js\":\"fc6f3521f78e41c0\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/toast.js\":\"2f287d8522c672b0\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/toggleStore.js\":\"62491582b1ca7b78\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/untilStopped.js\":\"c2853604068cd3ff\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/userActivity.js\":\"17ce320f0ad9ac31\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/viewTransition.js\":\"c07c43dc5461425e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/viewport.js\":\"8557f64075293aae\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/webLock.js\":\"b16f3412c03c5f04\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/workspaceRecovery.js\":\"6a166bf4e068c6e3\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/workspaceSnapshotStore.js\":\"bdcb4d79ccec67b6\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-compiler-runtime.js\":\"64e1c647be0aae5a\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-client.js\":\"3ab77437f5655f3e\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-server-edge.js\":\"7eb046d2be9d3aea\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-server.js\":\"278148e1c440ecf7\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-static-edge.js\":\"bbd980ec2dc7fc62\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-static.js\":\"8c2646366b88be6a\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-test-utils.js\":\"474526f631d52952\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom.js\":\"20b3c2d853ab32f4\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-jsx-runtime.js\":\"7881556be6e4e813\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react.js\":\"6f201fa96218ebdb\",\"/knowledge-medium/pr-preview/pr-1880/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1880/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1880/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
