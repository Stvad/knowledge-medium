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
		buildId: "0bf254fbf11d-8bf3df2b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1880/\":\"f86b61f6f660230c\",\"/knowledge-medium/pr-preview/pr-1880/index.html\":\"f86b61f6f660230c\",\"/knowledge-medium/pr-preview/pr-1880/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1880/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1880/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1880/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1880/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1880/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1880/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1880/assets/FacadeVFS-CfwOIaBe.js\":\"99973ad93a0ab6a4\",\"/knowledge-medium/pr-preview/pr-1880/assets/OPFSCoopSyncVFS-CGWyHqTt.js\":\"c19da42fffc5a5f8\",\"/knowledge-medium/pr-preview/pr-1880/assets/OPFSWriteAheadVFS-DE7kQUD9.js\":\"774dcaa43a4409b9\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-BMRXrxyP.js\":\"04c74e4277906524\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1880/assets/wa-sqlite-async-oSPzL-0G.js\":\"b6db167cabc22d6f\",\"/knowledge-medium/pr-preview/pr-1880/assets/worker-BFjzcqXv.js\":\"adef31055dbeaae5\",\"/knowledge-medium/pr-preview/pr-1880/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1880/chunks/app-DrOkKzpk.js\":\"39e83f6f81f97f5d\",\"/knowledge-medium/pr-preview/pr-1880/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1880/index.js\":\"62567dff50326ce9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1880/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1880/assets/AccessHandlePoolVFS-CjRieX9p.js\":\"e94c682b1edc370c\",\"/knowledge-medium/pr-preview/pr-1880/assets/IDBBatchAtomicVFS-KbzNfpmF.js\":\"aa115e545fddd8fd\",\"/knowledge-medium/pr-preview/pr-1880/assets/MemoryVFS-DgvTaVxP.js\":\"78b5975b28904ac1\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-async-CWXr4pAZ.js\":\"f517bf264bab7993\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1880/assets/mc-wa-sqlite-shMFXZFp.js\":\"feb6ee6fa0f3b068\",\"/knowledge-medium/pr-preview/pr-1880/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1880/chunks/AccessHandlePoolVFS-D1RnMJi-.js\":\"1762980589c1548d\",\"/knowledge-medium/pr-preview/pr-1880/chunks/FacadeVFS-CCLJP2xN.js\":\"801e69c4f41445b8\",\"/knowledge-medium/pr-preview/pr-1880/chunks/IDBBatchAtomicVFS-C4TZP8Qa.js\":\"d34593b6404b2f56\",\"/knowledge-medium/pr-preview/pr-1880/chunks/MemoryVFS-BgNapS_O.js\":\"bf8757716381057a\",\"/knowledge-medium/pr-preview/pr-1880/chunks/OPFSCoopSyncVFS-C9pIsSja.js\":\"05c634f264cf9cc9\",\"/knowledge-medium/pr-preview/pr-1880/chunks/OPFSWriteAheadVFS-Bue69Sng.js\":\"5ee0bc5a4649f053\",\"/knowledge-medium/pr-preview/pr-1880/chunks/Preview-CW3XJRiv.js\":\"c274606193441a45\",\"/knowledge-medium/pr-preview/pr-1880/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1880/chunks/card-DLOTUKUo.js\":\"90741ea78b0b61d9\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1880/chunks/dist-D5Pa87q9.js\":\"2cd513e35cbeec1e\",\"/knowledge-medium/pr-preview/pr-1880/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1880/chunks/mc-wa-sqlite-C9PNh_BD.js\":\"8cbd5be27858a11c\",\"/knowledge-medium/pr-preview/pr-1880/chunks/mc-wa-sqlite-async-BfItegsD.js\":\"f38bc8aa17473799\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-B1CSg6a2.js\":\"f82a349fcc05efc6\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-BBOAdzsU.js\":\"156694c25c33929c\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-C-GWghWD.js\":\"77b44734f9446a93\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-CM-JowpB.js\":\"32a20fa45fd2a990\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-CSoJ3rpe.js\":\"6bdb1059243d22a4\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-DHtN02pQ.js\":\"203db83b0b59b0f1\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-DNsL3u2u.js\":\"1ba9a6768dc83ad9\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-DnYaWIPM.js\":\"f1dab7c4d9f853f5\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-dom-server-legacy.browser.production-CxHb4jjr.js\":\"b252efde4b73ed24\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-dom-server.browser.production-BhbNHMdt.js\":\"2959eefd32be2156\",\"/knowledge-medium/pr-preview/pr-1880/chunks/react-dom-server.edge.production-CAmucLkO.js\":\"dc66abb938dd21a7\",\"/knowledge-medium/pr-preview/pr-1880/chunks/server.browser-Yq7VzJ3X.js\":\"e6e480f13244bc37\",\"/knowledge-medium/pr-preview/pr-1880/chunks/textarea-DFWhkW1m.js\":\"175d6e6a117d674f\",\"/knowledge-medium/pr-preview/pr-1880/chunks/ui-CBWhmUta.js\":\"64abf3441ea3e3c4\",\"/knowledge-medium/pr-preview/pr-1880/chunks/wa-sqlite-DwcZZiTk.js\":\"dd5ab6256287de95\",\"/knowledge-medium/pr-preview/pr-1880/chunks/wa-sqlite-async-Fu3buZTb.js\":\"b35b1ae066fdf5fa\",\"/knowledge-medium/pr-preview/pr-1880/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1880/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1880/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1880/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1880/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1880/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1880/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1880/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1880/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1880/src/App.js\":\"09423e727766b269\",\"/knowledge-medium/pr-preview/pr-1880/src/appUpdate.js\":\"ab9f7ee696046708\",\"/knowledge-medium/pr-preview/pr-1880/src/appVersion.js\":\"f7484ffb467ff623\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/initialLayout.js\":\"d1dfcc8fa22128be\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/openWorkspaceData.js\":\"e6088c4376ffc242\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/resolveWorkspace.js\":\"9af3fd714787814c\",\"/knowledge-medium/pr-preview/pr-1880/src/bootstrap/workspaceBootstrap.js\":\"ebef90358af2b16b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockComponent.js\":\"5ff4713e5b0d78d4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockCrumbs.js\":\"040c053c4b6b2025\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockEditor.js\":\"fb8edfcdbe75c563\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockLoadingPlaceholder.js\":\"2246e1e7f08399f4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockProperties.js\":\"c604ec193f22069a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/BlockSearchPicker.js\":\"5ab03bdcadf967f8\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ConfirmBulkDeleteDialog.js\":\"18e2c3c52b02cdf1\",\"/knowledge-medium/pr-preview/pr-1880/src/components/DividerHandle.js\":\"2338a47693f66167\",\"/knowledge-medium/pr-preview/pr-1880/src/components/DraftEditor.js\":\"36d036f2464a3572\",\"/knowledge-medium/pr-preview/pr-1880/src/components/GutterPill.js\":\"ef30e32c3ada8dc2\",\"/knowledge-medium/pr-preview/pr-1880/src/components/Header.js\":\"cc18720c6c5dbe56\",\"/knowledge-medium/pr-preview/pr-1880/src/components/LazyBlockComponent.js\":\"1c4c054d541a87c8\",\"/knowledge-medium/pr-preview/pr-1880/src/components/Login.js\":\"cfe117adfc6ab212\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ZoomableSurface.js\":\"0c4c85e737f24254\",\"/knowledge-medium/pr-preview/pr-1880/src/components/editModeKeepalive.js\":\"1633a4e702110d6f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d67151a01108b990\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"2a06d42765faa8ad\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/RefPropertyEditor.js\":\"63f2f9436e04c20a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/RefTargetTypePicker.js\":\"e39e2080399b7d36\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/SelectPropertyEditor.js\":\"c6335266a61b3fe6\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/TypesPropertyEditor.js\":\"d7a006c207c1adc9\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/defaults.js\":\"6d3c14f8047d4270\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/kernelValuePresets.js\":\"40e1eb256d0ce6e9\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/selectablePresets.js\":\"9dd0b435c372b29c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyEditors/typesPropertyUi.js\":\"bce270ffbc79815c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/AddPropertyForm.js\":\"f4b59e848d31149f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/PropertyPicker.js\":\"e803e11b4cce33f5\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/PropertyRow.js\":\"5d7a2a833718c7af\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/Rows.js\":\"9c909758a5834df4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/actions.js\":\"c01d5c2b65dd7085\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/declarationOnly.js\":\"f8044489d5e423f2\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/layout.js\":\"964408ea2a77f51e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/model.js\":\"3a16e9952df4c11d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/shapeUi.js\":\"9055c9416e293243\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/shapes.js\":\"98077ae88e3c6fba\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e828f4168e760be1\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanel/visibility.js\":\"95eb33fef28c186c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/propertyPanelSections.js\":\"63b2e2b2cbca791d\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/BlockEmbed.js\":\"44c3db9aebf36364\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/BlockLink.js\":\"5c3d4a85547756a3\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/BlockRef.js\":\"5988ade2b7fac4e4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/ReferenceLink.js\":\"860f48b686ea56c7\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/cycleGuard.js\":\"f4afbefe8c91f124\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/cycleGuardContext.js\":\"73902c1f9b279717\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/linkInteraction.js\":\"f6faca756a94662b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/referenceLayout.js\":\"fd4d99648201fc8f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/references/useBlockRefAncestors.js\":\"faea8cae5368d48f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BlockGutter.js\":\"610a26fd67b99127\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BlockInfoDialog.js\":\"8d2024cd1de4842c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BlockTypeBlockRenderer.js\":\"abcd2babe3f97663\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/BulletHoverCard.js\":\"b877717f9392a869\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/CodeMirrorContentRenderer.js\":\"9f0e57eec98b6088\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8372de0032331b76\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/ColumnResizeHandles.js\":\"9b53706f6687436f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"854efd41d6d4d18f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/DefaultBlockRenderer.js\":\"5461890df6f33e78\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/LayoutRenderer.js\":\"c2a3b2e3aa23be78\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/MarkdownContentRenderer.js\":\"1556739c549d443c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/MissingDataRenderer.js\":\"0be62c40c09eb8d8\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/PanelRenderer.js\":\"08d748762ed129c0\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/PropertySchemaBlockRenderer.js\":\"88a6b74ffcbfdeaf\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/TopLevelRenderer.js\":\"ad54c551b5e8e1db\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/blockGutterMode.js\":\"365fcc905e8db8bb\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/blockTitleText.js\":\"8d1baf7929a0a2a8\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/fieldCreationKeydown.js\":\"347db04645bfbf48\",\"/knowledge-medium/pr-preview/pr-1880/src/components/renderer/layoutRootContext.js\":\"19cede5ff702c4e0\",\"/knowledge-medium/pr-preview/pr-1880/src/components/typeChip/TypeChip.js\":\"6d43d0b7773fcd0b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/typeChip/chipStyle.js\":\"8173fdc2ffd5bd24\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/anchored-floating.js\":\"cd718b23177bcd6c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/button.js\":\"a622b663aeaa6bf8\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/card.js\":\"d08b288f4e278586\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/checkbox.js\":\"c4c4e5c15f9cbf46\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/collapsible.js\":\"4d14239b0aeb281f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/command.js\":\"9c2d077f76fcf85e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/context-menu.js\":\"8dcfa0eabb0cb172\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/dialog.js\":\"b0bfc6a3af7fef0f\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/dropdown-menu.js\":\"f28905781de2814a\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/floating-listbox.js\":\"afdd062141fa2623\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/index.js\":\"397ff43f3f542ced\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/input.js\":\"28bee26bc18cda6e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/kbd.js\":\"27c90519e90d61a6\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/label.js\":\"342e13aec6d786cf\",\"/knowledge-medium/pr-preview/pr-1880/src/components/ui/textarea.js\":\"8f0d129bbee1a6e7\",\"/knowledge-medium/pr-preview/pr-1880/src/components/useEditModeYieldKeepalive.js\":\"daa9cd2fbeed6fbd\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/BootFallback.js\":\"ad034f63819200fd\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/FocusedRowLazyMount.js\":\"d7f737bab61dbca5\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/LazyViewportMount.js\":\"2764ee28a4bea093\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/LocalDbCorruptionFallback.js\":\"39dff274a0369106\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/error.js\":\"cbcca5857f8381d1\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/lazyMountRegistry.js\":\"77f0fc4b2fb5abc4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/util/suspense.js\":\"a1324899345a1b2b\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/CreateWorkspaceDialog.js\":\"03c0a171396d6efd\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/PendingInvitations.js\":\"372bf18efa6d4056\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/SyncProgress.js\":\"732b4787d08c01cd\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/UnlockProgress.js\":\"17e443a9b512ece1\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceKeyGate.js\":\"a631c69152536470\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceSettingsDialog.js\":\"40fce8c0adbec746\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceSwitcher.js\":\"6cffb22816936d70\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/WorkspaceSyncGate.js\":\"9f9de0068bb6fd10\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/ConversionFlow.js\":\"fcbaf29174cba39c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/ConversionFlowHost.js\":\"9aaac1c4ab71ae6e\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/EncryptionSection.js\":\"a9ea87a0b7f863d4\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/attachmentPrompts.js\":\"9c42a5aa8080c920\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/bundleFolderPrompts.js\":\"2b66bd27cc1a5c66\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/conversionFlowDeps.js\":\"fbab2ad40fedd932\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/conversionFlowStore.js\":\"f5a37351e0bd8ccc\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/flowUi.js\":\"1dd47571ea626fe0\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/conversion/useConversionRun.js\":\"e377557e19a0d037\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/keyUi.js\":\"eb2d8cf4fbb0dfbd\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/useCloseOnKeyLoss.js\":\"bbfaa8828c0ff09c\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/useCloseOnServerE2ee.js\":\"5d81bc571677f612\",\"/knowledge-medium/pr-preview/pr-1880/src/components/workspace/workspaceUnlocked.js\":\"dc694457e861f448\",\"/knowledge-medium/pr-preview/pr-1880/src/context/backgroundSubtree.js\":\"2f9271446b391cca\",\"/knowledge-medium/pr-preview/pr-1880/src/context/block.js\":\"eab44558da85dfe3\",\"/knowledge-medium/pr-preview/pr-1880/src/context/layoutWsContext.js\":\"05cd39551165a51f\",\"/knowledge-medium/pr-preview/pr-1880/src/context/propertyDisplay.js\":\"cbc737a2748981c7\",\"/knowledge-medium/pr-preview/pr-1880/src/context/repo.js\":\"a292f69b4974342a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/aliasClaim.js\":\"541da49b6ae61baf\",\"/knowledge-medium/pr-preview/pr-1880/src/data/aliasSeatNamespace.js\":\"2a92d6aa22e1b9cd\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/blockData.js\":\"86c44966475576ed\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/blockType.js\":\"3f5f26c05fce5ab8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/changeScope.js\":\"ababb4ec2d4200eb\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/codecs.js\":\"cfb46d726276dcea\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/derivedData.js\":\"87db7e389771f251\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/errors.js\":\"1dd885e440215dec\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/events.js\":\"1da26353b17e308b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/handle.js\":\"75a289665ad7e724\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/index.js\":\"566739f44225e97e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/mutator.js\":\"dac6a643bc7b9d2c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/processor.js\":\"c5a96cc4305ecf27\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/propertySchema.js\":\"71dd69ec4efe6262\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/query.js\":\"9000b1332da2446a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/sameTxProcessor.js\":\"e522c6b51ad0bc3b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/schema.js\":\"75a289665ad7e724\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/tx.js\":\"75a289665ad7e724\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/typedBlockQuery.js\":\"78daa49e66fac6ea\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/user.js\":\"7da159852544bade\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/valuePresetCore.js\":\"4732979251e5b28c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/api/valuePresets.js\":\"58edab60ebf5165c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/attachmentCleanerIOVerb.js\":\"d7b31eaa8bcf2adf\",\"/knowledge-medium/pr-preview/pr-1880/src/data/block.js\":\"4d367106d0c1df90\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockCache.js\":\"625377d14a4032ed\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockId.js\":\"eeb0ca51380af61a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockLiveness.js\":\"b57fb27f4f0f5a12\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockMerge.js\":\"05cde704eb6956cf\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockSchema.js\":\"d5a129d78dbcbac4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockTypeLookup.js\":\"e2ba700b351d7f89\",\"/knowledge-medium/pr-preview/pr-1880/src/data/blockTypes.js\":\"bf04b3dc59f90958\",\"/knowledge-medium/pr-preview/pr-1880/src/data/childrenView.js\":\"465c3e65bf781781\",\"/knowledge-medium/pr-preview/pr-1880/src/data/clientContext.js\":\"96ecea185aed3eb8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/dbFileSiblings.js\":\"83cf3eceef401024\",\"/knowledge-medium/pr-preview/pr-1880/src/data/definitionSeeds.js\":\"222ce307932acda4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/derivedIds.js\":\"09ae8ec26dd054d5\",\"/knowledge-medium/pr-preview/pr-1880/src/data/drawnSubtree.js\":\"7644dd18d2d60f47\",\"/knowledge-medium/pr-preview/pr-1880/src/data/facetBridge.js\":\"47bafef5754146ab\",\"/knowledge-medium/pr-preview/pr-1880/src/data/facets.js\":\"fc11cd5441dcad11\",\"/knowledge-medium/pr-preview/pr-1880/src/data/globalState.js\":\"92d7222eb57ff164\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/aliasClaimRederiveProcessor.js\":\"f13fd4bcfd30ca03\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/ancestorBatch.js\":\"54ea67a0b685d376\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/blockTypeTypeifyProcessor.js\":\"afbe129cdd1b7300\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/clientSchema.js\":\"086b34a0b867f19f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/commitPipeline.js\":\"f3a7c32c4d458eab\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/devAssertions.js\":\"18d7e463f3b27899\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/firstSync.js\":\"5bee17cfcf095456\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/freshInitialLoad.js\":\"cc13b375f868aa53\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/graphBackfillClaim.js\":\"f1ce60c827d4da20\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/handleStore.js\":\"a9721531600c3fcf\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/idleMarkerJobs.js\":\"884666f917ae3b53\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/initialDownload.js\":\"6d56cf3fac10dfa6\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/initializeClientDatabase.js\":\"a3842c161f050f77\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/jsonCanonical.js\":\"6f4724f105e9b40c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/kernelInvalidation.js\":\"eecafe83d3e30854\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/kernelProcessors.js\":\"9fdd651e7f0d6787\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/kernelQueries.js\":\"a559a8298a1545e8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/mergeTypeMembershipProcessor.js\":\"60c6ccdffbc84748\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/normalizeReferencesProcessor.js\":\"74548d4e6da27794\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/poolInstrumentation.js\":\"923ce2768531546f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/processorRunner.js\":\"6ece6a86a65865c4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyCellBackfill.js\":\"4a041dee2bfe1916\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyChildMint.js\":\"79a6616a9ab0186f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyChildrenProcessor.js\":\"0e2046c9dcf95463\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyDefinitionChangeProcessor.js\":\"d546e3eb9f314f72\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyDefinitionSynthesis.js\":\"b1be5f65a78db397\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyKeyScan.js\":\"fee24c945ab09f9c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertySchemaResolution.js\":\"11bc58c250c2b78b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/propertyValueEdits.js\":\"e4c245afd4c08f4f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/raiseProtocol.js\":\"ddaa16e7147ee74c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/readBatch.js\":\"84704dc81778ef9f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/refProjection.js\":\"6aa2d44c48b4e8eb\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/referenceTargetLookups.js\":\"1edf80d7fe1891e8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/referenceTargetProcessor.js\":\"d3cbe4655f74e6cb\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/replayMerge.js\":\"790eb1e9c019fee3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/sqlBinds.js\":\"f8a712b2e7ed4fb5\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"a3bdc4469e67471a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/arrivalProcessors.js\":\"8b9550141951c690\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/invalidate.js\":\"86b73cfc1ec4e2ad\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/materialize.js\":\"ca5d0d3e9fb3f14f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/observer.js\":\"dae094499c004eca\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/syncObserver/reconcile.js\":\"88b8b744bbbab519\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/timingMetrics.js\":\"c41551864fd98711\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/treeQueries.js\":\"99a6398405372b5c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/txEngine.js\":\"58b05fad19f5e01b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/txSnapshots.js\":\"8c533e58c97d63f1\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/typedBlockQuery.js\":\"3c7911474c1ed3b9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/internals/undoManager.js\":\"632d809d2b5bfc8d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/invalidation.js\":\"afc8470347e7b7bc\",\"/knowledge-medium/pr-preview/pr-1880/src/data/kernelDataExtension.js\":\"1134a8593c24d47b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/kernelPage.js\":\"e3a4c727c08e824e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/kernelValuePresetCores.js\":\"8fd10bb2bf6c6931\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localDbCorruptionSignal.js\":\"557f5db616a40f76\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localDbStorage.js\":\"fe7d3bb950da5034\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localDbVfs.js\":\"3ec5a3e0d89ff462\",\"/knowledge-medium/pr-preview/pr-1880/src/data/localSchema.js\":\"d89148471b09495e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/maintenance.js\":\"81580b5d3035c456\",\"/knowledge-medium/pr-preview/pr-1880/src/data/mergeProperties.js\":\"e8588185f5422b9c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/metricsConsoleHook.js\":\"b848a9aad4fea160\",\"/knowledge-medium/pr-preview/pr-1880/src/data/migrationsPage.js\":\"1b6860f64b469087\",\"/knowledge-medium/pr-preview/pr-1880/src/data/mutators.js\":\"7adcd6b0284d31fe\",\"/knowledge-medium/pr-preview/pr-1880/src/data/orderKey.js\":\"a8623979bee2c7a4\",\"/knowledge-medium/pr-preview/pr-1880/src/data/orderKeyPlacement.js\":\"74f18be7f4ee8a7a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/outlineSurface.js\":\"0c031eefa893f90d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/pendingEditorContent.js\":\"b469e52dc1c49bd9\",\"/knowledge-medium/pr-preview/pr-1880/src/data/pendingUploadsSql.js\":\"b6d930dbec542c18\",\"/knowledge-medium/pr-preview/pr-1880/src/data/pluginStateExtensions.js\":\"3eef62d0d8488259\",\"/knowledge-medium/pr-preview/pr-1880/src/data/powerSyncLogger.js\":\"2e3e04f1bb7afade\",\"/knowledge-medium/pr-preview/pr-1880/src/data/projectorRuntime.js\":\"45c2151d82423578\",\"/knowledge-medium/pr-preview/pr-1880/src/data/properties.js\":\"45618f60ed408c10\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertiesPage.js\":\"45289ce2027565a8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyChildren.js\":\"7621a3332ba92532\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDefinitionFanout.js\":\"f3cf86f6e774b208\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDefinitionMetadata.js\":\"95a2165c413ec2dc\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDefinitionRegistry.js\":\"715b3f991ca354fe\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyDisplayMode.js\":\"78ef2f1573594e0b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertyRowCreation.js\":\"03e08afbc5d066fa\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertySchemaCreation.js\":\"910b9bed5ff6fba1\",\"/knowledge-medium/pr-preview/pr-1880/src/data/propertySeeds.js\":\"9d7b046d28f6f35e\",\"/knowledge-medium/pr-preview/pr-1880/src/data/recentsPage.js\":\"22d8d56a56a215f8\",\"/knowledge-medium/pr-preview/pr-1880/src/data/refTargetComparableProperty.js\":\"5fdeee198f9b9606\",\"/knowledge-medium/pr-preview/pr-1880/src/data/referenceBlock.js\":\"03cad5394ec54ee1\",\"/knowledge-medium/pr-preview/pr-1880/src/data/rejectedUploads.js\":\"de2abe47698ac307\",\"/knowledge-medium/pr-preview/pr-1880/src/data/releasePowerSyncConnection.js\":\"c1edd926ab2b3f4f\",\"/knowledge-medium/pr-preview/pr-1880/src/data/repo.js\":\"3bc0c74bbc23e8a0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/repoProvider.js\":\"9bc6c1dc5858b667\",\"/knowledge-medium/pr-preview/pr-1880/src/data/rowProperty.js\":\"99a36bde932dfe45\",\"/knowledge-medium/pr-preview/pr-1880/src/data/searchFilter.js\":\"16cafdcec1b78d3d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/seedIdentityLedger.js\":\"92dd85f087344611\",\"/knowledge-medium/pr-preview/pr-1880/src/data/stateBlocks.js\":\"85d87f3cc9c06763\",\"/knowledge-medium/pr-preview/pr-1880/src/data/structuralEditPolicy.js\":\"215eee9bf091f1df\",\"/knowledge-medium/pr-preview/pr-1880/src/data/structuralInsert.js\":\"aa499540c2c18269\",\"/knowledge-medium/pr-preview/pr-1880/src/data/subtreeDelete.js\":\"d762e95e584e2213\",\"/knowledge-medium/pr-preview/pr-1880/src/data/syncStreamLock.js\":\"8d405b538eee954b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/syncedTableSqlRecognizer.js\":\"fad27a8af38f7f93\",\"/knowledge-medium/pr-preview/pr-1880/src/data/syncedTableWriteGuard.js\":\"28464d59bd1cb2d7\",\"/knowledge-medium/pr-preview/pr-1880/src/data/targets.js\":\"720951d5acb1e3f3\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeColors.js\":\"a98d357de52285a2\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeDefinitionMetadata.js\":\"c2d964be0fbb1aaa\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeDefinitionRegistry.js\":\"a4cff82da698d38a\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeExtraction.js\":\"b69e83c742c177c0\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeInitialValues.js\":\"d0bf1c9527539e99\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typePropertyGroups.js\":\"17b326f4c882030b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeSeeds.js\":\"a3a3b127ca7a417c\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typeTagger.js\":\"f14865e5f05a820b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typedRecords.js\":\"109fff8a7973324d\",\"/knowledge-medium/pr-preview/pr-1880/src/data/typesPage.js\":\"048848d3bf9b3364\",\"/knowledge-medium/pr-preview/pr-1880/src/data/userPrefs.js\":\"2adc2c791429abce\",\"/knowledge-medium/pr-preview/pr-1880/src/data/userSchemasService.js\":\"ab920f64eb64bba6\",\"/knowledge-medium/pr-preview/pr-1880/src/data/userTypesService.js\":\"5b5cdff1e9f88982\",\"/knowledge-medium/pr-preview/pr-1880/src/data/valuePresetRegistry.js\":\"2439349e88b24750\",\"/knowledge-medium/pr-preview/pr-1880/src/data/visibleChildren.js\":\"adec4f7418c312b7\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceConversion.js\":\"f7a6978c80209f8b\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceFirstSync.js\":\"170ff89732dd8e78\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceIdNamespace.js\":\"88f47c65b3197810\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaceSchema.js\":\"cbd03f1abca616f5\",\"/knowledge-medium/pr-preview/pr-1880/src/data/workspaces.js\":\"007ecb6a85d52f88\",\"/knowledge-medium/pr-preview/pr-1880/src/data/writeAheadLog.js\":\"fc18a99101ce7558\",\"/knowledge-medium/pr-preview/pr-1880/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/BlockPasteShellDecorator.js\":\"a6847c2be6f8a889\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/atTrigger.js\":\"1f8a9785c2ee7ea0\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/autocomplete.js\":\"fd5c0bee300d5557\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/codeMirrorExtensions.js\":\"0c4737d613177dd7\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/contentFlush.js\":\"7444c71b6ee2ba5f\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/defaultInteractions.js\":\"b0947ebbba0aa800\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/editSettleSignal.js\":\"0b6bce595ad2def7\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/insertImage.js\":\"eace776a8a962c45\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/referenceCompletionRange.js\":\"628f20996c467a0e\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/referenceTargetTypes.js\":\"ec8e518c1fb8b47d\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/syntaxContext.js\":\"b1159b7a556f0e60\",\"/knowledge-medium/pr-preview/pr-1880/src/editor/triggerMatch.js\":\"ef765db329d04a2c\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/AppRuntimeProvider.js\":\"39fcacc3e1bc6ec2\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/BlockFocusShellDecorator.js\":\"232662afdde9b1ee\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/ExtensionRenderBoundary.js\":\"f4635baecb1f33d3\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/PanelContentRecovery.js\":\"5a24f4eda403cbac\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/apiCatalog.js\":\"db96923e4318d767\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/approveExtensionHere.js\":\"bc59b8fd70486747\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/armedCutAppMount.js\":\"5a03757d5d58820d\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/batchableKeyedStore.js\":\"cb41b7a0d45eb8d8\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/blockInteraction.js\":\"585fc63d7cc6899b\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/blockSelectionAction.js\":\"83a0bfeceb1f40b5\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/compileExtensionModule.js\":\"9a47b26507e632f1\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/compiledModuleCache.js\":\"4024ad848e8ecc66\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/continuousGestures.js\":\"6945a208b0ad1548\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/core.js\":\"f25328e0ca40acfd\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/defaultRenderers.js\":\"90e64069b7cd36ad\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/definitionFanoutAppMount.js\":\"9068241f525770c9\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/dialogAppMount.js\":\"d5ca348a59ebe949\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/dynamicExtensionSeeds.js\":\"34ad81900236afcd\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/dynamicExtensions.js\":\"2458d94b9f340fe1\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/exampleExtensions.js\":\"5858f14eca6830dc\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionApprovalStatus.js\":\"7bc4414e853a91ab\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionLoadErrorToast.js\":\"e66599602fa932fa\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionLoadErrors.js\":\"545c9d1a14a68487\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionLookup.js\":\"c851f13446c4d808\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionToggles.js\":\"6c1460feaf637988\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/extensionUtilitiesCss.js\":\"652ac9780f92a9c0\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/kernelPageDeletionGuard.js\":\"c6e3f6e9113a3f9f\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/liveRuntime.js\":\"0b185bf806cfaf61\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/openExtensionsSettings.js\":\"da376a891d1490c5\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/overridesCache.js\":\"0b9538a4248fb9e3\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/pluginIds.js\":\"9b43c6f2be81cb1d\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/processorRejectionToast.js\":\"42c6ef16fc527d71\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/runtimeActions.js\":\"21c8e921b0e09d1a\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/runtimeContext.js\":\"cc9fe5e67a13f79a\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/staticAppExtensions.js\":\"3521a8e9cf73f3d0\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/staticDataExtensions.js\":\"000b1e5c45a4c9a0\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/toastAppMount.js\":\"c9730a1f32deea62\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/useOverrides.js\":\"68ba1e2c1d1caf2b\",\"/knowledge-medium/pr-preview/pr-1880/src/extensions/useShortcutSurfaceActivations.js\":\"7d79244b0671c84c\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/discoverToggleTree.js\":\"2fae2681a3eca0bc\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/facet.js\":\"9fd54edfea683f55\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/resolveAppRuntime.js\":\"ca5592822e67b89c\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/runtimeEvents.js\":\"00f091e60bdcc4f4\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/togglable.js\":\"3c1bb4ceab69811f\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/variantFacet.js\":\"058a7e1da1661628\",\"/knowledge-medium/pr-preview/pr-1880/src/facets/verbFacet.js\":\"57725833703ee409\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/block.js\":\"fcd7c86fd7e51926\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/focusedChild.js\":\"f26bf6f366a9d7cf\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/propertySchemas.js\":\"ab35a5cb690e4571\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/typeRegistry.js\":\"72eab54aeaac68d2\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useAncestorCrumbs.js\":\"9974149227b6bf5b\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useAutocompleteListbox.js\":\"1f91b62235b0ec72\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useDebouncedSearch.js\":\"1155d3c5ec859f4e\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useDebouncedValue.js\":\"ad7727b8380f69da\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useFacetValue.js\":\"9502b35a3f18560a\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useIsFocalRender.js\":\"ee38072c09a16664\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useIsReadOnly.js\":\"ba3bfe7fcb82864b\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useMaterializeBacklog.js\":\"01405b84abfba2c8\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useMinuteClock.js\":\"15d9ff86e974f739\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/usePanelLayoutProjection.js\":\"9fcb270822f8744c\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/usePendingInvitations.js\":\"07229d98ad06f282\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useRendererRegistry.js\":\"bc4a98a6c6443656\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useRetainedFieldRows.js\":\"bb8561a3a8d3c595\",\"/knowledge-medium/pr-preview/pr-1880/src/hooks/useWorkspaces.js\":\"1e56e96402b5edb8\",\"/knowledge-medium/pr-preview/pr-1880/src/lib/utils.js\":\"422b88bec2a0aa0a\",\"/knowledge-medium/pr-preview/pr-1880/src/main.js\":\"2c58a09d4752205d\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/MarkdownImage.js\":\"eab3649431f6730f\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/blockSeparators.js\":\"50ad789cc94d5e71\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/context.js\":\"03ea48261b50cbae\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/defaultMarkdownExtension.js\":\"53e4158b328c7165\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/extensions.js\":\"0d9ecfd53592b7fe\",\"/knowledge-medium/pr-preview/pr-1880/src/markdown/renderMarkdownHtml.js\":\"83129e9cfbb528d8\",\"/knowledge-medium/pr-preview/pr-1880/src/minimal-editor.js\":\"bc31b075d653110c\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/armedCut.js\":\"ed70e93041c164a2\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/captureMediaVerb.js\":\"3db2688f28a4b208\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/clipboard.js\":\"b499f5eca4e6724d\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/decision.js\":\"aeeac733cc9eadb7\",\"/knowledge-medium/pr-preview/pr-1880/src/paste/operations.js\":\"9f14d89fcd297fb7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/account-header/AccountHeaderItem.js\":\"52dac685be4301b1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/account-header/index.js\":\"854ca3629a48708f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"aa40018c4ae33ce1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/askAgent.js\":\"179b4f2d1e3fc9b5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/askedStore.js\":\"1de34e40010ed567\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"832fe76597774297\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/chipState.js\":\"b58d0d1df9bd954e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/dataExtension.js\":\"00955f304036b9cf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/index.js\":\"0b7a89ee771184dc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"eab4546ed2051f79\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-dispatch-companion/schema.js\":\"38c2009f3c6ac2f0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/AgentTokensDialog.js\":\"bdc0092e7a16148f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/BridgePairingDialog.js\":\"bf17572d65734fb9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/addMedia.js\":\"ba186cb62ff22244\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a2e41ac52ef0a4a2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/block.js\":\"fc0241fbbabf2bb2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/context.js\":\"b331fea8f8d72f6b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/displayIds.js\":\"fc982fcd1183e8ef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/index.js\":\"61d271690a1fb268\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/outline.js\":\"49b457a0bb9fd7ba\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/properties.js\":\"f654cf770f773a43\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/refs.js\":\"26ed3e6f18fbcb36\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"02ee3b5fb72f8656\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/search.js\":\"a56ca59736eecca1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/shared.js\":\"d7c444a59d88464c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"2e1f23a347195bf8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentViews/text.js\":\"2242cbbd1d38d15a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/agentWrites.js\":\"0ea9c5f9e9858bcb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/authoringCatalog.js\":\"27b133581ef55308\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/blockRefTargets.js\":\"62faa50999559e3a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/bridge.js\":\"91be86fc0cda8059\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/bridgeLoop.js\":\"7274a43cf0690363\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/changeHistory.js\":\"429770322d09530f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/commands.js\":\"938172abe41af183\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/commentsCommands.js\":\"d0d570159941e73f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/dataExtension.js\":\"9212413425af0bc3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/dataModelGuide.js\":\"7c9fc13ed7cb46b1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/dayPropertyInputs.js\":\"f4b6b6e1ba621012\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/describeRuntime.js\":\"c8602b4b56099935\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/extensionLint.js\":\"0d315b5dea5fb5eb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/grainAudit.js\":\"5e452240b968c273\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/healthCommand.js\":\"9b2e600facd207dd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/index.js\":\"b7cb56553a0a3cf6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/presetIdentity.js\":\"603fd83c36e22a6d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"941943f4560dd518\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/readMedia.js\":\"6566fe09e39eeb0c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/schema.js\":\"6ee52e3c1e359ecd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/serialization.js\":\"0886eb9e88b50e87\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/targets.js\":\"f3e6f690bf75d074\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/tokens.js\":\"2dd73b900f484987\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/watchEvents.js\":\"9f1431e1a9969bef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/workspaceGuard.js\":\"da7ce7c33b8c9d06\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/agent-runtime/writeCommands.js\":\"35ce22df9ae3ea00\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/AliasCollisionToast.js\":\"f01c73608baa1eb9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/DuplicateNameBanner.js\":\"d193d00cd9ae3c6b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/collisionMerge.js\":\"41e3fc0aabae087b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/dataExtension.js\":\"7e93a3b6df1c754e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/index.js\":\"b54fcdc8ba2caee4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/mergeCollisionAction.js\":\"5a0f6f2a778ddf68\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/pageStyling.js\":\"ff8f0cabe10c2038\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/rejectionToast.js\":\"5dc58ec50b4b54fa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/alias/syncProcessor.js\":\"2a8de7f077e13cf1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/actions.js\":\"b78b3ece6ee699ca\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/addComment.js\":\"0f79350cf56433dc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/anchor.js\":\"0554ad8f76e58043\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/anchorState.js\":\"32217a5fc72b1d80\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/commentLinks.js\":\"ab9b3a6f177191a5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/confirmThreadDeletion.js\":\"e3fbc0d562816bca\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/container.js\":\"dad2537efd1e5c85\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/dataExtension.js\":\"77e934da365309c4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/deleteComment.js\":\"46f760c7455222bd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/highlights.js\":\"40bfdc5bcb287d38\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/index.js\":\"5dea91b66dd7ade7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/linkedCommentsPill.js\":\"3a64c563bc46bf65\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/margin.js\":\"7c8b0b3a266cd1c7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/marginAnchorLinks.js\":\"ca8516a68f884ae7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/marginSchema.js\":\"9c8ae7352fe2357d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/newComment.js\":\"9b5afb21a3f4f4b0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/ownThreadPicker.js\":\"c8f97d5602265e36\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/placement.js\":\"0918d13bfdfe7819\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/queries.js\":\"9dc7c7de85020790\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/quotePosition.js\":\"c67fb29f4f6591a9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/quotedIn.js\":\"5fc66016d7108c12\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/quotedRange.js\":\"9fe67983ae98a53a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/rangeRefs.js\":\"9a6c22ee69f57bd6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/readHighlights.js\":\"4e6edb8c8310b094\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/readSelection.js\":\"34cacf3c189b00c0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/readSelectionUi.js\":\"f083e391ddb26dc5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/reanchor.js\":\"a84380f708791ee3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/schema.js\":\"d5e5059e3df79a15\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/scope.js\":\"4cf84ab4786a7397\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/scopeThreads.js\":\"95e1d1ee5adbd45d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/splitRetarget.js\":\"c57528e4396431ff\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/suggestionCard.js\":\"92598d95d33dc25d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/suggestions.js\":\"012e40e71757d813\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/summaries.js\":\"35d30c50276170e6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/summaryBatch.js\":\"1f64b5e0e14e4c66\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/surface.js\":\"d65fbb7629406a74\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/threadNavigation.js\":\"2272fdce3fbc2b82\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/threads.js\":\"51006593f75d65ed\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/ui.js\":\"4ed216fd68d8cfe8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/annotations/uiStore.js\":\"3a3878b59c232956\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-intents/appIntents.js\":\"091d506f4ef98c99\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-intents/index.js\":\"080abfd11fea8f62\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-update-prompt/index.js\":\"530b1c76a6297fa4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/app-update-prompt/status.js\":\"f5d8001a7e71db75\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"d443e303cd660b08\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/MediaBlockRenderer.js\":\"517ab4074dad49a3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/MediaDownLaneReplicator.js\":\"479baee1fd62b22b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/MediaUploadReconciler.js\":\"933def01961249e4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/assetDownLane.js\":\"a1778f8fc85c3d11\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/assetResolver.js\":\"637a3584edc64a44\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/assetUpload.js\":\"5c9f89fd9be15e6b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/attachmentCleanerIO.js\":\"46a832fe01a306f1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d971115b4dab171f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/blobStore.js\":\"7b6292e39b77d281\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/browserMedia.js\":\"25deda9cb4368b01\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/byteStore.js\":\"0999c0b421e7fa13\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/cleanerIO.js\":\"89c2f0b17db87da4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/cleanupAttachments.js\":\"7ecd1559b9bacd07\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/dataExtension.js\":\"952cf4b930a6b3c1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/downLane.js\":\"ca8f9c0e7c18682d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/index.js\":\"b657e6be7f7f91ef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/insertImageContribution.js\":\"b7b9aafaf3b1209a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/laneArming.js\":\"bba3f7217bb11c12\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/laneLock.js\":\"3122d368c8392afc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaBlock.js\":\"3330391b12298752\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaCapture.js\":\"da3e1948f670c62f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaLanes.js\":\"bdee3d74e1a2631e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaViewers.js\":\"52ef997ed98e852b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/mediaViewersFacet.js\":\"0b40e90bc88bd3a4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/pasteCapture.js\":\"de375f9cf7dc0b58\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/resolver.js\":\"63b080302bd6ed65\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/retryUploadsAction.js\":\"1526cc088fd2a7e1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/storagePaths.js\":\"ce0316acebd1e16c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadDrain.js\":\"64c012dfefd02607\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadLaneStatus.js\":\"adb091fd68786ca9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadReconcile.js\":\"3d82cdb49d5e182e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadRecovery.js\":\"8241b531e1e13d33\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/uploadStore.js\":\"ed901c8da6f150b9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/attachments/useAssetObjectUrl.js\":\"f0b66e2064574ea7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"6282dbdd6568d6ae\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/BacklinksViewSection.js\":\"22e1a8b59a550e74\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/facet.js\":\"86b0c4339d28f463\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/index.js\":\"ef6434612f7889f6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks-view/prop.js\":\"258e62f0c2b4751e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/BacklinkFilters.js\":\"827a302ffbdf7383\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"cc5f63475a6bdfcf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/BlockEntry.js\":\"d77b3ca1c699edba\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/LinkedReferences.js\":\"d4748443febbd413\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"21a53d780d543050\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/dailyNoteDefaults.js\":\"440e6e536814b32c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/dataExtension.js\":\"84a5b7e9ffe959e8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/edgeExclusions.js\":\"0094e25dad0db5e6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/filterProperty.js\":\"adbdad0bbe361454\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/index.js\":\"cd8e4a94a3c06c00\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"5c7928306912e928\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/applies.js\":\"36b242d8150ea27d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/countQuery.js\":\"22db2b4cc19d1d6e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/expansionStore.js\":\"55c967eaba2e72f8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/index.js\":\"ab4708b197d7cb99\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"be43c17231f0d042\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/presentationInvalidation.js\":\"1c128bb984ffa8a6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/propertyEditorOverride.js\":\"af6977dc34dd77a9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/propertyFilter.js\":\"0ada8b9828397e90\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/query.js\":\"02725da542e438f4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/resolveFilter.js\":\"0fd9c4c8a071d422\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/sourceBatch.js\":\"54f1fb324ce94766\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/sources.js\":\"1e0fec0c44476d66\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/useBacklinks.js\":\"1c2ab0ca23d74d20\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"06b53f8457c425d6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/BirthdayCelebration.js\":\"beaaeb435ef8bdad\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/BirthdayOverlay.js\":\"150d38106df36fb3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/gate.js\":\"f755b02c6ba74048\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/index.js\":\"27e1946839f047e3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/birthday/wolfTheme.js\":\"0dfae400e46a1c2e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/BlockDragLayer.js\":\"dd5665ec08b7c548\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/dragController.js\":\"0fbf34becc5c1f5f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/dropTarget.js\":\"dd33392dbc0d98de\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/index.js\":\"8cafd5c6d6660bed\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-drag/projection.js\":\"7e37961405d5200b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-info/BlockMetaCard.js\":\"32ffb4649ba06af7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-info/index.js\":\"70419eb43980dc1a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/AddTagDialog.js\":\"8c98a7a52baf8aba\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"90f07c6a524a9da9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/TagNameIssueHint.js\":\"9ec9c83cc9c9d7bd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/addTagAction.js\":\"fe6be6ff1d9e9e66\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/appendTag.js\":\"c6af2b2eeffaa8c2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/config.js\":\"a6096d014618a426\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/dataExtension.js\":\"4d89d17e78c7ebe0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/index.js\":\"aebcdb17217e2529\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/block-tagging/propertyEditorOverride.js\":\"d3d5d0c2b0571d35\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/BreadcrumbList.js\":\"d5c04f805d2302dc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"7a1d51089cc07822\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/Breadcrumbs.js\":\"778a0052a83bb292\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0c072356752efff3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"6a3fb49a2a9ca5a0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/index.js\":\"edac3b450429700f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"94ed9802ff24bb31\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/CharacterCountItem.js\":\"48c1bc4db8efd66a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/ProfilePropertyEditor.js\":\"90f935e4278b1755\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/actions.js\":\"2887038bca4fb650\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/blockType.js\":\"cf1d74b06a5983ba\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/charCount.js\":\"400b01641cc5af27\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/dataExtension.js\":\"1e464fb261f0f63d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/index.js\":\"88783fbfdc2e7426\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/profiles.js\":\"aec3c3d0aeaeaccf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/properties.js\":\"d23db0aed4f009f4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/character-counter/textCounts.js\":\"32818d5fff301967\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/colemak-keybindings/index.js\":\"ce1ef50fd6965cee\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/CommandPalette.js\":\"2619c06da4e1bf8c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/HeaderItem.js\":\"a2a2202fd59fcd61\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/context.js\":\"c04768597e258297\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/index.js\":\"04e93dd30c854c77\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/selection.js\":\"87526d899263b938\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/toggleStore.js\":\"93cc285c95d8370c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/command-palette/useCommandPaletteActions.js\":\"4673d48bb316a894\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/ContributorBadges.js\":\"6c9e7eadcda9b0b5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/author.js\":\"6375799705a2b1c3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/codeMirrorExtensions.js\":\"d0219714e0a6a569\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/dataExtension.js\":\"4a296ce74148d0d8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/index.js\":\"ed5925eb1550060b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/mentionAutocomplete.js\":\"9e03f05b448da7cc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/processor.js\":\"5c333cc8c39a301d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/profiles.js\":\"acfbdac6ca4c2194\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/queries.js\":\"9fa370ef89d84bf9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/contributors/schema.js\":\"3fa8e1be6a9f96cd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9a72a7fe570982ec\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c9e1849e9eaf07e6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/index.js\":\"6176c0c3fdfb7d9f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"67dfd08fd425de0a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"98bbcd6f98182fc7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/CalendarGrid.js\":\"9a5bb4884e13c605\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DailyNotePicker.js\":\"cdf4d0fc36c0f205\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"08b627900798cf1c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DateNavDecorator.js\":\"bb0de47cafd546b3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DateScrubOverlay.js\":\"597f77e1886f9db0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/DayPropertyEditor.js\":\"d228a250910410b4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/HeaderItem.js\":\"e50bfa589af4b117\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/ReschedulePicker.js\":\"2d1f981d6c758dd7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d3cfb1774986e34a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/actions.js\":\"00531d18a5cf1ffa\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/blockDateAdapter.js\":\"995304b554caad47\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/calendar.js\":\"13f787767af7b520\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dailyNotes.js\":\"41d2a660fb6f9d9b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dataExtension.js\":\"5ca7b9c38a8d2f07\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubActions.js\":\"a242615a83d730c8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubGesture.js\":\"a42a0f4b010c1d14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubGestureActions.js\":\"9f7058ecdbc46bc2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dateScrubRecognizer.js\":\"56cba74eea10ac54\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dayProperty.js\":\"d5242cc012317722\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/deletionGuard.js\":\"cd482714e1aa3ce3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/dueQuery.js\":\"4daa49a0c7a6e532\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/index.js\":\"9c0c55c0e4d3bc57\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/landing.js\":\"68201e342ce644ae\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/localSchema.js\":\"fea47f54caa6eb98\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/referenceDateAdapter.js\":\"d6615cf51442442a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/rescheduleAction.js\":\"1ac94434b3f704b3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/schema.js\":\"6c194186323f2ede\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/spreadBlockDates.js\":\"db176d994b20dd2c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/spreadDatesAction.js\":\"be45bf56c7f3d630\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/today.js\":\"9108c71f1a9466f1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"026724c733b1f6fc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"330ab26cec429558\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/audit.js\":\"e999e7879bcd3fc5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/auditAction.js\":\"f74971633d77a6db\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/auditRanges.js\":\"ced2cac29f04f389\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/diagnosticsSource.js\":\"b0f1e1f2e297148f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/divergenceScan.js\":\"f33b46d52407311f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/index.js\":\"3c6240ca6460d02d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/propertyChildrenChecks.js\":\"bc1cb6cea1a923d3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/referencesMirror.js\":\"49b43e678f8ea43f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/rowJson.js\":\"9f4ca360d494ab8b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/schedule.js\":\"4b1c260bd5a78920\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/data-integrity/store.js\":\"e5c6fe8baa1274d8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-maintenance/action.js\":\"76c4e367bb15ebab\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-maintenance/index.js\":\"d27721c959650883\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-maintenance/plugin.js\":\"61bf991c3dbad217\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"8e83bce73b3de76d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/actions.js\":\"2ed42454a7865e9b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/changeMarker.js\":\"69f63bb4953e101a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/diagnostics.js\":\"596f4f79bbf37d30\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/fileSystemAccess.js\":\"293a7ff1f3527ef6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/filenames.js\":\"2e64eddc70838ccd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/index.js\":\"2c33a4dfdcfb18e5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/mirror.js\":\"aa44f06a4f457024\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/runLock.js\":\"f982d6b54b6cb81d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/runtimeHealth.js\":\"a69513b21297885f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/schedule.js\":\"a2a42e7a25b13500\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/db-mirror/store.js\":\"7859d79fcbf4f7a4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/default-themes/index.js\":\"26524f21889306c7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/default-themes/themes.js\":\"c983a52d9425aea9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/diagnostics/facet.js\":\"4cef8530b7aaca0b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/diagnostics/useDiagnostics.js\":\"f9910c8ee7ba4f78\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/dismissals.js\":\"0cf430fb3752d7d2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/index.js\":\"7868b2191f086342\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/status.js\":\"8ce09ce1ade9ff00\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extension-prompts/store.js\":\"e74b0dcfb8ef0c1f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7efd1e9d995e3153\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d9ae1fe35dde0e49\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/actions.js\":\"2fd61564f9379bf9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/config.js\":\"0478d5a006304683\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/dataExtension.js\":\"52eff5e5641c718e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/effect.js\":\"58865e4e26538d7d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/index.js\":\"344be40cbfe54a9b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/propertyEditorOverride.js\":\"90f28b1f28cce21c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extensions-settings/useToggleTree.js\":\"5913d2f028877880\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/ExtractTypeDialog.js\":\"925ae4f137978c03\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"06f3f8b3c322a8ae\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/PropertyShapePicker.js\":\"3e690e4f22640818\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/action.js\":\"fb028748dfdceda5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/extract-type/index.js\":\"d31c4c7ba25a9148\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/FindReplaceDialog.js\":\"840f2b11772bf28f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/HeaderItem.js\":\"78ab483836ffd272\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/dataExtension.js\":\"b7e279c4e9ebdb19\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/index.js\":\"927d4494b685f92e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/search.js\":\"614986a1a22cd340\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/toggleStore.js\":\"f04f74c27c149a16\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/LocationPropertyEditor.js\":\"a9d1417c196d028c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/MapView.js\":\"71982d1a0057e05d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/blockTypes.js\":\"ab2aec351bf6213f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/codeMirrorExtensions.js\":\"e730e338d7a13aac\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/createOrFindPlace.js\":\"004591038a4a65a8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/currentLocation.js\":\"0a86610c8cacd43d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/dataExtension.js\":\"7e1113f778ee56e3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/geoContentDecorator.js\":\"dc48d0c49ebadd0f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/googlePlacesClient.js\":\"033ebcb842224501\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/index.js\":\"d1de3bb592024dd0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/locationsPage.js\":\"00449dcfbef1ae0e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/mapViewport.js\":\"ff44b2c2056bb013\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/pickCurrentLocation.js\":\"4701d083c6b6c2f8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/placeAutocomplete.js\":\"f2fe1e50725f5f42\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/placeNameCollision.js\":\"10c84cf6b9aeb83d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/properties.js\":\"d4d2d0d5fd66a87a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/propertyEditorOverrides.js\":\"eb7ba9a523977ad1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/query.js\":\"bb514c31660b2871\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/geo/usePlaceSearch.js\":\"85b47028a6ac330e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"39e4080fcebb4a09\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0e62b99a007dd461\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e24e05bc5687a074\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/config.js\":\"fda9631637deef9e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/dataExtension.js\":\"a6dfbc93c4d3eab5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/facet.js\":\"fe13efee6d5fde96\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/grouping.js\":\"f995bf86cb056ddb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/index.js\":\"8e7cca3f909d2c6d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"26e674444f443a06\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/query.js\":\"96db68c652029787\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/resolveConfig.js\":\"491e520286f89571\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"85e448b1353c0c98\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6b12b8faa7795f65\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/HtmlDocumentContent.js\":\"2b9ed0512c50911e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/HtmlFrame.js\":\"943be17ea4d8768b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/actions.js\":\"5a4b2f98785461ab\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/blockType.js\":\"27589142f97e2418\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/confirmRunScripts.js\":\"4f19a840b7cb864e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/dataExtension.js\":\"29e91938202a8267\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/frameAnnotations.js\":\"35589fbde8c131b6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/frameDocument.js\":\"46115d670ce0a8a1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/frameTheme.js\":\"36d02f4c67b2686a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/index.js\":\"b2918c41b32425f7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/scriptConsent.js\":\"86241bd950cad7ba\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/sourceMap.js\":\"5b4a152f7162ac1d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/html-document/useDocumentScripts.js\":\"4b46be395b2e1a7e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/index.js\":\"0d1ddd63e349d64e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/record.js\":\"67459d4aa37eab11\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/recordStore.js\":\"e6bfa4c79afe0de8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/responsiveness.js\":\"9e3dae92544d1027\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/schedule.js\":\"64436f5c57a11283\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/interaction-metrics/sessionContext.js\":\"68e53bb13f2a6023\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"a9f2cb01171026b5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"594be5ceea60b149\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/actions.js\":\"7dec8a53edc8ec05\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/config.js\":\"3b12b96dc58f8e32\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/dataExtension.js\":\"3e709cd002337c41\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/effect.js\":\"32fd6172732ab8ad\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/index.js\":\"346e1123a9cff800\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/keyCapture.js\":\"bdd25457536a7839\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/overrideStore.js\":\"5f8a38a83b6f0c58\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"167547f535eabde7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/HeaderItem.js\":\"0718fd99f592cde5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/LeftSidebar.js\":\"cb2c1d2d95976465\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/actions.js\":\"f2528a3690f45f7b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/facet.js\":\"8b613b3625ca5592\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/index.js\":\"f6be23ef0ee56d1b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/shortcuts.js\":\"fe224c1fc39a16c9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/left-sidebar/toggleStore.js\":\"8fa50561e10791bc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/MergePicker.js\":\"c1918089276e4c57\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/index.js\":\"32b749a8053686b4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/mergeAction.js\":\"67945288635ed861\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/merge-blocks/strategy.js\":\"f9eb30728ed3b935\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/Button.js\":\"451ec4ef7833ff2c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1f75f5a6dbaf013e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a61af0e262e0185d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/facet.js\":\"9e499999827df407\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-bottom-nav/index.js\":\"4d82b159995368d1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"186ac88a95315bcf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d6154ae4654dfc8b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"c277dbc9b5895f91\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/facet.js\":\"e6335009d39176a8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/mobile-keyboard-toolbar/index.js\":\"f3ac82fcd58875e5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/MoveDestinationPicker.js\":\"6f97043636957512\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/blockSubtreeMembership.js\":\"111d945e11f06c9d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/contextMenuItem.js\":\"ef9a3269b8b94348\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/index.js\":\"74da13da9ad9bfef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/moveAction.js\":\"87c42e320226ac05\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/moveBlocks.js\":\"2ba7f6c4f6313d61\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/move-blocks/selectionAfterMove.js\":\"f59e32446bd60352\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/TutorialBanner.js\":\"18aa31ce13767923\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/action.js\":\"5d65940228ad4af7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/bannerDismissal.js\":\"8d54cb812547db8a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/documents/cheatSheet.js\":\"25a7c0c114e7ad7e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/index.js\":\"c329ad42e071a33d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/keys.js\":\"f2b06719723bb168\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/landing.js\":\"98bc2ef0ae23c76c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/outline.js\":\"5d78aa389e24c041\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/onboarding/seed.js\":\"77e799863322744d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/PerfTrendDialog.js\":\"01d858a466d8c987\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/analyze.js\":\"f926695f09a387d1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/diagnosticsSource.js\":\"3d90d79d247f2c2f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/index.js\":\"798829bf9715c18c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/load.js\":\"547c122a15fefce8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/monitorRun.js\":\"779dd6716e0f04f6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/schedule.js\":\"f0903c477b1bbd6d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/series.js\":\"a83f6c25ddaaa0e8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/store.js\":\"03000b5d9a56498f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/trendAction.js\":\"aa808e142387a15c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/perf-monitor/verdict.js\":\"e23c72a1b254b7de\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/plain-outliner/clickToEditAction.js\":\"00acef33285b4b64\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/plain-outliner/index.js\":\"7e5f48fa014e4988\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/plain-outliner/interactions.js\":\"561508dfc356db61\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"fed16615eb2e87ce\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/MigrationGate.js\":\"0ca9d72c5a707c3f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/MigrationGateDialog.js\":\"8b79fdfc1830e684\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/action.js\":\"4e028b7fe67b9f0e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/index.js\":\"3da6eba16ce9b0a0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/localRunMessage.js\":\"61bda70d98d570c1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/plugin.js\":\"870c77a2990cba2c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/progressReport.js\":\"8b4aaeff855212b0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/properties-migration/sweepProgress.js\":\"caddd4b33917e4a3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/FieldRowRenderer.js\":\"a5caf982f0c3aa77\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/ValueRowRenderer.js\":\"f83a19b49210ed26\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/actions.js\":\"66d311e4f1d4cd1e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/autocomplete.js\":\"437aa13f2f726943\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/fieldRow.js\":\"7c333340b77ff242\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/index.js\":\"a4ff7ffb96648ef3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/referenceWarning.js\":\"dc23de1d4ceb6dff\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/valueAutocomplete.js\":\"01190f3069423969\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/property-rows/valueSchema.js\":\"8b632a3174c57825\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/HeaderItem.js\":\"b285ad57a893fece\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/QuickFind.js\":\"2793e5261a6c87ea\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/index.js\":\"3639503afa7ec9ea\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/recents.js\":\"5a79dfb9abe48e3e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/resultItems.js\":\"8691d7fff9a263e1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/selection.js\":\"b8325ec3d480c603\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/quick-find/toggleStore.js\":\"a6116595ca56c052\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/HeaderItem.js\":\"61d72db77e184f96\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/RecentsPageBlockRenderer.js\":\"8f0db1070735be20\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/grouping.js\":\"5b3a4ad0a0211d2e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/index.js\":\"a7e3d554968f26e1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/recents/target.js\":\"cd40978d681fed92\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/codeMirrorExtensions.js\":\"5be4591d6bd909c6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/contentPrefill.js\":\"7014c912c26b9d09\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/dataExtension.js\":\"d308a895376ec08a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/index.js\":\"551694c7c82baca1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b6486b8192e7f8e7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/invalidation.js\":\"6cef53f20aa5efd0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/localSchema.js\":\"0c28da24a349d763\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/blockrefs/index.js\":\"e5f044130442b02b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"baa22ec4a78ab831\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/index.js\":\"8bfd46332ad94e96\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/referenceNode.js\":\"95483b7d5961c613\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e0b147e47d9e63e5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"6475269291218996\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/index.js\":\"ccac58411128cdbe\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e0111fc8e4f90515\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"732cb44f004670b6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/mergeRetargetProcessor.js\":\"14ee9ef536a524d4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/parseFence.js\":\"591b536714d2aaae\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/referenceParser.js\":\"81c30263b86f98b1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/referenceProjection.js\":\"24d0366a8c4e04ef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/referencesProcessor.js\":\"6bf67cce5d778b81\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/renameProcessor.js\":\"af505c8e34e406d7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/references/spanReplacement.js\":\"b171343d0b84516e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/htmlToOutline.js\":\"15dabd41baeeb57c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/index.js\":\"a8621b7de81d8da6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/normalizeClipboardDom.js\":\"1ec7bb50c49e4806\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/rich-paste/pasteDecision.js\":\"41aa4054cf7a2e10\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/action.js\":\"f87d9c6bf0013554\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/blockIds.js\":\"2d032ed6ea0e10d6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/content.js\":\"52ae50cd89ddf745\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/effect.js\":\"1f2601ab8c3c9983\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/ids.js\":\"1bd34139e22ea27e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/import.js\":\"162a55fc784cea0b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/index.js\":\"9263c3d0ac7e5fc1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/plan.js\":\"738cfc51197e10f4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/plugin.js\":\"6ade77645b7f2c43\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/promotion.js\":\"6ce9ce47e681cc6b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/properties.js\":\"dcb0be39ff8c1849\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/references.js\":\"f1893a8b36fc908e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/report.js\":\"0ed3529655a8658b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/roamMemo.js\":\"8153b6d67a1f6420\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/runtime.js\":\"e7ebba835b6abb5f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/schemaReconciliation.js\":\"4ea13335a05d1d19\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/srsMarkers.js\":\"b85ed1b1e17b1aef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/todo.js\":\"07c86e6096628528\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/typeCandidates.js\":\"92de50d9ff4f37f1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/roam-import/types.js\":\"1e57a0d4e81a85b2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/search-health/index.js\":\"03c21961be1f1b4f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/search-health/store.js\":\"edf73e66871ef491\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/HeaderItem.js\":\"653b011212c5bdf6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9f9fe16443f7a91e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/index.js\":\"3b696db282129fab\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/model.js\":\"5545ed216d57ba22\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/toggleStore.js\":\"4114b403c94617db\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/shortcut-help/useKeyInspector.js\":\"2f28fd7fa7f0ce2a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"551b94bee703c388\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/ShellDecorator.js\":\"9ad4538afb110936\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/actions.js\":\"2cbec63e92afd1b2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/exclusionsFacet.js\":\"36bb2274803c08fe\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/index.js\":\"b976531ebe6b9a61\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/shell.js\":\"93abc389bb107aeb\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/surface.js\":\"7ad160be9c29f95f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/spatial-navigation/walker.js\":\"a2f2ba5aaec7aea5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d71c3c8f24c8a900\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/dataExtension.js\":\"c418fe3074c71827\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/index.js\":\"ddf59b477b70db50\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/indicator.js\":\"36510da182f479c9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/moveSrsState.js\":\"0e13d989f90d8eb4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a6c4b29acf0aa870\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/scheduler.js\":\"105037d47b3175ce\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/schema.js\":\"f42ed202116d852a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"5070a6322ccb8813\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/srsClipboard.js\":\"b6a31394ac2f63c6\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"078a8f87926e4edd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9a3b0a8ca26ca820\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/DeckPicker.js\":\"2e115017941b0442\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/ReviewControls.js\":\"2c401c5dd516a068\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/ReviewDeckRenderer.js\":\"a7440980867e30ed\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/ReviewSession.js\":\"b221f9cf3c25acd5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/actions.js\":\"bec0c1ccd8734011\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/archive.js\":\"3361e6949713e089\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/dataExtension.js\":\"3af3e6ec18378934\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/deck.js\":\"388aae65256aef28\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/dueQuery.js\":\"ab7db1eb5ce8a199\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/gradeDecision.js\":\"5f72a7eb5a937296\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/index.js\":\"3df863535464aa12\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/keyHints.js\":\"a3055203b6d57052\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/reviewCardLayout.js\":\"4dfd076a1a5440d5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/reviewProgress.js\":\"0db65851d9fa871b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/schema.js\":\"51a23d7eacef5b21\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/srs-review/useDueCards.js\":\"ed6c2a3e7936f679\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/startup-metrics/index.js\":\"18bcc696eab5579d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/startup-metrics/record.js\":\"79ec8c4e6a26ce43\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/storage-persistence/index.js\":\"de171c3f43955a64\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/storage-persistence/persistenceStatus.js\":\"a4c8458b2140f51e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/storage-persistence/requestAction.js\":\"adbba57bee2cac06\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/TypeChipsDecorator.js\":\"4ccedd78f9040149\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/codeMirrorExtensions.js\":\"c12f341bccd75d5c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/index.js\":\"22390554d0b9683d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/supertags/typeAutocomplete.js\":\"c634a0f6ce7cbe18\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8a2add0d386a69dd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/actions.js\":\"c60f26708a259ddf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/anchor.js\":\"692b69d2aa064dbd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/events.js\":\"b63b0f08a7890512\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/gestureActions.js\":\"9ad4786495934cb8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/index.js\":\"cea2ecacdb62ff75\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1c238b64bc22771f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/sync-metrics/collect.js\":\"8dc3c11aec38717e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/sync-metrics/index.js\":\"82d9013bf46ffbd9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/sync-metrics/record.js\":\"e599d6af12c4119e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/RejectionDialog.js\":\"f22f4d182048b414\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/SystemStatusHeaderItem.js\":\"37adfc9b6ccbbf09\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/index.js\":\"17f47be58e6f6255\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/model.js\":\"8433e8375077be01\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/queueCounts.js\":\"130c22c2728a29ac\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/rejectedHelpers.js\":\"6c2340c5332218c3\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/rematerializeAction.js\":\"5ef7c38bb6af4f16\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/system-status/useHysteresis.js\":\"a1bffb318460639b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/ColumnHeaders.js\":\"abd398f1ed4c6dba\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/QueryUi.js\":\"53eafc9ba419202b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/TableLayout.js\":\"54084f6f2035a9ef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/actions.js\":\"8830dfcc37938278\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/cellEdits.js\":\"3f908abe91132417\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/childrenViews.js\":\"df70d0c0d54574c7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/columns.js\":\"63447def54d2b1ed\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/controller.js\":\"9ab301559753f9d5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/convert.js\":\"21e7ebfce82215a0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/dataExtension.js\":\"9dc726224690ec7e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/index.js\":\"3710a708f1729e5a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/keys.js\":\"6d28bad38c3005bf\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/model.js\":\"1c7adc445a233f47\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/backfill.js\":\"d8c314ceb6de7e58\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/completion.js\":\"04b26dc9bdedd329\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/format.js\":\"9298c6a860086df2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/parse.js\":\"265b5a4fdc25e314\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/queryValue.js\":\"46de8eb1c6afed0c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/registrations.js\":\"aeaea17af774926d\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/query/source.js\":\"fa9ed07f26dfb421\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/registry.js\":\"86f3ee8ea139bcdc\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/rowGutter.js\":\"65136047b76bd1ee\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/rowVerbs.js\":\"5c6a7db9dfa7505b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/schema.js\":\"2d16c8ac2ef329f2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/tables/sort.js\":\"2efe16d77cd3af42\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/theme-toggle/effect.js\":\"8c517c2c7fc71762\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/theme-toggle/index.js\":\"6c91378d2cd20595\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/theme-toggle/theme.js\":\"09f859b742c573b9\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/actions.js\":\"923b99fc1f36f875\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/dataExtension.js\":\"3601a31a7f7f4ab7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/index.js\":\"d78c98d2ce93b572\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/todo/schema.js\":\"955269abf218a83a\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/TouchSelectionLayer.js\":\"eb4c42176ffa4517\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/actions.js\":\"9b027d9c306b3877\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/defaultItems.js\":\"65aa743df0d6c8a5\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/facet.js\":\"31063716ea73ba72\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/holdRecognizer.js\":\"5ffde3ef62618c08\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/touch-selection/index.js\":\"8e9b66359b719d41\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/update-indicator/UpdateIndicator.js\":\"8f7816887c017db1\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/update-indicator/index.js\":\"370cfbb79377690f\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/update-indicator/loadTimes.js\":\"920619a3f6d79c41\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/VideoNotesRenderer.js\":\"9741c91a4ad9f188\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/VideoPlayerRenderer.js\":\"d8126f4c687097c4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/VideoTimeStamp.js\":\"940bcea52622b013\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/actions.js\":\"4c27b4f6ddbe7e7c\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/index.js\":\"74c402f88b85a8a4\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/markdown.js\":\"30d7470771d6eec7\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/notes.js\":\"fade95c96a0a4f4e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/registry.js\":\"c791cd3ea1a47bbd\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/remark-timestamps.js\":\"705757e9de75c360\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/video-player/view.js\":\"047b2a48681a732e\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/LinkHints.js\":\"823a74a4b8655ad8\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/index.js\":\"b39a33c447bafd05\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/model.js\":\"34ea3280adc4ccef\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-link-hints/settings.js\":\"4270dd55bdf7f9b2\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-normal-mode/actions.js\":\"20216a07fe56af8b\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-normal-mode/index.js\":\"b6ffc30bf24cf340\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/vim-normal-mode/interactions.js\":\"81e946bcf9accce0\",\"/knowledge-medium/pr-preview/pr-1880/src/plugins/workspace-header/index.js\":\"588965880904f46e\",\"/knowledge-medium/pr-preview/pr-1880/src/registerServiceWorker.js\":\"dbb27397dbfa71f7\",\"/knowledge-medium/pr-preview/pr-1880/src/requestPersistentStorage.js\":\"abb9d8d583813bbc\",\"/knowledge-medium/pr-preview/pr-1880/src/services/authRequestDeadline.js\":\"30ef04061e03d1b0\",\"/knowledge-medium/pr-preview/pr-1880/src/services/authStorage.js\":\"fa4ca179282918ad\",\"/knowledge-medium/pr-preview/pr-1880/src/services/powersync.js\":\"94997e563f32d903\",\"/knowledge-medium/pr-preview/pr-1880/src/services/supabase.js\":\"399171d36257846d\",\"/knowledge-medium/pr-preview/pr-1880/src/services/uploadErrorClassifier.js\":\"fced81db62eb40ba\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/ActiveContexts.js\":\"0a836e9b990cafe3\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/HotkeyReconciler.js\":\"d6b2c1e7edac9dce\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/WipeLocalDataDialog.js\":\"7dfa77ef11216a02\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/actionDispatch.js\":\"1eae2bdacfe9023a\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/actionRefItems.js\":\"ad3f5365be74ab24\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/applyKeybindingOverrides.js\":\"faf0995cfa5a9554\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/blockActions.js\":\"f5926d4fb584229d\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/blockMergeGesture.js\":\"340392c05d39193f\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/canonicalizeChord.js\":\"f376c0ca9405c046\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/defaultContexts.js\":\"f873746a48397f5c\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/defaultShortcuts.js\":\"708d4090d2241f8b\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/effectiveActions.js\":\"7fc24e52b8ff8ffd\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/gestureAction.js\":\"82f383029b99256f\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/gestureBinding.js\":\"80eaefc2773f6469\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/holdRegistry.js\":\"886d568623878699\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/keybindingConflicts.js\":\"16e24c1829cb7c43\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/keybindingOverrides.js\":\"bc3887c56584f589\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/pointerAction.js\":\"d3e00b309995ebd2\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/resolve.js\":\"9cbdfa405b8379d7\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/runAction.js\":\"73b43f37aab796c4\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/sequenceMatcher.js\":\"28e1a8373ccb70ba\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/types.js\":\"bf0db0052347e8aa\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/useActionContext.js\":\"ca9fc66c11498350\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/useActionDiscovery.js\":\"dc410d9513f59980\",\"/knowledge-medium/pr-preview/pr-1880/src/shortcuts/utils.js\":\"28779b7011e55de3\",\"/knowledge-medium/pr-preview/pr-1880/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1880/src/sw/bootStore.js\":\"a7309f8199a59d7c\",\"/knowledge-medium/pr-preview/pr-1880/src/sw/previewDatabases.js\":\"100a465918ad1f11\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/byteTransform.js\":\"d52e1d005426b666\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/attachmentCleaner.js\":\"3bdd4beebdfdf325\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/attachmentParts.js\":\"9b7244df035283f2\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/bundleParts.js\":\"ebec99da194f560d\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/bundleRecord.js\":\"854d6f5e508e1cc5\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/manifest.js\":\"3d49ca1de81629e9\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/takeBundle.js\":\"ce542875ce352acb\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/bundle/verifyBundle.js\":\"6eb78465e22f0304\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/cleaningStage.js\":\"bfb8e051894fede5\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/conversionKey.js\":\"0b9675a5d1ac5912\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/conversionServer.js\":\"958a8f4e678f1d50\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/flip.js\":\"2ac12b0663b6e053\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/flipAttempts.js\":\"ee1a278987e3cbc9\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/pages.js\":\"57fd6351431c11e3\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/preflight.js\":\"9e420b6c95f0b121\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/reseal.js\":\"645685d9db6649b1\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/runConversion.js\":\"ebfb7a8a3c95e9c4\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/runLock.js\":\"5611c2cc1bc18322\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/sealing.js\":\"d1b6e1b46db46fe0\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/sealingStage.js\":\"a4c399f29fec6c86\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/stage.js\":\"e0f58ea7db8dae73\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/conversion/verifyReseal.js\":\"a4abdf514f58eef9\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/aad.js\":\"3f88a6606433aa01\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/aead.js\":\"34f085bdc15cbd05\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/base32.js\":\"ff283977d5b8c13a\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/base64url.js\":\"165e1e2f92a43132\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/binaryEnvelope.js\":\"55478868780e03b4\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/byteAead.js\":\"32e68b1743d66c12\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/canary.js\":\"75f4febb325d43d9\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/contentHash.js\":\"1bb5901cdd80901f\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/contentKey.js\":\"35630b3567729d29\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/derivedIdNamespace.js\":\"449cf55f6f697887\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/envelope.js\":\"e335f718f844e5ee\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/hex.js\":\"2fab187b48ac2242\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/sha256Hex.js\":\"79e8102958798c4e\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/crypto/workspaceKey.js\":\"c12287b326eb5982\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/conversionState.js\":\"dd0436a017d03361\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3c6006292a66091d\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/pastedKey.js\":\"073bb073638e119f\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"23493878a2c02f1b\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b6e734e3f3c310db\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/keyStore.js\":\"e40a468258c39fb3\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/mintWorkspaceKey.js\":\"2ab26571db2965c9\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/modePin.js\":\"4d246f86515648b3\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/openWorkspaceKeys.js\":\"51b6e3124ac1cbe1\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/resolveWorkspaceEntry.js\":\"f0619145b334cbc8\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/resolver.js\":\"580567b10ea8c8b0\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/keys/workspaceAccess.js\":\"184d4c183e8f11e6\",\"/knowledge-medium/pr-preview/pr-1880/src/sync/transform.js\":\"9e9359b3833300a6\",\"/knowledge-medium/pr-preview/pr-1880/src/themeBootDefaults.js\":\"1a281672759ca93c\",\"/knowledge-medium/pr-preview/pr-1880/src/types.js\":\"f97b8a5b2890fdd1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/ClientLocalSettings.js\":\"2da4375db049c28c\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/abortableSleep.js\":\"e3ff121bbad540b7\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/array.js\":\"858a2f1ea03b207b\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/backlinkAutocomplete.js\":\"3e66025c59e0f559\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/blockCrumbs.js\":\"5cf8beecd51cfb6a\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/blockrefAutocomplete.js\":\"6f3cbf51b5665b9b\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/cadencedIdleJob.js\":\"ceeee84012337182\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/callbackSet.js\":\"d3e4ed028095b458\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/clientId.js\":\"3f5bcacc091fe108\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/codemirror.js\":\"8336e6abfaf97e4b\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/codemirrorCompletion.js\":\"b20277f578f8ffe1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/copy.js\":\"55f50f7ada21e987\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dailyPage.js\":\"e248be5412e655f2\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dbForensics.js\":\"586c7ee38df054ca\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dbForensicsHooks.js\":\"c720e5b02f0c8ec8\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/deleteBlockThroughUi.js\":\"b07059148cb25e5c\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dialogs.js\":\"04103a46be854364\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/dom.js\":\"dfc3fe86cb4cfbd7\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/downloadBlob.js\":\"666575a1d72ac820\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/drawnWalk.js\":\"61db5de4c1fc9fca\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/exportSqliteDb.js\":\"85f14b0f492d0224\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/fileSystemAccess.js\":\"149bd641367548a6\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/flipSlide.js\":\"d367fb6a1bc4030f\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/fnv1a.js\":\"4238b892b7b58725\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/formatBytes.js\":\"c92186764812dbc1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/fuzzyRank.js\":\"fdab66c082d001f8\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/idbKeyedStore.js\":\"251fb2c6b87c9ded\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/idleCallbackPolyfill.js\":\"c764d11325cd5bc2\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/keyboardAwareScroll.js\":\"4b5bc6c206434bf4\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/keyboardViewport.js\":\"4db5e8972c980a75\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/lastWorkspace.js\":\"3b990057ffc73868\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/layoutColumns.js\":\"276c6e2ffdfb41e6\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/layoutSessionDom.js\":\"92b0ef87ae69e036\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/layoutSessionId.js\":\"73d63920a655d811\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/linkClickGestures.js\":\"c3819d77189b9569\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/linkTargetAutocomplete.js\":\"68d498f4b0ee7077\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/localDbCorruption.js\":\"7c5d54187bf63913\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/localDbRecovery.js\":\"768dd1bf026bc190\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/markdownParser.js\":\"741ffb098af6dafe\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/memoize.js\":\"1de8edfaaa46cb32\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/nameFieldCommit.js\":\"5a31e994d818fd46\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/nameList.js\":\"c496045ca4cb7f6e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/navigation.js\":\"783c2df08ca464d2\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/omnilinerNamespace.js\":\"b03e8a8ca919a88f\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/opfsPageScan.js\":\"52566dce84f5a932\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelClearance.js\":\"740df60dca5f5d2a\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelHistory.js\":\"89de65539668ce58\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelLanes.js\":\"df75e6d4ae4f22bc\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelLayoutProjection.js\":\"423d0f2c05aa74ee\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelScrollAnchor.js\":\"9d02f56912830cf1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/panelUrlFlags.js\":\"3e25c50ecd90fe9d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/platform.js\":\"dd849222bab1432f\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/pluralize.js\":\"e1ab5af990e23895\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/propertyCreation.js\":\"f3d556f056408e4c\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/propertyNavigation.js\":\"4bec887dfa97ac01\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/propertyValueContext.js\":\"724da3a5ad03d5ff\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/react.js\":\"0c988c648dc435c1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/relativeDate.js\":\"01c09cbbd77e209a\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/relativeTime.js\":\"699e7d321d27a427\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/renderScope.js\":\"8ef7d82e4df1f6d7\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/resolvedThenable.js\":\"685ca875bb5926fd\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/routing.js\":\"53fdeefc7ba903b0\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/safeMode.js\":\"890f02af81dfdce1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/scheduleIdle.js\":\"2e1873c73fad0e46\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/screenWakeLock.js\":\"f884507b783bd979\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/selection.js\":\"25400e73d57f9b7a\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/softKeyboardGrab.js\":\"603d8e2d45edc836\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/startupTimeline.js\":\"9a4a55e0f3ec8c2d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/state.js\":\"989e13a3d8d8d951\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/string.js\":\"4433dc367c158c23\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/surfaceZoom.js\":\"24b37ff1dd6297f1\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/time.js\":\"4582ea7d299b8ae4\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/toast.js\":\"398069e7c0e4a5bc\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/toggleStore.js\":\"aa1e006e80cb6e09\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/untilStopped.js\":\"4c307242b9918575\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/userActivity.js\":\"d6235e1a8c44309e\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/viewTransition.js\":\"c565d26826363f61\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/viewport.js\":\"5e1a6919e8ee2a80\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/webLock.js\":\"ea4d7b89f35daec3\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/workspaceRecovery.js\":\"b6ce7a9ca211b25d\",\"/knowledge-medium/pr-preview/pr-1880/src/utils/workspaceSnapshotStore.js\":\"b3c1f7a2b9f84469\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-compiler-runtime.js\":\"b97d855cea70acd9\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-client.js\":\"92620877b36d8989\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-server-edge.js\":\"671ad9a40515664b\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-server.js\":\"6585cb53ddb7f47b\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-static-edge.js\":\"7ca142cf4bde177e\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-static.js\":\"7ddf0bcc117730fa\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom-test-utils.js\":\"cd40aab80cc5415c\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-dom.js\":\"8048773189c079ab\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react-jsx-runtime.js\":\"2d2c58e1fc3c6230\",\"/knowledge-medium/pr-preview/pr-1880/src/vendor/react.js\":\"ab20e523879cc67d\",\"/knowledge-medium/pr-preview/pr-1880/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1880/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1880/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
