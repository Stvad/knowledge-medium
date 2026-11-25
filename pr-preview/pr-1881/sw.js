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
		buildId: "93a2c3c2d692-8e12b2bb",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1881/\":\"d0ec45837fb35332\",\"/knowledge-medium/pr-preview/pr-1881/index.html\":\"d0ec45837fb35332\",\"/knowledge-medium/pr-preview/pr-1881/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1881/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1881/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1881/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1881/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1881/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1881/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/pr-preview/pr-1881/assets/FacadeVFS-DUmV9087.js\":\"b01be0c8bed41950\",\"/knowledge-medium/pr-preview/pr-1881/assets/OPFSCoopSyncVFS-CESeaoiK.js\":\"28bc6984d0e7eb28\",\"/knowledge-medium/pr-preview/pr-1881/assets/OPFSWriteAheadVFS-CwCZvF7K.js\":\"2270c42c7d993676\",\"/knowledge-medium/pr-preview/pr-1881/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1881/assets/wa-sqlite-R32BpnJ3.js\":\"341a4a9a1cdf2fd8\",\"/knowledge-medium/pr-preview/pr-1881/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1881/assets/wa-sqlite-async-BbeZW2w8.js\":\"9d1ec965d2e3b558\",\"/knowledge-medium/pr-preview/pr-1881/assets/worker-DR-dNokh.js\":\"d132e953348d318e\",\"/knowledge-medium/pr-preview/pr-1881/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1881/chunks/app-BH7RLhhx.js\":\"18ded1bcf977b84a\",\"/knowledge-medium/pr-preview/pr-1881/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1881/index.js\":\"0ae3d96a5af6b788\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1881/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1881/assets/AccessHandlePoolVFS-l2UfaOd6.js\":\"9ea00b672fe46a6f\",\"/knowledge-medium/pr-preview/pr-1881/assets/IDBBatchAtomicVFS-BFic9fDE.js\":\"0aa595b79a7832ed\",\"/knowledge-medium/pr-preview/pr-1881/assets/MemoryVFS-BTmwJbsq.js\":\"678f0f91b2700001\",\"/knowledge-medium/pr-preview/pr-1881/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1881/assets/mc-wa-sqlite-UVh30V2a.js\":\"f806b1354269ca05\",\"/knowledge-medium/pr-preview/pr-1881/assets/mc-wa-sqlite-async-Iy6ggeCZ.js\":\"b98ff85961586b60\",\"/knowledge-medium/pr-preview/pr-1881/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1881/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1881/chunks/AccessHandlePoolVFS-CZmMefDB.js\":\"a2d0ea0f90cf8168\",\"/knowledge-medium/pr-preview/pr-1881/chunks/FacadeVFS-CECGX9O2.js\":\"c4277fb1293c94f3\",\"/knowledge-medium/pr-preview/pr-1881/chunks/IDBBatchAtomicVFS-BlZkkj2u.js\":\"ba1113df21a20546\",\"/knowledge-medium/pr-preview/pr-1881/chunks/MemoryVFS-BWLLkQX4.js\":\"53cc6d8f16bffd42\",\"/knowledge-medium/pr-preview/pr-1881/chunks/OPFSCoopSyncVFS-D2TfiSIg.js\":\"af31221e5cafaeab\",\"/knowledge-medium/pr-preview/pr-1881/chunks/OPFSWriteAheadVFS-CZtreKjM.js\":\"1afeea9edfb74fca\",\"/knowledge-medium/pr-preview/pr-1881/chunks/Preview-Dr_O8OPG.js\":\"eca6f221438d73f0\",\"/knowledge-medium/pr-preview/pr-1881/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1881/chunks/card-CBgRRfdY.js\":\"35469d9e5e0b6c79\",\"/knowledge-medium/pr-preview/pr-1881/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1881/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1881/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1881/chunks/dist-D09kCAMr.js\":\"ec2a03d0cb893658\",\"/knowledge-medium/pr-preview/pr-1881/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1881/chunks/mc-wa-sqlite-CeRUnuDR.js\":\"4f1123368a532b25\",\"/knowledge-medium/pr-preview/pr-1881/chunks/mc-wa-sqlite-async-wGVinLDA.js\":\"7c3e44c5496336b2\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-B2uJOI62.js\":\"09a984cfbf8e4998\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-BkynkhhL.js\":\"67f085431ad53510\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-CRzZiiX1.js\":\"67def95c48566d5d\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-CX83UTBj.js\":\"d5a478d6d77ec1ac\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-CbB7ABHs.js\":\"7f4d3029c482b274\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-DQ5O1ByQ.js\":\"d1ebb50745318027\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-DRLjC_NW.js\":\"f63a02af681db6dc\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-DndJdb8c.js\":\"b35257cada751ac5\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-dom-server-legacy.browser.production-BpT_rNah.js\":\"0e9f840ec43569f0\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-dom-server.browser.production-CkVFlN5Z.js\":\"9fa9bcbd8b2c69e1\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-dom-server.edge.production-X5ReZOYd.js\":\"13fec0c8ef9c1809\",\"/knowledge-medium/pr-preview/pr-1881/chunks/server.browser-s7X2M_Gc.js\":\"5fec63b62055a46c\",\"/knowledge-medium/pr-preview/pr-1881/chunks/textarea-3EgU4emw.js\":\"b1b81ea91e69cbd5\",\"/knowledge-medium/pr-preview/pr-1881/chunks/ui-C5vA-GIm.js\":\"8da483174ef6b82c\",\"/knowledge-medium/pr-preview/pr-1881/chunks/wa-sqlite-OoRvvvBY.js\":\"a0f2f25b86c81e6a\",\"/knowledge-medium/pr-preview/pr-1881/chunks/wa-sqlite-async-BbIeyChr.js\":\"992aff3f77616bfa\",\"/knowledge-medium/pr-preview/pr-1881/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1881/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1881/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1881/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1881/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1881/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1881/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1881/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1881/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1881/src/App.js\":\"d2a936adb6fae877\",\"/knowledge-medium/pr-preview/pr-1881/src/appUpdate.js\":\"4faec847e70796a5\",\"/knowledge-medium/pr-preview/pr-1881/src/appVersion.js\":\"0595a38618b9f777\",\"/knowledge-medium/pr-preview/pr-1881/src/bootstrap/initialLayout.js\":\"e57ee1242c59490d\",\"/knowledge-medium/pr-preview/pr-1881/src/bootstrap/openWorkspaceData.js\":\"630a32047160ee3a\",\"/knowledge-medium/pr-preview/pr-1881/src/bootstrap/resolveWorkspace.js\":\"80b5104179f9080c\",\"/knowledge-medium/pr-preview/pr-1881/src/bootstrap/workspaceBootstrap.js\":\"37c8874f5ebdc2e9\",\"/knowledge-medium/pr-preview/pr-1881/src/components/BlockComponent.js\":\"df006a9d0cc9140c\",\"/knowledge-medium/pr-preview/pr-1881/src/components/BlockCrumbs.js\":\"806d3c285c24ab31\",\"/knowledge-medium/pr-preview/pr-1881/src/components/BlockEditor.js\":\"1f915223645647bd\",\"/knowledge-medium/pr-preview/pr-1881/src/components/BlockLoadingPlaceholder.js\":\"8f3882f27a6e41c5\",\"/knowledge-medium/pr-preview/pr-1881/src/components/BlockProperties.js\":\"e8ec9e25f1a4fd7f\",\"/knowledge-medium/pr-preview/pr-1881/src/components/BlockSearchPicker.js\":\"925c525a954dc89b\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ConfirmBulkDeleteDialog.js\":\"b3ea9f25479d2636\",\"/knowledge-medium/pr-preview/pr-1881/src/components/DividerHandle.js\":\"34f4b7aa8c30795c\",\"/knowledge-medium/pr-preview/pr-1881/src/components/DraftEditor.js\":\"16d6a897a2186e3b\",\"/knowledge-medium/pr-preview/pr-1881/src/components/GutterPill.js\":\"da197bca0c8ae4cb\",\"/knowledge-medium/pr-preview/pr-1881/src/components/Header.js\":\"e6619d55083a89d4\",\"/knowledge-medium/pr-preview/pr-1881/src/components/LazyBlockComponent.js\":\"797e9ee4488bb7f8\",\"/knowledge-medium/pr-preview/pr-1881/src/components/Login.js\":\"83ac5cad8644f420\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ZoomableSurface.js\":\"f2390c08e52e3a3d\",\"/knowledge-medium/pr-preview/pr-1881/src/components/editModeKeepalive.js\":\"e5ff60a1e9972345\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyDisplay/PropertyDisplayScope.js\":\"da9054acc3eddbb1\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ce7de237e6135d69\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/RefPropertyEditor.js\":\"1ab941d7e57768fb\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/RefTargetTypePicker.js\":\"1a4226c3ff513a2d\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/SelectPropertyEditor.js\":\"9d95aa748246140b\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/TypesPropertyEditor.js\":\"787282a49f348c0e\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/defaults.js\":\"0517e6e97c7583b1\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/kernelValuePresets.js\":\"f14b36503b9b1cc1\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/selectablePresets.js\":\"434bf7e68be8e164\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/typesPropertyUi.js\":\"023a661f423abfb7\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/AddPropertyForm.js\":\"54826148fd53f270\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/PropertyPicker.js\":\"4a7e9caafc080aa7\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/PropertyRow.js\":\"3591c0c167b8ea18\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/Rows.js\":\"9e3a4b61adf3e74c\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/actions.js\":\"eca9e98065edcf56\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/declarationOnly.js\":\"f56ca0c198070cfe\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/layout.js\":\"502ec4e0ecad6aec\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/model.js\":\"d6185f6686a363bc\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/shapeUi.js\":\"9d4a7a478d9af903\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/shapes.js\":\"9a9de7687d0b05e2\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/usePropertyEditingActivation.js\":\"296658df3c022036\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/visibility.js\":\"f6506d37c5ea33c8\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanelSections.js\":\"b46a330839a7ae37\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/BlockEmbed.js\":\"d6e8f8353925e057\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/BlockLink.js\":\"002a28d53795421c\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/BlockRef.js\":\"2be2608dbb43799e\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/ReferenceLink.js\":\"cab2c0c3b6980bbf\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/cycleGuard.js\":\"dd2d5a2df37bb6bd\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/cycleGuardContext.js\":\"d2667508a9522ebf\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/linkInteraction.js\":\"d5fec57aa863bd2e\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/referenceLayout.js\":\"584a531824b192ee\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/useBlockRefAncestors.js\":\"b265dfbc8971f7a4\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/BlockGutter.js\":\"4d1f8d47d7374a6e\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/BlockInfoDialog.js\":\"fd68af30e76457b9\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/BlockTypeBlockRenderer.js\":\"f38c95396df80d7d\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/BulletHoverCard.js\":\"6eb77fee1e23f693\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/CodeMirrorContentRenderer.js\":\"9b605a874890420b\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f17e062b7af20fc2\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/ColumnResizeHandles.js\":\"1d9ffcfde3e62c31\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"78ca8c815d95fe44\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/DefaultBlockRenderer.js\":\"6572ed803a381949\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/LayoutRenderer.js\":\"3a0a63b62a02a0e6\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/MarkdownContentRenderer.js\":\"4ce85ebb393e267e\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/MissingDataRenderer.js\":\"2f2833cecead3a4b\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/PanelRenderer.js\":\"c71a39bb5f5f4d96\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f219d1e9c18c1bcd\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/TopLevelRenderer.js\":\"168f3a0027c9dd77\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/blockGutterMode.js\":\"238f21734ea83a1b\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/blockTitleText.js\":\"f96c49a4ff3bd3b5\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/fieldCreationKeydown.js\":\"278a9e90e28ca830\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/layoutRootContext.js\":\"d5b336508b9799e2\",\"/knowledge-medium/pr-preview/pr-1881/src/components/typeChip/TypeChip.js\":\"31daf2b627802c6a\",\"/knowledge-medium/pr-preview/pr-1881/src/components/typeChip/chipStyle.js\":\"59456a9169f43982\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/anchored-floating.js\":\"d9524c3998d78bf0\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/button.js\":\"9d4e05b10565e619\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/card.js\":\"86dea46cce728acf\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/checkbox.js\":\"9d5255d143be8420\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/collapsible.js\":\"45f001a185297324\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/command.js\":\"396b265161e30c82\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/context-menu.js\":\"369f7b01fbfa5510\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/dialog.js\":\"04afcf819893e354\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/dropdown-menu.js\":\"8a54a225ef6cfa54\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/floating-listbox.js\":\"b84adac55f47df4d\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/index.js\":\"8f23a79f7def3307\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/input.js\":\"bc9675525afbd9a8\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/kbd.js\":\"1e0a923cc4bbd1ec\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/label.js\":\"7eeea6f096b89c3c\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/textarea.js\":\"167e6547c1bb51cb\",\"/knowledge-medium/pr-preview/pr-1881/src/components/useEditModeYieldKeepalive.js\":\"60a2c38c3004a6b6\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/BootFallback.js\":\"d87c65da96ff3019\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/FocusedRowLazyMount.js\":\"70c5aecafad71dea\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/LazyViewportMount.js\":\"59b5a743e88864e4\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/LocalDbCorruptionFallback.js\":\"468ed63f083c20ea\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/error.js\":\"4c908a99a9d0c196\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/lazyMountRegistry.js\":\"3cdcfc3605208216\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/suspense.js\":\"108f51da6971af3b\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/CreateWorkspaceDialog.js\":\"1850cf8a723eec94\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/PendingInvitations.js\":\"478510956a70f340\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/SyncProgress.js\":\"1a4f35f04ce32358\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/UnlockProgress.js\":\"7ec3fd08e3a22bd1\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/WorkspaceKeyGate.js\":\"4010ad2fa47f3c04\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/WorkspaceSettingsDialog.js\":\"ff9a4f6c10b9d210\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/WorkspaceSwitcher.js\":\"07309db65f04499c\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/WorkspaceSyncGate.js\":\"02229f16e57d8bff\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/ConversionFlow.js\":\"1869a680d22e680e\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/ConversionFlowHost.js\":\"615fcca4e012fcbb\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/EncryptionSection.js\":\"e2a4c72a095f6f16\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/attachmentPrompts.js\":\"fa2ff07b1c0f960b\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/bundleFolderPrompts.js\":\"709be11f5d317e38\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/conversionFlowDeps.js\":\"a7c454bed429ff8a\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/conversionFlowStore.js\":\"617d700a0c67e780\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/flowUi.js\":\"68ae42d0479d7e94\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/useConversionRun.js\":\"d8a1cd4d0469c87f\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/keyUi.js\":\"8cb26c450270df9e\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/useCloseOnKeyLoss.js\":\"95a3c43a1c36d08f\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/useCloseOnServerE2ee.js\":\"97a3f1b62a7600fa\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/workspaceUnlocked.js\":\"5f7a3caaed3e5ee4\",\"/knowledge-medium/pr-preview/pr-1881/src/context/backgroundSubtree.js\":\"789196cc70979aac\",\"/knowledge-medium/pr-preview/pr-1881/src/context/block.js\":\"aa7f261758fe6500\",\"/knowledge-medium/pr-preview/pr-1881/src/context/layoutWsContext.js\":\"404ad1f97eb0b9c9\",\"/knowledge-medium/pr-preview/pr-1881/src/context/propertyDisplay.js\":\"82ad5a8f62c53982\",\"/knowledge-medium/pr-preview/pr-1881/src/context/repo.js\":\"e5bd5996bcca0b45\",\"/knowledge-medium/pr-preview/pr-1881/src/data/aliasClaim.js\":\"da583b1c9bc191f2\",\"/knowledge-medium/pr-preview/pr-1881/src/data/aliasSeatNamespace.js\":\"2234e4d17419b753\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/blockData.js\":\"5fd90289616a97cf\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/blockType.js\":\"bd17ff8f000fe820\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/changeScope.js\":\"51ea0d51cd03bff0\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/codecs.js\":\"295bda2a0df4839b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/derivedData.js\":\"a7563a0746aec1bc\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/errors.js\":\"66f14e8356cf7c13\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/events.js\":\"ece415ae4f60c539\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/handle.js\":\"21c44827e5e7ed9b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/index.js\":\"dea5163dc9131259\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/mutator.js\":\"a8211a7cb23f30e1\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/processor.js\":\"8c7a175a77359b0d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/propertySchema.js\":\"000b37c3e35c7709\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/query.js\":\"5d99f5b5f9351fc2\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/sameTxProcessor.js\":\"2d3371cc39d6e5b2\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/schema.js\":\"21c44827e5e7ed9b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/tx.js\":\"21c44827e5e7ed9b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/typedBlockQuery.js\":\"ac703c56876b8132\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/user.js\":\"1eb1cb3729e704e6\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/valuePresetCore.js\":\"40db2dd524ccb662\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/valuePresets.js\":\"68a49fbb6cf012a5\",\"/knowledge-medium/pr-preview/pr-1881/src/data/attachmentCleanerIOVerb.js\":\"e48ab020ab51d821\",\"/knowledge-medium/pr-preview/pr-1881/src/data/block.js\":\"8f30812045389066\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockCache.js\":\"1e3d04665bc09db0\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockId.js\":\"a112d2cfa0c9c5a4\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockLiveness.js\":\"56d00b68ad4349f3\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockMerge.js\":\"c6670ec8320ae79e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockSchema.js\":\"259d10eafe3c08eb\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockTypeLookup.js\":\"699b3ed18fb3a361\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockTypes.js\":\"dea545b9ca3736d0\",\"/knowledge-medium/pr-preview/pr-1881/src/data/childrenView.js\":\"d51e2b4c512ad05b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/clientContext.js\":\"bd4403dbaf08b94c\",\"/knowledge-medium/pr-preview/pr-1881/src/data/dbFileSiblings.js\":\"0aafe2cd4a3b39f4\",\"/knowledge-medium/pr-preview/pr-1881/src/data/definitionSeeds.js\":\"15d0c57636c74bed\",\"/knowledge-medium/pr-preview/pr-1881/src/data/derivedIds.js\":\"0545d1e00fd8fe7d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/drawnSubtree.js\":\"316a80d44c97a3d4\",\"/knowledge-medium/pr-preview/pr-1881/src/data/facetBridge.js\":\"b0ed69c974387867\",\"/knowledge-medium/pr-preview/pr-1881/src/data/facets.js\":\"655213b9e5a6b921\",\"/knowledge-medium/pr-preview/pr-1881/src/data/globalState.js\":\"8f19d8ed7c63e7cc\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/aliasClaimRederiveProcessor.js\":\"9b4c490e7a3597e9\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/ancestorBatch.js\":\"34960943abc59fe2\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/blockTypeTypeifyProcessor.js\":\"d51a2cbd3fe3f700\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/clientSchema.js\":\"885fda57e8fd7e49\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/commitPipeline.js\":\"381ffe1583666d21\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/devAssertions.js\":\"a7f5238edbe59f33\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/firstSync.js\":\"41b364e7f095908a\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/freshInitialLoad.js\":\"12303c0b2eed3d27\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/graphBackfillClaim.js\":\"994f143f97333db0\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/handleStore.js\":\"3f526b4453402111\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/idleMarkerJobs.js\":\"47abf4f551fddd49\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/initialDownload.js\":\"c5ad89e0648d73eb\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/initializeClientDatabase.js\":\"c30206e7f7dfc360\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/jsonCanonical.js\":\"2ba8c0ca2e083ad2\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/kernelInvalidation.js\":\"207198d1188fde3d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/kernelProcessors.js\":\"65b33a21a554bdd7\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/kernelQueries.js\":\"a75a00164d41dccc\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/mergeTypeMembershipProcessor.js\":\"a37c9fe1d05d79b8\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/normalizeReferencesProcessor.js\":\"02693f411043c22a\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/poolInstrumentation.js\":\"f0395643909ab464\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/processorRunner.js\":\"1b3fb02f3ce90560\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyCellBackfill.js\":\"5e9ce3f749613120\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyChildMint.js\":\"f1c841e5c55e8095\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyChildrenProcessor.js\":\"55ef149afc1c67c3\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyDefinitionChangeProcessor.js\":\"41763aa9c55c036a\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyDefinitionSynthesis.js\":\"bfa308cf1169566e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyKeyScan.js\":\"6ef689a706100575\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertySchemaResolution.js\":\"581f885c98b28f2a\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyValueEdits.js\":\"66b2210f9623a685\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/raiseProtocol.js\":\"e247f09e4e51a8bf\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/readBatch.js\":\"15c1f7f4db1e69f8\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/refProjection.js\":\"8143b95e065ace7b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/referenceTargetLookups.js\":\"d8edb20aa7ec6d81\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/referenceTargetProcessor.js\":\"2d765caab6897472\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/replayMerge.js\":\"6f1c93871c981de1\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/sqlBinds.js\":\"b09f039a9ad3e8e6\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"7d55376a40dba456\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/syncObserver/arrivalProcessors.js\":\"bac0b02f049bf3f1\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/syncObserver/invalidate.js\":\"434fad20942abb8c\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/syncObserver/materialize.js\":\"bd76b3377e34d12b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/syncObserver/observer.js\":\"2f096d6cb7c15e66\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/syncObserver/reconcile.js\":\"061e610e0e1acd21\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/timingMetrics.js\":\"f26279e7247e04a9\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/treeQueries.js\":\"6f6203d99048bfff\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/txEngine.js\":\"4286931929f90973\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/txSnapshots.js\":\"0abb3d909a556dec\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/typedBlockQuery.js\":\"c1a41d154cde5c4f\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/undoManager.js\":\"ab6a0fa6c83843e8\",\"/knowledge-medium/pr-preview/pr-1881/src/data/invalidation.js\":\"ebe88c6ab76ab402\",\"/knowledge-medium/pr-preview/pr-1881/src/data/kernelDataExtension.js\":\"dee5048a950f870d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/kernelPage.js\":\"ee626a4e25d734df\",\"/knowledge-medium/pr-preview/pr-1881/src/data/kernelValuePresetCores.js\":\"e75df77329544faa\",\"/knowledge-medium/pr-preview/pr-1881/src/data/localDbCorruptionSignal.js\":\"2180f6ffa605294c\",\"/knowledge-medium/pr-preview/pr-1881/src/data/localDbStorage.js\":\"5f964006ac10d4ba\",\"/knowledge-medium/pr-preview/pr-1881/src/data/localDbVfs.js\":\"73c3fafaab00899e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/localSchema.js\":\"768e4fc8c0cf0d93\",\"/knowledge-medium/pr-preview/pr-1881/src/data/maintenance.js\":\"4217cbe11c57e065\",\"/knowledge-medium/pr-preview/pr-1881/src/data/mergeProperties.js\":\"30fbcf5be2a9cbe6\",\"/knowledge-medium/pr-preview/pr-1881/src/data/metricsConsoleHook.js\":\"478a3794a46a60a0\",\"/knowledge-medium/pr-preview/pr-1881/src/data/migrationsPage.js\":\"c312019543fa9f04\",\"/knowledge-medium/pr-preview/pr-1881/src/data/mutators.js\":\"83b5015250cdc62d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/orderKey.js\":\"e6b65f20b81fc576\",\"/knowledge-medium/pr-preview/pr-1881/src/data/orderKeyPlacement.js\":\"ba74653a07a60cdf\",\"/knowledge-medium/pr-preview/pr-1881/src/data/outlineSurface.js\":\"489f4437869a4d0f\",\"/knowledge-medium/pr-preview/pr-1881/src/data/pendingEditorContent.js\":\"60c190af3c15033b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/pendingUploadsSql.js\":\"7f41c38a101869cd\",\"/knowledge-medium/pr-preview/pr-1881/src/data/pluginStateExtensions.js\":\"cf78870b2b4f662e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/powerSyncLogger.js\":\"68b7ae9d8a458d53\",\"/knowledge-medium/pr-preview/pr-1881/src/data/projectorRuntime.js\":\"a0b852f07b75663d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/properties.js\":\"09d3b7ac493f53c5\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertiesPage.js\":\"24a69bb96b310012\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertyChildren.js\":\"356da74b0a3e02d1\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertyDefinitionFanout.js\":\"9ad12454b70c2123\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertyDefinitionMetadata.js\":\"af030f3bf57ecfc4\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertyDefinitionRegistry.js\":\"f69a5942796c016a\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertyDisplayMode.js\":\"bfdcddf36a3f892f\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertyRowCreation.js\":\"d57fd034b5c3090f\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertySchemaCreation.js\":\"0e012fecd6e5f23b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertySeeds.js\":\"f0cfe65d0ea82a25\",\"/knowledge-medium/pr-preview/pr-1881/src/data/recentsPage.js\":\"5afb73e53320dc87\",\"/knowledge-medium/pr-preview/pr-1881/src/data/referenceBlock.js\":\"5c451056f960c985\",\"/knowledge-medium/pr-preview/pr-1881/src/data/rejectedUploads.js\":\"776f9f91d0f88997\",\"/knowledge-medium/pr-preview/pr-1881/src/data/releasePowerSyncConnection.js\":\"aa00d0c61f2490d6\",\"/knowledge-medium/pr-preview/pr-1881/src/data/repo.js\":\"479fe47e423ffd9a\",\"/knowledge-medium/pr-preview/pr-1881/src/data/repoProvider.js\":\"051326fa7cacc0ba\",\"/knowledge-medium/pr-preview/pr-1881/src/data/rowProperty.js\":\"1b6d697b786cab3e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/searchFilter.js\":\"be667aea8b0e6160\",\"/knowledge-medium/pr-preview/pr-1881/src/data/seedIdentityLedger.js\":\"e931aaafbd4c7892\",\"/knowledge-medium/pr-preview/pr-1881/src/data/stateBlocks.js\":\"8d008a0cd00ec95b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/structuralEditPolicy.js\":\"cd197abf46530791\",\"/knowledge-medium/pr-preview/pr-1881/src/data/structuralInsert.js\":\"14617ec22f055726\",\"/knowledge-medium/pr-preview/pr-1881/src/data/subtreeDelete.js\":\"fc0fd863064d0421\",\"/knowledge-medium/pr-preview/pr-1881/src/data/syncStreamLock.js\":\"2762fdc110934ccf\",\"/knowledge-medium/pr-preview/pr-1881/src/data/syncedTableSqlRecognizer.js\":\"0f2e1b4db0017680\",\"/knowledge-medium/pr-preview/pr-1881/src/data/syncedTableWriteGuard.js\":\"6f602b4abf154a83\",\"/knowledge-medium/pr-preview/pr-1881/src/data/targets.js\":\"f6451a1173802902\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeColors.js\":\"792f1b981777ca6f\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeDefinitionMetadata.js\":\"c7eff487aacc0ace\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeDefinitionRegistry.js\":\"78c5f0bb706ef4aa\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeExtraction.js\":\"de01aa0d1d5983a1\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeInitialValues.js\":\"a3878810df978c83\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typePropertyGroups.js\":\"54c3a8704605c91b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeSeeds.js\":\"1413202b4a6350a5\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeTagger.js\":\"eb3f6bdff1b14f94\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typedRecords.js\":\"1374324a2da0bd43\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typesPage.js\":\"9300fc63f8b506ed\",\"/knowledge-medium/pr-preview/pr-1881/src/data/userPrefs.js\":\"42a2ca7019e80e5c\",\"/knowledge-medium/pr-preview/pr-1881/src/data/userSchemasService.js\":\"49aa42bd6813965e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/userTypesService.js\":\"f5e2185c8966cb77\",\"/knowledge-medium/pr-preview/pr-1881/src/data/valuePresetRegistry.js\":\"6b94a6aa70ea9822\",\"/knowledge-medium/pr-preview/pr-1881/src/data/visibleChildren.js\":\"89e85de371333458\",\"/knowledge-medium/pr-preview/pr-1881/src/data/workspaceConversion.js\":\"7e2c1d6430e01f26\",\"/knowledge-medium/pr-preview/pr-1881/src/data/workspaceFirstSync.js\":\"27a765d1bfa85622\",\"/knowledge-medium/pr-preview/pr-1881/src/data/workspaceIdNamespace.js\":\"b6c3556ebc47e3cc\",\"/knowledge-medium/pr-preview/pr-1881/src/data/workspaceSchema.js\":\"57d9da7f9b306d5c\",\"/knowledge-medium/pr-preview/pr-1881/src/data/workspaces.js\":\"dae6fd82ffcb6bde\",\"/knowledge-medium/pr-preview/pr-1881/src/data/writeAheadLog.js\":\"6f74f06534dae21c\",\"/knowledge-medium/pr-preview/pr-1881/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/BlockPasteShellDecorator.js\":\"1a05940abbd43328\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/atTrigger.js\":\"35c67fff24ce9c61\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/autocomplete.js\":\"bd7678670298af40\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/codeMirrorExtensions.js\":\"e323b2f57519b053\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/contentFlush.js\":\"debfbf5fa8a63c87\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/defaultInteractions.js\":\"f2f8468ea0ddf7c6\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/editSettleSignal.js\":\"b57d00b98ffe5f17\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/insertImage.js\":\"c8c9a971b6acaa51\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/referenceCompletionRange.js\":\"c866bf7f592f3432\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/referenceTargetTypes.js\":\"9f3548d139be3ac7\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/syntaxContext.js\":\"57a85950bb3af931\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/triggerMatch.js\":\"25d446bf20796167\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/AppRuntimeProvider.js\":\"77b1b6469c75eef5\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/BlockFocusShellDecorator.js\":\"a502baf17f2c51a5\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/ExtensionRenderBoundary.js\":\"e2d6226e4790cb64\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/PanelContentRecovery.js\":\"cfc11b7864d3628c\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/apiCatalog.js\":\"c786ac9b88a48279\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/approveExtensionHere.js\":\"e2f3c0f934df6a48\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/armedCutAppMount.js\":\"d51f92ba8a0dd7b3\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/batchableKeyedStore.js\":\"00522c4d759b8b09\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/blockInteraction.js\":\"24ccce014a3a7d16\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/blockSelectionAction.js\":\"3b3c88e39b17e586\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/compileExtensionModule.js\":\"77cfafcc443e027c\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/compiledModuleCache.js\":\"708bc745fd053d9b\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/continuousGestures.js\":\"4b238b2a5477aba5\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/core.js\":\"e5dbee2d62c1c65b\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/defaultRenderers.js\":\"21eac35e53b4bd50\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/definitionFanoutAppMount.js\":\"616cfab2c22b18a9\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/dialogAppMount.js\":\"8c87ff2737fa7fd6\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/dynamicExtensionSeeds.js\":\"4834a67fee0a765a\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/dynamicExtensions.js\":\"746c7ba8a5b28055\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/exampleExtensions.js\":\"cbe57330472a8948\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/extensionApprovalStatus.js\":\"0a9c4e008aa53af7\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/extensionLoadErrorToast.js\":\"3d81cb4f9779d058\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/extensionLoadErrors.js\":\"80726e1cfc2f3b2d\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/extensionLookup.js\":\"c8f2195918a128a1\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/extensionToggles.js\":\"fba4170f8a739864\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/extensionUtilitiesCss.js\":\"9d3d97e03de1d44b\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/kernelPageDeletionGuard.js\":\"49b267aadb620e03\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/liveRuntime.js\":\"87ab8d930f5e1c1d\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/openExtensionsSettings.js\":\"1a16dea7d91e0111\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/overridesCache.js\":\"7c0b8c5af4d319d3\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/pluginIds.js\":\"72e0dbd1d26d1e0a\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/processorRejectionToast.js\":\"94cc9bb8f3281f62\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/runtimeActions.js\":\"00e56acf729f51b3\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/runtimeContext.js\":\"49234579ef974db3\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/staticAppExtensions.js\":\"e359516f818cd68f\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/staticDataExtensions.js\":\"dfcd170aea6e6294\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/toastAppMount.js\":\"2bed514ac21c0614\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/useOverrides.js\":\"3c57e38ab6b0fbaa\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/useShortcutSurfaceActivations.js\":\"0ec2ad3b1f394024\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/discoverToggleTree.js\":\"cb5f7e25c3726ade\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/facet.js\":\"04bfbbfd437ff9e8\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/resolveAppRuntime.js\":\"144c64f30bdec55f\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/runtimeEvents.js\":\"9132dc6b62449343\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/togglable.js\":\"eba0f8416f176ab6\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/variantFacet.js\":\"e28efa9b2db10e15\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/verbFacet.js\":\"d3881bb56125f775\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/block.js\":\"4027b664ec00eb9a\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/focusedChild.js\":\"0f180d57ee9b9c85\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/propertySchemas.js\":\"7ebb6474607f71e4\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/typeRegistry.js\":\"37faa780a84ba169\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useAncestorCrumbs.js\":\"52d82ea28b56e7b5\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useAutocompleteListbox.js\":\"14c1a1580e97d334\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useDebouncedSearch.js\":\"64a8bc7609095527\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useDebouncedValue.js\":\"5130b48974733e9a\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useIsFocalRender.js\":\"5e8297167170e20e\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useIsReadOnly.js\":\"3c8af8377785bb34\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useMaterializeBacklog.js\":\"69615bbd4a5e3705\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useMinuteClock.js\":\"da4689c5f70ae88a\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/usePanelLayoutProjection.js\":\"5645085d1b81698c\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/usePendingInvitations.js\":\"ec9899747b663427\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useRendererRegistry.js\":\"26b153b263b819fb\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useRetainedFieldRows.js\":\"ed585059c378ece7\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useWorkspaces.js\":\"6e2c8ca45e213157\",\"/knowledge-medium/pr-preview/pr-1881/src/lib/utils.js\":\"29a60368f85524ec\",\"/knowledge-medium/pr-preview/pr-1881/src/main.js\":\"5a52b3ab006faecc\",\"/knowledge-medium/pr-preview/pr-1881/src/markdown/MarkdownImage.js\":\"506332b09f1f176d\",\"/knowledge-medium/pr-preview/pr-1881/src/markdown/blockSeparators.js\":\"c28cd5c646e676d8\",\"/knowledge-medium/pr-preview/pr-1881/src/markdown/context.js\":\"18d24f11ff36ad0a\",\"/knowledge-medium/pr-preview/pr-1881/src/markdown/defaultMarkdownExtension.js\":\"c3ab8e9991c16ba5\",\"/knowledge-medium/pr-preview/pr-1881/src/markdown/extensions.js\":\"610014bcec53b459\",\"/knowledge-medium/pr-preview/pr-1881/src/markdown/renderMarkdownHtml.js\":\"2e6a86f185b6c695\",\"/knowledge-medium/pr-preview/pr-1881/src/minimal-editor.js\":\"2d109bd10f9f7809\",\"/knowledge-medium/pr-preview/pr-1881/src/paste/armedCut.js\":\"a92e08e1622f8435\",\"/knowledge-medium/pr-preview/pr-1881/src/paste/captureMediaVerb.js\":\"13fd2acae741e700\",\"/knowledge-medium/pr-preview/pr-1881/src/paste/clipboard.js\":\"774ead062abf11a4\",\"/knowledge-medium/pr-preview/pr-1881/src/paste/decision.js\":\"c42efa0c6abe754e\",\"/knowledge-medium/pr-preview/pr-1881/src/paste/operations.js\":\"732fdfdd68f2306e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/account-header/AccountHeaderItem.js\":\"2f97cc2efba5568a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/account-header/index.js\":\"8f3cc28d64f6d4df\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"abee9b0b09cd0dd9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/askAgent.js\":\"91668d272c4ad0b8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/askedStore.js\":\"c29f817e06511e27\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f1958f0e73600f50\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/chipState.js\":\"588e67ed99a5e6ba\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/dataExtension.js\":\"cbb13a57cb5c72a3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/index.js\":\"3a899031bc740b13\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e255034f37cf2453\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/schema.js\":\"224bab41610d4512\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e82107fbbed04c98\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/BridgePairingDialog.js\":\"505620b54dfda325\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/addMedia.js\":\"b39c8a7ef7f192be\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3ba3e7080f35fd5e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/block.js\":\"57981769ef8ade39\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/context.js\":\"5c09293f81484a99\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/displayIds.js\":\"dd8a84dcf4474e3e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/index.js\":\"d447d4db1e8b485e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/outline.js\":\"32ee9c99985e24e0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/properties.js\":\"b0aa41b882083813\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/refs.js\":\"1d493ad3cb0a3a41\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"cbf3bc64ef5b85ce\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/search.js\":\"e5b49e8fbc4ec674\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/shared.js\":\"c392d64270f3dd2c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"4f95a5116b9b0d2c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/text.js\":\"f606e82ab4b7d652\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentWrites.js\":\"c6a36d25ee706887\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/authoringCatalog.js\":\"2ac8fc4fb6943408\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/blockRefTargets.js\":\"d0f9c2807d6ac831\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/bridge.js\":\"4af65b2e5aad5e0f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/bridgeLoop.js\":\"7a051df9ad5b1ce5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/changeHistory.js\":\"a76d126cfcf56255\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/commands.js\":\"d6f159bba819f758\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/commentsCommands.js\":\"466735430e308b12\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/dataExtension.js\":\"fe8305bd57af199d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/dataModelGuide.js\":\"c296a2e2899f2caf\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/describeRuntime.js\":\"db91ffc4a6375138\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/extensionLint.js\":\"3e886130d95bf788\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/grainAudit.js\":\"799f5e63531380ca\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/healthCommand.js\":\"27cfe1af13b4f1aa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/index.js\":\"095c85624d30ec90\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/presetIdentity.js\":\"77c55ed56181e824\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"db63ee3132ec3516\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/readMedia.js\":\"0398e54efa8dd438\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/schema.js\":\"f0bf19db71680500\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/serialization.js\":\"63d2b3d62ef4cca8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/targets.js\":\"4f40c11cc405787b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/tokens.js\":\"b769589449d81c89\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/watchEvents.js\":\"ee389ff3e688c65e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/workspaceGuard.js\":\"493f84f0a61e1ba4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/writeCommands.js\":\"c3ae9d414357be6d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/AliasCollisionToast.js\":\"a17f85d236889e53\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/DuplicateNameBanner.js\":\"e565feb939d7c306\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/collisionMerge.js\":\"b05cf1e0ef4bcf67\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/dataExtension.js\":\"4c7b4dc675a54e1a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/index.js\":\"ca01bd84a7033b05\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/mergeCollisionAction.js\":\"ec259c814decafba\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/pageStyling.js\":\"2b41d0b05436c1bd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/rejectionToast.js\":\"a5d89ad3385770eb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/syncProcessor.js\":\"c5f4b8c382a224a4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/actions.js\":\"6896db570f0507ee\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/addComment.js\":\"c362007c9c37b90d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/anchor.js\":\"e2638501660f7ee4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/anchorState.js\":\"03b93d7fadf8d6ea\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/commentLinks.js\":\"c6faf4d539f0b036\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/confirmThreadDeletion.js\":\"1bab5ae4818e1bf0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/container.js\":\"3b0231cd01f8c885\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/dataExtension.js\":\"e3ae89de4f1b1796\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/deleteComment.js\":\"78ee4b7e60f7d2f8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/highlights.js\":\"7e6c66766202a39a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/index.js\":\"d29dea6ac356f6c1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/linkedCommentsPill.js\":\"cd19916242c38c28\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/margin.js\":\"b4d439d098c821fc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/marginAnchorLinks.js\":\"ad01352440522907\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/marginSchema.js\":\"a3ba97af7465b76a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/newComment.js\":\"6ff1f67ed545ea34\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/ownThreadPicker.js\":\"a38f6b737a6a2377\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/placement.js\":\"cdec371dd9017ce5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/queries.js\":\"5d10518c1364fe53\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/quotePosition.js\":\"feb37f8783064317\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/quotedIn.js\":\"65951d996926717e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/quotedRange.js\":\"5c803f13da5fbc94\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/rangeRefs.js\":\"4597015f1bf35a24\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/readHighlights.js\":\"2b6cafe8b55c77a7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/readSelection.js\":\"f4fa99c63732c07d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/readSelectionUi.js\":\"417dee280fdc8473\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/reanchor.js\":\"420978d585864f19\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/schema.js\":\"eabc85dc62d2cbde\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/scope.js\":\"09ce8d34c17359c4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/scopeThreads.js\":\"e385bd696d286fdc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/splitRetarget.js\":\"565da74768fc00e4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/suggestionCard.js\":\"b41c2f7f09a8f54f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/suggestions.js\":\"7a0b5c1b2ad6b1ad\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/summaries.js\":\"4a9b85ecb8a0568f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/summaryBatch.js\":\"8c1e431cd3842355\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/surface.js\":\"3c05660b573ac710\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/threadNavigation.js\":\"3bbbc110e7e2b8a4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/threads.js\":\"6599d0dd37bfc10b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/ui.js\":\"fcac13be4bdbf9ee\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/uiStore.js\":\"339728c007e4a624\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/app-intents/appIntents.js\":\"2ae7fa23eacd252c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/app-intents/index.js\":\"cae4aa8cc843d9fc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/app-update-prompt/index.js\":\"14857b9502006a15\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/app-update-prompt/status.js\":\"a253fd87eef7ba19\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f69251d76a1ace09\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/MediaBlockRenderer.js\":\"3aab4a8a1dcc9016\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/MediaDownLaneReplicator.js\":\"bba5477bf9f79bdb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/MediaUploadReconciler.js\":\"8ec16552ec0a3c6f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/assetDownLane.js\":\"9f5960c75e84765a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/assetResolver.js\":\"f324046fd125254e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/assetUpload.js\":\"b4dcb36d809fea1c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/attachmentCleanerIO.js\":\"5640601933da0997\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2638627a8ce54498\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/blobStore.js\":\"fb45fd4112c97117\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/browserMedia.js\":\"67acb9568858628f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/byteStore.js\":\"46a473792b05a734\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/cleanerIO.js\":\"54acdfab2e435c89\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/cleanupAttachments.js\":\"20570abb390e45d4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/dataExtension.js\":\"9d11ec2524a8eeb2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/downLane.js\":\"d812711338b6abe4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/index.js\":\"5ffaba5eaa906a3e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/insertImageContribution.js\":\"6c2b97e1c3897c4f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/laneArming.js\":\"bb77e721befc27a8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/laneLock.js\":\"2970d3abc09154b6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/mediaBlock.js\":\"092421c8634e1e37\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/mediaCapture.js\":\"b6e35da7d20bc3de\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/mediaLanes.js\":\"384f4abacb6a1606\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/mediaViewers.js\":\"c0f53657053ad8f2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/mediaViewersFacet.js\":\"71da4206eee159f4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/pasteCapture.js\":\"5c03dfdd1754fe66\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/resolver.js\":\"c807ee708f4cad85\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/retryUploadsAction.js\":\"b7b3d0f32d8c8a7c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/storagePaths.js\":\"d4c9539869bb5ab4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/uploadDrain.js\":\"cea488b6410d526a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/uploadLaneStatus.js\":\"e8fa51180bb63715\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/uploadReconcile.js\":\"c438af729cd041a3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/uploadRecovery.js\":\"3b089eefc320a467\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/uploadStore.js\":\"27bdcda96f30f554\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/useAssetObjectUrl.js\":\"e07a4131907365ea\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"7a72533549611fa7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks-view/BacklinksViewSection.js\":\"62e77bf65141278e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks-view/facet.js\":\"9c655fc8df5ff5cd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks-view/index.js\":\"44863e1f2811c124\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks-view/prop.js\":\"4c21b0beeab3d08a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/BacklinkFilters.js\":\"e99bbbec86ed2727\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"fe73d89cc6806245\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/BlockEntry.js\":\"520a27545f83ab85\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/LinkedReferences.js\":\"13210f3a3499a3c3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"a019d0cd7ede1dd7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/dailyNoteDefaults.js\":\"750f3ceb23d3d05f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/dataExtension.js\":\"09e5d0e1aa64b670\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/edgeExclusions.js\":\"19d442e7c6116a1c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/filterProperty.js\":\"3763316366e36808\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/index.js\":\"d2f3f14f4b66558e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"3f89d6c64c9ee188\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/inline-counts/applies.js\":\"958cb07477b3235d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/inline-counts/countQuery.js\":\"332aa124ac49bf59\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/inline-counts/expansionStore.js\":\"3551b8f44ee4516c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/inline-counts/index.js\":\"726eff12bc88b626\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"edd8329fc2d6b525\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/presentationInvalidation.js\":\"124f22a454d8e631\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/propertyEditorOverride.js\":\"386ee76926af81fe\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/propertyFilter.js\":\"608017e31b91d746\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/query.js\":\"3a1da5d541e80da5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/resolveFilter.js\":\"a53db0ecfeefc21c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/sourceBatch.js\":\"10ae337fc6ea9afa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/sources.js\":\"ae9e4bfd2ded3410\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/useBacklinks.js\":\"80a30dc299fcc2aa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5f7822a898de74ec\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/birthday/BirthdayCelebration.js\":\"dcbd3dc37a1e73c0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/birthday/BirthdayOverlay.js\":\"2b1e399f5c319a4a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/birthday/gate.js\":\"122a76e0061f42cb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/birthday/index.js\":\"09d257a9373d5486\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/birthday/wolfTheme.js\":\"fd35305a23a1a575\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-drag/BlockDragLayer.js\":\"ba9282bfe484f802\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-drag/dragController.js\":\"96ac9e158fcbb441\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-drag/dropTarget.js\":\"4910a2a66f50c043\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-drag/index.js\":\"40821ce47b75cb75\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-drag/projection.js\":\"39510744cbbaa240\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-info/BlockMetaCard.js\":\"6baaefb57fb83360\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-info/index.js\":\"7cd044d293d25124\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/AddTagDialog.js\":\"03e4ddb426bc8039\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"01034e1c2900c5f2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/TagNameIssueHint.js\":\"13b3108f75663de1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/addTagAction.js\":\"a84b4b2146048c74\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/appendTag.js\":\"6566cc6249935010\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/config.js\":\"1b4f17b03b417313\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/dataExtension.js\":\"d6ab9803c1fed541\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/index.js\":\"1b480c9931655e61\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/propertyEditorOverride.js\":\"5170561c69130d6a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f82ea898874baea2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"b16568c5e24fc4a3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/Breadcrumbs.js\":\"85a6e3e8a5b218c7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"9ff0bc8a7a86639e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"da2f74f337f2102a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/index.js\":\"96e76e06cf31e26d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"dc5ebb544b75e735\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/CharacterCountItem.js\":\"080ac08400f96b3f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/ProfilePropertyEditor.js\":\"c8abec817483ca99\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/actions.js\":\"4d84d86e6ff70c79\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/blockType.js\":\"b9adc916801f4593\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/charCount.js\":\"10b8cd826add75b4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/dataExtension.js\":\"da0b17377f86e641\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/index.js\":\"4fd35e2cd6163751\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/profiles.js\":\"c2533ea93a6a1b8b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/properties.js\":\"0b19791d9994149a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/textCounts.js\":\"9e4db7065ce59be6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/colemak-keybindings/index.js\":\"1de9dbfe567fa5da\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/CommandPalette.js\":\"199d8221ebaac92d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/HeaderItem.js\":\"57da2247f811453c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/context.js\":\"38600dd227b09d47\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/index.js\":\"1b337ce5903dda79\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/selection.js\":\"7fbe155d60eefa93\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/toggleStore.js\":\"e6eb75b520bf04b8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/useCommandPaletteActions.js\":\"92256d220b2f9aad\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/ContributorBadges.js\":\"feb30a3edf23c37b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/author.js\":\"450a08dd19a4d47e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/codeMirrorExtensions.js\":\"efbc7bb8a4b7fa57\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/dataExtension.js\":\"65f3a533df0d2467\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/index.js\":\"1fd1703a67e3eb57\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/mentionAutocomplete.js\":\"afa2d4e4aa6df2ba\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/processor.js\":\"3cd264ebdd81ff43\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/profiles.js\":\"893abfb9ad614218\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/queries.js\":\"19b7e97286da4833\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/schema.js\":\"dfb56304ecc92c82\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"6ad93e9224eff5eb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6eafe40da0a994dc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/cursor-follows-scroll/index.js\":\"9acddebfdb5aad42\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6c9342515b883060\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"a1db2022801476f3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/CalendarGrid.js\":\"e703795a67fb28f7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/DailyNotePicker.js\":\"98af6e2017c25ada\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ac29777ca2de6ab5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/DateNavDecorator.js\":\"f5fc0cca6e3e0101\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/DateScrubOverlay.js\":\"444d5e1a04c49805\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/HeaderItem.js\":\"2e5aec1438386221\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/ReschedulePicker.js\":\"45e6dc012d3624f5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/SpreadDatesDialog.js\":\"ad4a9e86ff734364\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/actions.js\":\"f2cc2e947991a61d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/blockDateAdapter.js\":\"3cfc9c9cb33148e1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/calendar.js\":\"22989e81b6b264cb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dailyNotes.js\":\"cbd540d66e83e577\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dataExtension.js\":\"eae35eeb5eecc64d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dateScrubActions.js\":\"f2ba29182c1be573\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dateScrubGesture.js\":\"077f4c72d41b8672\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0fa8f41b2692f938\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dateScrubRecognizer.js\":\"99cb527ba821fa2e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/deletionGuard.js\":\"7a102685d05b534d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dueQuery.js\":\"dcc1acb59139771d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/index.js\":\"5939199c07e2b866\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/landing.js\":\"60201461c729271a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/localSchema.js\":\"0bf82a6d857bfd25\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/referenceDateAdapter.js\":\"15d951eef40e1d9e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/rescheduleAction.js\":\"983d0516beaae7e1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/schema.js\":\"40e57f2590f32907\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/spreadBlockDates.js\":\"6e2302b36fad524e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/spreadDatesAction.js\":\"a791e29f7ca9d0e6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/today.js\":\"e7a2a1f15f349a63\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"7f58d21f149a4e64\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"8715f36dd4da7b11\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/audit.js\":\"b175cc3abf0c39b5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/auditAction.js\":\"7f2fad19e9f6b45d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/auditRanges.js\":\"7e2d88b39d745c77\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/diagnosticsSource.js\":\"66f33d795751e5b4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/divergenceScan.js\":\"55de4ecc500c89e8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/index.js\":\"d64a0e9e21f81928\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/propertyChildrenChecks.js\":\"de105646cae03d65\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/referencesMirror.js\":\"0988842f0b8fa702\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/rowJson.js\":\"33946ab0d3986793\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/schedule.js\":\"888ef780af7ae4f6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/store.js\":\"cc2aa2d24c725d11\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-maintenance/action.js\":\"090016af6d850e7a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-maintenance/index.js\":\"7635de84dd3c2646\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-maintenance/plugin.js\":\"e99634c44544d0c7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"dfdeed5c562dfe38\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/actions.js\":\"6571b1ee613b5c61\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/changeMarker.js\":\"472c6d737a3ce893\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/diagnostics.js\":\"9ad047a8ba3be6e4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/fileSystemAccess.js\":\"dabacf1b0978fc73\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/filenames.js\":\"5e0c999c63928d65\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/index.js\":\"62788eb9574350e5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/mirror.js\":\"187a31d2806a79e5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/runLock.js\":\"66fc22ab1c001025\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/runtimeHealth.js\":\"4641aac350a2d28a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/schedule.js\":\"29945131c7e3c9d2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/store.js\":\"9267b92077325fdb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/default-themes/index.js\":\"099d054a640b498e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/default-themes/themes.js\":\"d29af0f572a5bcbe\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/diagnostics/facet.js\":\"89a352f089540fd2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/diagnostics/useDiagnostics.js\":\"de6f2fac26592fd9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extension-prompts/dismissals.js\":\"ec9d83d5420485db\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extension-prompts/index.js\":\"8e5346d6780e02ff\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extension-prompts/status.js\":\"69f409904985b1f4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extension-prompts/store.js\":\"123f1e7e0041effc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"955529b5a8f4f4a6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8e0bd7b4690ee615\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/actions.js\":\"fb5301932c329e5a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/config.js\":\"2204c6e2a0a282cd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/dataExtension.js\":\"06df9e6bb35e2a5e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/effect.js\":\"1c57e142548b3878\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/index.js\":\"6d6360f004db0f43\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f1a2bd780418f057\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/useToggleTree.js\":\"3e84bf4f1aae4d98\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extract-type/ExtractTypeDialog.js\":\"b56f49cfb40bf689\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"bc3d3ca9665de948\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extract-type/PropertyShapePicker.js\":\"406f79ce144128ed\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extract-type/action.js\":\"505562a003f37e3f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extract-type/index.js\":\"56028b10c3c7fd72\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/FindReplaceDialog.js\":\"92b800dcf7e4c8a8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/HeaderItem.js\":\"9fd5be6e2b21864f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/dataExtension.js\":\"afdd6b17c8e6c449\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/index.js\":\"5199176e4ea5d9b2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/search.js\":\"116a3f707c510ee8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/toggleStore.js\":\"37c13bf81fd11e10\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/LocationPropertyEditor.js\":\"34b39e9dc093793d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/MapView.js\":\"1a1dea5bbb8a4f94\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/blockTypes.js\":\"8686ce1cd05cf7cb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/codeMirrorExtensions.js\":\"75d98b8dea0364bd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/createOrFindPlace.js\":\"447f0c08f722825a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/currentLocation.js\":\"99ce534469a197f2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/dataExtension.js\":\"2db9d947b7f0518d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/geoContentDecorator.js\":\"a1b073d97e3537ed\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/googlePlacesClient.js\":\"d4afece0c6ba1cb7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/index.js\":\"7f7d3377002c1ae1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/locationsPage.js\":\"7ac8d5ce6788d00d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/mapViewport.js\":\"7c72c3a50678e651\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/pickCurrentLocation.js\":\"6cf632a6b2689ddf\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/placeAutocomplete.js\":\"3678f72b29dd92c6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/placeNameCollision.js\":\"d010c426ab42ed97\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/properties.js\":\"4aa214bf43077ade\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/propertyEditorOverrides.js\":\"a81f6eae4b58ee0f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/query.js\":\"b9aecdcae3ee798d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/usePlaceSearch.js\":\"90b41d00121526ae\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"2c6864cb9bb241a2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a8245fc8631aea25\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"09411ba6dc3ad5b3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/config.js\":\"d3e3fa039e7f6475\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/dataExtension.js\":\"855198e3d929a3f7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/facet.js\":\"1c0b9de11e7fbdb2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/grouping.js\":\"4e863d24198939fd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/index.js\":\"c07373aafb2fd5f6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"0e3bc123549a4c8a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/query.js\":\"f2eb80c235b485d8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/resolveConfig.js\":\"7d18d409b1f5174a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"10cba9f37476fdd3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"2864cb9bb25f9b51\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/HtmlDocumentContent.js\":\"c3b85911ddec9673\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/HtmlFrame.js\":\"4d40e3e5cfca06c1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/actions.js\":\"ef9a6868840f30d0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/blockType.js\":\"3bb0dbd385c0d957\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/confirmRunScripts.js\":\"02283e99f69b5ca2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/dataExtension.js\":\"4f3de61f5e414318\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/frameAnnotations.js\":\"817c25a3c815ffe5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/frameDocument.js\":\"9ac7cae740dd8f88\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/frameTheme.js\":\"e6b6a0274d5e592d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/index.js\":\"b93ea9e471a820a4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/scriptConsent.js\":\"d83766a5430a9182\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/sourceMap.js\":\"c07f67fe0b4ee4f0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/useDocumentScripts.js\":\"32533c1c106bb9e0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/interaction-metrics/index.js\":\"83a5393550e0eab8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/interaction-metrics/record.js\":\"d236ddfc5e960b29\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/interaction-metrics/recordStore.js\":\"c3c933bd6659fa3a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/interaction-metrics/responsiveness.js\":\"6b62556ed8cf737e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/interaction-metrics/schedule.js\":\"583de0fcea67112e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/interaction-metrics/sessionContext.js\":\"4b2086a151fa6a27\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d5bc1e3ae7f030ea\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"05c3444c243f8660\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/actions.js\":\"d009792334bc16ae\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/config.js\":\"9551e5678ace3160\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/dataExtension.js\":\"92c5f5bfb2797af0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/effect.js\":\"47899558dc4c7ee4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/index.js\":\"53420023ecda1d36\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/keyCapture.js\":\"f71dd9e410ff6da3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/overrideStore.js\":\"f5f5121cbae5311e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"eb15ff7d6973a2fb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/HeaderItem.js\":\"77c17b0b13bf8e15\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/LeftSidebar.js\":\"665ac6f77b940f97\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/actions.js\":\"49c835dc1c2d75d6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/facet.js\":\"caf73e6688c7ef56\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/index.js\":\"52e69ef4e46c39fc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/shortcuts.js\":\"3148601c4d413a16\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/toggleStore.js\":\"826b4da6e1a77ff8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/merge-blocks/MergePicker.js\":\"2037a62e51b0d94b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/merge-blocks/index.js\":\"7473f7b2c13e6c92\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/merge-blocks/mergeAction.js\":\"229829ace7d3199d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/merge-blocks/strategy.js\":\"c721c0b489a58471\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-bottom-nav/Button.js\":\"824440ae7ede7ca4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"db1a7b591a40d475\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a3f0e7d99d91bcac\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-bottom-nav/facet.js\":\"9b5c3c32609441c7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-bottom-nav/index.js\":\"be81bf8a1f1056b9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d63894b90c135bbf\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5c28be2ec4cf63ad\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"03f6aed13f70f3aa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-keyboard-toolbar/facet.js\":\"070ac9da25886b6d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-keyboard-toolbar/index.js\":\"3c619fc4d6aaee1f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5fdc97ff7ff3c936\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/blockSubtreeMembership.js\":\"8d0ffe2374067e22\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/contextMenuItem.js\":\"65f9a68257e565dc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/index.js\":\"8cee762ef6d9bea1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/moveAction.js\":\"b19d4a182596cebc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/moveBlocks.js\":\"89b08c339cf3eabe\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/selectionAfterMove.js\":\"55f6aafbb6ddec9b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/TutorialBanner.js\":\"bc9aaf2850cb037f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/action.js\":\"2bacc50626e312b8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/bannerDismissal.js\":\"0c13b69181b0585e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/documents/cheatSheet.js\":\"2679d0e4b35de454\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/index.js\":\"7bdf78b21edf55b9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/keys.js\":\"1c9d4202ce5bc0db\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/landing.js\":\"72760348213d048f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/outline.js\":\"de8cd708af71b7d1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/seed.js\":\"743017355c283656\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/PerfTrendDialog.js\":\"caf304254f57a74b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/analyze.js\":\"5c00fdc17c93278c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/diagnosticsSource.js\":\"1154ea76d372d686\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/index.js\":\"e5a43e468cfe86f2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/load.js\":\"f842b8c5dcb6c63d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/monitorRun.js\":\"55cbfa1d2d541757\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/schedule.js\":\"d982f84e939a8d22\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/series.js\":\"b17e973e843d61c4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/store.js\":\"a72ddbc4976a3eda\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/trendAction.js\":\"d2f8c56b22b9d03c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/verdict.js\":\"80ebf5be2abf2740\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/plain-outliner/clickToEditAction.js\":\"fac616670a7a7237\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/plain-outliner/index.js\":\"2b19de61eeb9d389\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/plain-outliner/interactions.js\":\"09e0122a193a4ade\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"872742a55165e45d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/MigrationGate.js\":\"53fa54f126bec0e4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/MigrationGateDialog.js\":\"7bc720a013ed2b12\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/action.js\":\"e359900c337cb8ee\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/index.js\":\"da1b5aab1e171501\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/localRunMessage.js\":\"d53d83f9f70a1f40\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/plugin.js\":\"06a83cb0bcea1242\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/progressReport.js\":\"2790eff655e2b827\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/sweepProgress.js\":\"acee376d1149b378\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/FieldRowRenderer.js\":\"6bafdb12df4554e0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/ValueRowRenderer.js\":\"0d527b42eeb09728\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/actions.js\":\"46abe9d0a6245ac6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/autocomplete.js\":\"9e6a5b770ab393b2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/fieldRow.js\":\"dd983835748bfbb9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/index.js\":\"13d705f690e53e46\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/referenceWarning.js\":\"1476ea78f53d78bf\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/valueAutocomplete.js\":\"18051638ca4b42b0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/valueSchema.js\":\"69c5376cf0d7499a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/HeaderItem.js\":\"be1bbf2a356930bf\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/QuickFind.js\":\"149c48c11940c90b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/index.js\":\"02b9cef83734fad9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/recents.js\":\"710c4b38a0ff7fe1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/resultItems.js\":\"6e2b333aa729a52c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/selection.js\":\"e2d521f0247b6c07\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/toggleStore.js\":\"66fb7ffd6c2dc6fd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/recents/HeaderItem.js\":\"993b94d34468be70\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/recents/RecentsPageBlockRenderer.js\":\"9baf67a274214961\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/recents/grouping.js\":\"696015e2110d7c0f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/recents/index.js\":\"b2d80cbf1999a5be\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/recents/target.js\":\"170ce1745e0034b1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/codeMirrorExtensions.js\":\"669d2f66f2f1d0c0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/contentPrefill.js\":\"5da12293704e0a5c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/dataExtension.js\":\"dc5bb6f5e6498ea2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/index.js\":\"919c39b43b83341b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"40f5688160c8136b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/invalidation.js\":\"3dcf4190da1cb576\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/localSchema.js\":\"fe0bec945655793e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/blockrefs/index.js\":\"b5eb93989c01198b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"ff374d13ad38120b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/index.js\":\"68b83f38a5296565\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/referenceNode.js\":\"70d6d64b3b7d87cb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/remark-reference-occurrences.js\":\"970c117705f83349\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"1d2dfa7f00bba854\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/wikilinks/index.js\":\"be2f460642e1be06\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7d0de79f006db0bd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1a219480a5cc7205\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/mergeRetargetProcessor.js\":\"3533b21785243f2b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/parseFence.js\":\"ba49a4831ce44051\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/referenceParser.js\":\"13f92b3539e3b25b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/referenceProjection.js\":\"e6da6dc895128561\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/referencesProcessor.js\":\"4c0e7844b612d64a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/renameProcessor.js\":\"6e053eae01ec437a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/spanReplacement.js\":\"eec20d753aea4841\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/rich-paste/htmlToOutline.js\":\"17107b248e37ec65\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/rich-paste/index.js\":\"4c2c774327c8b621\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e598050d145e062f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/rich-paste/pasteDecision.js\":\"532c9144214ece4b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/action.js\":\"01a663f45b5565c5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/blockIds.js\":\"2abbfbbb5ecbef2f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/content.js\":\"cee474b3ee8199b4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/effect.js\":\"4d2c4ce1029bc6ff\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/ids.js\":\"11b7451c60775d0c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/import.js\":\"03e581079f9677c8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/index.js\":\"ee10ea20a95d6c34\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/plan.js\":\"19a13299b48ec5e7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/plugin.js\":\"5321d04b264d6bb2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/promotion.js\":\"9f7731b7e4c58e60\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/properties.js\":\"2cb941511e8b1aa3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/references.js\":\"ca7ccdc4058d5f37\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/report.js\":\"a39dc1406c8427f6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/roamMemo.js\":\"60c928e6fdc60a36\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/runtime.js\":\"67a5e0c5472c4180\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/schemaReconciliation.js\":\"74ec52fa1351e687\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/srsMarkers.js\":\"46cc038a05c71e1a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/todo.js\":\"8b3e3c502e377147\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/typeCandidates.js\":\"4c43c54682f33a16\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/types.js\":\"aab8a9f0c33fc8e2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/search-health/index.js\":\"e1ad89fe93640af0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/search-health/store.js\":\"ab2f078d0d217377\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/shortcut-help/HeaderItem.js\":\"adfc87fe16da7e18\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"738498d7793da6e4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/shortcut-help/index.js\":\"ce27b7c572050194\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/shortcut-help/model.js\":\"c5d1ecbd0351b469\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/shortcut-help/toggleStore.js\":\"0aede3d5a8e61346\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/shortcut-help/useKeyInspector.js\":\"2cd589e46c5495ea\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"927eae6d081f589d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/ShellDecorator.js\":\"3e3ec55ce941e4a1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/actions.js\":\"3803ccc0ae6514f7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/exclusionsFacet.js\":\"fb73cb1831b2ed3b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/index.js\":\"851269f25450981f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/shell.js\":\"e28b3a2f9a981b51\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/surface.js\":\"06838d98ef4cfa49\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/walker.js\":\"1e0ed97e96e05c6e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ae61edb94466a654\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/dataExtension.js\":\"6f4e83707e46e544\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/index.js\":\"6d4121f234bd4dce\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/indicator.js\":\"5285923e8a87f5e3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/moveSrsState.js\":\"3488fd635f12d17e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"5b3481dfe18c97bb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/scheduler.js\":\"50ed294419d23602\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/schema.js\":\"e1032f3a6c7a3c79\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"0720e616db40cd3f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/srsClipboard.js\":\"2d7c413693eb0a90\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e98ee625e953ea99\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/DailyNoteReviewHint.js\":\"5a0cbf223dd44a62\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/DeckPicker.js\":\"4e1a6b1b252c0547\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/ReviewControls.js\":\"3e5a0948d4051d13\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/ReviewDeckRenderer.js\":\"411bf50871e8229a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/ReviewSession.js\":\"2b277606ca4cbdb2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/actions.js\":\"8c4cb18d7d0e6f11\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/archive.js\":\"3caff3c36ef6e39e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/dataExtension.js\":\"224d1d837b91c002\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/deck.js\":\"75cdd91a496b22bc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/dueQuery.js\":\"2829091adfee2de6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/gradeDecision.js\":\"5e42790ad051059c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/index.js\":\"a166568ea1c61cb6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/keyHints.js\":\"7625de0e36ab88a3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/reviewCardLayout.js\":\"6976c4607d15af64\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/reviewProgress.js\":\"82079a2b1e946ab1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/schema.js\":\"5093881b440e52f1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/useDueCards.js\":\"17f72a138558bd60\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/startup-metrics/index.js\":\"6fb692b2fbd92d86\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/startup-metrics/record.js\":\"aad8b0ce046f8d6b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/storage-persistence/index.js\":\"23e93d095e1821d2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/storage-persistence/persistenceStatus.js\":\"f372e0cef0a8c462\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/storage-persistence/requestAction.js\":\"c3172ea7cb15b350\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/supertags/TypeChipsDecorator.js\":\"624c4877242a564f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/supertags/codeMirrorExtensions.js\":\"d726f356c38fd414\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/supertags/index.js\":\"21e81f93c51060a9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/supertags/typeAutocomplete.js\":\"c66f78bca13ea6d1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"f06982a021a094ec\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/actions.js\":\"b2016b5a5597236c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/anchor.js\":\"9a8615fdbec35412\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/events.js\":\"b25cc58a8f76be46\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/gestureActions.js\":\"332ea52c1d861afb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/index.js\":\"13cc6d17aa0cf274\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"603537c0dceb62ab\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/sync-metrics/collect.js\":\"7d43b4a1f2b5d423\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/sync-metrics/index.js\":\"2d5b6854a6feafe3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/sync-metrics/record.js\":\"a3319389a822cc7e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/RejectionDialog.js\":\"31e59c1637510be8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/SystemStatusHeaderItem.js\":\"63ee9aba67908bbe\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/index.js\":\"349635edd61eccaa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/model.js\":\"a1fd8e10404af36f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/queueCounts.js\":\"c00de7dd3ea8f134\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/rejectedHelpers.js\":\"2bbfa03ff8fcc863\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/rematerializeAction.js\":\"3ee5b5de44012206\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/useHysteresis.js\":\"3070e62347826547\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/ColumnHeaders.js\":\"b7e23737ad64bd49\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/QueryUi.js\":\"7b943fa42910fefb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/TableLayout.js\":\"b28104295aa6d2a6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/actions.js\":\"d273dc88dddcaad3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/cellEdits.js\":\"ea9abedbbfdd9800\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/childrenViews.js\":\"1ba9e4c63b8f2b14\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/columns.js\":\"e0177db5f5319021\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/controller.js\":\"47fd294a79b2f9f4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/convert.js\":\"6676f8cdcb4e480f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/dataExtension.js\":\"0f4e8e470b905a3e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/index.js\":\"7c55b375f06e05fc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/keys.js\":\"31bcaa276043ce65\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/model.js\":\"bac551e94938c112\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/query/backfill.js\":\"3fa3bfc2ac239d98\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/query/completion.js\":\"d495de65e20a25a6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/query/format.js\":\"69eabada32568506\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/query/parse.js\":\"ed2e47ed8f5ab59a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/query/queryValue.js\":\"14b83223d08b79fb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/query/source.js\":\"0036ac95448beced\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/registry.js\":\"996fb899365d8117\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/rowGutter.js\":\"db47f8aaa8c0976a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/rowVerbs.js\":\"37157aa8ab567cf3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/schema.js\":\"12fa2d64c6ca3053\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/sort.js\":\"0a82bdd1d9d250b5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/theme-toggle/effect.js\":\"0ec5b5374b5ec81b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/theme-toggle/index.js\":\"2afcf46f568ebd60\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/theme-toggle/theme.js\":\"82e1e0e64a626045\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/todo/actions.js\":\"0a419941aae9b2c1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/todo/dataExtension.js\":\"441cb50679dfa2ba\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/todo/index.js\":\"ed59a172d9a5c6a7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/todo/schema.js\":\"d56d702c868011e5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a9360c37a3865bd7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/touch-selection/actions.js\":\"b5f973bcb1a1933a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/touch-selection/defaultItems.js\":\"3486b00f1e187a5f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/touch-selection/facet.js\":\"37187c5ef9d5723f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/touch-selection/holdRecognizer.js\":\"5df362e00836ff69\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/touch-selection/index.js\":\"95ea9b3d820c4d1d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/update-indicator/UpdateIndicator.js\":\"5e81416a9f51ec7b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/update-indicator/index.js\":\"e30fe82ad3c3010d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/update-indicator/loadTimes.js\":\"6c0d1125135e0bfd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/VideoNotesRenderer.js\":\"eb01c55bf8d607a6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/VideoPlayerRenderer.js\":\"7bafa3892721cc76\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/VideoTimeStamp.js\":\"c8970fccc764f71a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/actions.js\":\"507f2d2d1f7d5212\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/index.js\":\"6305f51f389fa7c8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/markdown.js\":\"2f76629b64dce8c3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/notes.js\":\"2c4e7f68350194e0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/registry.js\":\"65315a20639eaa09\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/remark-timestamps.js\":\"7cfbd843b0dc8d95\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/view.js\":\"ed61d5e9a015f90b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-link-hints/LinkHints.js\":\"1bf2075de08e8e13\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-link-hints/index.js\":\"51fe82c9412c9dbe\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-link-hints/model.js\":\"7928b17b5832a799\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-link-hints/settings.js\":\"c83668d608d4b8be\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-normal-mode/actions.js\":\"be05591e597da433\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-normal-mode/index.js\":\"68c816d926c8d552\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-normal-mode/interactions.js\":\"7c449ef996b34593\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/workspace-header/index.js\":\"54edf1959ea4af19\",\"/knowledge-medium/pr-preview/pr-1881/src/registerServiceWorker.js\":\"9db225881cd23057\",\"/knowledge-medium/pr-preview/pr-1881/src/requestPersistentStorage.js\":\"59ca917280e789a3\",\"/knowledge-medium/pr-preview/pr-1881/src/services/authRequestDeadline.js\":\"f2ceae0c2b06fa3f\",\"/knowledge-medium/pr-preview/pr-1881/src/services/authStorage.js\":\"4196d7847df611d9\",\"/knowledge-medium/pr-preview/pr-1881/src/services/powersync.js\":\"42f432e643dd3db5\",\"/knowledge-medium/pr-preview/pr-1881/src/services/supabase.js\":\"97ac446dab183549\",\"/knowledge-medium/pr-preview/pr-1881/src/services/uploadErrorClassifier.js\":\"66acdbeb0c572b47\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/ActiveContexts.js\":\"0d8262c4e6a18f24\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/HotkeyReconciler.js\":\"2569d0f926503300\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/WipeLocalDataDialog.js\":\"3bc4564f65e46f67\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/actionDispatch.js\":\"916612a6d3aee7b7\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/actionRefItems.js\":\"76d5816f9c95f58f\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/applyKeybindingOverrides.js\":\"425f80159c3fabe4\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/blockActions.js\":\"452ab400695f5528\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/blockMergeGesture.js\":\"f7f8fd5bb9a2936c\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/canonicalizeChord.js\":\"20d4ac11ae570cc4\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/defaultContexts.js\":\"e3e27ca9dbb3b8f8\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/defaultShortcuts.js\":\"eb59d2258212a0d7\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/effectiveActions.js\":\"2005191ac2e2ef69\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/gestureAction.js\":\"1018eb6d09fa6a58\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/gestureBinding.js\":\"357616f6a0504e31\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/holdRegistry.js\":\"b9342f4c6d51d8f4\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/keybindingConflicts.js\":\"646d8673ff42bc27\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/keybindingOverrides.js\":\"be216d1fb1ab637a\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/pointerAction.js\":\"354e2c16f32eb614\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/resolve.js\":\"228dbe6580eccf46\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/runAction.js\":\"1201e9a53d7a6677\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/sequenceMatcher.js\":\"d3cfd65e378c0b76\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/types.js\":\"2266c3af66f1c8c4\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/useActionContext.js\":\"5a7444214df5c3d5\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/useActionDiscovery.js\":\"f624cb5c7c189108\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/utils.js\":\"e853a2791f85a4d3\",\"/knowledge-medium/pr-preview/pr-1881/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1881/src/sw/bootStore.js\":\"89d9b177cf3c93a2\",\"/knowledge-medium/pr-preview/pr-1881/src/sw/previewDatabases.js\":\"00e4576ae039d56c\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/byteTransform.js\":\"bd51a08facb088ff\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/attachmentCleaner.js\":\"962d0fd34f7cb953\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/bundle/attachmentParts.js\":\"a1062ad32192e941\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/bundle/bundleParts.js\":\"2d98bbd817262c86\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/bundle/bundleRecord.js\":\"62192beb5598b9bb\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/bundle/manifest.js\":\"b9bb762d3b2b1fe0\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/bundle/takeBundle.js\":\"2c3f5d33d3aa4555\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/bundle/verifyBundle.js\":\"284f07d033924223\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/cleaningStage.js\":\"7fa213c23a55157f\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/conversionKey.js\":\"451a35aaa90f3e5a\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/conversionServer.js\":\"67b926b0a9cf34c6\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/flip.js\":\"a83af808b68c39c8\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/flipAttempts.js\":\"e353f1408d9b01f9\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/pages.js\":\"786b9e90df2c598d\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/preflight.js\":\"221a4ed819e66062\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/reseal.js\":\"ab359d2b0654fa16\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/runConversion.js\":\"8787141a495ca587\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/runLock.js\":\"c8aae63b7a968718\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/sealing.js\":\"0424630b8b8bcaf8\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/sealingStage.js\":\"98dd80ca5b210442\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/stage.js\":\"9e0da83b21a1383f\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/verifyReseal.js\":\"5d3ed969816119d7\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/aad.js\":\"46d4897705574b89\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/aead.js\":\"f8fb510bfb1a4e5a\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/base32.js\":\"1a2a883a7a8d478b\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/base64url.js\":\"ae56498a30fd032a\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/binaryEnvelope.js\":\"524f6902d300ad3a\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/byteAead.js\":\"c7d5ea6604727838\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/canary.js\":\"8b624847cc6355f8\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/contentHash.js\":\"65e82dd850ead77d\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/contentKey.js\":\"fc1b1f2f81ecb889\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/derivedIdNamespace.js\":\"96488b4896a8856a\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/envelope.js\":\"d50ebb12cb3753d2\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/hex.js\":\"225789524f9192fc\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/sha256Hex.js\":\"5e9e7c5fb70e2a07\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/workspaceKey.js\":\"bdf545c1b4d212bc\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/conversionState.js\":\"1e04fc40df8a3ad0\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/flows/createEncryptedWorkspace.js\":\"afdc3ff8aedd4b66\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/flows/pastedKey.js\":\"3f78d0785b653745\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c1294e40095da6de\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/flows/upgradeWorkspacePin.js\":\"4343edcce0ed37b1\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/keyStore.js\":\"ede7e8a85e0245f6\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/mintWorkspaceKey.js\":\"2fa47a229dfddaed\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/modePin.js\":\"110948b302a24c6f\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/openWorkspaceKeys.js\":\"fcad17fcf37827fa\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/resolveWorkspaceEntry.js\":\"f6c216198eb70e73\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/resolver.js\":\"05c90c3585988bd8\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/workspaceAccess.js\":\"3421fdf9ef67673d\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/transform.js\":\"e93880623ee95993\",\"/knowledge-medium/pr-preview/pr-1881/src/themeBootDefaults.js\":\"951a86be2b5048cb\",\"/knowledge-medium/pr-preview/pr-1881/src/types.js\":\"7ea09a122f76e5f2\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/ClientLocalSettings.js\":\"e440dc6abc51c3bb\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/abortableSleep.js\":\"ccf86e5c699a80c5\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/array.js\":\"5ba4160dc3edf388\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/backlinkAutocomplete.js\":\"d18cf6e4a4d9ec10\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/blockCrumbs.js\":\"f3395a270a5783f6\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/blockrefAutocomplete.js\":\"fe27a0024ee75516\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/cadencedIdleJob.js\":\"4e3a4db11236db42\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/callbackSet.js\":\"8468824453885807\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/clientId.js\":\"ccf091b7d17a731b\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/codemirror.js\":\"300630e1b629c670\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/codemirrorCompletion.js\":\"e60abcd5e13f7eb3\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/copy.js\":\"3ee619529db7fbaa\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/dailyPage.js\":\"6b7e7beb561d442f\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/dbForensics.js\":\"3d8d8903ff7982c5\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/dbForensicsHooks.js\":\"c8995eed459d93ee\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/deleteBlockThroughUi.js\":\"ee1bfe75bbc71c99\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/dialogs.js\":\"77ff36d5580b10c7\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/dom.js\":\"1d12095d5cb4cfc9\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/downloadBlob.js\":\"6be6b316bf7e3a71\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/drawnWalk.js\":\"06e2c75b0693467c\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/exportSqliteDb.js\":\"346d6f3ce94e4442\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/fileSystemAccess.js\":\"12a6d5d7b2f54014\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/flipSlide.js\":\"87059c9cd24056ee\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/fnv1a.js\":\"95dd1a68f53cd01b\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/formatBytes.js\":\"f1d69f5797bf6e7b\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/fuzzyRank.js\":\"9fac78bc54de08db\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/idbKeyedStore.js\":\"3d7009b1eff01a40\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/idleCallbackPolyfill.js\":\"947107159d0f395b\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/keyboardAwareScroll.js\":\"fd294a198151d925\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/keyboardViewport.js\":\"1b8459d2588cdf9a\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/lastWorkspace.js\":\"818c24c5cb5b1317\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/layoutColumns.js\":\"24a4dbc6fc18c5ff\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/layoutSessionDom.js\":\"27af871997f8c9b8\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/layoutSessionId.js\":\"8a09cd5ce1387cc7\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/linkClickGestures.js\":\"17bc0f9c87f253e0\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/linkTargetAutocomplete.js\":\"b2a7eb33087c7120\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/localDbCorruption.js\":\"ece3bf1eb0464634\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/localDbRecovery.js\":\"614a20eedbfb7f70\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/markdownParser.js\":\"2d1a4ecb0726714a\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/memoize.js\":\"2df2c40b6ce79936\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/nameFieldCommit.js\":\"32f475e0267bd874\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/nameList.js\":\"6aa23d43968f627d\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/navigation.js\":\"d1e31d27e03a5947\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/omnilinerNamespace.js\":\"8b246197dfa75bac\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/opfsPageScan.js\":\"8c44eadaa34de7cc\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/panelClearance.js\":\"7a31b26f7eb51681\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/panelHistory.js\":\"96143c3427b50d55\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/panelLanes.js\":\"7b30f40a43ad9615\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/panelLayoutProjection.js\":\"e678ed23fb814bd3\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/panelScrollAnchor.js\":\"b4484e21408afa68\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/panelUrlFlags.js\":\"789c8f5773c0e255\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/platform.js\":\"16fa1bf7d1c58554\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/pluralize.js\":\"3f2a58e8001f8dc4\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/propertyCreation.js\":\"246a7c9ad8328557\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/propertyNavigation.js\":\"a7e8a9bb456607c6\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/propertyValueContext.js\":\"ff840212bb5b3494\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/react.js\":\"6918c1d497154aa7\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/relativeDate.js\":\"f8a2db58f6a9da43\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/relativeTime.js\":\"6e925b1862aa9caf\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/renderScope.js\":\"3f21f96c5df37b8c\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/resolvedThenable.js\":\"aa45350a344d14fc\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/routing.js\":\"cedee98de62f8719\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/safeMode.js\":\"31f4d84a08dac1c8\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/scheduleIdle.js\":\"d4377710fc50c67c\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/screenWakeLock.js\":\"59a5084b4bbd38de\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/selection.js\":\"728ce897e4790c93\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/softKeyboardGrab.js\":\"9b08f1befd63ca01\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/startupTimeline.js\":\"d7a7f3910e2427a3\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/state.js\":\"d1a9567718e3bbde\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/string.js\":\"668bf1c9f4cae78d\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/surfaceZoom.js\":\"b4f860b1ebc12c39\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/time.js\":\"8af5bd439137699d\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/toast.js\":\"b4c4501c7475d43e\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/toggleStore.js\":\"fed6c4bfd17f64f0\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/untilStopped.js\":\"faeaf217686b1cef\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/userActivity.js\":\"59af6c1c1269b41e\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/viewTransition.js\":\"6e9aa09cb02071dd\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/viewport.js\":\"62d5b0e5bdf5704f\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/webLock.js\":\"76994507128c2964\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/workspaceRecovery.js\":\"33950c11cdc45bfd\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/workspaceSnapshotStore.js\":\"7e5dd8e5f0e2570a\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-compiler-runtime.js\":\"c7ee856a854eb243\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom-client.js\":\"b35aacebf48e526e\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom-server-edge.js\":\"2d823962016e112b\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom-server.js\":\"8e500b0f7f0fc9ca\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom-static-edge.js\":\"4d5e13d1659918a4\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom-static.js\":\"435064a9b50ab5ac\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom-test-utils.js\":\"f51ee938cf4080f0\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom.js\":\"e3bb76f0afe23626\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-jsx-runtime.js\":\"8753efef9f2b4d74\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react.js\":\"c3c4a97f84c18dc5\",\"/knowledge-medium/pr-preview/pr-1881/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1881/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1881/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
