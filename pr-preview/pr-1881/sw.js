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
		buildId: "f7864f5b55f7-f3e48506",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1881/\":\"e6d3fb0f4fadd941\",\"/knowledge-medium/pr-preview/pr-1881/index.html\":\"e6d3fb0f4fadd941\",\"/knowledge-medium/pr-preview/pr-1881/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1881/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1881/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1881/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1881/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1881/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1881/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/pr-preview/pr-1881/assets/FacadeVFS-DUmV9087.js\":\"b01be0c8bed41950\",\"/knowledge-medium/pr-preview/pr-1881/assets/OPFSCoopSyncVFS-CESeaoiK.js\":\"28bc6984d0e7eb28\",\"/knowledge-medium/pr-preview/pr-1881/assets/OPFSWriteAheadVFS-CwCZvF7K.js\":\"2270c42c7d993676\",\"/knowledge-medium/pr-preview/pr-1881/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1881/assets/wa-sqlite-R32BpnJ3.js\":\"341a4a9a1cdf2fd8\",\"/knowledge-medium/pr-preview/pr-1881/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1881/assets/wa-sqlite-async-BbeZW2w8.js\":\"9d1ec965d2e3b558\",\"/knowledge-medium/pr-preview/pr-1881/assets/worker-DR-dNokh.js\":\"d132e953348d318e\",\"/knowledge-medium/pr-preview/pr-1881/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1881/chunks/app-D_QVbLAF.js\":\"4d67c2552e9444a9\",\"/knowledge-medium/pr-preview/pr-1881/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1881/index.js\":\"7e53a1ff60cf775a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1881/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1881/assets/AccessHandlePoolVFS-l2UfaOd6.js\":\"9ea00b672fe46a6f\",\"/knowledge-medium/pr-preview/pr-1881/assets/IDBBatchAtomicVFS-BFic9fDE.js\":\"0aa595b79a7832ed\",\"/knowledge-medium/pr-preview/pr-1881/assets/MemoryVFS-BTmwJbsq.js\":\"678f0f91b2700001\",\"/knowledge-medium/pr-preview/pr-1881/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1881/assets/mc-wa-sqlite-UVh30V2a.js\":\"f806b1354269ca05\",\"/knowledge-medium/pr-preview/pr-1881/assets/mc-wa-sqlite-async-Iy6ggeCZ.js\":\"b98ff85961586b60\",\"/knowledge-medium/pr-preview/pr-1881/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1881/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1881/chunks/AccessHandlePoolVFS-BV5HgRdC.js\":\"de07856bc9e7ff63\",\"/knowledge-medium/pr-preview/pr-1881/chunks/FacadeVFS-Btcukh51.js\":\"36326e0048ee6da3\",\"/knowledge-medium/pr-preview/pr-1881/chunks/IDBBatchAtomicVFS-D0aP6aw3.js\":\"3c4becbbba1bc815\",\"/knowledge-medium/pr-preview/pr-1881/chunks/MemoryVFS-GAenJTem.js\":\"a69a8c9273c6b6b5\",\"/knowledge-medium/pr-preview/pr-1881/chunks/OPFSCoopSyncVFS-BWVQY86n.js\":\"6e8cc8fa3bfe3fbb\",\"/knowledge-medium/pr-preview/pr-1881/chunks/OPFSWriteAheadVFS-Dje0IF2a.js\":\"960cace659af3969\",\"/knowledge-medium/pr-preview/pr-1881/chunks/Preview-CRYynsRd.js\":\"3edcb0036e79ec78\",\"/knowledge-medium/pr-preview/pr-1881/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1881/chunks/card-BrQKPbHD.js\":\"127157426ddae566\",\"/knowledge-medium/pr-preview/pr-1881/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1881/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1881/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1881/chunks/dist-FiEe0nS7.js\":\"4f22773ece4088cc\",\"/knowledge-medium/pr-preview/pr-1881/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1881/chunks/mc-wa-sqlite-CeRUnuDR.js\":\"4f1123368a532b25\",\"/knowledge-medium/pr-preview/pr-1881/chunks/mc-wa-sqlite-async-wGVinLDA.js\":\"7c3e44c5496336b2\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-0PO_6HKV.js\":\"a4b968ed26699c2e\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-B6J5127P.js\":\"b27e5fa516122777\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-BJkHYG9E.js\":\"2bb354fdaa6cfdf9\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-BOzub2fP.js\":\"2a06e64fbe0ab2aa\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-BStpdS8Q.js\":\"01668bbe6bf6273c\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-CDzTn3qx.js\":\"edc7b4ce2adb41f5\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-CNUeusl0.js\":\"7d4c4fb57c588ae2\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-DPXQUzU_.js\":\"6036cb7d0b61354b\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-dom-server-legacy.browser.production-BT-elV41.js\":\"cc45d25c809a5574\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-dom-server.browser.production-BaIJ9U8Z.js\":\"2925aa91c7e37286\",\"/knowledge-medium/pr-preview/pr-1881/chunks/react-dom-server.edge.production-6pdOjBGx.js\":\"512b8a1b3127dbdf\",\"/knowledge-medium/pr-preview/pr-1881/chunks/server.browser-WgjOf_WY.js\":\"744338048e656b1a\",\"/knowledge-medium/pr-preview/pr-1881/chunks/textarea-Bx9WvdV4.js\":\"8cb62174b262ba26\",\"/knowledge-medium/pr-preview/pr-1881/chunks/ui-B3Kx-_Ma.js\":\"93983bd7a0c28ce2\",\"/knowledge-medium/pr-preview/pr-1881/chunks/wa-sqlite-OoRvvvBY.js\":\"a0f2f25b86c81e6a\",\"/knowledge-medium/pr-preview/pr-1881/chunks/wa-sqlite-async-BbIeyChr.js\":\"992aff3f77616bfa\",\"/knowledge-medium/pr-preview/pr-1881/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1881/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1881/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1881/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1881/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1881/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1881/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1881/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1881/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1881/src/App.js\":\"52dbb605df2346f1\",\"/knowledge-medium/pr-preview/pr-1881/src/appUpdate.js\":\"e636dd52fa246e12\",\"/knowledge-medium/pr-preview/pr-1881/src/appVersion.js\":\"a470fde4f0c97d51\",\"/knowledge-medium/pr-preview/pr-1881/src/bootstrap/initialLayout.js\":\"5b69aaca19203b5c\",\"/knowledge-medium/pr-preview/pr-1881/src/bootstrap/openWorkspaceData.js\":\"c98fa7cb29cb27f7\",\"/knowledge-medium/pr-preview/pr-1881/src/bootstrap/resolveWorkspace.js\":\"21d9d8c3812cbab1\",\"/knowledge-medium/pr-preview/pr-1881/src/bootstrap/workspaceBootstrap.js\":\"de8e0d6c2aaa8e2d\",\"/knowledge-medium/pr-preview/pr-1881/src/components/BlockComponent.js\":\"a98be8667791bf13\",\"/knowledge-medium/pr-preview/pr-1881/src/components/BlockCrumbs.js\":\"f8e49fa2baa0742d\",\"/knowledge-medium/pr-preview/pr-1881/src/components/BlockEditor.js\":\"587235d785b78cdb\",\"/knowledge-medium/pr-preview/pr-1881/src/components/BlockLoadingPlaceholder.js\":\"7c21ec8b58a55b77\",\"/knowledge-medium/pr-preview/pr-1881/src/components/BlockProperties.js\":\"2f0cb50b683b1b3e\",\"/knowledge-medium/pr-preview/pr-1881/src/components/BlockSearchPicker.js\":\"4587212ee5bfff73\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ConfirmBulkDeleteDialog.js\":\"64d1a2c7970b13ca\",\"/knowledge-medium/pr-preview/pr-1881/src/components/DividerHandle.js\":\"e3c2e9959a1b9406\",\"/knowledge-medium/pr-preview/pr-1881/src/components/DraftEditor.js\":\"db22cc4a9b5954b9\",\"/knowledge-medium/pr-preview/pr-1881/src/components/GutterPill.js\":\"1526b92fdaddaa98\",\"/knowledge-medium/pr-preview/pr-1881/src/components/Header.js\":\"b1d598935d51a695\",\"/knowledge-medium/pr-preview/pr-1881/src/components/LazyBlockComponent.js\":\"706dbecd53eb72aa\",\"/knowledge-medium/pr-preview/pr-1881/src/components/Login.js\":\"7e7d15b87abc5d55\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ZoomableSurface.js\":\"4abfc5eaa8bf1018\",\"/knowledge-medium/pr-preview/pr-1881/src/components/editModeKeepalive.js\":\"d083a0c79f17f638\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b8d48fd17229e063\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0c3a117adbc2c445\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/RefPropertyEditor.js\":\"1bdc55f94fd0ed92\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/RefTargetTypePicker.js\":\"a2afeb7166eba403\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/SelectPropertyEditor.js\":\"add7058b6b8c438d\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/TypesPropertyEditor.js\":\"b68fe0684130a80e\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/defaults.js\":\"b8edcc61cd85b521\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/kernelValuePresets.js\":\"ba632d22687aa66d\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/selectablePresets.js\":\"d33e8b392664a32e\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyEditors/typesPropertyUi.js\":\"c9650d5ec97e7eb4\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/AddPropertyForm.js\":\"5b7cfcdd5b88f7da\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/PropertyPicker.js\":\"5304e64910745996\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/PropertyRow.js\":\"311fb6b41bd66e4c\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/Rows.js\":\"89986398625de23f\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/actions.js\":\"811a8f955cfb0265\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/declarationOnly.js\":\"eaf4bae11c210ffd\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/layout.js\":\"8e6e414525875df6\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/model.js\":\"442726ef6f3c79db\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/shapeUi.js\":\"7f6e7c5d1a4351d7\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/shapes.js\":\"1b350e01ac22319d\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c313e8332ae6b3a7\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanel/visibility.js\":\"8937644a7248dd9b\",\"/knowledge-medium/pr-preview/pr-1881/src/components/propertyPanelSections.js\":\"0aafd79bf3af8f9f\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/BlockEmbed.js\":\"1f86d8bc349b4db9\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/BlockLink.js\":\"ce5bc697541a9668\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/BlockRef.js\":\"61f17d68bff4ac71\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/ReferenceLink.js\":\"7f5761c6efb2a01e\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/cycleGuard.js\":\"798c7831f6d2f851\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/cycleGuardContext.js\":\"6f22d7eb4b8fd9fb\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/linkInteraction.js\":\"9624c78bc2cf4202\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/referenceLayout.js\":\"0a2027f6801e72b3\",\"/knowledge-medium/pr-preview/pr-1881/src/components/references/useBlockRefAncestors.js\":\"b9d28e7ab28dac5c\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/BlockGutter.js\":\"997270fe0853bcff\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/BlockInfoDialog.js\":\"353276b76b3b61f1\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/BlockTypeBlockRenderer.js\":\"7b26d01779be4443\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/BulletHoverCard.js\":\"86bb20fe35057643\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/CodeMirrorContentRenderer.js\":\"cb771d84e18a8f69\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"50f81b0e76d2f042\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/ColumnResizeHandles.js\":\"83331fe6f3cf9e4f\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"eac1f45f01e59f8b\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/DefaultBlockRenderer.js\":\"4108ace1c55835aa\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/LayoutRenderer.js\":\"b9a1667edfa378f3\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/MarkdownContentRenderer.js\":\"f1927d1d6d19e043\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/MissingDataRenderer.js\":\"4ac95c8067cfc61c\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/PanelRenderer.js\":\"5e31b7e5e63bb0c7\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e463a73a34f2e077\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/TopLevelRenderer.js\":\"c95cddfa7db1fd7c\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/blockGutterMode.js\":\"04e6253402479f80\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/blockTitleText.js\":\"266494832bcd0f31\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/fieldCreationKeydown.js\":\"172186b052a756b4\",\"/knowledge-medium/pr-preview/pr-1881/src/components/renderer/layoutRootContext.js\":\"b85dabc9be948849\",\"/knowledge-medium/pr-preview/pr-1881/src/components/typeChip/TypeChip.js\":\"4a982596744b6396\",\"/knowledge-medium/pr-preview/pr-1881/src/components/typeChip/chipStyle.js\":\"6c9ccca0bd92e285\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/anchored-floating.js\":\"89dd17da58470980\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/button.js\":\"05982046e56c0f8c\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/card.js\":\"b2e85143feb007bf\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/checkbox.js\":\"a6a92d9bb78085f1\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/collapsible.js\":\"33c0fce7817baa0d\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/command.js\":\"1f4d0d143092e374\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/context-menu.js\":\"d8b7efda6546214d\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/dialog.js\":\"084b9d13bb9e0bdb\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/dropdown-menu.js\":\"3f7b2c76bf700165\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/floating-listbox.js\":\"aaff333f632bcb29\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/index.js\":\"3289f0dab51c69cd\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/input.js\":\"5b82037d5a7b8a82\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/kbd.js\":\"34e10fbe9973ecdb\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/label.js\":\"06699b70a922aa89\",\"/knowledge-medium/pr-preview/pr-1881/src/components/ui/textarea.js\":\"5e7b11903b59aeeb\",\"/knowledge-medium/pr-preview/pr-1881/src/components/useEditModeYieldKeepalive.js\":\"70cd7b554a7c5ba2\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/BootFallback.js\":\"d1b0b55286ce2ac0\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/FocusedRowLazyMount.js\":\"ff46ce47486a730b\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/LazyViewportMount.js\":\"edc3c30d0a5566ec\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/LocalDbCorruptionFallback.js\":\"8604ecd46b0283f1\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/error.js\":\"78059609a970f8db\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/lazyMountRegistry.js\":\"f944fd4ab14b06c7\",\"/knowledge-medium/pr-preview/pr-1881/src/components/util/suspense.js\":\"1188061fb91174a8\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/CreateWorkspaceDialog.js\":\"3870e72dbb206aad\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/PendingInvitations.js\":\"769762c99a757938\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/SyncProgress.js\":\"19d1dd174ab48afd\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/UnlockProgress.js\":\"e34398e68aa9b844\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/WorkspaceKeyGate.js\":\"a0e8fa0b2f10a92c\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/WorkspaceSettingsDialog.js\":\"77e470d0651c7226\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/WorkspaceSwitcher.js\":\"6ee694ff67c287da\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/WorkspaceSyncGate.js\":\"e5adc96e2db7ebfb\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/ConversionFlow.js\":\"a68327a9f7392f19\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/ConversionFlowHost.js\":\"f2ba4078ad4d6170\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/EncryptionSection.js\":\"d2994c5ca9740578\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/attachmentPrompts.js\":\"2e338e5677377ade\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f0058a8419d8c5ad\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/conversionFlowDeps.js\":\"b5bc25e08e6cae94\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/conversionFlowStore.js\":\"1f54b7522b5aa517\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/flowUi.js\":\"b6954fd58bf8eaf2\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/conversion/useConversionRun.js\":\"b77d4686ae97370d\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/keyUi.js\":\"0bd52af8444f8405\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/useCloseOnKeyLoss.js\":\"98b8b36773750dea\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/useCloseOnServerE2ee.js\":\"b16ec5a385ba9233\",\"/knowledge-medium/pr-preview/pr-1881/src/components/workspace/workspaceUnlocked.js\":\"1ad01ae90cde1291\",\"/knowledge-medium/pr-preview/pr-1881/src/context/backgroundSubtree.js\":\"470a520f48569ea4\",\"/knowledge-medium/pr-preview/pr-1881/src/context/block.js\":\"3319f84829cb7a5a\",\"/knowledge-medium/pr-preview/pr-1881/src/context/layoutWsContext.js\":\"07b51c2de998ba81\",\"/knowledge-medium/pr-preview/pr-1881/src/context/propertyDisplay.js\":\"8075c1399b720e99\",\"/knowledge-medium/pr-preview/pr-1881/src/context/repo.js\":\"e8a733a46d469fee\",\"/knowledge-medium/pr-preview/pr-1881/src/data/aliasClaim.js\":\"e093cbe9bb7ba852\",\"/knowledge-medium/pr-preview/pr-1881/src/data/aliasSeatNamespace.js\":\"83e3872e34640cb0\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/blockData.js\":\"5203179f3d077063\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/blockType.js\":\"9452945f72ca79fa\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/changeScope.js\":\"4d8f792a82a4a3a3\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/codecs.js\":\"4eeea075b36bbca1\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/derivedData.js\":\"d2d1f90694d74597\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/errors.js\":\"1c9d896292b4817d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/events.js\":\"7c12225ffd730337\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/handle.js\":\"614b3ebf2694a6dd\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/index.js\":\"b503ac711fd74485\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/mutator.js\":\"073583bbfc2e39ef\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/processor.js\":\"76c62505a6b7a82b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/propertySchema.js\":\"f374c18d06ea4894\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/query.js\":\"34a785196d989920\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/sameTxProcessor.js\":\"26a79386a51f6d05\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/schema.js\":\"614b3ebf2694a6dd\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/tx.js\":\"614b3ebf2694a6dd\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/typedBlockQuery.js\":\"d3146cfc10af60d2\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/user.js\":\"6cd7711a9aac5f4e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/valuePresetCore.js\":\"36f4530626b6bdba\",\"/knowledge-medium/pr-preview/pr-1881/src/data/api/valuePresets.js\":\"4d983d91ffa4b0fa\",\"/knowledge-medium/pr-preview/pr-1881/src/data/attachmentCleanerIOVerb.js\":\"92e1853be4fc3279\",\"/knowledge-medium/pr-preview/pr-1881/src/data/block.js\":\"f44258c49262ed7e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockCache.js\":\"96cbe926fec98145\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockId.js\":\"f935d426452addca\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockLiveness.js\":\"a434b2801149bbe4\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockMerge.js\":\"e090bafe0936ca5d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockSchema.js\":\"9aa72947ec1f2a01\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockTypeLookup.js\":\"7ea2d92a20215e64\",\"/knowledge-medium/pr-preview/pr-1881/src/data/blockTypes.js\":\"710c7af8844a1be1\",\"/knowledge-medium/pr-preview/pr-1881/src/data/childrenView.js\":\"043cbbf3b7a5570e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/clientContext.js\":\"e4d8bfdda351b52d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/dbFileSiblings.js\":\"b2250252ab896f50\",\"/knowledge-medium/pr-preview/pr-1881/src/data/definitionSeeds.js\":\"dc5c7048ff5ca21f\",\"/knowledge-medium/pr-preview/pr-1881/src/data/derivedIds.js\":\"52f641dde29f8b46\",\"/knowledge-medium/pr-preview/pr-1881/src/data/drawnSubtree.js\":\"e07de176305f7366\",\"/knowledge-medium/pr-preview/pr-1881/src/data/facetBridge.js\":\"631af45fe96e38a0\",\"/knowledge-medium/pr-preview/pr-1881/src/data/facets.js\":\"d20fbd1bb161ceb7\",\"/knowledge-medium/pr-preview/pr-1881/src/data/globalState.js\":\"1de3b6788524ca79\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/aliasClaimRederiveProcessor.js\":\"45fba34023c77627\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/ancestorBatch.js\":\"5d935a27e90f09ea\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/blockTypeTypeifyProcessor.js\":\"7a4370937bad086f\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/clientSchema.js\":\"f88569d2f8c9155d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/commitPipeline.js\":\"619d0d6a9ef8bc91\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/devAssertions.js\":\"59cfc8aa4a5cc9db\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/firstSync.js\":\"99f7b022581c12c8\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/freshInitialLoad.js\":\"904095d6d8cd12a5\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/graphBackfillClaim.js\":\"83f28f014d9ef922\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/handleStore.js\":\"e29c261ff73c726d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/idleMarkerJobs.js\":\"c98f698452058ddd\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/initialDownload.js\":\"c9887de7b12f14dc\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/initializeClientDatabase.js\":\"49b29a98a1f2e00e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/jsonCanonical.js\":\"97ee5bd72879fa1c\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/kernelInvalidation.js\":\"5bd66f57ffe62d74\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/kernelProcessors.js\":\"91f1c87f01686838\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/kernelQueries.js\":\"78a976d91f6efde9\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/mergeTypeMembershipProcessor.js\":\"62597db9cf4c93aa\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/normalizeReferencesProcessor.js\":\"12ceec1833dc5e80\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/poolInstrumentation.js\":\"4579e271bf398f81\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/processorRunner.js\":\"72c0b53b6f855650\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyCellBackfill.js\":\"35941a2cdd5a4f1b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyChildMint.js\":\"2af44df5d0fc4b93\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyChildrenProcessor.js\":\"4fb52f57870409ff\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2eae31395a1fbd4e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyDefinitionSynthesis.js\":\"ac049c3f453b89a2\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyKeyScan.js\":\"f88f52b6671abd69\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertySchemaResolution.js\":\"269ecef67fb585f0\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/propertyValueEdits.js\":\"1ae75aa0f62f046f\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/raiseProtocol.js\":\"63a1293c0321829d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/readBatch.js\":\"5f8cd734448a9334\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/refProjection.js\":\"115420f8106e24c4\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/referenceTargetLookups.js\":\"987d01d9a1d57df8\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/referenceTargetProcessor.js\":\"120eef8d1d5f2db9\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/replayMerge.js\":\"a0adae9ac1d2cbd6\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/sqlBinds.js\":\"21941c3667730a44\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"3bd51b69d09f2e75\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/syncObserver/arrivalProcessors.js\":\"67d89e186bad7202\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/syncObserver/invalidate.js\":\"1f9a2d91acb8b5de\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/syncObserver/materialize.js\":\"e72e77c0041f538d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/syncObserver/observer.js\":\"cea357ccd5406e85\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/syncObserver/reconcile.js\":\"0e5d59d215065716\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/timingMetrics.js\":\"9f3c81ab385cd926\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/treeQueries.js\":\"a4d344c4045adedc\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/txEngine.js\":\"112e1946e5f808cd\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/txSnapshots.js\":\"20b0d3a0b8812d27\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/typedBlockQuery.js\":\"356e4a21bb8410a1\",\"/knowledge-medium/pr-preview/pr-1881/src/data/internals/undoManager.js\":\"00b66e79f756f92e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/invalidation.js\":\"2a0a508570cc86f0\",\"/knowledge-medium/pr-preview/pr-1881/src/data/kernelDataExtension.js\":\"2c08fcc6143adba3\",\"/knowledge-medium/pr-preview/pr-1881/src/data/kernelPage.js\":\"c98b07dea8a28b96\",\"/knowledge-medium/pr-preview/pr-1881/src/data/kernelValuePresetCores.js\":\"dd439985fca62aab\",\"/knowledge-medium/pr-preview/pr-1881/src/data/localDbCorruptionSignal.js\":\"6c41486d19679e12\",\"/knowledge-medium/pr-preview/pr-1881/src/data/localDbStorage.js\":\"b1c629aba535530a\",\"/knowledge-medium/pr-preview/pr-1881/src/data/localDbVfs.js\":\"9e164e24ac412004\",\"/knowledge-medium/pr-preview/pr-1881/src/data/localSchema.js\":\"06061813ba284aeb\",\"/knowledge-medium/pr-preview/pr-1881/src/data/maintenance.js\":\"bc5e4a1139a136e5\",\"/knowledge-medium/pr-preview/pr-1881/src/data/mergeProperties.js\":\"ab9181f81a63aad1\",\"/knowledge-medium/pr-preview/pr-1881/src/data/metricsConsoleHook.js\":\"6b205cefdca2601e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/migrationsPage.js\":\"13247bee90561702\",\"/knowledge-medium/pr-preview/pr-1881/src/data/mutators.js\":\"e9d84431db9c60c2\",\"/knowledge-medium/pr-preview/pr-1881/src/data/orderKey.js\":\"ce2202ea421e8d0e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/orderKeyPlacement.js\":\"12bd70001c1afea6\",\"/knowledge-medium/pr-preview/pr-1881/src/data/outlineSurface.js\":\"288d8e424ffc3832\",\"/knowledge-medium/pr-preview/pr-1881/src/data/pendingEditorContent.js\":\"fc6e6456ef189a29\",\"/knowledge-medium/pr-preview/pr-1881/src/data/pendingUploadsSql.js\":\"2843ba5497a60368\",\"/knowledge-medium/pr-preview/pr-1881/src/data/pluginStateExtensions.js\":\"9a0c1161282b6ff2\",\"/knowledge-medium/pr-preview/pr-1881/src/data/powerSyncLogger.js\":\"d4d6fba8f7e296cb\",\"/knowledge-medium/pr-preview/pr-1881/src/data/projectorRuntime.js\":\"efb5625c6a764c05\",\"/knowledge-medium/pr-preview/pr-1881/src/data/properties.js\":\"431db3ad1ec112aa\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertiesPage.js\":\"9c7c5fd422e8210a\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertyChildren.js\":\"e463e2db4f0f5a41\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertyDefinitionFanout.js\":\"f31aac9270d4cd7b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertyDefinitionMetadata.js\":\"f42018304726b899\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertyDefinitionRegistry.js\":\"defa94555b3cf3a9\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertyDisplayMode.js\":\"413d3f351ea4e46a\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertyRowCreation.js\":\"805ac7c68526be04\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertySchemaCreation.js\":\"08b836fd191adbe6\",\"/knowledge-medium/pr-preview/pr-1881/src/data/propertySeeds.js\":\"34b6a1eb97f7538b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/recentsPage.js\":\"5fd3a210238d1224\",\"/knowledge-medium/pr-preview/pr-1881/src/data/referenceBlock.js\":\"c3fd509ad124bcc6\",\"/knowledge-medium/pr-preview/pr-1881/src/data/rejectedUploads.js\":\"cd888d8bb78f1dee\",\"/knowledge-medium/pr-preview/pr-1881/src/data/releasePowerSyncConnection.js\":\"d994f950ac7f3717\",\"/knowledge-medium/pr-preview/pr-1881/src/data/repo.js\":\"a2da7d41ba0f8ec0\",\"/knowledge-medium/pr-preview/pr-1881/src/data/repoProvider.js\":\"122b923cbf0428c7\",\"/knowledge-medium/pr-preview/pr-1881/src/data/rowProperty.js\":\"082f3795b72f927c\",\"/knowledge-medium/pr-preview/pr-1881/src/data/searchFilter.js\":\"ce10d917089ad316\",\"/knowledge-medium/pr-preview/pr-1881/src/data/seedIdentityLedger.js\":\"0f373604cb6d9d1e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/stateBlocks.js\":\"3c6d2b503bdf23ea\",\"/knowledge-medium/pr-preview/pr-1881/src/data/structuralEditPolicy.js\":\"01e18582378d2403\",\"/knowledge-medium/pr-preview/pr-1881/src/data/structuralInsert.js\":\"99305dd4111e9571\",\"/knowledge-medium/pr-preview/pr-1881/src/data/subtreeDelete.js\":\"d19375866fec5449\",\"/knowledge-medium/pr-preview/pr-1881/src/data/syncStreamLock.js\":\"845e82dcd882c358\",\"/knowledge-medium/pr-preview/pr-1881/src/data/syncedTableSqlRecognizer.js\":\"2b3c0af3b2de393d\",\"/knowledge-medium/pr-preview/pr-1881/src/data/syncedTableWriteGuard.js\":\"f3f07b90ff67a52f\",\"/knowledge-medium/pr-preview/pr-1881/src/data/targets.js\":\"4f7534e271fa861e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeColors.js\":\"527bc7df488fbedb\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeDefinitionMetadata.js\":\"5879968e9bea9251\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeDefinitionRegistry.js\":\"fec86f0dd0a7c186\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeExtraction.js\":\"035b33ef1382bf4e\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeInitialValues.js\":\"42ef793968c20244\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typePropertyGroups.js\":\"b20e67d862bb2f0f\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeSeeds.js\":\"6ae9ca7bcbdffdda\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typeTagger.js\":\"1b33890631eb9498\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typedRecords.js\":\"f70ec90496d96fe2\",\"/knowledge-medium/pr-preview/pr-1881/src/data/typesPage.js\":\"271f1f22c40baf4b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/userPrefs.js\":\"14979a32dabe30cd\",\"/knowledge-medium/pr-preview/pr-1881/src/data/userSchemasService.js\":\"b876c8008c94752f\",\"/knowledge-medium/pr-preview/pr-1881/src/data/userTypesService.js\":\"91d8c74f12d991f4\",\"/knowledge-medium/pr-preview/pr-1881/src/data/valuePresetRegistry.js\":\"dce56d313664915b\",\"/knowledge-medium/pr-preview/pr-1881/src/data/visibleChildren.js\":\"1b807510d4b50913\",\"/knowledge-medium/pr-preview/pr-1881/src/data/workspaceConversion.js\":\"2a561a03ec8a4d56\",\"/knowledge-medium/pr-preview/pr-1881/src/data/workspaceFirstSync.js\":\"53e7bfd0f1576fc7\",\"/knowledge-medium/pr-preview/pr-1881/src/data/workspaceIdNamespace.js\":\"c9248e1ac542ef39\",\"/knowledge-medium/pr-preview/pr-1881/src/data/workspaceSchema.js\":\"5d0094955d779ee5\",\"/knowledge-medium/pr-preview/pr-1881/src/data/workspaces.js\":\"491b95b2dbcfa7b6\",\"/knowledge-medium/pr-preview/pr-1881/src/data/writeAheadLog.js\":\"6fbd6b71c875e95c\",\"/knowledge-medium/pr-preview/pr-1881/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/BlockPasteShellDecorator.js\":\"ea2429cae33d3dad\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/atTrigger.js\":\"cc18851b9c2b0af6\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/autocomplete.js\":\"a3e4dbfa8fd2cac0\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/codeMirrorExtensions.js\":\"7c95668026bbecac\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/contentFlush.js\":\"2b060eb295360a7c\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/defaultInteractions.js\":\"3bf1816028251dc5\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/editSettleSignal.js\":\"9a6df4ad9d984818\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/insertImage.js\":\"6aca807f09baddb9\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/referenceCompletionRange.js\":\"d532c428f6126e2b\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/referenceTargetTypes.js\":\"ce49969c144179cc\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/syntaxContext.js\":\"bca457142bb7de33\",\"/knowledge-medium/pr-preview/pr-1881/src/editor/triggerMatch.js\":\"b32c23befe693c52\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/AppRuntimeProvider.js\":\"904e36403b21ad41\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/BlockFocusShellDecorator.js\":\"10e1fe3616b44ca0\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/ExtensionRenderBoundary.js\":\"d90bf0c970b14ba2\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/PanelContentRecovery.js\":\"6fe83f6bc639a072\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/apiCatalog.js\":\"bfd5b87577a1faa5\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/approveExtensionHere.js\":\"21eacf445d19f1f9\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/armedCutAppMount.js\":\"b689b3c68553bba7\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/batchableKeyedStore.js\":\"ecc171409dc2e86f\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/blockInteraction.js\":\"110cf02f86125379\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/blockSelectionAction.js\":\"89d7fe071e3ceb7a\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/compileExtensionModule.js\":\"4eb17b68a7780f40\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/compiledModuleCache.js\":\"57cb56a7a6f234ac\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/continuousGestures.js\":\"aa73d90522cc9ba0\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/core.js\":\"45ca2593fbde1279\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/defaultRenderers.js\":\"07bb747411c2889e\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/definitionFanoutAppMount.js\":\"f73efed95fbdf7dd\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/dialogAppMount.js\":\"797915bf25f54742\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/dynamicExtensionSeeds.js\":\"9c3bcdac20f40d1b\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/dynamicExtensions.js\":\"48acd5e3312049d1\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/exampleExtensions.js\":\"53f98e3bab274fd0\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/extensionApprovalStatus.js\":\"0bce3364b5e4b94e\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/extensionLoadErrorToast.js\":\"286888c5ffc52ca2\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/extensionLoadErrors.js\":\"d6dfdd96ecb1aa0d\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/extensionLookup.js\":\"1645a036a093b501\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/extensionToggles.js\":\"dd76477541bafe16\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/extensionUtilitiesCss.js\":\"ebfb29f16478398f\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/kernelPageDeletionGuard.js\":\"73d2a47efc7be636\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/liveRuntime.js\":\"fdcc39d401c5fe86\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/openExtensionsSettings.js\":\"866110a1b28fa0cb\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/overridesCache.js\":\"703a00630d52d87b\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/pluginIds.js\":\"c83e6b1a1a8f8b33\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/processorRejectionToast.js\":\"80359ce6020ae5a4\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/runtimeActions.js\":\"68a05a0c613bddf5\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/runtimeContext.js\":\"2e4f0ccbb37e6640\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/staticAppExtensions.js\":\"a357dcb12abf0da5\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/staticDataExtensions.js\":\"da2e7c9b1d1185e2\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/toastAppMount.js\":\"1a93f2d7bb1cc0ec\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/useOverrides.js\":\"ab5b42b5a08f686a\",\"/knowledge-medium/pr-preview/pr-1881/src/extensions/useShortcutSurfaceActivations.js\":\"dd2578b21a4c82cd\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/discoverToggleTree.js\":\"3dc6e89250530416\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/facet.js\":\"bf93277d76fcaa22\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/resolveAppRuntime.js\":\"01e36367410d5f4a\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/runtimeEvents.js\":\"f39d3c781935b394\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/togglable.js\":\"dec678d350ef4d38\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/variantFacet.js\":\"276a12f3092e774a\",\"/knowledge-medium/pr-preview/pr-1881/src/facets/verbFacet.js\":\"e694b6c3d81ab6d4\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/block.js\":\"6a6c10d0ad9f64ea\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/focusedChild.js\":\"f6b309925ae8925a\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/propertySchemas.js\":\"c053ed42b2ebc037\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/typeRegistry.js\":\"703086bec8fa85ac\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useAncestorCrumbs.js\":\"5923f5276066fd3d\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useAutocompleteListbox.js\":\"fa9e35c1aa7586c3\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useDebouncedSearch.js\":\"be7266d3d4d8fc35\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useDebouncedValue.js\":\"45203c1ee9f84579\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useIsFocalRender.js\":\"17f7ff0bd8a53b60\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useIsReadOnly.js\":\"00a80f34afb9b3aa\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useMaterializeBacklog.js\":\"3712ef33761d643e\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useMinuteClock.js\":\"2224a85e2a0717f6\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/usePanelLayoutProjection.js\":\"115ab85c0ee18fda\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/usePendingInvitations.js\":\"083592e8c78ea663\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useRendererRegistry.js\":\"ca8529f366a3b5b3\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useRetainedFieldRows.js\":\"cc0e72f3d27b14f5\",\"/knowledge-medium/pr-preview/pr-1881/src/hooks/useWorkspaces.js\":\"6501594160c1357e\",\"/knowledge-medium/pr-preview/pr-1881/src/lib/utils.js\":\"4a1b0afacb0901d3\",\"/knowledge-medium/pr-preview/pr-1881/src/main.js\":\"9ddd2bf26bccac91\",\"/knowledge-medium/pr-preview/pr-1881/src/markdown/MarkdownImage.js\":\"5f93c47fe1332317\",\"/knowledge-medium/pr-preview/pr-1881/src/markdown/blockSeparators.js\":\"8df2141f7fcc7192\",\"/knowledge-medium/pr-preview/pr-1881/src/markdown/context.js\":\"64fded8f65c0fd69\",\"/knowledge-medium/pr-preview/pr-1881/src/markdown/defaultMarkdownExtension.js\":\"3d900e0cf598ba75\",\"/knowledge-medium/pr-preview/pr-1881/src/markdown/extensions.js\":\"fc8eb83714e18e6f\",\"/knowledge-medium/pr-preview/pr-1881/src/markdown/renderMarkdownHtml.js\":\"0a9ce7d76e339341\",\"/knowledge-medium/pr-preview/pr-1881/src/minimal-editor.js\":\"71121c2082a870da\",\"/knowledge-medium/pr-preview/pr-1881/src/paste/armedCut.js\":\"3720ed1982356e3a\",\"/knowledge-medium/pr-preview/pr-1881/src/paste/captureMediaVerb.js\":\"733edc841b63c42c\",\"/knowledge-medium/pr-preview/pr-1881/src/paste/clipboard.js\":\"d0038ff4283f1fc0\",\"/knowledge-medium/pr-preview/pr-1881/src/paste/decision.js\":\"fa2e59119e15997a\",\"/knowledge-medium/pr-preview/pr-1881/src/paste/operations.js\":\"1eb34e5b55946bd8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/account-header/AccountHeaderItem.js\":\"7b8719f5aa86e9a6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/account-header/index.js\":\"161945b6f772f46f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"273536ad00e7f015\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/askAgent.js\":\"6ff9eeac6a65547e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/askedStore.js\":\"c6e33729e77b7aa7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5758d3ba31bedfac\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/chipState.js\":\"01a0dfaed674f666\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/dataExtension.js\":\"e7096aaf34168745\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/index.js\":\"af3966158e4bd9a6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"71aa620aed1750d8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-dispatch-companion/schema.js\":\"5b1804d0dcefe068\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e8381c6372e3b24e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4877c51965a75a49\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/addMedia.js\":\"b77567b1a7ad76fc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/backlinks.js\":\"842a910696f8035f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/block.js\":\"a6c3fc069781a9a5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/context.js\":\"92a659ea6445c609\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/displayIds.js\":\"cc3c93379ff6e0a6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/index.js\":\"c008982fc78fb070\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/outline.js\":\"306bca471bdaac5d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/properties.js\":\"c925b02f633a45db\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/refs.js\":\"ea95e65c3f554b7b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"0d75015a32232de9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/search.js\":\"b0e9de3c380ff69f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/shared.js\":\"22d9d9e2e400f59d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"fdd80fe16f005249\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentViews/text.js\":\"37f2473a1feb7885\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/agentWrites.js\":\"bda43f8cd0184929\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/authoringCatalog.js\":\"8aac09b6da942657\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/blockRefTargets.js\":\"8973f527a60e6711\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/bridge.js\":\"ebfc15a4b34475ae\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/bridgeLoop.js\":\"b2242763cd41ebca\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/changeHistory.js\":\"fef6115b5934baee\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/commands.js\":\"9711e325c6b30ce6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/commentsCommands.js\":\"7aca717251ef6a25\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/dataExtension.js\":\"369858dac00f6f0c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/dataModelGuide.js\":\"21fac7c690f81e28\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/describeRuntime.js\":\"ebf265ce95300df1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/extensionLint.js\":\"608ba28324e67f29\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/grainAudit.js\":\"d1c467f554a37d51\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/healthCommand.js\":\"2305acc3509c1776\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/index.js\":\"f62df29b95a27679\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/presetIdentity.js\":\"7897e552e1b11009\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2c6ee34956de11f6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/readMedia.js\":\"086aacec6593b088\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/schema.js\":\"d0ed665edd05f3b1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/serialization.js\":\"86d1386a9c127d8c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/targets.js\":\"ea255d209e0584cc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/tokens.js\":\"5038003e8577f039\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/watchEvents.js\":\"ca1672fb0da99e38\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/workspaceGuard.js\":\"e7a1ab75ee28bace\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/agent-runtime/writeCommands.js\":\"6f07bafe095c96f0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/AliasCollisionToast.js\":\"9dcdbb153b90276f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/DuplicateNameBanner.js\":\"f81a556a10eaec0e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/collisionMerge.js\":\"f45b8a02c6e07b9c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/dataExtension.js\":\"27e109db8fc8450f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/index.js\":\"392dc3467abc0bfa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/mergeCollisionAction.js\":\"7e96f1e9702b826f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/pageStyling.js\":\"712c99a0fe6fc0bb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/rejectionToast.js\":\"c00a9578a46df97f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/alias/syncProcessor.js\":\"f88da85e2cfafeec\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/actions.js\":\"762184cfbc75aaad\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/addComment.js\":\"a6bcee9fca051c44\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/anchor.js\":\"8ca85cd9ebfe1d4c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/anchorState.js\":\"2a7d0827ae9de4d1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/commentLinks.js\":\"05454baf606d0df7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/confirmThreadDeletion.js\":\"868295edb078adf0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/container.js\":\"4f8b9a129a5baf2f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/dataExtension.js\":\"8ea04955b7991ef1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/deleteComment.js\":\"b0af1ac653cd262d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/highlights.js\":\"2089bfd914786f15\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/index.js\":\"956cac83c2e1e558\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/linkedCommentsPill.js\":\"a6ac4f7051d21574\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/margin.js\":\"710c0e89979c9c7e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/marginAnchorLinks.js\":\"4622df3108a1e878\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/marginSchema.js\":\"013ecd568d8299cc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/newComment.js\":\"2741594d387f786a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/ownThreadPicker.js\":\"b928c913de825d65\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/placement.js\":\"1acf2bca1d2a9548\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/queries.js\":\"ee7213c493038d71\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/quotePosition.js\":\"d5ebdeb1ad62a45d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/quotedIn.js\":\"a879ee1c0538cb32\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/quotedRange.js\":\"e474f63d48624ed6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/rangeRefs.js\":\"f9b0ad6b2a51be6e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/readHighlights.js\":\"b78b45ce95a50038\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/readSelection.js\":\"c85911007c02035c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/readSelectionUi.js\":\"e4923042a6ef4992\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/reanchor.js\":\"e58d0759ad2af756\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/schema.js\":\"8a64274744cf74bb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/scope.js\":\"6ed31ca96ad9fa63\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/scopeThreads.js\":\"2eeebe731e6a53c7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/splitRetarget.js\":\"b7207fc793db7d8e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/suggestionCard.js\":\"73cf5b6872bee28d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/suggestions.js\":\"c06bbe6ecf608040\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/summaries.js\":\"10995d6b8fa91609\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/summaryBatch.js\":\"7b799c3085bab778\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/surface.js\":\"e94ca51f5deeb726\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/threadNavigation.js\":\"727a4c9ef0adc374\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/threads.js\":\"fc59118da767c48f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/ui.js\":\"669cf8d2e7d11ecf\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/annotations/uiStore.js\":\"a524fcbd871596b4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/app-intents/appIntents.js\":\"b66d07a665b1898c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/app-intents/index.js\":\"406f34c06432f2c3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/app-update-prompt/index.js\":\"5f2c13ced6d7b9df\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/app-update-prompt/status.js\":\"25efba872eacae2a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"67b18c2550327804\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/MediaBlockRenderer.js\":\"7eb377cf2dda2e0b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5b59f9fe7d1e7337\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/MediaUploadReconciler.js\":\"aa40fe4173e490a3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/assetDownLane.js\":\"7e4954febd165ee7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/assetResolver.js\":\"4c6cc56a998366cb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/assetUpload.js\":\"b824431d5b187251\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/attachmentCleanerIO.js\":\"1c932a24df685499\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/audit/supabaseAuditIO.js\":\"359049fbf27a5b96\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/blobStore.js\":\"bc6352e783fa644e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/browserMedia.js\":\"b72f0b3f8a86051e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/byteStore.js\":\"adba466e1a888040\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/cleanerIO.js\":\"842c77b121f7f784\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/cleanupAttachments.js\":\"d0fab5447605b19e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/dataExtension.js\":\"54a9613e5e0637c6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/downLane.js\":\"517f0b886833ff79\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/index.js\":\"83c04ae1b117412c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/insertImageContribution.js\":\"3031fa7d4709824f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/laneArming.js\":\"1fc027d43d292c75\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/laneLock.js\":\"fe481863abfd2e47\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/mediaBlock.js\":\"89a67c6de49477c3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/mediaCapture.js\":\"60eecfd068c017b3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/mediaLanes.js\":\"7168feedfe959d68\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/mediaViewers.js\":\"803e7a8fcf9082cc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/mediaViewersFacet.js\":\"93b0c969ae5a842a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/pasteCapture.js\":\"5eb91f7550d7e235\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/resolver.js\":\"85d0eeac761bca80\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/retryUploadsAction.js\":\"f508cdf45c9542c8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/storagePaths.js\":\"95b817a86781a621\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/uploadDrain.js\":\"6795755efa0b839e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/uploadLaneStatus.js\":\"585f9b1a927b6f48\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/uploadReconcile.js\":\"415b0999ed9df620\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/uploadRecovery.js\":\"97071201505e1afc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/uploadStore.js\":\"5ac1014cedf4702c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/attachments/useAssetObjectUrl.js\":\"5508fb97a19be82a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"99fc7604d0bd6a05\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks-view/BacklinksViewSection.js\":\"2ea7a2912ed07675\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks-view/facet.js\":\"59702f9ee6da5022\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks-view/index.js\":\"88b4fb013f6aacc0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks-view/prop.js\":\"81aa3d23ab16138e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/BacklinkFilters.js\":\"0a2b0fed773d1320\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9f6e5bca992ab443\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/BlockEntry.js\":\"80015c0579d92e20\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/LinkedReferences.js\":\"0cae3c414681cc75\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"30505a18796746e9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/dailyNoteDefaults.js\":\"56490906965ff84e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/dataExtension.js\":\"ae0f9f114ac45d54\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/edgeExclusions.js\":\"2b9b9c976b4762c0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/filterProperty.js\":\"d1e0b2052e97549f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/index.js\":\"8de84c685e2522e3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"cc108bb2498bbfac\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/inline-counts/applies.js\":\"36b2e55e8e5c6c5a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/inline-counts/countQuery.js\":\"a3d21b2965f4d9de\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4a372ed74c65b24e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/inline-counts/index.js\":\"e105a6aef22470ee\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"197f89661c5a06e3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/presentationInvalidation.js\":\"c79dac34f532ed94\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/propertyEditorOverride.js\":\"036917083322f673\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/propertyFilter.js\":\"480eea3f2fde2a67\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/query.js\":\"f8902f69d1771356\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/resolveFilter.js\":\"d57fc9b5dfa624c9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/sourceBatch.js\":\"4e1054a7713be0d0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/sources.js\":\"14a31cc1c5dd801b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/useBacklinks.js\":\"3e28762f6f472c35\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"aba9e6cd5d7023a4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/birthday/BirthdayCelebration.js\":\"0d48cd3feb143d45\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/birthday/BirthdayOverlay.js\":\"9600ed22d746c055\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/birthday/gate.js\":\"087e774acf957a69\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/birthday/index.js\":\"8e0e1a8c54cb8ab5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/birthday/wolfTheme.js\":\"d716d3364b70f7f0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-drag/BlockDragLayer.js\":\"bad117c93a2447b8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-drag/dragController.js\":\"23f0a9a4dfc2d529\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-drag/dropTarget.js\":\"1890ca044cdc6de1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-drag/index.js\":\"70ab8c5e0f272bd6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-drag/projection.js\":\"91ce168f44c67a24\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-info/BlockMetaCard.js\":\"24e45c0a6c806757\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-info/index.js\":\"d27a0c2fd1939c72\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/AddTagDialog.js\":\"5d9f19e416717480\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"40c70b4a87387be0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/TagNameIssueHint.js\":\"e888496ef187b9aa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/addTagAction.js\":\"f1f6f6a5e3e00901\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/appendTag.js\":\"1078cbf67dfe7dca\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/config.js\":\"a5f804b482a68b60\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/dataExtension.js\":\"0a71d37f8a12360c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/index.js\":\"d094b7f0129ffa89\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/block-tagging/propertyEditorOverride.js\":\"39c31172a0e9dd94\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f0fa683c1b4f8574\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"2a714b0bd875f9e2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/Breadcrumbs.js\":\"13eceaef643d37b6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7611c6bfeac18d53\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"68150f6b8e80e0e2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/index.js\":\"51aa83cc6426784a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5cd52e18e6d5ebb2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/CharacterCountItem.js\":\"960d784d9180f9a9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/ProfilePropertyEditor.js\":\"522b646de98ebfdf\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/actions.js\":\"27a7774e8f7ebd07\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/blockType.js\":\"55d5862db66174b2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/charCount.js\":\"4e44dbf2193ae6d3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/dataExtension.js\":\"beb12813b7fb8c6a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/index.js\":\"66a39681ab5d1a1d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/profiles.js\":\"db36c4c74a6f3b7a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/properties.js\":\"54e8ecbaeef83880\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/character-counter/textCounts.js\":\"55935bdd4f6eaff0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/colemak-keybindings/index.js\":\"b6515e43d3b36b10\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/CommandPalette.js\":\"c6b2c6dd31d9efeb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/HeaderItem.js\":\"f42c97a9a546b5b5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/context.js\":\"584d8c34f7b12cc8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/index.js\":\"f82bd29ddc7cf13e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/selection.js\":\"466414fc69255a95\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/toggleStore.js\":\"fcf9d504ccaaf639\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/command-palette/useCommandPaletteActions.js\":\"fbf11256f6226613\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/ContributorBadges.js\":\"5935b35c76e98179\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/author.js\":\"1b3e40f9d4b47e7d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/codeMirrorExtensions.js\":\"22529d5fe54fbf36\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/dataExtension.js\":\"3b88dd2d2d4c32c2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/index.js\":\"7ce4695cbf55d9aa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/mentionAutocomplete.js\":\"44e677c5cdb7b6ee\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/processor.js\":\"0adeaad01ee804a4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/profiles.js\":\"785e02f7d9272710\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/queries.js\":\"f3a09794009476f2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/contributors/schema.js\":\"760732bbc85be185\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e91619f47c9f7ed1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/cursor-follows-scroll/followOrigin.js\":\"52aed63a1940085d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/cursor-follows-scroll/index.js\":\"490c311549ff9964\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"516b7c859108f1e3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d226a0f5420cb0fd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/CalendarGrid.js\":\"32c29ef6610b419b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/DailyNotePicker.js\":\"9da2293646b5dbb6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4143f21178010616\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/DateNavDecorator.js\":\"6813b34801f73050\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/DateScrubOverlay.js\":\"d6f128918bc06f04\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/HeaderItem.js\":\"387613aed4aa4ef6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/ReschedulePicker.js\":\"2cf22aedf2653da8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/SpreadDatesDialog.js\":\"85ec4377382fed53\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/actions.js\":\"d776f6e615fb7f55\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/blockDateAdapter.js\":\"b4e0d892d19ff05d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/calendar.js\":\"8f2fb121e47d49c5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dailyNotes.js\":\"8e30a4c381c66ceb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dataExtension.js\":\"b5936700c6dbd066\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dateScrubActions.js\":\"ab056fd6a5afdc41\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dateScrubGesture.js\":\"bbe0adfe643591fd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dateScrubGestureActions.js\":\"57d6a4be6c0a3628\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9d55ecedadf6fb11\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/deletionGuard.js\":\"320b885dc9d321f7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/dueQuery.js\":\"53e8f5a4e4a410f4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/index.js\":\"e22a1418cc977505\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/landing.js\":\"87cb11affbad3303\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/localSchema.js\":\"a3299480f1f6b37e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/referenceDateAdapter.js\":\"37363bc289828332\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/rescheduleAction.js\":\"689e21319c24704f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/schema.js\":\"67e452f186fad851\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/spreadBlockDates.js\":\"b2d108b5253e4125\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/spreadDatesAction.js\":\"49780d62cd1f54a7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/today.js\":\"7954307810cb965a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"7ad6f59f0355e303\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d9ebdf28893fecf9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/audit.js\":\"071f506eeb0b4c09\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/auditAction.js\":\"b3083d20d23e4692\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/auditRanges.js\":\"809e2e8a919f475d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/diagnosticsSource.js\":\"067b169ef37d5003\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/divergenceScan.js\":\"5ba3010411133cdf\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/index.js\":\"58e9eb41e0169fb4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/propertyChildrenChecks.js\":\"dbc3d170ae4e1e6a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/referencesMirror.js\":\"62e389d28a6d60c6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/rowJson.js\":\"8d232bc1e370f410\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/schedule.js\":\"e0fdbb0fbf6e3112\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/data-integrity/store.js\":\"12c6d5e43bc5bebd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-maintenance/action.js\":\"74edcf64968fa365\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-maintenance/index.js\":\"bb10434a43a94df8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-maintenance/plugin.js\":\"4b434c94414a7893\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"415464893e836ae2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/actions.js\":\"4b6c90ea0b8a5b7a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/changeMarker.js\":\"3d282521edcfd7d3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/diagnostics.js\":\"d9123076da915db7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/fileSystemAccess.js\":\"99a60d38e1b2f4e1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/filenames.js\":\"d6a8f71db27d1117\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/index.js\":\"6afb2fdfd2abfe6e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/mirror.js\":\"18a78a6fc0958bfb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/runLock.js\":\"f1dd46978ac673d5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/runtimeHealth.js\":\"bc11f71b2e81365c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/schedule.js\":\"f893318a8484e208\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/db-mirror/store.js\":\"c93e80c1d96c049f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/default-themes/index.js\":\"3448ddf45dcd2118\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/default-themes/themes.js\":\"0b8a4b7deb3b4028\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/diagnostics/facet.js\":\"de44220a0d419464\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/diagnostics/useDiagnostics.js\":\"c761e9c64af48714\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extension-prompts/dismissals.js\":\"9fd7a81e10e4a3ab\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extension-prompts/index.js\":\"44e8b7ad6dfbde5b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extension-prompts/status.js\":\"27973a88dab8352d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extension-prompts/store.js\":\"84969a3b68973e0f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"82eab6003e1065f9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/ExtensionsSettings.js\":\"60ca58c292c7ac8d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/actions.js\":\"0e6cca9b9122cbb4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/config.js\":\"174247598992ee1d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/dataExtension.js\":\"f48d0fda4d36f0ba\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/effect.js\":\"f36f71d7104bf842\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/index.js\":\"a5dd69eeffeee5b8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f39bde53351004b3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extensions-settings/useToggleTree.js\":\"27fd10a541d038ea\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extract-type/ExtractTypeDialog.js\":\"61c6d8512fc602b1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e2eb6b57c4ae8343\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extract-type/PropertyShapePicker.js\":\"8f2bbf77b8cd6f2e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extract-type/action.js\":\"810086994ecdd1bd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/extract-type/index.js\":\"96f478f83f23ea77\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/FindReplaceDialog.js\":\"8f3ba02cb1359c99\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/HeaderItem.js\":\"e567cf5520a4ae28\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/dataExtension.js\":\"c117cb8ea77f8989\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/index.js\":\"e5c7ef77810ea9ca\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/search.js\":\"d0d03b226ea5443b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/toggleStore.js\":\"eea1a366b02feb1f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/LocationPropertyEditor.js\":\"199522b7ff84ca5b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/MapView.js\":\"b44755ab74fca8c2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/blockTypes.js\":\"91409a7c7ab20ed6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/codeMirrorExtensions.js\":\"e1d4a72e94832c08\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/createOrFindPlace.js\":\"fe360b596ed2417b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/currentLocation.js\":\"0c846bb577b05ffc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/dataExtension.js\":\"672db04b824af498\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/geoContentDecorator.js\":\"b2d294cfa6012d1e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/googlePlacesClient.js\":\"8f5fa4d66cb76a5e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/index.js\":\"5e5f1369c352c935\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/locationsPage.js\":\"8dd98fbb769a2081\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/mapViewport.js\":\"d9975f5794769865\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/pickCurrentLocation.js\":\"8824a4731053334d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/placeAutocomplete.js\":\"669890f69cc51e74\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/placeNameCollision.js\":\"0cb427d0f77d6049\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/properties.js\":\"e40f19e97a9e864b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/propertyEditorOverrides.js\":\"048ff77c30281de2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/query.js\":\"23a810a65ccfb311\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/geo/usePlaceSearch.js\":\"5a5643cc2cfab624\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f80703afb65935ce\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"44e3d9d7e1d26224\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6c339b6f006de837\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/config.js\":\"26eb7e38b645c70e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/dataExtension.js\":\"1fb33f61acee9a5e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/facet.js\":\"ac3af32278b492b9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/grouping.js\":\"f7a0ace5f752829c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/index.js\":\"b832c7f730b99238\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"00534e7571436727\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/query.js\":\"a558fb6772499004\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/resolveConfig.js\":\"8c6d4dd0aebc641a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d2f3960afeb8daad\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"272baf527787a357\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/HtmlDocumentContent.js\":\"5bcfe07c5c1f7bd6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/HtmlFrame.js\":\"84ec1c47a1d8e1a1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/actions.js\":\"069259f79db00823\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/blockType.js\":\"3c48d497e279bff5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/confirmRunScripts.js\":\"81f8df512269c466\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/dataExtension.js\":\"e0b86c4a74aee1b4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/frameAnnotations.js\":\"ca221466147e14af\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/frameDocument.js\":\"1e99b53e10d535c7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/frameTheme.js\":\"144478724a7ad26a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/index.js\":\"d721461ec56e487c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/scriptConsent.js\":\"2d0b33a47d0923d2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/sourceMap.js\":\"12d52c00051e2f51\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/html-document/useDocumentScripts.js\":\"865cb5f7d71ca54c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/interaction-metrics/index.js\":\"63a3efdcb8fdf8ea\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/interaction-metrics/record.js\":\"4799287fc76cdf91\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/interaction-metrics/recordStore.js\":\"63fb652ec2302a12\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/interaction-metrics/responsiveness.js\":\"c249d61803a22f60\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/interaction-metrics/schedule.js\":\"f5795c41c064baac\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/interaction-metrics/sessionContext.js\":\"edb9f1b0547671af\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"daf41b53ea04deb7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5c804573e6db0024\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/actions.js\":\"678f34dba38b3386\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/config.js\":\"7a420bea379d72e5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/dataExtension.js\":\"93f90dd98907a142\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/effect.js\":\"d9fd029982ddba88\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/index.js\":\"ce300fa23efd6c16\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/keyCapture.js\":\"c0d1c0b1837ae18b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/overrideStore.js\":\"234c26a9d20c3084\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c578bb8019651ce5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/HeaderItem.js\":\"6f3b6099005480d1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/LeftSidebar.js\":\"7d946d927b3c068a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/actions.js\":\"48f16f32c8da4569\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/facet.js\":\"5833f4028ed8cc06\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/index.js\":\"1def5ecbb57425b2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/shortcuts.js\":\"3f9fb0c2cf8c83fa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/left-sidebar/toggleStore.js\":\"df5d5b99a0b044a8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/merge-blocks/MergePicker.js\":\"b71e3f514e0871bb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/merge-blocks/index.js\":\"ec0b34191c8f85e4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/merge-blocks/mergeAction.js\":\"8a8d83cba6772b4c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/merge-blocks/strategy.js\":\"491ccf88c46f657f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-bottom-nav/Button.js\":\"cb11ed551e66a71b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"80866997552a3416\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-bottom-nav/defaultItems.js\":\"bd7f630626204956\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-bottom-nav/facet.js\":\"18d6f7ad273786f3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-bottom-nav/index.js\":\"a03f7f8f8c37a220\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"67794e30849f586c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5170c7cdd9f31bf9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"bacb2b70adbf4d5f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-keyboard-toolbar/facet.js\":\"d765a130ab124fc8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/mobile-keyboard-toolbar/index.js\":\"b50e5dc00fa2d0af\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/MoveDestinationPicker.js\":\"bb1b2d0bd4003a2b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/blockSubtreeMembership.js\":\"4a03769457a2b9c4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/contextMenuItem.js\":\"53d31ad3e78921d9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/index.js\":\"2c5983e7edca02a0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/moveAction.js\":\"623de1a315b4fba2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/moveBlocks.js\":\"44ab589c9f0a10ea\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/move-blocks/selectionAfterMove.js\":\"e5cc1dc31dbc7f57\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/TutorialBanner.js\":\"46014776517a0bea\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/action.js\":\"bd26b1e53b6aae22\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/bannerDismissal.js\":\"8c1fba7188fbab54\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/documents/cheatSheet.js\":\"1edf51ff535baa6a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/index.js\":\"f856ad42320f432a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/keys.js\":\"e3f9a97ec565bb78\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/landing.js\":\"0038c25308787b20\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/outline.js\":\"e6722d7a0ca0f293\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/onboarding/seed.js\":\"e84f40bd12816bd8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/PerfTrendDialog.js\":\"772acb5264daa822\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/analyze.js\":\"80ea1d0706d6c3bd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/diagnosticsSource.js\":\"a401d2b81bf22d9f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/index.js\":\"3c06d7c40f1a8862\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/load.js\":\"d59990f858d60f41\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/monitorRun.js\":\"f1b5196751f1a6fe\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/schedule.js\":\"ab19c3869f5087b5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/series.js\":\"410cefb32f5ff83f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/store.js\":\"1e8af9b35a5fad28\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/trendAction.js\":\"a6cfca5d63af0275\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/perf-monitor/verdict.js\":\"dba27441a07200a7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/plain-outliner/clickToEditAction.js\":\"ed0c6b25277fa20f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/plain-outliner/index.js\":\"2b84bd315b7bd46d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/plain-outliner/interactions.js\":\"a6e19b6f9fb2c53e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3c9071dde97351ec\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/MigrationGate.js\":\"f83d29e8c5a60e7e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/MigrationGateDialog.js\":\"12b88fbdc817d5af\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/action.js\":\"f7215fb90f4e4962\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/index.js\":\"ec0def43bc8c0e7d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/localRunMessage.js\":\"dcbd115c3df515e6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/plugin.js\":\"e252301537df1938\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/progressReport.js\":\"e4a1145bdaa3beff\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/properties-migration/sweepProgress.js\":\"bde88e5823034262\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/FieldRowRenderer.js\":\"0f566104d786b4fd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/ValueRowRenderer.js\":\"11e53805c10d8510\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/actions.js\":\"22b7bf306a561fff\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/autocomplete.js\":\"02428eb5f76fd7cc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/fieldRow.js\":\"67db41b7f3d14813\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/index.js\":\"b59b6dfc5b7fa352\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/referenceWarning.js\":\"854253116a6098ab\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/valueAutocomplete.js\":\"b0ac1a09ab639f8e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/property-rows/valueSchema.js\":\"8e1576847019dc42\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/HeaderItem.js\":\"1c9f8310ef2d54d7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/QuickFind.js\":\"eb041a6a9cf0c59a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/index.js\":\"e81f52bc7f7cdb55\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/recents.js\":\"9d84326225896864\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/resultItems.js\":\"133f3243d12abdce\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/selection.js\":\"69fc2a27b209cbec\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/quick-find/toggleStore.js\":\"a6a68e0640b51146\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/recents/HeaderItem.js\":\"56f8e2652a6ab1e2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/recents/RecentsPageBlockRenderer.js\":\"03961af196012224\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/recents/grouping.js\":\"0f11c73a41e47b31\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/recents/index.js\":\"721fa03b6b19bb1d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/recents/target.js\":\"7f3a4160eb00434d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/codeMirrorExtensions.js\":\"07df32b58b31faf1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/contentPrefill.js\":\"d0bbca96bc946ffa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/dataExtension.js\":\"17f995ad6de37995\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/index.js\":\"66619fc948ca8544\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"efc102234b1edaf7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/invalidation.js\":\"a0a206a3289e7de4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/localSchema.js\":\"4e35436daeb576b7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/blockrefs/index.js\":\"3766d034e5e31251\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d81a9bd3f7c5aefa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/index.js\":\"50f78b387530bb5e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/referenceNode.js\":\"57a05dc328b6be76\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/remark-reference-occurrences.js\":\"21926f8259011c2f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"705ee2492f2bb326\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/wikilinks/index.js\":\"3b54a842d1a4c28f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2d1c749234447fb1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a7c4126e8c9aa042\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/mergeRetargetProcessor.js\":\"c880ac358060c334\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/parseFence.js\":\"c6b61a2d9d1dcfa5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/referenceParser.js\":\"37bc15248e88cf73\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/referenceProjection.js\":\"d0d98d0180065c4c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/referencesProcessor.js\":\"8303ec269dcf8686\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/renameProcessor.js\":\"60fc7deecb479df4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/references/spanReplacement.js\":\"bfdc551ffe6ee28f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/rich-paste/htmlToOutline.js\":\"d7fcd79dedae9cd6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/rich-paste/index.js\":\"df842054ad211ec4\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/rich-paste/normalizeClipboardDom.js\":\"d353068fb27b6e6f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/rich-paste/pasteDecision.js\":\"65db385562342091\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/action.js\":\"a915a1c1892cb0f2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/blockIds.js\":\"fe2014c9441eeff9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/content.js\":\"254f8441e4af85c0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/effect.js\":\"a9fa68ecbc1b728a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/ids.js\":\"c4cd84ed2304f163\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/import.js\":\"1fdca201c1ec8be6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/index.js\":\"51b6d2a3ae785843\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/plan.js\":\"05fbbcd2b0b339a0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/plugin.js\":\"ad27cf864c3e2b6c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/promotion.js\":\"908735e2bdc0a567\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/properties.js\":\"8e359f6079a6c52d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/references.js\":\"f8c686d343a7f7e3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/report.js\":\"c798da232bf75896\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/roamMemo.js\":\"4482f60273dcc9f3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/runtime.js\":\"a1019268380e85ab\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/schemaReconciliation.js\":\"f4326fe728b846dc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/srsMarkers.js\":\"778cbd84c117457a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/todo.js\":\"8cfd3ef94682ffb2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/typeCandidates.js\":\"bd4bacea8fea63c5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/roam-import/types.js\":\"1bd99ad8c3ee48b6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/search-health/index.js\":\"524b7458117aedb2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/search-health/store.js\":\"441ffed3e11f0b59\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/shortcut-help/HeaderItem.js\":\"522e364fd4cbdbf9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"94a60a34a0d67118\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/shortcut-help/index.js\":\"adc75cc31205d5bf\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/shortcut-help/model.js\":\"693ebb9d4cff660a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/shortcut-help/toggleStore.js\":\"e4808b4ee31a0ce3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/shortcut-help/useKeyInspector.js\":\"a8324bf062510968\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"ba40413fc7412e4f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/ShellDecorator.js\":\"c6eb3221abfebb5f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/actions.js\":\"d426e32aabe23487\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/exclusionsFacet.js\":\"392b9ec20a59ee76\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/index.js\":\"fbdb3f4dd3921efb\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/shell.js\":\"4fcc9b461c485190\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/surface.js\":\"24682384c8e0457f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/spatial-navigation/walker.js\":\"d0423dd513ab34d6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4edb7c106280daf8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/dataExtension.js\":\"f62ff11e3891d2a2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/index.js\":\"a53109b892ffd12c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/indicator.js\":\"8666976f4607b17b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/moveSrsState.js\":\"0c1df12521fc3d06\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"5e0153b76961e4df\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/scheduler.js\":\"06e210e2723fb792\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/schema.js\":\"f0b97108be737547\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2271538e0f7be10c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/srsClipboard.js\":\"bf54ebc5c7554463\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1ff28d71922384f2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/DailyNoteReviewHint.js\":\"e7e0b30db75305ff\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/DeckPicker.js\":\"d30b74029025593e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/ReviewControls.js\":\"7e18a27e34397aa2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/ReviewDeckRenderer.js\":\"713aeae8ab4546ed\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/ReviewSession.js\":\"2b6a17ce8533a16c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/actions.js\":\"9985d2f6e8a6a09b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/archive.js\":\"0b5f84f06bffd148\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/dataExtension.js\":\"7af5b51fbf13a4fa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/deck.js\":\"c4281cca9f44011c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/dueQuery.js\":\"d31d2b3402a05398\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/gradeDecision.js\":\"5bc5c1f38798fdff\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/index.js\":\"b034073aa8e6b8ef\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/keyHints.js\":\"afb3f948950b1792\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/reviewCardLayout.js\":\"1aa61c614cf8453d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/reviewProgress.js\":\"6592f820debf13ef\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/schema.js\":\"30bb875044ee69b8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/srs-review/useDueCards.js\":\"161d8fa1e120d26d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/startup-metrics/index.js\":\"a5cc3dad21769854\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/startup-metrics/record.js\":\"54ffddc01debef58\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/storage-persistence/index.js\":\"d4a67ebb970bd770\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/storage-persistence/persistenceStatus.js\":\"d3e84fbac00056f9\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/storage-persistence/requestAction.js\":\"300093f8891645b1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/supertags/TypeChipsDecorator.js\":\"16f978f0b551ab36\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/supertags/codeMirrorExtensions.js\":\"0c39b919b116087d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/supertags/index.js\":\"f7d0a2bd9f0f16c8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/supertags/typeAutocomplete.js\":\"22e35508fb5545fa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6fd7528df8a303c6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/actions.js\":\"e0696f33db7e26e2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/anchor.js\":\"3b9dde077d7f5c4e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/events.js\":\"5d9ada10a0abd962\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/gestureActions.js\":\"f3e09d043ce662a8\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/index.js\":\"d82b748a05b0655c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"d1eb984535e7d3d3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/sync-metrics/collect.js\":\"a5649eb9c336a0e1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/sync-metrics/index.js\":\"63d8d6940fc8b6d3\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/sync-metrics/record.js\":\"5403844176bc1d47\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/RejectionDialog.js\":\"1978615ba9a6668c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/SystemStatusHeaderItem.js\":\"17b3c6f83b653397\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/index.js\":\"0a9c228bd35e78dc\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/model.js\":\"8f491248650096d5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/queueCounts.js\":\"47b6a0b7e42911d5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/rejectedHelpers.js\":\"ba6ebc233a4b0cf7\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/rematerializeAction.js\":\"53180c7f2f88e935\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/system-status/useHysteresis.js\":\"c38e813684d09000\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/ColumnHeaders.js\":\"904b0a9e7bf9bdf0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/QueryUi.js\":\"5dbc2d64fc911e5b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/TableLayout.js\":\"170aecd21356b240\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/actions.js\":\"e1ec8ac22f5982e0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/cellEdits.js\":\"1f8c2ae85c82a1ad\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/childrenViews.js\":\"33463990e9aac1b1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/columns.js\":\"beb0a4edcf20e92b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/controller.js\":\"81218d5f02159a3c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/convert.js\":\"44dc606878fabd3d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/dataExtension.js\":\"857beb87833bdfe2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/index.js\":\"b7b47e7f646a30f5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/keys.js\":\"66091ace3ab7ecb6\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/model.js\":\"5f2b94bbf3749052\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/query/backfill.js\":\"dcbe7a783abc5463\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/query/completion.js\":\"b615b46fedb4f11d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/query/format.js\":\"8b09f9092486bf0c\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/query/parse.js\":\"df19824523f64353\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/query/queryValue.js\":\"e9fea024f757c067\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/query/source.js\":\"e2a50b58d9a43996\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/registry.js\":\"0ceb6bd93e6a6b0b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/rowGutter.js\":\"a109b43c4e0dbf3b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/rowVerbs.js\":\"f84ef06ca667e722\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/schema.js\":\"fcf1870d1a2f1803\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/tables/sort.js\":\"45e80c74cbefe786\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/theme-toggle/effect.js\":\"0bb33e2d71560305\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/theme-toggle/index.js\":\"2fd0e0d2e8c92aef\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/theme-toggle/theme.js\":\"543031340ddf9037\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/todo/actions.js\":\"21268955fe042647\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/todo/dataExtension.js\":\"08944d9a2d02118e\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/todo/index.js\":\"0e80000f3462150d\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/todo/schema.js\":\"e0a5eafae710cbf0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c6318fcd7aa4ce00\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/touch-selection/actions.js\":\"a846301788fc119b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/touch-selection/defaultItems.js\":\"4553ad9c6ff8c241\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/touch-selection/facet.js\":\"f16a71c049343020\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/touch-selection/holdRecognizer.js\":\"bafb014a08f7255b\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/touch-selection/index.js\":\"34c455aa7b74bed0\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/update-indicator/UpdateIndicator.js\":\"af48313928ae24bd\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/update-indicator/index.js\":\"cd7a1e7ecc314793\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/update-indicator/loadTimes.js\":\"d0eba1a8f35a6554\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/VideoNotesRenderer.js\":\"b18178e8f4004453\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/VideoPlayerRenderer.js\":\"c2caf9b8f1555262\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/VideoTimeStamp.js\":\"c2c9848cccdf1161\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/actions.js\":\"1205921b76383db2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/index.js\":\"110d01ca0a1154f5\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/markdown.js\":\"aac35c98cdd9fa9f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/notes.js\":\"87c05de86a0fed91\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/registry.js\":\"25c658bf566e26d1\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/remark-timestamps.js\":\"507425b0235750a2\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/video-player/view.js\":\"ef2d357211467d40\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-link-hints/LinkHints.js\":\"ae8588929cc1603f\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-link-hints/index.js\":\"5d339fa076d30dfa\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-link-hints/model.js\":\"6dc93dfddd77caab\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-link-hints/settings.js\":\"72ad3258fc94e13a\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-normal-mode/actions.js\":\"3a13057e02140abf\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-normal-mode/index.js\":\"bf232c4ae985d5af\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/vim-normal-mode/interactions.js\":\"05b1ee733efebfad\",\"/knowledge-medium/pr-preview/pr-1881/src/plugins/workspace-header/index.js\":\"e9d34409618c0428\",\"/knowledge-medium/pr-preview/pr-1881/src/registerServiceWorker.js\":\"68e1845c29347274\",\"/knowledge-medium/pr-preview/pr-1881/src/requestPersistentStorage.js\":\"b3cb50df5bc21f59\",\"/knowledge-medium/pr-preview/pr-1881/src/services/authRequestDeadline.js\":\"d409ebeb7020f17a\",\"/knowledge-medium/pr-preview/pr-1881/src/services/authStorage.js\":\"479c59084751916a\",\"/knowledge-medium/pr-preview/pr-1881/src/services/powersync.js\":\"232e1c6c2ffa7130\",\"/knowledge-medium/pr-preview/pr-1881/src/services/supabase.js\":\"6efb196d60052e25\",\"/knowledge-medium/pr-preview/pr-1881/src/services/uploadErrorClassifier.js\":\"8795da4e314bfcea\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/ActiveContexts.js\":\"c43ae87dd41d045a\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/HotkeyReconciler.js\":\"107d3b4ff34842c8\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/WipeLocalDataDialog.js\":\"631a440a2d72b3b9\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/actionDispatch.js\":\"1dde105affcbdc02\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/actionRefItems.js\":\"1cf7a7c5ca0e77a7\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/applyKeybindingOverrides.js\":\"24d5613d2788a335\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/blockActions.js\":\"e0a90fe498817c7b\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/blockMergeGesture.js\":\"7604921c0b2bb6dd\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/canonicalizeChord.js\":\"af45695f143ca687\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/defaultContexts.js\":\"fd9c401a9c7e6bd6\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/defaultShortcuts.js\":\"c182b721c79f303f\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/effectiveActions.js\":\"74f7c49bb0d9a3e1\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/gestureAction.js\":\"30409f095340e38e\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/gestureBinding.js\":\"500daffeaa45759e\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/holdRegistry.js\":\"7686ff9888a86723\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/keybindingConflicts.js\":\"f9829cbc34c0605c\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/keybindingOverrides.js\":\"60b0ad2e56229c0d\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/pointerAction.js\":\"9cd2cf86dccae573\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/resolve.js\":\"e72173ce68501582\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/runAction.js\":\"d9cc2abd8d880658\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/sequenceMatcher.js\":\"1b6de3fe1ab78aab\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/types.js\":\"1e2b77120c0cbdd7\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/useActionContext.js\":\"3c988b86f720f395\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/useActionDiscovery.js\":\"e84c7227ba7f5f8a\",\"/knowledge-medium/pr-preview/pr-1881/src/shortcuts/utils.js\":\"d1bd3432dcf49d60\",\"/knowledge-medium/pr-preview/pr-1881/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1881/src/sw/bootStore.js\":\"fe22c47e849799cc\",\"/knowledge-medium/pr-preview/pr-1881/src/sw/previewDatabases.js\":\"db91a0e8e188a4c6\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/byteTransform.js\":\"238953c67f033bf2\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/attachmentCleaner.js\":\"18f70dbc09a9e4f2\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/bundle/attachmentParts.js\":\"8f99f5641cb35885\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/bundle/bundleParts.js\":\"8b162b5521473beb\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/bundle/bundleRecord.js\":\"af835475f495798d\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/bundle/manifest.js\":\"c9eea226dcdabccd\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/bundle/takeBundle.js\":\"af51f7533a2737f4\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/bundle/verifyBundle.js\":\"2563db677a01d849\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/cleaningStage.js\":\"ddfdd0ac79987dba\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/conversionKey.js\":\"3df175c8a2692800\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/conversionServer.js\":\"af345c55bdb64449\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/flip.js\":\"beee493853815f31\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/flipAttempts.js\":\"b457141b5e24ba22\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/pages.js\":\"262ccbd99bb540a4\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/preflight.js\":\"816ef107983692ae\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/reseal.js\":\"d27540a821e507c4\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/runConversion.js\":\"74d6b39d53324217\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/runLock.js\":\"0fd27e60f97432e4\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/sealing.js\":\"d86a4b61e133a178\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/sealingStage.js\":\"c40bf5464a125948\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/stage.js\":\"dc8a4a05410584c2\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/conversion/verifyReseal.js\":\"b3e361ca7e45027f\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/aad.js\":\"1953aef02866a9cb\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/aead.js\":\"299ce2236baf3f68\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/base32.js\":\"dbd895de3aaca76a\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/base64url.js\":\"c1b8495c57684914\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/binaryEnvelope.js\":\"6268cb443d04446c\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/byteAead.js\":\"4dcc315268ba63f0\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/canary.js\":\"13d1a55720f10335\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/contentHash.js\":\"bf71f2f618b834e6\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/contentKey.js\":\"c22ec0e5e6186be8\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/derivedIdNamespace.js\":\"2f15b5dbc4ddb190\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/envelope.js\":\"f6979a315ae6024b\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/hex.js\":\"10344af7e358bd91\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/sha256Hex.js\":\"64fa77f7103a529f\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/crypto/workspaceKey.js\":\"2e97a948701e899a\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/conversionState.js\":\"26e46675f82667f0\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/flows/createEncryptedWorkspace.js\":\"c664b59058f81b39\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/flows/pastedKey.js\":\"cf994d5943bf0c41\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"58015b39e0073c4c\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/flows/upgradeWorkspacePin.js\":\"32491a88818a5607\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/keyStore.js\":\"87159062d6827e06\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/mintWorkspaceKey.js\":\"708569ca8e424712\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/modePin.js\":\"5acaa6fcce3794b3\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/openWorkspaceKeys.js\":\"d11d326f27118c58\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/resolveWorkspaceEntry.js\":\"b72567134faf9da4\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/resolver.js\":\"7cfd96db274e5153\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/keys/workspaceAccess.js\":\"5628b1c2439acfa5\",\"/knowledge-medium/pr-preview/pr-1881/src/sync/transform.js\":\"ee6c7905ed3da440\",\"/knowledge-medium/pr-preview/pr-1881/src/themeBootDefaults.js\":\"dfd76be3a50897be\",\"/knowledge-medium/pr-preview/pr-1881/src/types.js\":\"f0762cb40600afc3\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/ClientLocalSettings.js\":\"cec79838af026cf2\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/abortableSleep.js\":\"1d9586ca3f292b2b\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/array.js\":\"a6b9f211a446a609\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/backlinkAutocomplete.js\":\"62f6b41dc89783dd\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/blockCrumbs.js\":\"bbd39fdf9443b5d8\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/blockrefAutocomplete.js\":\"28ad51f78c10e39c\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/cadencedIdleJob.js\":\"90b141efe1fbbf38\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/callbackSet.js\":\"9780d90c689df361\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/clientId.js\":\"9967c2c79b3e0fc8\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/codemirror.js\":\"4c55b7848ccba618\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/codemirrorCompletion.js\":\"2cde11a73010d11f\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/copy.js\":\"4708b146dc86de3e\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/dailyPage.js\":\"3df5f2ad4bbd6317\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/dbForensics.js\":\"e9846dd0d388cfa7\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/dbForensicsHooks.js\":\"0fe06b0226891377\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/deleteBlockThroughUi.js\":\"ebc10efdff8766aa\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/dialogs.js\":\"9c67ce7639f2a04f\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/dom.js\":\"b7938d3c77f41fb8\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/downloadBlob.js\":\"8535b31aeb9bb336\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/drawnWalk.js\":\"da2d154023ee2191\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/exportSqliteDb.js\":\"d683d784f7d9ecb9\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/fileSystemAccess.js\":\"b701ac37937efa4b\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/flipSlide.js\":\"316de45abf43c8de\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/fnv1a.js\":\"cba134c63c9202bd\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/formatBytes.js\":\"3802e24d60d5b520\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/fuzzyRank.js\":\"f3a80e8598c36782\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/idbKeyedStore.js\":\"1b455e4b913cf59e\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/idleCallbackPolyfill.js\":\"7af8d34cad20638f\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/keyboardAwareScroll.js\":\"7be970d56a4a5671\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/keyboardViewport.js\":\"20b0c5dafaa0c38f\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/lastWorkspace.js\":\"ce22dd5d370ecdf2\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/layoutColumns.js\":\"bf58687838922141\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/layoutSessionDom.js\":\"5eac3f27612f2e1a\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/layoutSessionId.js\":\"fc4a0ccaf8a8bdc3\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/linkClickGestures.js\":\"b3e6d9b4f4c86c93\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/linkTargetAutocomplete.js\":\"d518988aacad4d80\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/localDbCorruption.js\":\"ca761b688de69533\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/localDbRecovery.js\":\"f8b67e8cc9e7af78\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/markdownParser.js\":\"c0ad3fd1bbeca5d3\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/memoize.js\":\"bbe6a47ec991ba0d\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/nameFieldCommit.js\":\"4f0a9a0a8ddb0ae5\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/nameList.js\":\"fe24d510e0bc5d83\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/navigation.js\":\"7252fb764f6f36ee\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/omnilinerNamespace.js\":\"572c3dd629a30545\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/opfsPageScan.js\":\"46984a1ccd283364\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/panelClearance.js\":\"53e3efb97f57a0a5\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/panelHistory.js\":\"8b45b977de2b7ba9\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/panelLanes.js\":\"fd7af5ccdf088478\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/panelLayoutProjection.js\":\"f39495aa16d913e6\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/panelScrollAnchor.js\":\"1dc93a34dadcbaba\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/panelUrlFlags.js\":\"4abfb956ed2c1160\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/platform.js\":\"95ee3cb7ec877b30\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/pluralize.js\":\"b3a40cfb392bcf3f\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/propertyCreation.js\":\"3320c3aef77d7b16\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/propertyNavigation.js\":\"2c8dd4932bf00a1c\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/propertyValueContext.js\":\"6c8506d7aeaaf0e4\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/react.js\":\"08c915c93dce857c\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/relativeDate.js\":\"4f3f1c8bd53a5136\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/relativeTime.js\":\"f15030f37bca602b\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/renderScope.js\":\"9afa42af0b0b7c23\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/resolvedThenable.js\":\"e384fbc4eaafa57a\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/routing.js\":\"725dfc60e342818d\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/safeMode.js\":\"e298ea976de3682c\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/scheduleIdle.js\":\"810e882d24ec3e3d\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/screenWakeLock.js\":\"4db96303b24d38a6\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/selection.js\":\"ca2041d3c07bd972\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/softKeyboardGrab.js\":\"f67bc6a2e2fc1b91\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/startupTimeline.js\":\"e0d9f26d248f0364\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/state.js\":\"cb5fd76accbf3981\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/string.js\":\"d7a94b0a6a34d952\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/surfaceZoom.js\":\"d8bcdf7c99269e9d\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/time.js\":\"9d78aff4e41cb676\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/toast.js\":\"a53465d38769dbfd\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/toggleStore.js\":\"c9766a91fd84847a\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/untilStopped.js\":\"d7772e12ef8c18e8\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/userActivity.js\":\"d356be29d0a381d7\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/viewTransition.js\":\"420ed40e61e26418\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/viewport.js\":\"987c558b56789004\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/webLock.js\":\"952cd5f7658efc8b\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/workspaceRecovery.js\":\"c76cbaaaf203dfda\",\"/knowledge-medium/pr-preview/pr-1881/src/utils/workspaceSnapshotStore.js\":\"9dff5de0ec304469\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-compiler-runtime.js\":\"1f204cb6eba3b67a\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom-client.js\":\"1fc445b8f51d52d6\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom-server-edge.js\":\"749d98979c198706\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom-server.js\":\"13703347c1a95d4b\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom-static-edge.js\":\"40aeb648dc9d5d64\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom-static.js\":\"ae2c2c10fd377db4\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom-test-utils.js\":\"a967fa5639d9de85\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-dom.js\":\"5229f4fe9d22ce44\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react-jsx-runtime.js\":\"312ac5f08f72b654\",\"/knowledge-medium/pr-preview/pr-1881/src/vendor/react.js\":\"941d6c6757d6be38\",\"/knowledge-medium/pr-preview/pr-1881/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1881/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1881/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
