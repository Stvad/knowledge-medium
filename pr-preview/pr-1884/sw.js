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
		buildId: "9637c087d64b-1eeef2e9",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/\":\"30e9459a5a9692b2\",\"/knowledge-medium/pr-preview/pr-1884/index.html\":\"30e9459a5a9692b2\",\"/knowledge-medium/pr-preview/pr-1884/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1884/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1884/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1884/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1884/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/pr-preview/pr-1884/assets/FacadeVFS-CZaZubyA.js\":\"452ee8ccaf3632a7\",\"/knowledge-medium/pr-preview/pr-1884/assets/OPFSCoopSyncVFS-DRXZrIUY.js\":\"b8ea73ac2df32151\",\"/knowledge-medium/pr-preview/pr-1884/assets/OPFSWriteAheadVFS-B-yZHJr3.js\":\"b0a02404a97ed504\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-BS2QWGnH.js\":\"0517618f12db4340\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-async-BPFsksgB.js\":\"17f6a60a8fd23bf0\",\"/knowledge-medium/pr-preview/pr-1884/assets/worker-9LcMb2Hh.js\":\"aef896ed4be63d75\",\"/knowledge-medium/pr-preview/pr-1884/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1884/chunks/app-CzXsWXQ_.js\":\"a375f0a6dcc477ae\",\"/knowledge-medium/pr-preview/pr-1884/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1884/index.js\":\"89065c569671fbe9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1884/assets/AccessHandlePoolVFS-EiQkhSYC.js\":\"fd1ee9ae005ac7f1\",\"/knowledge-medium/pr-preview/pr-1884/assets/IDBBatchAtomicVFS-ByKXhiwu.js\":\"d87443cd047eff78\",\"/knowledge-medium/pr-preview/pr-1884/assets/MemoryVFS-C994MB5Q.js\":\"b6c1d748ad1ed335\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-DpNyrni7.js\":\"14aa37c3d28ad0fa\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-async-l6kr3bLo.js\":\"31eed6ab5c5837a9\",\"/knowledge-medium/pr-preview/pr-1884/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1884/chunks/AccessHandlePoolVFS-DDmRLDCT.js\":\"115c8c063dc1f392\",\"/knowledge-medium/pr-preview/pr-1884/chunks/FacadeVFS-CxAARmdt.js\":\"f0a323e429e0bbae\",\"/knowledge-medium/pr-preview/pr-1884/chunks/IDBBatchAtomicVFS-nmNKgo4e.js\":\"463daf3932bd370d\",\"/knowledge-medium/pr-preview/pr-1884/chunks/MemoryVFS-95xrbwWz.js\":\"aa0d007b46af8d35\",\"/knowledge-medium/pr-preview/pr-1884/chunks/OPFSCoopSyncVFS-DEhuBRD8.js\":\"2eadd7c76aefc710\",\"/knowledge-medium/pr-preview/pr-1884/chunks/OPFSWriteAheadVFS-DkuLYQIZ.js\":\"5644b51f8b19c804\",\"/knowledge-medium/pr-preview/pr-1884/chunks/Preview-DfwCQGZi.js\":\"47861f5e9579c2d6\",\"/knowledge-medium/pr-preview/pr-1884/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1884/chunks/card-C6Zc3pjH.js\":\"1e3e3603de4c88f0\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-BVZnESwP.js\":\"3a69bc946d664554\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1884/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1884/chunks/mc-wa-sqlite-DFyKaaxw.js\":\"b99c56c32a3d3a91\",\"/knowledge-medium/pr-preview/pr-1884/chunks/mc-wa-sqlite-async-DDdztWG6.js\":\"4f4dac2e549d9d9d\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-7TLA1Aoz.js\":\"ebb91f0351d2fb34\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-B26DT193.js\":\"7302dfcb41db012a\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-BOiApJ_P.js\":\"b97d99bdbcec7987\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-BY9o3bNJ.js\":\"be4661a7cfe608f3\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-C0l6K8Ov.js\":\"7044cac7efa9f044\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-DLu2L1k8.js\":\"56b2b8796b28d20d\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-Dhi0CeJn.js\":\"03142da6db94a4d8\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-Dmx9P3YE.js\":\"8f49b3c8202631d5\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server-legacy.browser.production-DEWvAkiA.js\":\"8ac5264179be89a3\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server.browser.production-CHcHo4rF.js\":\"d6f916a287617082\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server.edge.production-DALDIheR.js\":\"b3739384c57121c0\",\"/knowledge-medium/pr-preview/pr-1884/chunks/server.browser-D3-mPJiL.js\":\"d36b6285bc04420b\",\"/knowledge-medium/pr-preview/pr-1884/chunks/textarea-CY2A6xJ1.js\":\"7bf9919f37cf7036\",\"/knowledge-medium/pr-preview/pr-1884/chunks/ui-CzNG5sTP.js\":\"3401f98d0fa153cd\",\"/knowledge-medium/pr-preview/pr-1884/chunks/wa-sqlite-CcK4Ra1E.js\":\"249711f0f25cd8ab\",\"/knowledge-medium/pr-preview/pr-1884/chunks/wa-sqlite-async-C4pAzbgW.js\":\"4ac3bd399a8977e3\",\"/knowledge-medium/pr-preview/pr-1884/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1884/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1884/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1884/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1884/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1884/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1884/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1884/src/App.js\":\"4cbf5cc6bdb131e1\",\"/knowledge-medium/pr-preview/pr-1884/src/appUpdate.js\":\"02bf175558bad8d8\",\"/knowledge-medium/pr-preview/pr-1884/src/appVersion.js\":\"c977d0379710f12c\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/initialLayout.js\":\"d45f2587dd6a1c90\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/openWorkspaceData.js\":\"7b0aead76f1155fc\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/resolveWorkspace.js\":\"79ce39512df2bfa1\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/workspaceBootstrap.js\":\"25087d8973e46198\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockComponent.js\":\"dbcc27d8811ed80f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockCrumbs.js\":\"194eb62048cf3173\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockEditor.js\":\"1814dd0edfce574b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockLoadingPlaceholder.js\":\"291cd380083b4714\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockProperties.js\":\"85802f7565b62fff\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockSearchPicker.js\":\"ded4fe984aefdacc\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ConfirmBulkDeleteDialog.js\":\"82add0ad17b51236\",\"/knowledge-medium/pr-preview/pr-1884/src/components/DividerHandle.js\":\"e3dc858cf0fa8021\",\"/knowledge-medium/pr-preview/pr-1884/src/components/DraftEditor.js\":\"6542940db025608b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/GutterPill.js\":\"118fb9331a0fed77\",\"/knowledge-medium/pr-preview/pr-1884/src/components/Header.js\":\"a6033496e9354e6b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/LazyBlockComponent.js\":\"84c72fe7d9488433\",\"/knowledge-medium/pr-preview/pr-1884/src/components/Login.js\":\"944d115d61601845\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ZoomableSurface.js\":\"489b1422bb56d3af\",\"/knowledge-medium/pr-preview/pr-1884/src/components/editModeKeepalive.js\":\"758999566885b9f2\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9790b20666ba5a9b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"185563c8e100a227\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/RefPropertyEditor.js\":\"618efbe5a264d352\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/RefTargetTypePicker.js\":\"098d68685cb59549\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/SelectPropertyEditor.js\":\"bb9f1e2029be2d8f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/TypesPropertyEditor.js\":\"0387bcf8be5ffda9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/defaults.js\":\"ee12147fdf8a7d04\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/kernelValuePresets.js\":\"7396d7129b5cabd8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/selectablePresets.js\":\"f5f7c978b8149de1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/typesPropertyUi.js\":\"a37f869bea01b42b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/AddPropertyForm.js\":\"4cc09b9eb90e58bf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/PropertyPicker.js\":\"5f289a937851ffa9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/PropertyRow.js\":\"78ec738bebf6cf63\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/Rows.js\":\"239cef79713eacaf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/actions.js\":\"470759fa83a0ba8c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/declarationOnly.js\":\"28df682132b366bf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/layout.js\":\"aed522217325bc16\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/model.js\":\"49c4f3c02f99a53e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/shapeUi.js\":\"f3aec234bc3404d2\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/shapes.js\":\"dfc1c7a3ea6d950b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/usePropertyEditingActivation.js\":\"fafc08fa8937c9a7\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/visibility.js\":\"1b182c68257329ac\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanelSections.js\":\"95e861ae19aaa45d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockEmbed.js\":\"bd81fd32590057a5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockLink.js\":\"74b747084a7eccc7\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockRef.js\":\"6273e6924b070f41\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/ReferenceLink.js\":\"3a185d7200fd2d8e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/cycleGuard.js\":\"6a6229980937ab23\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/cycleGuardContext.js\":\"6b586a53e5ba3243\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/linkInteraction.js\":\"3054953f0cff2d7e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/referenceLayout.js\":\"733fe6032f53a31d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/useBlockRefAncestors.js\":\"7cc778e17b13d4ef\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockGutter.js\":\"7bacb697de1774da\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockInfoDialog.js\":\"57a5ed2c53dea373\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockTypeBlockRenderer.js\":\"89c72896b6c477b3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BulletHoverCard.js\":\"0ae6eacd6acbdc44\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/CodeMirrorContentRenderer.js\":\"238e728f6a0a9e52\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0fbf31c5d3646513\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/ColumnResizeHandles.js\":\"27fd7288e56e928e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"23d6921689c98205\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/DefaultBlockRenderer.js\":\"a21c8b0e21d1d81e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/LayoutRenderer.js\":\"e2012a269331659b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/MarkdownContentRenderer.js\":\"66454a498c466db2\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/MissingDataRenderer.js\":\"6c2d7f80c6137d06\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/PanelRenderer.js\":\"4867cf20d8d00533\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/PropertySchemaBlockRenderer.js\":\"00a88e32fd4e26a9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/TopLevelRenderer.js\":\"d93d641d7d2bbcc1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/blockGutterMode.js\":\"188eaaefb98aff41\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/blockTitleText.js\":\"dc41bb827b130f05\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/fieldCreationKeydown.js\":\"2db368725bb42bf9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/layoutRootContext.js\":\"1f565980b2558153\",\"/knowledge-medium/pr-preview/pr-1884/src/components/typeChip/TypeChip.js\":\"4aafe718924a5812\",\"/knowledge-medium/pr-preview/pr-1884/src/components/typeChip/chipStyle.js\":\"d284572ad54660a6\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/anchored-floating.js\":\"4e31c063cd656e72\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/button.js\":\"ae276f370f9dea5e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/card.js\":\"54bbe69f215bcf2d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/checkbox.js\":\"b4b983be478e43e0\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/collapsible.js\":\"f9009ead0a58b4b3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/command.js\":\"3b2743cb88924216\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/context-menu.js\":\"574582e1e8212346\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/dialog.js\":\"6b04fdeb979f99d6\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/dropdown-menu.js\":\"f03a654c039af24d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/floating-listbox.js\":\"4d998bced6fffab4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/index.js\":\"5cf0c7ee077c5ba7\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/input.js\":\"675df5f03a61aa80\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/kbd.js\":\"d4fbeb2de8e0612c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/label.js\":\"5c0a3fe9a0eef5ac\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/textarea.js\":\"0514f469b78e978c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/useEditModeYieldKeepalive.js\":\"8f8f5cc0f448a8a0\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/BootFallback.js\":\"a35bd95425e0b517\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/FocusedRowLazyMount.js\":\"cd9459aa4d0bc48f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/LazyViewportMount.js\":\"8c46e300b5c45f2a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/LocalDbCorruptionFallback.js\":\"bbfaa1ff14379d96\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/error.js\":\"213aec1c1eeed4aa\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/lazyMountRegistry.js\":\"e35f8f68ba2d85ce\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/suspense.js\":\"e4d9d027eb62313b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/CreateWorkspaceDialog.js\":\"3fe338e5b1c61890\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/PendingInvitations.js\":\"cef4cc6854aa7515\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/SyncProgress.js\":\"dac18b4f26f536e6\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/UnlockProgress.js\":\"111e7e0221d4a7d3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceKeyGate.js\":\"089cae21f5a816e5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSettingsDialog.js\":\"b576516deeeabc96\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSwitcher.js\":\"23fe363bda1e6430\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSyncGate.js\":\"b12356bd7278d456\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/ConversionFlow.js\":\"350875f4acd93469\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/ConversionFlowHost.js\":\"0291556367738b51\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/EncryptionSection.js\":\"17f73aba9b01dac5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/attachmentPrompts.js\":\"7e39a06fad7c174c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/bundleFolderPrompts.js\":\"4d410cd63d6336db\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/conversionFlowDeps.js\":\"6239f2b5e660dd27\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/conversionFlowStore.js\":\"cc566c914d1e79b0\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/flowUi.js\":\"efa8583121133b61\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/useConversionRun.js\":\"0e100415a20856a6\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/keyUi.js\":\"ce5d3b1b5d40e122\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/useCloseOnKeyLoss.js\":\"2ef0883926e9155b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/useCloseOnServerE2ee.js\":\"f8ade92db8db20d1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/workspaceUnlocked.js\":\"03cb073f4c782005\",\"/knowledge-medium/pr-preview/pr-1884/src/context/backgroundSubtree.js\":\"f580c599fdf6b24b\",\"/knowledge-medium/pr-preview/pr-1884/src/context/block.js\":\"3c64e95f7c38adc1\",\"/knowledge-medium/pr-preview/pr-1884/src/context/layoutWsContext.js\":\"0aec6dfdbc060131\",\"/knowledge-medium/pr-preview/pr-1884/src/context/propertyDisplay.js\":\"792a03b31ccb38c2\",\"/knowledge-medium/pr-preview/pr-1884/src/context/repo.js\":\"fe3c77f904710697\",\"/knowledge-medium/pr-preview/pr-1884/src/data/aliasClaim.js\":\"32ebeeeaaa002781\",\"/knowledge-medium/pr-preview/pr-1884/src/data/aliasSeatNamespace.js\":\"635ac3f4ad8db27f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/blockData.js\":\"e746399168558385\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/blockType.js\":\"a9e4278fe3a470c3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/changeScope.js\":\"38a6a12a8a16cd92\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/codecs.js\":\"fbfab3ef9a554489\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/derivedData.js\":\"4960a509e3635ac9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/errors.js\":\"01ed4345ba476307\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/events.js\":\"85c42ebefc8aa9ec\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/handle.js\":\"75de788f75259482\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/index.js\":\"3186de0bf6a39d58\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/mutator.js\":\"b7e903b380c44e9c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/processor.js\":\"d6baeacbfee92847\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/propertySchema.js\":\"375c791a2b6f8dec\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/query.js\":\"df7a85dba0ce8a1a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/sameTxProcessor.js\":\"28d05f5613b22dfa\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/schema.js\":\"75de788f75259482\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/tx.js\":\"75de788f75259482\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/typedBlockQuery.js\":\"f0b23cfc3250968a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/user.js\":\"c001aafa92e3f529\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/valuePresetCore.js\":\"73d306e97a8e654a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/valuePresets.js\":\"de14cacd466789a7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/attachmentCleanerIOVerb.js\":\"2365317259323509\",\"/knowledge-medium/pr-preview/pr-1884/src/data/block.js\":\"1e90c716096592af\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockCache.js\":\"a71f5cb12d9a0bfc\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockId.js\":\"e5fe1c78d958172e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockLiveness.js\":\"eddb6e0644ba1daf\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockMerge.js\":\"3e84182952ed01b2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockSchema.js\":\"8b3777808ef413a6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockTypeLookup.js\":\"20817ac303f9eb75\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockTypes.js\":\"06674db23ac4a390\",\"/knowledge-medium/pr-preview/pr-1884/src/data/childrenView.js\":\"845d71b6beca566f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/clientContext.js\":\"b3551cbd97597652\",\"/knowledge-medium/pr-preview/pr-1884/src/data/dbFileSiblings.js\":\"b8cfff1774ad2c42\",\"/knowledge-medium/pr-preview/pr-1884/src/data/definitionSeeds.js\":\"8518cd815a1cce58\",\"/knowledge-medium/pr-preview/pr-1884/src/data/derivedIds.js\":\"9bde94b4fc272df5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/drawnSubtree.js\":\"c0c53f71137abbb7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/facetBridge.js\":\"814e11bd57f882c4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/facets.js\":\"70d558603df5941a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/globalState.js\":\"73de512fdc0b8a74\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/aliasClaimRederiveProcessor.js\":\"8f762326e555c689\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/ancestorBatch.js\":\"581cc6aba4bc7f96\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/blockTypeTypeifyProcessor.js\":\"306f85f83937eb15\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/clientSchema.js\":\"13d99c2520bbcc5f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/commitPipeline.js\":\"a315a3c456336bfe\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/devAssertions.js\":\"1d978829bfe63f33\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/firstSync.js\":\"ddc6c34e86bd6bec\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/freshInitialLoad.js\":\"ef93963b56d637ee\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/graphBackfillClaim.js\":\"9179d2aab985add4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/handleStore.js\":\"fade834f93c89934\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/idleMarkerJobs.js\":\"f7974b227dfe8e8d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/initialDownload.js\":\"5c0d688eb9dd120b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/initializeClientDatabase.js\":\"45902e5691397de8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/jsonCanonical.js\":\"c4c47d8d79c90a5a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelInvalidation.js\":\"6c424eac45554bce\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelProcessors.js\":\"77fc9d1141646b9c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelQueries.js\":\"588ef11916685cea\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/mergeTypeMembershipProcessor.js\":\"cc8fdc19b197ea7e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/normalizeReferencesProcessor.js\":\"0415280a50cc4548\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/poolInstrumentation.js\":\"dfc2e568e8e2c7c4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/processorRunner.js\":\"9b6bbdaef218bb4d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyCellBackfill.js\":\"18dccb3277980565\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyChildMint.js\":\"5edf2892a7b7c7d9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyChildrenProcessor.js\":\"0cc57f7ac75f2459\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyDefinitionChangeProcessor.js\":\"560e232b4410edd4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyDefinitionSynthesis.js\":\"b380661cada5821e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyKeyScan.js\":\"6e213f798611b731\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertySchemaResolution.js\":\"93efcfd85f5348ab\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyValueEdits.js\":\"a359482bc0c06e35\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/raiseProtocol.js\":\"91f8e332e2951181\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/readBatch.js\":\"a3fec82dc4821e7a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/refProjection.js\":\"9986b3fe9e0167b3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/referenceTargetLookups.js\":\"088bb126d4c9525c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/referenceTargetProcessor.js\":\"c6388eb898af65e1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/replayMerge.js\":\"78237548fffe1022\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/sqlBinds.js\":\"ca4c88a68e180d82\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"847358291c92aeb7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/arrivalProcessors.js\":\"0a573d586ec7e7eb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/invalidate.js\":\"f5d04ba67e223523\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/materialize.js\":\"b3b27f4749d5f8ea\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/observer.js\":\"4d3103214ae1a823\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/reconcile.js\":\"96260d5beae2acae\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/timingMetrics.js\":\"6b32a3e7b3160164\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/treeQueries.js\":\"92a04dfb5c20962c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/txEngine.js\":\"186c212ec91cddc0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/txSnapshots.js\":\"a5d74df1d4af4dba\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/typedBlockQuery.js\":\"450f6cbea5df3c38\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/undoManager.js\":\"dc0a6d19d8122c9b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/invalidation.js\":\"4b7fcdbd756ff2de\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelDataExtension.js\":\"ff2457c7522ff071\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelPage.js\":\"0cdd4ae6b5894738\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelValuePresetCores.js\":\"98512470cdcfd7e3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbCorruptionSignal.js\":\"aae04de7e1bd2be4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbStorage.js\":\"2bfb90581b0d09a0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbVfs.js\":\"7b066cff6835464b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localSchema.js\":\"c53a29e378351b5f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/maintenance.js\":\"8d245312eae4d865\",\"/knowledge-medium/pr-preview/pr-1884/src/data/mergeProperties.js\":\"258f719f28841577\",\"/knowledge-medium/pr-preview/pr-1884/src/data/metricsConsoleHook.js\":\"b754afbecdbf3ff9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/migrationsPage.js\":\"4f6de29d63994de7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/mutators.js\":\"6fb47be800892b64\",\"/knowledge-medium/pr-preview/pr-1884/src/data/orderKey.js\":\"c5877e38c00d6ee5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/orderKeyPlacement.js\":\"8c38fbcedce7bfc2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/outlineSurface.js\":\"9b30de909102eb2f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pendingEditorContent.js\":\"b90a42478188d411\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pendingUploadsSql.js\":\"d65bcf3ee51e11f2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pluginStateExtensions.js\":\"8add16571a4dbcf1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/powerSyncLogger.js\":\"afd7f51976596a57\",\"/knowledge-medium/pr-preview/pr-1884/src/data/projectorRuntime.js\":\"9fd9300af3ebfc56\",\"/knowledge-medium/pr-preview/pr-1884/src/data/properties.js\":\"fee2051e51460458\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertiesPage.js\":\"cec389b32db55885\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyChildren.js\":\"d7e5b1ed915f53bc\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionFanout.js\":\"8a9065aacdbdceb0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionMetadata.js\":\"a902e91a9b22e955\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionRegistry.js\":\"d0b53a26d9e41ea5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDisplayMode.js\":\"e8fda88fee4034cd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyRowCreation.js\":\"8d38646308fb96d1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertySchemaCreation.js\":\"ed46037c571bb257\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertySeeds.js\":\"bdecce7978e65263\",\"/knowledge-medium/pr-preview/pr-1884/src/data/recentsPage.js\":\"5a6fcceaca4d1765\",\"/knowledge-medium/pr-preview/pr-1884/src/data/refTargetComparableProperty.js\":\"8966827413b970c7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/referenceBlock.js\":\"50d1591f907d2620\",\"/knowledge-medium/pr-preview/pr-1884/src/data/rejectedUploads.js\":\"289b81ea9c7d3d91\",\"/knowledge-medium/pr-preview/pr-1884/src/data/releasePowerSyncConnection.js\":\"5cae79afc29634c4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/repo.js\":\"75b4e880ba8e7a6c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/repoProvider.js\":\"ac0d6b511e2d070e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/rowProperty.js\":\"8c0466d8f484a690\",\"/knowledge-medium/pr-preview/pr-1884/src/data/searchFilter.js\":\"2c1f30649dfe0cbd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/seedIdentityLedger.js\":\"6fe9bf0886c15547\",\"/knowledge-medium/pr-preview/pr-1884/src/data/stateBlocks.js\":\"b23896449833ffcf\",\"/knowledge-medium/pr-preview/pr-1884/src/data/structuralEditPolicy.js\":\"be20893c150e1be7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/structuralInsert.js\":\"9d45810d0ec9fbad\",\"/knowledge-medium/pr-preview/pr-1884/src/data/subtreeDelete.js\":\"8eaa5665582546de\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncStreamLock.js\":\"032d8bafc6a82552\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncedTableSqlRecognizer.js\":\"78f877352ad5e917\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncedTableWriteGuard.js\":\"d7bbbe63a4bcf055\",\"/knowledge-medium/pr-preview/pr-1884/src/data/targets.js\":\"52674d621d21e99c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeColors.js\":\"a4d7af6b7f04286d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeDefinitionMetadata.js\":\"8ea894fa388cb6ef\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeDefinitionRegistry.js\":\"c0504db907fa8055\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeExtraction.js\":\"5f1df3c22f841264\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeInitialValues.js\":\"b5b44ae550dd919b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typePropertyGroups.js\":\"5b8718a49292e91a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeSeeds.js\":\"2aea52e3f31b485c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeTagger.js\":\"42edf874ce96c76c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typedRecords.js\":\"1a601708d1f2efb9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typesPage.js\":\"6c672e36793eea61\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userPrefs.js\":\"73ec7a064b2d04ff\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userSchemasService.js\":\"efb5a685568d6e0e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userTypesService.js\":\"479141a11c0e4614\",\"/knowledge-medium/pr-preview/pr-1884/src/data/valuePresetRegistry.js\":\"067e21ea317d0929\",\"/knowledge-medium/pr-preview/pr-1884/src/data/visibleChildren.js\":\"c3907b1798f2ec22\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceConversion.js\":\"fc86bc1790c205fe\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceFirstSync.js\":\"6f08068507e66424\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceIdNamespace.js\":\"13b2fbbf5ecc4964\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceSchema.js\":\"954d7cf5c01e8646\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaces.js\":\"208b61a0a645d770\",\"/knowledge-medium/pr-preview/pr-1884/src/data/writeAheadLog.js\":\"8c57bbf0da91a2e8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/BlockPasteShellDecorator.js\":\"b8906fd3321f92b7\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/atTrigger.js\":\"94392aa352d997a2\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/autocomplete.js\":\"db9e09484ab61e88\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/codeMirrorExtensions.js\":\"0aabe6d0e58bd840\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/contentFlush.js\":\"621ead56e805a650\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/defaultInteractions.js\":\"e75ab0b708e340d4\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/editSettleSignal.js\":\"a5bb9b63239a2287\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/insertImage.js\":\"de19695ae2f84758\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/referenceCompletionRange.js\":\"bc533ac282519ed0\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/referenceTargetTypes.js\":\"06467bdca99a3930\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/syntaxContext.js\":\"806968f55f4a472e\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/triggerMatch.js\":\"04c3b106a948d56d\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/AppRuntimeProvider.js\":\"941b367dfddaf41b\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/BlockFocusShellDecorator.js\":\"82ad1e3b91490f09\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/ExtensionRenderBoundary.js\":\"1c531ba91b8824a8\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/PanelContentRecovery.js\":\"b75fca309521787c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/apiCatalog.js\":\"6ce13d64c05aa825\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/approveExtensionHere.js\":\"d2d450e9861a70bf\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/armedCutAppMount.js\":\"d60d6cb64ef5fca5\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/batchableKeyedStore.js\":\"cb65bad527de466b\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/blockInteraction.js\":\"575b0a70bb0fba7c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/blockSelectionAction.js\":\"84c75759ff75d46d\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/compileExtensionModule.js\":\"21f72c378a64bac3\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/compiledModuleCache.js\":\"86a0de5c8e741008\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/continuousGestures.js\":\"85f6dbce575560c0\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/core.js\":\"788b21b412e19e46\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/defaultRenderers.js\":\"d5fcc9f9bdd85171\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/definitionFanoutAppMount.js\":\"9cff94b24b08967b\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dialogAppMount.js\":\"9ad0cd89561e235d\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dynamicExtensionSeeds.js\":\"ccec548ea40cfd8b\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dynamicExtensions.js\":\"82c456eb197de07d\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/exampleExtensions.js\":\"f96e254f6903ac87\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionApprovalStatus.js\":\"c1c346d2b4a4b136\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLoadErrorToast.js\":\"cf05c0b027fb3343\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLoadErrors.js\":\"52566fb2f91a2ff8\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLookup.js\":\"511edba9e44a6eaa\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionToggles.js\":\"9be34a6cd53e7849\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionUtilitiesCss.js\":\"016d9d7d41471e44\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/kernelPageDeletionGuard.js\":\"9d06c64f7f8f2752\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/liveRuntime.js\":\"c61d3e1e1bfef0d1\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/openExtensionsSettings.js\":\"4954ddf6800bcf5c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/overridesCache.js\":\"c280b78f0973311f\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/pluginIds.js\":\"d7fabfe7f5f839d4\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/processorRejectionToast.js\":\"3250a67ead2bf17b\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/runtimeActions.js\":\"0eff8e00fc680b3e\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/runtimeContext.js\":\"972c8e1fa2aa1795\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/staticAppExtensions.js\":\"7137cee63812a5b0\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/staticDataExtensions.js\":\"767b9e6783a94f77\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/toastAppMount.js\":\"37a819ae54e372aa\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/useOverrides.js\":\"cda92b60ab8eedcc\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/useShortcutSurfaceActivations.js\":\"67e963b9a7f1d47a\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/discoverToggleTree.js\":\"2830882ffa230aeb\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/facet.js\":\"34fb2220a1a04e28\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/resolveAppRuntime.js\":\"98ffc00a98563d6e\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/runtimeEvents.js\":\"270dd1da2dd202ea\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/togglable.js\":\"4d4d5ec649ee7a05\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/variantFacet.js\":\"aa6dff2258cc5908\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/verbFacet.js\":\"648012f9b27c852b\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/block.js\":\"99b5d8f1159af150\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/focusedChild.js\":\"847dc9a19dac7498\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/propertySchemas.js\":\"378a74aefcd68db6\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/typeRegistry.js\":\"19cb8ea2164af84a\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useAncestorCrumbs.js\":\"15833206d31f8428\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useAutocompleteListbox.js\":\"b07aa7a3a0b7cbfd\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useDebouncedSearch.js\":\"92eba64fcba7d2e6\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useDebouncedValue.js\":\"81533bea675019b4\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useFacetValue.js\":\"6e3f24be5185fa90\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useIsFocalRender.js\":\"24c34069654c57b9\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useIsReadOnly.js\":\"9ac4ae6a2421d3af\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useMaterializeBacklog.js\":\"6fabeee79b7086bd\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useMinuteClock.js\":\"4e5234257ea446cd\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/usePanelLayoutProjection.js\":\"a15c2d499a674528\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/usePendingInvitations.js\":\"7baec260da65123a\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useRendererRegistry.js\":\"a8b3e32f12791333\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useRetainedFieldRows.js\":\"c68ca81558f4abd9\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useWorkspaces.js\":\"74080b558b9d4542\",\"/knowledge-medium/pr-preview/pr-1884/src/lib/utils.js\":\"7fb081e820b4f963\",\"/knowledge-medium/pr-preview/pr-1884/src/main.js\":\"c1269202f1e6bc30\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/MarkdownImage.js\":\"effb01449915593f\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/blockSeparators.js\":\"80db4dd062b41baf\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/context.js\":\"f9b0d3051374d657\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/defaultMarkdownExtension.js\":\"96079ece15795a56\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/extensions.js\":\"abe1630f6e37fc48\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/renderMarkdownHtml.js\":\"c4654bcc6ed1b28d\",\"/knowledge-medium/pr-preview/pr-1884/src/minimal-editor.js\":\"ac5a44da1277da61\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/armedCut.js\":\"1d4ee85a7f7e65f4\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/captureMediaVerb.js\":\"f635f5f6d550d68c\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/clipboard.js\":\"b342efd90775f447\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/decision.js\":\"414cda0912ff2264\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/operations.js\":\"793f9ad6e604d735\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/account-header/AccountHeaderItem.js\":\"b22663ab1211e44e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/account-header/index.js\":\"eef10b0bf18b888c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"8e849b34656d2dc6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/askAgent.js\":\"26b82f764ae2ca28\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/askedStore.js\":\"b6e10bd4a71fe538\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"970fce0419c5c575\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/chipState.js\":\"c4dcd5d84291ffff\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/dataExtension.js\":\"b8d7745c3ed83e49\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/index.js\":\"c49933d6be23554b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"450d565f41584a90\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/schema.js\":\"7ebecc39c58e8528\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/AgentTokensDialog.js\":\"53b6f098163414ec\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5fca6220926fef0f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/addMedia.js\":\"8d368fef7b7c18e3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/backlinks.js\":\"0163462905b054f9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/block.js\":\"c146244a36f117de\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/context.js\":\"ca23b83dbf6271c0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/displayIds.js\":\"70fc43d91114cf72\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/index.js\":\"76da310c34acd6d8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/outline.js\":\"bdf04e4665b1c305\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/properties.js\":\"8f60ef9c8e32fc56\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/refs.js\":\"5e2e7120ff52abc7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"1f2a10db0e01a826\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/search.js\":\"d29867b2e5dd57d0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/shared.js\":\"23508ffc236290c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"477780d966a9e833\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/text.js\":\"8202ced410f5c97e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentWrites.js\":\"64276f0cee902118\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/authoringCatalog.js\":\"d5314cd6fd13616b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/blockRefTargets.js\":\"7a54dce7dbe64e8f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/bridge.js\":\"33e899be36bd5a0d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/bridgeLoop.js\":\"1f1f86890d95c9fa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/changeHistory.js\":\"3d1471db0c2f48c5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/commands.js\":\"ac575e1ada983e70\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/commentsCommands.js\":\"46138d26f13082ac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dataExtension.js\":\"9a01c0e092555274\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dataModelGuide.js\":\"610fade10e90e8c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dayPropertyInputs.js\":\"93f852e70a3c3f59\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/describeRuntime.js\":\"d90d90bebef749db\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/extensionLint.js\":\"3838eb74c5115c13\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/grainAudit.js\":\"15413b6ae9f9692d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/healthCommand.js\":\"de03ca510bed6e24\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/index.js\":\"d75d8f022307b591\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/presetIdentity.js\":\"141fa53a85779b66\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e86e8ff6cbd18a7e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/readMedia.js\":\"f54522592367e2da\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/schema.js\":\"b1b1d69e33e4b6ed\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/serialization.js\":\"84b59bec377db9b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/targets.js\":\"136052bc25d9ae61\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/tokens.js\":\"27c9ef4c93937b3a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/watchEvents.js\":\"193031e30d203ff0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/workspaceGuard.js\":\"94267661f8663e6e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/writeCommands.js\":\"ff09d7ab0715cc69\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/AliasCollisionToast.js\":\"06ea166bc371edd7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/DuplicateNameBanner.js\":\"7cd9380dd035c799\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/collisionMerge.js\":\"6009d38c7511bb91\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/dataExtension.js\":\"1836f05ad42324f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/index.js\":\"403455b3915521fb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/mergeCollisionAction.js\":\"371df1c0f8ef95fa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/pageStyling.js\":\"25224ef99a100a6a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/rejectionToast.js\":\"0523d9cc3b984fee\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/syncProcessor.js\":\"66298d88424f717f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/actions.js\":\"f76ba7b70ed6f336\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/addComment.js\":\"fbbde2fb881d8bc9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/anchor.js\":\"f6355704e1a1961c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/anchorState.js\":\"07210c50cfbe05c1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/commentLinks.js\":\"ac8326acd539a597\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/confirmThreadDeletion.js\":\"ca530434c5caac2f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/container.js\":\"e231c2e77b86b90d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/dataExtension.js\":\"897211c01ab5ab89\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/deleteComment.js\":\"6e26107fce5c8c18\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/highlights.js\":\"0a43abe6a77a5c25\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/index.js\":\"3dcced621b700a94\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/linkedCommentsPill.js\":\"5f916812cdba84a9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/margin.js\":\"084792775b819bdf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/marginAnchorLinks.js\":\"b0010134d5144b4f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/marginSchema.js\":\"ce87dae619c9bccc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/newComment.js\":\"3df4a403bedd0da5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/ownThreadPicker.js\":\"3534e70cadf41bae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/placement.js\":\"1815bc78cbd0532f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/queries.js\":\"f826970591150ab6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotePosition.js\":\"f1d5b5b67832d2ed\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotedIn.js\":\"4969e0b61ad696da\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotedRange.js\":\"6c17b075aa1bae03\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/rangeRefs.js\":\"26a4ea3e2c5b9f16\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readHighlights.js\":\"61c7ac64cba00fe2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readSelection.js\":\"c559ba510062261b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readSelectionUi.js\":\"24e355d7f064c010\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/reanchor.js\":\"09a29d90ea2c5372\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/schema.js\":\"9c663210cbe17ee7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/scope.js\":\"dc23659c5af3494c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/scopeThreads.js\":\"1798eea061667a98\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/splitRetarget.js\":\"337e37aed1b5ed0c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/suggestionCard.js\":\"5b506560c668dd56\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/suggestions.js\":\"f61d93d93744751a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/summaries.js\":\"5cfe11a289817167\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/summaryBatch.js\":\"b96168046cf5a133\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/surface.js\":\"c2a868325747aede\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/threadNavigation.js\":\"3ac3da3399d7b49c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/threads.js\":\"064ec4c4dcf54dff\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/ui.js\":\"e483a63905ab4e39\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/uiStore.js\":\"851db410d71994f7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-intents/appIntents.js\":\"2b7502548c4dabf6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-intents/index.js\":\"889e73a156265d39\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-update-prompt/index.js\":\"af96794758343fa2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-update-prompt/status.js\":\"ac30e81fb3f21888\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7afb84e7e5796e0f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaBlockRenderer.js\":\"980ddc5ddd99b60d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b58e8acb02a4c7be\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaUploadReconciler.js\":\"3cb33d6b96e4b195\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetDownLane.js\":\"b06e8be3573b867d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetResolver.js\":\"aec76743c8307242\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetUpload.js\":\"d9be6bf2d0b1139a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/attachmentCleanerIO.js\":\"e46898862e5e7d8e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b6d80f3afc9da136\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/blobStore.js\":\"d23ecf784993886e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/browserMedia.js\":\"754fc7953aec3c2f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/byteStore.js\":\"5c976c23944a7d59\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/cleanerIO.js\":\"627a3c4a689b70f1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/cleanupAttachments.js\":\"f16d37e60d18aeb1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/dataExtension.js\":\"4f8368b2cda9151a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/downLane.js\":\"0313a960cfa5bdbe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/index.js\":\"73ec6cf0239ea3e0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/insertImageContribution.js\":\"17c2ffa1fbe3ff19\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/laneArming.js\":\"c18aae93cee03c6b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/laneLock.js\":\"3399cb7194bf76be\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaBlock.js\":\"b84d778e21a48e9b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaCapture.js\":\"223016885c9bc811\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaLanes.js\":\"23d9d2664f79eaab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaViewers.js\":\"b4ac19e30cda0ac6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaViewersFacet.js\":\"5ca34e130ae0438d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/pasteCapture.js\":\"f4c23ffe7f74e983\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/resolver.js\":\"a7a9c0bef8dfe8fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/retryUploadsAction.js\":\"e94da2a81e048bfa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/storagePaths.js\":\"ae939b972b8749d8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadDrain.js\":\"b14a22e649af27ef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadLaneStatus.js\":\"b14da1175c6aab9e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadReconcile.js\":\"9fadad84a09c0afc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadRecovery.js\":\"8f32dc25e217ed4d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadStore.js\":\"6b20cbe63a509a2d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/useAssetObjectUrl.js\":\"f0b6a6d177b1a3bd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0d050870ffd4c19b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/BacklinksViewSection.js\":\"0e291e74c64ad9b8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/facet.js\":\"a72c40eac466e6c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/index.js\":\"5ee0897bb295d874\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/prop.js\":\"990bdc47c430f8e5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BacklinkFilters.js\":\"6802b595abfc200f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"820eb7f2b485d3fe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BlockEntry.js\":\"57780041b559d828\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/LinkedReferences.js\":\"e53111c1ae6e6948\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b3da2d042a65ae4f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/dailyNoteDefaults.js\":\"6e974ff2d158473f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/dataExtension.js\":\"e555f7bd6e3d9bd2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/edgeExclusions.js\":\"5347c9f8cb2259f9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/filterProperty.js\":\"cbcd58f079f6ce13\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/index.js\":\"b81f3f918a99bbdc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e17b892ce4f8ddf8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/applies.js\":\"c1a431f938a273e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/countQuery.js\":\"43671c637e4c559d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4164a9d48f501a96\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/index.js\":\"70f8580f38734c01\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b4f2d8178c1b24aa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/presentationInvalidation.js\":\"da069d92f38c4d23\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/propertyEditorOverride.js\":\"5c343e686d86f9ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/propertyFilter.js\":\"4209ad0cba472511\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/query.js\":\"be5553d9963f38f4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/resolveFilter.js\":\"645626c2b4e28dbb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/sourceBatch.js\":\"efbd24912ff4853c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/sources.js\":\"b9ce463e5eb3643a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/useBacklinks.js\":\"22d949208eef0015\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"bef1293a4f31b227\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/BirthdayCelebration.js\":\"7edee57fa2024eae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/BirthdayOverlay.js\":\"96f8bbf6fba1ee6a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/gate.js\":\"950ba81846aac7fb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/index.js\":\"979d3f9ae1711ba6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/wolfTheme.js\":\"11be053392444258\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/BlockDragLayer.js\":\"5e64c6983bfbe8dd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/dragController.js\":\"b90e0bafa34bfc7b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/dropTarget.js\":\"8f4ea6e5d02698da\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/index.js\":\"9565e76b1e13d5fa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/projection.js\":\"c8b3810819db5221\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-info/BlockMetaCard.js\":\"810eb2ffff5a948f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-info/index.js\":\"75ad082237f19d7f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/AddTagDialog.js\":\"ac0fea7ab2110cc0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"31b0f41db5f069eb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/TagNameIssueHint.js\":\"e99dcabc8f607b73\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/addTagAction.js\":\"0e26d4b8dd3332b8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/appendTag.js\":\"acba5a82a39518fe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/config.js\":\"4bdd1df3fb3a917f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/dataExtension.js\":\"4c9a21d6f354e716\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/index.js\":\"cdb2e06735952b39\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/propertyEditorOverride.js\":\"1e95375a9e3f112d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/BreadcrumbList.js\":\"cd0ba7e23fd95ea0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"db0f475f04d3821f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/Breadcrumbs.js\":\"9fad7d48c0949598\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c64c31b8456bf2ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ce05ef6797f5fe40\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/index.js\":\"b4ae006e659905c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"58cb00cf96e0ce6d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/CharacterCountItem.js\":\"dae12ba45c78c42f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/ProfilePropertyEditor.js\":\"13557e1259c67ce3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/actions.js\":\"29df14a092e27ad5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/blockType.js\":\"225127c340d0305b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/charCount.js\":\"53c95dcbb23234dc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/dataExtension.js\":\"9c8d343b2610166a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/index.js\":\"c3db9aa4ea9a33db\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/profiles.js\":\"34fc161398ffd2cd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/properties.js\":\"23b43f058a1aa41d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/textCounts.js\":\"5dc4e44c7ab82779\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/colemak-keybindings/index.js\":\"10c4d9fe6c0ae034\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/CommandPalette.js\":\"6e70ef6d0d1273f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/HeaderItem.js\":\"51121769b6b1125a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/context.js\":\"0fca56e1e221b0da\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/index.js\":\"fb599431f0e59ea8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/selection.js\":\"c67979a20d712bcf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/toggleStore.js\":\"c031ce246163fa27\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/useCommandPaletteActions.js\":\"3be48ee01506bf91\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/ContributorBadges.js\":\"dddc589268b2aa1a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/author.js\":\"9351ec7c71a9a960\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/codeMirrorExtensions.js\":\"ecb8670f2dfe7898\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/dataExtension.js\":\"9bc5051e8050996e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/index.js\":\"f36b2e19544a84d7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/mentionAutocomplete.js\":\"6d683cff9e04dc0f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/processor.js\":\"dcf993e4956e7c97\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/profiles.js\":\"97df17da2f209993\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/queries.js\":\"c4fe5c0757a38ed9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/schema.js\":\"c1c93707172ceb4f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4795f0b3c0939f0a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/followOrigin.js\":\"acde732a599fc7a3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/index.js\":\"de606a3270517c53\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"47f8473f02aa2dcf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"dfb48d000f652b10\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/CalendarGrid.js\":\"9627284595f82c53\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DailyNotePicker.js\":\"c1439b650e219987\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"192f9ebefab34b55\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateNavDecorator.js\":\"2f43ed09f9ad66d1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateScrubOverlay.js\":\"31eb4ed02ae32bca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DayReferencePanelEditor.js\":\"fb4babde4f5e017e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/HeaderItem.js\":\"efc294cbccd2c780\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/ReschedulePicker.js\":\"896249ec859becb9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/SpreadDatesDialog.js\":\"f1760d6dffc6b10e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/actions.js\":\"5810541eb8f23999\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/blockDateAdapter.js\":\"cb7eb999584f810d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/calendar.js\":\"ddd2e658db48b1bc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dailyNotes.js\":\"902250ebb64ba02d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dataExtension.js\":\"52540071e37048fa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubActions.js\":\"2faf6ffdc227dac9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubGesture.js\":\"8674354129a42744\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubGestureActions.js\":\"43a8e87f94793fd6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubRecognizer.js\":\"508e61b5c5e2d9cc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dayProperty.js\":\"e3b9a6c832c4efe3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/deletionGuard.js\":\"09fb7ae9a1776260\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dueQuery.js\":\"1bbc097226481798\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/index.js\":\"69e3f257cc870ed7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/landing.js\":\"53553fddb4d619d1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/localSchema.js\":\"39caf7d2561985ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/referenceDateAdapter.js\":\"6d566944fb7d5544\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/rescheduleAction.js\":\"a7e22fc019f19e66\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/schema.js\":\"1d27211893722b3a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/spreadBlockDates.js\":\"477c291f4dbf1b2a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/spreadDatesAction.js\":\"c630b811b27315a2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/today.js\":\"ed3a5315ecebe596\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"040e4dcae506f378\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ca30fa68c8296ad5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/audit.js\":\"bbfe6a41dc9a67b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/auditAction.js\":\"6dd10fd30a5fc5ae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/auditRanges.js\":\"c99b2855a37692c3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/diagnosticsSource.js\":\"59f7a894de2c14f0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/divergenceScan.js\":\"2b4afe19eb9bae88\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/index.js\":\"624792356909c860\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0dee689749b3787f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/referencesMirror.js\":\"049b9d642eeabe41\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/rowJson.js\":\"c3a6a454c741ebc3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/schedule.js\":\"396c1906c0876a70\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/store.js\":\"2ef09f8b148766d8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/action.js\":\"5517378d666a1e98\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/index.js\":\"97ae282e878268b4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/plugin.js\":\"f280aa8d1550b523\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d8235cefed249b9b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/actions.js\":\"c1692df0bcfe3f59\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/changeMarker.js\":\"9bfc79cbbe825f0c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/diagnostics.js\":\"e6a23d33e97f7eb8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/fileSystemAccess.js\":\"9ec6995add340ede\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/filenames.js\":\"5f16d820e02fdefd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/index.js\":\"792971fbeee241f4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/mirror.js\":\"84c3e6e053c90afa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/runLock.js\":\"68edc91ed1dd23ce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/runtimeHealth.js\":\"1a7cfb96d9f0c691\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/schedule.js\":\"069adf25729589d3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/store.js\":\"bd00f54cc9621cb6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/default-themes/index.js\":\"e4f02f0cb1bbec93\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/default-themes/themes.js\":\"70db17da1214b5dd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/diagnostics/facet.js\":\"a4edc0dcc67b1016\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/diagnostics/useDiagnostics.js\":\"cb1a5e4b1e41deb3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/dismissals.js\":\"fcc55a379c1fec86\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/index.js\":\"ee9c8e9be30dad39\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/status.js\":\"c33ac98eea7e675b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/store.js\":\"ac91d66a1b3f7f47\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"75165fcdf81b2a38\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/ExtensionsSettings.js\":\"34d42812e09b24cc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/actions.js\":\"eed210f0af55855b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/config.js\":\"aef372c49af6dfed\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/dataExtension.js\":\"2035597f235a851e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/effect.js\":\"a0eb174188651654\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/index.js\":\"60d4e5f9f1c73faa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/propertyEditorOverride.js\":\"bc00956d34d83264\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/useToggleTree.js\":\"762461eadbed0812\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/ExtractTypeDialog.js\":\"899fb562a42bea6c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"fc6a9a20d67eaa5e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/PropertyShapePicker.js\":\"373a678795d68080\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/action.js\":\"08631a7bb94b6868\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/index.js\":\"3dfc519d9d58edd6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/FindReplaceDialog.js\":\"df744a4e4ed8761c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/HeaderItem.js\":\"62ba7513b9b1652f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/dataExtension.js\":\"ea496b574d1cfb21\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/index.js\":\"556cbf5a0d4a05ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/search.js\":\"a8f29c336e3fa839\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/toggleStore.js\":\"a3db0b9eea53b230\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/LocationPropertyEditor.js\":\"a9bdcff9b432519c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/MapView.js\":\"f704641927b7eb50\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/blockTypes.js\":\"5b9795c2316a85ac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/codeMirrorExtensions.js\":\"d3d9677e277b00f7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/createOrFindPlace.js\":\"77a43dfe711bebf4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/currentLocation.js\":\"01943714d8f0dd70\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/dataExtension.js\":\"1b4aae7c75fb9d05\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/geoContentDecorator.js\":\"bef7f2a10f96e405\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/googlePlacesClient.js\":\"ce0acbc1de47dd25\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/index.js\":\"14e98aed2027f321\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/locationsPage.js\":\"fb6da921eb61d9fb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/mapViewport.js\":\"e53ec7df5ec2eb2c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/pickCurrentLocation.js\":\"8571d5791c48fe68\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/placeAutocomplete.js\":\"3839337ac96dea25\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/placeNameCollision.js\":\"c0d2e8f4c70fc6ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/properties.js\":\"1d945b5aad042b83\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/propertyEditorOverrides.js\":\"90024db4cb409d9c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/query.js\":\"e2ab5248d27b23b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/usePlaceSearch.js\":\"d67408a8f2fd6010\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b1aa037c69e1082e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"144aeded3159450e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"2d1ba77e07b81fe5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/config.js\":\"134dd1e5f3b7a2df\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/dataExtension.js\":\"b345421e4b4c568f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/facet.js\":\"b6dcccd823f62ce1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/grouping.js\":\"0dad238d39fbfd38\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/index.js\":\"7b8a844ae2e8f385\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"9bd62833f8a30cc6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/query.js\":\"a91ed7c61fd93675\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/resolveConfig.js\":\"9906be70fa80c759\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"b1d090d339eacd66\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e29c882f27d7aaea\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/HtmlDocumentContent.js\":\"06bba33989879b85\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/HtmlFrame.js\":\"4ebd501ed247561d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/actions.js\":\"eaf3c88a1e150e52\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/blockType.js\":\"80c7c1dca1d71f9e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/confirmRunScripts.js\":\"89c5ff0e90b6f10e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/dataExtension.js\":\"cd5aa3ebd23a5826\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameAnnotations.js\":\"b0241ebc4372f8b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameDocument.js\":\"7d9cca7b139536b8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameTheme.js\":\"608c4b50f7609fd9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/index.js\":\"00cccb3d101eb26d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/scriptConsent.js\":\"2fc0396a90963c0c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/sourceMap.js\":\"f9a47f0f07c426de\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/useDocumentScripts.js\":\"d40edf725c7cdd1e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/index.js\":\"084f8be728be47fa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/record.js\":\"72f7261da00ac3fa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/recordStore.js\":\"8160b4ec77f487fb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/responsiveness.js\":\"e8164c55c1db347b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/schedule.js\":\"5c67c1a95d7001ae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/sessionContext.js\":\"88be2b6d1d70c500\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2f16d9b42a138388\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"91c4501a60c7eee8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/actions.js\":\"72eaf887b36d4544\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/config.js\":\"38919058ae6bb85a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/dataExtension.js\":\"a8b2b72a30342c81\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/effect.js\":\"f57030a4c9507326\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/index.js\":\"a0776b502f892175\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/keyCapture.js\":\"4d3c6ff6be31739b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/overrideStore.js\":\"deb8cf65862a0029\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"682effadc05ea3aa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/HeaderItem.js\":\"5e0248b65381a828\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/LeftSidebar.js\":\"9bf642b8260e7ca4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/actions.js\":\"10944cd02cbf43eb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/facet.js\":\"b7a1c436fbe9c112\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/index.js\":\"03a64c97b51cd178\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/shortcuts.js\":\"ac35bfff1e57988e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/toggleStore.js\":\"180c6bcbe8fe7153\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/MergePicker.js\":\"224524971e99cf6b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/index.js\":\"a93cc11da8ea39ff\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/mergeAction.js\":\"03c7334d856bacdd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/strategy.js\":\"2bb40d832809433d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/Button.js\":\"4d7d613c6c5d882c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1ba3f37946656375\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/defaultItems.js\":\"889e5813989b8a9d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/facet.js\":\"adf67035584a5002\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/index.js\":\"f3bd52b50cb36469\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"369657984b2b060d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/actions.js\":\"eeb6f7e2accf0766\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"37548e115444301b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9738beaa2fd14aa8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/index.js\":\"e4ca802f15e3fedd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9387f4f3ddb2e7c0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/blockSubtreeMembership.js\":\"89803feb9d1c6101\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/contextMenuItem.js\":\"39df0ea517f30182\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/index.js\":\"77a7bbd4f76e122c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/moveAction.js\":\"51e53507d663dc13\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/moveBlocks.js\":\"99dc396f2138a0ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/selectionAfterMove.js\":\"639dbd6ab15fe7ea\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/TutorialBanner.js\":\"7c64e88c4b901bd1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/action.js\":\"bf22ccbe376c2974\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/bannerDismissal.js\":\"3eddcc08febeb28d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/documents/cheatSheet.js\":\"9e1c5baca760d662\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/index.js\":\"0bc018f5876f6fa5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/keys.js\":\"f408c1ba5a639fea\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/landing.js\":\"7410ecfab504c925\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/outline.js\":\"d81ef03d59154349\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/seed.js\":\"8bf348e37400d775\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/PerfTrendDialog.js\":\"647ba25a7c5779f6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/analyze.js\":\"e6a612320177f64e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/diagnosticsSource.js\":\"13e65fab9a2f0dea\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/index.js\":\"95555b580e8d06fe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/load.js\":\"b9cbe4391d38e83e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/monitorRun.js\":\"f19b78e452fb73a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/schedule.js\":\"6dda0cc09d9f0f31\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/series.js\":\"dc1ad12e5e5b2880\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/store.js\":\"4fe2cdf4ac4e4627\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/trendAction.js\":\"dc08b41dfbe70a30\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/verdict.js\":\"30fddc1304bf5648\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/clickToEditAction.js\":\"fa81ca98c7e5e99a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/index.js\":\"d0f3324771026e1c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/interactions.js\":\"aa656c561ef9a516\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"567e35586ecaace6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/MigrationGate.js\":\"e15eae526fc7fb04\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/MigrationGateDialog.js\":\"afbc6a0a2ab34976\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/action.js\":\"c214fb768de4d5a0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/index.js\":\"b63120ea39f46fb2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/localRunMessage.js\":\"62f588dd70979c01\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/plugin.js\":\"397a050de48f060d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/progressReport.js\":\"8bfa985c5de31fd2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/sweepProgress.js\":\"a35cb2be6cfc027d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/FieldRowRenderer.js\":\"add942d864f5864b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/ValueRowRenderer.js\":\"5c27f9844b76582e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/actions.js\":\"efa9540092fef3a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/autocomplete.js\":\"1766751aba3d6123\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/fieldRow.js\":\"92b4fa0f9804ff3a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/index.js\":\"a7a9e163db3e7c58\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/referenceWarning.js\":\"457c9bd93062984e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/valueAutocomplete.js\":\"69c8956569a23f36\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/valueSchema.js\":\"e020f42c3fea04c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/HeaderItem.js\":\"558f8f4146cb157d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/QuickFind.js\":\"e22b218936ef44e8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/index.js\":\"9976be83f590a0c9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/recents.js\":\"c193fad39a77736d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/resultItems.js\":\"d5ed87b5245d048d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/selection.js\":\"036b5dc5da93988b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/toggleStore.js\":\"0f689867a9fa6564\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/HeaderItem.js\":\"d0dc9ddffdd15b80\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4a1374a15aa217c1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/grouping.js\":\"64fd0a5f2ff0432c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/index.js\":\"e8a0f9173db4587f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/target.js\":\"8093af6938ef74e8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/codeMirrorExtensions.js\":\"619e3ea0d513eff7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/contentPrefill.js\":\"026a56522851e5d1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/dataExtension.js\":\"1d8ca2ce10d91b38\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/index.js\":\"033679737a18cc36\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"823cf89ae7dc94a2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/invalidation.js\":\"d520180da71a9db5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/localSchema.js\":\"9ba3ba15371bc7b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/blockrefs/index.js\":\"106c460d692f42b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e7cfda4f46d9429f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/index.js\":\"aa74b056ae2104d9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/referenceNode.js\":\"74402b4c7ab87574\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/remark-reference-occurrences.js\":\"7a01781d9a50276d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"142f7df512016ba5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/index.js\":\"5fd7d0238bbf4048\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2647729c7853edd5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7a279a8e2f7a1734\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/mergeRetargetProcessor.js\":\"4167dd0437dd202f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/parseFence.js\":\"b9446772ed3c7427\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referenceParser.js\":\"e4977928504e1ef6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referenceProjection.js\":\"6636fe8827c0db21\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referencesProcessor.js\":\"fc19022ee774393c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/renameProcessor.js\":\"a67d2415aaeb4c85\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/spanReplacement.js\":\"ee5de2846594d144\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/htmlToOutline.js\":\"03ba2c126b712307\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/index.js\":\"8b320c924fa6bf7c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/normalizeClipboardDom.js\":\"7ab66fc2d0915147\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/pasteDecision.js\":\"69e51a1294c9d8d3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/action.js\":\"626c16c5b66227dd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/blockIds.js\":\"c0001ff4d27b324c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/content.js\":\"0d75edf3d598fd7d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/effect.js\":\"c6a8f5912e926af3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/ids.js\":\"d3f8d97efed72eff\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/import.js\":\"7c02b8a3dd9a8e90\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/index.js\":\"a943539be8bd7d84\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/plan.js\":\"48fa02f2c3d1428f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/plugin.js\":\"52db06111c7ea31f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/promotion.js\":\"293004008ddc97bd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/properties.js\":\"56a888275eb4f79a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/references.js\":\"0864c544b40e6c64\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/report.js\":\"944b08f6915380fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/roamMemo.js\":\"e2cb55c354a17d72\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/runtime.js\":\"3b6d7d99cd97a58a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/schemaReconciliation.js\":\"081e3453b674730f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/srsMarkers.js\":\"5d57407a427ee228\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/todo.js\":\"4c82061078c2798f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/typeCandidates.js\":\"dbb58f8a34a8173e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/types.js\":\"ab253cd3e282e015\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/search-health/index.js\":\"0b1cdca7b642e255\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/search-health/store.js\":\"aa2ab2161e397934\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/HeaderItem.js\":\"e72c24101300466b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"aa64c79ad4fe6996\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/index.js\":\"0accf6f403b9f891\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/model.js\":\"08f792e212927fcb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/toggleStore.js\":\"2a3461233f72a087\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/useKeyInspector.js\":\"6861a38f4ec1a971\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d038822cf3786459\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/ShellDecorator.js\":\"afc5f2489dbb9f03\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/actions.js\":\"14947a7aaaea6555\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/exclusionsFacet.js\":\"aaacba5025a6cacc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/index.js\":\"b1b3a617d2533c87\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/shell.js\":\"33708122c3bd7386\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/surface.js\":\"c636be9271147b22\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/walker.js\":\"2185436346f6d718\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/RescheduleToast.js\":\"6756a0280562c6f3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/dataExtension.js\":\"3ce6e5fbd080d442\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/index.js\":\"d394b1b35260b448\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/indicator.js\":\"e0dd01f86e07af0b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/moveSrsState.js\":\"10ece9b313f405cd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"4016bca8a684b005\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/scheduler.js\":\"5b664e19c19d6fe3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/schema.js\":\"8e0196ae11c181a9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"717c83a85238aed8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/srsClipboard.js\":\"e4d901d9a5a3a61a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"215782d921d4deb8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9624b51137161fcb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/DeckPicker.js\":\"843edf2212ef914e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewControls.js\":\"411c56f355c2f570\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewDeckRenderer.js\":\"895631f2d3c8060c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewSession.js\":\"8f7725423e75ca3a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/actions.js\":\"cb7832e8e9d933d7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/archive.js\":\"891d94f0d2c56739\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/dataExtension.js\":\"29b46e3512bb70fc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/deck.js\":\"17a16bfcd37ca9a2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/dueQuery.js\":\"f51d14d30391296a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/gradeDecision.js\":\"7eb4d5024ee57c4b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/index.js\":\"26ad9778fa0b7235\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/keyHints.js\":\"f78f5d328fd67578\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/reviewCardLayout.js\":\"96b3835b6f07bcda\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/reviewProgress.js\":\"71997a65a3b0203c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/schema.js\":\"6928b25963773d27\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/useDueCards.js\":\"7aa75452c28a0367\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/startup-metrics/index.js\":\"3fd614b947ae8ca0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/startup-metrics/record.js\":\"28900cae44eaad77\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/index.js\":\"bf337c93ef3536b4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/persistenceStatus.js\":\"0d79b23b3b5ce318\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/requestAction.js\":\"59f9be388d2ead80\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/TypeChipsDecorator.js\":\"cf042d0736a7689e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/codeMirrorExtensions.js\":\"e87738c90dbed1dd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/index.js\":\"8c072d3277990637\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/typeAutocomplete.js\":\"3bfd53ac14fa225d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"24292a3ff0df60cb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/actions.js\":\"dba0a4b3bba838c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/anchor.js\":\"c8855d3ab4b6fd96\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/events.js\":\"5558090b9d29ec8f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/gestureActions.js\":\"37a41e0ca8b22b6d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/index.js\":\"7da7f712ad84ff4e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"593ec986d74189b2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/collect.js\":\"2dddcbbabd8113e9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/index.js\":\"a316449537298cac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/record.js\":\"6af8eb301e09d999\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/RejectionDialog.js\":\"a0927246ad34b9df\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/SystemStatusHeaderItem.js\":\"73e38eacef65cbd9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/index.js\":\"bba4c0a2cd44d338\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/model.js\":\"bb31b1da0c0d0e15\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/queueCounts.js\":\"2bc9f0ca310ce46c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/rejectedHelpers.js\":\"605933a47a573a96\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/rematerializeAction.js\":\"dbc666ae033f37b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/useHysteresis.js\":\"0a3eecdcac518f17\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/ColumnHeaders.js\":\"6f8cddb0e6c5c68b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/QueryUi.js\":\"202abe96f50dbf96\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/TableLayout.js\":\"3e3f2d333c6bb204\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/actions.js\":\"cfe0a74312f8dbdb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/cellEdits.js\":\"80a8fdaa3cd5987c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/childrenViews.js\":\"b2f6b1241a3d03b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/columns.js\":\"207bae5c7e8db5dd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/controller.js\":\"12cc0c2f2653f94f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/convert.js\":\"0998b1f2d7d58173\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/dataExtension.js\":\"d831f807cbdfcbd7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/index.js\":\"2589817b6a495473\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/keys.js\":\"7b1c3b8821359716\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/model.js\":\"8d61858be76af02a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/backfill.js\":\"8bfeaf6459cc79d8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/completion.js\":\"1e7470d5bd8e1d12\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/format.js\":\"96a98073d8550bf3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/parse.js\":\"f69ff8df9d2fc03f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/queryValue.js\":\"668706b65ab18b87\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/registrations.js\":\"b00de4ddec521ca2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/source.js\":\"f856fc8c9323f857\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/registry.js\":\"9f15d979e641d1b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/rowGutter.js\":\"8bca04476caa8543\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/rowVerbs.js\":\"47179db42a7e45e2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/schema.js\":\"af7f45bb7c1d4760\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/sort.js\":\"581ff20af1f07ade\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/effect.js\":\"f1d98b2b5ec9e208\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/index.js\":\"e19392db1586d9f5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/theme.js\":\"c12f7ea7c30dd04d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/actions.js\":\"74ad36c229082ce7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/dataExtension.js\":\"a58edd06702cce0f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/index.js\":\"974bf5f17a266625\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/schema.js\":\"63c9836e44799248\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/TouchSelectionLayer.js\":\"509422fa96a78283\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/actions.js\":\"9d629b889c7f616a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/defaultItems.js\":\"60e3ab77ea5954f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/facet.js\":\"8fc14acb017318df\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/holdRecognizer.js\":\"697244ab447989b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/index.js\":\"fe797acadca79228\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/UpdateIndicator.js\":\"88bbbe1d9dfe238b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/index.js\":\"ea7df41fdeadbb49\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/loadTimes.js\":\"ba2ae92b1505e954\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoNotesRenderer.js\":\"49ae88f104e0ae1e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoPlayerRenderer.js\":\"29eab0b9ffd7e6f7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoTimeStamp.js\":\"59ef62dffbb8e3b8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/actions.js\":\"daf272c24378b211\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/index.js\":\"217287daeccf0bcb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/markdown.js\":\"d5c8f16c448d7ae2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/notes.js\":\"27116d24ea7287ef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/registry.js\":\"d7ade08c77039402\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/remark-timestamps.js\":\"82b1a8f52ff19b6d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/view.js\":\"422f2bcf87323414\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/LinkHints.js\":\"5a868242e2fde2e0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/index.js\":\"f22855b71f313b4f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/model.js\":\"5989747a5067418a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/settings.js\":\"eb41cc37daa76c89\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/actions.js\":\"10b31adbab8bd6a2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/index.js\":\"2e118d918c2b6c96\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/interactions.js\":\"be9653504effa73c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/workspace-header/index.js\":\"7a3b7b6cb549fd9f\",\"/knowledge-medium/pr-preview/pr-1884/src/registerServiceWorker.js\":\"3a4f404dff264a46\",\"/knowledge-medium/pr-preview/pr-1884/src/requestPersistentStorage.js\":\"4550e00fdc7f324f\",\"/knowledge-medium/pr-preview/pr-1884/src/services/authRequestDeadline.js\":\"abf31fa09e192e27\",\"/knowledge-medium/pr-preview/pr-1884/src/services/authStorage.js\":\"aea7532cf3f95a51\",\"/knowledge-medium/pr-preview/pr-1884/src/services/powersync.js\":\"2b97b63f71bca6f7\",\"/knowledge-medium/pr-preview/pr-1884/src/services/supabase.js\":\"b92fca4ec9901a4f\",\"/knowledge-medium/pr-preview/pr-1884/src/services/uploadErrorClassifier.js\":\"234a6685433df75a\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/ActiveContexts.js\":\"104e65a965a88c45\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/HotkeyReconciler.js\":\"79f61c978f124a4f\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/WipeLocalDataDialog.js\":\"abb8624bf23a870e\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/actionDispatch.js\":\"fa107ef99bdd6db0\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/actionRefItems.js\":\"dd8e501f2cbb73c1\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/applyKeybindingOverrides.js\":\"8ba1f6f3b381c040\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/blockActions.js\":\"f083094507a999c0\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/blockMergeGesture.js\":\"df56d3f4ea3364ce\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/canonicalizeChord.js\":\"3a4e454ef8149bb1\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/defaultContexts.js\":\"7dd543c1a0b746e1\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/defaultShortcuts.js\":\"1c13da62f98a6a2d\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/effectiveActions.js\":\"b52097c8d822f1be\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/gestureAction.js\":\"4e46453c62576eac\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/gestureBinding.js\":\"3642e8fd3478d4ed\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/holdRegistry.js\":\"57a3997d4618422c\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/keybindingConflicts.js\":\"aad8aaf43a000cd6\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/keybindingOverrides.js\":\"afa004ad8457efb2\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/pointerAction.js\":\"ba9751a26a73a47d\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/resolve.js\":\"42f4ee77fb83e16b\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/runAction.js\":\"3e9d8f7560ba7eb4\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/sequenceMatcher.js\":\"7d6503e973f5fe4c\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/types.js\":\"f70612aef61a0418\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/useActionContext.js\":\"43db540b87c7ce25\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/useActionDiscovery.js\":\"d151002d494c7dbb\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/utils.js\":\"1e9893fbe2028f29\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/bootStore.js\":\"0c7683cbf669306e\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/previewDatabases.js\":\"9a89a77ac4138023\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/byteTransform.js\":\"aec6ee658d13d78b\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/attachmentCleaner.js\":\"11ad42d7d3c430a9\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/attachmentParts.js\":\"16d2700e93e135b7\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/bundleParts.js\":\"42627bcf580983c2\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/bundleRecord.js\":\"4b3c6cc958e319a4\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/manifest.js\":\"62dd65089286ab1d\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/takeBundle.js\":\"c6298ba865a3c5d1\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/verifyBundle.js\":\"14b36bce095981e0\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/cleaningStage.js\":\"e83cc3c33c0770b6\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionKey.js\":\"1e98ad5f9c09612b\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionServer.js\":\"0d02e18f8ca0199c\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/flip.js\":\"43cded8c5799c7fb\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/flipAttempts.js\":\"ce0d22673d5c8876\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/pages.js\":\"a4faf9e2c0cd736b\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/preflight.js\":\"be66fc109db815d2\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/reseal.js\":\"20f5835dde407e8a\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/runConversion.js\":\"0259ca7d7127ee46\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/runLock.js\":\"d75a463cc7070967\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/sealing.js\":\"04382b00f1050ab1\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/sealingStage.js\":\"0e67fd8410368968\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/stage.js\":\"d7275ceea134061f\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/verifyReseal.js\":\"1a5a4fc06534af01\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/aad.js\":\"deded5d0293bb24a\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/aead.js\":\"095aacdbbb0bff9f\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/base32.js\":\"d7a8ee5562278194\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/base64url.js\":\"bb7fa31a5d4bd9cd\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/binaryEnvelope.js\":\"86adf62dd817043f\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/byteAead.js\":\"45cfeb7126784786\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/canary.js\":\"c2bc404b4c346579\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/contentHash.js\":\"db006e52fe298fc1\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/contentKey.js\":\"da719e7793e184ef\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/derivedIdNamespace.js\":\"aadd363b0b4f72ee\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/envelope.js\":\"67c65eac37bf2ca0\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/hex.js\":\"2968b2703c9debf1\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/sha256Hex.js\":\"14e0e92069100add\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/workspaceKey.js\":\"c07dffff0edf89c6\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/conversionState.js\":\"766b218630d75e6c\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/createEncryptedWorkspace.js\":\"b30e7c8eebde05e1\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/pastedKey.js\":\"158d36b0ded748f7\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b6aacc8d9cf18884\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/upgradeWorkspacePin.js\":\"bf6618c23e0279d5\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/keyStore.js\":\"692a1e3810820fa4\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/mintWorkspaceKey.js\":\"1b8c39cbc2fd7d79\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/modePin.js\":\"1e258d1237f8ae4a\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/openWorkspaceKeys.js\":\"5316e26b082ae2c0\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/resolveWorkspaceEntry.js\":\"f7a0da1aacb0ffc9\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/resolver.js\":\"8758a84457d3a271\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/workspaceAccess.js\":\"d273ad33718a1b42\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/transform.js\":\"9dfb1af4ac1a81a0\",\"/knowledge-medium/pr-preview/pr-1884/src/themeBootDefaults.js\":\"e496cd73eb29b912\",\"/knowledge-medium/pr-preview/pr-1884/src/types.js\":\"398feacc9a9fa6ba\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/ClientLocalSettings.js\":\"831bab41b0098db1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/abortableSleep.js\":\"6e057a2974386946\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/array.js\":\"fe5e236937937e7d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/backlinkAutocomplete.js\":\"d819b9dcb898b01f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/blockCrumbs.js\":\"93209b374b7d3db1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/blockrefAutocomplete.js\":\"b1491d14a8ed5078\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/cadencedIdleJob.js\":\"9cf021f162f8b8a2\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/callbackSet.js\":\"737732fa21870546\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/clientId.js\":\"7b695a5a34ea109f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/codemirror.js\":\"fc62fd13a909fa67\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/codemirrorCompletion.js\":\"3598d7c684ec1e0e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/copy.js\":\"c6d1c461605fa39b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dailyPage.js\":\"3fb8054714bf854d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dbForensics.js\":\"34fb5f32d4574649\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dbForensicsHooks.js\":\"fd554237ebab22cd\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/deleteBlockThroughUi.js\":\"e74de5d08dad1842\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dialogs.js\":\"b55bcfc4f29054c8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dom.js\":\"5ffc1ab96c74da43\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/downloadBlob.js\":\"12d945e76cd958b1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/drawnWalk.js\":\"db580c083dbcbbc8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/exportSqliteDb.js\":\"bedf8a8a043ecc49\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fileSystemAccess.js\":\"f3a20e4a510b369c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/flipSlide.js\":\"193ac4f0644af2ef\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fnv1a.js\":\"3bd4e5b5a1de2c8a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/formatBytes.js\":\"b7e8db280b7721df\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fuzzyRank.js\":\"43ff6e6781614a82\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/idbKeyedStore.js\":\"57dd92aa9e8efc82\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/idleCallbackPolyfill.js\":\"1005b25c44de10b8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/keyboardAwareScroll.js\":\"e8aa65266c43a5ea\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/keyboardViewport.js\":\"5ea4976364b8fde3\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/lastWorkspace.js\":\"86d2cc5a5f0ce19f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutColumns.js\":\"91e41e2ce5f4efe4\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutSessionDom.js\":\"d1adfe91419bf289\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutSessionId.js\":\"dbfe8306fef70434\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/linkClickGestures.js\":\"0034ed5ff83a8e5b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/linkTargetAutocomplete.js\":\"272d1575e89ad044\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/localDbCorruption.js\":\"70ad7bbcbeaf8bf3\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/localDbRecovery.js\":\"651a02bcb1becf61\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/markdownParser.js\":\"c6a477f13f67d7d7\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/memoize.js\":\"79296365d1f8037e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/nameFieldCommit.js\":\"cbfab9a6a33243e0\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/nameList.js\":\"05f9e438d1f6b758\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/navigation.js\":\"75cada81a718a094\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/omnilinerNamespace.js\":\"2e254000506cb556\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/opfsPageScan.js\":\"b3f530d4e62b8f71\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelClearance.js\":\"76d695cb86e33bab\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelHistory.js\":\"beaa815ba39c2bdc\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelLanes.js\":\"1811631946c1946a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelLayoutProjection.js\":\"265362891e3aec1e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelScrollAnchor.js\":\"ee5e1d524345ddf7\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelUrlFlags.js\":\"41b06dbe1ddc5040\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/platform.js\":\"972e8250144612ce\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/pluralize.js\":\"8d4f83b37196e65d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyCreation.js\":\"cc28cbbed3d1797f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyNavigation.js\":\"06f35215e5df577b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyValueContext.js\":\"6bf28a3d08eb04df\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/react.js\":\"d92d4ab8cb323e0a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/relativeDate.js\":\"75bbbde07948d258\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/relativeTime.js\":\"6a401b725955b53c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/renderScope.js\":\"a510e38ba14efd8b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/resolvedThenable.js\":\"9e1c558c0d9f3926\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/routing.js\":\"1608320e58758473\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/safeMode.js\":\"6f88b13537b7bf56\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/scheduleIdle.js\":\"431438f59ca9e9e8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/screenWakeLock.js\":\"fbd1a91331e036dc\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/selection.js\":\"9ca7b047faa1709e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/softKeyboardGrab.js\":\"51e69d054f96f45b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/startupTimeline.js\":\"b42cf499c7aefd9a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/state.js\":\"2b1d9dd3c3220acd\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/string.js\":\"419beeaeec4658da\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/surfaceZoom.js\":\"602db74fd2ffddfc\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/time.js\":\"1b57aa2553a68027\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/toast.js\":\"577f0dfcad737fdc\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/toggleStore.js\":\"d19c153065f55437\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/untilStopped.js\":\"f98b44830ab1874d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/userActivity.js\":\"0dde5a742bc38187\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/viewTransition.js\":\"4c98716cda6b0dc1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/viewport.js\":\"a468f9c7b4ceeff1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/webLock.js\":\"0b0416b80d24c6eb\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/workspaceRecovery.js\":\"322fd6f178d832e1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/workspaceSnapshotStore.js\":\"8fe9a4d948f8a058\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-compiler-runtime.js\":\"e9cb47a36ec916ee\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-client.js\":\"2a0a987ae56536e6\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-server-edge.js\":\"a177fdb2d1b5210d\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-server.js\":\"b528b02074593b00\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-static-edge.js\":\"2cf2e8f847995bb0\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-static.js\":\"dc7ae2716a746fff\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-test-utils.js\":\"14f99e6a3f348f8e\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom.js\":\"a7a9740518d067f6\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-jsx-runtime.js\":\"5d373e2c675505a9\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react.js\":\"fddeff7f8e48c1f1\",\"/knowledge-medium/pr-preview/pr-1884/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1884/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1884/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
