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
		buildId: "5b089240efe7-33dbcdd6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1882/\":\"f780029859dd4776\",\"/knowledge-medium/pr-preview/pr-1882/index.html\":\"f780029859dd4776\",\"/knowledge-medium/pr-preview/pr-1882/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1882/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1882/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1882/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1882/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1882/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1882/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1882/assets/FacadeVFS-99kVmZO7.js\":\"426e7203f81affdc\",\"/knowledge-medium/pr-preview/pr-1882/assets/OPFSCoopSyncVFS-DO5OHV2T.js\":\"543a90148e1e1657\",\"/knowledge-medium/pr-preview/pr-1882/assets/OPFSWriteAheadVFS-B61smqnw.js\":\"bc0d536e7a48ba56\",\"/knowledge-medium/pr-preview/pr-1882/assets/wa-sqlite-CTZ0rPzG.js\":\"4d2e042217ea46bc\",\"/knowledge-medium/pr-preview/pr-1882/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1882/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1882/assets/wa-sqlite-async-BlZML6NF.js\":\"eacbbb29a28097e9\",\"/knowledge-medium/pr-preview/pr-1882/assets/worker-C6NS55m-.js\":\"b9a10c6d6bd81bce\",\"/knowledge-medium/pr-preview/pr-1882/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1882/chunks/app-B4ekowXz.js\":\"4041bdd099534b0f\",\"/knowledge-medium/pr-preview/pr-1882/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1882/index.js\":\"cba9bd78655c3345\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1882/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1882/assets/AccessHandlePoolVFS-B-wzmTPc.js\":\"36a8c6c7b382f861\",\"/knowledge-medium/pr-preview/pr-1882/assets/IDBBatchAtomicVFS-DxifNBEd.js\":\"4b4a458ec7123f6e\",\"/knowledge-medium/pr-preview/pr-1882/assets/MemoryVFS-BlikPfD-.js\":\"4edc0e0af9b304aa\",\"/knowledge-medium/pr-preview/pr-1882/assets/mc-wa-sqlite-Bpza7jpN.js\":\"788bef41efe2212c\",\"/knowledge-medium/pr-preview/pr-1882/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1882/assets/mc-wa-sqlite-async-Cyp7h6WK.js\":\"68560dd24b5b69e9\",\"/knowledge-medium/pr-preview/pr-1882/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1882/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1882/chunks/AccessHandlePoolVFS-SjTXT9La.js\":\"ec51ab085a000669\",\"/knowledge-medium/pr-preview/pr-1882/chunks/FacadeVFS-D7WRet9D.js\":\"cb16588071916fcd\",\"/knowledge-medium/pr-preview/pr-1882/chunks/IDBBatchAtomicVFS-DD-dRvo9.js\":\"65645eda5f251853\",\"/knowledge-medium/pr-preview/pr-1882/chunks/MemoryVFS-3E2saJKC.js\":\"9836711afc5d0f2f\",\"/knowledge-medium/pr-preview/pr-1882/chunks/OPFSCoopSyncVFS-D0bvl0_V.js\":\"abe0f8cab7bd9b49\",\"/knowledge-medium/pr-preview/pr-1882/chunks/OPFSWriteAheadVFS-IaHi3_jy.js\":\"4c959fa3f49fca62\",\"/knowledge-medium/pr-preview/pr-1882/chunks/Preview-I8RIrTmI.js\":\"8977edd1722410da\",\"/knowledge-medium/pr-preview/pr-1882/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1882/chunks/card-D4D5KG0j.js\":\"2d9177dd0bec79e1\",\"/knowledge-medium/pr-preview/pr-1882/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1882/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1882/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1882/chunks/dist-DTAOYhk3.js\":\"54ac82b71470f3f1\",\"/knowledge-medium/pr-preview/pr-1882/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1882/chunks/mc-wa-sqlite-CaZ4uKwX.js\":\"f9aa8ab7b770386c\",\"/knowledge-medium/pr-preview/pr-1882/chunks/mc-wa-sqlite-async-0bfMz7oE.js\":\"7338b37b12f51997\",\"/knowledge-medium/pr-preview/pr-1882/chunks/react-6x57j08k.js\":\"02bb9b1650a6e0bc\",\"/knowledge-medium/pr-preview/pr-1882/chunks/react-Bz22Df8y.js\":\"849f48368d5514a6\",\"/knowledge-medium/pr-preview/pr-1882/chunks/react-CREX56GN.js\":\"d25c2bd816d1dcdc\",\"/knowledge-medium/pr-preview/pr-1882/chunks/react-CwB-Iayr.js\":\"be93cf988457a5e9\",\"/knowledge-medium/pr-preview/pr-1882/chunks/react-CwjnTaVE.js\":\"9e9475e9357d11a5\",\"/knowledge-medium/pr-preview/pr-1882/chunks/react-DrQ5ftJc.js\":\"f013ab61105b0c2e\",\"/knowledge-medium/pr-preview/pr-1882/chunks/react-Dww9Ee5G.js\":\"13890f593554c1ad\",\"/knowledge-medium/pr-preview/pr-1882/chunks/react-dom-server-legacy.browser.production-BM0pWYgZ.js\":\"6232206516ecd851\",\"/knowledge-medium/pr-preview/pr-1882/chunks/react-dom-server.browser.production-CdLaB6nq.js\":\"e7b386aae468347a\",\"/knowledge-medium/pr-preview/pr-1882/chunks/react-dom-server.edge.production-C6fPajbt.js\":\"99a577543675e35e\",\"/knowledge-medium/pr-preview/pr-1882/chunks/react-s6663y-W.js\":\"5016758ba67bdd3e\",\"/knowledge-medium/pr-preview/pr-1882/chunks/server.browser-ccAoTCDo.js\":\"2e415c8b7711a390\",\"/knowledge-medium/pr-preview/pr-1882/chunks/textarea-hlglTh99.js\":\"c7ac1bc151ff8f9d\",\"/knowledge-medium/pr-preview/pr-1882/chunks/ui-bkzRPvX9.js\":\"a008df3ef54e96dd\",\"/knowledge-medium/pr-preview/pr-1882/chunks/wa-sqlite-async-CJJsugC1.js\":\"ba11883388fb96f4\",\"/knowledge-medium/pr-preview/pr-1882/chunks/wa-sqlite-h7hs_I8Q.js\":\"362cd95ea0db3042\",\"/knowledge-medium/pr-preview/pr-1882/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1882/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1882/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1882/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1882/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1882/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1882/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1882/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1882/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1882/src/App.js\":\"34482b0e376b4dfc\",\"/knowledge-medium/pr-preview/pr-1882/src/appUpdate.js\":\"9aeafd7ba3174547\",\"/knowledge-medium/pr-preview/pr-1882/src/appVersion.js\":\"1e0dbae51d1484ce\",\"/knowledge-medium/pr-preview/pr-1882/src/bootstrap/initialLayout.js\":\"9a94d41196afab1a\",\"/knowledge-medium/pr-preview/pr-1882/src/bootstrap/openWorkspaceData.js\":\"0c801a70ccbe75d3\",\"/knowledge-medium/pr-preview/pr-1882/src/bootstrap/resolveWorkspace.js\":\"ad59c7c33cfeabae\",\"/knowledge-medium/pr-preview/pr-1882/src/bootstrap/workspaceBootstrap.js\":\"73262bedec053982\",\"/knowledge-medium/pr-preview/pr-1882/src/components/BlockComponent.js\":\"48d2ad402916ee7d\",\"/knowledge-medium/pr-preview/pr-1882/src/components/BlockCrumbs.js\":\"08425161800dc5a4\",\"/knowledge-medium/pr-preview/pr-1882/src/components/BlockEditor.js\":\"b3e919eb47355f35\",\"/knowledge-medium/pr-preview/pr-1882/src/components/BlockLoadingPlaceholder.js\":\"84e01a4951781496\",\"/knowledge-medium/pr-preview/pr-1882/src/components/BlockProperties.js\":\"1f5191d43ae12099\",\"/knowledge-medium/pr-preview/pr-1882/src/components/BlockSearchPicker.js\":\"e43a83f879f2f6bf\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ConfirmBulkDeleteDialog.js\":\"79c220e8a36e1ed5\",\"/knowledge-medium/pr-preview/pr-1882/src/components/DividerHandle.js\":\"c8acfaa6f453526e\",\"/knowledge-medium/pr-preview/pr-1882/src/components/DraftEditor.js\":\"67c70e547958f3b4\",\"/knowledge-medium/pr-preview/pr-1882/src/components/GutterPill.js\":\"cd8be239f353e6fd\",\"/knowledge-medium/pr-preview/pr-1882/src/components/Header.js\":\"1d3555c7150fdeca\",\"/knowledge-medium/pr-preview/pr-1882/src/components/LazyBlockComponent.js\":\"c2d0c03464535986\",\"/knowledge-medium/pr-preview/pr-1882/src/components/Login.js\":\"f84d5ce1fd3e388b\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ZoomableSurface.js\":\"867d45c101181a83\",\"/knowledge-medium/pr-preview/pr-1882/src/components/editModeKeepalive.js\":\"6acafe0718005fea\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyDisplay/PropertyDisplayScope.js\":\"7dde017f51ed8e6c\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"792e7b5f93e4c246\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyEditors/RefPropertyEditor.js\":\"5eee0d63c2b0bc4d\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyEditors/RefTargetTypePicker.js\":\"ac66cc672e1ffe60\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyEditors/SelectPropertyEditor.js\":\"a0e515c3a574eabb\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyEditors/TypesPropertyEditor.js\":\"817994c8766e23c1\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyEditors/defaults.js\":\"1d55be85a09a0e91\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyEditors/kernelValuePresets.js\":\"2385396af1919e85\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyEditors/selectablePresets.js\":\"a896aac02ff6a859\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyEditors/typesPropertyUi.js\":\"3f896508d86340e6\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyPanel/AddPropertyForm.js\":\"053bd3564cfd721b\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyPanel/PropertyPicker.js\":\"ed1662c3607797d0\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyPanel/PropertyRow.js\":\"f8169e93a2a0b37b\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyPanel/Rows.js\":\"88be1bc39a9febd5\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyPanel/actions.js\":\"28c8019bfe74623c\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyPanel/declarationOnly.js\":\"0f3abecc1fb03456\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyPanel/layout.js\":\"c110db9a33aae81e\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyPanel/model.js\":\"da70c0e91f69070d\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyPanel/shapeUi.js\":\"ac7d16ae36c87f2c\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyPanel/shapes.js\":\"c3eb554e8c07ad8d\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ac1eaffe8f5fd932\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyPanel/visibility.js\":\"07ef74bef8f03ca1\",\"/knowledge-medium/pr-preview/pr-1882/src/components/propertyPanelSections.js\":\"0e7f4d147d5b7203\",\"/knowledge-medium/pr-preview/pr-1882/src/components/references/BlockEmbed.js\":\"5c5b96650c596a4f\",\"/knowledge-medium/pr-preview/pr-1882/src/components/references/BlockLink.js\":\"9ed9ebc57b49ef34\",\"/knowledge-medium/pr-preview/pr-1882/src/components/references/BlockRef.js\":\"e850b3b28986f2f2\",\"/knowledge-medium/pr-preview/pr-1882/src/components/references/ReferenceLink.js\":\"bb1e558840c6a920\",\"/knowledge-medium/pr-preview/pr-1882/src/components/references/cycleGuard.js\":\"5bf98afa9d7ea7f5\",\"/knowledge-medium/pr-preview/pr-1882/src/components/references/cycleGuardContext.js\":\"332b77d93befe51c\",\"/knowledge-medium/pr-preview/pr-1882/src/components/references/linkInteraction.js\":\"4d0d069cc787ecc7\",\"/knowledge-medium/pr-preview/pr-1882/src/components/references/referenceLayout.js\":\"9f16ffdd1a4e61e8\",\"/knowledge-medium/pr-preview/pr-1882/src/components/references/useBlockRefAncestors.js\":\"983805e6c2073948\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/BlockGutter.js\":\"82c7ce6ec12b3edc\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/BlockInfoDialog.js\":\"497aa92582937f55\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/BlockTypeBlockRenderer.js\":\"6763cb01cbc524db\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/BulletHoverCard.js\":\"1ed7571d2b12b9a6\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/CodeMirrorContentRenderer.js\":\"25f20a3d4fa264da\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7e2814ae9b86e303\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/ColumnResizeHandles.js\":\"0a347d4b34113b48\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e482be36ce0cf4b8\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/DefaultBlockRenderer.js\":\"51a44277650f7fb9\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/LayoutRenderer.js\":\"6d86c0272cf1cba7\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/MarkdownContentRenderer.js\":\"2f169f179ba0e158\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/MissingDataRenderer.js\":\"12cbabd3a5008393\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/PanelRenderer.js\":\"a6ae5732cca64d7f\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/PropertySchemaBlockRenderer.js\":\"828493e715623202\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/TopLevelRenderer.js\":\"93bc0be661814a93\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/blockGutterMode.js\":\"c47154ff0caed622\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/blockTitleText.js\":\"2b1514132b94bc87\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/fieldCreationKeydown.js\":\"a57e78128c3cffe0\",\"/knowledge-medium/pr-preview/pr-1882/src/components/renderer/layoutRootContext.js\":\"2f9976623b67a147\",\"/knowledge-medium/pr-preview/pr-1882/src/components/typeChip/TypeChip.js\":\"49921dd064d72b67\",\"/knowledge-medium/pr-preview/pr-1882/src/components/typeChip/chipStyle.js\":\"15228dda0d5e0528\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/anchored-floating.js\":\"4e4dac3e9572356a\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/button.js\":\"fa1a268f48e7d0f5\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/card.js\":\"63a53b6ae4461615\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/checkbox.js\":\"c0b831e8e53e2e0c\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/collapsible.js\":\"a4c09751bb8abef5\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/command.js\":\"487d3a0168e409b1\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/context-menu.js\":\"8b9d126b887acf40\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/dialog.js\":\"21f2b9e886b9224a\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/dropdown-menu.js\":\"9a3a18b29a589f64\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/floating-listbox.js\":\"2802cffb21d7f887\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/index.js\":\"e2600b6fdf0d951a\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/input.js\":\"6a7ddfbe553a2073\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/kbd.js\":\"775c1b3630c1414d\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/label.js\":\"20b050a86cce5947\",\"/knowledge-medium/pr-preview/pr-1882/src/components/ui/textarea.js\":\"01c58698f825126e\",\"/knowledge-medium/pr-preview/pr-1882/src/components/useEditModeYieldKeepalive.js\":\"e11eab7e7ab375bb\",\"/knowledge-medium/pr-preview/pr-1882/src/components/util/BootFallback.js\":\"51aae91cb5411110\",\"/knowledge-medium/pr-preview/pr-1882/src/components/util/FocusedRowLazyMount.js\":\"2d6b2435fd502fa4\",\"/knowledge-medium/pr-preview/pr-1882/src/components/util/LazyViewportMount.js\":\"c4405780bd2cac01\",\"/knowledge-medium/pr-preview/pr-1882/src/components/util/LocalDbCorruptionFallback.js\":\"07a9e9fedb804dfe\",\"/knowledge-medium/pr-preview/pr-1882/src/components/util/error.js\":\"7c4407ee3d1c1e69\",\"/knowledge-medium/pr-preview/pr-1882/src/components/util/lazyMountRegistry.js\":\"7408fe8c596ec772\",\"/knowledge-medium/pr-preview/pr-1882/src/components/util/suspense.js\":\"9772f1f3d8c17278\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/CreateWorkspaceDialog.js\":\"dba54025c492678f\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/PendingInvitations.js\":\"945bea29e830438b\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/SyncProgress.js\":\"958b8ae4ac0d5041\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/UnlockProgress.js\":\"f70d0d5f9fc0a09d\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/WorkspaceKeyGate.js\":\"8cb5ce44439a1807\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/WorkspaceSettingsDialog.js\":\"d809043d3f740174\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/WorkspaceSwitcher.js\":\"270c52316ace0cef\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/WorkspaceSyncGate.js\":\"d5b7983b961074f2\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/conversion/ConversionFlow.js\":\"b4343197567688fb\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/conversion/ConversionFlowHost.js\":\"d5b8850691104ac5\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/conversion/EncryptionSection.js\":\"0f2c90a165cb053e\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/conversion/attachmentPrompts.js\":\"b15c251bebcddc03\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d5244cb6843c03c4\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/conversion/conversionFlowDeps.js\":\"ff993f96dab83dc0\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/conversion/conversionFlowStore.js\":\"ae23a4da7d3b6585\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/conversion/flowUi.js\":\"4678a81058e55c0c\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/conversion/useConversionRun.js\":\"aaa5be48da075dd0\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/keyUi.js\":\"9acd7d8a000dd101\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/useCloseOnKeyLoss.js\":\"7ee08ed198337279\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/useCloseOnServerE2ee.js\":\"710729842a1b5479\",\"/knowledge-medium/pr-preview/pr-1882/src/components/workspace/workspaceUnlocked.js\":\"2f98a31b4264aff8\",\"/knowledge-medium/pr-preview/pr-1882/src/context/backgroundSubtree.js\":\"21c1d9752cf239a6\",\"/knowledge-medium/pr-preview/pr-1882/src/context/block.js\":\"f8ff535d0c8b8dd9\",\"/knowledge-medium/pr-preview/pr-1882/src/context/layoutWsContext.js\":\"da431cf9675bdd2d\",\"/knowledge-medium/pr-preview/pr-1882/src/context/propertyDisplay.js\":\"95624047e6a6f103\",\"/knowledge-medium/pr-preview/pr-1882/src/context/repo.js\":\"2887d02c88fccfa3\",\"/knowledge-medium/pr-preview/pr-1882/src/data/aliasClaim.js\":\"cb6bdc690de9a067\",\"/knowledge-medium/pr-preview/pr-1882/src/data/aliasSeatNamespace.js\":\"efa8fd1a088d13da\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/blockData.js\":\"30494dea03e70308\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/blockType.js\":\"a8ce19f745a6d907\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/changeScope.js\":\"7e59612915dd7f0c\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/codecs.js\":\"b92a50c68b43c462\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/derivedData.js\":\"7c1b2b996f30e036\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/errors.js\":\"44cf5a32523c762d\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/events.js\":\"0e6ffbea9249c8bd\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/handle.js\":\"c185f404d6a0081a\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/index.js\":\"53dfd668a11bc264\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/mutator.js\":\"8d18a357f02a5827\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/processor.js\":\"0a15eb6994d09559\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/propertySchema.js\":\"a35f14d914dbe14d\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/query.js\":\"3816907f0fc9b4f6\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/sameTxProcessor.js\":\"41f2c4e5e4dbbf58\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/schema.js\":\"c185f404d6a0081a\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/tx.js\":\"c185f404d6a0081a\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/typedBlockQuery.js\":\"bdd2ae04a78c9ad3\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/user.js\":\"30fb0ff4fc953f59\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/valuePresetCore.js\":\"d6aa1644063e4f11\",\"/knowledge-medium/pr-preview/pr-1882/src/data/api/valuePresets.js\":\"8c6554b96b8c7abf\",\"/knowledge-medium/pr-preview/pr-1882/src/data/attachmentCleanerIOVerb.js\":\"a5c4e7371458737b\",\"/knowledge-medium/pr-preview/pr-1882/src/data/block.js\":\"6b82a60a232c4c0c\",\"/knowledge-medium/pr-preview/pr-1882/src/data/blockCache.js\":\"679d0e47e942abc9\",\"/knowledge-medium/pr-preview/pr-1882/src/data/blockId.js\":\"0bf8ac602b278ca6\",\"/knowledge-medium/pr-preview/pr-1882/src/data/blockLiveness.js\":\"082708e63d07e9e2\",\"/knowledge-medium/pr-preview/pr-1882/src/data/blockMerge.js\":\"71add25f16ce325f\",\"/knowledge-medium/pr-preview/pr-1882/src/data/blockSchema.js\":\"3c59cd8ec8d89f9e\",\"/knowledge-medium/pr-preview/pr-1882/src/data/blockTypeLookup.js\":\"fcbfb78bf547dea6\",\"/knowledge-medium/pr-preview/pr-1882/src/data/blockTypes.js\":\"356902c788d36840\",\"/knowledge-medium/pr-preview/pr-1882/src/data/childrenView.js\":\"160760e105eb63d8\",\"/knowledge-medium/pr-preview/pr-1882/src/data/clientContext.js\":\"3403b4f5166507f7\",\"/knowledge-medium/pr-preview/pr-1882/src/data/dbFileSiblings.js\":\"9728619938e723c0\",\"/knowledge-medium/pr-preview/pr-1882/src/data/definitionSeeds.js\":\"e8cf24a7fd79d6fe\",\"/knowledge-medium/pr-preview/pr-1882/src/data/derivedIds.js\":\"5393bf32260b8887\",\"/knowledge-medium/pr-preview/pr-1882/src/data/drawnSubtree.js\":\"08d8f1c726ade50a\",\"/knowledge-medium/pr-preview/pr-1882/src/data/facetBridge.js\":\"d11fe1cbf65d1cef\",\"/knowledge-medium/pr-preview/pr-1882/src/data/facets.js\":\"93b66ae7713788ba\",\"/knowledge-medium/pr-preview/pr-1882/src/data/globalState.js\":\"be2e422cbb51ac5d\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/aliasClaimRederiveProcessor.js\":\"3c2950311e99d906\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/ancestorBatch.js\":\"1b5fef07875af624\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/blockTypeTypeifyProcessor.js\":\"534e7ee472ae071f\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/clientSchema.js\":\"14184efb4cef63ea\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/commitPipeline.js\":\"dc3f7f7265b712f7\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/devAssertions.js\":\"3f1a01f21db0bd3c\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/firstSync.js\":\"8fe39eb88c0245dc\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/freshInitialLoad.js\":\"f61f4ba7685cdf10\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/graphBackfillClaim.js\":\"8f99cde455cb9e8f\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/handleStore.js\":\"994de734b290d095\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/idleMarkerJobs.js\":\"4147cdb37f934e26\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/initialDownload.js\":\"bd23caba456bb6e7\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/initializeClientDatabase.js\":\"d11f6ebe3cd5a585\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/jsonCanonical.js\":\"5468b157221e8a4e\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/kernelInvalidation.js\":\"a4e8fecc96d63d49\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/kernelProcessors.js\":\"0cde0b4f86d5c8eb\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/kernelQueries.js\":\"92ed3d4b92c40ae3\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/mergeTypeMembershipProcessor.js\":\"5cefd003cfc52424\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/normalizeReferencesProcessor.js\":\"b7518e193583f4c3\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/poolInstrumentation.js\":\"8ba9c312c7a51a52\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/processorRunner.js\":\"6b9500519d30b8cb\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/propertyCellBackfill.js\":\"db360a4f27503830\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/propertyChildMint.js\":\"ca94c044611f8cdd\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/propertyChildrenProcessor.js\":\"e9fe092b9b3db45a\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/propertyDefinitionChangeProcessor.js\":\"d2fac4a62240819c\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/propertyDefinitionSynthesis.js\":\"cbd949e49d8090cb\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/propertyKeyScan.js\":\"b069e28062c7217a\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/propertySchemaResolution.js\":\"49402b02c4d085de\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/propertyValueEdits.js\":\"e1a066eeb8433eb6\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/raiseProtocol.js\":\"ea82213a2c801961\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/readBatch.js\":\"eab5598e271a3dd9\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/refProjection.js\":\"0b50fea37d3e1775\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/referenceTargetLookups.js\":\"19e0c7e937b3c137\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/referenceTargetProcessor.js\":\"b889820d4f0cae7c\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/replayMerge.js\":\"ea22dc5521382452\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/sqlBinds.js\":\"5e538fc0ba4aee1e\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"09efd58ed9eb8673\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/syncObserver/arrivalProcessors.js\":\"ec1faf1d6ea9854b\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/syncObserver/invalidate.js\":\"f6239b7270eea275\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/syncObserver/materialize.js\":\"25bc20aa44e2af96\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/syncObserver/observer.js\":\"04e84cad49e01b6d\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/syncObserver/reconcile.js\":\"9b58873f8b6f7a8b\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/timingMetrics.js\":\"20ac6465f8f5a856\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/treeQueries.js\":\"003b99d021416a4d\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/txEngine.js\":\"2075959ed408251c\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/txSnapshots.js\":\"5e9f8103b2ebeec0\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/typedBlockQuery.js\":\"8e1246755034ace1\",\"/knowledge-medium/pr-preview/pr-1882/src/data/internals/undoManager.js\":\"a871133400ba0fcb\",\"/knowledge-medium/pr-preview/pr-1882/src/data/invalidation.js\":\"8648af931007bb6f\",\"/knowledge-medium/pr-preview/pr-1882/src/data/kernelDataExtension.js\":\"bef5c76bc0271d9a\",\"/knowledge-medium/pr-preview/pr-1882/src/data/kernelPage.js\":\"e9a5e3703a63e963\",\"/knowledge-medium/pr-preview/pr-1882/src/data/kernelValuePresetCores.js\":\"6d393d2943031230\",\"/knowledge-medium/pr-preview/pr-1882/src/data/localDbCorruptionSignal.js\":\"06e5e43060e59300\",\"/knowledge-medium/pr-preview/pr-1882/src/data/localDbStorage.js\":\"c1a1ec5cbae47f35\",\"/knowledge-medium/pr-preview/pr-1882/src/data/localDbVfs.js\":\"60ca42fa1f6775a1\",\"/knowledge-medium/pr-preview/pr-1882/src/data/localSchema.js\":\"cb5877a30f6290e2\",\"/knowledge-medium/pr-preview/pr-1882/src/data/maintenance.js\":\"4fecd76f15455f93\",\"/knowledge-medium/pr-preview/pr-1882/src/data/mergeProperties.js\":\"1abfb1eb098ae094\",\"/knowledge-medium/pr-preview/pr-1882/src/data/metricsConsoleHook.js\":\"102147b83bd582e6\",\"/knowledge-medium/pr-preview/pr-1882/src/data/migrationsPage.js\":\"bc2cd163bcda247c\",\"/knowledge-medium/pr-preview/pr-1882/src/data/mutators.js\":\"4a85785a0b1d4bfa\",\"/knowledge-medium/pr-preview/pr-1882/src/data/orderKey.js\":\"97156a8847ad600f\",\"/knowledge-medium/pr-preview/pr-1882/src/data/orderKeyPlacement.js\":\"cf55edce2044ed2c\",\"/knowledge-medium/pr-preview/pr-1882/src/data/outlineSurface.js\":\"68441b36342677b0\",\"/knowledge-medium/pr-preview/pr-1882/src/data/pendingEditorContent.js\":\"830ca1a305c13fe8\",\"/knowledge-medium/pr-preview/pr-1882/src/data/pendingUploadsSql.js\":\"2aa06588e4d6a9be\",\"/knowledge-medium/pr-preview/pr-1882/src/data/pluginStateExtensions.js\":\"fd22196e3118f49d\",\"/knowledge-medium/pr-preview/pr-1882/src/data/powerSyncLogger.js\":\"3f1caf771581c6bd\",\"/knowledge-medium/pr-preview/pr-1882/src/data/projectorRuntime.js\":\"c6fb8f25e89ab067\",\"/knowledge-medium/pr-preview/pr-1882/src/data/properties.js\":\"d20c57f9d92b0f01\",\"/knowledge-medium/pr-preview/pr-1882/src/data/propertiesPage.js\":\"5e4ed6936760d874\",\"/knowledge-medium/pr-preview/pr-1882/src/data/propertyChildren.js\":\"df6b7f9d26e6685b\",\"/knowledge-medium/pr-preview/pr-1882/src/data/propertyDefinitionFanout.js\":\"11f08ec787dc43eb\",\"/knowledge-medium/pr-preview/pr-1882/src/data/propertyDefinitionMetadata.js\":\"c3e30d1a7062d20a\",\"/knowledge-medium/pr-preview/pr-1882/src/data/propertyDefinitionRegistry.js\":\"c37be72aa84f7525\",\"/knowledge-medium/pr-preview/pr-1882/src/data/propertyDisplayMode.js\":\"726e146cd74f36ee\",\"/knowledge-medium/pr-preview/pr-1882/src/data/propertyRowCreation.js\":\"399f03b88d264b7b\",\"/knowledge-medium/pr-preview/pr-1882/src/data/propertySchemaCreation.js\":\"736fe0999f1cd5c6\",\"/knowledge-medium/pr-preview/pr-1882/src/data/propertySeeds.js\":\"cf7c23d8ed2a2fa6\",\"/knowledge-medium/pr-preview/pr-1882/src/data/recentsPage.js\":\"5bb6e26913c9ad5b\",\"/knowledge-medium/pr-preview/pr-1882/src/data/refTargetComparableProperty.js\":\"1a50fd1bf9d62023\",\"/knowledge-medium/pr-preview/pr-1882/src/data/referenceBlock.js\":\"e69fe127b232024f\",\"/knowledge-medium/pr-preview/pr-1882/src/data/rejectedUploads.js\":\"0cfbcab9dea9fc29\",\"/knowledge-medium/pr-preview/pr-1882/src/data/releasePowerSyncConnection.js\":\"d24aca660c45c8fa\",\"/knowledge-medium/pr-preview/pr-1882/src/data/repo.js\":\"de74860f81794d9b\",\"/knowledge-medium/pr-preview/pr-1882/src/data/repoProvider.js\":\"fc284dbb42ae3f66\",\"/knowledge-medium/pr-preview/pr-1882/src/data/rowProperty.js\":\"4526d487907c5651\",\"/knowledge-medium/pr-preview/pr-1882/src/data/searchFilter.js\":\"2ced2370c306f062\",\"/knowledge-medium/pr-preview/pr-1882/src/data/seedIdentityLedger.js\":\"aabd5a1b2ea51f7f\",\"/knowledge-medium/pr-preview/pr-1882/src/data/stateBlocks.js\":\"a1c83f05e000435f\",\"/knowledge-medium/pr-preview/pr-1882/src/data/structuralEditPolicy.js\":\"f2f4852faf1f1246\",\"/knowledge-medium/pr-preview/pr-1882/src/data/structuralInsert.js\":\"dd809386b0659815\",\"/knowledge-medium/pr-preview/pr-1882/src/data/subtreeDelete.js\":\"28deb3ef3448a997\",\"/knowledge-medium/pr-preview/pr-1882/src/data/syncStreamLock.js\":\"f4fdcf8321196df9\",\"/knowledge-medium/pr-preview/pr-1882/src/data/syncedTableSqlRecognizer.js\":\"4dec980eefdbb9ab\",\"/knowledge-medium/pr-preview/pr-1882/src/data/syncedTableWriteGuard.js\":\"59a1dc8536b2faa2\",\"/knowledge-medium/pr-preview/pr-1882/src/data/targets.js\":\"215a835a1847db28\",\"/knowledge-medium/pr-preview/pr-1882/src/data/typeColors.js\":\"c1efc63ca4a60042\",\"/knowledge-medium/pr-preview/pr-1882/src/data/typeDefinitionMetadata.js\":\"cd40fae0850e91f0\",\"/knowledge-medium/pr-preview/pr-1882/src/data/typeDefinitionRegistry.js\":\"b5951f27c1639f72\",\"/knowledge-medium/pr-preview/pr-1882/src/data/typeExtraction.js\":\"7a60f264fb2296c8\",\"/knowledge-medium/pr-preview/pr-1882/src/data/typeInitialValues.js\":\"c60a4834a16d34b8\",\"/knowledge-medium/pr-preview/pr-1882/src/data/typePropertyGroups.js\":\"d58e96fe8ce5be72\",\"/knowledge-medium/pr-preview/pr-1882/src/data/typeSeeds.js\":\"bb2120dfd15bdf83\",\"/knowledge-medium/pr-preview/pr-1882/src/data/typeTagger.js\":\"86e91ee3946cd09a\",\"/knowledge-medium/pr-preview/pr-1882/src/data/typedRecords.js\":\"f90a46c78d540aa4\",\"/knowledge-medium/pr-preview/pr-1882/src/data/typesPage.js\":\"dbdcd48e152794fb\",\"/knowledge-medium/pr-preview/pr-1882/src/data/userPrefs.js\":\"b5b0ea274847b336\",\"/knowledge-medium/pr-preview/pr-1882/src/data/userSchemasService.js\":\"3e267955f60026a4\",\"/knowledge-medium/pr-preview/pr-1882/src/data/userTypesService.js\":\"78554f99f815e4c7\",\"/knowledge-medium/pr-preview/pr-1882/src/data/valuePresetRegistry.js\":\"f83bf3cf72c9a9e9\",\"/knowledge-medium/pr-preview/pr-1882/src/data/visibleChildren.js\":\"4c41c5a53e204cd8\",\"/knowledge-medium/pr-preview/pr-1882/src/data/workspaceConversion.js\":\"a604f38333e337c9\",\"/knowledge-medium/pr-preview/pr-1882/src/data/workspaceFirstSync.js\":\"323a241a88f1b265\",\"/knowledge-medium/pr-preview/pr-1882/src/data/workspaceIdNamespace.js\":\"c3a45412e55c302b\",\"/knowledge-medium/pr-preview/pr-1882/src/data/workspaceSchema.js\":\"04dfc4f2095397e9\",\"/knowledge-medium/pr-preview/pr-1882/src/data/workspaces.js\":\"366fafb5c1e09a98\",\"/knowledge-medium/pr-preview/pr-1882/src/data/writeAheadLog.js\":\"7f7d6af556d9a6d4\",\"/knowledge-medium/pr-preview/pr-1882/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1882/src/editor/BlockPasteShellDecorator.js\":\"a8684063e06572a9\",\"/knowledge-medium/pr-preview/pr-1882/src/editor/atTrigger.js\":\"8829c589adaa9dfe\",\"/knowledge-medium/pr-preview/pr-1882/src/editor/autocomplete.js\":\"5f669fa1ced81400\",\"/knowledge-medium/pr-preview/pr-1882/src/editor/codeMirrorExtensions.js\":\"f17890e08c96bff9\",\"/knowledge-medium/pr-preview/pr-1882/src/editor/contentFlush.js\":\"9ec6ae3c271c5031\",\"/knowledge-medium/pr-preview/pr-1882/src/editor/defaultInteractions.js\":\"ec22656739d0d82a\",\"/knowledge-medium/pr-preview/pr-1882/src/editor/editSettleSignal.js\":\"b60cd259a109a9a1\",\"/knowledge-medium/pr-preview/pr-1882/src/editor/insertImage.js\":\"904b7ddcd65d9c0c\",\"/knowledge-medium/pr-preview/pr-1882/src/editor/referenceCompletionRange.js\":\"c4c4104ef55cc523\",\"/knowledge-medium/pr-preview/pr-1882/src/editor/referenceTargetTypes.js\":\"313da2925b51d121\",\"/knowledge-medium/pr-preview/pr-1882/src/editor/syntaxContext.js\":\"0c22eef158999aa7\",\"/knowledge-medium/pr-preview/pr-1882/src/editor/triggerMatch.js\":\"e3f03bf7b27a4903\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/AppRuntimeProvider.js\":\"08cb0800c3fbbfab\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/BlockFocusShellDecorator.js\":\"11dd6e9c7c1c354e\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/ExtensionRenderBoundary.js\":\"c273a256a8ac7645\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/PanelContentRecovery.js\":\"be58d621d2ac2ad5\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/apiCatalog.js\":\"72471702be6ae434\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/approveExtensionHere.js\":\"0bc79e7d29dfdda5\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/armedCutAppMount.js\":\"8961d19e844308f1\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/batchableKeyedStore.js\":\"653c3648ae057cc7\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/blockInteraction.js\":\"479f3b1cb5fc3cf5\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/blockSelectionAction.js\":\"3cf836177360ad18\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/compileExtensionModule.js\":\"ac9020cbd3f3e681\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/compiledModuleCache.js\":\"00d23af11ef8f22c\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/continuousGestures.js\":\"96b471273f844d18\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/core.js\":\"e2065c4869846907\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/defaultRenderers.js\":\"6e499a65f3d6ef07\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/definitionFanoutAppMount.js\":\"d8e66dad69dd4326\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/dialogAppMount.js\":\"c17e03c6aa2d109f\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/dynamicExtensionSeeds.js\":\"47c90eab56b675cf\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/dynamicExtensions.js\":\"ac7929530d57b3c5\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/exampleExtensions.js\":\"3cf081d183c2e02d\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/extensionApprovalStatus.js\":\"693e4f911299309a\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/extensionLoadErrorToast.js\":\"9e8453d64a98c25a\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/extensionLoadErrors.js\":\"5b33954b6b226ebe\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/extensionLookup.js\":\"89e7b53818f1e559\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/extensionToggles.js\":\"51771ef001e3071e\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/extensionUtilitiesCss.js\":\"f0bdc414011abf22\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/kernelPageDeletionGuard.js\":\"39613b8b1c170571\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/liveRuntime.js\":\"624ef37f61cd026b\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/openExtensionsSettings.js\":\"fb9bdf4919b8315c\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/overridesCache.js\":\"59102156ef936b4e\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/pluginIds.js\":\"d00831d230242b71\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/processorRejectionToast.js\":\"034b848e431541ab\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/runtimeActions.js\":\"da558b0aeb2807ca\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/runtimeContext.js\":\"d529108906540ad0\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/staticAppExtensions.js\":\"bc74743163f52eb0\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/staticDataExtensions.js\":\"2c56e43714439ebf\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/toastAppMount.js\":\"dcaf25e98c03f14a\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/useOverrides.js\":\"bf91b07f2a81fec6\",\"/knowledge-medium/pr-preview/pr-1882/src/extensions/useShortcutSurfaceActivations.js\":\"16fa9041843db1df\",\"/knowledge-medium/pr-preview/pr-1882/src/facets/discoverToggleTree.js\":\"e255fe3b0409ab2c\",\"/knowledge-medium/pr-preview/pr-1882/src/facets/facet.js\":\"3aa8f7843f9a279b\",\"/knowledge-medium/pr-preview/pr-1882/src/facets/resolveAppRuntime.js\":\"01ccb603e1806214\",\"/knowledge-medium/pr-preview/pr-1882/src/facets/runtimeEvents.js\":\"a5ff9d4bc5f1afee\",\"/knowledge-medium/pr-preview/pr-1882/src/facets/togglable.js\":\"47364b95ccd6c82b\",\"/knowledge-medium/pr-preview/pr-1882/src/facets/variantFacet.js\":\"b0a7c49f980530e4\",\"/knowledge-medium/pr-preview/pr-1882/src/facets/verbFacet.js\":\"9cd326c3fb4b3d21\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/block.js\":\"c6ba204e0ec6b2c3\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/focusedChild.js\":\"fe10a294cf791df2\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/propertySchemas.js\":\"6b8759e164a5274c\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/typeRegistry.js\":\"b8b7bb89c582cd0e\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/useAncestorCrumbs.js\":\"6c1051386d7c6127\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/useAutocompleteListbox.js\":\"25ea36db3297ebbf\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/useDebouncedSearch.js\":\"2b86d07261d7a3b6\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/useDebouncedValue.js\":\"885e0625932ddb8f\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/useFacetValue.js\":\"9e29f5f2108c5a6b\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/useIsFocalRender.js\":\"b1df805149e2dd90\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/useIsReadOnly.js\":\"12a0847a29bfed36\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/useMaterializeBacklog.js\":\"5cfd9a8871d9a503\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/useMinuteClock.js\":\"c02515d328f7f456\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/usePanelLayoutProjection.js\":\"6d450829a5daad77\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/usePendingInvitations.js\":\"cb1cbe3adeed28f7\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/useRendererRegistry.js\":\"d5db2672acca7944\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/useRetainedFieldRows.js\":\"c080697654fcd487\",\"/knowledge-medium/pr-preview/pr-1882/src/hooks/useWorkspaces.js\":\"6a95260b236e768e\",\"/knowledge-medium/pr-preview/pr-1882/src/lib/utils.js\":\"1560518091ba68bb\",\"/knowledge-medium/pr-preview/pr-1882/src/main.js\":\"3e1f337150fb7371\",\"/knowledge-medium/pr-preview/pr-1882/src/markdown/MarkdownImage.js\":\"a0cd154bc8a17ea1\",\"/knowledge-medium/pr-preview/pr-1882/src/markdown/blockSeparators.js\":\"d3a239efe16e8488\",\"/knowledge-medium/pr-preview/pr-1882/src/markdown/context.js\":\"e6b15156505e0f33\",\"/knowledge-medium/pr-preview/pr-1882/src/markdown/defaultMarkdownExtension.js\":\"b79a67c826067f06\",\"/knowledge-medium/pr-preview/pr-1882/src/markdown/extensions.js\":\"7cbd5ff19433ad8e\",\"/knowledge-medium/pr-preview/pr-1882/src/markdown/renderMarkdownHtml.js\":\"37cee24316250171\",\"/knowledge-medium/pr-preview/pr-1882/src/minimal-editor.js\":\"628bd0e6710b9d9f\",\"/knowledge-medium/pr-preview/pr-1882/src/paste/armedCut.js\":\"06e5d6613413a2a0\",\"/knowledge-medium/pr-preview/pr-1882/src/paste/captureMediaVerb.js\":\"6930d86edf4a34bc\",\"/knowledge-medium/pr-preview/pr-1882/src/paste/clipboard.js\":\"adfdb5bae2a37e04\",\"/knowledge-medium/pr-preview/pr-1882/src/paste/decision.js\":\"c0d286de27d67e1f\",\"/knowledge-medium/pr-preview/pr-1882/src/paste/operations.js\":\"9d205e3940a456db\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/account-header/AccountHeaderItem.js\":\"715c75caa471ccca\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/account-header/index.js\":\"bed97d92d7142ac9\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5d2ca4ad8dfa71e0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-dispatch-companion/askAgent.js\":\"95cd81971cd5c1cc\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-dispatch-companion/askedStore.js\":\"b7a15ae23dd1b935\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"c561a7a2df4db337\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-dispatch-companion/chipState.js\":\"b090eb180d4c5821\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-dispatch-companion/dataExtension.js\":\"b360a82c28230989\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-dispatch-companion/index.js\":\"ff517dd79d11137c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"3857b8fccea6a0a4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-dispatch-companion/schema.js\":\"5f05d675cbf72eee\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/AgentTokensDialog.js\":\"010a301418ec52ed\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/BridgePairingDialog.js\":\"17944dcc782faf7d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/addMedia.js\":\"27c8c56f728e6fc4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentViews/backlinks.js\":\"d15eb1bc82654062\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentViews/block.js\":\"3144954d525db6ba\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentViews/context.js\":\"9b940a955b5d3a3b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5bb493299a9bdc41\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentViews/index.js\":\"b9faa5a0b02e118b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentViews/outline.js\":\"5178dab1ceba85d2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentViews/properties.js\":\"a3750473116ada36\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentViews/refs.js\":\"519146d3d3277a17\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"12c5a794cc517c4e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentViews/search.js\":\"e46706a30a831494\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentViews/shared.js\":\"bd0908a7db95634b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c8139eca777f0603\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentViews/text.js\":\"8a65ddc714867332\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/agentWrites.js\":\"488ce324866f2c8a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/authoringCatalog.js\":\"df0fde3eaa867920\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/blockRefTargets.js\":\"b4c377a246d5db45\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/bridge.js\":\"5224f235a487cc19\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/bridgeLoop.js\":\"12f73c4a6e0d4534\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/changeHistory.js\":\"3353794a4b2bc454\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/commands.js\":\"f682bede1e4118ec\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/commentsCommands.js\":\"22691e27bb215ae5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/dataExtension.js\":\"09fd58e029fec44e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/dataModelGuide.js\":\"54de2e73e2fe4cf4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/dayPropertyInputs.js\":\"ec5d3615a0b6cd1d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/describeRuntime.js\":\"3e08b28f729d1009\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/extensionLint.js\":\"bd336dce08818b65\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/grainAudit.js\":\"638807bbf8e51dee\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/healthCommand.js\":\"79b2dbc5262788b5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/index.js\":\"45bc943612bd7a4c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/presetIdentity.js\":\"c136175bc678bf03\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"6fcddb702273e117\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/readMedia.js\":\"40bc1e04ae3a72a4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/schema.js\":\"80063741507c2390\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/serialization.js\":\"921a8967dc54f73b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/targets.js\":\"9f4921f912d84d62\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/tokens.js\":\"21e67c0e80cd53ae\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/watchEvents.js\":\"dedb71fad5f56f34\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/workspaceGuard.js\":\"1f866c64c2cee994\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/agent-runtime/writeCommands.js\":\"855b6e00d2f1a90f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/alias/AliasCollisionToast.js\":\"4d07d1272b6f80f5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/alias/DuplicateNameBanner.js\":\"634b0af6ef373a3f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/alias/collisionMerge.js\":\"3de72ca0050fc0b9\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/alias/dataExtension.js\":\"9f864e346971c4e5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/alias/index.js\":\"0cc4e69d99c12b63\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/alias/mergeCollisionAction.js\":\"d9166c354a61b23e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/alias/pageStyling.js\":\"7ab2e98020b1446c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/alias/rejectionToast.js\":\"5ba0a3e11b41b7f1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/alias/syncProcessor.js\":\"a582cda7ab3d1636\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/actions.js\":\"0519854fb78ab319\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/addComment.js\":\"49e751c3ba9158eb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/anchor.js\":\"c0ef3cb6a89ac61e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/anchorState.js\":\"cc48da92d878cf4a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/commentLinks.js\":\"3575b3eb322997ae\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/confirmThreadDeletion.js\":\"aac007d39d770703\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/container.js\":\"d1f4c0cab5a8317e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/dataExtension.js\":\"0b5133ee3b843a62\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/deleteComment.js\":\"fb8c2380aefccfa6\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/highlights.js\":\"b29a38a7f060e052\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/index.js\":\"03bbbd91e94602a4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/linkedCommentsPill.js\":\"07fe64f07e10895b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/margin.js\":\"54dbbe8a1d37b30c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/marginAnchorLinks.js\":\"9a268e305ef64212\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/marginSchema.js\":\"ef6631392d19df91\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/newComment.js\":\"4cf290ce8a85fa93\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/ownThreadPicker.js\":\"009568bd3438ab6f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/placement.js\":\"f994bdb25ebd1863\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/queries.js\":\"677e3bf0a5278c96\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/quotePosition.js\":\"2f753597233240a6\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/quotedIn.js\":\"f128905f81285e31\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/quotedRange.js\":\"5613be606b59c1b5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/rangeRefs.js\":\"03a6e8455a09e1ce\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/readHighlights.js\":\"94e57ab43fad5013\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/readSelection.js\":\"b0d6b8ed1611004b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/readSelectionUi.js\":\"fd169908717ca292\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/reanchor.js\":\"d852692c32ffee1a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/schema.js\":\"0eb3fd9aa02de992\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/scope.js\":\"fd7a5bbcbc48b5f2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/scopeThreads.js\":\"684f98324132b8de\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/splitRetarget.js\":\"92ff44e95aa15e9e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/suggestionCard.js\":\"30fa8f070ea342d8\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/suggestions.js\":\"477efc1ed84caac8\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/summaries.js\":\"0c1719833675f636\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/summaryBatch.js\":\"08acbee83eaac8e0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/surface.js\":\"5ab3679717463888\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/threadNavigation.js\":\"a34dc4d4094c068d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/threads.js\":\"f391fe99ed30e217\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/ui.js\":\"72d376b4e4cfa33e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/annotations/uiStore.js\":\"704a0e12176428fe\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/app-intents/appIntents.js\":\"2f6065a361ce01f9\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/app-intents/index.js\":\"513d936065b2f070\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/app-update-prompt/index.js\":\"f34da375b2651fb1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/app-update-prompt/status.js\":\"0d24eac38019eae7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"fc23524d119e01c5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/MediaBlockRenderer.js\":\"693ab2cea8a00fa0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4b9775239f41b5e3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/MediaUploadReconciler.js\":\"1537e3afaaa892e0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/assetDownLane.js\":\"417952453345844a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/assetResolver.js\":\"84bb21dbf581b7e6\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/assetUpload.js\":\"e449488c2b87a829\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/attachmentCleanerIO.js\":\"27f909a89b75b284\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4b3133ce6ed719e1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/blobStore.js\":\"52d630cdcd59dfd1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/browserMedia.js\":\"82a146e955e5756e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/byteStore.js\":\"95847ce0aae31380\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/cleanerIO.js\":\"df914c3c6e67a9bd\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/cleanupAttachments.js\":\"a5ed6479a0273de6\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/dataExtension.js\":\"600e29dbdcd96c10\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/downLane.js\":\"8f219085e3c46c9a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/index.js\":\"3556250304532a62\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/insertImageContribution.js\":\"c53e63393f213e98\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/laneArming.js\":\"224cc21fc1456c01\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/laneLock.js\":\"97a90346b98e5daf\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/mediaBlock.js\":\"6a95e941b78f0616\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/mediaCapture.js\":\"073e62f325a63ce0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/mediaLanes.js\":\"3e096d37033b8e23\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/mediaViewers.js\":\"881125e5aa015166\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/mediaViewersFacet.js\":\"364c11573a126a38\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/pasteCapture.js\":\"5c23cd3f960c8789\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/resolver.js\":\"5532aeb4b30d70aa\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/retryUploadsAction.js\":\"dc85db3ac694eeda\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/storagePaths.js\":\"5b3cb8b9f5627807\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/uploadDrain.js\":\"ff1605df0bb7b64e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/uploadLaneStatus.js\":\"03664fd1de2c3113\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/uploadReconcile.js\":\"dd94901f838dc4d0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/uploadRecovery.js\":\"8c239b78711e8bb0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/uploadStore.js\":\"b84d5983d6a2730a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/attachments/useAssetObjectUrl.js\":\"d5320b9b1ba336da\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b833f4664c4bae57\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks-view/BacklinksViewSection.js\":\"68f3158e1cf917d6\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks-view/facet.js\":\"cb7ad0383336830d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks-view/index.js\":\"7ef0c145056e7836\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks-view/prop.js\":\"0e57b5224492853e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/BacklinkFilters.js\":\"b30997c3917cd88d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"190f8902994a2a73\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/BlockEntry.js\":\"c997f31c56c2fc13\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/LinkedReferences.js\":\"981a3b156a357acc\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"6088b79ed70a3703\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/dailyNoteDefaults.js\":\"3756568db7c582b4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/dataExtension.js\":\"b08ff4459701cf28\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/edgeExclusions.js\":\"d74652267c76f69d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/filterProperty.js\":\"4bfbf2b64f41019d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/index.js\":\"8151e920667cab10\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"faedeb10409d162d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/inline-counts/applies.js\":\"e5828e4f16e59446\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/inline-counts/countQuery.js\":\"8dbe4737b78c0ec7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/inline-counts/expansionStore.js\":\"302130afcb17625d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/inline-counts/index.js\":\"d441e50f3057bbd0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ef0149cf8072d50b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/presentationInvalidation.js\":\"dfd3429e7fd5aa6d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/propertyEditorOverride.js\":\"83f9867d2e2502a4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/propertyFilter.js\":\"462ccc37971411fb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/query.js\":\"9a8ebafb4a2abc77\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/resolveFilter.js\":\"705d8cfbcc6289e9\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/sourceBatch.js\":\"ff338397b68fd3e4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/sources.js\":\"17d8a108617a581a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/useBacklinks.js\":\"ade3bb4b2eec17de\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5d58cbbd95ad4bc5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/birthday/BirthdayCelebration.js\":\"ae4cd26b804490f4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/birthday/BirthdayOverlay.js\":\"279831b413cc1a78\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/birthday/gate.js\":\"7604f0fac04237c7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/birthday/index.js\":\"df5d3ab3b4261923\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/birthday/wolfTheme.js\":\"6b7da04d4e7dde04\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-drag/BlockDragLayer.js\":\"6f27a56dd30af61c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-drag/dragController.js\":\"3b214868c600153b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-drag/dropTarget.js\":\"968092fa58414807\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-drag/index.js\":\"6bc210ef6d0a429e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-drag/projection.js\":\"24d5d374d1b4d6b3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-info/BlockMetaCard.js\":\"d8796adaea1fbbab\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-info/index.js\":\"a2e005579341fc23\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-tagging/AddTagDialog.js\":\"9f70e53ade6079e4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"13728204a7567c89\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-tagging/TagNameIssueHint.js\":\"fd0efbab403af072\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-tagging/addTagAction.js\":\"c295b8b5c0b55d1a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-tagging/appendTag.js\":\"fbfe7351c67d7aa5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-tagging/config.js\":\"fa64ea8ca09d0610\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-tagging/dataExtension.js\":\"31a92e892417761e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-tagging/index.js\":\"1f57c89225c042e7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/block-tagging/propertyEditorOverride.js\":\"089e451e11795a24\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/breadcrumbs/BreadcrumbList.js\":\"922977b075282bd5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"b64c1db2322e5890\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c2f76ae76184f704\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7380b8fe1eae217f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"bdc45cccc39242f2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/breadcrumbs/index.js\":\"7c8064c3cf6c8742\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"bfe1319fdda3454e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/character-counter/CharacterCountItem.js\":\"ccd131dc7ccb1b70\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b8abf3dc7d9a9d59\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/character-counter/actions.js\":\"81d083a12eb683fe\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/character-counter/blockType.js\":\"714d2484cf42f88c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/character-counter/charCount.js\":\"e9809f3380d0ae92\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/character-counter/dataExtension.js\":\"4ba28d3c6ed55851\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/character-counter/index.js\":\"0b9c424bbf9efe63\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/character-counter/profiles.js\":\"ae46c9325d0581e9\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/character-counter/properties.js\":\"8d5d66adb9c48a57\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/character-counter/textCounts.js\":\"8d3be71ad207626e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/colemak-keybindings/index.js\":\"7d58243f0f294f74\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/command-palette/CommandPalette.js\":\"9ade5abe65d668c3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/command-palette/HeaderItem.js\":\"1f1f3bc54ea27be9\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/command-palette/context.js\":\"25c82c142880ca01\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/command-palette/index.js\":\"3b89619d661bfa74\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/command-palette/selection.js\":\"ed197b8cf7e5124d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/command-palette/toggleStore.js\":\"df7052328e964a0f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/command-palette/useCommandPaletteActions.js\":\"3f3c0906c148817d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/contributors/ContributorBadges.js\":\"46995d7a966a3288\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/contributors/author.js\":\"2a17c6784c86b3cb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/contributors/codeMirrorExtensions.js\":\"5e3f22c113c33cb2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/contributors/dataExtension.js\":\"c974d36f71e24012\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/contributors/index.js\":\"49820a7ee8632a14\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/contributors/mentionAutocomplete.js\":\"6ef3c1ee4a6c1f38\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/contributors/processor.js\":\"a70ced08e8259862\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/contributors/profiles.js\":\"ee45a9b79cffd3be\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/contributors/queries.js\":\"5c144d7b7150ddf1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/contributors/schema.js\":\"43e24cbc66d32e6b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"357d6d40d1f851b3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/cursor-follows-scroll/followOrigin.js\":\"3eba3cbf7492cdac\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/cursor-follows-scroll/index.js\":\"d3110be9cadf9f69\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d045b1e3bd3598e2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5233572f373edc64\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/CalendarGrid.js\":\"b0a9bcf754bdff35\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/DailyNotePicker.js\":\"bcf25a817fd6e8b5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"49fc00d2f88df8e5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/DateNavDecorator.js\":\"6aec56be1f73ea89\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/DateScrubOverlay.js\":\"a2d451b6caee26e1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/DayPropertyEditor.js\":\"d8e8b93c520ac4af\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/HeaderItem.js\":\"8ed575b4cffbb3fb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/ReschedulePicker.js\":\"7cd3ca6f9aafaf05\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8ca64e1946cd328b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/actions.js\":\"e8b87e84435053e5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/blockDateAdapter.js\":\"0260ff11cabed026\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/calendar.js\":\"676f3ff606ba7f82\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/dailyNotes.js\":\"f41acde0c5b16a9e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/dataExtension.js\":\"95e99a136ffb0d34\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/dateScrubActions.js\":\"39ba0f2d877feed3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/dateScrubGesture.js\":\"0c3b638410214248\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/dateScrubGestureActions.js\":\"f6f464ef8a8a2df3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/dateScrubRecognizer.js\":\"63e1e132a21f3c96\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/dayProperty.js\":\"6c9077780532341f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/deletionGuard.js\":\"c28331b64d4868d9\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/dueQuery.js\":\"c5709d11d5a2a4eb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/index.js\":\"6c62c672c07f83bb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/landing.js\":\"8825519c9e8ecfc4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/localSchema.js\":\"0cba6d44c2f6ead7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/referenceDateAdapter.js\":\"8a9070b0eb0b5e4a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/rescheduleAction.js\":\"38b61709e47ce9d5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/schema.js\":\"6250a827a2a0e0cd\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/spreadBlockDates.js\":\"baa5bb96b197cbad\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/spreadDatesAction.js\":\"6f7c6f961ac1cbd6\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/today.js\":\"dd1997eeaeb01b39\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2e598267c3e53aeb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"416baedd211ca6aa\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/data-integrity/audit.js\":\"17054c1759340ffa\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/data-integrity/auditAction.js\":\"9faa72f6aefa72c5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/data-integrity/auditRanges.js\":\"f9ecff428d61bc24\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/data-integrity/diagnosticsSource.js\":\"e18c1bda83f9e9bc\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/data-integrity/divergenceScan.js\":\"d12982c1a04cb5a2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/data-integrity/index.js\":\"88ee490d11259aab\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e2f64ffba816bd59\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/data-integrity/referencesMirror.js\":\"872603a95908c613\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/data-integrity/rowJson.js\":\"401cce9c70664839\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/data-integrity/schedule.js\":\"27b8cb9ffff98adf\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/data-integrity/store.js\":\"77465d15b972020f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-maintenance/action.js\":\"9fee0fdef2b3c657\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-maintenance/index.js\":\"04b8221c4b9c3298\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-maintenance/plugin.js\":\"056a3ebc2305ac73\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c454314c3a2ea9e0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-mirror/actions.js\":\"d69395746b87a57f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-mirror/changeMarker.js\":\"5ed2eda891e26f86\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-mirror/diagnostics.js\":\"7e4c5aff5baa00a6\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-mirror/fileSystemAccess.js\":\"1988703a2303c3c5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-mirror/filenames.js\":\"a78b4be88f59a9bb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-mirror/index.js\":\"7db69cbb13d93b0a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-mirror/mirror.js\":\"52ce89e6a56f8c77\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-mirror/runLock.js\":\"7af053a015794d80\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-mirror/runtimeHealth.js\":\"820e5c1bfd2b7bf2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-mirror/schedule.js\":\"1ec1c16cbc9bf577\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/db-mirror/store.js\":\"d2e3b19dfddd1cae\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/default-themes/index.js\":\"6e1a2db7322f54bc\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/default-themes/themes.js\":\"f03142ef7941d930\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/diagnostics/facet.js\":\"11bf9a9e4a4993ff\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/diagnostics/useDiagnostics.js\":\"1c2f78f681d8cd05\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extension-prompts/dismissals.js\":\"e042d587de25831a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extension-prompts/index.js\":\"5425554ed2e3d4d1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extension-prompts/status.js\":\"4353ec1c81a6ad38\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extension-prompts/store.js\":\"0be8dfdabfc20971\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"6b3fcd0f0b481acf\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extensions-settings/ExtensionsSettings.js\":\"de2b5e0fe86df742\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extensions-settings/actions.js\":\"cae0056d0610ca42\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extensions-settings/config.js\":\"3cbb7ac8ea08433e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extensions-settings/dataExtension.js\":\"eb78362c3ea6068c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extensions-settings/effect.js\":\"d8b83ad771364053\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extensions-settings/index.js\":\"392e405bc156a84f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extensions-settings/propertyEditorOverride.js\":\"389b9e5565cbfaa0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extensions-settings/useToggleTree.js\":\"107da166b3b239f5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extract-type/ExtractTypeDialog.js\":\"d043e33734fdabcb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b7451e4ca0f24dc6\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extract-type/PropertyShapePicker.js\":\"281f541159a0bc32\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extract-type/action.js\":\"c0dd8db7c99c2668\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/extract-type/index.js\":\"afd16213b44c421d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/find-replace/FindReplaceDialog.js\":\"1984a3c21cf25591\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/find-replace/HeaderItem.js\":\"2a9f7ee461e31b87\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/find-replace/dataExtension.js\":\"faa0d2ce26efe6dd\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/find-replace/index.js\":\"9f7740ca108d0d9c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/find-replace/search.js\":\"2d390c97b4a66b37\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/find-replace/toggleStore.js\":\"02abb9561e9464f5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/LocationPropertyEditor.js\":\"d66b75392c91fd1c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/MapView.js\":\"8967e3e2dac56edd\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/blockTypes.js\":\"1587a94cf8fdf3ad\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/codeMirrorExtensions.js\":\"961bc35ee52a8b4d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/createOrFindPlace.js\":\"6f32474f82b2e36c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/currentLocation.js\":\"c8acf4dc7e6fa936\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/dataExtension.js\":\"86b6903f094f6315\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/geoContentDecorator.js\":\"237ede27f6f76d9c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/googlePlacesClient.js\":\"7f3074a009e1621d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/index.js\":\"89d61e3d0005b379\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/locationsPage.js\":\"68d7f93c4e756cd9\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/mapViewport.js\":\"ab585d7b6cf9ac41\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/pickCurrentLocation.js\":\"b21e959458120c4c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/placeAutocomplete.js\":\"abf573ef7bbcdc51\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/placeNameCollision.js\":\"8333b7b341776fc3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/properties.js\":\"574f5d836419ef1d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/propertyEditorOverrides.js\":\"f482dcbcd6b87db1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/query.js\":\"a7d598d8b4986e3f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/geo/usePlaceSearch.js\":\"571dfd7d56e6aa6f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"e1ef610e042d5f1e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"af9ed0325c2e64a4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"f882348a45c0e195\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/grouped-backlinks/config.js\":\"3a17c965bfbfb0ea\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/grouped-backlinks/dataExtension.js\":\"367cdf8a2250051c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/grouped-backlinks/facet.js\":\"9585308421244fc2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/grouped-backlinks/grouping.js\":\"f09ef380d3bcf867\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/grouped-backlinks/index.js\":\"fef494e5ad628590\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7c7553a4f2975cc8\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/grouped-backlinks/query.js\":\"c311a11397341812\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/grouped-backlinks/resolveConfig.js\":\"c8a1b60aa3d763c8\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"f5a0ac79ec9dcc84\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"ae060d602a9549ef\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/html-document/HtmlDocumentContent.js\":\"b335bb2e9e115b75\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/html-document/HtmlFrame.js\":\"823379fc978bcf27\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/html-document/actions.js\":\"9e7fb5e4e1112d84\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/html-document/blockType.js\":\"67f014b28cb6edc3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/html-document/confirmRunScripts.js\":\"00801c715ec4784e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/html-document/dataExtension.js\":\"db203d9d4913c5de\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/html-document/frameAnnotations.js\":\"5ffcef99fe9101a1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/html-document/frameDocument.js\":\"f4ad8fe4ea83295f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/html-document/frameTheme.js\":\"6f0fbdb7ff197f2a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/html-document/index.js\":\"f8a0c35316d6f525\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/html-document/scriptConsent.js\":\"120fb8ab422273d7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/html-document/sourceMap.js\":\"0110f62772a695da\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/html-document/useDocumentScripts.js\":\"2348ffb38faa2bf0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/interaction-metrics/index.js\":\"447394cfc8715c34\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/interaction-metrics/record.js\":\"5527f7aeffcbaf08\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/interaction-metrics/recordStore.js\":\"82bc0d1be1661228\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/interaction-metrics/responsiveness.js\":\"e2f6343d1d3dab7d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/interaction-metrics/schedule.js\":\"eb684ccdabcf6e24\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/interaction-metrics/sessionContext.js\":\"18f2fc1f911c871c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1fad5ec95e9c8f88\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c11572c5607fb799\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/keybindings-settings/actions.js\":\"93f36b665bf00ef4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/keybindings-settings/config.js\":\"2cbb6db7a170b448\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/keybindings-settings/dataExtension.js\":\"bd3131b8d38210fe\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/keybindings-settings/effect.js\":\"dd3fea4e75c53ebc\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/keybindings-settings/index.js\":\"28f885275e79b898\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/keybindings-settings/keyCapture.js\":\"14fc807d6bf8f59c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/keybindings-settings/overrideStore.js\":\"050623ce5733a9f2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"caf271b267413627\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/left-sidebar/HeaderItem.js\":\"f52293ca1f650f8f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/left-sidebar/LeftSidebar.js\":\"28733f010395c236\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/left-sidebar/actions.js\":\"1017b9e24ce665f3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/left-sidebar/facet.js\":\"ec137d679bf58009\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/left-sidebar/index.js\":\"c22578385cce1adb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/left-sidebar/shortcuts.js\":\"3f3658da6e7923fb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/left-sidebar/toggleStore.js\":\"16ef3c31e1930b0b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/merge-blocks/MergePicker.js\":\"116011b593abf7a3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/merge-blocks/index.js\":\"8e264273b58a9a00\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/merge-blocks/mergeAction.js\":\"3bd7a1bb3aca6bb8\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/merge-blocks/strategy.js\":\"faf627e4407bd19b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/mobile-bottom-nav/Button.js\":\"effcd331973a1285\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"9142ca204e25d8fc\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5c7dea22980eca08\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/mobile-bottom-nav/facet.js\":\"273187452b025ef2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/mobile-bottom-nav/index.js\":\"e45c39702240d5a7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d5d81b2f7a07533a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f0794587714009c8\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"1db3589b92b562bc\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/mobile-keyboard-toolbar/facet.js\":\"1d3882cf924119f3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/mobile-keyboard-toolbar/index.js\":\"75fd268e9c3f15a4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/move-blocks/MoveDestinationPicker.js\":\"312a7e33e6552e2a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/move-blocks/blockSubtreeMembership.js\":\"a843185b336d1f54\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/move-blocks/contextMenuItem.js\":\"d7e66611d1702d43\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/move-blocks/index.js\":\"4b0bd2c40aae4e1f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/move-blocks/moveAction.js\":\"b0ff41fc4cd3887e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/move-blocks/moveBlocks.js\":\"02e16122ccc4ad0c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/move-blocks/selectionAfterMove.js\":\"b1090493d9195d67\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/onboarding/TutorialBanner.js\":\"c634e1d282db8450\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/onboarding/action.js\":\"daf851fcc3655205\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/onboarding/bannerDismissal.js\":\"24d2f959ac0422d1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/onboarding/documents/cheatSheet.js\":\"0ac948e369340ee0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/onboarding/index.js\":\"41fbd3eed37f0249\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/onboarding/keys.js\":\"aa44647e8a69f3c4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/onboarding/landing.js\":\"bc8940a0eeccdcfa\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/onboarding/outline.js\":\"12fa6635748eef3c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/onboarding/seed.js\":\"07168178b4b5d552\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/perf-monitor/PerfTrendDialog.js\":\"bef8b1fb0335d13b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/perf-monitor/analyze.js\":\"337abf9a45ae64a1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/perf-monitor/diagnosticsSource.js\":\"2ae88e486cabbf24\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/perf-monitor/index.js\":\"ab700acb8f03d50e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/perf-monitor/load.js\":\"64e9aa9523d2089d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/perf-monitor/monitorRun.js\":\"406e3061397693f7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/perf-monitor/schedule.js\":\"9b306d9f6ce8558b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/perf-monitor/series.js\":\"c18769f6240d060b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/perf-monitor/store.js\":\"8d1ca4210b248a0b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/perf-monitor/trendAction.js\":\"3e523780d227acbc\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/perf-monitor/verdict.js\":\"ad47f98e1992dfc8\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/plain-outliner/clickToEditAction.js\":\"d9268ec3cb9a2b12\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/plain-outliner/index.js\":\"32f1560647f9c758\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/plain-outliner/interactions.js\":\"02c78c84a881e722\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9dc39ba9d109775a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/properties-migration/MigrationGate.js\":\"a23bdc7d5d1512b2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/properties-migration/MigrationGateDialog.js\":\"7b08b699dfb0d0f5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/properties-migration/action.js\":\"1f4ad688d055a81f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/properties-migration/index.js\":\"ed7393f29b317b87\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/properties-migration/localRunMessage.js\":\"086b9690c6f97de3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/properties-migration/plugin.js\":\"5ef6b68b37d43aae\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/properties-migration/progressReport.js\":\"64d6cfc7e076e00c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/properties-migration/sweepProgress.js\":\"cedd8b8bdd69eb19\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/property-rows/FieldRowRenderer.js\":\"55d1b3d04b636a5b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/property-rows/ValueRowRenderer.js\":\"681f209a88dfa937\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/property-rows/actions.js\":\"398359412e3e3a02\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/property-rows/autocomplete.js\":\"f713b2b3dda599f4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/property-rows/fieldRow.js\":\"9c2aeaedfa32b1d9\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/property-rows/index.js\":\"923eb0b4dddd515b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/property-rows/referenceWarning.js\":\"3acf5887b4b4964d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/property-rows/valueAutocomplete.js\":\"48ef51667bef3fcd\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/property-rows/valueSchema.js\":\"878ce622b56e4803\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/quick-find/HeaderItem.js\":\"aa365a310be1e001\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/quick-find/QuickFind.js\":\"17adf4c775ce366c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/quick-find/index.js\":\"ed6586ab6edc66e6\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/quick-find/recents.js\":\"47f1fc8ab904f589\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/quick-find/resultItems.js\":\"7225e570cc961fa7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/quick-find/selection.js\":\"8570a758673ef2e6\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/quick-find/toggleStore.js\":\"796569a2a2adbb25\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/recents/HeaderItem.js\":\"0cc412e62e74d977\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b408127112768af9\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/recents/grouping.js\":\"68f6e73c8f300a53\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/recents/index.js\":\"90bd54ef0fddb188\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/recents/target.js\":\"1b1e40def030b4fb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/codeMirrorExtensions.js\":\"f58528ac258c65b7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/contentPrefill.js\":\"1a5af66d1ecf4762\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/dataExtension.js\":\"84286b0aa0550b0a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/index.js\":\"20cafb3712055f4e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a1dd2e663ad13bc6\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/invalidation.js\":\"86c9a58a8e5e736c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/localSchema.js\":\"bda4f1e5f7583908\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/markdown/blockrefs/index.js\":\"24c2f54af1b64444\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"33c0d792ad36bd30\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/markdown/index.js\":\"b86967f9fa712229\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/markdown/referenceNode.js\":\"b5369a825311506e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/markdown/remark-reference-occurrences.js\":\"0ad16f287cea3895\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"76b2e75699a6d919\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/markdown/wikilinks/index.js\":\"14d3e6962047c646\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"9bc5aa8dd22a46c0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6fedb3d5cb79fcbf\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/mergeRetargetProcessor.js\":\"d3704db6ae7ae4bd\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/parseFence.js\":\"6ab3401205c167ad\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/referenceParser.js\":\"e00723b1f9b52ac3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/referenceProjection.js\":\"099cc803702f756e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/referencesProcessor.js\":\"fd9dadc474c54edd\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/renameProcessor.js\":\"9e525a48705f0078\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/references/spanReplacement.js\":\"acef7c14b5748005\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/rich-paste/htmlToOutline.js\":\"e9187e8e32770dfa\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/rich-paste/index.js\":\"d2b5194b5e8422a3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f863ef56b48de492\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/rich-paste/pasteDecision.js\":\"4034cd59726696b8\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/action.js\":\"1a948fcaea58354c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/blockIds.js\":\"47aa55312e866b29\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/content.js\":\"b7eaa9ccf8c2fd30\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/effect.js\":\"e377ba59f9e07ecc\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/ids.js\":\"728d406ae0da6049\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/import.js\":\"1fbd46f33aaa3712\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/index.js\":\"e6d05f13a4cf9414\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/plan.js\":\"0e21b3dc9223e691\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/plugin.js\":\"f991774a1793be5c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/promotion.js\":\"b3ae1ccb354f01c1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/properties.js\":\"3da2bb0f6755c3db\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/references.js\":\"4a828ec6f1925299\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/report.js\":\"709eeb5180653a6a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/roamMemo.js\":\"67578deb6cf41af0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/runtime.js\":\"3c684c0651e78480\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/schemaReconciliation.js\":\"46420563bee95739\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/srsMarkers.js\":\"db861ce1f0c0191d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/todo.js\":\"c6da67706b6c8d08\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/typeCandidates.js\":\"1226e4d4a4323ec6\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/roam-import/types.js\":\"e46fa2531a22a2ec\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/search-health/index.js\":\"377b5bf4d6b0757a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/search-health/store.js\":\"1b3509795ce3d3a2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/shortcut-help/HeaderItem.js\":\"4483254aa9b80599\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"d28df556f6e556ce\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/shortcut-help/index.js\":\"5b5a3cf2de586c3d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/shortcut-help/model.js\":\"cbe86e4ce790ff18\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/shortcut-help/toggleStore.js\":\"d9c2c51d55269c84\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/shortcut-help/useKeyInspector.js\":\"50f1e92230a48f47\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"2c89f08cdeca98a5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/spatial-navigation/ShellDecorator.js\":\"89a6b22062e78f80\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/spatial-navigation/actions.js\":\"6025e2a3127d58e3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/spatial-navigation/exclusionsFacet.js\":\"dafa3a7a2be98aa7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/spatial-navigation/index.js\":\"f8fd9cd560f2ec38\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/spatial-navigation/shell.js\":\"f24ab3d313ab4be3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/spatial-navigation/surface.js\":\"a9aee0bc1eb5eb64\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/spatial-navigation/walker.js\":\"f2885bc12bfbc6c3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-rescheduling/RescheduleToast.js\":\"63bc6d4c658f8a3c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-rescheduling/dataExtension.js\":\"726ffe80cb89ee0c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-rescheduling/index.js\":\"e0f1b48746b0b962\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-rescheduling/indicator.js\":\"d9fbd33119783f2e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-rescheduling/moveSrsState.js\":\"6ee0dd9f5a981840\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"55a1be1d76f4c916\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-rescheduling/scheduler.js\":\"449b0a9d3684cc3e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-rescheduling/schema.js\":\"948428fcb6e68ec7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"0006dc4f1a7afa7d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-rescheduling/srsClipboard.js\":\"11cb1031d738f000\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2f4741b025e35729\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/DailyNoteReviewHint.js\":\"5f2915df32c814eb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/DeckPicker.js\":\"9849958bd0f78829\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/ReviewControls.js\":\"56d5e06e9137634c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7fca486cbbfab902\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/ReviewSession.js\":\"a0451bffa4a7e32c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/actions.js\":\"089934dfc2a1172d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/archive.js\":\"d1a775a53d65f77f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/dataExtension.js\":\"40c9205e3e2461b7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/deck.js\":\"3e58bb9eee0e80c3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/dueQuery.js\":\"11db1f9383b54a1c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/gradeDecision.js\":\"aedb159c52e1fa3b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/index.js\":\"1962f439bb1202aa\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/keyHints.js\":\"f5390bac308dac79\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/reviewCardLayout.js\":\"ebfa4f43935568bc\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/reviewProgress.js\":\"d31a1896f28bce73\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/schema.js\":\"7050337d5cf3ced7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/srs-review/useDueCards.js\":\"ad2c6b93d211991f\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/startup-metrics/index.js\":\"8bc53cad6ab9d1e1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/startup-metrics/record.js\":\"0ed68e6ac445ff75\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/storage-persistence/index.js\":\"0f1ea6cb9155ec05\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/storage-persistence/persistenceStatus.js\":\"261ba4d190ed2084\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/storage-persistence/requestAction.js\":\"90f58322e8a79651\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/supertags/TypeChipsDecorator.js\":\"eb55c007e8479322\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/supertags/codeMirrorExtensions.js\":\"3e8e9c27871c4792\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/supertags/index.js\":\"68acdf79b3ccb955\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/supertags/typeAutocomplete.js\":\"d1c322276a901b22\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"27d1118191f84e5b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/swipe-quick-actions/actions.js\":\"db89cc62d67d932a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/swipe-quick-actions/anchor.js\":\"3d483e4ef6d13aa8\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/swipe-quick-actions/events.js\":\"e6a7e2a5b3cb6cad\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/swipe-quick-actions/gestureActions.js\":\"aadb39a6db79ec61\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/swipe-quick-actions/index.js\":\"0bb19c9030c21938\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"49f81f00464a7fd9\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/sync-metrics/collect.js\":\"27c3bd031391e4dd\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/sync-metrics/index.js\":\"60cf44a78bd5a4f0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/sync-metrics/record.js\":\"c606853dc4d2f6da\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/system-status/RejectionDialog.js\":\"0ea97a4b4a1310f7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9703d9df519a85fb\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/system-status/index.js\":\"cf15543c3b153f1b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/system-status/model.js\":\"e695e64a3b89c0bc\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/system-status/queueCounts.js\":\"b633cf94830e3977\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/system-status/rejectedHelpers.js\":\"b771a48b4a85175a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/system-status/rematerializeAction.js\":\"c29cf58516011fe4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/system-status/useHysteresis.js\":\"de5c53f2158baba6\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/ColumnHeaders.js\":\"1d08fad3ff9eddc2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/QueryUi.js\":\"29fea0a1979b981e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/TableLayout.js\":\"1df5fc606e1fc3f3\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/actions.js\":\"ecb152c4c10213f8\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/cellEdits.js\":\"69e3a9372f11db42\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/childrenViews.js\":\"20995a130151261d\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/columns.js\":\"fe6db66ae8246e2b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/controller.js\":\"0f7f21079d2fa7ab\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/convert.js\":\"0bc9cd73850399b7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/dataExtension.js\":\"6ad43e137cdd95e1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/index.js\":\"0d4f2837ec6b2f3e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/keys.js\":\"fb24fa53fa7e8cfc\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/model.js\":\"51abd77b4b65a585\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/query/backfill.js\":\"1aa337d60ceb02dd\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/query/completion.js\":\"4cdc27978874cb1b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/query/format.js\":\"d48f711de952981c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/query/parse.js\":\"dfa41d956f5d597b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/query/queryValue.js\":\"11181dbaf0d88056\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/query/registrations.js\":\"6da0fe9b07be8931\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/query/source.js\":\"39ad412bbeb39477\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/registry.js\":\"374d05e9b976fbfa\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/rowGutter.js\":\"1748f7957f1dcc41\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/rowVerbs.js\":\"346d2554abcf9293\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/schema.js\":\"4305e4be1ff123b1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/tables/sort.js\":\"97dfa37f2d627e21\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/theme-toggle/effect.js\":\"9d427a1f90527b44\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/theme-toggle/index.js\":\"cdedb31753f16e33\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/theme-toggle/theme.js\":\"bc3923051655bff7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/todo/actions.js\":\"dbc09f724113cc3e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/todo/dataExtension.js\":\"8e61811d36feaaab\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/todo/index.js\":\"11e465efe5c3dcc5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/todo/schema.js\":\"49884e76e8838df2\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/touch-selection/TouchSelectionLayer.js\":\"cec356581446bc52\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/touch-selection/actions.js\":\"3317164100991a1b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/touch-selection/defaultItems.js\":\"59a4608278126ca0\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/touch-selection/facet.js\":\"0738148cfd9959cf\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/touch-selection/holdRecognizer.js\":\"dbab4a66be5d7ebe\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/touch-selection/index.js\":\"0b9aa40791f7fd0e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/update-indicator/UpdateIndicator.js\":\"8ab2c6ce59cf5fc7\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/update-indicator/index.js\":\"1f242e3dc6d8e84a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/update-indicator/loadTimes.js\":\"a7d9ad1a1eee25f1\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/video-player/VideoNotesRenderer.js\":\"fd2f08eda9a0ba8e\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/video-player/VideoPlayerRenderer.js\":\"21437ff3fc390674\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/video-player/VideoTimeStamp.js\":\"554b5bd17be138d9\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/video-player/actions.js\":\"ccb5f4f39169f0ee\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/video-player/index.js\":\"8eb7cde2f9152f3b\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/video-player/markdown.js\":\"a8d9c24c7483a121\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/video-player/notes.js\":\"b5a999e619dc7557\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/video-player/registry.js\":\"a3bff63c32d7da2c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/video-player/remark-timestamps.js\":\"2e45b5a8c5d103f8\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/video-player/view.js\":\"a0b7e87bcd457077\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/vim-link-hints/LinkHints.js\":\"cfae7d826e8cd5e5\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/vim-link-hints/index.js\":\"6ca66b8449c0901a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/vim-link-hints/model.js\":\"38996956fb1bc0f4\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/vim-link-hints/settings.js\":\"4a1d056088cb4e45\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/vim-normal-mode/actions.js\":\"dc7d283ed75b639c\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/vim-normal-mode/index.js\":\"53470462e2f10a0a\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/vim-normal-mode/interactions.js\":\"2149b7ff12c22aa8\",\"/knowledge-medium/pr-preview/pr-1882/src/plugins/workspace-header/index.js\":\"33d8fdf9f6e91212\",\"/knowledge-medium/pr-preview/pr-1882/src/registerServiceWorker.js\":\"63430c8313a19e68\",\"/knowledge-medium/pr-preview/pr-1882/src/requestPersistentStorage.js\":\"13c03630c5c5cf03\",\"/knowledge-medium/pr-preview/pr-1882/src/services/authRequestDeadline.js\":\"22b137037f263e11\",\"/knowledge-medium/pr-preview/pr-1882/src/services/authStorage.js\":\"73aa6b25c77fca96\",\"/knowledge-medium/pr-preview/pr-1882/src/services/powersync.js\":\"7dff55c1eb3c8a6c\",\"/knowledge-medium/pr-preview/pr-1882/src/services/supabase.js\":\"d182da31594a5f81\",\"/knowledge-medium/pr-preview/pr-1882/src/services/uploadErrorClassifier.js\":\"5feb6013ad411030\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/ActiveContexts.js\":\"9ece534406a44ebf\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/HotkeyReconciler.js\":\"b120d130105b2db1\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/WipeLocalDataDialog.js\":\"3455e3829b71517a\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/actionDispatch.js\":\"5129524277a2ec69\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/actionRefItems.js\":\"721bcba01406e514\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/applyKeybindingOverrides.js\":\"062ce9bdb906aa1d\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/blockActions.js\":\"e998ab03f2d74ab6\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/blockMergeGesture.js\":\"f1bf7cc2a3c94fca\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/canonicalizeChord.js\":\"dd6c879b18689696\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/defaultContexts.js\":\"4fb2481f4f699efd\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/defaultShortcuts.js\":\"55341e8f9149c5b8\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/effectiveActions.js\":\"26b3acc0d329b0dc\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/gestureAction.js\":\"dda75708a383a1f1\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/gestureBinding.js\":\"be407638fb6fa6e9\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/holdRegistry.js\":\"1dc4ed12fb3fae35\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/keybindingConflicts.js\":\"4515e6b94b7bb2b2\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/keybindingOverrides.js\":\"f57037ddd7c0eb89\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/pointerAction.js\":\"d10d69b58bfb75fe\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/resolve.js\":\"70c4414930b34571\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/runAction.js\":\"087052f8bf7c2de8\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/sequenceMatcher.js\":\"6fb977adf6e2075d\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/types.js\":\"130ae6747a4234d0\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/useActionContext.js\":\"0600697e5b29d3c3\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/useActionDiscovery.js\":\"67d2770b7a438a74\",\"/knowledge-medium/pr-preview/pr-1882/src/shortcuts/utils.js\":\"7754a802861cdac7\",\"/knowledge-medium/pr-preview/pr-1882/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1882/src/sw/bootStore.js\":\"c1e5381ca0e7491f\",\"/knowledge-medium/pr-preview/pr-1882/src/sw/previewDatabases.js\":\"a09c4bc3186f87d0\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/byteTransform.js\":\"90fb00087159ace4\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/attachmentCleaner.js\":\"dab48782052c78b0\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/bundle/attachmentParts.js\":\"4a242d904445aa87\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/bundle/bundleParts.js\":\"b02354c0793c4b04\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/bundle/bundleRecord.js\":\"23c0ecb36ebf3b96\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/bundle/manifest.js\":\"dc8392a380ebf325\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/bundle/takeBundle.js\":\"1946847a08497b0f\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/bundle/verifyBundle.js\":\"5dc0e5bc88d2b7bc\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/cleaningStage.js\":\"92e09ec03bda5591\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/conversionKey.js\":\"0f25113756e9be89\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/conversionServer.js\":\"f39841ee2aa4fa5c\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/flip.js\":\"a25a0ecf1002b3cd\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/flipAttempts.js\":\"67f9fa5b23618d93\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/pages.js\":\"4276625d0f4cb395\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/preflight.js\":\"8fc9699484288d7a\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/reseal.js\":\"1bdcf7bf9551aed0\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/runConversion.js\":\"9f79e930bb64aed1\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/runLock.js\":\"82cd67e375795eab\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/sealing.js\":\"ac3a387cbca321ef\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/sealingStage.js\":\"2ee0fb359c58ee8c\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/stage.js\":\"0bfa85e21e0006fe\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/conversion/verifyReseal.js\":\"f6bca2124d6ec7b7\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/aad.js\":\"6dfd1d42e676f333\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/aead.js\":\"b6fa2ed4d4d7b801\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/base32.js\":\"c3df6e1f0ead477b\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/base64url.js\":\"1539a14db679bb71\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/binaryEnvelope.js\":\"086b8de853e211c2\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/byteAead.js\":\"93acabbf3dd6285f\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/canary.js\":\"6c8941d4dba9292e\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/contentHash.js\":\"76138bd77f31c8c0\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/contentKey.js\":\"d73e1c191ea50337\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/derivedIdNamespace.js\":\"5b8e2e7b4a4c03ed\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/envelope.js\":\"5b2eaede2d7bc6b5\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/hex.js\":\"987729fd2baeb67b\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/sha256Hex.js\":\"f5596640b6720d37\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/crypto/workspaceKey.js\":\"47610fac08cff9a9\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/keys/conversionState.js\":\"346e6b84d4a763cd\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/keys/flows/createEncryptedWorkspace.js\":\"2902e7ad7443b0cd\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/keys/flows/pastedKey.js\":\"d8543ab187e868e4\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bcf828ab33b576ba\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/keys/flows/upgradeWorkspacePin.js\":\"6e68b8e61675e4fd\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/keys/keyStore.js\":\"5ccee318c57a70fc\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/keys/mintWorkspaceKey.js\":\"3c89036784be7c3e\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/keys/modePin.js\":\"38f2f4f10cf48052\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/keys/openWorkspaceKeys.js\":\"8698ed66921a9a10\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/keys/resolveWorkspaceEntry.js\":\"1d37deed96967ece\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/keys/resolver.js\":\"6fa264f2c164df28\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/keys/workspaceAccess.js\":\"bfbb0d955239ecb1\",\"/knowledge-medium/pr-preview/pr-1882/src/sync/transform.js\":\"c04fa09dc0640f92\",\"/knowledge-medium/pr-preview/pr-1882/src/themeBootDefaults.js\":\"4b580fec011d4336\",\"/knowledge-medium/pr-preview/pr-1882/src/types.js\":\"6c61103cd7f405d0\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/ClientLocalSettings.js\":\"38195d58d3071caf\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/abortableSleep.js\":\"8bd33186a795d948\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/array.js\":\"1c0a3c44f6b0adfa\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/backlinkAutocomplete.js\":\"651874c0c6281adc\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/blockCrumbs.js\":\"bb75df613899fb10\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/blockrefAutocomplete.js\":\"15d52826ab04cdf8\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/cadencedIdleJob.js\":\"7ddfece7c9bd6c32\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/callbackSet.js\":\"eaf508c9c435409b\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/clientId.js\":\"0c99a08069cea45b\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/codemirror.js\":\"e22613553ca2f5c7\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/codemirrorCompletion.js\":\"7290755a656b674b\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/copy.js\":\"9296cebe30872721\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/dailyPage.js\":\"d193bd24e18d3fd6\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/dbForensics.js\":\"20ec788cc7bfb239\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/dbForensicsHooks.js\":\"399d3b7fec588248\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/deleteBlockThroughUi.js\":\"c985f81a73c928e9\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/dialogs.js\":\"1931405b6c41a2e1\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/dom.js\":\"27acc6ac6955f7a5\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/downloadBlob.js\":\"622e1800772c8749\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/drawnWalk.js\":\"aaf086a354bd1315\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/exportSqliteDb.js\":\"7b15039ecbed0db1\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/fileSystemAccess.js\":\"bbe96881992ceb51\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/flipSlide.js\":\"e50575752079c381\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/fnv1a.js\":\"fb66d0529f3fa113\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/formatBytes.js\":\"53ae49fcc07d2eb0\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/fuzzyRank.js\":\"d86ceac86f814be5\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/idbKeyedStore.js\":\"def19887809acf52\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/idleCallbackPolyfill.js\":\"625dca188c3a8385\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/keyboardAwareScroll.js\":\"a764b63bbc5896de\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/keyboardViewport.js\":\"99bb8476caadeeff\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/lastWorkspace.js\":\"ea38614fc71aef17\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/layoutColumns.js\":\"f51c00ba29b22854\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/layoutSessionDom.js\":\"2f20e71b85bd9823\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/layoutSessionId.js\":\"13c8b0a20195090a\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/linkClickGestures.js\":\"dd84a36efd20b363\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/linkTargetAutocomplete.js\":\"70c9126499ba02ab\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/localDbCorruption.js\":\"2b8d96f5d54ca3d5\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/localDbRecovery.js\":\"b847d5b725acee9c\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/markdownParser.js\":\"8768c21d41aa1c40\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/memoize.js\":\"6b5ab2323d9e715c\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/nameFieldCommit.js\":\"c6dd1b4147193c0a\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/nameList.js\":\"46e6c89ab3f6875f\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/navigation.js\":\"63f0edf5e6b7df0f\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/omnilinerNamespace.js\":\"38396718c10b7862\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/opfsPageScan.js\":\"6adc26ec4062df5f\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/panelClearance.js\":\"a09dca082f8e50be\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/panelHistory.js\":\"e435747101b87068\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/panelLanes.js\":\"e071a432ff758632\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/panelLayoutProjection.js\":\"ec47218bb9495289\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/panelScrollAnchor.js\":\"66380c02f0686609\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/panelUrlFlags.js\":\"3cd4198fb953c805\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/platform.js\":\"7eaca40fc07489a7\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/pluralize.js\":\"7f3b76ba8446c434\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/propertyCreation.js\":\"f69c1e6b9a469a9f\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/propertyNavigation.js\":\"ac24ac73f842db0b\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/propertyValueContext.js\":\"69b1dd74406b3a68\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/react.js\":\"0e2d9fbc4b3b7e0f\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/relativeDate.js\":\"30e5a9fbb946b8a9\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/relativeTime.js\":\"7825aa7eb575ae26\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/renderScope.js\":\"da4ca61ae1ed13de\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/resolvedThenable.js\":\"8205a475b457fb70\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/routing.js\":\"b07101f9e8136a8a\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/safeMode.js\":\"17124891fc73421a\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/scheduleIdle.js\":\"f29129bbf5a60e46\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/screenWakeLock.js\":\"0c2fdc874db3d284\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/selection.js\":\"984573ba926d09d0\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/softKeyboardGrab.js\":\"8125debda5653a57\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/startupTimeline.js\":\"75ed2ff8f5a95703\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/state.js\":\"c935ff7e09bbc4cd\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/string.js\":\"f2a474007e218ead\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/surfaceZoom.js\":\"92bd925f3ed5c70c\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/time.js\":\"253985eac6a6ab0c\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/toast.js\":\"c79d748dd671e6e3\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/toggleStore.js\":\"b861c488c6337af8\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/untilStopped.js\":\"b708a05d17e07247\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/userActivity.js\":\"8076ba2e3bf44436\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/viewTransition.js\":\"b5371101b89f55ec\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/viewport.js\":\"44058497ea04411f\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/webLock.js\":\"72b63ed4e501d058\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/workspaceRecovery.js\":\"bd6ac23de4a9e2c5\",\"/knowledge-medium/pr-preview/pr-1882/src/utils/workspaceSnapshotStore.js\":\"d9888d62a50b6c82\",\"/knowledge-medium/pr-preview/pr-1882/src/vendor/react-compiler-runtime.js\":\"3edb153160d815fc\",\"/knowledge-medium/pr-preview/pr-1882/src/vendor/react-dom-client.js\":\"d76f803a94081189\",\"/knowledge-medium/pr-preview/pr-1882/src/vendor/react-dom-server-edge.js\":\"5ce28e7039beff7d\",\"/knowledge-medium/pr-preview/pr-1882/src/vendor/react-dom-server.js\":\"f8351643f6008af8\",\"/knowledge-medium/pr-preview/pr-1882/src/vendor/react-dom-static-edge.js\":\"c21b351cb2394717\",\"/knowledge-medium/pr-preview/pr-1882/src/vendor/react-dom-static.js\":\"dd8bcab4b6c70253\",\"/knowledge-medium/pr-preview/pr-1882/src/vendor/react-dom-test-utils.js\":\"b656bdeba1559bd7\",\"/knowledge-medium/pr-preview/pr-1882/src/vendor/react-dom.js\":\"462980126065d4e0\",\"/knowledge-medium/pr-preview/pr-1882/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1882/src/vendor/react-jsx-runtime.js\":\"7bc2422de16fbf16\",\"/knowledge-medium/pr-preview/pr-1882/src/vendor/react.js\":\"ad5bea202cd54aae\",\"/knowledge-medium/pr-preview/pr-1882/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1882/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1882/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
