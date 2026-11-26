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
		buildId: "cea5d7f78a7e-070727e3",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/\":\"49b47be737030bca\",\"/knowledge-medium/pr-preview/pr-1884/index.html\":\"49b47be737030bca\",\"/knowledge-medium/pr-preview/pr-1884/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1884/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1884/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1884/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1884/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/app.css\":\"d6b85c2ba5dde3ba\",\"/knowledge-medium/pr-preview/pr-1884/assets/FacadeVFS-CZaZubyA.js\":\"452ee8ccaf3632a7\",\"/knowledge-medium/pr-preview/pr-1884/assets/OPFSCoopSyncVFS-DRXZrIUY.js\":\"b8ea73ac2df32151\",\"/knowledge-medium/pr-preview/pr-1884/assets/OPFSWriteAheadVFS-B-yZHJr3.js\":\"b0a02404a97ed504\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-BS2QWGnH.js\":\"0517618f12db4340\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-async-BPFsksgB.js\":\"17f6a60a8fd23bf0\",\"/knowledge-medium/pr-preview/pr-1884/assets/worker-9LcMb2Hh.js\":\"aef896ed4be63d75\",\"/knowledge-medium/pr-preview/pr-1884/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1884/chunks/app-CClm5431.js\":\"0ed08315c2e3cda3\",\"/knowledge-medium/pr-preview/pr-1884/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1884/index.js\":\"686ba564fe2f8ada\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1884/assets/AccessHandlePoolVFS-EiQkhSYC.js\":\"fd1ee9ae005ac7f1\",\"/knowledge-medium/pr-preview/pr-1884/assets/IDBBatchAtomicVFS-ByKXhiwu.js\":\"d87443cd047eff78\",\"/knowledge-medium/pr-preview/pr-1884/assets/MemoryVFS-C994MB5Q.js\":\"b6c1d748ad1ed335\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-DpNyrni7.js\":\"14aa37c3d28ad0fa\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-async-l6kr3bLo.js\":\"31eed6ab5c5837a9\",\"/knowledge-medium/pr-preview/pr-1884/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1884/chunks/AccessHandlePoolVFS-DEMNJ2is.js\":\"2de9534c45c05681\",\"/knowledge-medium/pr-preview/pr-1884/chunks/FacadeVFS-O7efc8dt.js\":\"fbb5bd9da06a4299\",\"/knowledge-medium/pr-preview/pr-1884/chunks/IDBBatchAtomicVFS-v8GQyajX.js\":\"9a85a800158ea4d3\",\"/knowledge-medium/pr-preview/pr-1884/chunks/MemoryVFS-BPCAsqUC.js\":\"c89b32776b3c9192\",\"/knowledge-medium/pr-preview/pr-1884/chunks/OPFSCoopSyncVFS-CaIYRbUo.js\":\"68910d17d921a35c\",\"/knowledge-medium/pr-preview/pr-1884/chunks/OPFSWriteAheadVFS-CS9Qc9Fe.js\":\"22681cb6ca42eeec\",\"/knowledge-medium/pr-preview/pr-1884/chunks/Preview-p9sSYTck.js\":\"dad64e30f5a8810e\",\"/knowledge-medium/pr-preview/pr-1884/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1884/chunks/card-CToZHsOa.js\":\"ba6649a618a8d0db\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-Zecszv2O.js\":\"2d2016a107cc672b\",\"/knowledge-medium/pr-preview/pr-1884/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1884/chunks/mc-wa-sqlite-DFyKaaxw.js\":\"b99c56c32a3d3a91\",\"/knowledge-medium/pr-preview/pr-1884/chunks/mc-wa-sqlite-async-DDdztWG6.js\":\"4f4dac2e549d9d9d\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-BCSVPuDQ.js\":\"c441bbcb7a5373fc\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-BCjz1M8B.js\":\"09cf9d4bbc3d0150\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-BKP49tBm.js\":\"0dfcf5c7e7dc1034\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-C1GQpD-P.js\":\"0dbb06090efec7b6\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-CQrILSmQ.js\":\"1a899ce48d0bcfd1\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-DN1Bk0R4.js\":\"14411840685b98d5\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-DVFzjeSx.js\":\"dc1e61848a57d2ce\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-_0cUHnnk.js\":\"053b18ae7754b27c\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server-legacy.browser.production-BEoxODD-.js\":\"4090964a6d4f4bcb\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server.browser.production-C5GQAdJG.js\":\"2d3b100a4c28009d\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server.edge.production-DmOBycWR.js\":\"8821a4130bd066ee\",\"/knowledge-medium/pr-preview/pr-1884/chunks/server.browser-mcIu7YcY.js\":\"78e1b4219476a8c7\",\"/knowledge-medium/pr-preview/pr-1884/chunks/textarea-OIDuq3Yx.js\":\"11bfe336e8642949\",\"/knowledge-medium/pr-preview/pr-1884/chunks/ui-yGYFtvYi.js\":\"b885ed43e222faca\",\"/knowledge-medium/pr-preview/pr-1884/chunks/wa-sqlite-CcK4Ra1E.js\":\"249711f0f25cd8ab\",\"/knowledge-medium/pr-preview/pr-1884/chunks/wa-sqlite-async-C4pAzbgW.js\":\"4ac3bd399a8977e3\",\"/knowledge-medium/pr-preview/pr-1884/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1884/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1884/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1884/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1884/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1884/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1884/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1884/src/App.js\":\"715a2b6249dbf648\",\"/knowledge-medium/pr-preview/pr-1884/src/appUpdate.js\":\"1fe09871cc9cb500\",\"/knowledge-medium/pr-preview/pr-1884/src/appVersion.js\":\"c2dfe2b79863af6f\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/initialLayout.js\":\"68b3c4145da7bd8a\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/openWorkspaceData.js\":\"9cd0dffd8843aed5\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/resolveWorkspace.js\":\"997f56cca12f0455\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/workspaceBootstrap.js\":\"cf701b5ab2bf55e4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockComponent.js\":\"e064dd6161586c7a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockCrumbs.js\":\"2fd5fae7e67eee38\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockEditor.js\":\"1d7e5dfab67c4000\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockLoadingPlaceholder.js\":\"e0657a04ead2cc59\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockProperties.js\":\"4313bb408bde9f48\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockSearchPicker.js\":\"2920d14e03f38051\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ConfirmBulkDeleteDialog.js\":\"db023302c855c131\",\"/knowledge-medium/pr-preview/pr-1884/src/components/DividerHandle.js\":\"fcf33c66dd8230ba\",\"/knowledge-medium/pr-preview/pr-1884/src/components/DraftEditor.js\":\"854cab24b7b5fcdd\",\"/knowledge-medium/pr-preview/pr-1884/src/components/GutterPill.js\":\"3db472afd8113983\",\"/knowledge-medium/pr-preview/pr-1884/src/components/Header.js\":\"963307f001b95449\",\"/knowledge-medium/pr-preview/pr-1884/src/components/LazyBlockComponent.js\":\"05129b577ba3b05f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/Login.js\":\"a950f893d0ff58df\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ZoomableSurface.js\":\"7c36950b5ff06c22\",\"/knowledge-medium/pr-preview/pr-1884/src/components/editModeKeepalive.js\":\"971ac770b1b9b54e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a0eb51567e371b6b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"99376b63b4458fce\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/RefPropertyEditor.js\":\"0957c11020b826b4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/RefTargetTypePicker.js\":\"65b9259c84c5d509\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/SelectPropertyEditor.js\":\"c0da805d7ce8cef5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/TypesPropertyEditor.js\":\"cd90be97857df81d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/defaults.js\":\"7fb4e0dbe5fabf4a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/kernelValuePresets.js\":\"25fabb8511bea011\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/selectablePresets.js\":\"12a60590a99786d6\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/typesPropertyUi.js\":\"285f12c9098a3c8d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/AddPropertyForm.js\":\"ba1c0bee4cace235\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/PropertyPicker.js\":\"473dcb88f69a239f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/PropertyRow.js\":\"e823ddbabdc5fc25\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/Rows.js\":\"b4eb898f35b73725\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/actions.js\":\"bcda855f537a2c1d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/declarationOnly.js\":\"998c593f039a7e30\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/layout.js\":\"a4ed060e6a3830d6\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/model.js\":\"19033e9f3a086f05\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/shapeUi.js\":\"ac1e0bf74491932c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/shapes.js\":\"31c64e48685fa78f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c489cd595d0fd4be\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/visibility.js\":\"e6a817ecec7bbb0e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanelSections.js\":\"46bb7e00f9286b7a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockEmbed.js\":\"6ba3296c65ddf311\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockLink.js\":\"60de233b991451e8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockRef.js\":\"29ae5db1c45337e5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/CompactReferenceLink.js\":\"c2054e874c9e8053\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/ReferenceLink.js\":\"abc5299ab8d86d46\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/cycleGuard.js\":\"569f6b3b16669ec4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/cycleGuardContext.js\":\"723ddcfd50632233\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/linkInteraction.js\":\"88ca2a27a2e2bb1b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/referenceLayout.js\":\"f387827dc1f36c81\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/useBlockRefAncestors.js\":\"f757af4eb0c1bf8d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockGutter.js\":\"1553eb993e77d1c6\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockInfoDialog.js\":\"751666d0e060ccd9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockReadText.js\":\"eb545898eaffb825\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockTypeBlockRenderer.js\":\"02147dd6de69ddda\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BulletHoverCard.js\":\"0237e07a74485352\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/CodeMirrorContentRenderer.js\":\"93faa68f58692e54\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9a022ab1999db318\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/ColumnResizeHandles.js\":\"d236850816dc028d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a393f0cc9435cead\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/DefaultBlockRenderer.js\":\"deb002e50a571834\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/LayoutRenderer.js\":\"bd97bd9997969527\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/MarkdownContentRenderer.js\":\"5fdd24df65e9697b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/MissingDataRenderer.js\":\"b9f197de148c13d0\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/PanelRenderer.js\":\"c604438643cd07c9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/PropertySchemaBlockRenderer.js\":\"17ccf05a94edea57\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/TopLevelRenderer.js\":\"b1cacce8eaf2c507\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/blockGutterMode.js\":\"f25c458f1bfaa243\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/blockTitleText.js\":\"f49c4ea6245c5bf4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/fieldCreationKeydown.js\":\"62ac0080af10b5cc\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/layoutRootContext.js\":\"60ceaf790477b728\",\"/knowledge-medium/pr-preview/pr-1884/src/components/typeChip/TypeChip.js\":\"21c1c28913e2823a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/typeChip/chipStyle.js\":\"932334c64ede935b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/anchored-floating.js\":\"d93e756b34d5cb4b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/button.js\":\"a6f51b90f8a8e873\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/card.js\":\"3e473de55da2fb4d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/checkbox.js\":\"7d70078502f5928c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/collapsible.js\":\"47280f1309dd53ee\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/command.js\":\"ef3fa4b04f421f4b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/context-menu.js\":\"40f98323f0e5e4b4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/dialog.js\":\"cf27b2b7297ac1e5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/dropdown-menu.js\":\"7e588ecd79f99ef3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/floating-listbox.js\":\"3d46a433faaf330b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/index.js\":\"a8670a35fe41ffbb\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/input.js\":\"8b29dd92e0939e26\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/kbd.js\":\"9b42a74f982eeaa0\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/label.js\":\"4b6c442d62f2727b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/textarea.js\":\"9dee2dd04b86435e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/useEditModeYieldKeepalive.js\":\"476fa52523f069e1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/BootFallback.js\":\"a1f9aea1e0125c04\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/FocusedRowLazyMount.js\":\"00329ecba70fe228\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/LazyViewportMount.js\":\"d29d2893f5a0d412\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/LocalDbCorruptionFallback.js\":\"e6384697e3911132\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/error.js\":\"46ed6509b1b351df\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/lazyMountRegistry.js\":\"b8e0939647024242\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/suspense.js\":\"f35f5f1e4efe2554\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/CreateWorkspaceDialog.js\":\"bf0d369d09a7afc1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/PendingInvitations.js\":\"430b56c3b922d468\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/SyncProgress.js\":\"f1630233d801e555\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/UnlockProgress.js\":\"49b625975cfe28ff\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceKeyGate.js\":\"0a8e6a3296eb3fb8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSettingsDialog.js\":\"60ff0fb05a8ff09d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSwitcher.js\":\"4691d911073bf335\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSyncGate.js\":\"26c400f36af0a43c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/ConversionFlow.js\":\"73f214aafa44e1e2\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/ConversionFlowHost.js\":\"c7e3b1b90ee8eedd\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/EncryptionSection.js\":\"53e4b0803f9144fb\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/attachmentPrompts.js\":\"53ebc6f5918d39e1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6ca05585050a1e47\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/conversionFlowDeps.js\":\"4b3f1ab6d1f5c725\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/conversionFlowStore.js\":\"05b770dfb475458b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/flowUi.js\":\"ccece625fd91dcea\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/useConversionRun.js\":\"a24f71ab17c1056f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/keyUi.js\":\"37c0a7c26c328743\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/useCloseOnKeyLoss.js\":\"be78260960fb4e45\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/useCloseOnServerE2ee.js\":\"ee066357473012d6\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/workspaceUnlocked.js\":\"3f01b854b384b158\",\"/knowledge-medium/pr-preview/pr-1884/src/context/backgroundSubtree.js\":\"df9f047a6f7e738c\",\"/knowledge-medium/pr-preview/pr-1884/src/context/block.js\":\"c2ffebe1bdb66145\",\"/knowledge-medium/pr-preview/pr-1884/src/context/layoutWsContext.js\":\"0a4fd35e9fe924bb\",\"/knowledge-medium/pr-preview/pr-1884/src/context/propertyDisplay.js\":\"f60e353c4f5c6bd5\",\"/knowledge-medium/pr-preview/pr-1884/src/context/repo.js\":\"5aa9e9f3470137d3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/aliasClaim.js\":\"bc038b03f069d841\",\"/knowledge-medium/pr-preview/pr-1884/src/data/aliasSeatNamespace.js\":\"f48feb43fd956fe2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/blockData.js\":\"90780dff8bb8b9de\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/blockType.js\":\"ede21c490ac62176\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/changeScope.js\":\"8898aa1f921c7c5f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/codecs.js\":\"79a8c0ca478d6e4e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/derivedData.js\":\"d1c29fda204f86bb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/errors.js\":\"aa6446f95e009a1f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/events.js\":\"c42e6c6908cfdc74\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/handle.js\":\"e4a8ce42b12006f2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/index.js\":\"2e796256066eba74\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/mutator.js\":\"63897f24524041ed\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/processor.js\":\"de9f6d984f4f65fa\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/propertySchema.js\":\"1de1c42d97ef1bbc\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/query.js\":\"0442bdfba199f210\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/sameTxProcessor.js\":\"6c6354531f6b4f93\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/schema.js\":\"e4a8ce42b12006f2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/tx.js\":\"e4a8ce42b12006f2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/typedBlockQuery.js\":\"776e4911c7130a8a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/user.js\":\"3679648da67a4e1a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/valuePresetCore.js\":\"ed254c02d1264ca9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/valuePresets.js\":\"5632475365028818\",\"/knowledge-medium/pr-preview/pr-1884/src/data/attachmentCleanerIOVerb.js\":\"51410eae882e3f65\",\"/knowledge-medium/pr-preview/pr-1884/src/data/block.js\":\"617fedead7da7c5a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockCache.js\":\"d936f68a25b398be\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockId.js\":\"7bba3a8bdcdf4783\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockLiveness.js\":\"4307f2dae21771c7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockMerge.js\":\"3d312abcacdc7a46\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockSchema.js\":\"e5711d41623a8209\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockTypeLookup.js\":\"f5a04ea7681a1e88\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockTypes.js\":\"3cbf8180c5f2c101\",\"/knowledge-medium/pr-preview/pr-1884/src/data/childrenView.js\":\"047be7552d33a733\",\"/knowledge-medium/pr-preview/pr-1884/src/data/clientContext.js\":\"89bcef8be7586983\",\"/knowledge-medium/pr-preview/pr-1884/src/data/dbFileSiblings.js\":\"9a8d236a418efdcd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/definitionSeeds.js\":\"f1b774dfd41862fd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/derivedIds.js\":\"7c2f766572667bec\",\"/knowledge-medium/pr-preview/pr-1884/src/data/drawnSubtree.js\":\"c3edde3e79aeb1cb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/facetBridge.js\":\"c9dfa4d20b367193\",\"/knowledge-medium/pr-preview/pr-1884/src/data/facets.js\":\"9fc4c58b2aeac167\",\"/knowledge-medium/pr-preview/pr-1884/src/data/globalState.js\":\"017daecaf7b10eae\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/aliasClaimRederiveProcessor.js\":\"b2e6ef94329334e1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/ancestorBatch.js\":\"0e6dd643395db89f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/blockTypeTypeifyProcessor.js\":\"35c3085bd42916bb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/clientSchema.js\":\"c0949b2eb357ba20\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/commitPipeline.js\":\"3b606003192c8cd5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/devAssertions.js\":\"ff6406784ce10fe4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/firstSync.js\":\"fefad4b6ba506d23\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/freshInitialLoad.js\":\"59e9cf9f414283f0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/graphBackfillClaim.js\":\"89e32a9845496d33\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/handleStore.js\":\"ba4d9d4112644eb7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/idleMarkerJobs.js\":\"a2f811b2f6b29fc8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/initialDownload.js\":\"42772b7098484011\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/initializeClientDatabase.js\":\"b9675144ff90d7e4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/jsonCanonical.js\":\"ad344cf8bfcfa974\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelInvalidation.js\":\"dc277f7ebb68e6a3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelProcessors.js\":\"1ef1ead9638fd774\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelQueries.js\":\"63a808f394f4c529\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/mergeTypeMembershipProcessor.js\":\"c542a815ede15990\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/normalizeReferencesProcessor.js\":\"0fc446df17c88529\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/poolInstrumentation.js\":\"9700e503ea410856\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/processorRunner.js\":\"6038844f5b0ab8c3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyCellBackfill.js\":\"c68c7e437961d35d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyChildMint.js\":\"4a11ba9f449666ee\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyChildrenProcessor.js\":\"67d92abf9a3e04b6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyDefinitionChangeProcessor.js\":\"5cf3b1fa6a6b6b0f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyDefinitionSynthesis.js\":\"0eaa17769308008d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyKeyScan.js\":\"444c04d3a3a1a125\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertySchemaResolution.js\":\"df60d5c1b2875374\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyValueEdits.js\":\"67674e5a882ee1c4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/raiseProtocol.js\":\"c9d168645e09dc60\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/readBatch.js\":\"93d7f5b7f660742c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/refProjection.js\":\"38e62877e0f9b915\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/referenceTargetLookups.js\":\"39fdb4eca4c18421\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/referenceTargetProcessor.js\":\"6c3ec46cbb8f7d0a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/replayMerge.js\":\"e218dbe2e07a7a4c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/sqlBinds.js\":\"819971e0255b08af\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"262e266760abbce7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/arrivalProcessors.js\":\"88d68013dd955a15\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/invalidate.js\":\"53e1841bf3c47a60\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/materialize.js\":\"41c4a5a14e83a915\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/observer.js\":\"33be7103cb504af1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/reconcile.js\":\"832703748fb46ae6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/timingMetrics.js\":\"af68bae5cc62c4b8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/treeQueries.js\":\"3920864de19b42b5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/txEngine.js\":\"7bf93aadeeb85348\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/txSnapshots.js\":\"bbc92a0100e4eb3a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/typedBlockQuery.js\":\"26f065ac563183a5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/undoManager.js\":\"75e98cf134d27129\",\"/knowledge-medium/pr-preview/pr-1884/src/data/invalidation.js\":\"5badcb716e6f98b4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelDataExtension.js\":\"99d02af68604339a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelPage.js\":\"a5a75b4aaeee8abf\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelValuePresetCores.js\":\"d2382607bb7b3caf\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbCorruptionSignal.js\":\"e9902b5795df6656\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbStorage.js\":\"b8b93b0af4fc636c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbVfs.js\":\"d1fc0f82fa15f734\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localSchema.js\":\"b455c5f0a6443f03\",\"/knowledge-medium/pr-preview/pr-1884/src/data/maintenance.js\":\"22a6ecd05df17d72\",\"/knowledge-medium/pr-preview/pr-1884/src/data/mergeProperties.js\":\"0ea169f0a6e74acd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/metricsConsoleHook.js\":\"d8eaed4077094c64\",\"/knowledge-medium/pr-preview/pr-1884/src/data/migrationsPage.js\":\"25400405d1862024\",\"/knowledge-medium/pr-preview/pr-1884/src/data/mutators.js\":\"254f4cc2b50d2284\",\"/knowledge-medium/pr-preview/pr-1884/src/data/orderKey.js\":\"2738ea0ff1dc0829\",\"/knowledge-medium/pr-preview/pr-1884/src/data/orderKeyPlacement.js\":\"919234f37d85f635\",\"/knowledge-medium/pr-preview/pr-1884/src/data/outlineSurface.js\":\"852fce70df23595d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pendingEditorContent.js\":\"5d044b2dc5035cae\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pendingUploadsSql.js\":\"e2707afca0c940e6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pluginStateExtensions.js\":\"5df60cb5934f5ce3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/powerSyncLogger.js\":\"9d2fabc9f1548254\",\"/knowledge-medium/pr-preview/pr-1884/src/data/projectorRuntime.js\":\"c7fef2a618b824c5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/properties.js\":\"b253a59ac4b0bd0a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertiesPage.js\":\"540b54bb309e5d11\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyChildren.js\":\"7145e8fb16504f59\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionFanout.js\":\"f3c5a7a8a76b6ed7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionMetadata.js\":\"06f43df72906750b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionRegistry.js\":\"0084afc52e194f11\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDisplayMode.js\":\"42045a8fe41ed3f3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyRowCreation.js\":\"554d746cd9197cbf\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertySchemaCreation.js\":\"1bed47e9ab4b58b1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertySeeds.js\":\"6965cfa6b410cb64\",\"/knowledge-medium/pr-preview/pr-1884/src/data/recentsPage.js\":\"d4c5e20d399a4563\",\"/knowledge-medium/pr-preview/pr-1884/src/data/refTargetComparableProperty.js\":\"8c6746d5a920e22b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/referenceBlock.js\":\"5ba877773b350f1a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/rejectedUploads.js\":\"673d8089ed2961fa\",\"/knowledge-medium/pr-preview/pr-1884/src/data/releasePowerSyncConnection.js\":\"7ffa5ca17bf2427e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/repo.js\":\"de3b8bee6c2eddc4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/repoProvider.js\":\"f048d8936fb781c1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/rowProperty.js\":\"5dfc81949e073ce8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/searchFilter.js\":\"26f99c52d175b6ca\",\"/knowledge-medium/pr-preview/pr-1884/src/data/seedIdentityLedger.js\":\"0548d608108964eb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/stateBlocks.js\":\"513a11fcd07af3e1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/structuralEditPolicy.js\":\"6310852198b6c261\",\"/knowledge-medium/pr-preview/pr-1884/src/data/structuralInsert.js\":\"35e27c02023c7a7f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/subtreeDelete.js\":\"a22feeb8a90f98e3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncStreamLock.js\":\"2d9bf386a0ad69cd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncedTableSqlRecognizer.js\":\"d7f98455c4ab95d6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncedTableWriteGuard.js\":\"372c51704df810a1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/targets.js\":\"778117182ae2170e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeColors.js\":\"124d6edc4bdc7115\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeDefinitionMetadata.js\":\"9b63629a7b77333e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeDefinitionRegistry.js\":\"1f0b7e0fd039af65\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeExtraction.js\":\"5f71a08be1424eb4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeInitialValues.js\":\"7959c4c5d793132a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typePropertyGroups.js\":\"07faf4bcdd490f2e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeSeeds.js\":\"e6d1e2f3861c0965\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeTagger.js\":\"e11ada20bfcb3d5b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typedRecords.js\":\"0c2185fe9738be4c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typesPage.js\":\"f2c122dcf3f5aa2d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userPrefs.js\":\"145ce7239fa3bf1d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userSchemasService.js\":\"cabd2c9fd739ab04\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userTypesService.js\":\"ae2dcfac0e03f11e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/valuePresetRegistry.js\":\"74f7d0bdf515fefe\",\"/knowledge-medium/pr-preview/pr-1884/src/data/visibleChildren.js\":\"ff7ee8f92a9fa42a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceConversion.js\":\"c653830de5e1513e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceFirstSync.js\":\"9b5b0d7d6b22b156\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceIdNamespace.js\":\"1b28ac2b6ad9eb6d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceSchema.js\":\"f2aa9fb1ed0870d5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaces.js\":\"2865bfd9b68901f9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/writeAheadLog.js\":\"4617f1ab01e7265b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/BlockPasteShellDecorator.js\":\"51ccfd103cc854ad\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/atTrigger.js\":\"ea8c3c224762d29f\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/autocomplete.js\":\"c1fffa5d1672c83f\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/codeMirrorExtensions.js\":\"77a14f2b1b82246c\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/contentFlush.js\":\"9e97f3a8aa9cf912\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/defaultInteractions.js\":\"63717eced663b1a0\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/editSettleSignal.js\":\"8a94035e276ae26e\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/insertImage.js\":\"532a660fb06e458f\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/referenceCompletionRange.js\":\"800ddd0a46292239\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/referenceTargetTypes.js\":\"3b79c886898d8a65\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/syntaxContext.js\":\"0b6a415cb0dda198\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/triggerMatch.js\":\"908a41cb8185ef4d\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/AppRuntimeProvider.js\":\"ed11888d9f14430b\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/BlockFocusShellDecorator.js\":\"c0c91dcb8b87f720\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/ExtensionRenderBoundary.js\":\"9638cdce1a2ee029\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/PanelContentRecovery.js\":\"e79d3a2f66fb611c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/apiCatalog.js\":\"ba7dfe77d9c07e8f\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/approveExtensionHere.js\":\"cd531cddcdb79079\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/armedCutAppMount.js\":\"8ff70ad0d9a407ba\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/batchableKeyedStore.js\":\"db5fd81956e3d95a\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/blockInteraction.js\":\"1f252c7b04a79698\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/blockSelectionAction.js\":\"94fb97b1b75ef482\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/compileExtensionModule.js\":\"b749084d3f7e1eca\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/compiledModuleCache.js\":\"1ec67e277109710b\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/continuousGestures.js\":\"b76d8d4a0552075a\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/core.js\":\"3e4f0ddf94512c84\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/defaultRenderers.js\":\"06d8fc8e21a19ddc\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/definitionFanoutAppMount.js\":\"9010fa4b63ecac4a\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dialogAppMount.js\":\"ea41efd65f9d22a7\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dynamicExtensionSeeds.js\":\"a9cd0c42fc636696\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dynamicExtensions.js\":\"0c74e139b9f089c9\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/exampleExtensions.js\":\"6348dc1e75a411b6\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionApprovalStatus.js\":\"2880183b977efbb5\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLoadErrorToast.js\":\"d16fcb7b1843ecf3\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLoadErrors.js\":\"3e0296fa90289eed\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLookup.js\":\"5e6b71cc9c1071d7\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionToggles.js\":\"727015aa2ebc7fae\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionUtilitiesCss.js\":\"79cc66d1b80d461e\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/kernelPageDeletionGuard.js\":\"1bd3675c31245f03\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/liveRuntime.js\":\"1cfefcd3241f95f1\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/openExtensionsSettings.js\":\"25b54777093edd34\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/overridesCache.js\":\"ceec7706800a3be8\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/pluginIds.js\":\"3ecd3ef9e70a6334\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/processorRejectionToast.js\":\"04578b0a907813c0\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/runtimeActions.js\":\"c35b6c20da2f54f1\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/runtimeContext.js\":\"c35169ba5157573c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/staticAppExtensions.js\":\"7f85784621ab5f1c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/staticDataExtensions.js\":\"0799f41efdf175d2\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/toastAppMount.js\":\"5aa6bcf7c9f40dce\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/useOverrides.js\":\"529a0c8335a9348c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/useShortcutSurfaceActivations.js\":\"4659e68a4192e07a\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/discoverToggleTree.js\":\"13f0ecd742e9d353\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/facet.js\":\"b9adfaea6a4f14ae\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/resolveAppRuntime.js\":\"4fd8808ca4450fb4\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/runtimeEvents.js\":\"3905e5cea4683760\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/togglable.js\":\"a16751025dc6d8f0\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/variantFacet.js\":\"91fd704331ce3990\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/verbFacet.js\":\"c7abfbf9d9c3ede2\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/block.js\":\"1aad4ad3d41224fc\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/focusedChild.js\":\"59b5af1e6ce2ed6a\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/propertySchemas.js\":\"d65a3a0f6625905e\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/typeRegistry.js\":\"f4f03af9568c90b1\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useAncestorCrumbs.js\":\"561bcd9dbee4eae8\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useAutocompleteListbox.js\":\"06484b3649529f40\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useDebouncedSearch.js\":\"1c4627eb90906f57\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useDebouncedValue.js\":\"6e339fdb239c49af\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useFacetValue.js\":\"5576df3730c62f03\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useIsFocalRender.js\":\"ab3e8de66aacfd7a\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useIsReadOnly.js\":\"67e4988ea3f24f53\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useMaterializeBacklog.js\":\"bca4da4aa2332c64\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useMinuteClock.js\":\"0f4287edb686fb6f\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/usePanelLayoutProjection.js\":\"b67358d0625f822a\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/usePendingInvitations.js\":\"c7754a888449a5db\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useRendererRegistry.js\":\"96202dbca18c47d1\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useRetainedFieldRows.js\":\"bd74e3c4bf17965d\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useWorkspaces.js\":\"cf819b8af25a0efe\",\"/knowledge-medium/pr-preview/pr-1884/src/lib/utils.js\":\"396b8693d3134f9a\",\"/knowledge-medium/pr-preview/pr-1884/src/main.js\":\"325849a37519d4e6\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/MarkdownImage.js\":\"1377a2500eeaa0c0\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/blockSeparators.js\":\"fb9eecfa1d341eef\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/context.js\":\"c98fb7cec89235c3\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/defaultMarkdownExtension.js\":\"fe35ca2ef97b6270\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/extensions.js\":\"b03e5772ab0f7c25\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/renderMarkdownHtml.js\":\"64240fa174bbace6\",\"/knowledge-medium/pr-preview/pr-1884/src/minimal-editor.js\":\"32066a3e54e7a200\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/armedCut.js\":\"0a1f4a89b3e4e9f8\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/captureMediaVerb.js\":\"cb6a0580a5af25c9\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/clipboard.js\":\"2e19c0bdd88b33d0\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/decision.js\":\"e77af1c7edcd2969\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/operations.js\":\"3bff386f04aab8b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/account-header/AccountHeaderItem.js\":\"9b3445468413661c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/account-header/index.js\":\"ad0ff0314b41bb53\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7d7426873e602448\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/askAgent.js\":\"8b18b1295b41a3c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/askedStore.js\":\"02477046f12b04f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"10cfb0e5280cdc42\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/chipState.js\":\"cc9eac7f6795e6c0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7ef85ef33e579552\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/index.js\":\"6a30195c33819e2f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7334fae94e284ee8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/schema.js\":\"78f1f90a614419e2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/AgentTokensDialog.js\":\"213f6fa411af3732\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/BridgePairingDialog.js\":\"cd3cb8ef2bc7e167\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/addMedia.js\":\"5a087c5c9fa0b4c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a53922c00e5a1c62\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/block.js\":\"0fdc208fbd16f9c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/context.js\":\"bafba4a784101817\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/displayIds.js\":\"bd47a9b262d30f8f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/index.js\":\"f291448bba4e2426\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/outline.js\":\"471de14640d3129d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/properties.js\":\"cd6bf09ea6888bcb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/refs.js\":\"3104734e891137d0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"7947ade1cbf02d1b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/search.js\":\"33f2b781dd30e825\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/shared.js\":\"9819c28e66204b54\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d851cbc67c1ea6fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/text.js\":\"dfcabec0c30bed44\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentWrites.js\":\"d2f31d6a65ed58e9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/authoringCatalog.js\":\"a2af5620fe886a78\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/blockRefTargets.js\":\"4d0d15ee4e8b1f6a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/bridge.js\":\"6b658d69f47b42fc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/bridgeLoop.js\":\"39af0cd9176083b2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/changeHistory.js\":\"dc4397c0177d4661\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/commands.js\":\"7346102fbace6a8b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/commentsCommands.js\":\"6bcd9a8cf9f909d6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dataExtension.js\":\"06106a8b4e4acfb1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dataModelGuide.js\":\"e115bbf2e6008e66\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dayPropertyInputs.js\":\"a5064d749c298080\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/describeRuntime.js\":\"d9b6a0b3d16572e2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/extensionLint.js\":\"634256038d5aa184\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/grainAudit.js\":\"7c5fc66e2f8c80cb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/healthCommand.js\":\"b6ef95e0f0a170ac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/index.js\":\"04cd60ad77e1f543\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/presetIdentity.js\":\"cf3dd66fec4d359e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"75d3165774a331c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/readMedia.js\":\"39e2c1274a584008\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/schema.js\":\"80e8c5a5eb80b6b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/serialization.js\":\"9b989c64305478b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/targets.js\":\"748095061da755eb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/tokens.js\":\"b376a422b0b0b7c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/watchEvents.js\":\"ca140b773a8427a1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/workspaceGuard.js\":\"1b5f7c1d144f84fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/writeCommands.js\":\"7b8f257b1ff43c6e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/AliasCollisionToast.js\":\"e108ef51532575cf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/DuplicateNameBanner.js\":\"6d80a946d687d313\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/collisionMerge.js\":\"2824cc78401eae8b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/dataExtension.js\":\"65fda4cfb311670c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/index.js\":\"7feaaadeabfceba1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/mergeCollisionAction.js\":\"6c7be85f2958bf0b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/pageStyling.js\":\"7da5bdc798884aef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/rejectionToast.js\":\"15eaede8663b5fe1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/syncProcessor.js\":\"efc2e0e35434db8c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/actions.js\":\"a8c386296c5d738f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/addComment.js\":\"080fb1b9b2851c05\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/anchor.js\":\"271efb71c0f9be38\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/anchorState.js\":\"cddf80fcd831e75d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/commentLinks.js\":\"bc169b0e72a7c00e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/confirmThreadDeletion.js\":\"3ee2c241a48eee73\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/container.js\":\"a5d5c0a0912ccf72\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/dataExtension.js\":\"6477be6f0503a76a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/deleteComment.js\":\"6aba8590abbbe317\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/highlights.js\":\"5ac5c7dcc94a8a9f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/index.js\":\"cc7ab82eb22ac688\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/linkedCommentsPill.js\":\"bed535664bc6ee93\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/margin.js\":\"f65f280d34db2dc6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/marginAnchorLinks.js\":\"77c57f777337e959\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/marginSchema.js\":\"991532f979409594\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/newComment.js\":\"8208e7c5f8ba94a9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/ownThreadPicker.js\":\"2f783c8f39d34de6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/placement.js\":\"773661236ad7dea1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/queries.js\":\"1137219f4334ae95\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotePosition.js\":\"777c93c5d659b8f3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotedIn.js\":\"71748c68aa392eee\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotedRange.js\":\"cf9f1d1ba69e3746\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/rangeRefs.js\":\"f86553fd6fd9b4e8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readHighlights.js\":\"eb3313566308bcd4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readSelection.js\":\"4bd61b4fa55be583\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readSelectionUi.js\":\"7378dda4a0f25475\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/reanchor.js\":\"a08a02114f42493b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/schema.js\":\"5b29dfaf098113c3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/scope.js\":\"81b827b944580c48\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/scopeThreads.js\":\"ca29b8a12406f431\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/splitRetarget.js\":\"a5b4e38f520ff9ce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/suggestionCard.js\":\"055dd0b4f7fb9448\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/suggestions.js\":\"0245eb227ef9ad21\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/summaries.js\":\"6a4f657574c55d57\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/summaryBatch.js\":\"5f9bc7ba0ebc460f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/surface.js\":\"e117ab0a605c27bb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/threadNavigation.js\":\"dd448c3589cdeab4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/threads.js\":\"3a840c4fb1a667b9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/ui.js\":\"b30a903b9bf79243\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/uiStore.js\":\"9c068d32b105af40\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-intents/appIntents.js\":\"4fc80a55a483131a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-intents/index.js\":\"e6636378e3ca8347\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-update-prompt/index.js\":\"a577c3e29126b387\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-update-prompt/status.js\":\"34fd0c1b89c665b8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"52cc524bac387fc1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaBlockRenderer.js\":\"1cea9dc28c1f4d40\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaDownLaneReplicator.js\":\"f1eac0a09f3dfd43\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaUploadReconciler.js\":\"4a5f78142996329d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetDownLane.js\":\"3511f27529db0b83\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetResolver.js\":\"823532f99846c0a5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetUpload.js\":\"0e90ff26d18d1e10\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/attachmentCleanerIO.js\":\"8dcac9ba3237b22d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/supabaseAuditIO.js\":\"088fa20004d554d4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/blobStore.js\":\"ce8bd641c863000d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/browserMedia.js\":\"115fc968bf2a2ad6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/byteStore.js\":\"360243b21a6de83d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/cleanerIO.js\":\"2ea1a699499372f7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/cleanupAttachments.js\":\"269802cd390c671b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/dataExtension.js\":\"66ef41d3b6d05f98\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/downLane.js\":\"f1e9a1f1ea8b1a93\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/index.js\":\"68b7babea0120513\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/insertImageContribution.js\":\"50a95f4ff9368931\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/laneArming.js\":\"5bab72a1de513618\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/laneLock.js\":\"7c2e3482ae5cf668\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaBlock.js\":\"655ffed92c86449c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaCapture.js\":\"1ac14abd2cd693a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaLanes.js\":\"a94ff60c361d54d7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaViewers.js\":\"02eb14cb594abe84\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaViewersFacet.js\":\"88aee44142473cdd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/pasteCapture.js\":\"ee4b7a5cc551bc08\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/resolver.js\":\"47bfb3571e781a84\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/retryUploadsAction.js\":\"ba0c429af26f1172\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/storagePaths.js\":\"8d62f4f5535d8e16\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadDrain.js\":\"768dcf182d0bb776\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadLaneStatus.js\":\"32b6538eca2e8143\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadReconcile.js\":\"4637bcb791c9ba15\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadRecovery.js\":\"8bdae6e6f80b9297\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadStore.js\":\"01438b084c2b7847\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/useAssetObjectUrl.js\":\"9d0f6a1d384b87fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0e4ebed6823b8fc8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/BacklinksViewSection.js\":\"79218e04979f89c0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/facet.js\":\"2b09d962e192ff6f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/index.js\":\"af8bf2257e51cff9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/prop.js\":\"0698c86cafb4466f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BacklinkFilters.js\":\"a6e23524b735a332\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"60eb02ac360891ed\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BlockEntry.js\":\"4017148e8d64f53e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/LinkedReferences.js\":\"18fa56f7ae625384\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"1f613e4e518ff0bd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/dailyNoteDefaults.js\":\"c19ceb903dd56b87\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/dataExtension.js\":\"57d3ecad89ac4611\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/edgeExclusions.js\":\"5287d47f64b21e7c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/filterProperty.js\":\"7c8e8aa904bb4e1d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/index.js\":\"c385281a9d71aa99\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"aca8e5f68d62d216\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/applies.js\":\"2aa495048134d932\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/countQuery.js\":\"6445dde70e1f6448\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/expansionStore.js\":\"b1eb9da4bb777bb4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/index.js\":\"47df3a260e42b723\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"fb1f1dcab8a50871\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/presentationInvalidation.js\":\"bb8305981e89e59a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/propertyEditorOverride.js\":\"1ff594a9f203ecb4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/propertyFilter.js\":\"1d572220cbd86537\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/query.js\":\"c645336159129bec\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/resolveFilter.js\":\"27ad21617514de66\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/sourceBatch.js\":\"168ff15cfe469329\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/sources.js\":\"4333dd71aced9aa4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/useBacklinks.js\":\"65233e8a50b37f7e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"ad090f368668e661\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/BirthdayCelebration.js\":\"83c73e6bbc08bb63\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/BirthdayOverlay.js\":\"f88a5ca1ee46c13c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/gate.js\":\"0b65f1e393194e29\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/index.js\":\"b041d0bc3e492b50\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/wolfTheme.js\":\"ac248660c041a0b8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/BlockDragLayer.js\":\"bb73495d5795df05\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/dragController.js\":\"b80e048c10c50667\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/dropTarget.js\":\"c39221bce3df8693\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/index.js\":\"727625e806f8d4d1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/projection.js\":\"0797b7d393aa6fca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-info/BlockMetaCard.js\":\"011a7edba30c0f46\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-info/index.js\":\"9c9a901191ba8eba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/AddTagDialog.js\":\"7b6c49465672da3f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"d0b2df190e3f7dfc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/TagNameIssueHint.js\":\"ffaef619ff85b539\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/addTagAction.js\":\"9af47b9e8a721c10\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/appendTag.js\":\"e681a6acb4af4a8b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/config.js\":\"11520533a00b45cd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/dataExtension.js\":\"242b74a12b03be10\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/index.js\":\"fabdec3821d2410d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/propertyEditorOverride.js\":\"0311100fcf13bbc0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5f66f84351256bc8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"9dad21e583fa2389\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c5717b74aa6adb8a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"fdc8d05ca293f968\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"070ae0ee00683975\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/index.js\":\"b5b0b5373a3d2a8e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d91052a4367be945\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/CharacterCountItem.js\":\"c54dbfa918987a5f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/ProfilePropertyEditor.js\":\"0c0de2079ee42aad\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/actions.js\":\"df3323e5bf4caba8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/blockType.js\":\"2e5454f10cc230bc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/charCount.js\":\"349be0cf44fb83a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/dataExtension.js\":\"2347e8bce95d3e3d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/index.js\":\"dd497b367e2b80b8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/profiles.js\":\"def1394b851af148\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/properties.js\":\"183c1f7fbef2cb0a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/subtree.js\":\"c49ba006214065f6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/textCounts.js\":\"6313a8b8d0a1d889\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/colemak-keybindings/index.js\":\"a75ad1dd49304466\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/CommandPalette.js\":\"80227e6737644ce7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/HeaderItem.js\":\"d248f962bc643003\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/context.js\":\"fd188beca6132d79\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/index.js\":\"b563cefc34abefb2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/selection.js\":\"7cfc05da0a87e961\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/toggleStore.js\":\"5c452dd2f4878945\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/useCommandPaletteActions.js\":\"8d3b16cf696ee04b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/ContributorBadges.js\":\"468d56030238e19a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/author.js\":\"4482daad6637eadd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/codeMirrorExtensions.js\":\"54d0ca11a53756d5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/dataExtension.js\":\"1936d0fc0f8ea8d5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/index.js\":\"0cbae4353692d800\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/mentionAutocomplete.js\":\"85b118cf8653f7f7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/processor.js\":\"c061a206ccf009d0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/profiles.js\":\"71fb2c7904daa227\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/queries.js\":\"75cccc1f26c43920\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/schema.js\":\"1b497f0b0029bbee\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9dd042da0b97fb06\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/followOrigin.js\":\"db6df39dd7516cd4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/index.js\":\"328ec10719aa4b8f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"48d6468db94f7be4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"083c076b39fd7197\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/CalendarGrid.js\":\"f22e70f73194d15c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DailyNotePicker.js\":\"1c20a7f3932dcc54\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ef94503777906e8c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateNavDecorator.js\":\"ccae8730517c699b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateScrubOverlay.js\":\"eae424ed11a9d3f5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DayPropertyControl.js\":\"2f74bc88a44ffe9c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DayValueReferenceControl.js\":\"e7c052ebfa3dba68\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/HeaderItem.js\":\"a5df46cdb03c03e6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/ReschedulePicker.js\":\"424b8648174c92cc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/SpreadDatesDialog.js\":\"3fcea23858520016\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/actions.js\":\"c5520c6a764058c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/blockDateAdapter.js\":\"0cfd17c6316316ff\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/calendar.js\":\"71fb4e9cc599948b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dailyNotes.js\":\"4ba1c75e67a7ba19\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dataExtension.js\":\"0af697917ab478d7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubActions.js\":\"66903ab89403ae18\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubGesture.js\":\"88d34ee10f02fd23\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0a84caeabe8611fb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c8acc72a9a64833d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dayProperty.js\":\"d1a80e14c0b97530\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"2541eb6dba928f48\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/deletionGuard.js\":\"8727f658621a5dfe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dueQuery.js\":\"7eddf3734b8be07a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/index.js\":\"e4c5b8fc734e1088\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/landing.js\":\"d79e876fd6aecf34\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/localSchema.js\":\"e6574ce29ed01696\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/referenceDateAdapter.js\":\"64de129bd9c57e87\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/rescheduleAction.js\":\"510d632a6df57710\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/schema.js\":\"3a67271dfb3b53a1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/spreadBlockDates.js\":\"b86c22f69dbc4127\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/spreadDatesAction.js\":\"d605553307806fe9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/today.js\":\"aa00a45901138afb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"986ff921201ad503\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a10da3cacd754496\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/audit.js\":\"0c20f4fa783dcb37\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/auditAction.js\":\"622838bcb08e06f3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/auditRanges.js\":\"5a5db2be870a11a9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/diagnosticsSource.js\":\"e6bbcc185ccff88f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/divergenceScan.js\":\"bc7748a8dfabedae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/index.js\":\"3e6c0ee346ec732d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/propertyChildrenChecks.js\":\"5df6dbe9ccd18c40\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/referencesMirror.js\":\"560be12d6403a951\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/rowJson.js\":\"35ab299bccdc5c50\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/schedule.js\":\"2aaeb7c7efcfe6c3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/store.js\":\"5eb6f1c5575c4763\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/action.js\":\"aa74b9149a915dd5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/index.js\":\"5aaf4619ff41f1c9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/plugin.js\":\"78bb21d2c082ceb5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"169505f59ee66968\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/actions.js\":\"09e4ea2384fa88f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/changeMarker.js\":\"60d3c8cbcc11c85c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/diagnostics.js\":\"f92c2cd86fe9edce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/fileSystemAccess.js\":\"8b4791cda7021062\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/filenames.js\":\"7d529617e5d70dcb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/index.js\":\"0fc295545054d89a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/mirror.js\":\"d099b85fef388b4c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/runLock.js\":\"58f74c0c20ed6a15\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/runtimeHealth.js\":\"e2485717a573a077\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/schedule.js\":\"48765a97565ee249\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/store.js\":\"3e63043ec06597a1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/default-themes/index.js\":\"801c96b524e29937\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/default-themes/themes.js\":\"f1e5c181fb8ec4bc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/diagnostics/facet.js\":\"83c8cc177a41d789\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/diagnostics/useDiagnostics.js\":\"3da862fb50695838\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/dismissals.js\":\"09d82669775c0d93\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/index.js\":\"8aac4e6e9ba2d5cc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/status.js\":\"e0484a283a70c8cc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/store.js\":\"29449f70b5a3f3cc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"dfff3af16834100a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/ExtensionsSettings.js\":\"e1bde5c7800a700d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/actions.js\":\"3334787eaf9d243f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/config.js\":\"06cbbf80244877b8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/dataExtension.js\":\"1d3dd2c1cae941ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/effect.js\":\"095ca7c6f147ad87\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/index.js\":\"136c35cffa624476\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/propertyEditorOverride.js\":\"536e8a9bc1d6dcd2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/useToggleTree.js\":\"233345c78d32dace\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/ExtractTypeDialog.js\":\"408ff5bc94b55fb1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"82ef7e4a2ebf9dfa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/PropertyShapePicker.js\":\"ad599a94075873b1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/action.js\":\"4c4917415a18fbb6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/index.js\":\"4745166ac180dd1a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/FindReplaceDialog.js\":\"2553b481305698d3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/HeaderItem.js\":\"f511a626bbccdf0c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/dataExtension.js\":\"3447c3c9a6443411\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/index.js\":\"3d8f144f5c981b3d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/search.js\":\"35a273fb168da503\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/toggleStore.js\":\"7407358fc8a95fa6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/LocationPropertyEditor.js\":\"a60a88498fc856e2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/MapView.js\":\"122e0df936811ba9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/blockTypes.js\":\"558f3529b2325208\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/codeMirrorExtensions.js\":\"62e886cb01ef2304\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/createOrFindPlace.js\":\"71d3c2b1f348b72d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/currentLocation.js\":\"674eb4a272f7d746\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/dataExtension.js\":\"f113fb980d183952\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/geoContentDecorator.js\":\"9270da28afae5322\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/googlePlacesClient.js\":\"1fe76674d06a7bae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/index.js\":\"3ef321e3b7b99148\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/locationsPage.js\":\"cacf32c1500fe6d9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/mapViewport.js\":\"6089cd0d303931a4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/pickCurrentLocation.js\":\"7b4ee1890125e726\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/placeAutocomplete.js\":\"42cc28ced2d89b60\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/placeNameCollision.js\":\"ede0a83211c01d20\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/properties.js\":\"cc878cc3803a2e57\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/propertyEditorOverrides.js\":\"3818ba09155ce336\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/query.js\":\"77a4046a6db3f3bb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/usePlaceSearch.js\":\"9e1825303a4cae9a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"38344b556da2f946\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"17078af7236e13de\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8e2b763ffece195b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/config.js\":\"25036f5753bbc4ac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/dataExtension.js\":\"e6501d56eb671709\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/facet.js\":\"4447f7ec2c8048db\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/grouping.js\":\"ec101751e8b9b8ad\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/index.js\":\"e97511bca5dcebe9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"54b4bc53e4353654\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/query.js\":\"255470cdc10c20b1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/resolveConfig.js\":\"a18b480f9992482d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"4ec62c259fd88ea9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"35556af9ac4339e7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/HtmlDocumentContent.js\":\"216f163433e2c2ed\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/HtmlFrame.js\":\"b8122efe71a81e0b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/actions.js\":\"7f3714d5eed4212c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/blockType.js\":\"f8865a9da5006fb8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/confirmRunScripts.js\":\"e2365982bbac8126\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/dataExtension.js\":\"e85fc94b95660405\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameAnnotations.js\":\"2f1fd6985ca4948e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameDocument.js\":\"29a38f2143bf0065\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameTheme.js\":\"a85d9b8fb294a4ff\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/index.js\":\"3b9127ec31b2e498\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/scriptConsent.js\":\"3ffbff2e2a4c6863\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/sourceMap.js\":\"ee6c9f02b3ef89c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/useDocumentScripts.js\":\"d9a589cd1eb9fd3b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/index.js\":\"60ad03e7718da492\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/record.js\":\"0f68e98e90b4c21f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/recordStore.js\":\"9003a88b2ad21260\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/responsiveness.js\":\"12023d4def256de0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/schedule.js\":\"22109a5a5ff26c3a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/sessionContext.js\":\"314b598ac28caf25\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c0a70f442245afd7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"42d1e8b2a3ddfa93\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/actions.js\":\"1d674ea399a672db\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/config.js\":\"16ef16f8859099bc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/dataExtension.js\":\"21ac6e2c75e89fe5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/effect.js\":\"89a8faf6e63ac20b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/index.js\":\"86d478566c731e91\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/keyCapture.js\":\"95f10e2e01675ea8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/overrideStore.js\":\"17c50377da1f90f3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"01adf8d73f7022af\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/HeaderItem.js\":\"725490824f72e05c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/LeftSidebar.js\":\"bc8e4a2582a0bb12\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/actions.js\":\"f5abf7592c2d3c2a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/facet.js\":\"610d058cce9dbf3d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/index.js\":\"5aa99fff3d78d4f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/shortcuts.js\":\"f202d0066399cdf3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/toggleStore.js\":\"53f2f66f56a9e57b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/MergePicker.js\":\"88c8107d808c6a67\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/index.js\":\"e149dbfce5c80aaa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/mergeAction.js\":\"363604be1bd33bc9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/strategy.js\":\"e42581520bd779c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/Button.js\":\"1608feb691a01d64\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"731e544ad5b1281a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/defaultItems.js\":\"58ba1b287f5d7154\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/facet.js\":\"7209c8de78857499\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/index.js\":\"4c8d8c229f2eed3c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"509d6c60f376cb92\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4637d76e1be57cab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"356e9f0e7f47beff\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/facet.js\":\"05633879bcb50035\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/index.js\":\"539d51a2185645bb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/MoveDestinationPicker.js\":\"7fcbf94c0841bad7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/blockSubtreeMembership.js\":\"8ef1a133e17a5200\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/contextMenuItem.js\":\"9f7a0397725a22e8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/index.js\":\"229a1ee6a8d7e500\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/moveAction.js\":\"89200349f8c7473c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/moveBlocks.js\":\"492f702750977472\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/selectionAfterMove.js\":\"f722f5b1d1b2591f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/TutorialBanner.js\":\"15ea6cd03d03f4d9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/action.js\":\"2ba556d7ee5a2188\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/bannerDismissal.js\":\"92884dd3794d9f17\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/documents/cheatSheet.js\":\"b891ea03c119d39e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/index.js\":\"99d041cf851b4684\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/keys.js\":\"95c18a1ab0ff25e2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/landing.js\":\"f13885fdb03890ce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/outline.js\":\"c308525a668cd001\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/seed.js\":\"b076b310f1c00def\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/PerfTrendDialog.js\":\"eaee022c6fdd38ae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/analyze.js\":\"792835c4f2df8329\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/diagnosticsSource.js\":\"a52a49eb8dc1de29\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/index.js\":\"fbca79312af80232\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/load.js\":\"471453461651ac4b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/monitorRun.js\":\"0b86fe05203f466e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/schedule.js\":\"2f7af25ffbde2075\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/series.js\":\"978a7a199ff9549c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/store.js\":\"d007334486f052a5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/trendAction.js\":\"06e37a398a81a23e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/verdict.js\":\"3a9bc77ac19cb91d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/clickToEditAction.js\":\"6314a4707b3439b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/index.js\":\"cff587b1aca153ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/interactions.js\":\"e9dc41d60cb7c47b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b2b5388df9721ade\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/MigrationGate.js\":\"e8412e0cde9742bf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/MigrationGateDialog.js\":\"7ca2a6c6ed678fce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/action.js\":\"b374f95ff2edadcc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/index.js\":\"f981b76eb90431f9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/localRunMessage.js\":\"bc4ac1f304a3e417\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/plugin.js\":\"5309481d1eb51a50\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/progressReport.js\":\"b961c40a1e729aa4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/sweepProgress.js\":\"8e41e238fa694075\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/FieldRowRenderer.js\":\"4436c243c33f7dc3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/ValueRowRenderer.js\":\"a7ffd348c0fc2b9c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/actions.js\":\"2a0e97457d5e48ac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/autocomplete.js\":\"e8a125dd18274cbc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/fieldRow.js\":\"d3c06d49a3929afe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/index.js\":\"97e31b232f214850\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/referenceWarning.js\":\"b7e4b32fad2cd333\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/valueAutocomplete.js\":\"eb365fbea7f42a69\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/valueSchema.js\":\"e456974a792e349a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/HeaderItem.js\":\"a1a2488ab686b632\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/QuickFind.js\":\"9d17fba25124f205\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/index.js\":\"8575ab8652c95f83\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/recents.js\":\"1aefd82c6dc7861d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/resultItems.js\":\"516f0b875e46a6bd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/selection.js\":\"da9ef0d7f3bdb26b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/toggleStore.js\":\"a69344df1e0baa6e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/HeaderItem.js\":\"023a5992f10df1cc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/RecentsPageBlockRenderer.js\":\"69fb5c890738580e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/grouping.js\":\"b68ec632a972741c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/index.js\":\"09444dcee8f087a1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/target.js\":\"b6a12e69ce79961f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/codeMirrorExtensions.js\":\"0e0b5091e5bd0e22\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/contentPrefill.js\":\"eb53b0140b8017b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/dataExtension.js\":\"1ad1065d5cbd41d4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/index.js\":\"a770d08490ec0425\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0587ba60bab7446c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/invalidation.js\":\"aee0d56d680403cb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/localSchema.js\":\"5f17da632822bb08\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/blockrefs/index.js\":\"d1e14a8acb634635\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"0a32e404012891d1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/index.js\":\"ac7966fecec8eb47\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/referenceNode.js\":\"f5b98b221f7a7334\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/remark-reference-occurrences.js\":\"bdfc8a9123a75254\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9ac22b46f3d0bfe2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/index.js\":\"28f8b02271f9c8a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e37f784feb9d4878\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"509535e522d6b25e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/mergeRetargetProcessor.js\":\"73bf6a434885cd54\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/parseFence.js\":\"b2e070da5674818f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referenceParser.js\":\"7a1acbd3d9c49cee\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referenceProjection.js\":\"62194755c122949c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referencesProcessor.js\":\"d27c59fb050c8300\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/renameProcessor.js\":\"66ff2e4c216f00b2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/spanReplacement.js\":\"1fef79b7d8bc4cb0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/htmlToOutline.js\":\"40a0223a7f5e2248\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/index.js\":\"ebfe0eda3954d69f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/normalizeClipboardDom.js\":\"8644db420f082ef4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/pasteDecision.js\":\"d62220d9d4aac551\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/action.js\":\"98afbc2f268e8b48\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/blockIds.js\":\"bee72b0699d4aa8b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/content.js\":\"c45e147c5b355095\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/effect.js\":\"bdb9367175050087\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/ids.js\":\"43df9824bbab869f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/import.js\":\"7fb0fe87ed6b26d0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/index.js\":\"1a82eb9a7fc67778\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/plan.js\":\"4c583697fba73408\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/plugin.js\":\"115778e9aef8095e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/promotion.js\":\"4c5a8deef28a88b2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/properties.js\":\"c58a8264a1a32947\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/references.js\":\"c38537304399fbd0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/report.js\":\"6f53124e0af03848\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/roamMemo.js\":\"4f7b8c0f3fe90777\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/runtime.js\":\"df7f8efd92213e68\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/schemaReconciliation.js\":\"d9324a58f44310d3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/srsMarkers.js\":\"dc136f481ffb2ffc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/todo.js\":\"f94c60b1cbb1ee7a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/typeCandidates.js\":\"2a80105e8d9d412b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/types.js\":\"6fec7bf17b1d05ab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/search-health/index.js\":\"bec53dc0881d985b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/search-health/store.js\":\"a47ac471f95213c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/HeaderItem.js\":\"e1a79d5c0bc237cf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"4acca37c4d052a6d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/index.js\":\"9c04604ef00a1aaa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/model.js\":\"74466bee62a0f7d2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/toggleStore.js\":\"8295fb466b1d95d2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/useKeyInspector.js\":\"59cf4a3db22adc9b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"14886a3279ca5a3a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/ShellDecorator.js\":\"d9632d28b05e378c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/actions.js\":\"adf45d767221f512\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c0df3c4581dd531c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/index.js\":\"a0ea74d6b7049b84\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/shell.js\":\"02c49d46980dd0f7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/surface.js\":\"d17d15635e9bdd3f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/walker.js\":\"8082ed393159dd18\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d1422957a3dc302b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/dataExtension.js\":\"f1684681a68fe0e9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/index.js\":\"04f4bb642b64bd41\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/indicator.js\":\"c0da058a326c6356\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/moveSrsState.js\":\"a8f5c12d1154bd60\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1eb42349c66e0cea\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/scheduler.js\":\"c05f494495bce2e2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/schema.js\":\"d40d3bf1ecde7110\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"137f2205e0ad5e1c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/srsClipboard.js\":\"9e5023f215076068\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5b38eba88aabd893\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/DailyNoteReviewHint.js\":\"300c628f6f76bd72\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/DeckPicker.js\":\"aacb17ec482751ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewControls.js\":\"0685401988959e76\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7c38462d144c97b8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewSession.js\":\"c9611c781c0286cd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/actions.js\":\"17b2144b3d724c8f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/archive.js\":\"9c1bf891b9a4375b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/dataExtension.js\":\"a981288cb6a5e181\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/deck.js\":\"c9021f105e37b94c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/dueQuery.js\":\"98d597f0925957b2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/gradeDecision.js\":\"4e2a52350894099a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/index.js\":\"f031e8cbed521c72\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/keyHints.js\":\"f05e7c94b6c56c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/reviewCardLayout.js\":\"199ced651bf1d8a4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/reviewProgress.js\":\"873f5e0a824b5173\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/schema.js\":\"700052b270d65547\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/useDueCards.js\":\"2a374d9d43ede924\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/startup-metrics/index.js\":\"174fc94aaa76a7c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/startup-metrics/record.js\":\"ae6731644dfb7a04\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/index.js\":\"29f7524afbd3c6e9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/persistenceStatus.js\":\"3ea8f9430db3e17f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/requestAction.js\":\"afb64ed883db3234\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/TypeChipsDecorator.js\":\"cd86f88746bc7a9b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/codeMirrorExtensions.js\":\"ca94f873520c1af4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/index.js\":\"6a8123b193f8ff49\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/typeAutocomplete.js\":\"aca434674fb0e481\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"059ffe0ff5db7617\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/actions.js\":\"501ac0aed126adbb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/anchor.js\":\"6182ed516035b5e5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/events.js\":\"6c87a4590ef084f7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/gestureActions.js\":\"221750d2294fe535\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/index.js\":\"f2031d71105b711a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"977e3b17b9e45a80\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/collect.js\":\"fe5df212baf978bd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/index.js\":\"3012118670027554\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/record.js\":\"34cee9622fdf26f9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/RejectionDialog.js\":\"b66e0522f251799b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/SystemStatusHeaderItem.js\":\"0ea1e71c5dcc29c0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/index.js\":\"e7b3fca4b5d01612\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/model.js\":\"06fa0bd99454d4a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/queueCounts.js\":\"657e61b640855429\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/rejectedHelpers.js\":\"5af1ecef12a1edd5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/rematerializeAction.js\":\"c55e666895207753\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/useHysteresis.js\":\"bd9f224b8cede314\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/ColumnHeaders.js\":\"cb551414c7005426\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/QueryUi.js\":\"b8915f0362148ca7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/TableLayout.js\":\"39e8d926d354636c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/actions.js\":\"452b3997c9b6d872\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/cellEdits.js\":\"516d49461f2bcac9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/childrenViews.js\":\"c0af7705db83a8b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/columns.js\":\"0ecb6223bb5a12dc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/controller.js\":\"ca3eac2fd11e8d89\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/convert.js\":\"f0bf8abe02794816\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/dataExtension.js\":\"c15a473b8079fd15\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/index.js\":\"e4f5212b6fe55075\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/keys.js\":\"915f0932b480eda1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/model.js\":\"a7c34d065ced66f5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/QueryText.js\":\"1e35184a40426628\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/backfill.js\":\"39ab6ad13171a3b2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/completion.js\":\"a9b0c56272832a2a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/format.js\":\"deeb7fd037ce0f22\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/parse.js\":\"da3bcc6228487f08\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/queryValue.js\":\"e0a9dec28f1e6f85\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/registrations.js\":\"1e06e275f66a463d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/source.js\":\"d078db09764f4aab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/registry.js\":\"1905940b63b190a0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/rowGutter.js\":\"ea8e63e15ebc7811\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/rowVerbs.js\":\"5f7aa4be358b4edb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/schema.js\":\"627e6e60330dca95\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/sort.js\":\"a1bfe036630dd794\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/effect.js\":\"387d31311d5c39bb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/index.js\":\"38390feb076b5549\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/theme.js\":\"ec0dd75a98d4e02a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/actions.js\":\"c763881315069cf7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/dataExtension.js\":\"5cec2e54ff357ec5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/index.js\":\"b176fb63e2585dd7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/schema.js\":\"88f4591d5d1f6251\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e1933f254d97faab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/actions.js\":\"d6ba7f703d5c7ea6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/defaultItems.js\":\"71de562e218a9e70\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/facet.js\":\"e9c5bd273df28c67\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/holdRecognizer.js\":\"25aa0fc64f368d86\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/index.js\":\"b84ee3899e5a0ca1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/UpdateIndicator.js\":\"791ceb772dbf70ab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/index.js\":\"63dd021f9aded5b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/loadTimes.js\":\"0a18da128b10f89b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoNotesRenderer.js\":\"4d10fbdef02addf2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoPlayerRenderer.js\":\"4ee6fcd10667d8ac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoTimeStamp.js\":\"d4883283fad82b69\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/actions.js\":\"8400c9e303dec46c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/index.js\":\"d3bb9021e0da973e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/markdown.js\":\"d311cbf51b751401\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/notes.js\":\"c3892eee2156240f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/registry.js\":\"59874cbd79ed3288\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/remark-timestamps.js\":\"34cc1d87ca38200b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/view.js\":\"35c7bfcd65b7f622\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/LinkHints.js\":\"1decaee2c93b646e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/index.js\":\"b9b7f8a1db215923\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/model.js\":\"fb29ca78eeea8032\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/settings.js\":\"56039fad204c359d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/actions.js\":\"d603cb1bf32afcf0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/index.js\":\"82c247f51f6e5869\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/interactions.js\":\"de804cf19c0e34ee\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/workspace-header/index.js\":\"bebbc528d9e0fb78\",\"/knowledge-medium/pr-preview/pr-1884/src/registerServiceWorker.js\":\"25ffc18619f3c15e\",\"/knowledge-medium/pr-preview/pr-1884/src/requestPersistentStorage.js\":\"7127f1ec4c7561e3\",\"/knowledge-medium/pr-preview/pr-1884/src/services/authRequestDeadline.js\":\"fd0b6dd4508b3c46\",\"/knowledge-medium/pr-preview/pr-1884/src/services/authStorage.js\":\"f56204f2dd243e01\",\"/knowledge-medium/pr-preview/pr-1884/src/services/powersync.js\":\"8c94ea0e554c5667\",\"/knowledge-medium/pr-preview/pr-1884/src/services/supabase.js\":\"5d9e00a6f2e2a34b\",\"/knowledge-medium/pr-preview/pr-1884/src/services/uploadErrorClassifier.js\":\"0be61f71af8cdb99\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/ActiveContexts.js\":\"f3973a3f92a106cc\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/HotkeyReconciler.js\":\"dc9a0c325da9bc21\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/WipeLocalDataDialog.js\":\"ca14414a7b8fbfe7\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/actionDispatch.js\":\"7d83730a2a1a7ed5\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/actionRefItems.js\":\"173a132451b2f3d5\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/applyKeybindingOverrides.js\":\"5db60b465e015a18\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/blockActions.js\":\"56c7990b6d29abee\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/blockMergeGesture.js\":\"67d22a974c46b042\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/canonicalizeChord.js\":\"3282b577e03b25bd\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/defaultContexts.js\":\"3e1726894a514486\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/defaultShortcuts.js\":\"dac7bc742165f5f8\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/effectiveActions.js\":\"0bff7fcf28259a40\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/gestureAction.js\":\"6d96ed1fdad78be6\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/gestureBinding.js\":\"42cdd941acb526a0\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/holdRegistry.js\":\"1ce44383559123b0\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/keybindingConflicts.js\":\"930868be85c63873\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/keybindingOverrides.js\":\"ffe54014980cc849\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/pointerAction.js\":\"382f9fc75f77e0ef\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/resolve.js\":\"6464537fc1669044\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/runAction.js\":\"b5693214806abc86\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/sequenceMatcher.js\":\"16661fbd18ee943b\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/types.js\":\"040ed28c6d75130c\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/useActionContext.js\":\"537cf8afc66c84df\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/useActionDiscovery.js\":\"5509112ef196b530\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/utils.js\":\"044208382199a609\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/bootStore.js\":\"96558bc65a628443\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/previewDatabases.js\":\"f7719952b6857099\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/byteTransform.js\":\"2b5998292c5c8751\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/attachmentCleaner.js\":\"d7d4729927b417fb\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/attachmentParts.js\":\"8407c99dd880b3f5\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/bundleParts.js\":\"ac56503bd1ac2571\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/bundleRecord.js\":\"ba1600ac2527e545\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/manifest.js\":\"b40db778cdb0f816\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/takeBundle.js\":\"3861241707632160\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/verifyBundle.js\":\"ee7e20652ca46652\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/cleaningStage.js\":\"59237d5195b929bd\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionKey.js\":\"ddb8d0b8a317d9bc\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionServer.js\":\"0b1eb9611b1d4e45\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/flip.js\":\"3496b9e73b61d3ef\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/flipAttempts.js\":\"1e3a417bf1ccebac\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/pages.js\":\"30d357b1ff369c3e\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/preflight.js\":\"0d36f4cf4c79a3c7\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/reseal.js\":\"384e2013d0c353b9\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/runConversion.js\":\"8698a01e1339fbfc\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/runLock.js\":\"5fdf37aa3bf8b3f6\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/sealing.js\":\"8ea6f5539ca1c3b9\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/sealingStage.js\":\"88ed33f20ccb74f4\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/stage.js\":\"47e4cbf1fa4c56d0\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/verifyReseal.js\":\"50c6e07c5186fbbd\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/aad.js\":\"b3140d1a48f4d7f9\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/aead.js\":\"79f26c4c16394ff9\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/base32.js\":\"1fb9952340cf0950\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/base64url.js\":\"a68842af5d90e8a1\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/binaryEnvelope.js\":\"edc4569c100fe34e\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/byteAead.js\":\"e0ba93363233d4fd\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/canary.js\":\"0f12f7d79af3e487\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/contentHash.js\":\"4fb57724313dabf4\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/contentKey.js\":\"0ec90d7e354c9049\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/derivedIdNamespace.js\":\"7fdf4afb77ff6a3f\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/envelope.js\":\"0b95b4dae9e83752\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/hex.js\":\"eab4d2d9017f4da2\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/sha256Hex.js\":\"b9be9025bcc04b71\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/workspaceKey.js\":\"f81bc01b59f1d7b5\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/conversionState.js\":\"1db8fe6e49e649af\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a309d22303f3aea1\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/pastedKey.js\":\"d7c9f48acde9696e\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a399d14f2802e3b9\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a9135ee340395c8b\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/keyStore.js\":\"8582b212f61d088b\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/mintWorkspaceKey.js\":\"514aa9037630a6d0\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/modePin.js\":\"3074a0f979e8810d\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/openWorkspaceKeys.js\":\"5c36af051085db0d\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/resolveWorkspaceEntry.js\":\"93c12fe0df624a03\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/resolver.js\":\"988feef99af660ba\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/workspaceAccess.js\":\"4914ba6e58635f69\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/transform.js\":\"b8d82dcab6105824\",\"/knowledge-medium/pr-preview/pr-1884/src/themeBootDefaults.js\":\"404aed674273cd94\",\"/knowledge-medium/pr-preview/pr-1884/src/types.js\":\"da6e81b9715386bf\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/ClientLocalSettings.js\":\"907e92a96e236264\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/abortableSleep.js\":\"1bb966d2f2d9acd1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/array.js\":\"2e874f2b84074863\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/backlinkAutocomplete.js\":\"207b805bcd696902\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/blockCrumbs.js\":\"9479d2dda66cfd7c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/blockrefAutocomplete.js\":\"8a532e5cba9878f8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/cadencedIdleJob.js\":\"6f3f76f7346010b6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/callbackSet.js\":\"92bd471000e83b8b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/clientId.js\":\"59f5358128068a77\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/codemirror.js\":\"53168dff2d091d2e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/codemirrorCompletion.js\":\"efddc515b51f280e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/copy.js\":\"f10618dbb40da4a6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dailyPage.js\":\"f7a226300266fdf7\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dbForensics.js\":\"e3510eefc3575a32\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dbForensicsHooks.js\":\"efd80e2517a60571\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/deleteBlockThroughUi.js\":\"7b1d30fc1f242aba\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dialogs.js\":\"168347e0f59f589d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dom.js\":\"d920df3f65547312\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/downloadBlob.js\":\"a832ca72f6c7de44\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/drawnWalk.js\":\"b769c0438a867a3f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/exportSqliteDb.js\":\"30d984c77d7849f6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fileSystemAccess.js\":\"4ba75e86b0643da5\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/flipSlide.js\":\"33f8e51b6ed72319\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fnv1a.js\":\"31be43a92a6b3b35\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/formatBytes.js\":\"450f80051d9a28d0\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fuzzyRank.js\":\"fa729cd08a4233a6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/idbKeyedStore.js\":\"ad988080f281584c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/idleCallbackPolyfill.js\":\"5a3fe55089127e5c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/keyboardAwareScroll.js\":\"6a16444236896f4f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/keyboardViewport.js\":\"b51b1bbc044d29b9\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/lastWorkspace.js\":\"cfcc38ea10e2af65\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutColumns.js\":\"7107e5b10d4f0f76\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutSessionDom.js\":\"c8610c55204dd7e1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutSessionId.js\":\"6c47df9e2086c442\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/linkClickGestures.js\":\"6b4ac7a988d9dca2\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/linkTargetAutocomplete.js\":\"f90cc4bb7152bead\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/localDbCorruption.js\":\"4b7d233d9f0f6594\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/localDbRecovery.js\":\"4285f9bc563d301c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/markdownParser.js\":\"bad6240df4b130a1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/memoize.js\":\"790592c8f7c3956c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/nameFieldCommit.js\":\"6c6b0876ec523f8b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/nameList.js\":\"b22b6cb18963940c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/navigation.js\":\"afb9e7ddc348bc0e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/omnilinerNamespace.js\":\"315de228eaf5dc3d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/opfsPageScan.js\":\"6e5da03ef0d2147e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelClearance.js\":\"e88f2887db37a67b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelHistory.js\":\"b3d4ee35d891d47e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelLanes.js\":\"b2913725c706769f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelLayoutProjection.js\":\"beb9a269fb6e9c46\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelScrollAnchor.js\":\"b650fbe6110fea89\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelUrlFlags.js\":\"a4ec298de6f271d2\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/platform.js\":\"d514cfe0a406f7b0\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/pluralize.js\":\"046bdde18adfda0f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyCreation.js\":\"56aa6ffc0cbdbbda\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyNavigation.js\":\"2c71e8e68202e65c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyValueContext.js\":\"27cbaf49e82c3cae\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/react.js\":\"86940c129235136a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/relativeDate.js\":\"c97a1e5fe7249773\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/relativeTime.js\":\"22bd370f30e122b0\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/renderScope.js\":\"baceb70e98c4ee31\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/resolvedThenable.js\":\"ec305683b7b54da3\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/routing.js\":\"2f6ab240a9133ded\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/safeMode.js\":\"f5c02c891a3991a3\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/scheduleIdle.js\":\"6ab18dbe65373bc8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/screenWakeLock.js\":\"502465c391d39cfe\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/selection.js\":\"fb2192eaf060f51a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/softKeyboardGrab.js\":\"bb9162a0e36d080a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/startupTimeline.js\":\"8f3cb18873535029\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/state.js\":\"298862b55d2dd43e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/string.js\":\"757247fc0455400f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/surfaceZoom.js\":\"07f0be02b4771492\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/time.js\":\"4089254c6b7ed9cd\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/toast.js\":\"9b2edefd58568271\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/toggleStore.js\":\"6f4f5ccc862cb138\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/untilStopped.js\":\"1ba92d021cda9db1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/userActivity.js\":\"61ea3829f3c3a7c3\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/viewTransition.js\":\"55caf3b1df92826f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/viewport.js\":\"0ad170cfebc869d3\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/webLock.js\":\"a4c2d11536ff8372\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/workspaceRecovery.js\":\"137da3a53a829591\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/workspaceSnapshotStore.js\":\"5375123717b6cb7a\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-compiler-runtime.js\":\"8bdebcdc18987f17\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-client.js\":\"28f3fa667150c4c5\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-server-edge.js\":\"ff3583cf586f4020\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-server.js\":\"0345d580f7ee1b1e\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-static-edge.js\":\"eb1a5a8e3553cfe8\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-static.js\":\"2e2419f8e0fae5c4\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-test-utils.js\":\"21a453371470d0b4\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom.js\":\"c75e7c37e1195dc1\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-jsx-runtime.js\":\"a5a0e6ff74404dcc\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react.js\":\"4bd480c7c2b8a479\",\"/knowledge-medium/pr-preview/pr-1884/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1884/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1884/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
