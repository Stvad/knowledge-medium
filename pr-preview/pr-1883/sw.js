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
		buildId: "8bfd1784f623-9fb2024f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1883/\":\"658b0015a0c5ed7a\",\"/knowledge-medium/pr-preview/pr-1883/index.html\":\"658b0015a0c5ed7a\",\"/knowledge-medium/pr-preview/pr-1883/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1883/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1883/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1883/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1883/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1883/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1883/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1883/assets/FacadeVFS-BgQWkbkS.js\":\"d7261e5c62b85ecd\",\"/knowledge-medium/pr-preview/pr-1883/assets/OPFSCoopSyncVFS-7R-1ZRyA.js\":\"61db6bf160878f8f\",\"/knowledge-medium/pr-preview/pr-1883/assets/OPFSWriteAheadVFS-Q-umpHMw.js\":\"ca52f33072e6425b\",\"/knowledge-medium/pr-preview/pr-1883/assets/wa-sqlite-B8VU6dLD.js\":\"7ea3be248387652d\",\"/knowledge-medium/pr-preview/pr-1883/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1883/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1883/assets/wa-sqlite-async-BiSolIMw.js\":\"01d3e8c127805a1c\",\"/knowledge-medium/pr-preview/pr-1883/assets/worker-T8ZLQy8T.js\":\"09fbaa9385c94ca2\",\"/knowledge-medium/pr-preview/pr-1883/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1883/chunks/app-DKd4PQgU.js\":\"52ffc20afce2ae58\",\"/knowledge-medium/pr-preview/pr-1883/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1883/index.js\":\"ae3b140373521164\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1883/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1883/assets/AccessHandlePoolVFS-DltcYOMC.js\":\"c5061fd3da1778fe\",\"/knowledge-medium/pr-preview/pr-1883/assets/IDBBatchAtomicVFS-CyIK4t9R.js\":\"0fee92822f3d785c\",\"/knowledge-medium/pr-preview/pr-1883/assets/MemoryVFS-DgsPMA8C.js\":\"f31d0d81091bc4af\",\"/knowledge-medium/pr-preview/pr-1883/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1883/assets/mc-wa-sqlite-DJNsj4mX.js\":\"7b874da1c564d794\",\"/knowledge-medium/pr-preview/pr-1883/assets/mc-wa-sqlite-async-DSfUcflP.js\":\"b41c8ac02bebdbd7\",\"/knowledge-medium/pr-preview/pr-1883/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1883/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1883/chunks/AccessHandlePoolVFS-9p0H7iiH.js\":\"5acfae69437b35b2\",\"/knowledge-medium/pr-preview/pr-1883/chunks/FacadeVFS-Cd2kKi2X.js\":\"1b92c9a50bc0d236\",\"/knowledge-medium/pr-preview/pr-1883/chunks/IDBBatchAtomicVFS-CtpWseBr.js\":\"493b077bed53ec50\",\"/knowledge-medium/pr-preview/pr-1883/chunks/MemoryVFS-CazYyRYS.js\":\"c7ac0afa052d61ff\",\"/knowledge-medium/pr-preview/pr-1883/chunks/OPFSCoopSyncVFS-BYALKTA6.js\":\"1fc3e23d730f2acb\",\"/knowledge-medium/pr-preview/pr-1883/chunks/OPFSWriteAheadVFS-DjJYhRAx.js\":\"fca3e896f8859081\",\"/knowledge-medium/pr-preview/pr-1883/chunks/Preview-CxQXT-Uc.js\":\"6522a9fcf37940fd\",\"/knowledge-medium/pr-preview/pr-1883/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1883/chunks/card-Dzgcog18.js\":\"0d2b510988167676\",\"/knowledge-medium/pr-preview/pr-1883/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1883/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1883/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1883/chunks/dist-Z4CKoFjo.js\":\"e0768d1466e245f1\",\"/knowledge-medium/pr-preview/pr-1883/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1883/chunks/mc-wa-sqlite-CD11vUf_.js\":\"b352b118359331b1\",\"/knowledge-medium/pr-preview/pr-1883/chunks/mc-wa-sqlite-async-Dq7R4NN5.js\":\"1de07d076eaf573c\",\"/knowledge-medium/pr-preview/pr-1883/chunks/react-B5BguyiM.js\":\"ce40fe9d0c61be55\",\"/knowledge-medium/pr-preview/pr-1883/chunks/react-CGGwM9s-.js\":\"8254e0bd5771a414\",\"/knowledge-medium/pr-preview/pr-1883/chunks/react-CghwTJiS.js\":\"6dc1d1471c06000a\",\"/knowledge-medium/pr-preview/pr-1883/chunks/react-CixOdn6h.js\":\"ab9e9b5ba53ef541\",\"/knowledge-medium/pr-preview/pr-1883/chunks/react-DNCXIisM.js\":\"07527c8c80d4e43e\",\"/knowledge-medium/pr-preview/pr-1883/chunks/react-YRCvC-Iu.js\":\"a15acb06f1fc7b35\",\"/knowledge-medium/pr-preview/pr-1883/chunks/react-ZpLN9tF1.js\":\"a9445936f1f7072d\",\"/knowledge-medium/pr-preview/pr-1883/chunks/react-dom-server-legacy.browser.production-CeQPeOa3.js\":\"cd7102a5ebfa9cc2\",\"/knowledge-medium/pr-preview/pr-1883/chunks/react-dom-server.browser.production-BCoQi3gF.js\":\"3dc82ef63f388013\",\"/knowledge-medium/pr-preview/pr-1883/chunks/react-dom-server.edge.production-97ohwYHH.js\":\"53aa4d2086b37c11\",\"/knowledge-medium/pr-preview/pr-1883/chunks/react-mttFlwCF.js\":\"e2526e4f13355660\",\"/knowledge-medium/pr-preview/pr-1883/chunks/server.browser-B-jEKaVj.js\":\"bb728414e7905c74\",\"/knowledge-medium/pr-preview/pr-1883/chunks/textarea-sxgK2cd2.js\":\"b4c32be2bf777e9e\",\"/knowledge-medium/pr-preview/pr-1883/chunks/ui-DbQbyRLG.js\":\"852472c157bbafdd\",\"/knowledge-medium/pr-preview/pr-1883/chunks/wa-sqlite-D6yh6keQ.js\":\"b4aeab256c19243c\",\"/knowledge-medium/pr-preview/pr-1883/chunks/wa-sqlite-async-CjdZPZiy.js\":\"df0e74077ae49350\",\"/knowledge-medium/pr-preview/pr-1883/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1883/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1883/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1883/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1883/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1883/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1883/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1883/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1883/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1883/src/App.js\":\"988d3b018e9a562c\",\"/knowledge-medium/pr-preview/pr-1883/src/appUpdate.js\":\"297e9520f5572e2d\",\"/knowledge-medium/pr-preview/pr-1883/src/appVersion.js\":\"e36b9554acb5a1e8\",\"/knowledge-medium/pr-preview/pr-1883/src/bootstrap/initialLayout.js\":\"1082bf8b7e03d696\",\"/knowledge-medium/pr-preview/pr-1883/src/bootstrap/openWorkspaceData.js\":\"03ca07d6b029b6dd\",\"/knowledge-medium/pr-preview/pr-1883/src/bootstrap/resolveWorkspace.js\":\"3f01178e696392eb\",\"/knowledge-medium/pr-preview/pr-1883/src/bootstrap/workspaceBootstrap.js\":\"cec86a55c805b780\",\"/knowledge-medium/pr-preview/pr-1883/src/components/BlockComponent.js\":\"36440b1bc96f29f0\",\"/knowledge-medium/pr-preview/pr-1883/src/components/BlockCrumbs.js\":\"3057d4dea53082c9\",\"/knowledge-medium/pr-preview/pr-1883/src/components/BlockEditor.js\":\"4f00ae7754f1ea32\",\"/knowledge-medium/pr-preview/pr-1883/src/components/BlockLoadingPlaceholder.js\":\"1c2d6b22534acb88\",\"/knowledge-medium/pr-preview/pr-1883/src/components/BlockProperties.js\":\"dcada1d6294d4e8f\",\"/knowledge-medium/pr-preview/pr-1883/src/components/BlockSearchPicker.js\":\"33837578c65772ef\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ConfirmBulkDeleteDialog.js\":\"d9ad8f25436061a1\",\"/knowledge-medium/pr-preview/pr-1883/src/components/DividerHandle.js\":\"50c38ebd135a0948\",\"/knowledge-medium/pr-preview/pr-1883/src/components/DraftEditor.js\":\"80099298180a355a\",\"/knowledge-medium/pr-preview/pr-1883/src/components/GutterPill.js\":\"24ddd06d51de12a2\",\"/knowledge-medium/pr-preview/pr-1883/src/components/Header.js\":\"3d1d6de84a684717\",\"/knowledge-medium/pr-preview/pr-1883/src/components/LazyBlockComponent.js\":\"3fbd885f0f03ca17\",\"/knowledge-medium/pr-preview/pr-1883/src/components/Login.js\":\"d6f7b81939b8f137\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ZoomableSurface.js\":\"f219c6b1c1345fe4\",\"/knowledge-medium/pr-preview/pr-1883/src/components/editModeKeepalive.js\":\"fec7da3d33a7e189\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8a302f64a08de095\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"84290112dfc4d638\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyEditors/RefPropertyEditor.js\":\"f34dc484dbbf94ed\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyEditors/RefTargetTypePicker.js\":\"2fe1f8e868a2cce6\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyEditors/SelectPropertyEditor.js\":\"89004737c3b62e4d\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyEditors/TypesPropertyEditor.js\":\"fd9c84581f52f956\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyEditors/defaults.js\":\"73f27cc3eb4e0741\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyEditors/kernelValuePresets.js\":\"2ca4643f59749ac9\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyEditors/selectablePresets.js\":\"b3d790f7f214a64c\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyEditors/typesPropertyUi.js\":\"afb842bf27e28192\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyPanel/AddPropertyForm.js\":\"876ede6a34f6c8c5\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyPanel/PropertyPicker.js\":\"5f1c1ff3355ed9fd\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyPanel/PropertyRow.js\":\"2ed57381210bddd3\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyPanel/Rows.js\":\"7bea52eda0f1e23c\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyPanel/actions.js\":\"22a325dbccb88ff0\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyPanel/declarationOnly.js\":\"4d4b4dac2ec0b22f\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyPanel/layout.js\":\"d9581fda4cd08437\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyPanel/model.js\":\"013bd612f37ad155\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyPanel/shapeUi.js\":\"72c713530b85afae\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyPanel/shapes.js\":\"212bd216834ec79f\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyPanel/usePropertyEditingActivation.js\":\"00b4c4045191c794\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyPanel/visibility.js\":\"57a21fda0d02b188\",\"/knowledge-medium/pr-preview/pr-1883/src/components/propertyPanelSections.js\":\"1fb5f7248948af64\",\"/knowledge-medium/pr-preview/pr-1883/src/components/references/BlockEmbed.js\":\"482da69c225ec202\",\"/knowledge-medium/pr-preview/pr-1883/src/components/references/BlockLink.js\":\"628ff93a859e2a3a\",\"/knowledge-medium/pr-preview/pr-1883/src/components/references/BlockRef.js\":\"918d133690f16f3b\",\"/knowledge-medium/pr-preview/pr-1883/src/components/references/ReferenceLink.js\":\"69fc13a56e3d1809\",\"/knowledge-medium/pr-preview/pr-1883/src/components/references/cycleGuard.js\":\"275c54a6adc1cda1\",\"/knowledge-medium/pr-preview/pr-1883/src/components/references/cycleGuardContext.js\":\"0032a4ecf6dd0b18\",\"/knowledge-medium/pr-preview/pr-1883/src/components/references/linkInteraction.js\":\"bb1b42c8e66a8dd5\",\"/knowledge-medium/pr-preview/pr-1883/src/components/references/referenceLayout.js\":\"b81fc50d038ec60c\",\"/knowledge-medium/pr-preview/pr-1883/src/components/references/useBlockRefAncestors.js\":\"99036761bf9f87fa\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/BlockGutter.js\":\"01ebf61a3b154a9e\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/BlockInfoDialog.js\":\"161c06160ec0ed42\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/BlockTypeBlockRenderer.js\":\"219f80b0fb3149ef\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/BulletHoverCard.js\":\"f1e3bd2ea90a4c82\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/CodeMirrorContentRenderer.js\":\"35937c22c69f7937\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"a0ff48446f298c2a\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/ColumnResizeHandles.js\":\"ab714a8fbd9ea858\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"608804f5568fff87\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/DefaultBlockRenderer.js\":\"2085eafce9762837\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/LayoutRenderer.js\":\"d97ad3d4d5206cc8\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/MarkdownContentRenderer.js\":\"4f3b0269105690d6\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/MissingDataRenderer.js\":\"22f58c7c71b4a069\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/PanelRenderer.js\":\"71f0ab578bc652f9\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/PropertySchemaBlockRenderer.js\":\"211b87c7453f1f30\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/TopLevelRenderer.js\":\"6a5955f514412db6\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/blockGutterMode.js\":\"bdd3ab80ff358928\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/blockTitleText.js\":\"c777a5d9cdfeff09\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/fieldCreationKeydown.js\":\"61f422a6294e3110\",\"/knowledge-medium/pr-preview/pr-1883/src/components/renderer/layoutRootContext.js\":\"b241c9d7214e9f0b\",\"/knowledge-medium/pr-preview/pr-1883/src/components/typeChip/TypeChip.js\":\"2dbd5bba4ba55708\",\"/knowledge-medium/pr-preview/pr-1883/src/components/typeChip/chipStyle.js\":\"bd77710e7370fe1b\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/anchored-floating.js\":\"b54b68bf3c43f8af\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/button.js\":\"1a78aa44397cb64c\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/card.js\":\"c6d564d18419594f\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/checkbox.js\":\"06d5d9d55aabab61\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/collapsible.js\":\"a466595e5bea6c31\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/command.js\":\"3170f8f89b0df65b\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/context-menu.js\":\"9fbbb43be6cbc6b7\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/dialog.js\":\"1b36f62e2619e310\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/dropdown-menu.js\":\"cf8de746518490ea\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/floating-listbox.js\":\"0861ab87398500a2\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/index.js\":\"60e8e9b06d70bd44\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/input.js\":\"b704c80fe1088d69\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/kbd.js\":\"65081133adbaedbc\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/label.js\":\"dbfd6eee2e09543a\",\"/knowledge-medium/pr-preview/pr-1883/src/components/ui/textarea.js\":\"a7e160c2275505f8\",\"/knowledge-medium/pr-preview/pr-1883/src/components/useEditModeYieldKeepalive.js\":\"d378f7d070ec4317\",\"/knowledge-medium/pr-preview/pr-1883/src/components/util/BootFallback.js\":\"21e72f82db6095b8\",\"/knowledge-medium/pr-preview/pr-1883/src/components/util/FocusedRowLazyMount.js\":\"e8853750e09198a6\",\"/knowledge-medium/pr-preview/pr-1883/src/components/util/LazyViewportMount.js\":\"1b53a13599c8ad7c\",\"/knowledge-medium/pr-preview/pr-1883/src/components/util/LocalDbCorruptionFallback.js\":\"f56b1d57db4a5216\",\"/knowledge-medium/pr-preview/pr-1883/src/components/util/error.js\":\"503c0ad1deb70dfc\",\"/knowledge-medium/pr-preview/pr-1883/src/components/util/lazyMountRegistry.js\":\"33b84ad189294108\",\"/knowledge-medium/pr-preview/pr-1883/src/components/util/suspense.js\":\"2d6e6bbf2adfe523\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/CreateWorkspaceDialog.js\":\"6f98101a24ba15e0\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/PendingInvitations.js\":\"0548ab566fd48b3d\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/SyncProgress.js\":\"eb40f4496d24d7cf\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/UnlockProgress.js\":\"5352590b69fa8c63\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/WorkspaceKeyGate.js\":\"c9f5da0b1262298c\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/WorkspaceSettingsDialog.js\":\"09d78aa311353544\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/WorkspaceSwitcher.js\":\"4d2d7ba15698f85d\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/WorkspaceSyncGate.js\":\"f9fc4764a539189e\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/conversion/ConversionFlow.js\":\"8734fcf40876aa72\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/conversion/ConversionFlowHost.js\":\"949359ebb9a86269\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/conversion/EncryptionSection.js\":\"9c3ea18e0f398dd2\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/conversion/attachmentPrompts.js\":\"ab086a79b3c792e0\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a9d84cf292ea150e\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/conversion/conversionFlowDeps.js\":\"7d16c788932eaa1d\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/conversion/conversionFlowStore.js\":\"8bdd10f10d5ea6d8\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/conversion/flowUi.js\":\"4f3c95a5f1b26da7\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/conversion/useConversionRun.js\":\"29ffd8321bb9532a\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/keyUi.js\":\"726c35a62c2e4e93\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/useCloseOnKeyLoss.js\":\"2f2d782d4b64587d\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/useCloseOnServerE2ee.js\":\"7ce580d0570e85ee\",\"/knowledge-medium/pr-preview/pr-1883/src/components/workspace/workspaceUnlocked.js\":\"86069ce97ed02627\",\"/knowledge-medium/pr-preview/pr-1883/src/context/backgroundSubtree.js\":\"3f5bea89e2ed225a\",\"/knowledge-medium/pr-preview/pr-1883/src/context/block.js\":\"d6d0c8b8b08c4b8d\",\"/knowledge-medium/pr-preview/pr-1883/src/context/layoutWsContext.js\":\"54b87ec950b4acca\",\"/knowledge-medium/pr-preview/pr-1883/src/context/propertyDisplay.js\":\"f065519c3a79a617\",\"/knowledge-medium/pr-preview/pr-1883/src/context/repo.js\":\"83702c6fed9252f7\",\"/knowledge-medium/pr-preview/pr-1883/src/data/aliasClaim.js\":\"4aef8bf0b7df8921\",\"/knowledge-medium/pr-preview/pr-1883/src/data/aliasSeatNamespace.js\":\"f360af4a4dd5c28e\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/blockData.js\":\"2b2c883c091d2083\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/blockType.js\":\"cd762e90e2a869f5\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/changeScope.js\":\"f259786c1117aa3d\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/codecs.js\":\"b8f364dcf40ee408\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/derivedData.js\":\"ed893fe8d3e76e00\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/errors.js\":\"e96c37954f396984\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/events.js\":\"f9714e2fb1e8508a\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/handle.js\":\"5728e571e06809e9\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/index.js\":\"3b8fc24312b7cab1\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/mutator.js\":\"1852ce0a8462713b\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/processor.js\":\"d298eb4d075fd855\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/propertySchema.js\":\"e6d089d806aafb4d\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/query.js\":\"5f367719c039becc\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/sameTxProcessor.js\":\"8e1bf39d5664efe0\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/schema.js\":\"5728e571e06809e9\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/tx.js\":\"5728e571e06809e9\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/typedBlockQuery.js\":\"676f502dd846893e\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/user.js\":\"3b368b5f7eb24419\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/valuePresetCore.js\":\"5029aa86980121cf\",\"/knowledge-medium/pr-preview/pr-1883/src/data/api/valuePresets.js\":\"611cd4f1a5a5b7ad\",\"/knowledge-medium/pr-preview/pr-1883/src/data/attachmentCleanerIOVerb.js\":\"88e627104ade8c43\",\"/knowledge-medium/pr-preview/pr-1883/src/data/block.js\":\"f43ccc605b67abc8\",\"/knowledge-medium/pr-preview/pr-1883/src/data/blockCache.js\":\"ffc523a3d9eee8c9\",\"/knowledge-medium/pr-preview/pr-1883/src/data/blockId.js\":\"a215fb821e71c254\",\"/knowledge-medium/pr-preview/pr-1883/src/data/blockLiveness.js\":\"f90745069c63733c\",\"/knowledge-medium/pr-preview/pr-1883/src/data/blockMerge.js\":\"aea8528008d1a8d0\",\"/knowledge-medium/pr-preview/pr-1883/src/data/blockSchema.js\":\"b69ddfa4456ee20c\",\"/knowledge-medium/pr-preview/pr-1883/src/data/blockTypeLookup.js\":\"3820d8ad7fa6d045\",\"/knowledge-medium/pr-preview/pr-1883/src/data/blockTypes.js\":\"b1622d36fd0a9f39\",\"/knowledge-medium/pr-preview/pr-1883/src/data/childrenView.js\":\"457d74d85144fbc1\",\"/knowledge-medium/pr-preview/pr-1883/src/data/clientContext.js\":\"dc0810977cb67090\",\"/knowledge-medium/pr-preview/pr-1883/src/data/dbFileSiblings.js\":\"fc83b80cac1287fe\",\"/knowledge-medium/pr-preview/pr-1883/src/data/definitionSeeds.js\":\"13e8a3d0eb11c1fc\",\"/knowledge-medium/pr-preview/pr-1883/src/data/derivedIds.js\":\"a9d0e1a34b3b5324\",\"/knowledge-medium/pr-preview/pr-1883/src/data/drawnSubtree.js\":\"b0eb4b4a2fbcb5c6\",\"/knowledge-medium/pr-preview/pr-1883/src/data/facetBridge.js\":\"f382114e3a5e1deb\",\"/knowledge-medium/pr-preview/pr-1883/src/data/facets.js\":\"b1ecf156fe0dbd36\",\"/knowledge-medium/pr-preview/pr-1883/src/data/globalState.js\":\"367b94fcd7bbaba7\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/aliasClaimRederiveProcessor.js\":\"8a66671a4413820a\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/ancestorBatch.js\":\"3e8fa046cb9699fa\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/blockTypeTypeifyProcessor.js\":\"7db5dee04ebd579b\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/clientSchema.js\":\"37055d7ecd00d5aa\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/commitPipeline.js\":\"2ce014b34f5da0ac\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/devAssertions.js\":\"6f2d0585325a743b\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/firstSync.js\":\"5abff79c1be08853\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/freshInitialLoad.js\":\"e8545ffd2b494b09\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/graphBackfillClaim.js\":\"b849ccf8e5c1dd51\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/handleStore.js\":\"0fc4c23df1dec8d5\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/idleMarkerJobs.js\":\"2898ffc8c9560cc9\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/initialDownload.js\":\"bd83d1b79b1fd033\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/initializeClientDatabase.js\":\"a0deda24066c26d2\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/jsonCanonical.js\":\"9f0a90d118e465eb\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/kernelInvalidation.js\":\"8d9d3f0b31cb1d13\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/kernelProcessors.js\":\"05ec9cc45a3b6c9b\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/kernelQueries.js\":\"167efeb17dfdce5a\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/mergeTypeMembershipProcessor.js\":\"656d3294fca0ee8b\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/normalizeReferencesProcessor.js\":\"575afc0e0fcdd4d9\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/poolInstrumentation.js\":\"dbb19e44a35abbb6\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/processorRunner.js\":\"c118d49590d1e399\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/propertyCellBackfill.js\":\"d28dbb44843002a9\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/propertyChildMint.js\":\"7abd66cae8a2b548\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/propertyChildrenProcessor.js\":\"81dfc301caed81c9\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/propertyDefinitionChangeProcessor.js\":\"ce21f6435554cc54\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/propertyDefinitionSynthesis.js\":\"9f8f57bf071d5660\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/propertyKeyScan.js\":\"16d55cd3fbb964e9\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/propertySchemaResolution.js\":\"3caa1361943638f0\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/propertyValueEdits.js\":\"c85396dd83013d71\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/raiseProtocol.js\":\"676a2a3e74978bec\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/readBatch.js\":\"8974fe458d0aa509\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/refProjection.js\":\"3489592279754e57\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/referenceTargetLookups.js\":\"00b91d02be441639\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/referenceTargetProcessor.js\":\"4f00fde4839be47c\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/replayMerge.js\":\"a4afeb1223f62afe\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/sqlBinds.js\":\"e7f840540149b2a7\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"5b5c8a1393cf9fa5\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/syncObserver/arrivalProcessors.js\":\"043cf34f9f6bf860\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/syncObserver/invalidate.js\":\"a4cdaeab91cc4a33\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/syncObserver/materialize.js\":\"12139ec6e3427a99\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/syncObserver/observer.js\":\"79d65117c2b19fcf\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/syncObserver/reconcile.js\":\"634b3a440ece66c3\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/timingMetrics.js\":\"74c7a596431746fb\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/treeQueries.js\":\"9d904bc8c7dbb562\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/txEngine.js\":\"98200b3e274c1848\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/txSnapshots.js\":\"f8029353a3432b53\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/typedBlockQuery.js\":\"aabf5923bce42e94\",\"/knowledge-medium/pr-preview/pr-1883/src/data/internals/undoManager.js\":\"03fbc7c92538e032\",\"/knowledge-medium/pr-preview/pr-1883/src/data/invalidation.js\":\"267c2dcbbca4a512\",\"/knowledge-medium/pr-preview/pr-1883/src/data/kernelDataExtension.js\":\"1ff22cdddfb30a8a\",\"/knowledge-medium/pr-preview/pr-1883/src/data/kernelPage.js\":\"5d5a08d4c4bb3fc7\",\"/knowledge-medium/pr-preview/pr-1883/src/data/kernelValuePresetCores.js\":\"bee6926901db3185\",\"/knowledge-medium/pr-preview/pr-1883/src/data/localDbCorruptionSignal.js\":\"cee094aa3e38348a\",\"/knowledge-medium/pr-preview/pr-1883/src/data/localDbStorage.js\":\"fa4b31c45b6b7203\",\"/knowledge-medium/pr-preview/pr-1883/src/data/localDbVfs.js\":\"27919749a9922f14\",\"/knowledge-medium/pr-preview/pr-1883/src/data/localSchema.js\":\"f1baf995fd59acdf\",\"/knowledge-medium/pr-preview/pr-1883/src/data/maintenance.js\":\"f44d82a45679e532\",\"/knowledge-medium/pr-preview/pr-1883/src/data/mergeProperties.js\":\"ca588ba28fdbf96d\",\"/knowledge-medium/pr-preview/pr-1883/src/data/metricsConsoleHook.js\":\"a63148c616a641ac\",\"/knowledge-medium/pr-preview/pr-1883/src/data/migrationsPage.js\":\"303192d615d9aac6\",\"/knowledge-medium/pr-preview/pr-1883/src/data/mutators.js\":\"4da14b84234cf96c\",\"/knowledge-medium/pr-preview/pr-1883/src/data/orderKey.js\":\"e225a9b5f4293259\",\"/knowledge-medium/pr-preview/pr-1883/src/data/orderKeyPlacement.js\":\"092af3e06b0cb958\",\"/knowledge-medium/pr-preview/pr-1883/src/data/outlineSurface.js\":\"e185211b297f7c04\",\"/knowledge-medium/pr-preview/pr-1883/src/data/pendingEditorContent.js\":\"adb64534f0d0fe81\",\"/knowledge-medium/pr-preview/pr-1883/src/data/pendingUploadsSql.js\":\"99328bba24b1b416\",\"/knowledge-medium/pr-preview/pr-1883/src/data/pluginStateExtensions.js\":\"f5be5d8294108b58\",\"/knowledge-medium/pr-preview/pr-1883/src/data/powerSyncLogger.js\":\"cb5bf48df3d63c79\",\"/knowledge-medium/pr-preview/pr-1883/src/data/projectorRuntime.js\":\"4c2761ffb1472ac8\",\"/knowledge-medium/pr-preview/pr-1883/src/data/properties.js\":\"ed132f96ee75e5fc\",\"/knowledge-medium/pr-preview/pr-1883/src/data/propertiesPage.js\":\"04c6ab29a28d96b1\",\"/knowledge-medium/pr-preview/pr-1883/src/data/propertyChildren.js\":\"9952ce3a436c03f6\",\"/knowledge-medium/pr-preview/pr-1883/src/data/propertyDefinitionFanout.js\":\"26b6ec31892c02af\",\"/knowledge-medium/pr-preview/pr-1883/src/data/propertyDefinitionMetadata.js\":\"6c08fd91ec638ce1\",\"/knowledge-medium/pr-preview/pr-1883/src/data/propertyDefinitionRegistry.js\":\"d9d46d17cc9a1dd1\",\"/knowledge-medium/pr-preview/pr-1883/src/data/propertyDisplayMode.js\":\"c3455a1608c17973\",\"/knowledge-medium/pr-preview/pr-1883/src/data/propertyRowCreation.js\":\"fad743bb1f8a7169\",\"/knowledge-medium/pr-preview/pr-1883/src/data/propertySchemaCreation.js\":\"762a8c693e058ce6\",\"/knowledge-medium/pr-preview/pr-1883/src/data/propertySeeds.js\":\"96abdd312b75f013\",\"/knowledge-medium/pr-preview/pr-1883/src/data/recentsPage.js\":\"b408dd513b31b655\",\"/knowledge-medium/pr-preview/pr-1883/src/data/refTargetComparableProperty.js\":\"b52f47e5c19ee62f\",\"/knowledge-medium/pr-preview/pr-1883/src/data/referenceBlock.js\":\"e64f4ba2416146b1\",\"/knowledge-medium/pr-preview/pr-1883/src/data/rejectedUploads.js\":\"852fb367989f9005\",\"/knowledge-medium/pr-preview/pr-1883/src/data/releasePowerSyncConnection.js\":\"7324aec623d7b07a\",\"/knowledge-medium/pr-preview/pr-1883/src/data/repo.js\":\"20d5bcbe1bc1350d\",\"/knowledge-medium/pr-preview/pr-1883/src/data/repoProvider.js\":\"6b1a2da6b8922a21\",\"/knowledge-medium/pr-preview/pr-1883/src/data/rowProperty.js\":\"c9f7509f52efedf4\",\"/knowledge-medium/pr-preview/pr-1883/src/data/searchFilter.js\":\"a9321cc103bd0311\",\"/knowledge-medium/pr-preview/pr-1883/src/data/seedIdentityLedger.js\":\"4ec57cd4852ba933\",\"/knowledge-medium/pr-preview/pr-1883/src/data/stateBlocks.js\":\"4c15931a48d0244e\",\"/knowledge-medium/pr-preview/pr-1883/src/data/structuralEditPolicy.js\":\"347e26c81c4120b1\",\"/knowledge-medium/pr-preview/pr-1883/src/data/structuralInsert.js\":\"d4dbf665981dcb73\",\"/knowledge-medium/pr-preview/pr-1883/src/data/subtreeDelete.js\":\"c3e0b5c760c6a6e4\",\"/knowledge-medium/pr-preview/pr-1883/src/data/syncStreamLock.js\":\"5e3100e0e97c71aa\",\"/knowledge-medium/pr-preview/pr-1883/src/data/syncedTableSqlRecognizer.js\":\"f02839933ef25f9f\",\"/knowledge-medium/pr-preview/pr-1883/src/data/syncedTableWriteGuard.js\":\"8f6150c7805ec36c\",\"/knowledge-medium/pr-preview/pr-1883/src/data/targets.js\":\"84a3d3728f8d3c0f\",\"/knowledge-medium/pr-preview/pr-1883/src/data/typeColors.js\":\"7fa8ff2d83681179\",\"/knowledge-medium/pr-preview/pr-1883/src/data/typeDefinitionMetadata.js\":\"8297f5593e9e8980\",\"/knowledge-medium/pr-preview/pr-1883/src/data/typeDefinitionRegistry.js\":\"37421a396c64ffe9\",\"/knowledge-medium/pr-preview/pr-1883/src/data/typeExtraction.js\":\"b15a03b4988d53a9\",\"/knowledge-medium/pr-preview/pr-1883/src/data/typeInitialValues.js\":\"888af3ea81eecd8a\",\"/knowledge-medium/pr-preview/pr-1883/src/data/typePropertyGroups.js\":\"ba31df5e12e3a8c1\",\"/knowledge-medium/pr-preview/pr-1883/src/data/typeSeeds.js\":\"67c29129605a2655\",\"/knowledge-medium/pr-preview/pr-1883/src/data/typeTagger.js\":\"d52b7300a6ef494e\",\"/knowledge-medium/pr-preview/pr-1883/src/data/typedRecords.js\":\"5d86c1acb3d7467a\",\"/knowledge-medium/pr-preview/pr-1883/src/data/typesPage.js\":\"d0041f860bcb7297\",\"/knowledge-medium/pr-preview/pr-1883/src/data/userPrefs.js\":\"9fe33b6415679349\",\"/knowledge-medium/pr-preview/pr-1883/src/data/userSchemasService.js\":\"ae96c8d5d1fc1b97\",\"/knowledge-medium/pr-preview/pr-1883/src/data/userTypesService.js\":\"3fad714f22d7884b\",\"/knowledge-medium/pr-preview/pr-1883/src/data/valuePresetRegistry.js\":\"bdc4b45a2d6de186\",\"/knowledge-medium/pr-preview/pr-1883/src/data/visibleChildren.js\":\"afaf1d0ab4d85fbf\",\"/knowledge-medium/pr-preview/pr-1883/src/data/workspaceConversion.js\":\"37454922fe6a2878\",\"/knowledge-medium/pr-preview/pr-1883/src/data/workspaceFirstSync.js\":\"2a7f224df433c1a7\",\"/knowledge-medium/pr-preview/pr-1883/src/data/workspaceIdNamespace.js\":\"94bc82dac1fc87dc\",\"/knowledge-medium/pr-preview/pr-1883/src/data/workspaceSchema.js\":\"3c64bc59df2af3d4\",\"/knowledge-medium/pr-preview/pr-1883/src/data/workspaces.js\":\"f047e59a2de382f9\",\"/knowledge-medium/pr-preview/pr-1883/src/data/writeAheadLog.js\":\"cff104162e2a91be\",\"/knowledge-medium/pr-preview/pr-1883/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1883/src/editor/BlockPasteShellDecorator.js\":\"538c9304ae75bcb3\",\"/knowledge-medium/pr-preview/pr-1883/src/editor/atTrigger.js\":\"ad39b7ada6685dca\",\"/knowledge-medium/pr-preview/pr-1883/src/editor/autocomplete.js\":\"4297d89db49dd5ac\",\"/knowledge-medium/pr-preview/pr-1883/src/editor/codeMirrorExtensions.js\":\"3c7e0a18f61f6a3c\",\"/knowledge-medium/pr-preview/pr-1883/src/editor/contentFlush.js\":\"29d95c3b5bfa99e7\",\"/knowledge-medium/pr-preview/pr-1883/src/editor/defaultInteractions.js\":\"6d5187d6376201c7\",\"/knowledge-medium/pr-preview/pr-1883/src/editor/editSettleSignal.js\":\"4f109f4033c7caa2\",\"/knowledge-medium/pr-preview/pr-1883/src/editor/insertImage.js\":\"5daa869a07edf3a8\",\"/knowledge-medium/pr-preview/pr-1883/src/editor/referenceCompletionRange.js\":\"d94d8bec87c4a151\",\"/knowledge-medium/pr-preview/pr-1883/src/editor/referenceTargetTypes.js\":\"4e0ce8de793095f7\",\"/knowledge-medium/pr-preview/pr-1883/src/editor/syntaxContext.js\":\"ff1cf428579edb96\",\"/knowledge-medium/pr-preview/pr-1883/src/editor/triggerMatch.js\":\"35a531da32493e72\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/AppRuntimeProvider.js\":\"206f055a64cb5f5e\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/BlockFocusShellDecorator.js\":\"3ec9d20af9acf95e\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/ExtensionRenderBoundary.js\":\"a1dfd97e657d60b8\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/PanelContentRecovery.js\":\"b69f033871e74755\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/apiCatalog.js\":\"c74bb2f22f7d411b\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/approveExtensionHere.js\":\"e4bc7d9e69202e7c\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/armedCutAppMount.js\":\"501a4ac6c6510082\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/batchableKeyedStore.js\":\"35594a5cb2d82230\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/blockInteraction.js\":\"52771b975f2bb5a3\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/blockSelectionAction.js\":\"1f39f2ae4aa13db1\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/compileExtensionModule.js\":\"66f7e133fe6ebf74\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/compiledModuleCache.js\":\"99a3b6b3f91724c3\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/continuousGestures.js\":\"b2526e79cb4e98de\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/core.js\":\"7c6eeeb5b33f8a38\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/defaultRenderers.js\":\"c8e3f793b8766b89\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/definitionFanoutAppMount.js\":\"6adea580dd81e487\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/dialogAppMount.js\":\"326c6ebd48570117\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/dynamicExtensionSeeds.js\":\"2dbeb6c024a795bc\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/dynamicExtensions.js\":\"38eff0cc2fae670b\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/exampleExtensions.js\":\"9792a2f337a31a0f\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/extensionApprovalStatus.js\":\"74c828df919bc868\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/extensionLoadErrorToast.js\":\"bdd9db56ba838a8a\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/extensionLoadErrors.js\":\"7583894d0bb93665\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/extensionLookup.js\":\"e4ce3c7422e8b6ee\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/extensionToggles.js\":\"f0e1175434291db5\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/extensionUtilitiesCss.js\":\"994bb892a7b901b7\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/kernelPageDeletionGuard.js\":\"dcc9a7e85f60ce04\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/liveRuntime.js\":\"549c8c60ede7e916\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/openExtensionsSettings.js\":\"fda4e4c05836016f\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/overridesCache.js\":\"3279b6225abb7a35\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/pluginIds.js\":\"26fb0e66a082a8ca\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/processorRejectionToast.js\":\"ae69e7009e0fbbad\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/runtimeActions.js\":\"1c1b4ca2b99caece\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/runtimeContext.js\":\"14438aac1dcd20e3\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/staticAppExtensions.js\":\"f1a69e6e8b46c682\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/staticDataExtensions.js\":\"ae5eb3e43f750283\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/toastAppMount.js\":\"65d09314c58ac907\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/useOverrides.js\":\"358bf425e6497e66\",\"/knowledge-medium/pr-preview/pr-1883/src/extensions/useShortcutSurfaceActivations.js\":\"3f53505dcb499a0a\",\"/knowledge-medium/pr-preview/pr-1883/src/facets/discoverToggleTree.js\":\"10bfdbb796b0bf03\",\"/knowledge-medium/pr-preview/pr-1883/src/facets/facet.js\":\"741edcdfd73dd0f2\",\"/knowledge-medium/pr-preview/pr-1883/src/facets/resolveAppRuntime.js\":\"7fe0e6570b90bb1f\",\"/knowledge-medium/pr-preview/pr-1883/src/facets/runtimeEvents.js\":\"6bef7e8f5133d903\",\"/knowledge-medium/pr-preview/pr-1883/src/facets/togglable.js\":\"f06be0996a4e12e2\",\"/knowledge-medium/pr-preview/pr-1883/src/facets/variantFacet.js\":\"2d60b885522389ba\",\"/knowledge-medium/pr-preview/pr-1883/src/facets/verbFacet.js\":\"3a2f6571a8937902\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/block.js\":\"4d176a45a2aaae2e\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/focusedChild.js\":\"06f68c5d190817bb\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/propertySchemas.js\":\"a964f404e8e7ff91\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/typeRegistry.js\":\"b5379735096d8d03\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/useAncestorCrumbs.js\":\"1b92acd6cda42f26\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/useAutocompleteListbox.js\":\"cb9b2a8becbb34bd\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/useDebouncedSearch.js\":\"c7f3e244ca313735\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/useDebouncedValue.js\":\"6ffaa512bc63635e\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/useFacetValue.js\":\"effc0b8a47785ea5\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/useIsFocalRender.js\":\"bb388c4782bde00a\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/useIsReadOnly.js\":\"b13d2728ec335cc4\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/useMaterializeBacklog.js\":\"3af635ab31fd6761\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/useMinuteClock.js\":\"288a1ddcb64cb65f\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/usePanelLayoutProjection.js\":\"9e446dee9ad36886\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/usePendingInvitations.js\":\"f4024c6a5d56d202\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/useRendererRegistry.js\":\"46939d9b99e91238\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/useRetainedFieldRows.js\":\"5ca77b8c1a95afe8\",\"/knowledge-medium/pr-preview/pr-1883/src/hooks/useWorkspaces.js\":\"897eff7dbf4c4e7d\",\"/knowledge-medium/pr-preview/pr-1883/src/lib/utils.js\":\"87dfdfdb3556a08e\",\"/knowledge-medium/pr-preview/pr-1883/src/main.js\":\"f71baf8af030e0f8\",\"/knowledge-medium/pr-preview/pr-1883/src/markdown/MarkdownImage.js\":\"486af8e00d56639c\",\"/knowledge-medium/pr-preview/pr-1883/src/markdown/blockSeparators.js\":\"e58240fe54368f40\",\"/knowledge-medium/pr-preview/pr-1883/src/markdown/context.js\":\"207ed211c56ec745\",\"/knowledge-medium/pr-preview/pr-1883/src/markdown/defaultMarkdownExtension.js\":\"2d68aa2409181b4d\",\"/knowledge-medium/pr-preview/pr-1883/src/markdown/extensions.js\":\"02cf1bb5c7cbf6c5\",\"/knowledge-medium/pr-preview/pr-1883/src/markdown/renderMarkdownHtml.js\":\"d14390dfa829240f\",\"/knowledge-medium/pr-preview/pr-1883/src/minimal-editor.js\":\"a11ffb9caa8b7093\",\"/knowledge-medium/pr-preview/pr-1883/src/paste/armedCut.js\":\"007cf69d54c70e4b\",\"/knowledge-medium/pr-preview/pr-1883/src/paste/captureMediaVerb.js\":\"1208203aee86703f\",\"/knowledge-medium/pr-preview/pr-1883/src/paste/clipboard.js\":\"ea18e132260b47f8\",\"/knowledge-medium/pr-preview/pr-1883/src/paste/decision.js\":\"146f964aa846eedc\",\"/knowledge-medium/pr-preview/pr-1883/src/paste/operations.js\":\"089f113c8f115f77\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/account-header/AccountHeaderItem.js\":\"a6304ead96b2c0b3\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/account-header/index.js\":\"b83fea424eb7d124\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c367a9e8d1f5d040\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-dispatch-companion/askAgent.js\":\"2e8e229e537d873f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-dispatch-companion/askedStore.js\":\"926dcbdfac98e279\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"11c4e1ed3eae5ce1\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-dispatch-companion/chipState.js\":\"865e867f082f74db\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-dispatch-companion/dataExtension.js\":\"5b88189c3239f78a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-dispatch-companion/index.js\":\"7cf969ed129551ee\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"937fedf9ab9f176b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-dispatch-companion/schema.js\":\"7dd7753e45e824d4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/AgentTokensDialog.js\":\"9ea4cb89aa43914f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/BridgePairingDialog.js\":\"84b9c35c973af874\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/addMedia.js\":\"685c1e5f2164c857\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3581d5962cab8c94\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentViews/block.js\":\"65f2e55b6cfc9e8a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentViews/context.js\":\"5ceffcb926da30d4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentViews/displayIds.js\":\"0a95756f21af04e4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentViews/index.js\":\"f607477bff1c9e71\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentViews/outline.js\":\"3bc064ec89bbb6dd\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentViews/properties.js\":\"1f4c0c8adddac1ff\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentViews/refs.js\":\"5fbbb38c4580f90f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"671915d896aee08a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentViews/search.js\":\"1726675564bb666a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentViews/shared.js\":\"af5da4b8e3436ddd\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"50d466b462403c9a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentViews/text.js\":\"21dcb08942ad1e6c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/agentWrites.js\":\"73deb9ebf93bb0e7\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/authoringCatalog.js\":\"b7a227a045f2be84\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/blockRefTargets.js\":\"c32701d5abe9bf32\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/bridge.js\":\"96dada80aaf52488\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/bridgeLoop.js\":\"796255a940a1f4ac\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/changeHistory.js\":\"b7f5ef9417408f95\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/commands.js\":\"b7c07a70c89556ee\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/commentsCommands.js\":\"a7becc4e3dec209d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/dataExtension.js\":\"d0dc533de728c123\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/dataModelGuide.js\":\"b85831e136124313\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/dayPropertyInputs.js\":\"2b1eb7e85b9a4212\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/describeRuntime.js\":\"c47d05384c369a94\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/extensionLint.js\":\"b7233d3824136752\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/grainAudit.js\":\"303ae28982d183de\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/healthCommand.js\":\"a7ec59481d62e411\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/index.js\":\"5180775714808c26\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/presetIdentity.js\":\"a4afb9ada8b00de7\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"3fa9f497ebc749c5\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/readMedia.js\":\"3908878d34ffeb2e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/schema.js\":\"4e101782e3fe599a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/serialization.js\":\"402b0e500125f06f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/targets.js\":\"3acd8d0630954417\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/tokens.js\":\"e2ba84094dc8d229\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/watchEvents.js\":\"b3b0849a41387a3b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/workspaceGuard.js\":\"02169873e19080db\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/agent-runtime/writeCommands.js\":\"e68d072ce4cc08df\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/alias/AliasCollisionToast.js\":\"d23115b95e47e3fa\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/alias/DuplicateNameBanner.js\":\"ee86a3bcaafb504c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/alias/collisionMerge.js\":\"27857420685cb639\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/alias/dataExtension.js\":\"3efb2bbde4421269\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/alias/index.js\":\"a184a31fb34b9f21\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/alias/mergeCollisionAction.js\":\"28b5f65f603360db\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/alias/pageStyling.js\":\"21d6dd74275223e9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/alias/rejectionToast.js\":\"9722973997f52dc6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/alias/syncProcessor.js\":\"2c46007c6ec49308\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/actions.js\":\"7b1fde807640802d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/addComment.js\":\"f8fc1933fd87965a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/anchor.js\":\"116e308b14d0aa48\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/anchorState.js\":\"ce703e5ce942bc95\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/commentLinks.js\":\"e245cdd2ae602ad0\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/confirmThreadDeletion.js\":\"8181f397bed7cd96\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/container.js\":\"0beb38748d4c1c72\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/dataExtension.js\":\"aa31ad43abd75604\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/deleteComment.js\":\"52935b43b6423823\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/highlights.js\":\"6dd56503bccc6485\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/index.js\":\"677ae4e2ad08fdc0\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/linkedCommentsPill.js\":\"39aabeb810d4e3e2\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/margin.js\":\"ce288be89c604788\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/marginAnchorLinks.js\":\"8f628d4a0fe03486\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/marginSchema.js\":\"21d3e13d27544b8c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/newComment.js\":\"753014bb5fdd0f6c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/ownThreadPicker.js\":\"6a405fc9e270e390\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/placement.js\":\"399ba63910b138b9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/queries.js\":\"b26ccffd31c7cce3\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/quotePosition.js\":\"6075207e5b5e1275\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/quotedIn.js\":\"30b7be5b1ebc0ce5\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/quotedRange.js\":\"94449795c0bd26a4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/rangeRefs.js\":\"3bf3019f17bccc70\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/readHighlights.js\":\"30e85cfcecd414ec\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/readSelection.js\":\"14cc82e502b8a89b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/readSelectionUi.js\":\"19ca6be3e589cc17\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/reanchor.js\":\"0a5fa089052fe4bd\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/schema.js\":\"df55bde8ba694ebf\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/scope.js\":\"a25bf3d702eab35b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/scopeThreads.js\":\"f24195d4b6bb4eb9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/splitRetarget.js\":\"8500ce04ceeec704\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/suggestionCard.js\":\"dbbd412402a2cd2f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/suggestions.js\":\"886ba5ddc68859d4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/summaries.js\":\"d446af706d08e796\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/summaryBatch.js\":\"89f5afda329487c1\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/surface.js\":\"2ed074d5cabfe606\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/threadNavigation.js\":\"ef0a8329926d852e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/threads.js\":\"98debc44477102e6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/ui.js\":\"4c67df89210b9e6b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/annotations/uiStore.js\":\"9cd8066dd06d5227\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/app-intents/appIntents.js\":\"f2f4df68872eb7d8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/app-intents/index.js\":\"6e9770b261282094\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/app-update-prompt/index.js\":\"6b58d0ab4a38b231\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/app-update-prompt/status.js\":\"2d195874f0018876\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a0397d9698959e49\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/MediaBlockRenderer.js\":\"7c3c451ca357e4fc\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/MediaDownLaneReplicator.js\":\"89112b0f9533ab07\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/MediaUploadReconciler.js\":\"faf344724399cf3a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/assetDownLane.js\":\"8767be1ca9d796e4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/assetResolver.js\":\"40b29e27a9b3bc18\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/assetUpload.js\":\"1d3fae376ef87260\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/attachmentCleanerIO.js\":\"a4d5b7502ab99310\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/audit/supabaseAuditIO.js\":\"cdb36083cd59b829\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/blobStore.js\":\"c5e4015b852f7e62\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/browserMedia.js\":\"291c6b2aa303623e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/byteStore.js\":\"24efbfabdd59085f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/cleanerIO.js\":\"a2fd03704cd1e87a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/cleanupAttachments.js\":\"3cdfca5d6923c2e4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/dataExtension.js\":\"6e04fe0e5b1efe92\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/downLane.js\":\"60b92e247701b93c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/index.js\":\"67a7b83bdd1b05a9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/insertImageContribution.js\":\"4858e638ce5ef36d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/laneArming.js\":\"ba0e0ceb3f2d84bf\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/laneLock.js\":\"3220271e9b8e1113\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/mediaBlock.js\":\"d16dcb35dda8ae35\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/mediaCapture.js\":\"128928f41c834db4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/mediaLanes.js\":\"f380928923eb9248\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/mediaViewers.js\":\"1d080f0892b9319c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/mediaViewersFacet.js\":\"c9cf26191d645eb8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/pasteCapture.js\":\"89ac16a4411ff53e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/resolver.js\":\"dd3eff5ecfe86a43\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/retryUploadsAction.js\":\"68cbcf023cd045d9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/storagePaths.js\":\"f09bf1559ab25141\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/uploadDrain.js\":\"ac39bbf46e716df1\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/uploadLaneStatus.js\":\"ce19b7a8369f0e1d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/uploadReconcile.js\":\"a204712f1e0f92e8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/uploadRecovery.js\":\"5fa98139e546c405\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/uploadStore.js\":\"120eadf1f283bbef\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/attachments/useAssetObjectUrl.js\":\"ab110f35a25a48db\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f6c86c66ba923573\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks-view/BacklinksViewSection.js\":\"51f54ff453abc162\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks-view/facet.js\":\"435054e739ff9447\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks-view/index.js\":\"877c7ed60a007f54\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks-view/prop.js\":\"8a6d27e3eddb8a99\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/BacklinkFilters.js\":\"9d49890356a47e9c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a23681ed6d4a4501\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/BlockEntry.js\":\"00733b416ed79cdd\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/LinkedReferences.js\":\"048c4e3022ba124a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c5e9c65dc4211839\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/dailyNoteDefaults.js\":\"031961a65e803e9d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/dataExtension.js\":\"7a4741e1af6ae1ff\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/edgeExclusions.js\":\"76889c091f54d53c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/filterProperty.js\":\"336bd6a4233d0c9c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/index.js\":\"bc5cbf70540d8e52\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"3d0695cbc6c30c6c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/inline-counts/applies.js\":\"6bc32ee4f9ed2532\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/inline-counts/countQuery.js\":\"41a3159493789fa1\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/inline-counts/expansionStore.js\":\"48bfdc453af4445f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/inline-counts/index.js\":\"9048d932d7c294f7\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"797ea8d84c53bfb2\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/presentationInvalidation.js\":\"83b98fa4ba01806e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/propertyEditorOverride.js\":\"6ccbbadd6087fe1f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/propertyFilter.js\":\"812e6b63b5560596\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/query.js\":\"7b77ade01a4d8ffc\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/resolveFilter.js\":\"296a872ed81ce047\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/sourceBatch.js\":\"7199f3eb41470194\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/sources.js\":\"bfc0b95443de99ec\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/useBacklinks.js\":\"a8bdc1ca0fbde761\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"50751375c2b4d4c4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/birthday/BirthdayCelebration.js\":\"c25ee55a2348fd4c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/birthday/BirthdayOverlay.js\":\"58b0b651c9940314\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/birthday/gate.js\":\"3549cca49445e53c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/birthday/index.js\":\"b2562a6f902c21ed\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/birthday/wolfTheme.js\":\"74eec2296b663a5d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-drag/BlockDragLayer.js\":\"7ed40ed8e9a0a0f4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-drag/dragController.js\":\"411b2e27974fb079\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-drag/dropTarget.js\":\"848a8e8216e72c1c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-drag/index.js\":\"cfdf170a0b3bd08a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-drag/projection.js\":\"311b74cae44a6b9d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-info/BlockMetaCard.js\":\"17477d06428cc4d8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-info/index.js\":\"3d077540a91ba5ab\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-tagging/AddTagDialog.js\":\"d0d3ceebe4a6f0bc\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ce5a19a9a03ff2e5\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-tagging/TagNameIssueHint.js\":\"b7a4f86096070fcf\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-tagging/addTagAction.js\":\"64aacf0287f81bb5\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-tagging/appendTag.js\":\"6230ef6def74bb4e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-tagging/config.js\":\"219b07c7b7543703\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-tagging/dataExtension.js\":\"b91c46d7050ae45c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-tagging/index.js\":\"bbf247b92561a575\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/block-tagging/propertyEditorOverride.js\":\"ab6f8f7d30b147ac\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/breadcrumbs/BreadcrumbList.js\":\"56cc1ceddcc449a5\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"b143812181aa2155\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8472f9f9cdac8870\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"10a1eb189dffb74a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"60550e824eacb134\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/breadcrumbs/index.js\":\"b84e9857bbc89bb9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"bd2f049ac520980e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/character-counter/CharacterCountItem.js\":\"e924686f53e12d7f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/character-counter/ProfilePropertyEditor.js\":\"7857fdaa672883ae\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/character-counter/actions.js\":\"52f9973dfee8ab3e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/character-counter/blockType.js\":\"edcda5c54c1f88bf\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/character-counter/charCount.js\":\"45f1de101c67aac7\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/character-counter/dataExtension.js\":\"0dae9fa2f25755e0\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/character-counter/index.js\":\"2a5e1f384e597f59\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/character-counter/profiles.js\":\"5e87933875c23846\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/character-counter/properties.js\":\"af2f42359f1d4e18\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/character-counter/textCounts.js\":\"24d5af44c9f94a20\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/colemak-keybindings/index.js\":\"87feda343d14d213\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/command-palette/CommandPalette.js\":\"fa647cabeb022ea8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/command-palette/HeaderItem.js\":\"00e1c735c761a834\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/command-palette/context.js\":\"4f36a227908fcc20\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/command-palette/index.js\":\"44f29487200d780e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/command-palette/selection.js\":\"8bcd367224a30be7\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/command-palette/toggleStore.js\":\"e5ef71ec8f56bf3c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/command-palette/useCommandPaletteActions.js\":\"3416e8350b409bbc\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/contributors/ContributorBadges.js\":\"c075a5bf22993653\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/contributors/author.js\":\"12d1bb84a59c0d5b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/contributors/codeMirrorExtensions.js\":\"341c7aab3c3f29f8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/contributors/dataExtension.js\":\"2d2fa74b0c369b62\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/contributors/index.js\":\"e8658ae481b0ae90\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/contributors/mentionAutocomplete.js\":\"d9c959f53111e8a8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/contributors/processor.js\":\"e52f52a49fcc7216\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/contributors/profiles.js\":\"088b15805deb0787\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/contributors/queries.js\":\"906ef8260aadcc43\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/contributors/schema.js\":\"ac8edc9c45502850\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ffa29d31d5080556\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4550a7ea8b1307e4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/cursor-follows-scroll/index.js\":\"f8d4c63e6789c172\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6b054863628a0e9b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"3b077d244380da26\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/CalendarGrid.js\":\"7aceebb4e1463b4f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/DailyNotePicker.js\":\"788e5ea7f8363e00\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"cc0d59c7c0531b9f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/DateNavDecorator.js\":\"a36e58181f576cb2\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/DateScrubOverlay.js\":\"bb75c307ba2ee1c1\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/DayPropertyEditor.js\":\"66ca764486bb7d19\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/HeaderItem.js\":\"1b076c68fb4b6c98\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/ReschedulePicker.js\":\"35ae6acaf7f17ec2\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/SpreadDatesDialog.js\":\"baf166e736ad7e0a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/actions.js\":\"6dfec08b1f185e8c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/blockDateAdapter.js\":\"cf62469e26d78eef\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/calendar.js\":\"49e8ab1bebc52521\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/dailyNotes.js\":\"c4550543b868849f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/dataExtension.js\":\"a5fa0f3b6b5a628b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/dateScrubActions.js\":\"ee4cffc7a0002c69\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/dateScrubGesture.js\":\"4935dc3f907f1947\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/dateScrubGestureActions.js\":\"648306891bd7052e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/dateScrubRecognizer.js\":\"5ef0935c9e215b15\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/dayProperty.js\":\"74aa957b4db01aef\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/deletionGuard.js\":\"d0b3e656bf286b15\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/dueQuery.js\":\"d6e552ff287349bf\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/index.js\":\"6242a11d5d8f69b5\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/landing.js\":\"4845d9240a404ea8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/localSchema.js\":\"7bff373d7b69753d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/referenceDateAdapter.js\":\"0c9f8a0f0ad073c2\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/rescheduleAction.js\":\"7cf20530fd94e219\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/schema.js\":\"c8f03f218de0b883\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/spreadBlockDates.js\":\"f23930e2fcd3dda9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/spreadDatesAction.js\":\"d748a735208bc4f6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/today.js\":\"8bee86511aba3e74\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"dcd0fd4a99d80524\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"621d4cc378dd7592\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/data-integrity/audit.js\":\"04e44773671d7a58\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/data-integrity/auditAction.js\":\"4a44ca4e490834af\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/data-integrity/auditRanges.js\":\"f743a5ae4851850e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/data-integrity/diagnosticsSource.js\":\"7cb1fdcee37f15da\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/data-integrity/divergenceScan.js\":\"d46570f15265ff7e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/data-integrity/index.js\":\"5ef89782b68326c9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/data-integrity/propertyChildrenChecks.js\":\"66032760273e6bc4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/data-integrity/referencesMirror.js\":\"0ab0c2af82abcf3d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/data-integrity/rowJson.js\":\"4bea4d1359f94025\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/data-integrity/schedule.js\":\"0594c29af3b56e33\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/data-integrity/store.js\":\"1705e58d6fb5d3e0\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-maintenance/action.js\":\"07c1919a67768afa\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-maintenance/index.js\":\"11546f98df7e7daf\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-maintenance/plugin.js\":\"557221941e140b3c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"08ba1b3c01e433aa\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-mirror/actions.js\":\"8a768bef58fceeaf\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-mirror/changeMarker.js\":\"cbec679ba6e0ffb5\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-mirror/diagnostics.js\":\"7f837880f4c9c0d7\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-mirror/fileSystemAccess.js\":\"47eef2bff3bc7a56\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-mirror/filenames.js\":\"c466103742df0d3e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-mirror/index.js\":\"08565ee2a2a6dee2\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-mirror/mirror.js\":\"5a9ee9d0fd8c809a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-mirror/runLock.js\":\"b60c2da04979b7cb\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-mirror/runtimeHealth.js\":\"6152d5ffd3e77586\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-mirror/schedule.js\":\"2ea5d3a8312ed4df\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/db-mirror/store.js\":\"e942b4f52c1cb6a3\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/default-themes/index.js\":\"a85977c36a0e76f1\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/default-themes/themes.js\":\"b72127b49d9ce9a0\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/diagnostics/facet.js\":\"9635fce577fbe9be\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/diagnostics/useDiagnostics.js\":\"5ddb59dba43b2b38\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extension-prompts/dismissals.js\":\"cd6a29303d9c7b3c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extension-prompts/index.js\":\"930b01bde3d2958f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extension-prompts/status.js\":\"10a990c5b98dffb6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extension-prompts/store.js\":\"b10635a70b0992ca\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9cc78c0ca04b5221\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extensions-settings/ExtensionsSettings.js\":\"758d9f44d57967e2\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extensions-settings/actions.js\":\"f8d8248e6b86015c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extensions-settings/config.js\":\"6ea17f4b5ddc1d41\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extensions-settings/dataExtension.js\":\"d62305a1ea920a2d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extensions-settings/effect.js\":\"f3eb612829648b61\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extensions-settings/index.js\":\"b6bc62b9062c34dc\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extensions-settings/propertyEditorOverride.js\":\"43269970d0b5ecae\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extensions-settings/useToggleTree.js\":\"07d53732bf30763a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extract-type/ExtractTypeDialog.js\":\"51c4e7f07f02fc40\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f247e84a31a2933f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extract-type/PropertyShapePicker.js\":\"22a3c9403fe64321\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extract-type/action.js\":\"3955f7051c095573\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/extract-type/index.js\":\"ba4a56f1bffd20a3\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/find-replace/FindReplaceDialog.js\":\"d08495293abd87d6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/find-replace/HeaderItem.js\":\"ebb5c399a654d84d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/find-replace/dataExtension.js\":\"29fe723b7614fd50\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/find-replace/index.js\":\"91cfd419a595ee9e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/find-replace/search.js\":\"4ad61c97cef02be7\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/find-replace/toggleStore.js\":\"bbe00312d1751b7c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/LocationPropertyEditor.js\":\"599a6777909a394b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/MapView.js\":\"5cafcfbaa90d5214\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/blockTypes.js\":\"f0038b0a4eabab2d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/codeMirrorExtensions.js\":\"7d617e30022b64d7\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/createOrFindPlace.js\":\"0c5170760ac98d41\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/currentLocation.js\":\"d0450b75bbc5629c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/dataExtension.js\":\"c217e2b6db21cbef\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/geoContentDecorator.js\":\"1dd0e8987c5eb0f6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/googlePlacesClient.js\":\"54ed6d850077259b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/index.js\":\"13989df7334524d0\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/locationsPage.js\":\"de8280fd8a432083\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/mapViewport.js\":\"5478a355e57d5005\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/pickCurrentLocation.js\":\"7f2786f7628155a3\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/placeAutocomplete.js\":\"bcf7bb5af0cf7797\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/placeNameCollision.js\":\"2e3cf3d9371214d3\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/properties.js\":\"c77141d029191b86\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/propertyEditorOverrides.js\":\"2c20864aa47a647d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/query.js\":\"ac0d48cd1e2eef75\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/geo/usePlaceSearch.js\":\"0ada9ce4d4a44cda\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a0ea44b72bcb4cdb\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a7ed5578f7795c8a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"27fa236a132b5059\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/grouped-backlinks/config.js\":\"9bff0f650527d339\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/grouped-backlinks/dataExtension.js\":\"38eea05cd6916d2f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/grouped-backlinks/facet.js\":\"684bd19889130bfe\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/grouped-backlinks/grouping.js\":\"4645605f44178dbd\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/grouped-backlinks/index.js\":\"5ab9643c7298fbca\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"166b33cb5298b97b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/grouped-backlinks/query.js\":\"e30b5c4e397ea496\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/grouped-backlinks/resolveConfig.js\":\"3e22be00e8df01d8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"77ee089e215bbb72\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"dacb9068f4c412a6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/html-document/HtmlDocumentContent.js\":\"f208af8035c8c3c2\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/html-document/HtmlFrame.js\":\"dc735436f71c5cd3\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/html-document/actions.js\":\"a0fda03c9fd53d0c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/html-document/blockType.js\":\"863ab76022b2db35\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/html-document/confirmRunScripts.js\":\"80b6f1fcbc268099\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/html-document/dataExtension.js\":\"adc99f4ced597c9a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/html-document/frameAnnotations.js\":\"d12437d3f3525720\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/html-document/frameDocument.js\":\"8279abfdf73c63f4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/html-document/frameTheme.js\":\"68cb49ccc19189aa\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/html-document/index.js\":\"02e7185014f9ca58\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/html-document/scriptConsent.js\":\"6a9df0d29df5acc4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/html-document/sourceMap.js\":\"4a036180f28d4af2\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/html-document/useDocumentScripts.js\":\"5fee77591c99f8e4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/interaction-metrics/index.js\":\"fc0a0f38c3387760\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/interaction-metrics/record.js\":\"6e75a23f219b3808\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/interaction-metrics/recordStore.js\":\"84360a2f25818d9a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/interaction-metrics/responsiveness.js\":\"28efef740bb56ece\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/interaction-metrics/schedule.js\":\"fc7fb04970c260dd\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/interaction-metrics/sessionContext.js\":\"ddeed61088c0d5dd\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9c39e873f701a74f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"dae45289e368b4e8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/keybindings-settings/actions.js\":\"6649d26a786cd7b1\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/keybindings-settings/config.js\":\"3c3d43ce2fcbc651\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/keybindings-settings/dataExtension.js\":\"08e7d355c31187d4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/keybindings-settings/effect.js\":\"e213dcb42700bcd8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/keybindings-settings/index.js\":\"000608901b991466\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/keybindings-settings/keyCapture.js\":\"c8fe9ace7d978062\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/keybindings-settings/overrideStore.js\":\"cbf49646c8a87fb4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"43dd42978207f8e8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/left-sidebar/HeaderItem.js\":\"841aa61dd6bc5116\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/left-sidebar/LeftSidebar.js\":\"a38c831a1a7b6212\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/left-sidebar/actions.js\":\"b599fac24344e231\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/left-sidebar/facet.js\":\"2677f4548e18813d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/left-sidebar/index.js\":\"ad3b32d56e00bb65\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/left-sidebar/shortcuts.js\":\"fb9db4daec35c25a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/left-sidebar/toggleStore.js\":\"51d52584bf63c709\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/merge-blocks/MergePicker.js\":\"19bd7a92a5e65d74\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/merge-blocks/index.js\":\"fd8d0c7534b2de1a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/merge-blocks/mergeAction.js\":\"63df10633ab4773d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/merge-blocks/strategy.js\":\"68658861d316db8d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/mobile-bottom-nav/Button.js\":\"fe09c1d2ff8565cb\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5287e7c4f744d26f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a4249f737c1ddc42\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/mobile-bottom-nav/facet.js\":\"68dffb6c62d6f4fa\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/mobile-bottom-nav/index.js\":\"3190ddfcc1b06c84\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"3cc0ad4860986045\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/mobile-keyboard-toolbar/actions.js\":\"9204fc406bd3a2ca\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f21cd8e7e98c9314\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/mobile-keyboard-toolbar/facet.js\":\"4e171edfb558edcd\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/mobile-keyboard-toolbar/index.js\":\"7dc4ae0454e5341e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/move-blocks/MoveDestinationPicker.js\":\"1e4d94cee6a6661e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d1435f2f75ff31c1\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/move-blocks/contextMenuItem.js\":\"9df548d52c231844\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/move-blocks/index.js\":\"1549827868359b92\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/move-blocks/moveAction.js\":\"5a21f2399d6cde0c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/move-blocks/moveBlocks.js\":\"cb99a1e568e4b805\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/move-blocks/selectionAfterMove.js\":\"98c698757a09342e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/onboarding/TutorialBanner.js\":\"9f60b20f9bfbc962\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/onboarding/action.js\":\"27dc597d51859add\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/onboarding/bannerDismissal.js\":\"6e24a9e70bdf9bd7\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/onboarding/documents/cheatSheet.js\":\"71c926b04f13c96f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/onboarding/index.js\":\"e2747a983b9e2f86\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/onboarding/keys.js\":\"afe5c8f1260114e8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/onboarding/landing.js\":\"8d7912e54554ac22\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/onboarding/outline.js\":\"5c93db9d398cba79\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/onboarding/seed.js\":\"cad3e35200f84855\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b69db6881e35bae9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/perf-monitor/analyze.js\":\"4cc7fd801078028f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/perf-monitor/diagnosticsSource.js\":\"fa2f8c2689e67825\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/perf-monitor/index.js\":\"43954dd56d9cedaa\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/perf-monitor/load.js\":\"5ac328515a048c43\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/perf-monitor/monitorRun.js\":\"64d36d08e396d540\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/perf-monitor/schedule.js\":\"6a38669b72520d3c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/perf-monitor/series.js\":\"b67d008de3a72298\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/perf-monitor/store.js\":\"65736b4a14d364a3\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/perf-monitor/trendAction.js\":\"c14e286d6510cb44\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/perf-monitor/verdict.js\":\"a07cf94eb1010963\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/plain-outliner/clickToEditAction.js\":\"6ff0241b0711b685\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/plain-outliner/index.js\":\"71eca1d9babb6961\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/plain-outliner/interactions.js\":\"d80b6f60bf8cfd01\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f3289bfda8cb1cf9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/properties-migration/MigrationGate.js\":\"8a203ffb46414cdc\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/properties-migration/MigrationGateDialog.js\":\"4fe2faf09d6163b6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/properties-migration/action.js\":\"0d0c525a945c7fd0\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/properties-migration/index.js\":\"d1c8be1fab643459\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/properties-migration/localRunMessage.js\":\"8abdf34926ed3b1e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/properties-migration/plugin.js\":\"83eeee244061d380\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/properties-migration/progressReport.js\":\"92491603fc825879\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/properties-migration/sweepProgress.js\":\"505e716aaedb2056\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/property-rows/FieldRowRenderer.js\":\"153c7f0c02b2c113\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/property-rows/ValueRowRenderer.js\":\"9451968b7333296a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/property-rows/actions.js\":\"201d73c387383d36\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/property-rows/autocomplete.js\":\"f900edb0441df88b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/property-rows/fieldRow.js\":\"421a357da3d39d28\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/property-rows/index.js\":\"b3527a54a53bb9f2\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/property-rows/referenceWarning.js\":\"44afaee00bc7ed48\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/property-rows/valueAutocomplete.js\":\"586b5ea917581ae8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/property-rows/valueSchema.js\":\"a1d6da775ff375b2\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/quick-find/HeaderItem.js\":\"80ca98f23d700cdc\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/quick-find/QuickFind.js\":\"a491736f218df43a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/quick-find/index.js\":\"959be7d6fba145d0\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/quick-find/recents.js\":\"811e20f87d15d4f5\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/quick-find/resultItems.js\":\"8cd3bb41ea593feb\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/quick-find/selection.js\":\"fb4ff994cb03b951\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/quick-find/toggleStore.js\":\"f10f5a1e902ee13a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/recents/HeaderItem.js\":\"16e88718a6d97243\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4ced46752927b130\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/recents/grouping.js\":\"218b35c64bc41804\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/recents/index.js\":\"1b822a7594fb7555\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/recents/target.js\":\"eab33d9ce67a534d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/codeMirrorExtensions.js\":\"53a8770b00586dbe\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/contentPrefill.js\":\"f420e026921fff88\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/dataExtension.js\":\"dae7304e0ac33822\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/index.js\":\"1be6d4e9f757eaa8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"3b8469736bf45f3f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/invalidation.js\":\"20eb2532c31bf6c7\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/localSchema.js\":\"af926f2d53ba4001\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/markdown/blockrefs/index.js\":\"44cdcd492641f079\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f10f9b9a72f87eee\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/markdown/index.js\":\"0ac8b9f716eeec19\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/markdown/referenceNode.js\":\"2eb0de0dd0a76777\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/markdown/remark-reference-occurrences.js\":\"47d94e876c534fb6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"694b1c418ff5a7f8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/markdown/wikilinks/index.js\":\"cb3bd7a496998e66\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"1d59fe2365e03a35\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"e91274fdf7b98d98\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/mergeRetargetProcessor.js\":\"d8747fa8eb8dc1c6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/parseFence.js\":\"583c7d84cf21a866\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/referenceParser.js\":\"37e15ad6df47460e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/referenceProjection.js\":\"01fe2992103822de\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/referencesProcessor.js\":\"d9b76db78055e6df\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/renameProcessor.js\":\"a55af83b2843d04d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/references/spanReplacement.js\":\"95dce862ca946715\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/rich-paste/htmlToOutline.js\":\"030f52ad87580639\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/rich-paste/index.js\":\"4b49d6be6de815e7\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/rich-paste/normalizeClipboardDom.js\":\"025191a85ac1a6d8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/rich-paste/pasteDecision.js\":\"8ac8df8cca7abf62\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/action.js\":\"556bbdc7f4436d15\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/blockIds.js\":\"49db5846c29e387a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/content.js\":\"8c24befc687fdb6e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/effect.js\":\"5265684d455979fe\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/ids.js\":\"464b59c0ebb73895\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/import.js\":\"feef09d4c3d5227c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/index.js\":\"7b4fd513d19e00d8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/plan.js\":\"28500b56418ebf07\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/plugin.js\":\"4e362f6bb5b6f884\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/promotion.js\":\"a07e7c26baad0831\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/properties.js\":\"e5375cff26f998ee\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/references.js\":\"4f2aad3a65ec737d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/report.js\":\"dfd320be2b4940e6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/roamMemo.js\":\"29e60a6c449576ca\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/runtime.js\":\"800f15c283d28323\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/schemaReconciliation.js\":\"571a7bd156d26355\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/srsMarkers.js\":\"a9d5e402c1ccd9b9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/todo.js\":\"55fb588779a07222\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/typeCandidates.js\":\"af8c3d9464039675\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/roam-import/types.js\":\"f98e3dd06674a2e7\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/search-health/index.js\":\"6ac1d17b431c6a64\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/search-health/store.js\":\"2ca78f0278b5cba2\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/shortcut-help/HeaderItem.js\":\"3c28a114b4b69c1a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e97cb718ecd42ae8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/shortcut-help/index.js\":\"ce8a42f3c6777bb0\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/shortcut-help/model.js\":\"912c3d759b433335\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/shortcut-help/toggleStore.js\":\"03bd5b924972763c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/shortcut-help/useKeyInspector.js\":\"9209c527fcbece39\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d1db35139e7ad328\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/spatial-navigation/ShellDecorator.js\":\"75290f168070c805\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/spatial-navigation/actions.js\":\"5cb756bfc0369763\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/spatial-navigation/exclusionsFacet.js\":\"bb92a5baa18f1f94\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/spatial-navigation/index.js\":\"01126c15bd42f23f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/spatial-navigation/shell.js\":\"75b8ee03634fc327\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/spatial-navigation/surface.js\":\"80be71c500993352\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/spatial-navigation/walker.js\":\"1a3fd0a73dbf32be\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c7b6b94b3d70ec1f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-rescheduling/dataExtension.js\":\"fd8a2c71c30fe136\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-rescheduling/index.js\":\"b074be67624f7bce\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-rescheduling/indicator.js\":\"e92ed28bc10a8b49\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-rescheduling/moveSrsState.js\":\"63ef769c21e845bd\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"15b767f6e8ff081a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-rescheduling/scheduler.js\":\"0f90f694e5070754\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-rescheduling/schema.js\":\"087b4f469fc55feb\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"0697743740605a24\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-rescheduling/srsClipboard.js\":\"5580340062d6187c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ebd177d5dae2bc54\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/DailyNoteReviewHint.js\":\"48db4aa758cb4735\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/DeckPicker.js\":\"8912b4616ed2f643\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/ReviewControls.js\":\"477ae3a7ce1ae704\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/ReviewDeckRenderer.js\":\"64fd8a39f09ef503\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/ReviewSession.js\":\"2a3270af5b0ca7a6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/actions.js\":\"30c6d43670cea635\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/archive.js\":\"803cd9152398168a\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/dataExtension.js\":\"13e7384ad674c17d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/deck.js\":\"8f123015028ea97e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/dueQuery.js\":\"986a36408c40fed3\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/gradeDecision.js\":\"0adf5148e8330c4b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/index.js\":\"eda4c073c6df2484\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/keyHints.js\":\"f15556b7849a66eb\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/reviewCardLayout.js\":\"981e72d92f42f5a6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/reviewProgress.js\":\"f21c40fd78b45147\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/schema.js\":\"ab722dcb49470462\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/srs-review/useDueCards.js\":\"f801c4b7014fae45\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/startup-metrics/index.js\":\"ad96b127a0f68790\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/startup-metrics/record.js\":\"b1ec70273cbdc534\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/storage-persistence/index.js\":\"83d4b177cae3c5dd\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/storage-persistence/persistenceStatus.js\":\"6002f1476fcff585\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/storage-persistence/requestAction.js\":\"7e8e1960cc909bfc\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/supertags/TypeChipsDecorator.js\":\"cee2a6b1963405f0\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/supertags/codeMirrorExtensions.js\":\"a4e10d8acd369132\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/supertags/index.js\":\"fba0ddb851c1abeb\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/supertags/typeAutocomplete.js\":\"ae6cacb9697fb727\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"822b13cf5e310a45\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/swipe-quick-actions/actions.js\":\"f78c6143fda1e8c9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/swipe-quick-actions/anchor.js\":\"feead7ed7f798190\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/swipe-quick-actions/events.js\":\"afa666e72f40df2c\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/swipe-quick-actions/gestureActions.js\":\"6dc1dd1d8013a0e9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/swipe-quick-actions/index.js\":\"e866ab65594eda00\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"4a93728b7bd0ebc6\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/sync-metrics/collect.js\":\"994abc5c2f732265\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/sync-metrics/index.js\":\"7918f02d62291b4f\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/sync-metrics/record.js\":\"dd87487f46dbad93\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/system-status/RejectionDialog.js\":\"eb23c98f3bdb2fb4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/system-status/SystemStatusHeaderItem.js\":\"0e31beadeec50d93\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/system-status/index.js\":\"760aca5faa9f7ff4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/system-status/model.js\":\"6b8992130d4e2cd1\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/system-status/queueCounts.js\":\"c17fe0963afa33cd\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/system-status/rejectedHelpers.js\":\"d0c0b28e9a84cc14\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/system-status/rematerializeAction.js\":\"06031d1c0774f647\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/system-status/useHysteresis.js\":\"e19e2ae21c0f614e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/ColumnHeaders.js\":\"83f4cd777463dfeb\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/QueryUi.js\":\"3c4a58a61daf3773\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/TableLayout.js\":\"993f67e04f79237b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/actions.js\":\"b0a66869d8f76a71\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/cellEdits.js\":\"ac7ce253561da051\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/childrenViews.js\":\"a75e8c75a6ef3940\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/columns.js\":\"e2c8db54169876b8\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/controller.js\":\"5996f2990093b2f0\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/convert.js\":\"271f9ecb45a60e08\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/dataExtension.js\":\"fcaa4c8d2af7c1d5\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/index.js\":\"79fdbccfe803be13\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/keys.js\":\"45e11afec2f1717d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/model.js\":\"6774bca75d5b09c9\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/query/backfill.js\":\"bae608eaf8ca8961\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/query/completion.js\":\"4782422d3d9dda41\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/query/format.js\":\"9d0a5e2d8b14b8c5\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/query/parse.js\":\"6739701b3e8854a5\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/query/queryValue.js\":\"c6314e25797913ea\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/query/registrations.js\":\"093b485551783860\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/query/source.js\":\"07af86e08d32d228\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/registry.js\":\"e5f5e137c0d59567\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/rowGutter.js\":\"9e3a8978fd9dd937\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/rowVerbs.js\":\"2f13dce39d7c7b66\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/schema.js\":\"0e247f995a91cd62\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/tables/sort.js\":\"62f434dc02f5bb48\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/theme-toggle/effect.js\":\"575ef4ffae286290\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/theme-toggle/index.js\":\"90d1f8ac13fa90fb\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/theme-toggle/theme.js\":\"63f6887c8a1a9624\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/todo/actions.js\":\"2d602e17746d7aaa\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/todo/dataExtension.js\":\"39345c77f46326f7\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/todo/index.js\":\"46ba51e0403c56e3\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/todo/schema.js\":\"343f962c1659a892\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/touch-selection/TouchSelectionLayer.js\":\"44e873d7496c84c3\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/touch-selection/actions.js\":\"2363e081f0414531\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/touch-selection/defaultItems.js\":\"9d45917180854804\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/touch-selection/facet.js\":\"eb156d5f78634054\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/touch-selection/holdRecognizer.js\":\"c9d283e8eec5019b\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/touch-selection/index.js\":\"9d11bd1c7af995be\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/update-indicator/UpdateIndicator.js\":\"2dc77ecfa2c50781\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/update-indicator/index.js\":\"58b3a6bc04410484\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/update-indicator/loadTimes.js\":\"00bfcff10bdc36f5\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/video-player/VideoNotesRenderer.js\":\"7bcbc7999393dbb4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/video-player/VideoPlayerRenderer.js\":\"831251eeffc92c23\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/video-player/VideoTimeStamp.js\":\"2fd6bcd10d23c90e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/video-player/actions.js\":\"582996c0512d7713\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/video-player/index.js\":\"7d053618eb101c70\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/video-player/markdown.js\":\"2d360592c87f4a13\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/video-player/notes.js\":\"2ee29c0677128291\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/video-player/registry.js\":\"7e2c1bde53f90355\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/video-player/remark-timestamps.js\":\"7347a89be30134fa\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/video-player/view.js\":\"604a92d7a9511f6d\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/vim-link-hints/LinkHints.js\":\"b62d739afd4f20d1\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/vim-link-hints/index.js\":\"32de3a80b5a5e84e\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/vim-link-hints/model.js\":\"2b5fe897b0185a52\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/vim-link-hints/settings.js\":\"3746de4db9765c27\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/vim-normal-mode/actions.js\":\"f804a6fa593f2afd\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/vim-normal-mode/index.js\":\"c92e6babdd8354e4\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/vim-normal-mode/interactions.js\":\"deaa66f33610a269\",\"/knowledge-medium/pr-preview/pr-1883/src/plugins/workspace-header/index.js\":\"e8b2a35a73dbc491\",\"/knowledge-medium/pr-preview/pr-1883/src/registerServiceWorker.js\":\"f7c7db21a1606a21\",\"/knowledge-medium/pr-preview/pr-1883/src/requestPersistentStorage.js\":\"9b6849048dd52d1e\",\"/knowledge-medium/pr-preview/pr-1883/src/services/authRequestDeadline.js\":\"46870059809cbae8\",\"/knowledge-medium/pr-preview/pr-1883/src/services/authStorage.js\":\"8d2b38129c925c44\",\"/knowledge-medium/pr-preview/pr-1883/src/services/powersync.js\":\"362e3709d70aac66\",\"/knowledge-medium/pr-preview/pr-1883/src/services/supabase.js\":\"b9ff8061157cf995\",\"/knowledge-medium/pr-preview/pr-1883/src/services/uploadErrorClassifier.js\":\"c5823ae7461f2d17\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/ActiveContexts.js\":\"61d90655528d13f1\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/HotkeyReconciler.js\":\"fc02984df06a837e\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/WipeLocalDataDialog.js\":\"9c3406db2757a211\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/actionDispatch.js\":\"372455b25c17a774\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/actionRefItems.js\":\"dd5d58b621b5d2e5\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/applyKeybindingOverrides.js\":\"65a36469b5a6e8a4\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/blockActions.js\":\"a555944a93578d04\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/blockMergeGesture.js\":\"4096fe0d4f79bee4\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/canonicalizeChord.js\":\"e551d70d1bb5be1f\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/defaultContexts.js\":\"031401f62999b5dc\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/defaultShortcuts.js\":\"69fda775a353c670\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/effectiveActions.js\":\"4c7e3132d481a88e\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/gestureAction.js\":\"057983cd338fa6ca\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/gestureBinding.js\":\"5743b2285f57d385\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/holdRegistry.js\":\"8510df60feb23a87\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/keybindingConflicts.js\":\"abc493178403cd6b\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/keybindingOverrides.js\":\"800b56d5d0fdeda9\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/pointerAction.js\":\"5312312809966a0e\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/resolve.js\":\"f9e98ce5dc3b0e53\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/runAction.js\":\"0fa96898d3af38be\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/sequenceMatcher.js\":\"f5c4ed2a7040b5c8\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/types.js\":\"a94ddeb164b22ec9\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/useActionContext.js\":\"067343adfdcfddec\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/useActionDiscovery.js\":\"ee64cf853cf0ef6b\",\"/knowledge-medium/pr-preview/pr-1883/src/shortcuts/utils.js\":\"4a7abfce1c35e952\",\"/knowledge-medium/pr-preview/pr-1883/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1883/src/sw/bootStore.js\":\"56ae56863bf19554\",\"/knowledge-medium/pr-preview/pr-1883/src/sw/previewDatabases.js\":\"7fc98361f34d199c\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/byteTransform.js\":\"298b0f7146c482b2\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/attachmentCleaner.js\":\"a1255d9fbc963d71\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/bundle/attachmentParts.js\":\"a47bd00b100d8bfa\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/bundle/bundleParts.js\":\"5e6f606deda624ac\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/bundle/bundleRecord.js\":\"df22840771070b30\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/bundle/manifest.js\":\"7dc6b56c22fc1e52\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/bundle/takeBundle.js\":\"5987c05cf1b22e48\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/bundle/verifyBundle.js\":\"4f7149f61ac03bcd\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/cleaningStage.js\":\"fa10b74d33d94936\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/conversionKey.js\":\"0fb0366a6fa47246\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/conversionServer.js\":\"08dab2663fa442fd\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/flip.js\":\"ce465bef8c1c4d7f\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/flipAttempts.js\":\"641346af4edd93f0\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/pages.js\":\"2d0dad6b13ec39e5\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/preflight.js\":\"ac898e06a38a6c61\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/reseal.js\":\"418460db381102fe\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/runConversion.js\":\"54efde10ef3a73c5\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/runLock.js\":\"d5402e9dc229208a\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/sealing.js\":\"6360938da68f036a\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/sealingStage.js\":\"867d4652df309f98\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/stage.js\":\"581ba9075b681dde\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/conversion/verifyReseal.js\":\"934b0fb8fe6f57b7\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/aad.js\":\"c9e66defba76fba8\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/aead.js\":\"4abf822c14f0988d\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/base32.js\":\"791a0ad06e7a63e5\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/base64url.js\":\"9c1c20f90ec9fc26\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/binaryEnvelope.js\":\"ebd06fba4780fadb\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/byteAead.js\":\"80b9848c1da09d8a\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/canary.js\":\"c91fb3a975dae943\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/contentHash.js\":\"5567aa1d4ca18482\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/contentKey.js\":\"3681c82a523da708\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/derivedIdNamespace.js\":\"6518104615a70865\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/envelope.js\":\"c866b05cd123a7f9\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/hex.js\":\"4d5ccc736c6d3953\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/sha256Hex.js\":\"d0d0a35d987e264e\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/crypto/workspaceKey.js\":\"b102a0ace34c8c30\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/keys/conversionState.js\":\"ffd94e186460e49e\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0087da91603324b3\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/keys/flows/pastedKey.js\":\"3ab3fd529b4d50a7\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"099040b348fbbec2\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ca5e1745a4c6ffb5\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/keys/keyStore.js\":\"40d904fe456376c7\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/keys/mintWorkspaceKey.js\":\"f49afaf63cd70b1e\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/keys/modePin.js\":\"71cbf3c777fdafeb\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/keys/openWorkspaceKeys.js\":\"e407b2866c0c26a3\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/keys/resolveWorkspaceEntry.js\":\"162e355fb6530c1a\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/keys/resolver.js\":\"cf33fee575e2de27\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/keys/workspaceAccess.js\":\"2650c26651af995f\",\"/knowledge-medium/pr-preview/pr-1883/src/sync/transform.js\":\"4acfc665bf3744fb\",\"/knowledge-medium/pr-preview/pr-1883/src/themeBootDefaults.js\":\"29a5325641e4c684\",\"/knowledge-medium/pr-preview/pr-1883/src/types.js\":\"a51f5b943aeeab4a\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/ClientLocalSettings.js\":\"7eff5268da99b287\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/abortableSleep.js\":\"5a3d577cca638dc8\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/array.js\":\"61af39508d03a2dd\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/backlinkAutocomplete.js\":\"eb47f42c24b90955\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/blockCrumbs.js\":\"1c731b51ab22c51b\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/blockrefAutocomplete.js\":\"486673ced9160035\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/cadencedIdleJob.js\":\"92b25196512efefb\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/callbackSet.js\":\"44b6138fcc6fe176\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/clientId.js\":\"69bc769302ea70b3\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/codemirror.js\":\"bfbe0ca4b491892e\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/codemirrorCompletion.js\":\"322a24e1368b22a9\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/copy.js\":\"4fc950d019425f70\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/dailyPage.js\":\"79261623cd20a5c2\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/dbForensics.js\":\"3fd92033002ba991\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/dbForensicsHooks.js\":\"188e479f2c9f4e61\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/deleteBlockThroughUi.js\":\"355439393cbb8e88\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/dialogs.js\":\"b07926a163bea2cc\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/dom.js\":\"5a4cd22aef8a1512\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/downloadBlob.js\":\"825ec2e8acdb3ca3\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/drawnWalk.js\":\"1863aa6cd2ec9758\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/exportSqliteDb.js\":\"fa89383beb8924ec\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/fileSystemAccess.js\":\"29a8aa26532d6746\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/flipSlide.js\":\"3cb967271ca85fe3\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/fnv1a.js\":\"547745087fc5219b\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/formatBytes.js\":\"3a22c190610934b9\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/fuzzyRank.js\":\"5139671928675312\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/idbKeyedStore.js\":\"4fad5cbd480ba8a4\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/idleCallbackPolyfill.js\":\"84eb6f5fa10f28f2\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/keyboardAwareScroll.js\":\"6f9ae2621253e5d4\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/keyboardViewport.js\":\"e4403387489495ab\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/lastWorkspace.js\":\"d4d81f78f1db7adf\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/layoutColumns.js\":\"b6d134d9604ee08e\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/layoutSessionDom.js\":\"b3cbace6c3500856\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/layoutSessionId.js\":\"55f8709b67b7f95e\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/linkClickGestures.js\":\"313f8d261acd281a\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/linkTargetAutocomplete.js\":\"63f4aad5c4373d7e\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/localDbCorruption.js\":\"2eb7a25f075b17d2\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/localDbRecovery.js\":\"775405d46ecbc76c\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/markdownParser.js\":\"07bb6018b4cb1b5c\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/memoize.js\":\"ef2a7ca2ef74fe75\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/nameFieldCommit.js\":\"1ab3ecc85c9788ee\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/nameList.js\":\"60ccfae7b1759d13\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/navigation.js\":\"8198c4bd84c7d9a6\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/omnilinerNamespace.js\":\"72d014d876c07436\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/opfsPageScan.js\":\"283d0317335b1a83\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/panelClearance.js\":\"ee214f859d95fcd9\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/panelHistory.js\":\"b83ea078fc21baa0\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/panelLanes.js\":\"16e151c90203d253\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/panelLayoutProjection.js\":\"8495ce29fdcf5f63\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/panelScrollAnchor.js\":\"7e4fe0eec67b6f53\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/panelUrlFlags.js\":\"568bd916faf6ead4\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/platform.js\":\"9acc5f876a7ec0b3\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/pluralize.js\":\"ff161278343fb203\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/propertyCreation.js\":\"ceac1fe8e1976841\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/propertyNavigation.js\":\"62f582426dc098be\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/propertyValueContext.js\":\"ad2b6be69b55364c\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/react.js\":\"e1dfa7df5278861e\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/relativeDate.js\":\"d5b39a32d57ee9e5\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/relativeTime.js\":\"679daa8a1d73fba0\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/renderScope.js\":\"1a2515bbc7a39901\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/resolvedThenable.js\":\"6ffcf34a65494e31\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/routing.js\":\"f9796a43fd6f1afa\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/safeMode.js\":\"ae893475cda9f27e\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/scheduleIdle.js\":\"241bee2ae358e903\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/screenWakeLock.js\":\"21fc866e02208410\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/selection.js\":\"e00ea034d0ed5e6c\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/softKeyboardGrab.js\":\"d8b37fa1882825c3\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/startupTimeline.js\":\"06a7f3a3a8e82003\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/state.js\":\"32d857e60cfaaf83\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/string.js\":\"1257234be2fe0b65\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/surfaceZoom.js\":\"ee4eea245c19fa46\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/time.js\":\"ef0226f08f3fb1fe\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/toast.js\":\"26f2d69bc57e2556\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/toggleStore.js\":\"03b85a0865fa45d2\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/untilStopped.js\":\"bdcb1b28c9cc26c5\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/userActivity.js\":\"8cf7e1bfbc92b43f\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/viewTransition.js\":\"a529f6370caa973b\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/viewport.js\":\"67d29a5c5c5b4c43\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/webLock.js\":\"625f915c136d1e7b\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/workspaceRecovery.js\":\"658cf3073d169bec\",\"/knowledge-medium/pr-preview/pr-1883/src/utils/workspaceSnapshotStore.js\":\"c0af406ed2094b45\",\"/knowledge-medium/pr-preview/pr-1883/src/vendor/react-compiler-runtime.js\":\"481fa628bf173adf\",\"/knowledge-medium/pr-preview/pr-1883/src/vendor/react-dom-client.js\":\"5ef5480eafee2ec6\",\"/knowledge-medium/pr-preview/pr-1883/src/vendor/react-dom-server-edge.js\":\"7f4798e615667e7f\",\"/knowledge-medium/pr-preview/pr-1883/src/vendor/react-dom-server.js\":\"cd20dfca4243d897\",\"/knowledge-medium/pr-preview/pr-1883/src/vendor/react-dom-static-edge.js\":\"821d7de4c292cf3f\",\"/knowledge-medium/pr-preview/pr-1883/src/vendor/react-dom-static.js\":\"3342f3b0c3321dfd\",\"/knowledge-medium/pr-preview/pr-1883/src/vendor/react-dom-test-utils.js\":\"3085f98971b1ffcb\",\"/knowledge-medium/pr-preview/pr-1883/src/vendor/react-dom.js\":\"108144b9265b40fa\",\"/knowledge-medium/pr-preview/pr-1883/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1883/src/vendor/react-jsx-runtime.js\":\"97f300402d51356f\",\"/knowledge-medium/pr-preview/pr-1883/src/vendor/react.js\":\"87ec57307dedac8d\",\"/knowledge-medium/pr-preview/pr-1883/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1883/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1883/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
