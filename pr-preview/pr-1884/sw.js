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
		buildId: "fc7d7fd2dadb-07085487",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/\":\"a0f22e674a9129ec\",\"/knowledge-medium/pr-preview/pr-1884/index.html\":\"a0f22e674a9129ec\",\"/knowledge-medium/pr-preview/pr-1884/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1884/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1884/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1884/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1884/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/pr-preview/pr-1884/assets/FacadeVFS-CZaZubyA.js\":\"452ee8ccaf3632a7\",\"/knowledge-medium/pr-preview/pr-1884/assets/OPFSCoopSyncVFS-DRXZrIUY.js\":\"b8ea73ac2df32151\",\"/knowledge-medium/pr-preview/pr-1884/assets/OPFSWriteAheadVFS-B-yZHJr3.js\":\"b0a02404a97ed504\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-BS2QWGnH.js\":\"0517618f12db4340\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-async-BPFsksgB.js\":\"17f6a60a8fd23bf0\",\"/knowledge-medium/pr-preview/pr-1884/assets/worker-9LcMb2Hh.js\":\"aef896ed4be63d75\",\"/knowledge-medium/pr-preview/pr-1884/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1884/chunks/app-EV9-BZEz.js\":\"7a41e7ad50a65f8b\",\"/knowledge-medium/pr-preview/pr-1884/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1884/index.js\":\"517eb15d0ae9c05f\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1884/assets/AccessHandlePoolVFS-EiQkhSYC.js\":\"fd1ee9ae005ac7f1\",\"/knowledge-medium/pr-preview/pr-1884/assets/IDBBatchAtomicVFS-ByKXhiwu.js\":\"d87443cd047eff78\",\"/knowledge-medium/pr-preview/pr-1884/assets/MemoryVFS-C994MB5Q.js\":\"b6c1d748ad1ed335\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-DpNyrni7.js\":\"14aa37c3d28ad0fa\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-async-l6kr3bLo.js\":\"31eed6ab5c5837a9\",\"/knowledge-medium/pr-preview/pr-1884/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1884/chunks/AccessHandlePoolVFS-BcLYnv1L.js\":\"c506ef537150bc49\",\"/knowledge-medium/pr-preview/pr-1884/chunks/FacadeVFS-DWgPZNqb.js\":\"a3efecdff2beb73e\",\"/knowledge-medium/pr-preview/pr-1884/chunks/IDBBatchAtomicVFS-CGDto-S3.js\":\"5370776d44c09aa2\",\"/knowledge-medium/pr-preview/pr-1884/chunks/MemoryVFS-BWcTfhsg.js\":\"3bbc4c0b7f0be79d\",\"/knowledge-medium/pr-preview/pr-1884/chunks/OPFSCoopSyncVFS-CRyt9yPC.js\":\"ac6d5d544b761859\",\"/knowledge-medium/pr-preview/pr-1884/chunks/OPFSWriteAheadVFS-CnVLQfvD.js\":\"cab7569588d593a2\",\"/knowledge-medium/pr-preview/pr-1884/chunks/Preview-CdEdPscJ.js\":\"25aa1195df789f83\",\"/knowledge-medium/pr-preview/pr-1884/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1884/chunks/card-B-91701f.js\":\"3e84ad915f43e168\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-HhVmG_0t.js\":\"62f3fa4093c792ba\",\"/knowledge-medium/pr-preview/pr-1884/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1884/chunks/mc-wa-sqlite-DFyKaaxw.js\":\"b99c56c32a3d3a91\",\"/knowledge-medium/pr-preview/pr-1884/chunks/mc-wa-sqlite-async-DDdztWG6.js\":\"4f4dac2e549d9d9d\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-BXh7SYML.js\":\"627052947ac38824\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-B_lcsom2.js\":\"04acdc922f7dd896\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-Bh7ZU6wJ.js\":\"291fafd261e553ec\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-BiP7pdjC.js\":\"ce0dd70f0ee5ff73\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-Bous0dR4.js\":\"367ecb41e6a4d0b5\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-CPhpb7Ry.js\":\"2f9b4189305f3873\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-CkwB2Wyr.js\":\"2068bc59a3134623\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server-legacy.browser.production-BOAmuKAz.js\":\"ad9c943657b72c16\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server.browser.production-DrqpGgxq.js\":\"fbee2017140b1fdf\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server.edge.production-D4hfS7Mc.js\":\"774c8fa6a79fda03\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-qq7Et54K.js\":\"5ecb3b505fbd05d9\",\"/knowledge-medium/pr-preview/pr-1884/chunks/server.browser-eC91smrn.js\":\"5d4a1281ab941169\",\"/knowledge-medium/pr-preview/pr-1884/chunks/textarea-B5Oyn5rP.js\":\"7c48ac66ee5115fe\",\"/knowledge-medium/pr-preview/pr-1884/chunks/ui-ChHmfnWy.js\":\"0e9160b43b42dd34\",\"/knowledge-medium/pr-preview/pr-1884/chunks/wa-sqlite-CcK4Ra1E.js\":\"249711f0f25cd8ab\",\"/knowledge-medium/pr-preview/pr-1884/chunks/wa-sqlite-async-C4pAzbgW.js\":\"4ac3bd399a8977e3\",\"/knowledge-medium/pr-preview/pr-1884/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1884/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1884/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1884/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1884/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1884/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1884/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1884/src/App.js\":\"73e03be5bb0ae6c1\",\"/knowledge-medium/pr-preview/pr-1884/src/appUpdate.js\":\"c3c33f3561e54220\",\"/knowledge-medium/pr-preview/pr-1884/src/appVersion.js\":\"a4b34de6b8f0c6cb\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/initialLayout.js\":\"c8efe50e81392e13\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/openWorkspaceData.js\":\"a05db9098373c148\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/resolveWorkspace.js\":\"d72730732bd0e480\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/workspaceBootstrap.js\":\"5c0b83405e20bbc5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockComponent.js\":\"cc8cf05cd36598f4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockCrumbs.js\":\"435b5fcc75c6e7aa\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockEditor.js\":\"a5637ca065f0fd4a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockLoadingPlaceholder.js\":\"9c332a9baa7cefe5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockProperties.js\":\"f1ee06e989fc4071\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockSearchPicker.js\":\"e37113e6fda5c9a1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ConfirmBulkDeleteDialog.js\":\"711eb152e20baedf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/DividerHandle.js\":\"13e927ff8e78817a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/DraftEditor.js\":\"0bd556d7d346a0b8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/GutterPill.js\":\"724f949d4bddbc3b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/Header.js\":\"3659aee04f674b68\",\"/knowledge-medium/pr-preview/pr-1884/src/components/LazyBlockComponent.js\":\"cfe93ab46534cc1a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/Login.js\":\"c86db43b2085414b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ZoomableSurface.js\":\"8bd88829f1b4e3d3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/editModeKeepalive.js\":\"c309eee32a132f74\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyDisplay/PropertyDisplayScope.js\":\"f6ac6b8b9c8b7353\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ac5ae617c705f001\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/RefPropertyEditor.js\":\"3f1cfce8c3b1cf2b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/RefTargetTypePicker.js\":\"c9b08f8c8373ed06\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/SelectPropertyEditor.js\":\"80e679dbfc0ec15c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/TypesPropertyEditor.js\":\"b21fd4ea513aa0d5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/defaults.js\":\"9327e588f0761c94\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/kernelValuePresets.js\":\"997c52bea7b5f22f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/selectablePresets.js\":\"bbe13e94ccfaa5e9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/typesPropertyUi.js\":\"0a47e3ffa6d6765e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/AddPropertyForm.js\":\"a263e150fdbde3d6\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/PropertyPicker.js\":\"bcf65ac12ff134c8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/PropertyRow.js\":\"6ab63bee7e8780e6\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/Rows.js\":\"ef5cebcb3fcae21b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/actions.js\":\"a7736013390e9d8b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/declarationOnly.js\":\"2ada15d978316a5e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/layout.js\":\"d3fd74435d8894c9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/model.js\":\"d9ab1b88d72ad944\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/shapeUi.js\":\"7b02e48e28044f0e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/shapes.js\":\"e3e9d44a327e9fbc\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/usePropertyEditingActivation.js\":\"bfd6a0941eb205b5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/visibility.js\":\"77b74f7137853605\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanelSections.js\":\"b5ff2a3e4e570436\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockEmbed.js\":\"40bc1bc42dc8a3d5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockLink.js\":\"bfae01c32a328395\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockRef.js\":\"37f68deb7bcdfe81\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/ReferenceLink.js\":\"d20eb71e8b34b096\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/cycleGuard.js\":\"e527ee43081c598e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/cycleGuardContext.js\":\"4508cab314eeef49\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/linkInteraction.js\":\"3c9e29076ecf7f6f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/referenceLayout.js\":\"d3633f4e91df859f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/useBlockRefAncestors.js\":\"167de6a1c677fbb3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockGutter.js\":\"5a75755b1aed0933\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockInfoDialog.js\":\"8407c39a28be86ed\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockTypeBlockRenderer.js\":\"486a0c278eec6101\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BulletHoverCard.js\":\"9be3e08860a44917\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/CodeMirrorContentRenderer.js\":\"2b68fbb15d7e4f94\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5ea73163532513cf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/ColumnResizeHandles.js\":\"b6f3e27157c56885\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"cc966106f8d841a2\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/DefaultBlockRenderer.js\":\"7851d7548a88904d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/LayoutRenderer.js\":\"500322b0830d9ac2\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/MarkdownContentRenderer.js\":\"0159264eac307657\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/MissingDataRenderer.js\":\"f1d9a7b596992902\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/PanelRenderer.js\":\"fd35fea2abf13e19\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/PropertySchemaBlockRenderer.js\":\"57410cc95da4be74\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/TopLevelRenderer.js\":\"7341496cc49dd77f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/blockGutterMode.js\":\"658151da3ca651ba\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/blockTitleText.js\":\"fb1402d0e60d0853\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/fieldCreationKeydown.js\":\"eb12a0266746e8f0\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/layoutRootContext.js\":\"d652a77308a2d9a7\",\"/knowledge-medium/pr-preview/pr-1884/src/components/typeChip/TypeChip.js\":\"459133ded95a5000\",\"/knowledge-medium/pr-preview/pr-1884/src/components/typeChip/chipStyle.js\":\"2c2d83ba876163de\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/anchored-floating.js\":\"6905592aa3389749\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/button.js\":\"18a13a9d79b655af\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/card.js\":\"952bb5e8aabda435\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/checkbox.js\":\"4a9bdf8c3001994b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/collapsible.js\":\"97da3dd516d0e461\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/command.js\":\"625fe0501149e1b0\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/context-menu.js\":\"172812fbfbc80a57\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/dialog.js\":\"05e9cfc5cca396df\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/dropdown-menu.js\":\"9f8788fcd0cf00d9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/floating-listbox.js\":\"0d555ded1beb0ced\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/index.js\":\"bda165ca47e53cb4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/input.js\":\"1fab1d329f7c2108\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/kbd.js\":\"05a45d720b7ff95b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/label.js\":\"efa18b0699e389bf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/textarea.js\":\"e4d83e0821290be3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/useEditModeYieldKeepalive.js\":\"eca946e8f094e787\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/BootFallback.js\":\"917b0570fac36888\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/FocusedRowLazyMount.js\":\"f45a59dc60257d27\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/LazyViewportMount.js\":\"2779673a4cb12bcb\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/LocalDbCorruptionFallback.js\":\"dc1292e88e04d7af\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/error.js\":\"422bb48896e86d2a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/lazyMountRegistry.js\":\"a44641107561ecf3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/suspense.js\":\"084b14ee41497c88\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/CreateWorkspaceDialog.js\":\"aa70d72a6798db6c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/PendingInvitations.js\":\"86e468309ad1e800\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/SyncProgress.js\":\"47948ddd3e7b4743\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/UnlockProgress.js\":\"cd367d079389c94f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceKeyGate.js\":\"7a5f30165b0aaca3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSettingsDialog.js\":\"5e5446df58fe9f43\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSwitcher.js\":\"5bf09e499e272910\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSyncGate.js\":\"689562019a4ec622\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/ConversionFlow.js\":\"cb39bd194efb960b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/ConversionFlowHost.js\":\"50dabd0e68fd7737\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/EncryptionSection.js\":\"b4ae2e920d98ec79\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/attachmentPrompts.js\":\"42fc2a61c453dc3a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/bundleFolderPrompts.js\":\"190081fa2498f1fb\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/conversionFlowDeps.js\":\"2841acfecb20897a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/conversionFlowStore.js\":\"7dce83ad3b0db9b8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/flowUi.js\":\"cfb4fba521091610\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/useConversionRun.js\":\"ce11a21d80044e88\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/keyUi.js\":\"c61d935dac001d19\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/useCloseOnKeyLoss.js\":\"4caefa7d68b3789e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/useCloseOnServerE2ee.js\":\"1d6f45696af7736f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/workspaceUnlocked.js\":\"b09276b1c6bb2343\",\"/knowledge-medium/pr-preview/pr-1884/src/context/backgroundSubtree.js\":\"7c9da54eeacaf286\",\"/knowledge-medium/pr-preview/pr-1884/src/context/block.js\":\"04423b6b7d77821b\",\"/knowledge-medium/pr-preview/pr-1884/src/context/layoutWsContext.js\":\"b666ba13cd538ffd\",\"/knowledge-medium/pr-preview/pr-1884/src/context/propertyDisplay.js\":\"b482be4c1dce3602\",\"/knowledge-medium/pr-preview/pr-1884/src/context/repo.js\":\"d24bfb01394ee794\",\"/knowledge-medium/pr-preview/pr-1884/src/data/aliasClaim.js\":\"8c07d57396611029\",\"/knowledge-medium/pr-preview/pr-1884/src/data/aliasSeatNamespace.js\":\"61f3250ff8caeffa\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/blockData.js\":\"ad742b9091064117\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/blockType.js\":\"d325142861b234c0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/changeScope.js\":\"b433f5f4f5e39093\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/codecs.js\":\"7e394b1b7d3ade6e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/derivedData.js\":\"f4bd0969b6f55e0b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/errors.js\":\"f05ff9012f7a4952\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/events.js\":\"0e9eef65127b896c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/handle.js\":\"4d250c2c5cd61b48\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/index.js\":\"a1c011e2281eb378\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/mutator.js\":\"4ca56dcc2ba24615\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/processor.js\":\"a9ff9f08e85fdb3a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/propertySchema.js\":\"413d518ee2eebe0d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/query.js\":\"dfdecfd971964744\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/sameTxProcessor.js\":\"cce84137887d2924\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/schema.js\":\"4d250c2c5cd61b48\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/tx.js\":\"4d250c2c5cd61b48\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/typedBlockQuery.js\":\"1b072c50d5b9386c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/user.js\":\"a729ba95469d2d85\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/valuePresetCore.js\":\"ccd3e10fa874da1f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/valuePresets.js\":\"ebf115445eb71f14\",\"/knowledge-medium/pr-preview/pr-1884/src/data/attachmentCleanerIOVerb.js\":\"bcffd96284aa9be8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/block.js\":\"8be382489ee76eac\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockCache.js\":\"416e8700cba61bae\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockId.js\":\"d35e49e795aa4de0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockLiveness.js\":\"6bc37d1ae3635484\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockMerge.js\":\"1d86e11733015194\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockSchema.js\":\"e968834f1298884f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockTypeLookup.js\":\"210ed4d1137710dc\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockTypes.js\":\"478807c0292f0802\",\"/knowledge-medium/pr-preview/pr-1884/src/data/childrenView.js\":\"2a543c40d1e1995d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/clientContext.js\":\"b24bc4d346b317f6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/dbFileSiblings.js\":\"6e9ba8f6b5b55232\",\"/knowledge-medium/pr-preview/pr-1884/src/data/definitionSeeds.js\":\"ef8e5508d91ca5f8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/derivedIds.js\":\"c3321b565ea43522\",\"/knowledge-medium/pr-preview/pr-1884/src/data/drawnSubtree.js\":\"f52c176d863d3ee6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/facetBridge.js\":\"47f81920fc4bd9d5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/facets.js\":\"8e9d004909b75f09\",\"/knowledge-medium/pr-preview/pr-1884/src/data/globalState.js\":\"3f68e39d597ffaa9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/aliasClaimRederiveProcessor.js\":\"37a72b90432e8f99\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/ancestorBatch.js\":\"a9168c8d55ec601e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/blockTypeTypeifyProcessor.js\":\"ccaf325a07e2b19d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/clientSchema.js\":\"bf32135398ba74d7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/commitPipeline.js\":\"080b413c8fd19dcc\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/devAssertions.js\":\"41052677216d387d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/firstSync.js\":\"608357da7a3a03f5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/freshInitialLoad.js\":\"4b8d25849d440c6d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/graphBackfillClaim.js\":\"f0dd255f66125cdb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/handleStore.js\":\"47c7a1f28097df7a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/idleMarkerJobs.js\":\"cfa5d4e02ec19905\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/initialDownload.js\":\"5757d6c2381a6148\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/initializeClientDatabase.js\":\"c08c04b94178ec53\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/jsonCanonical.js\":\"57be9cb8b798682c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelInvalidation.js\":\"cd9c7c643bf3332e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelProcessors.js\":\"c4311238a11f9416\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelQueries.js\":\"e5335cd25dca6903\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/mergeTypeMembershipProcessor.js\":\"f2b4020dc8052c17\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/normalizeReferencesProcessor.js\":\"97762ebc92571b86\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/poolInstrumentation.js\":\"483477a872045d40\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/processorRunner.js\":\"2e8947f573c37224\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyCellBackfill.js\":\"1d489184fd96aeb6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyChildMint.js\":\"721a272b6bba008f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyChildrenProcessor.js\":\"d0fd9a739b6c23c4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyDefinitionChangeProcessor.js\":\"77717da47453b864\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyDefinitionSynthesis.js\":\"455f59ae58a40484\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyKeyScan.js\":\"9f2358d716f9abc8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertySchemaResolution.js\":\"d5f9aa73f3e2b29c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyValueEdits.js\":\"90aaecb7d722d540\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/raiseProtocol.js\":\"4e0200479d0f6c8d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/readBatch.js\":\"a05d8bec9eeb8940\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/refProjection.js\":\"10c66572a3956cc3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/referenceTargetLookups.js\":\"2d4d22a66f3b06a5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/referenceTargetProcessor.js\":\"657208074ffb24b4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/replayMerge.js\":\"5dea3660d90b1884\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/sqlBinds.js\":\"b3a147082bfaa4dc\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"af617cd94bdb018b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/arrivalProcessors.js\":\"ea738b0421ee9527\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/invalidate.js\":\"f73da8f7d5fe2e89\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/materialize.js\":\"c0ae0c1eff40e83b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/observer.js\":\"5b28a74b3ede8bec\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/reconcile.js\":\"b71f15ce7bc617ed\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/timingMetrics.js\":\"7ee3ff7c039ffa5a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/treeQueries.js\":\"62be80463def02b8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/txEngine.js\":\"4f1989b81fafa8a9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/txSnapshots.js\":\"80acd567e4791031\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/typedBlockQuery.js\":\"c3f34c5efd62d6ca\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/undoManager.js\":\"87e542fc07af7a33\",\"/knowledge-medium/pr-preview/pr-1884/src/data/invalidation.js\":\"82a35e7cb09f3a2d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelDataExtension.js\":\"bc95e45bb7b3a9ca\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelPage.js\":\"e07a13c19b416ea2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelValuePresetCores.js\":\"31f8594dd7786972\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbCorruptionSignal.js\":\"1faa4d8bcb62c46e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbStorage.js\":\"8209d0bd105df87f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbVfs.js\":\"f44ccf6b6935ce06\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localSchema.js\":\"add094502891f122\",\"/knowledge-medium/pr-preview/pr-1884/src/data/maintenance.js\":\"8db33cf745db6e89\",\"/knowledge-medium/pr-preview/pr-1884/src/data/mergeProperties.js\":\"d02825cb921d6f96\",\"/knowledge-medium/pr-preview/pr-1884/src/data/metricsConsoleHook.js\":\"d5c436a14da5f8b5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/migrationsPage.js\":\"3cc81df93e766604\",\"/knowledge-medium/pr-preview/pr-1884/src/data/mutators.js\":\"5113b98fcece9a59\",\"/knowledge-medium/pr-preview/pr-1884/src/data/orderKey.js\":\"a7d9eb83dfafb655\",\"/knowledge-medium/pr-preview/pr-1884/src/data/orderKeyPlacement.js\":\"fe92a99f6a5e3415\",\"/knowledge-medium/pr-preview/pr-1884/src/data/outlineSurface.js\":\"01646097c5e7782c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pendingEditorContent.js\":\"86789aae344c6b10\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pendingUploadsSql.js\":\"d1a859f4e957607f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pluginStateExtensions.js\":\"070467608859a607\",\"/knowledge-medium/pr-preview/pr-1884/src/data/powerSyncLogger.js\":\"c2f3d25fd6c55b11\",\"/knowledge-medium/pr-preview/pr-1884/src/data/projectorRuntime.js\":\"52b5a8c3ae03a8f7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/properties.js\":\"355ff929b8a4a4bc\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertiesPage.js\":\"11b9777416d6ace1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyChildren.js\":\"b32f29a4a9bd7f21\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionFanout.js\":\"73e47fba24d6d9d4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionMetadata.js\":\"35a03d5c7fa17d9e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionRegistry.js\":\"5e2a3efeb3ed19db\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDisplayMode.js\":\"e5cf27a5ac6efd96\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyRowCreation.js\":\"74696a29c2e93f96\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertySchemaCreation.js\":\"6bd787cceef74923\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertySeeds.js\":\"0e85adf88a4f7602\",\"/knowledge-medium/pr-preview/pr-1884/src/data/recentsPage.js\":\"f7ba3e841156d775\",\"/knowledge-medium/pr-preview/pr-1884/src/data/refTargetComparableProperty.js\":\"4717031714717a46\",\"/knowledge-medium/pr-preview/pr-1884/src/data/referenceBlock.js\":\"1bc9c7ab88498c75\",\"/knowledge-medium/pr-preview/pr-1884/src/data/rejectedUploads.js\":\"6c77cef67dcae6b9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/releasePowerSyncConnection.js\":\"c51c38358e540f74\",\"/knowledge-medium/pr-preview/pr-1884/src/data/repo.js\":\"ebf160b8dba09d4e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/repoProvider.js\":\"10677c0023406a65\",\"/knowledge-medium/pr-preview/pr-1884/src/data/rowProperty.js\":\"87de575a4fbf3e99\",\"/knowledge-medium/pr-preview/pr-1884/src/data/searchFilter.js\":\"2cb21e6ebcad7bc1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/seedIdentityLedger.js\":\"baaf669055c8b492\",\"/knowledge-medium/pr-preview/pr-1884/src/data/stateBlocks.js\":\"66fcbef0a4572d1e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/structuralEditPolicy.js\":\"80232a08b1658237\",\"/knowledge-medium/pr-preview/pr-1884/src/data/structuralInsert.js\":\"516ea82fdc60d5af\",\"/knowledge-medium/pr-preview/pr-1884/src/data/subtreeDelete.js\":\"0a8fad15b841b7f3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncStreamLock.js\":\"30fac12d4bb6998f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncedTableSqlRecognizer.js\":\"baf0dabec1438223\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncedTableWriteGuard.js\":\"d4e40262d0d3d304\",\"/knowledge-medium/pr-preview/pr-1884/src/data/targets.js\":\"011c93517c80c322\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeColors.js\":\"a5d2571d706cac55\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeDefinitionMetadata.js\":\"2ecb3d9931c8fbe1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeDefinitionRegistry.js\":\"bf7c236d7c232c61\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeExtraction.js\":\"3acd6280f82196ef\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeInitialValues.js\":\"170c76a5c118a0f0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typePropertyGroups.js\":\"65efb17be27eace0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeSeeds.js\":\"c852d4382d43dc9e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeTagger.js\":\"0ae59a159947e222\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typedRecords.js\":\"401db12700a3d5e8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typesPage.js\":\"af8e58e54aa59064\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userPrefs.js\":\"eaeb21079ae3cbe0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userSchemasService.js\":\"8ccbd1c37fb125ef\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userTypesService.js\":\"de989308278e026c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/valuePresetRegistry.js\":\"fa05cc40bab08734\",\"/knowledge-medium/pr-preview/pr-1884/src/data/visibleChildren.js\":\"5a5455e74be8f43c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceConversion.js\":\"d223ebf336224943\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceFirstSync.js\":\"8c1ad830b1eac743\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceIdNamespace.js\":\"781cc7a76a2cd43b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceSchema.js\":\"6ae95e3761155c7e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaces.js\":\"42037c6fcb0decc8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/writeAheadLog.js\":\"dde909f28b69ebcf\",\"/knowledge-medium/pr-preview/pr-1884/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/BlockPasteShellDecorator.js\":\"82b221fb81183f83\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/atTrigger.js\":\"0db2349476d64326\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/autocomplete.js\":\"c17cc2ead58e1599\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/codeMirrorExtensions.js\":\"b95eb6ff60c3b84a\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/contentFlush.js\":\"165c6c99b0f4a9ee\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/defaultInteractions.js\":\"0e573ed7817339d0\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/editSettleSignal.js\":\"fd12d2801308d542\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/insertImage.js\":\"968e4ff283d643df\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/referenceCompletionRange.js\":\"deb70416bca0f5c4\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/referenceTargetTypes.js\":\"56f00a6267b02a6b\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/syntaxContext.js\":\"66f167adae12b00d\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/triggerMatch.js\":\"ca253ce8a318535c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/AppRuntimeProvider.js\":\"f1df0503f4eab612\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/BlockFocusShellDecorator.js\":\"9355eb64ab706b5f\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/ExtensionRenderBoundary.js\":\"9eccfc92e32b6dfd\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/PanelContentRecovery.js\":\"9fa52d8b31d70979\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/apiCatalog.js\":\"0b49f0c48cb21f12\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/approveExtensionHere.js\":\"afd60d988349d435\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/armedCutAppMount.js\":\"52ad3511ae04cf04\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/batchableKeyedStore.js\":\"7e7da0d81ccff049\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/blockInteraction.js\":\"b19f8f385a525b18\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/blockSelectionAction.js\":\"c0df92051041b216\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/compileExtensionModule.js\":\"ec11e658be4f6a2c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/compiledModuleCache.js\":\"edefdf3ea1716107\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/continuousGestures.js\":\"fd158ca605f85136\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/core.js\":\"88b8783bb9127182\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/defaultRenderers.js\":\"573dc2d48b4ef6b2\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/definitionFanoutAppMount.js\":\"b3e3cae2a58db000\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dialogAppMount.js\":\"1e7491b17e4b2b0b\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dynamicExtensionSeeds.js\":\"8b4ab4c1fa4978dd\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dynamicExtensions.js\":\"5a5ed6aa16b65962\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/exampleExtensions.js\":\"12b828ff1d9f040a\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionApprovalStatus.js\":\"2ba6376feb42ea70\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLoadErrorToast.js\":\"cf286a25ad17419e\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLoadErrors.js\":\"650625fef7cd5b8c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLookup.js\":\"729046804040a3b8\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionToggles.js\":\"1ab514a3ab1780df\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionUtilitiesCss.js\":\"9dde060302b40d64\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/kernelPageDeletionGuard.js\":\"416351538e1d941c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/liveRuntime.js\":\"d3b337ec7ecdec89\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/openExtensionsSettings.js\":\"9347259ef8ef9e10\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/overridesCache.js\":\"2ab64804e563e8ff\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/pluginIds.js\":\"112bb1feea0eb3f0\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/processorRejectionToast.js\":\"7b2b6992c58edda1\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/runtimeActions.js\":\"e14115fe1fc2e03e\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/runtimeContext.js\":\"d0c8974c4cc24539\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/staticAppExtensions.js\":\"242d3805933747b2\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/staticDataExtensions.js\":\"8f118c2a15efb9c5\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/toastAppMount.js\":\"ce3848d6edd53ad3\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/useOverrides.js\":\"7474bf3af3dbdf9e\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/useShortcutSurfaceActivations.js\":\"f41f5ffa46a51779\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/discoverToggleTree.js\":\"db34fcb67b88bba6\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/facet.js\":\"6ff2dd1639578c7b\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/resolveAppRuntime.js\":\"9509bde3dea76b08\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/runtimeEvents.js\":\"332302e14bd5b99e\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/togglable.js\":\"76c1b27b3a49a864\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/variantFacet.js\":\"9858c735c6e6aac8\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/verbFacet.js\":\"d1302615184957f0\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/block.js\":\"905f0e08eff3cd1b\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/focusedChild.js\":\"ae59aa371ff9dd44\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/propertySchemas.js\":\"8cd4075eb0397a51\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/typeRegistry.js\":\"a21805351356ee08\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useAncestorCrumbs.js\":\"50f36e12be13a996\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useAutocompleteListbox.js\":\"fe73a7de412fcd41\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useDebouncedSearch.js\":\"589162aee818beaf\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useDebouncedValue.js\":\"4b7be3bd137fb25a\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useFacetValue.js\":\"d7e9fd7a53c40dbd\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useIsFocalRender.js\":\"0daac0676342e9d7\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useIsReadOnly.js\":\"30eaf43261693b5c\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useMaterializeBacklog.js\":\"7457e0854199c4fa\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useMinuteClock.js\":\"6bd2c11e0b0217ee\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/usePanelLayoutProjection.js\":\"31aee4b74807ba31\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/usePendingInvitations.js\":\"08e218d39811c613\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useRendererRegistry.js\":\"20749ef457b0d361\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useRetainedFieldRows.js\":\"0b6e0f8869041a6c\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useWorkspaces.js\":\"3a54c8711d554b0f\",\"/knowledge-medium/pr-preview/pr-1884/src/lib/utils.js\":\"781c8156bbc9d622\",\"/knowledge-medium/pr-preview/pr-1884/src/main.js\":\"ce4a17c07b3c0812\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/MarkdownImage.js\":\"d010583f8b248d28\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/blockSeparators.js\":\"f576caec4568b8e9\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/context.js\":\"e53d992ae8b5c8cf\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/defaultMarkdownExtension.js\":\"8a279812f83cb507\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/extensions.js\":\"a7e7d35bbf987fd5\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/renderMarkdownHtml.js\":\"4f9807cf0ec8eb52\",\"/knowledge-medium/pr-preview/pr-1884/src/minimal-editor.js\":\"b77b25fa0fa9d212\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/armedCut.js\":\"4a548b705fce4544\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/captureMediaVerb.js\":\"a4307e9c53218fc6\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/clipboard.js\":\"9e64f34d140e2eb7\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/decision.js\":\"8b4ee6a047393bcf\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/operations.js\":\"ca943dafafa72f5d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/account-header/AccountHeaderItem.js\":\"098dc8ed9e018a94\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/account-header/index.js\":\"e1c454625fad7f71\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"2f640d52ce09f11e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/askAgent.js\":\"703883cdfd47dc65\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/askedStore.js\":\"81c88f98e23ed3c9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"4935be04913454d0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/chipState.js\":\"b85990bc0e11f031\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8411b3d19e0ce6c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/index.js\":\"76beb03e6bac4b5b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"bd2a48156e641f64\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/schema.js\":\"1df8de5ac373a350\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/AgentTokensDialog.js\":\"52900994ed171b4e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/BridgePairingDialog.js\":\"620f818e6fbb2c71\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/addMedia.js\":\"37a798f726a88b7c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6e0ea8f30de5c6c6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/block.js\":\"c91635fe3bc4cf34\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/context.js\":\"3804532efa425d7d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/displayIds.js\":\"54aa0b386fbea392\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/index.js\":\"f7f8ccecaa4289ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/outline.js\":\"fce06867b39f64b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/properties.js\":\"0fb7cec8e3e7b06c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/refs.js\":\"b7e62c32be9bc0bc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"cde1a8f909f9f15b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/search.js\":\"52af5773cbeca71b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/shared.js\":\"f8d75d60311c8d77\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"455fae269ac09137\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/text.js\":\"0fd7d8bfb6a29854\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentWrites.js\":\"c5a4af20f895797f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/authoringCatalog.js\":\"2840d8c99a385eb8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/blockRefTargets.js\":\"eab4d587fa6a42d0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/bridge.js\":\"f7689b6f2215e59a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/bridgeLoop.js\":\"aa82062b6f5933c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/changeHistory.js\":\"c24aef0ffdc0eb72\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/commands.js\":\"d1ea231784385d09\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/commentsCommands.js\":\"cdfa612a532e31b5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dataExtension.js\":\"b5b678213a58de04\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dataModelGuide.js\":\"0f18190eb09cf15e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dayPropertyInputs.js\":\"57a00ca8a1815bf3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/describeRuntime.js\":\"15558961b06ffb29\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/extensionLint.js\":\"0796e42cafb34860\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/grainAudit.js\":\"b73bfbf9061e47d6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/healthCommand.js\":\"bd8c778ccb00d179\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/index.js\":\"bbf3ed8f88273cfe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/presetIdentity.js\":\"eca0025dcfb3a653\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"148afd078acf94f5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/readMedia.js\":\"eb871936917f1baf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/schema.js\":\"da41fd789f0e2d7b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/serialization.js\":\"bd267513a8a0286c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/targets.js\":\"c981b225d8c08ca0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/tokens.js\":\"320cba179d284abb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/watchEvents.js\":\"ab2943c9420fcee2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/workspaceGuard.js\":\"febaec189a76f17b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/writeCommands.js\":\"33729e6e1ed4b189\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/AliasCollisionToast.js\":\"80687e7e1b75e1bc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/DuplicateNameBanner.js\":\"665d58db4c677d0a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/collisionMerge.js\":\"f028c25f1e2ddba6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/dataExtension.js\":\"8a2f4ea68fe9c692\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/index.js\":\"4efd845d8c024c69\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/mergeCollisionAction.js\":\"5dadc510beb33cac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/pageStyling.js\":\"e402913287cbaf34\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/rejectionToast.js\":\"1c1721e61f9a4c31\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/syncProcessor.js\":\"71c76e888c07eb0f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/actions.js\":\"c1eb51f494202bb6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/addComment.js\":\"b47d0f0416ff8e39\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/anchor.js\":\"3ba8a9a7a80b5345\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/anchorState.js\":\"f8f4cc7a8bc47a3f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/commentLinks.js\":\"054dbdb5e202dfd9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/confirmThreadDeletion.js\":\"b053192ef392e172\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/container.js\":\"3ee40e433224f362\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/dataExtension.js\":\"4adc14077d57fc31\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/deleteComment.js\":\"55d04da8f2028b2b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/highlights.js\":\"8b4ecddee7c2068e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/index.js\":\"617a495299ce4133\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/linkedCommentsPill.js\":\"9ed79e95d00ae236\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/margin.js\":\"064e0efdc713a61b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/marginAnchorLinks.js\":\"d8fd4d5eb60c5a66\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/marginSchema.js\":\"7f879e69686e4ab3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/newComment.js\":\"14c9d1a0126f89ff\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/ownThreadPicker.js\":\"2146f515384f74d8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/placement.js\":\"96f3bd35dc76f11d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/queries.js\":\"9bd693afbc61c762\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotePosition.js\":\"a1cd1833086c49d4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotedIn.js\":\"827a0f4443610aba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotedRange.js\":\"a318cc80e2332d4b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/rangeRefs.js\":\"0faa11825020bab9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readHighlights.js\":\"adca84f178254380\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readSelection.js\":\"6e62bae22c968cbd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readSelectionUi.js\":\"71b2abd29179635b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/reanchor.js\":\"c730070673c69521\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/schema.js\":\"c49b3a9a8ac27627\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/scope.js\":\"8182e1cbf44fec90\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/scopeThreads.js\":\"59c79d177302579e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/splitRetarget.js\":\"7c4df6e8c3e0a786\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/suggestionCard.js\":\"7652eed187c6f325\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/suggestions.js\":\"cb7d6b73bcd01302\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/summaries.js\":\"82909ea021b691e0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/summaryBatch.js\":\"a1e6736f86b4b216\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/surface.js\":\"c9fb00936b96fa92\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/threadNavigation.js\":\"ba046d38d7f9cf3c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/threads.js\":\"b414a7b69022ace8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/ui.js\":\"e2e291a43e9fc6fb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/uiStore.js\":\"afa133d001570b2d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-intents/appIntents.js\":\"5df46fa6a35ff83b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-intents/index.js\":\"d1c3ce6cfed45ead\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-update-prompt/index.js\":\"f4754dbd66fd946d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-update-prompt/status.js\":\"c12d3066e87e2df7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"70b54888c89bffd7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaBlockRenderer.js\":\"68f4ad1c93d5016f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e2e85fa59216ec11\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaUploadReconciler.js\":\"fa73ad97286f96c1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetDownLane.js\":\"8e7922b6c50e9900\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetResolver.js\":\"b03c890dbe5efd54\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetUpload.js\":\"9d13c0d7c7dd4b2f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/attachmentCleanerIO.js\":\"cabfc8d0e26c6c79\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/supabaseAuditIO.js\":\"8ca0a984ad506204\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/blobStore.js\":\"9249a55187ee0655\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/browserMedia.js\":\"f6a0a435eb707058\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/byteStore.js\":\"c6ca7e110f6f3ae0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/cleanerIO.js\":\"fac88701b4096999\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/cleanupAttachments.js\":\"f49128573aea7e61\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/dataExtension.js\":\"a954cf66339e3bc4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/downLane.js\":\"530f9938c3b3ac24\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/index.js\":\"723aee5d3442a542\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/insertImageContribution.js\":\"d8d8793e3155a56a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/laneArming.js\":\"4b34e304fa6b7b26\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/laneLock.js\":\"bb2bf4cf5613f944\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaBlock.js\":\"5cc5376a46434670\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaCapture.js\":\"199788d1fe28e79d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaLanes.js\":\"226f46986cf5f227\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaViewers.js\":\"216a30c9bf84388e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaViewersFacet.js\":\"defb17c6e4dcf7c0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/pasteCapture.js\":\"0b28bd1ce56abb8f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/resolver.js\":\"e080b0518b6b7f9c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/retryUploadsAction.js\":\"40a76e3543585d1e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/storagePaths.js\":\"e1ec51bf7c26ea43\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadDrain.js\":\"4da329f52367d7fc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadLaneStatus.js\":\"cc2830c6fc9f6cf8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadReconcile.js\":\"befd2ed3cdd88d7e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadRecovery.js\":\"9fbfe333666ac760\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadStore.js\":\"7b55ee479738755f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/useAssetObjectUrl.js\":\"d9f2a9929980ba75\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9eeb27866f7db3ef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e32876b27da48029\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/facet.js\":\"b3a7093eae24c5b9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/index.js\":\"1f3e07d632e1a967\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/prop.js\":\"aa5d883262a236a8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BacklinkFilters.js\":\"e549650599b0e722\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"2d8c54b9cbb6bbc3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BlockEntry.js\":\"cf496c9ef005f501\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/LinkedReferences.js\":\"08035fc0878fc85f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"a21e6b5c5de8ba1c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/dailyNoteDefaults.js\":\"0478374473bd09c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/dataExtension.js\":\"2b2a0b1657c5cbac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/edgeExclusions.js\":\"3c36370aad6048c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/filterProperty.js\":\"963adad0a64f3935\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/index.js\":\"71d735181c8e3f4e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b348880a7d99492a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/applies.js\":\"62a65b9e8c325181\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/countQuery.js\":\"a9ee8e8d31b31ed9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/expansionStore.js\":\"406a9026913705dd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/index.js\":\"d4501aede8a49b88\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"5c4dbfff6f51cf45\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/presentationInvalidation.js\":\"09731d5235db595c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/propertyEditorOverride.js\":\"d88a46f3b9f9ef4a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/propertyFilter.js\":\"682041436860255c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/query.js\":\"3ecc267fdbf2139c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/resolveFilter.js\":\"83339db61ca123f5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/sourceBatch.js\":\"8017a4e7428665a3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/sources.js\":\"c5d2b56c52ecc023\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/useBacklinks.js\":\"0790877b54f78cc3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"ca907ed72ae99ac1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/BirthdayCelebration.js\":\"0e5dca937c444498\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/BirthdayOverlay.js\":\"51bcc025b1c4082b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/gate.js\":\"cbc1e240a9576c4f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/index.js\":\"d672bda8d9bf0239\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/wolfTheme.js\":\"02427d569995eb92\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/BlockDragLayer.js\":\"7d74371669c9c5a9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/dragController.js\":\"eeb628a04e43c8bf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/dropTarget.js\":\"e1b5d3f335c23148\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/index.js\":\"913ebe7d53be926d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/projection.js\":\"e301cf4f1be593e2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-info/BlockMetaCard.js\":\"8f357da85e582ae9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-info/index.js\":\"0a2bb6adb9d6ec3d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/AddTagDialog.js\":\"ce9f3bb76c025f35\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"498d9f12e82f1c47\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/TagNameIssueHint.js\":\"c417eeccae517410\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/addTagAction.js\":\"3e1d8b16511eb3c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/appendTag.js\":\"1b6d8d596e6492c9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/config.js\":\"ae02e17151964444\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/dataExtension.js\":\"97367e32224af3fc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/index.js\":\"c8e90f98b864f020\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/propertyEditorOverride.js\":\"a628cd6c9a0bd222\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/BreadcrumbList.js\":\"053d624271f13a42\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"22ff271ce79f233f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/Breadcrumbs.js\":\"eb2ef93d0fce8883\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a96f33ebdc651ea2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"5471d4f8f2ce2b9a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/index.js\":\"c8e00f796d57f88a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"8866c463c911185c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/CharacterCountItem.js\":\"cfdf6c0b6d9da2f6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/ProfilePropertyEditor.js\":\"c2c9a1f5e6309fe5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/actions.js\":\"73a622a6d0bea757\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/blockType.js\":\"2a7a71a1e0e09327\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/charCount.js\":\"2e773cdc2912b705\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/dataExtension.js\":\"65d3817dc995709e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/index.js\":\"9f27d23c11b0fa89\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/profiles.js\":\"89d1fd78843cd9f5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/properties.js\":\"ae227062af65e6e6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/textCounts.js\":\"a5e1bc6db826be5f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/colemak-keybindings/index.js\":\"d5c91425132ab18a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/CommandPalette.js\":\"082bc7693e3f1d9b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/HeaderItem.js\":\"a5b6eb4eec1bb36b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/context.js\":\"43b43ad4d55f2270\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/index.js\":\"fbbfa78e3db70a25\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/selection.js\":\"754b822f90b4b79f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/toggleStore.js\":\"a9842ce776d05b72\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/useCommandPaletteActions.js\":\"9ac38aa31e0ae7b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/ContributorBadges.js\":\"2cce286be70bce6c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/author.js\":\"a3dde87d003b7058\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/codeMirrorExtensions.js\":\"cfc578c9d7bec693\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/dataExtension.js\":\"f37be8bff06a76f7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/index.js\":\"6fa1916b8d71b006\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/mentionAutocomplete.js\":\"5ca1e466c875e012\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/processor.js\":\"0f33e45ef7595980\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/profiles.js\":\"bf414ece436f989f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/queries.js\":\"6e172102d76de4ee\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/schema.js\":\"024c807349c38335\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"73cc7e8a9eea3f13\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/followOrigin.js\":\"359000c7a67de176\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/index.js\":\"e39a61a035c70aeb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"4b276d575edbd0ab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"042edeca9ecd8271\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/CalendarGrid.js\":\"56dacc1c3f9af48c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DailyNotePicker.js\":\"48b8df8a35abb1a3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b418f1dbae1f809e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateNavDecorator.js\":\"f596fa85fb3f2255\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateScrubOverlay.js\":\"fece45f35d6689b3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DayReferencePanelEditor.js\":\"d609f7c672718678\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/HeaderItem.js\":\"10357aa8a8de285c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/ReschedulePicker.js\":\"375303121a00b631\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/SpreadDatesDialog.js\":\"23fe21d845713004\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/actions.js\":\"2e13935914a34914\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/blockDateAdapter.js\":\"a13d898bec5d6306\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/calendar.js\":\"42588d3b573f304a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dailyNotes.js\":\"6c66f4142bc16b35\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dataExtension.js\":\"c0aba29844d82435\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubActions.js\":\"3ea72438c84ec1fc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubGesture.js\":\"3f0de963c8d586ed\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubGestureActions.js\":\"2f585ad2eb3a58c5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubRecognizer.js\":\"3e7a5012ae60fef0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dayProperty.js\":\"57effa1af8be2e0e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/deletionGuard.js\":\"b79f70a9f1b320cf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dueQuery.js\":\"b7827c42f6665815\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/index.js\":\"cbc412f634647eaf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/landing.js\":\"345c5cdb462e9ba7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/localSchema.js\":\"a45fb0ff50f1fee3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/referenceDateAdapter.js\":\"5335327763289aca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/rescheduleAction.js\":\"f0624460007e3515\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/schema.js\":\"e23e9d18b5d8aa76\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/spreadBlockDates.js\":\"63d562fda18fc6e7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/spreadDatesAction.js\":\"a0c6873480b6d5da\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/today.js\":\"ebb51ac5725eb2c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"663813d40d60393f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b6f660ab5b1c28a3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/audit.js\":\"9dd0ecaa522278b9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/auditAction.js\":\"fc9f7d6c46ca20f8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/auditRanges.js\":\"3bb9b01681364ca1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/diagnosticsSource.js\":\"7cf2d17987e45622\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/divergenceScan.js\":\"a2314f2a485e57f8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/index.js\":\"96908b9648d08d18\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/propertyChildrenChecks.js\":\"2f24bdfbd76ea054\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/referencesMirror.js\":\"720a062dc754cacf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/rowJson.js\":\"806177001574760d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/schedule.js\":\"7ff2bc951ee5d8cf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/store.js\":\"cccb3c2a0ccf09ef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/action.js\":\"73093830641f1c68\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/index.js\":\"0535cfede388ede1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/plugin.js\":\"28de4977a2fb5361\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"6587fcb9b7f713e4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/actions.js\":\"60c515d07a20476c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/changeMarker.js\":\"1dfaa3cfe66c3b13\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/diagnostics.js\":\"56fc6a66f4bc5f6c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/fileSystemAccess.js\":\"5c054aead10489a2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/filenames.js\":\"f03761722e36e97a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/index.js\":\"a37ea770fad97821\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/mirror.js\":\"f7a9812df65712d0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/runLock.js\":\"9bc3b3780fafb423\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/runtimeHealth.js\":\"d76860bf053869d3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/schedule.js\":\"d69c9933dd99995b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/store.js\":\"e3f7ebe5f0f1b389\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/default-themes/index.js\":\"c8f0a9b7c87256c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/default-themes/themes.js\":\"04ec5b7eace34665\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/diagnostics/facet.js\":\"cf594ebfa9972d02\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/diagnostics/useDiagnostics.js\":\"3c3fad6bb35c78a6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/dismissals.js\":\"85bba7bfaa8cd984\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/index.js\":\"35f27e366a50538d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/status.js\":\"40e384210823b137\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/store.js\":\"6afd51b0ac46c01e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"44102c9c29b5d446\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/ExtensionsSettings.js\":\"aeaf3280530a8ea3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/actions.js\":\"07c30e048ae59e60\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/config.js\":\"70c042ba717e54f5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/dataExtension.js\":\"bfccbe43e6440141\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/effect.js\":\"2cf23e0ff867463c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/index.js\":\"e4e2c48bf5e0ccaf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/propertyEditorOverride.js\":\"918f4f86005118f7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/useToggleTree.js\":\"af292ae2ef878fd8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/ExtractTypeDialog.js\":\"f4f2d65119849215\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"afc5c61504263c46\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/PropertyShapePicker.js\":\"b7fb8deefc1d2b93\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/action.js\":\"1d8e4dc4a22c2f48\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/index.js\":\"9b6662bcc3f568b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/FindReplaceDialog.js\":\"ab94e76a87135eb9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/HeaderItem.js\":\"f4db99ecfab76de2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/dataExtension.js\":\"ff7b749d666c4e46\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/index.js\":\"f8353f700d281eb3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/search.js\":\"b5a9bd5b75c4f872\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/toggleStore.js\":\"d17883b3b21686ae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/LocationPropertyEditor.js\":\"8de9f48b9f960f7d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/MapView.js\":\"eacdb620c8b4a204\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/blockTypes.js\":\"4f9dd6fa2564eda6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/codeMirrorExtensions.js\":\"02670ecd40d94986\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/createOrFindPlace.js\":\"79e57e15da33db96\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/currentLocation.js\":\"35fec20ee23f474f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/dataExtension.js\":\"9158002df6c410d8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/geoContentDecorator.js\":\"52ce632eb92276bb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/googlePlacesClient.js\":\"2520133cffd9ada3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/index.js\":\"a73443c00a6cd312\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/locationsPage.js\":\"74b03a32ad07aee2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/mapViewport.js\":\"bd4d41b0dac651db\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/pickCurrentLocation.js\":\"e11ae94dc7eba110\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/placeAutocomplete.js\":\"46dbbcb3a05348f6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/placeNameCollision.js\":\"0be1617d4cc2bda2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/properties.js\":\"80044d148129def8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/propertyEditorOverrides.js\":\"f0daa61ad58ebaa9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/query.js\":\"717ebef4478698d2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/usePlaceSearch.js\":\"14b70dba819ea9d8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"694b10a790aea049\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"80cb2faa472571b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"443fc51be7594b66\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/config.js\":\"9012ba0823f7bd90\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/dataExtension.js\":\"369f1c5834678632\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/facet.js\":\"c28858bffbc30fcf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/grouping.js\":\"fd4dd28cc928ad8b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/index.js\":\"07bad03f7587accc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"075b37b69941d498\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/query.js\":\"7cc48d25a2ff5317\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/resolveConfig.js\":\"71e2285f191dbfe2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"dae0c9619dc40980\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"2a6cf4a98a0638f8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/HtmlDocumentContent.js\":\"3869bf1499774444\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/HtmlFrame.js\":\"80aff165263a9520\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/actions.js\":\"2fe08d8e4612a03d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/blockType.js\":\"c26408051b73a505\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/confirmRunScripts.js\":\"e096e4bcc733f5d2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/dataExtension.js\":\"d7fd325bbdf83f95\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameAnnotations.js\":\"04d7e1695e8414bb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameDocument.js\":\"6120b908a241abc0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameTheme.js\":\"bacf1385250a0268\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/index.js\":\"a9765291f8671e86\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/scriptConsent.js\":\"5aa1263ac00e7696\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/sourceMap.js\":\"e7f15011b515d500\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/useDocumentScripts.js\":\"1a64dd09d661a74d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/index.js\":\"58d9e3b92d570048\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/record.js\":\"2d5ea9ce25a759c6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/recordStore.js\":\"8b0c60e0ab0e2fbe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/responsiveness.js\":\"19e0511299a6d07c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/schedule.js\":\"1b55f73a1573c392\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/sessionContext.js\":\"bb49f99dd02a4165\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"db72339bc1884d05\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"48b407cc0991bbb2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/actions.js\":\"71bbbb916501b016\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/config.js\":\"6617f3e29ae19759\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/dataExtension.js\":\"b5b3640cc652848a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/effect.js\":\"4ddd42f7d91e9d3c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/index.js\":\"1b0fcb971cefbda9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/keyCapture.js\":\"2923a54b9ec4140f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/overrideStore.js\":\"bdd9799eb3dd2737\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4e0c39987c1cf62a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/HeaderItem.js\":\"8b079bfb9b663915\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/LeftSidebar.js\":\"5ebe88c7161038e4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/actions.js\":\"8de86512ac8f1ad4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/facet.js\":\"dd27e3ae8f8de12d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/index.js\":\"d4fb06a507244c04\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/shortcuts.js\":\"435fd67c8379b6c6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/toggleStore.js\":\"621d50d9bb4c1f68\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/MergePicker.js\":\"afa00091815c9b03\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/index.js\":\"35ad41906b3ae23a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/mergeAction.js\":\"ea1808e199f5bd8c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/strategy.js\":\"9b538e46191b23af\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/Button.js\":\"214d2f35ac0d7eb5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"eced2c6b28b77e9c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/defaultItems.js\":\"aa48ba84176e87c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/facet.js\":\"b0b4277687ab036c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/index.js\":\"af95cfeae2e9f1dc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0a681e2cea0c75f7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/actions.js\":\"31eb0f32577d4088\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5f16b857cd2e905a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/facet.js\":\"5bf211d58367d66d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/index.js\":\"97dc4ccf3db3da94\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/MoveDestinationPicker.js\":\"baeee67835aca9e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/blockSubtreeMembership.js\":\"5d0019915a65c970\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/contextMenuItem.js\":\"e3cc50b75c2106d7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/index.js\":\"38e3083401d22817\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/moveAction.js\":\"405a0248c6174ba8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/moveBlocks.js\":\"28bb8f90538fe5e3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/selectionAfterMove.js\":\"151d26a6df79e0e3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/TutorialBanner.js\":\"132dadc1f57e1369\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/action.js\":\"73759b9c9c0580e7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/bannerDismissal.js\":\"365c3d11f0d6aca0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/documents/cheatSheet.js\":\"ca53140f5182b790\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/index.js\":\"4c87692a876006b1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/keys.js\":\"c270e8e51a35229d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/landing.js\":\"7e9dae20b12cbfc4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/outline.js\":\"2313fbf252c74185\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/seed.js\":\"6449ae474157f216\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/PerfTrendDialog.js\":\"4f5c09fe78153595\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/analyze.js\":\"1d8d78e62868374c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/diagnosticsSource.js\":\"1d52025389d65903\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/index.js\":\"61e7d00848d2030a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/load.js\":\"362d791951689fd6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/monitorRun.js\":\"c15c6c7f83837427\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/schedule.js\":\"e7d5c9bd422e22da\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/series.js\":\"04bd268f25d223e5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/store.js\":\"b344622e4e38c84a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/trendAction.js\":\"2d05789ccd908c98\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/verdict.js\":\"b2cb2c334390b520\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/clickToEditAction.js\":\"8eab4f1e0b9cd7f8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/index.js\":\"915aa00e9324793e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/interactions.js\":\"4817acfc10b90acb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f74b4b824da15845\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/MigrationGate.js\":\"5145c0f1ac491f0f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/MigrationGateDialog.js\":\"e538c379d6077a1a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/action.js\":\"4517b9b160f70357\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/index.js\":\"0bedfd68b9cb083d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/localRunMessage.js\":\"87c3d5f2949828c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/plugin.js\":\"f919322e7d9a335a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/progressReport.js\":\"12ec052894cfb60b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/sweepProgress.js\":\"3b85135a5ef40f60\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/FieldRowRenderer.js\":\"f38309519e5552fb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/ValueRowRenderer.js\":\"7a6807385445e7c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/actions.js\":\"fb35d04b5f6da7f1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/autocomplete.js\":\"298891b8f08fdd2a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/fieldRow.js\":\"d4d2837d9b256edd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/index.js\":\"f70ea474b82de112\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/referenceWarning.js\":\"64eea1e720ced8f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/valueAutocomplete.js\":\"e1d9ddc216b12879\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/valueSchema.js\":\"cbd11c985bc6d7d6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/HeaderItem.js\":\"5551a556ba7f4c28\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/QuickFind.js\":\"4961a96feca620ec\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/index.js\":\"1f87deb6832828d4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/recents.js\":\"79a2578c440f3102\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/resultItems.js\":\"b1ba5a71eed9947e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/selection.js\":\"ce78dc827b42b29e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/toggleStore.js\":\"b324e719e602fe42\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/HeaderItem.js\":\"3d15f2711e135fc9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f97c70bd736ed842\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/grouping.js\":\"9f9bde4da08aa24d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/index.js\":\"cf3261914388a37b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/target.js\":\"d0defe9e3a4feb01\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/codeMirrorExtensions.js\":\"5f5ac3fd6e43d6c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/contentPrefill.js\":\"c0490f97d9f86147\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/dataExtension.js\":\"866959e30360d101\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/index.js\":\"e04f623d3871d5f8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"da32f3e24b93210c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/invalidation.js\":\"10151b67855e225f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/localSchema.js\":\"82d37871d7a3496b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/blockrefs/index.js\":\"6115dfbfc45736eb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"a22eb4029c2b57aa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/index.js\":\"6a661e76ef7bfa02\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/referenceNode.js\":\"054f110d6762c90c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/remark-reference-occurrences.js\":\"501891cfd9629065\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7951f147c144667e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/index.js\":\"f799cbc314c02e61\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"88e90292d00f2cc2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"65bd76b6e5f7a7ab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/mergeRetargetProcessor.js\":\"186b33e8b762c288\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/parseFence.js\":\"477f5dbdaa19bb75\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referenceParser.js\":\"e5f1745784f2a510\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referenceProjection.js\":\"816641d09f76c71b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referencesProcessor.js\":\"526971ee173bdf6c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/renameProcessor.js\":\"d3042db9ffceb213\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/spanReplacement.js\":\"c3a610c8a52ccdf1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/htmlToOutline.js\":\"dbf69b19e21937a0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/index.js\":\"b5a64c1be7fecce8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/normalizeClipboardDom.js\":\"d76de8b20003454b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/pasteDecision.js\":\"cdb11907cfbda1d7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/action.js\":\"0c2ce981f993c592\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/blockIds.js\":\"25060a2e66fab019\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/content.js\":\"6821e049f29121ee\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/effect.js\":\"f192e74d892364a6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/ids.js\":\"ed7523079803efa6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/import.js\":\"0becbe161d897c61\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/index.js\":\"c0a064d403a011a6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/plan.js\":\"dfaaf465808e6329\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/plugin.js\":\"d772bb3c9a73fe03\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/promotion.js\":\"2af4c5514c322c18\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/properties.js\":\"cc55d98af4af8909\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/references.js\":\"ef99e2628c33c4f1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/report.js\":\"83f5ee62cb057159\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/roamMemo.js\":\"0d71d6da11841a1d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/runtime.js\":\"869c70a775d40304\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/schemaReconciliation.js\":\"d7956e5a17ef189e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/srsMarkers.js\":\"3e0cc18881e76580\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/todo.js\":\"3fcdba72153af9d1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/typeCandidates.js\":\"ebcbb4c6829649b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/types.js\":\"8528ff0b248d3dbb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/search-health/index.js\":\"2ced2535c8e1cba0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/search-health/store.js\":\"9f5d0f78503d9209\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/HeaderItem.js\":\"683a1f34bfd6b8ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"151801286ac91c0e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/index.js\":\"d1db96696633e774\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/model.js\":\"6e72b1b100f48692\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/toggleStore.js\":\"133365ea52ab8c36\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/useKeyInspector.js\":\"e96b664076b9c53f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"14ba527f5c7e3424\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/ShellDecorator.js\":\"7dbc7d9be06bef2a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/actions.js\":\"bf00dd17762014f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c7591bbe601dd7de\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/index.js\":\"b54299ffc7d2b3a1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/shell.js\":\"88389ea17e8e344e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/surface.js\":\"b8207c02cd2e82d7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/walker.js\":\"e5c5d75cf0249e9f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/RescheduleToast.js\":\"2c28dfba549f0ebe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/dataExtension.js\":\"c10ac63dcbce60cd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/index.js\":\"b9889336792b4ab1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/indicator.js\":\"277fa5df6589db6a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/moveSrsState.js\":\"cb538d983838e3ef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1154354da1b8fcf7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/scheduler.js\":\"6137bf07d022f4ac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/schema.js\":\"8f248190a1dbd3e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a413c6e92dfe5c16\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/srsClipboard.js\":\"99fdd5d7b3324340\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ba5543b1c9cf785b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/DailyNoteReviewHint.js\":\"82b8023beec279f3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/DeckPicker.js\":\"8c326641e11b81c0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewControls.js\":\"46fedebd8e862bf7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewDeckRenderer.js\":\"d88de0c0d7057664\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewSession.js\":\"a4f3854355afba03\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/actions.js\":\"746ad76fec7325f9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/archive.js\":\"a878665527548b87\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/dataExtension.js\":\"e7f0911df047b436\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/deck.js\":\"c193aa9afab0240a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/dueQuery.js\":\"6025832c99abfd35\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/gradeDecision.js\":\"328a404f968bc41b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/index.js\":\"1547b21d4c6e0bcc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/keyHints.js\":\"3c426d9efef5bde6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/reviewCardLayout.js\":\"0a1b4930b42cf210\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/reviewProgress.js\":\"1fdaa3d649db63e2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/schema.js\":\"6b6744d9fa2a22b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/useDueCards.js\":\"c5cd9b3ed3be542e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/startup-metrics/index.js\":\"aafa3a859f71df64\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/startup-metrics/record.js\":\"8625a845898e0303\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/index.js\":\"462ff935d8b9b825\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/persistenceStatus.js\":\"de3fb8b588d3ba35\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/requestAction.js\":\"c4009b1695cfc608\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/TypeChipsDecorator.js\":\"638fe93d27374dac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/codeMirrorExtensions.js\":\"40b0b5a4173bfb95\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/index.js\":\"8535f0d0151ae2eb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/typeAutocomplete.js\":\"813bf59879523141\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"56298c4c826306b4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/actions.js\":\"a57f7d8d4e73317c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/anchor.js\":\"aea9ae36586c72ef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/events.js\":\"325fba0ddb766af2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/gestureActions.js\":\"f8dba7ff489dabb3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/index.js\":\"d3fb01bf2af4ff85\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"0c17118c00d09b79\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/collect.js\":\"33883727abcf113d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/index.js\":\"642b8abe36a94e0c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/record.js\":\"40d74c78b7e20337\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/RejectionDialog.js\":\"7235649daa7223ef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a4cba92a0d636071\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/index.js\":\"dce805626f3406ed\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/model.js\":\"136f332680b5e89e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/queueCounts.js\":\"17648d897503a7df\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/rejectedHelpers.js\":\"dd36bb995d3be4d4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/rematerializeAction.js\":\"eed5bdb77a00c226\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/useHysteresis.js\":\"428f343a8155ef40\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/ColumnHeaders.js\":\"a90b22ea787f1509\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/QueryUi.js\":\"a8f0e471650de743\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/TableLayout.js\":\"eef2c3d003dc1f96\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/actions.js\":\"f980e1162a353b19\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/cellEdits.js\":\"47aa2ae47943dd58\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/childrenViews.js\":\"70d2e6f67d5cc71d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/columns.js\":\"6795c41c55f252ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/controller.js\":\"8ffbcf44e721a074\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/convert.js\":\"f67a62a635147119\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/dataExtension.js\":\"2b98c5969834ac3b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/index.js\":\"8f514a5dcfa75440\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/keys.js\":\"be3aa909d704980a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/model.js\":\"7bc9a64ee2ba235a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/backfill.js\":\"81336d36d552266b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/completion.js\":\"491244605ab65820\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/format.js\":\"844ddc2017cd695c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/parse.js\":\"39a900644bd23d6c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/queryValue.js\":\"d21d524aacd3202e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/registrations.js\":\"c2e22f40d8197069\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/source.js\":\"0fe63a019b3368ef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/registry.js\":\"14f15f056797502a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/rowGutter.js\":\"932790c766c7d756\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/rowVerbs.js\":\"b444b9f7b070ea69\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/schema.js\":\"0801382835157d52\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/sort.js\":\"9fe6b32278785767\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/effect.js\":\"26f9a3f02a76f676\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/index.js\":\"42477e2ff737cb17\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/theme.js\":\"c91cf14d3ad08cd8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/actions.js\":\"c0651eaf0aab8ac6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/dataExtension.js\":\"8a48c51c67517ba4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/index.js\":\"e751f91816811bc3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/schema.js\":\"a31c8a7b9250c033\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f8e089d1541cb064\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/actions.js\":\"a93f03ef0de85011\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/defaultItems.js\":\"d3b244e6c1dacc4f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/facet.js\":\"c686da5e22f616d9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/holdRecognizer.js\":\"570b1f6bccfe53c1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/index.js\":\"04d5c89224973631\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/UpdateIndicator.js\":\"97f848ac8b5619d7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/index.js\":\"f0d02b42d24d8236\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/loadTimes.js\":\"284a6e5048dc7232\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoNotesRenderer.js\":\"57075f1581930aad\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoPlayerRenderer.js\":\"b9a21088bd768579\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoTimeStamp.js\":\"34d480bea8117972\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/actions.js\":\"299151439e776352\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/index.js\":\"7cde78adb2653627\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/markdown.js\":\"4e59bc40b43b564f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/notes.js\":\"36ba74a71767dc45\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/registry.js\":\"de0209487d217279\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/remark-timestamps.js\":\"023216b6806c99f8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/view.js\":\"912475217a5c0efe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/LinkHints.js\":\"4ce7edd9da41d580\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/index.js\":\"20234baccff575c8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/model.js\":\"03c84734f23fc60d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/settings.js\":\"d5770c5478a7df63\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/actions.js\":\"9b16c045254433dd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/index.js\":\"86b93b8605c1b732\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/interactions.js\":\"4766c72f41beeb89\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/workspace-header/index.js\":\"f535d68df0923e5a\",\"/knowledge-medium/pr-preview/pr-1884/src/registerServiceWorker.js\":\"7dfd98db479b7638\",\"/knowledge-medium/pr-preview/pr-1884/src/requestPersistentStorage.js\":\"bd79058e4db14095\",\"/knowledge-medium/pr-preview/pr-1884/src/services/authRequestDeadline.js\":\"bb2a95b261f58f8e\",\"/knowledge-medium/pr-preview/pr-1884/src/services/authStorage.js\":\"97ee6fbad6a87556\",\"/knowledge-medium/pr-preview/pr-1884/src/services/powersync.js\":\"eb9d0f2d2fe2a75f\",\"/knowledge-medium/pr-preview/pr-1884/src/services/supabase.js\":\"e5501217362018ec\",\"/knowledge-medium/pr-preview/pr-1884/src/services/uploadErrorClassifier.js\":\"0c6017ec4ab12d02\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/ActiveContexts.js\":\"b88ac38ce9faa6a6\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/HotkeyReconciler.js\":\"4983d226ca249281\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/WipeLocalDataDialog.js\":\"be8d62cd7d2c5254\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/actionDispatch.js\":\"11496b9216f0f0fc\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/actionRefItems.js\":\"e1bf53e90193c09b\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/applyKeybindingOverrides.js\":\"907c627a981d183f\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/blockActions.js\":\"d966565063fa1c94\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/blockMergeGesture.js\":\"c546358cec22e1c0\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/canonicalizeChord.js\":\"361394c79660493f\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/defaultContexts.js\":\"e06a5b93f27141d6\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/defaultShortcuts.js\":\"431f9c3156b6f89e\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/effectiveActions.js\":\"a863da73f3f462d7\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/gestureAction.js\":\"16e83ffcc9d6df0d\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/gestureBinding.js\":\"be6e446391848d23\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/holdRegistry.js\":\"e58aa2560527b9c0\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/keybindingConflicts.js\":\"bbdfa856d1a1e74a\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/keybindingOverrides.js\":\"fa7b721797fd2178\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/pointerAction.js\":\"145c013af2b969f6\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/resolve.js\":\"e21c4156a656c988\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/runAction.js\":\"a69331b787e9804e\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/sequenceMatcher.js\":\"33a5eb8cac5a38ef\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/types.js\":\"aa963febe4f3f19b\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/useActionContext.js\":\"5766e1edfb342ed8\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/useActionDiscovery.js\":\"7f0bff02c36c9257\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/utils.js\":\"7d958de317cc2f17\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/bootStore.js\":\"e1f589a6d72c75f2\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/previewDatabases.js\":\"27db2388c556f2fd\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/byteTransform.js\":\"34aaa5463c412640\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/attachmentCleaner.js\":\"bfb2eb9ae997eddb\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/attachmentParts.js\":\"5adca082325f63d6\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/bundleParts.js\":\"00630f21bd284c20\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/bundleRecord.js\":\"d126029f6b804175\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/manifest.js\":\"61c644dd4a845fe1\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/takeBundle.js\":\"82df853fccc90cac\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/verifyBundle.js\":\"465739429cee4204\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/cleaningStage.js\":\"ebe60716b3054ea7\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionKey.js\":\"c036a256349daed1\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionServer.js\":\"a2b7997de88aae04\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/flip.js\":\"db66d5ffdea62f97\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/flipAttempts.js\":\"5768413a2095b6ae\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/pages.js\":\"723c55977a5581af\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/preflight.js\":\"d3fad41a4170a96e\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/reseal.js\":\"e61ef9c40069b34a\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/runConversion.js\":\"66304b6b8857c1c8\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/runLock.js\":\"af0434820851a4cb\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/sealing.js\":\"706630fc39b91fe7\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/sealingStage.js\":\"eb54d697ea35407e\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/stage.js\":\"789e9e5a6b50f696\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/verifyReseal.js\":\"86b463f736fc082b\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/aad.js\":\"867a8d78c32af425\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/aead.js\":\"9ae2fb58348d5c05\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/base32.js\":\"3cb87d344c08cefb\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/base64url.js\":\"107c56840be97020\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/binaryEnvelope.js\":\"cb3eb15853ddc7ae\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/byteAead.js\":\"f5991404e4922996\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/canary.js\":\"5ffcd35e4aff715a\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/contentHash.js\":\"592513305d87aa0c\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/contentKey.js\":\"268d4e79d66bdf60\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/derivedIdNamespace.js\":\"087b417f13721fc4\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/envelope.js\":\"91c76728837e8ad6\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/hex.js\":\"c03fa2cecddf6abb\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/sha256Hex.js\":\"f5508609cd5ec00d\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/workspaceKey.js\":\"1aac77932bd7d9a5\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/conversionState.js\":\"e55b7ff09fa52493\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6b46f9c30b7ff308\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/pastedKey.js\":\"21f921a773ed327d\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bb6da55a1ea4042e\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/upgradeWorkspacePin.js\":\"01ac33dfde646179\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/keyStore.js\":\"5f66bef3031852bf\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/mintWorkspaceKey.js\":\"877c949652eea189\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/modePin.js\":\"c2ac2802b5f2032d\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/openWorkspaceKeys.js\":\"a8549c88786447b5\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/resolveWorkspaceEntry.js\":\"61f9f930cc9148d7\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/resolver.js\":\"b21e45216ee921c7\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/workspaceAccess.js\":\"d4e92e935a114d4b\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/transform.js\":\"7abe223f83fb8736\",\"/knowledge-medium/pr-preview/pr-1884/src/themeBootDefaults.js\":\"2375217f45a83230\",\"/knowledge-medium/pr-preview/pr-1884/src/types.js\":\"65ee82490e8be55e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/ClientLocalSettings.js\":\"d0d51db884e3b633\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/abortableSleep.js\":\"5339ec53d8764148\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/array.js\":\"5c83bcfda1807a84\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/backlinkAutocomplete.js\":\"d85e458603b14323\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/blockCrumbs.js\":\"81bcdd870723d644\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/blockrefAutocomplete.js\":\"1776ea7174b6fc8d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/cadencedIdleJob.js\":\"9508b8ce500022ad\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/callbackSet.js\":\"1054b0426f04d991\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/clientId.js\":\"ceb863a5a72dfd53\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/codemirror.js\":\"c8847bbad6e93d3e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/codemirrorCompletion.js\":\"17317085f7086d28\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/copy.js\":\"9dd2413b26334cc3\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dailyPage.js\":\"0167a77699a4f75b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dbForensics.js\":\"f2de334e891d8532\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dbForensicsHooks.js\":\"f2c04620c6184191\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/deleteBlockThroughUi.js\":\"720869fcc4b0b905\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dialogs.js\":\"f4702ddc574230bf\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dom.js\":\"091296279717fd33\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/downloadBlob.js\":\"571983809d553f28\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/drawnWalk.js\":\"166a696b3891ba0c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/exportSqliteDb.js\":\"48aab58507a088d5\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fileSystemAccess.js\":\"89530be41d807a5a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/flipSlide.js\":\"e2d9180fa94625e0\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fnv1a.js\":\"36f63cab865bd519\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/formatBytes.js\":\"2c76e69b520210ff\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fuzzyRank.js\":\"48bf34662538627c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/idbKeyedStore.js\":\"e5358c7429995760\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/idleCallbackPolyfill.js\":\"1e02a9b298c378d7\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/keyboardAwareScroll.js\":\"5e155175c79bfd0a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/keyboardViewport.js\":\"485db0c00580b74a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/lastWorkspace.js\":\"1437053912aab255\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutColumns.js\":\"f1f9b49e79ffea07\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutSessionDom.js\":\"e7ef400ececff02e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutSessionId.js\":\"87058dae09f597a1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/linkClickGestures.js\":\"29dda14b5787a890\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/linkTargetAutocomplete.js\":\"478309e719750e58\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/localDbCorruption.js\":\"7bc804c7ced749a3\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/localDbRecovery.js\":\"346a6db2b1284312\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/markdownParser.js\":\"0076bd71dae8659e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/memoize.js\":\"adb0244b91c5ca14\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/nameFieldCommit.js\":\"0bf26103e875f89e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/nameList.js\":\"8afd53e62f732837\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/navigation.js\":\"e7a1037a5e874270\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/omnilinerNamespace.js\":\"0574e2c137614d64\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/opfsPageScan.js\":\"286ebba7ef2e740f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelClearance.js\":\"420d2b5f0fdcd52a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelHistory.js\":\"9d9d4b869b2bd811\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelLanes.js\":\"01be0b1018f9d8be\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelLayoutProjection.js\":\"9296e0fe8d40f44d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelScrollAnchor.js\":\"0766b2abb8ef2796\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelUrlFlags.js\":\"61807d80c8763858\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/platform.js\":\"6d2df93803d668f3\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/pluralize.js\":\"bedd0e038a3e3891\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyCreation.js\":\"b3e2e1249baadda1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyNavigation.js\":\"b23f4063adc127f9\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyValueContext.js\":\"1c58334cb41ca460\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/react.js\":\"3f0011cc181ecc09\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/relativeDate.js\":\"4d68db8dbf2bdf78\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/relativeTime.js\":\"bf891e11028b3c5d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/renderScope.js\":\"04accd5509d34e3f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/resolvedThenable.js\":\"d2bebd553189c367\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/routing.js\":\"36ed21955ef8cfe7\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/safeMode.js\":\"95ed3615f1772be9\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/scheduleIdle.js\":\"8c97a8c5a8e20b9c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/screenWakeLock.js\":\"251eb16c55da3cea\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/selection.js\":\"5777b8bf6761f075\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/softKeyboardGrab.js\":\"0293f328a5ae8fac\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/startupTimeline.js\":\"ba9044d9fc7a7f2e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/state.js\":\"c91be0479b1c0f24\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/string.js\":\"0c27a072160a0a70\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/surfaceZoom.js\":\"4e13c8ab84e92600\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/time.js\":\"d403cecd1b6bdffc\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/toast.js\":\"321a293b5867764b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/toggleStore.js\":\"91b474401a8dd34d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/untilStopped.js\":\"67085034bac78aa5\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/userActivity.js\":\"d097b937d70bdbf6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/viewTransition.js\":\"5e22bdf23eed836b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/viewport.js\":\"a7bffbc726cd1c2d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/webLock.js\":\"9c0d6b1993e5efe6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/workspaceRecovery.js\":\"24a01655a7c26261\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/workspaceSnapshotStore.js\":\"ae362a83647c7866\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-compiler-runtime.js\":\"24079354c96cd4e2\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-client.js\":\"834065c068059f88\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-server-edge.js\":\"be1a9cf76fc6b043\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-server.js\":\"fd7746533a1e9f56\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-static-edge.js\":\"cb4fffcb9954c715\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-static.js\":\"8eea95473f1f870f\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-test-utils.js\":\"2512872d4dc08006\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom.js\":\"97c69306891d387c\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-jsx-runtime.js\":\"3427adb6c04cb23a\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react.js\":\"28eb415a3de00f97\",\"/knowledge-medium/pr-preview/pr-1884/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1884/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1884/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
