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
		buildId: "e8db70ad00d8-42b7dac5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/\":\"c3a6fb35edc40b69\",\"/knowledge-medium/pr-preview/pr-1884/index.html\":\"c3a6fb35edc40b69\",\"/knowledge-medium/pr-preview/pr-1884/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1884/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1884/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1884/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1884/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/app.css\":\"d676f8b41deb55c8\",\"/knowledge-medium/pr-preview/pr-1884/assets/FacadeVFS-CZaZubyA.js\":\"452ee8ccaf3632a7\",\"/knowledge-medium/pr-preview/pr-1884/assets/OPFSCoopSyncVFS-DRXZrIUY.js\":\"b8ea73ac2df32151\",\"/knowledge-medium/pr-preview/pr-1884/assets/OPFSWriteAheadVFS-B-yZHJr3.js\":\"b0a02404a97ed504\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-BS2QWGnH.js\":\"0517618f12db4340\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-async-BPFsksgB.js\":\"17f6a60a8fd23bf0\",\"/knowledge-medium/pr-preview/pr-1884/assets/worker-9LcMb2Hh.js\":\"aef896ed4be63d75\",\"/knowledge-medium/pr-preview/pr-1884/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1884/chunks/app-B3Pv9BLe.js\":\"d87ecbd2548bd9f9\",\"/knowledge-medium/pr-preview/pr-1884/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1884/index.js\":\"6d656027578e631a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1884/assets/AccessHandlePoolVFS-EiQkhSYC.js\":\"fd1ee9ae005ac7f1\",\"/knowledge-medium/pr-preview/pr-1884/assets/IDBBatchAtomicVFS-ByKXhiwu.js\":\"d87443cd047eff78\",\"/knowledge-medium/pr-preview/pr-1884/assets/MemoryVFS-C994MB5Q.js\":\"b6c1d748ad1ed335\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-DpNyrni7.js\":\"14aa37c3d28ad0fa\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-async-l6kr3bLo.js\":\"31eed6ab5c5837a9\",\"/knowledge-medium/pr-preview/pr-1884/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1884/chunks/AccessHandlePoolVFS-DVph1_k0.js\":\"93dda17502374472\",\"/knowledge-medium/pr-preview/pr-1884/chunks/FacadeVFS-H7MiFBzi.js\":\"0a400c0927e2d837\",\"/knowledge-medium/pr-preview/pr-1884/chunks/IDBBatchAtomicVFS-BkO4bPoD.js\":\"7f63215335a48e41\",\"/knowledge-medium/pr-preview/pr-1884/chunks/MemoryVFS-DQLjJijA.js\":\"608241afb62c3135\",\"/knowledge-medium/pr-preview/pr-1884/chunks/OPFSCoopSyncVFS-BlB_Pi2O.js\":\"e65cf3fb4c2661c2\",\"/knowledge-medium/pr-preview/pr-1884/chunks/OPFSWriteAheadVFS-D0aUlzc4.js\":\"395544e6c53dfb34\",\"/knowledge-medium/pr-preview/pr-1884/chunks/Preview-BnYn4HEN.js\":\"2eac570d88e95ae7\",\"/knowledge-medium/pr-preview/pr-1884/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1884/chunks/card-C17xycFz.js\":\"7e1544610230cf3c\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-BcmrzAb8.js\":\"41707e7a0e30e5c5\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1884/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1884/chunks/mc-wa-sqlite-DFyKaaxw.js\":\"b99c56c32a3d3a91\",\"/knowledge-medium/pr-preview/pr-1884/chunks/mc-wa-sqlite-async-DDdztWG6.js\":\"4f4dac2e549d9d9d\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-BfUVh2aj.js\":\"ca5a6b1f5e48287a\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-BnWRt7dk.js\":\"4b8138f49ad4a30f\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-CTpfE0OQ.js\":\"b76e9520fe3a654c\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-C_TD3Cw8.js\":\"1d67b6350e0f1ea8\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-D024fUWK.js\":\"509530d5876fdb27\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-DJbKvp5v.js\":\"0787a211e8b4fb55\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-DLI82-AP.js\":\"6ae8fa8fe6f9b0cf\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-DxAb9HFo.js\":\"81d47cb20b626a61\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server-legacy.browser.production-BbVOEy5I.js\":\"56257ba6c4ecd6b6\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server.browser.production-CynB-9He.js\":\"68a33ae7eab08257\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server.edge.production-BU95fyn-.js\":\"83219ef5800b8bfb\",\"/knowledge-medium/pr-preview/pr-1884/chunks/server.browser-B-JisRzB.js\":\"2794cfcad487dbb3\",\"/knowledge-medium/pr-preview/pr-1884/chunks/textarea-DwirdStT.js\":\"e643165b4a3e05de\",\"/knowledge-medium/pr-preview/pr-1884/chunks/ui-irgScPnk.js\":\"1fcbc68a39ccc6f8\",\"/knowledge-medium/pr-preview/pr-1884/chunks/wa-sqlite-CcK4Ra1E.js\":\"249711f0f25cd8ab\",\"/knowledge-medium/pr-preview/pr-1884/chunks/wa-sqlite-async-C4pAzbgW.js\":\"4ac3bd399a8977e3\",\"/knowledge-medium/pr-preview/pr-1884/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1884/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1884/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1884/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1884/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1884/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1884/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1884/src/App.js\":\"e8e6067706a0bbf7\",\"/knowledge-medium/pr-preview/pr-1884/src/appUpdate.js\":\"505270ae0238b938\",\"/knowledge-medium/pr-preview/pr-1884/src/appVersion.js\":\"f4d1b9730bf02b0a\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/initialLayout.js\":\"aea492b5a450f9a8\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/openWorkspaceData.js\":\"bef49e6b57f570fa\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/resolveWorkspace.js\":\"0df66533821b864e\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/workspaceBootstrap.js\":\"8775111779341e9d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockComponent.js\":\"8ed21b7784d4fe5e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockCrumbs.js\":\"087e45f2cfd67fe5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockEditor.js\":\"b01e227312781b9b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockLoadingPlaceholder.js\":\"e38141b6f85052d9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockProperties.js\":\"f719013f18bc7c7b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockSearchPicker.js\":\"a8cfff45268299d1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ConfirmBulkDeleteDialog.js\":\"8ffa76f7e65a6b67\",\"/knowledge-medium/pr-preview/pr-1884/src/components/DividerHandle.js\":\"6b5d01d7c9401100\",\"/knowledge-medium/pr-preview/pr-1884/src/components/DraftEditor.js\":\"e9a39e34870210d8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/GutterPill.js\":\"362ec302c3c3cc60\",\"/knowledge-medium/pr-preview/pr-1884/src/components/Header.js\":\"02b0135cdd63f743\",\"/knowledge-medium/pr-preview/pr-1884/src/components/LazyBlockComponent.js\":\"18b21708328e2b10\",\"/knowledge-medium/pr-preview/pr-1884/src/components/Login.js\":\"bc3e9e01ec91fd14\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ZoomableSurface.js\":\"74fa0569a4672d78\",\"/knowledge-medium/pr-preview/pr-1884/src/components/editModeKeepalive.js\":\"26103b594d8a422e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyDisplay/PropertyDisplayScope.js\":\"0a1ae10593965add\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"02e815002e522375\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/RefPropertyEditor.js\":\"3aee66604cc1ed5d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/RefTargetTypePicker.js\":\"04e192547aeca492\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/SelectPropertyEditor.js\":\"1e710fce5132d1a3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/TypesPropertyEditor.js\":\"00108771c56d75c4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/defaults.js\":\"8a652a816e3012fb\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/kernelValuePresets.js\":\"7e0af36d5784955a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/selectablePresets.js\":\"305c07af4ef24b8f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/typesPropertyUi.js\":\"9328dcf4d96478f3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/AddPropertyForm.js\":\"745015f376cae770\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/PropertyPicker.js\":\"0da9c5da870d80f7\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/PropertyRow.js\":\"7036c4e4dafc9960\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/Rows.js\":\"106899e8cdceee71\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/actions.js\":\"2977df21dc632004\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/declarationOnly.js\":\"64c2b0758137ebbd\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/layout.js\":\"2e32feccb65333f4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/model.js\":\"6b3e5d270303f9c4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/shapeUi.js\":\"5ee3d1ddb95aba74\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/shapes.js\":\"bf84c83627a54a11\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/usePropertyEditingActivation.js\":\"1e5a80f61677efe7\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/visibility.js\":\"55d0adece1b091a4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanelSections.js\":\"bf335ecddbaff0e5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockEmbed.js\":\"e5dd5193833b229d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockLink.js\":\"8998e63b247f83f7\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockRef.js\":\"9768da40243c022b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/CompactReferenceLink.js\":\"142a326afd6954b7\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/ReferenceLink.js\":\"5c5217baafb6cc19\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/cycleGuard.js\":\"6d4d98ffc00981b2\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/cycleGuardContext.js\":\"13bf0fc1c7a3f16f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/linkInteraction.js\":\"659f80342c094f9c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/referenceLayout.js\":\"4e6a8830dfbaf4dc\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/useBlockRefAncestors.js\":\"a83bf91b003a781b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockGutter.js\":\"fa1d4cc15948d88a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockInfoDialog.js\":\"ce7fb60332bd6167\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockTypeBlockRenderer.js\":\"120d56339106981b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BulletHoverCard.js\":\"70c107a47fde00ce\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/CodeMirrorContentRenderer.js\":\"20a278c8dfcb7260\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"1502cb0397de0a83\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/ColumnResizeHandles.js\":\"eb793d3d96dc69bf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"10b012bd83d6aeb4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/DefaultBlockRenderer.js\":\"05373dffceb7e715\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/LayoutRenderer.js\":\"c62daa122e6004da\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/MarkdownContentRenderer.js\":\"337367c26f112793\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/MissingDataRenderer.js\":\"b6c004ebf890e76f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/PanelRenderer.js\":\"3bc8cac807539c64\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/PropertySchemaBlockRenderer.js\":\"69e5f38bedccc78e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/TopLevelRenderer.js\":\"f3d6950f706f9db9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/blockGutterMode.js\":\"21fe31e00fa70b31\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/blockTitleText.js\":\"f5e0f30b913e76ce\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/fieldCreationKeydown.js\":\"e2e7ca512cb9bdf2\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/layoutRootContext.js\":\"c6ccadb5782693c9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/typeChip/TypeChip.js\":\"6376bebe68de65a8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/typeChip/chipStyle.js\":\"ba2c3a4cccfee13a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/anchored-floating.js\":\"2883891b0dfa2dbb\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/button.js\":\"9fe790238a447705\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/card.js\":\"8acabc631dc14698\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/checkbox.js\":\"a9401e26936d596f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/collapsible.js\":\"01d9389140590c6a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/command.js\":\"2ef5c15583091091\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/context-menu.js\":\"058ffe7689572386\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/dialog.js\":\"d680532f57286874\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/dropdown-menu.js\":\"914275acad469363\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/floating-listbox.js\":\"c487f993e64b2a53\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/index.js\":\"e79a13c86bcbde8a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/input.js\":\"6d7298bd56d9e8b3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/kbd.js\":\"e23e381e958f32d4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/label.js\":\"0936893528eb5ded\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/textarea.js\":\"e53cf8548d7de439\",\"/knowledge-medium/pr-preview/pr-1884/src/components/useEditModeYieldKeepalive.js\":\"eb51cb7d1747e679\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/BootFallback.js\":\"f5ceda37832c19cf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/FocusedRowLazyMount.js\":\"cde1f2e7a5ae2f1b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/LazyViewportMount.js\":\"b0528078b1c1723a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/LocalDbCorruptionFallback.js\":\"498e1eb70c33cded\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/error.js\":\"45630e80a197c7da\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/lazyMountRegistry.js\":\"8763fd88586c1ea9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/suspense.js\":\"dacbb24ff3e83df8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/CreateWorkspaceDialog.js\":\"2eb4534b584ffd4b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/PendingInvitations.js\":\"105b96d2d368de29\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/SyncProgress.js\":\"6b00e574a745310d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/UnlockProgress.js\":\"2354ffbcc35c7407\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceKeyGate.js\":\"56202d21f36fd65f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSettingsDialog.js\":\"43c1266fb129aaca\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSwitcher.js\":\"2516260ddfc24d06\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSyncGate.js\":\"5630f2862ebfe3b4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/ConversionFlow.js\":\"aee0264a7aadfbda\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/ConversionFlowHost.js\":\"332cd5f8fc129249\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/EncryptionSection.js\":\"fa0b8a031b67b092\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/attachmentPrompts.js\":\"22150ae40d642ea3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0b236c48ec70368e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/conversionFlowDeps.js\":\"b7a931ab6ded2b52\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/conversionFlowStore.js\":\"e2c9e41b50b129f4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/flowUi.js\":\"76221b9dbf145fbc\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/useConversionRun.js\":\"d098562eb949890a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/keyUi.js\":\"dc4ad9ad2f6a7757\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/useCloseOnKeyLoss.js\":\"fc59980c41010d38\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/useCloseOnServerE2ee.js\":\"02f85c8cb8e2fb57\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/workspaceUnlocked.js\":\"1e14cbebb6b23426\",\"/knowledge-medium/pr-preview/pr-1884/src/context/backgroundSubtree.js\":\"1cf45e6cac4224f1\",\"/knowledge-medium/pr-preview/pr-1884/src/context/block.js\":\"b98f506fc1b2913f\",\"/knowledge-medium/pr-preview/pr-1884/src/context/layoutWsContext.js\":\"3a0c3d4e60caee42\",\"/knowledge-medium/pr-preview/pr-1884/src/context/propertyDisplay.js\":\"a013a14a6af5cbc7\",\"/knowledge-medium/pr-preview/pr-1884/src/context/repo.js\":\"4dd3a96fd4bb4927\",\"/knowledge-medium/pr-preview/pr-1884/src/data/aliasClaim.js\":\"2ab441143c598f9b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/aliasSeatNamespace.js\":\"5436b964847480af\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/blockData.js\":\"5951843ae4b15b65\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/blockType.js\":\"d99675cc1daa062f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/changeScope.js\":\"4a118bf1ba9208b3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/codecs.js\":\"35e238e03a54d207\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/derivedData.js\":\"2e35cb49b3e4f4b9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/errors.js\":\"c8db92e5283869bb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/events.js\":\"3f378a3880b57f42\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/handle.js\":\"ee4257868d54cde3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/index.js\":\"d95cd188724078c8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/mutator.js\":\"c292bb2646d725fc\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/processor.js\":\"77b28b2aa63dc888\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/propertySchema.js\":\"68bca67f12dd6aa9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/query.js\":\"abe184d5cab189b1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/sameTxProcessor.js\":\"445cc6547e7a7e96\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/schema.js\":\"ee4257868d54cde3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/tx.js\":\"ee4257868d54cde3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/typedBlockQuery.js\":\"401781a1fee36f36\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/user.js\":\"07a8e6add5fc3eab\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/valuePresetCore.js\":\"37a3b3a5ec085b4d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/valuePresets.js\":\"b855af9b13b750de\",\"/knowledge-medium/pr-preview/pr-1884/src/data/attachmentCleanerIOVerb.js\":\"203b20563e095a3a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/block.js\":\"84a30cb22d70622c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockCache.js\":\"9f3091f32c0db405\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockId.js\":\"dd6dc6601e7dba2a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockLiveness.js\":\"b1ae3b7ccf7e5b6b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockMerge.js\":\"a72804337398b66f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockSchema.js\":\"4da9fae2035d000f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockTypeLookup.js\":\"b7320d4f487330f2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockTypes.js\":\"d3ba44c892058ed2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/childrenView.js\":\"561e5b7259e371aa\",\"/knowledge-medium/pr-preview/pr-1884/src/data/clientContext.js\":\"e0042da49952a011\",\"/knowledge-medium/pr-preview/pr-1884/src/data/dbFileSiblings.js\":\"bd623c5a789f736c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/definitionSeeds.js\":\"82b3c20be5fe8483\",\"/knowledge-medium/pr-preview/pr-1884/src/data/derivedIds.js\":\"bfe328a432e244e0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/drawnSubtree.js\":\"4344edb5c699892f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/facetBridge.js\":\"65aa5cf5c681db9e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/facets.js\":\"af7e608ad0cc5adf\",\"/knowledge-medium/pr-preview/pr-1884/src/data/globalState.js\":\"fc6a2578e9173bbe\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/aliasClaimRederiveProcessor.js\":\"f9e780d0c20d3c55\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/ancestorBatch.js\":\"a648a259ac507997\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/blockTypeTypeifyProcessor.js\":\"272f9034618d406a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/clientSchema.js\":\"39efcfff0e854134\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/commitPipeline.js\":\"1ec3b24e1d939f04\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/devAssertions.js\":\"07c85974a141d4b0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/firstSync.js\":\"453d7c61f2d8c26d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/freshInitialLoad.js\":\"b8a65e6d477b848e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/graphBackfillClaim.js\":\"faa4086eaf7c24f7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/handleStore.js\":\"b7051147ccf4cc00\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/idleMarkerJobs.js\":\"c0d2d65b9c23968c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/initialDownload.js\":\"5dfbdf070e06cea9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/initializeClientDatabase.js\":\"c5a0ae5ec61af1c6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/jsonCanonical.js\":\"f62f1798a28befc6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelInvalidation.js\":\"14c0d8d7de1b2c08\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelProcessors.js\":\"e78fc6a3a561e533\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelQueries.js\":\"48e657d239c71f4f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/mergeTypeMembershipProcessor.js\":\"9e56670e976d6c09\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/normalizeReferencesProcessor.js\":\"a363ee63e093be81\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/poolInstrumentation.js\":\"9c2280330dee9647\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/processorRunner.js\":\"5d0f162c38c6a9ba\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyCellBackfill.js\":\"0044ce6f7c1a0e4e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyChildMint.js\":\"3229d20a57299bd7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyChildrenProcessor.js\":\"cb47e4af48cf84d0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyDefinitionChangeProcessor.js\":\"5931a11ca79726bb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyDefinitionSynthesis.js\":\"7b54118720ef8b9e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyKeyScan.js\":\"796e68fd06407a7e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertySchemaResolution.js\":\"94029fbd5e4712b0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyValueEdits.js\":\"bcc89833f5b731c1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/raiseProtocol.js\":\"119c84884051b3e3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/readBatch.js\":\"57c02f99c5196e63\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/refProjection.js\":\"f0af28e4a925eda3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/referenceTargetLookups.js\":\"c38dd6546d609ca4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/referenceTargetProcessor.js\":\"cafd4829e4a20f4d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/replayMerge.js\":\"72c4c96a6f8a8e67\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/sqlBinds.js\":\"9cea1e893f310877\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c70d8ef0d8697612\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/arrivalProcessors.js\":\"4ffaf8e856a715db\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/invalidate.js\":\"ac69a7f7af1453a8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/materialize.js\":\"6896589279915073\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/observer.js\":\"52ff16c75bd84d41\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/reconcile.js\":\"5cad30c7517a1aae\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/timingMetrics.js\":\"deb7982c7b6d66d3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/treeQueries.js\":\"9859069cecb242ba\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/txEngine.js\":\"3cf9fa87973b6d3f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/txSnapshots.js\":\"c68009ca5d4fe68b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/typedBlockQuery.js\":\"1fb106b7e1f7d9d5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/undoManager.js\":\"e7adf90f40103f84\",\"/knowledge-medium/pr-preview/pr-1884/src/data/invalidation.js\":\"3e7d92b143ec580b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelDataExtension.js\":\"5008a1d47f71aff4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelPage.js\":\"de122917d9f17a88\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelValuePresetCores.js\":\"e280daec4660568d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbCorruptionSignal.js\":\"befbea82e4546146\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbStorage.js\":\"eac5c93de53e7470\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbVfs.js\":\"f27aa843f5b74663\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localSchema.js\":\"3fcef0498956720f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/maintenance.js\":\"41fb20a39752d202\",\"/knowledge-medium/pr-preview/pr-1884/src/data/mergeProperties.js\":\"f36a71f42f0cbf38\",\"/knowledge-medium/pr-preview/pr-1884/src/data/metricsConsoleHook.js\":\"04800eb8b856a740\",\"/knowledge-medium/pr-preview/pr-1884/src/data/migrationsPage.js\":\"c0de90dee02b1032\",\"/knowledge-medium/pr-preview/pr-1884/src/data/mutators.js\":\"34941b2663c7eb70\",\"/knowledge-medium/pr-preview/pr-1884/src/data/orderKey.js\":\"ec3a505967e90e6f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/orderKeyPlacement.js\":\"d6bf97961e68f810\",\"/knowledge-medium/pr-preview/pr-1884/src/data/outlineSurface.js\":\"0355734d24e5fb13\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pendingEditorContent.js\":\"95db7d8eebfdf25a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pendingUploadsSql.js\":\"7fbccfabd74012a8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pluginStateExtensions.js\":\"982a93d6d9b12801\",\"/knowledge-medium/pr-preview/pr-1884/src/data/powerSyncLogger.js\":\"ac0513de508b6255\",\"/knowledge-medium/pr-preview/pr-1884/src/data/projectorRuntime.js\":\"627009e6be7d2b56\",\"/knowledge-medium/pr-preview/pr-1884/src/data/properties.js\":\"822de71b925d26e9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertiesPage.js\":\"0f583ee6bbbb6245\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyChildren.js\":\"4244423368bd4f62\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionFanout.js\":\"c99981c0ea3e7404\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionMetadata.js\":\"9d147e4e1787cfa2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionRegistry.js\":\"d8fa9db32d683fd3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDisplayMode.js\":\"3850daf6b1951f91\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyRowCreation.js\":\"1dc29a89a4d35a70\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertySchemaCreation.js\":\"b1ff8c3702ac8792\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertySeeds.js\":\"7ae8d3e53b18645f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/recentsPage.js\":\"648b06d549aad613\",\"/knowledge-medium/pr-preview/pr-1884/src/data/refTargetComparableProperty.js\":\"2c512e681d88564f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/referenceBlock.js\":\"0da66f36dd1f5cbd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/rejectedUploads.js\":\"5bb78925e49d8a35\",\"/knowledge-medium/pr-preview/pr-1884/src/data/releasePowerSyncConnection.js\":\"b67a2b4fba879fd6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/repo.js\":\"37c8ac85397ca735\",\"/knowledge-medium/pr-preview/pr-1884/src/data/repoProvider.js\":\"baf898a848028ef3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/rowProperty.js\":\"a1356dfa2d70cfec\",\"/knowledge-medium/pr-preview/pr-1884/src/data/searchFilter.js\":\"b86295827c403162\",\"/knowledge-medium/pr-preview/pr-1884/src/data/seedIdentityLedger.js\":\"31d3ea12d7dd1ba0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/stateBlocks.js\":\"b30699683a2312c0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/structuralEditPolicy.js\":\"1bd810b488fd4bbf\",\"/knowledge-medium/pr-preview/pr-1884/src/data/structuralInsert.js\":\"4329618632362732\",\"/knowledge-medium/pr-preview/pr-1884/src/data/subtreeDelete.js\":\"a938153b0bcd55ca\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncStreamLock.js\":\"46fe79b964e0d313\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncedTableSqlRecognizer.js\":\"55daf87c7dfd2528\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncedTableWriteGuard.js\":\"a83f07a7c693ab9f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/targets.js\":\"10a90d0a966b1c59\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeColors.js\":\"51ace714369902d5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeDefinitionMetadata.js\":\"93040c1851741d70\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeDefinitionRegistry.js\":\"cd517b997455c003\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeExtraction.js\":\"1607f4fefdc8ff2a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeInitialValues.js\":\"d69c776a2b1d43c5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typePropertyGroups.js\":\"c4315e233d04b13d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeSeeds.js\":\"383e89a916c075fe\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeTagger.js\":\"5137503018b60fbb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typedRecords.js\":\"77468d5b81c950cc\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typesPage.js\":\"59e70726a324b738\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userPrefs.js\":\"79f4e4d073fcaa4c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userSchemasService.js\":\"ac50e29f4da71887\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userTypesService.js\":\"b409474d7029979a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/valuePresetRegistry.js\":\"b0cd1078bfc46a5e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/visibleChildren.js\":\"6e2fa03e2a678f4c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceConversion.js\":\"7e52432fbdcf79c6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceFirstSync.js\":\"f514e9c28f83132b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceIdNamespace.js\":\"2fefc993d966ce8b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceSchema.js\":\"188b5aa9da53217b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaces.js\":\"639a43e3142a3154\",\"/knowledge-medium/pr-preview/pr-1884/src/data/writeAheadLog.js\":\"b63651457c99ed21\",\"/knowledge-medium/pr-preview/pr-1884/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/BlockPasteShellDecorator.js\":\"2a17ca3916d8b8c2\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/atTrigger.js\":\"46dc4d24053fb916\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/autocomplete.js\":\"8104f9bd67c5b80b\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/codeMirrorExtensions.js\":\"7f6efbb9c7d76cc3\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/contentFlush.js\":\"c51b73a7aecfa80f\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/defaultInteractions.js\":\"6eab9ffb3db822a4\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/editSettleSignal.js\":\"1cf9ba316e9b4cf3\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/insertImage.js\":\"dbe6c77d84718cf2\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/referenceCompletionRange.js\":\"beafad3b63348f16\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/referenceTargetTypes.js\":\"087a192c4587dbbf\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/syntaxContext.js\":\"7cf0fa7a5318fe87\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/triggerMatch.js\":\"9f77ed94e85a1515\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/AppRuntimeProvider.js\":\"ed60925e4538c6aa\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/BlockFocusShellDecorator.js\":\"8f587ec44d28d855\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/ExtensionRenderBoundary.js\":\"eff149a11ac561fa\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/PanelContentRecovery.js\":\"88d9ff287823959f\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/apiCatalog.js\":\"9347f718e1a8c6aa\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/approveExtensionHere.js\":\"9224dbc3158c4d36\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/armedCutAppMount.js\":\"dbe7c4c8cd53a974\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/batchableKeyedStore.js\":\"abb63b8633b56fe7\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/blockInteraction.js\":\"ef6a81b45008175f\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/blockSelectionAction.js\":\"998b271fa0c68afb\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/compileExtensionModule.js\":\"875dee26ecc8a8bb\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/compiledModuleCache.js\":\"ae0bf666353f322f\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/continuousGestures.js\":\"23535981915aa1ed\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/core.js\":\"52dd12715d2545d0\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/defaultRenderers.js\":\"b914a6d9ff1ff12c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/definitionFanoutAppMount.js\":\"d306fe0c11b19148\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dialogAppMount.js\":\"52188dad108e48e9\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dynamicExtensionSeeds.js\":\"cd726b92ae2c3f3a\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dynamicExtensions.js\":\"6e681e78cb4f5ed6\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/exampleExtensions.js\":\"bc59e46d06fa5e57\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionApprovalStatus.js\":\"585c76223deefedf\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLoadErrorToast.js\":\"87bf6003eb99bb05\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLoadErrors.js\":\"3248534dc916cb67\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLookup.js\":\"f264006b3526c3ac\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionToggles.js\":\"db2a24f919017d85\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionUtilitiesCss.js\":\"60f2d81ea80cdd92\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/kernelPageDeletionGuard.js\":\"3dc139d69845dcdd\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/liveRuntime.js\":\"fc76a1e571d7c3aa\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/openExtensionsSettings.js\":\"a344322a5e73e78a\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/overridesCache.js\":\"6e9d57bf7d1356e1\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/pluginIds.js\":\"da14d48b0c9366c1\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/processorRejectionToast.js\":\"257e71cbf45d9dac\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/runtimeActions.js\":\"c7697bb1e06a749f\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/runtimeContext.js\":\"d8b21c21691c9fdb\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/staticAppExtensions.js\":\"b866d0c03c684ba2\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/staticDataExtensions.js\":\"8847f7d7995bf95c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/toastAppMount.js\":\"69f3304cc3dce01e\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/useOverrides.js\":\"9a5ee6a53cdbf3e6\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/useShortcutSurfaceActivations.js\":\"aa15929cc26d2218\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/discoverToggleTree.js\":\"d25dec6381a60b11\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/facet.js\":\"aa7fcef4a5363a89\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/resolveAppRuntime.js\":\"0225b354cf6142a9\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/runtimeEvents.js\":\"f33ddcc6df054498\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/togglable.js\":\"e700aecfe7e068b9\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/variantFacet.js\":\"4254e4ee0e39b385\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/verbFacet.js\":\"10eb1254e10ef92d\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/block.js\":\"e9cbbddb2c63daa3\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/focusedChild.js\":\"e75664cfb7c95b7c\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/propertySchemas.js\":\"5c9e4c4378cfb38b\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/typeRegistry.js\":\"146e4e090db89ed3\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useAncestorCrumbs.js\":\"e1e67733a0d5d5e1\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useAutocompleteListbox.js\":\"de80051cf2355886\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useDebouncedSearch.js\":\"897fd70abac26483\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useDebouncedValue.js\":\"4af33f27c81d17be\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useFacetValue.js\":\"a6ce4a64e6f52f55\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useIsFocalRender.js\":\"9c4cddd002158f78\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useIsReadOnly.js\":\"6d4952cfcfbdc3c6\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useMaterializeBacklog.js\":\"76cfa8993e63442d\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useMinuteClock.js\":\"500bfc5a729d90e3\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/usePanelLayoutProjection.js\":\"ddaaaae0f50a0232\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/usePendingInvitations.js\":\"e8fa13dfeb7be47f\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useRendererRegistry.js\":\"d7f5075cf4ed6343\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useRetainedFieldRows.js\":\"f6c7f42ac69d6265\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useWorkspaces.js\":\"e1e126a6512e0c2f\",\"/knowledge-medium/pr-preview/pr-1884/src/lib/utils.js\":\"91ba76d51e985ca2\",\"/knowledge-medium/pr-preview/pr-1884/src/main.js\":\"652e062b852fe56c\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/MarkdownImage.js\":\"e10130f42c5595be\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/blockSeparators.js\":\"c4792c73d257e01d\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/context.js\":\"41475b00c075c6e4\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/defaultMarkdownExtension.js\":\"4c3385d8de777b39\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/extensions.js\":\"a00e7f068c8eb0ee\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/renderMarkdownHtml.js\":\"eefc90712a554348\",\"/knowledge-medium/pr-preview/pr-1884/src/minimal-editor.js\":\"c806dbd7eb9008b5\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/armedCut.js\":\"4ee8debe32b20928\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/captureMediaVerb.js\":\"d297f3fea0a0084b\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/clipboard.js\":\"7f8b8b85a6b4234b\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/decision.js\":\"c43458fde15c0692\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/operations.js\":\"eb8c4b127e7db8de\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/account-header/AccountHeaderItem.js\":\"2d649087a6a2175e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/account-header/index.js\":\"1235f33b06212559\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"967a34c04eb04468\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/askAgent.js\":\"54e070a2c6c26f85\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/askedStore.js\":\"f0ff59dcb4f6fb31\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"61272656a929dc1b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/chipState.js\":\"8dc93da7f8edbaad\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/dataExtension.js\":\"1f5659f7dace106f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/index.js\":\"1ad1cd02d4b4bb1d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"ed00854067312ba9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/schema.js\":\"3a3a42112c7c98e7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/AgentTokensDialog.js\":\"98eb6a7bd3321308\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/BridgePairingDialog.js\":\"fb0260ff46fd0a0d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/addMedia.js\":\"f8a70ce18f5760ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/backlinks.js\":\"4baf41fd63a188a6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/block.js\":\"9128d0788781cf47\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/context.js\":\"b03d487a7efab182\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/displayIds.js\":\"fe370decc6839aeb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/index.js\":\"e8c631d1cecdbda2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/outline.js\":\"1b99a2a8f8c530b1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/properties.js\":\"80b56f45748c6c97\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/refs.js\":\"b4650022751fe2b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f58f33b5e742cb72\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/search.js\":\"3b774a61da9acb6b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/shared.js\":\"03cd7c4896d3dc71\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ce739b558af78892\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/text.js\":\"0f22a6c55649cf4f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentWrites.js\":\"f82f10a5678aa44c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/authoringCatalog.js\":\"8d114c58d7abcd2f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/blockRefTargets.js\":\"a0530504b533a736\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/bridge.js\":\"1be1f3e96c575b2b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/bridgeLoop.js\":\"7bc4a4d9002a121f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/changeHistory.js\":\"c87a9bf95bdf9589\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/commands.js\":\"d9796a59e0cd8cd7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/commentsCommands.js\":\"88969cf421ecdd71\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dataExtension.js\":\"2f86c524691a9337\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dataModelGuide.js\":\"c0443971d58f8fda\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dayPropertyInputs.js\":\"5624f56b10ff27cf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/describeRuntime.js\":\"13c667cb07b26b70\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/extensionLint.js\":\"b6703a1cc687247b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/grainAudit.js\":\"ae38cd0c4b0efa1a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/healthCommand.js\":\"4cc9cfbe25ba5288\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/index.js\":\"2e3340cc7b1aa5ef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/presetIdentity.js\":\"3573f854f887481f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"97b8af9288f47d59\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/readMedia.js\":\"1c9d00aa0d3f0e0d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/schema.js\":\"3890fa66de2bc325\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/serialization.js\":\"9959dbb7b6997ba5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/targets.js\":\"77ba80e4d6460b58\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/tokens.js\":\"6e15c80a1a780a5c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/watchEvents.js\":\"6c97b55ca13eaa97\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/workspaceGuard.js\":\"b7d95fd9f81c8ea7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/writeCommands.js\":\"73f3aac8dd70207f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/AliasCollisionToast.js\":\"1c8bf6a2b096aa88\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/DuplicateNameBanner.js\":\"2cd19d306b8b9509\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/collisionMerge.js\":\"fe99b4103d1afb47\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/dataExtension.js\":\"799edf0f84811f6f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/index.js\":\"d1860a3098e38e98\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/mergeCollisionAction.js\":\"ebf538d51581ae8a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/pageStyling.js\":\"87aff596df965333\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/rejectionToast.js\":\"5921da151b446ed1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/syncProcessor.js\":\"38e306472ebf9410\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/actions.js\":\"0263f3c392ebcfdb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/addComment.js\":\"f51b3d12f7ca7d27\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/anchor.js\":\"86327c3c63e7cc70\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/anchorState.js\":\"cd2d93a52431957c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/commentLinks.js\":\"451bb679c5dd7fe9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/confirmThreadDeletion.js\":\"01909452029a0f1f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/container.js\":\"233966016c5d0167\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/dataExtension.js\":\"d5244dbc9fdf3741\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/deleteComment.js\":\"b093171afb3eb307\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/highlights.js\":\"019a3dda05e5288d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/index.js\":\"735422fbd4a8ab14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/linkedCommentsPill.js\":\"b69b8c5f0c8c1949\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/margin.js\":\"72f9f297d23a6acf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/marginAnchorLinks.js\":\"a636815b96f5ac3d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/marginSchema.js\":\"33d13e4c4895478e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/newComment.js\":\"d6a47820a26a41e0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/ownThreadPicker.js\":\"a42e1381f04ffd3d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/placement.js\":\"99aea4278ba7842b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/queries.js\":\"7c0a3792785d250d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotePosition.js\":\"bb7a0aa6917ec306\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotedIn.js\":\"0ca54bc7cb304cd7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotedRange.js\":\"1592ef3bc34530dd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/rangeRefs.js\":\"485873d5a36151b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readHighlights.js\":\"82c33aac0b94dccf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readSelection.js\":\"2d81f5d72e786928\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readSelectionUi.js\":\"d74e00f0f40d480e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/reanchor.js\":\"cfdbab60a0a2ed90\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/schema.js\":\"e5c9b2122490be63\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/scope.js\":\"20fb66cfed150614\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/scopeThreads.js\":\"a0fe46058e5ce673\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/splitRetarget.js\":\"148bda7424d60c9d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/suggestionCard.js\":\"1230715202612a1d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/suggestions.js\":\"4716343483ac8e9b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/summaries.js\":\"580ccd0488d16dee\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/summaryBatch.js\":\"f6ae41b8eea6a47e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/surface.js\":\"7e4ca7d58d55e248\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/threadNavigation.js\":\"cae460a40015cfbc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/threads.js\":\"d1e3843e4c7251de\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/ui.js\":\"3463004450416a80\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/uiStore.js\":\"7b9dc7148b2b2037\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-intents/appIntents.js\":\"5ccee200ed959f3c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-intents/index.js\":\"a9a7812e8b63ad6d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-update-prompt/index.js\":\"f4be86c01b928468\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-update-prompt/status.js\":\"af05bcd4b48c090c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"6094ef2bb1e47662\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaBlockRenderer.js\":\"af1e367b75b79468\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaDownLaneReplicator.js\":\"85ac00ed9103d3fa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaUploadReconciler.js\":\"0e87ad1c30b66355\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetDownLane.js\":\"249182ce891acb04\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetResolver.js\":\"a811164aa4d668b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetUpload.js\":\"0ef92f642e2ae3fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/attachmentCleanerIO.js\":\"b8e12c4a365a224f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/supabaseAuditIO.js\":\"8e116e090a0eb3da\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/blobStore.js\":\"aab99f5ac369556e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/browserMedia.js\":\"f931a880ed71f972\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/byteStore.js\":\"b12f9afc312eb06a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/cleanerIO.js\":\"8185fcb7d9e821c0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/cleanupAttachments.js\":\"9fcf9d82f3244a98\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/dataExtension.js\":\"99eea427cd6ff681\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/downLane.js\":\"d775cdc2b6e153cd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/index.js\":\"480b57fff1f5c775\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/insertImageContribution.js\":\"efc26ae35ad43e66\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/laneArming.js\":\"537af63209a6e2ce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/laneLock.js\":\"4e934d516fc3139c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaBlock.js\":\"d9f0585829432223\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaCapture.js\":\"67b41928bba337ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaLanes.js\":\"668048781d48f026\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaViewers.js\":\"780f4d573583bfbb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaViewersFacet.js\":\"3e5c918f61380da1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/pasteCapture.js\":\"69887dd3658aa6e8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/resolver.js\":\"d40330748379fb47\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/retryUploadsAction.js\":\"a12fc16343ee9f68\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/storagePaths.js\":\"07e50a406f2e2890\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadDrain.js\":\"ba69a38ddb265a00\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadLaneStatus.js\":\"1b09a71302d9cc06\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadReconcile.js\":\"274a3dd10a3a390e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadRecovery.js\":\"39d58e7253b1f185\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadStore.js\":\"235a51a61225780a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/useAssetObjectUrl.js\":\"3a69ad6540a03326\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"4186545f0a0aadc2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/BacklinksViewSection.js\":\"bb4e3162b09a7754\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/facet.js\":\"ee1bdb68e9c9531b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/index.js\":\"81c3a713237eef96\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/prop.js\":\"7a07c3ad1d5fb943\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BacklinkFilters.js\":\"d94d0883076ceb06\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a780b75cf8c268f0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BlockEntry.js\":\"b7d2c565e54e9789\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/LinkedReferences.js\":\"619d2b96d4fe896c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"6a2eafa2a08a3474\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/dailyNoteDefaults.js\":\"858ba2f52931bf16\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/dataExtension.js\":\"01e5474d80a806a8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/edgeExclusions.js\":\"419aad7a852621bf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/filterProperty.js\":\"8d6f57d76b50f43c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/index.js\":\"041e72edfad81aca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"dbcc9821d3997033\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/applies.js\":\"5efd094732348ebd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/countQuery.js\":\"480de8059aa55e7a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/expansionStore.js\":\"28a515f2f7f9bcc9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/index.js\":\"e7109ca5a73519d7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"5244ab5bb1c7ab7e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/presentationInvalidation.js\":\"073f8769d2d6fc8f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/propertyEditorOverride.js\":\"075ff7d8420624a3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/propertyFilter.js\":\"ab18c554ddf5f6a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/query.js\":\"1c896f597750e41b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/resolveFilter.js\":\"5c84df6134bf453e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/sourceBatch.js\":\"ca946b875eccc0f3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/sources.js\":\"fbc230a5d3fb6b11\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/useBacklinks.js\":\"3a50ca6a71494ea3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"eabb2092e012bddf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/BirthdayCelebration.js\":\"296d9b1e38515677\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/BirthdayOverlay.js\":\"80c0c69d7a1fa303\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/gate.js\":\"2f18f61bc28c72a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/index.js\":\"b888fa2e58bf840b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/wolfTheme.js\":\"1cc8c6253cf1ee06\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/BlockDragLayer.js\":\"7ed0d36258a1eb59\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/dragController.js\":\"913198b48dbbc3b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/dropTarget.js\":\"a2dafd23df5335ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/index.js\":\"d43332ddea5ef733\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/projection.js\":\"7f542724e76f628d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-info/BlockMetaCard.js\":\"2cd6255f361bef27\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-info/index.js\":\"8b543b41862e26d3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/AddTagDialog.js\":\"d9775e2e78ccc589\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"aec2de6d6a55243e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/TagNameIssueHint.js\":\"1b39f3872d9cb973\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/addTagAction.js\":\"958075f97db37916\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/appendTag.js\":\"9a6a0c58fcbd09bf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/config.js\":\"f86140e0040a1a83\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/dataExtension.js\":\"b929d24037edc747\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/index.js\":\"46a9436cf52186c9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/propertyEditorOverride.js\":\"f1b04f4a2a9e0432\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/BreadcrumbList.js\":\"1eb7c0650907d2f6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"424b2b49b568a371\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/Breadcrumbs.js\":\"25564b49aee3383d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"57a1a003b42dc49a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a222089b8677135f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/index.js\":\"96f9115bf8b45e66\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"88a46a587a154acf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/CharacterCountItem.js\":\"96e28d64062629f6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5dff5aef9233037e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/actions.js\":\"0ea66f288890db8d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/blockType.js\":\"a7771ea20ea178b9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/charCount.js\":\"3a66077e6f0b44f8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/dataExtension.js\":\"141733b68b21fabb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/index.js\":\"6cae79219c56fbc4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/profiles.js\":\"bd2b6b41588d9444\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/properties.js\":\"11b0702db001d35e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/subtree.js\":\"556c3fb3ed51168c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/textCounts.js\":\"288b8418c2ad8e63\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/colemak-keybindings/index.js\":\"a025bfba1b12dcb6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/CommandPalette.js\":\"ec91019b2ce3c07e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/HeaderItem.js\":\"5a4e12ee3ba9beeb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/context.js\":\"0051b7cc8057e16c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/index.js\":\"f99408c07f98cb43\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/selection.js\":\"a25b837fa04af198\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/toggleStore.js\":\"014adb14449997c8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/useCommandPaletteActions.js\":\"e375632f3750501e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/ContributorBadges.js\":\"54a6a50aaec63ce8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/author.js\":\"22c8e3bb085410ce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/codeMirrorExtensions.js\":\"619e9332c31a3d0e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/dataExtension.js\":\"d900d4162bd35441\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/index.js\":\"803b5a96d5c4948e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/mentionAutocomplete.js\":\"806fa3761ecda880\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/processor.js\":\"e3e39b8e7d4d300a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/profiles.js\":\"7f706ca964f18535\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/queries.js\":\"c645349893176694\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/schema.js\":\"46595490e61cc435\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"374159a6a1d1fa76\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4cb3168dc878a9d1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/index.js\":\"224494dc9fff40b5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c7736415381a3519\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f6d8af8c6de63fec\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/CalendarGrid.js\":\"e883c08c6e98447f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DailyNotePicker.js\":\"029fada37633949f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"526d55ce54dec7f0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateNavDecorator.js\":\"464ccb79862c9dff\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateScrubOverlay.js\":\"27ebef4654555c37\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DayPropertyControl.js\":\"a985496fdec2065c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/HeaderItem.js\":\"e4f22d80e74a9806\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/ReschedulePicker.js\":\"05d4ec321df38437\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0826c13c7d3cf4b1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/actions.js\":\"a2af2d8a66978f16\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/blockDateAdapter.js\":\"739f2bda089cc3ae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/calendar.js\":\"67159f5bcf97edb3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dailyNotes.js\":\"2e2cc49b40c2e94a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dataExtension.js\":\"079f9f7bedfd95f8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubActions.js\":\"1ae717cbf57cdaf5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubGesture.js\":\"c79c9e441f91778b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubGestureActions.js\":\"960ebdbe6d106d28\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubRecognizer.js\":\"25391eb1f589fa56\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dayProperty.js\":\"0d41ecb97ca85f11\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/deletionGuard.js\":\"84f8b748ebccf8a8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dueQuery.js\":\"9b7d3ef9c0cef68d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/index.js\":\"7d2e1fc86b54539f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/landing.js\":\"1f433c26c2bbf5d5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/localSchema.js\":\"4196f2d0b49a3b31\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/referenceDateAdapter.js\":\"c0e1c836340b154d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/rescheduleAction.js\":\"76cdccd02d2a5b3a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/schema.js\":\"94f0adbd082de18e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/spreadBlockDates.js\":\"b7028bf3f9b00bd9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/spreadDatesAction.js\":\"5a846282103ae35d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/today.js\":\"f466e19207e827fe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"86881fd3b4a97851\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"99b93d90a018af4e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/audit.js\":\"e7529f245c0a290c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/auditAction.js\":\"33df64a5d8798505\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/auditRanges.js\":\"5dc53673b0cd7534\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/diagnosticsSource.js\":\"580267962cd6c6bd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/divergenceScan.js\":\"9808703eeac289a3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/index.js\":\"eb2c22c738e139de\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e18d84f0d57d37b5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/referencesMirror.js\":\"5120e5ddbbbde3fb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/rowJson.js\":\"51b886eb338f1656\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/schedule.js\":\"21d3c2118b38b18a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/store.js\":\"d60b6a662a92b077\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/action.js\":\"9a8016d803e122b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/index.js\":\"9be0a1c1ff4ae937\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/plugin.js\":\"8bd66910a94144d5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c2ca94ae9f84700b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/actions.js\":\"ebb6597ef8921ba5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/changeMarker.js\":\"ac8b7319b4669b4b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/diagnostics.js\":\"053b601db9e37f18\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/fileSystemAccess.js\":\"61f1923ee2a6f9fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/filenames.js\":\"5371d4ef7be73cd4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/index.js\":\"07cdec84ded66a19\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/mirror.js\":\"203ff7172fd9f077\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/runLock.js\":\"2986bd37a65bd305\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/runtimeHealth.js\":\"a960b5f1374ee2c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/schedule.js\":\"7055dd4bdad96425\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/store.js\":\"995c9c33a84248b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/default-themes/index.js\":\"ddc7baa9b1612fe0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/default-themes/themes.js\":\"ca95fcdeafe2c141\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/diagnostics/facet.js\":\"26f87435b6ce46ae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/diagnostics/useDiagnostics.js\":\"c10edd6ac2cf9c2c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/dismissals.js\":\"f75310fccbd2a413\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/index.js\":\"2d943cf0b2b53c9b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/status.js\":\"5b0ce25adb786a03\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/store.js\":\"58e3bd8ec52a3949\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"38d92f514a218a94\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b15a0ff1d25802b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/actions.js\":\"46a008740643627f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/config.js\":\"2372a817a2381e50\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/dataExtension.js\":\"c33e201f3b2d7452\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/effect.js\":\"aef1cdabd21bcb6e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/index.js\":\"9f8994f97b5b4390\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/propertyEditorOverride.js\":\"b70d218f5e21168c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/useToggleTree.js\":\"82c92b1c9fc00a5d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/ExtractTypeDialog.js\":\"a6c906ea6353c15f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"6f1c44346c54b13b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/PropertyShapePicker.js\":\"e579de45839fed32\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/action.js\":\"7eb4699046a3e0cd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/index.js\":\"2240dead05d8eaff\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/FindReplaceDialog.js\":\"7e6a1438d8e4e731\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/HeaderItem.js\":\"1cc914a339d72ea5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/dataExtension.js\":\"bef90238145d3a87\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/index.js\":\"6ec98af4e7010e1a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/search.js\":\"a80d31913e99d40e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/toggleStore.js\":\"cdb575c24fdfdcd7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/LocationPropertyEditor.js\":\"8375f7e808b813e5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/MapView.js\":\"6e8cff476b291865\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/blockTypes.js\":\"c7decbc7e1fb0b58\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/codeMirrorExtensions.js\":\"2978ead1928ce217\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/createOrFindPlace.js\":\"4e1e064fb0dcfd2f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/currentLocation.js\":\"960b9490aab5d8fb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/dataExtension.js\":\"0a24f7481d4afb4f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/geoContentDecorator.js\":\"c1bd5e7a85b5c2de\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/googlePlacesClient.js\":\"8fd910dc5422781e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/index.js\":\"cf8ff376e2a9d409\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/locationsPage.js\":\"2ee54ca8f50844c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/mapViewport.js\":\"983761ae69f79c96\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/pickCurrentLocation.js\":\"05351c171713ee18\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/placeAutocomplete.js\":\"b6cf8aa63642559e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/placeNameCollision.js\":\"5ef5447992385f74\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/properties.js\":\"403428565329e59f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/propertyEditorOverrides.js\":\"01034d107018f4f1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/query.js\":\"52689e16b54a1e2d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/usePlaceSearch.js\":\"c082dc8195f3e7bc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"95dc931d714b7194\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b8569f96a2c032c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"5199cb81b34e7181\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/config.js\":\"f272424f5754f46a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/dataExtension.js\":\"0ba0d746d7d86e1d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/facet.js\":\"c7f97f7d295bf148\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/grouping.js\":\"0f661f813903c44c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/index.js\":\"f9396528c1802704\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"79389e25959fb0b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/query.js\":\"dac844e45326b50e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/resolveConfig.js\":\"785423fa72c54d2c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"7be7fd27953a31af\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d0bb0a8b31111514\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/HtmlDocumentContent.js\":\"4d68f1863e15d4aa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/HtmlFrame.js\":\"b510105f1572147a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/actions.js\":\"b4a9ee5937a71723\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/blockType.js\":\"e35343ad82610180\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/confirmRunScripts.js\":\"c740486295ba8422\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/dataExtension.js\":\"fb6a1b4bff4ca5b3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameAnnotations.js\":\"27e7758572106bdb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameDocument.js\":\"b8e81a8f3993cad3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameTheme.js\":\"c772915093afb7de\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/index.js\":\"37caddf62c327113\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/scriptConsent.js\":\"5136fbe3b4eef867\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/sourceMap.js\":\"0d9c093c98173b95\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/useDocumentScripts.js\":\"b30df54feba57e36\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/index.js\":\"37cd5b684db5e79d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/record.js\":\"16633850586806b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/recordStore.js\":\"b69341dff6599105\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/responsiveness.js\":\"55bcd0316f15b371\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/schedule.js\":\"37e29ffb562afd90\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/sessionContext.js\":\"6f602567aa22612a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"6dbc16416412433b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"270696b2b343b836\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/actions.js\":\"7dc29769f7332f38\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/config.js\":\"924949fb1fe57807\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/dataExtension.js\":\"28b61a7b6210b995\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/effect.js\":\"b035538c94618723\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/index.js\":\"70f70eed1a6763fb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/keyCapture.js\":\"15970c5a5a487382\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/overrideStore.js\":\"215bbb77ef18d7c8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3d9777a26185b6de\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/HeaderItem.js\":\"0ea3546c5c71b265\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/LeftSidebar.js\":\"3cab3dde7bc63bf4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/actions.js\":\"22b803c726a38cdf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/facet.js\":\"f436e76bb3a4b18e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/index.js\":\"3692276c86bc12ea\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/shortcuts.js\":\"293690ace2fbbe15\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/toggleStore.js\":\"30116dac2b555f6e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/MergePicker.js\":\"d699dff40bcd9c8c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/index.js\":\"799a630572cae91e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/mergeAction.js\":\"747a44f5ab46a5fc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/strategy.js\":\"80c1d3f2bb79fe12\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/Button.js\":\"933420ff1c303c31\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a8757df31e195e41\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f862cebf3b40669b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/facet.js\":\"6f75044604d8d633\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/index.js\":\"20f6cf3c5877b325\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b1fb744b9a0af4e4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/actions.js\":\"65e1a483dcc88f91\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"da8c7c6feba9a8eb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/facet.js\":\"e86813355b9d0fd6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/index.js\":\"e5814491114ac0e0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/MoveDestinationPicker.js\":\"7bfcab1469da77d1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/blockSubtreeMembership.js\":\"f9c85897b695a9af\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/contextMenuItem.js\":\"7ca0fd0381f96f05\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/index.js\":\"daf6d93f6b6da53f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/moveAction.js\":\"5967fe7d16defedc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/moveBlocks.js\":\"45b9e28f0f032d15\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/selectionAfterMove.js\":\"ef30dc1e5e5aa921\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/TutorialBanner.js\":\"1a95953b7fce5f6d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/action.js\":\"b567b3d8aa5b0db4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/bannerDismissal.js\":\"0b3e21a854d2ac1e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/documents/cheatSheet.js\":\"3ca20fcd61f69890\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/index.js\":\"29b260c7e9361f6f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/keys.js\":\"117b6aae621768c3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/landing.js\":\"f5be197f623460bd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/outline.js\":\"cfb160f70bb6275f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/seed.js\":\"c44224abb7a7cbb8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/PerfTrendDialog.js\":\"bd2a82c2ebc7a9d6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/analyze.js\":\"1d3c1fbc58a75509\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/diagnosticsSource.js\":\"51923c1a8c4e864e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/index.js\":\"863b7e12bdb96928\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/load.js\":\"d6169c86ee5d1e97\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/monitorRun.js\":\"d158a2d4c5365924\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/schedule.js\":\"c5a2f72e07bdf16e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/series.js\":\"426e1eb3b5bde14a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/store.js\":\"eae07b9f8c451fd5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/trendAction.js\":\"4ec191a453700112\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/verdict.js\":\"e7cb7522f3ebb798\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/clickToEditAction.js\":\"805368fdbf691d7c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/index.js\":\"597844ea11396e7f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/interactions.js\":\"bce411b344e62ab2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"43f0420e797800d1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/MigrationGate.js\":\"6a3f6720070a6509\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/MigrationGateDialog.js\":\"abb1c917f0ea7709\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/action.js\":\"0921c2deca73c6f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/index.js\":\"c7bf6dc87a5e780f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/localRunMessage.js\":\"594cb381e73fb18e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/plugin.js\":\"fb329b6fd1550cf9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/progressReport.js\":\"c22ca1b87101c592\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/sweepProgress.js\":\"700868b6a984938d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/FieldRowRenderer.js\":\"0fd8fa0722d8d4d3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/ValueRowRenderer.js\":\"7ffb10a59fabf2b5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/actions.js\":\"a5a592d060d98bcc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/autocomplete.js\":\"f23854494e387bd0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/fieldRow.js\":\"57ac4f99277e9705\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/index.js\":\"53d0d62380228231\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/referenceWarning.js\":\"78f72058e3be80c8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/valueAutocomplete.js\":\"e239a7ae027ca62c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/valueSchema.js\":\"09097209e36446f1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/HeaderItem.js\":\"33628e94961ce765\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/QuickFind.js\":\"c118ec5f0178e4e8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/index.js\":\"a327d396cbcc8553\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/recents.js\":\"87d1d1c54e7a6c77\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/resultItems.js\":\"7903809f370545c5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/selection.js\":\"ac6b0099fb398ac3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/toggleStore.js\":\"d3199c529f7e8f96\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/HeaderItem.js\":\"22e42d3645716ff8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/RecentsPageBlockRenderer.js\":\"9a2c040428885f37\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/grouping.js\":\"5ba636d247e94d19\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/index.js\":\"253f6baa8a155543\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/target.js\":\"6645e158b3f33263\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/codeMirrorExtensions.js\":\"7dcb68507340e4e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/contentPrefill.js\":\"6f875a3427f0ac47\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/dataExtension.js\":\"7857a8823acef061\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/index.js\":\"0e510f39ba2c8c3e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d2129a7613ada00a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/invalidation.js\":\"c60d7b791e4e68f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/localSchema.js\":\"0dc08913e2bfe040\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/blockrefs/index.js\":\"c171baf9f921f7b5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2023b7f09e666e06\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/index.js\":\"f8ca7e819ede01fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/referenceNode.js\":\"f24bd3e3284756b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/remark-reference-occurrences.js\":\"0836eb6fd9fa4931\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d0af4568a4fce12e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/index.js\":\"c04ab88114078f41\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"bc4217f9d73f81f8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b02ea7f3381d8134\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/mergeRetargetProcessor.js\":\"34bd0a041f79f109\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/parseFence.js\":\"4aa44337f9a30939\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referenceParser.js\":\"2a48a6cfef255c89\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referenceProjection.js\":\"053aa59a07b924bd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referencesProcessor.js\":\"10de9597bdc5574d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/renameProcessor.js\":\"38d76b489ad56cba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/spanReplacement.js\":\"4657e17b3f8006e7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/htmlToOutline.js\":\"0844e73aad4ccdba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/index.js\":\"03246f26e3efa06c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/normalizeClipboardDom.js\":\"211388b5b146dfef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/pasteDecision.js\":\"9ec4b8c8b9d11089\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/action.js\":\"931487abfba138ab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/blockIds.js\":\"2d75dfbb78e22d8d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/content.js\":\"9a3dc66217a45a37\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/effect.js\":\"4fabb0baef6d25e6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/ids.js\":\"4a797f29213ba0b2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/import.js\":\"275e6a4ec64b45a2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/index.js\":\"b43fda37a9513e11\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/plan.js\":\"41d83e24b98b322d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/plugin.js\":\"4303e000cd233ebe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/promotion.js\":\"ace40a3383072348\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/properties.js\":\"5dc3cc28acdef73f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/references.js\":\"a9f16bafdf560ae5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/report.js\":\"d027c77cbccba344\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/roamMemo.js\":\"480bdb99683d0f3c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/runtime.js\":\"90e1f1f97ce0728e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/schemaReconciliation.js\":\"44540b68773cdf8a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/srsMarkers.js\":\"b9b75e18e83c04d3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/todo.js\":\"805d8d5243263617\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/typeCandidates.js\":\"73c7c5e53dfa0b50\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/types.js\":\"c63ff82f98c7a1b3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/search-health/index.js\":\"ad07802db3de42a4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/search-health/store.js\":\"5f5611ff10947d95\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/HeaderItem.js\":\"dc285967d4cace9e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"56b61ae40208d243\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/index.js\":\"11df9ab158833f05\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/model.js\":\"1f9a45af218a2bc7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/toggleStore.js\":\"65e2e45fd14c3fae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/useKeyInspector.js\":\"13c4b6831193270b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8905ec86518298b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/ShellDecorator.js\":\"dabf62ba08585aba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/actions.js\":\"2e9356326b8ba3ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/exclusionsFacet.js\":\"5c82c2182e204c08\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/index.js\":\"20319d1066467346\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/shell.js\":\"0720711bd7e949a2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/surface.js\":\"453882908fc88940\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/walker.js\":\"69c568781303591e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4f531075ddcd0231\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/dataExtension.js\":\"513caf0ade4e8014\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/index.js\":\"6ed515d305ddb18e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/indicator.js\":\"91f80589535f3ba8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/moveSrsState.js\":\"79b57bf0a28fdd64\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"106676a2594a18bc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/scheduler.js\":\"89bf8ee17e56c0b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/schema.js\":\"b1fc1619bfe5d903\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"758c74480f77bd2e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/srsClipboard.js\":\"22576e29d7391d6f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"285b74152da51bbb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b4a13a16945e5810\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/DeckPicker.js\":\"5588d9d9f41f9671\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewControls.js\":\"e8aee6f83182e1b8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewDeckRenderer.js\":\"26857411f7071382\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewSession.js\":\"915b67e0e15b9ab5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/actions.js\":\"0a242739c4dbff7c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/archive.js\":\"2e5a454a008a651b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/dataExtension.js\":\"3e4723344eb759f8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/deck.js\":\"f461536d0bf0e4af\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/dueQuery.js\":\"8e8ee3f2ce28bc25\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/gradeDecision.js\":\"48306b7952e5de0d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/index.js\":\"92c7a91678eff821\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/keyHints.js\":\"4f1d084d55a922c1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/reviewCardLayout.js\":\"2dcd686795f58c3d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/reviewProgress.js\":\"dfc7bf886b07e556\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/schema.js\":\"dab4ecadc22f6b0e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/useDueCards.js\":\"9bcf4fcc0cc14537\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/startup-metrics/index.js\":\"20cb24cdfed41eea\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/startup-metrics/record.js\":\"df9e3b855037a711\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/index.js\":\"8870cc16d2eb3369\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/persistenceStatus.js\":\"3aa02bb7c9ebd242\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/requestAction.js\":\"1ac3ddb693af4c90\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/TypeChipsDecorator.js\":\"d7e888c8015d4eb8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/codeMirrorExtensions.js\":\"11c5360ce715d1dc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/index.js\":\"cb44b07126bb70ab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/typeAutocomplete.js\":\"fea260511724bc23\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"b1635387e74801d7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/actions.js\":\"3dcf259fcc526e5a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/anchor.js\":\"952a009f73339e3c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/events.js\":\"8a0c6b2252a5a408\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/gestureActions.js\":\"20511bb20fedd591\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/index.js\":\"8a9e54a2413d04b5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"fa94223f772b621e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/collect.js\":\"380414291c1ab66d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/index.js\":\"1f3f1d3b23dd4814\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/record.js\":\"ab89368af9a1a431\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/RejectionDialog.js\":\"78b5aee5bd213a64\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d79ac09c947fb8b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/index.js\":\"feacff27da19ae13\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/model.js\":\"a54ab75a68a82656\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/queueCounts.js\":\"ecda476e8a0e1019\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/rejectedHelpers.js\":\"70df38223c5efe6d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/rematerializeAction.js\":\"a5d6d372cbcaa857\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/useHysteresis.js\":\"2e11bab222b3331c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/ColumnHeaders.js\":\"4b4e9c2d6eaf1308\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/QueryUi.js\":\"5f5545bf80decacf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/TableLayout.js\":\"f6484135dc00dedb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/actions.js\":\"8cf23479201c51d2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/cellEdits.js\":\"20b9ec289b0f4111\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/childrenViews.js\":\"59f9f1d7f3618421\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/columns.js\":\"18d461d52a7fae47\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/controller.js\":\"1e7ab6ab1b3e160b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/convert.js\":\"c6c86c92eb7ab674\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/dataExtension.js\":\"f50b8fd458e0713d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/index.js\":\"ecc1301c31b1edc4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/keys.js\":\"fb910618fbbdd69e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/model.js\":\"89cd26218df502f4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/QueryText.js\":\"cde8cb6cb645b5a9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/backfill.js\":\"e55bef3a90273b29\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/completion.js\":\"5d967dcd3c00c250\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/format.js\":\"ef13c19c55abd1e0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/parse.js\":\"1a636b7ba609d61e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/queryValue.js\":\"8c8a33a6bae11de9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/registrations.js\":\"152f1337f430caef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/source.js\":\"c7b41fc5eb4a66e7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/registry.js\":\"55e719bd70a19833\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/rowGutter.js\":\"f528a4a41a550b16\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/rowVerbs.js\":\"a001737f14eb93cb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/schema.js\":\"013977c5c26a920b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/sort.js\":\"c527682992ead0fe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/effect.js\":\"1a30d14bfcbce5fe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/index.js\":\"7a18af08e112e24c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/theme.js\":\"f7fb86111329417a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/actions.js\":\"0a587866a34b73cb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/dataExtension.js\":\"2ff8b5fcf59f9f83\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/index.js\":\"45d11756db91cdbd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/schema.js\":\"7574850718a41bfa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c0b58fb40a34f195\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/actions.js\":\"00955bb49329a9ed\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/defaultItems.js\":\"94d693963135e7b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/facet.js\":\"5cd3b642e0fe001a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/holdRecognizer.js\":\"fec86441ddf4d135\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/index.js\":\"f54704d789bef258\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/UpdateIndicator.js\":\"20099395c41380f6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/index.js\":\"6f830747f698bbfa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/loadTimes.js\":\"ed4d7d25eb6dac0d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoNotesRenderer.js\":\"c44e35024e2d3464\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoPlayerRenderer.js\":\"e593d3a6e1c95045\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoTimeStamp.js\":\"0782766bcf9646ef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/actions.js\":\"19bfb6157b322da0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/index.js\":\"e48d9b05c9b609e4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/markdown.js\":\"e3a2bd94ac827966\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/notes.js\":\"2fc04845d61c8cd7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/registry.js\":\"76379114ca6ab1aa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/remark-timestamps.js\":\"fee55d1b900fdbce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/view.js\":\"f86d10c1f976c922\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/LinkHints.js\":\"3b666ab6db84afca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/index.js\":\"0faa0696af637316\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/model.js\":\"2b8e509c2a01177c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/settings.js\":\"0f4918c93e6c86ec\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/actions.js\":\"fe59aef911ad9d2d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/index.js\":\"e6ee03d34e50f27c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/interactions.js\":\"3e0663feb8cb7194\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/workspace-header/index.js\":\"da3dc5abe3e209c6\",\"/knowledge-medium/pr-preview/pr-1884/src/registerServiceWorker.js\":\"53172a71ae0d1acd\",\"/knowledge-medium/pr-preview/pr-1884/src/requestPersistentStorage.js\":\"0910a3edae8a1bbd\",\"/knowledge-medium/pr-preview/pr-1884/src/services/authRequestDeadline.js\":\"7ce441114c5ad433\",\"/knowledge-medium/pr-preview/pr-1884/src/services/authStorage.js\":\"f8676fcb79b8e74f\",\"/knowledge-medium/pr-preview/pr-1884/src/services/powersync.js\":\"2edc3571ce411c3c\",\"/knowledge-medium/pr-preview/pr-1884/src/services/supabase.js\":\"29f162f35d498de7\",\"/knowledge-medium/pr-preview/pr-1884/src/services/uploadErrorClassifier.js\":\"cf2f399b560317ba\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/ActiveContexts.js\":\"54ae6baf0aa036ba\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/HotkeyReconciler.js\":\"24e498046aa57588\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/WipeLocalDataDialog.js\":\"9c1281e1d4e50965\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/actionDispatch.js\":\"f66c5334c13145b4\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/actionRefItems.js\":\"69c459ce3e903ce1\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/applyKeybindingOverrides.js\":\"f14fb71db54b45f8\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/blockActions.js\":\"d37558f5e6750798\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/blockMergeGesture.js\":\"f4a185ed20ef4821\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/canonicalizeChord.js\":\"8685f112ba0b4a5b\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/defaultContexts.js\":\"c2f931e67c7b9448\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/defaultShortcuts.js\":\"42da0d88d29729a6\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/effectiveActions.js\":\"a29ddebc0a667398\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/gestureAction.js\":\"65308c9b9fe86a02\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/gestureBinding.js\":\"f46850e09a5a7f46\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/holdRegistry.js\":\"85ccb5ec6655b9a8\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/keybindingConflicts.js\":\"7ede8000c879a860\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/keybindingOverrides.js\":\"1f2c2d4ced8b0bca\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/pointerAction.js\":\"bb8540cba62d544f\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/resolve.js\":\"8cb2b3c5cd8b2a6c\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/runAction.js\":\"b049d0b7634c8ce7\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/sequenceMatcher.js\":\"2bb312b00dc1fc0a\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/types.js\":\"7f79caaf55612437\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/useActionContext.js\":\"71cffdb618ab49c9\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/useActionDiscovery.js\":\"88cb65c48b37a4ae\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/utils.js\":\"12f30824803c0419\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/bootStore.js\":\"2df39649e944a122\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/previewDatabases.js\":\"80aec175676cb639\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/byteTransform.js\":\"613cb853a4d4cc6e\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/attachmentCleaner.js\":\"81b6f355523bd2c2\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/attachmentParts.js\":\"22521cde1c82a0bf\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/bundleParts.js\":\"a64ab717ac78b850\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/bundleRecord.js\":\"f9b4e8a0c12997ef\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/manifest.js\":\"35349bdd5e3419b9\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/takeBundle.js\":\"d0ad44228cb6b2b4\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/verifyBundle.js\":\"322fdb01ad001739\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/cleaningStage.js\":\"0ccb13c1c96bbf64\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionKey.js\":\"bcafac8e0a30141f\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionServer.js\":\"fb1497fda1007edd\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/flip.js\":\"5887125a8b403a2c\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/flipAttempts.js\":\"2ab7a4a62578d061\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/pages.js\":\"52f4b3d2de31d328\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/preflight.js\":\"81b2054615f61701\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/reseal.js\":\"b3e1b5edc0645d65\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/runConversion.js\":\"c736fbd204edce24\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/runLock.js\":\"5c338afeaa291a41\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/sealing.js\":\"5f6f5a8128bfb93f\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/sealingStage.js\":\"097fa61bdf33cd3f\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/stage.js\":\"4b05e064ab7e620b\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/verifyReseal.js\":\"34d5348e43829c4e\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/aad.js\":\"a569856e176524a8\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/aead.js\":\"b471d8d31bf3e734\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/base32.js\":\"2396ed71cf1ad374\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/base64url.js\":\"c106dee275b5baee\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/binaryEnvelope.js\":\"d4d75952eb3a09b5\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/byteAead.js\":\"4659c6ecb9cd36de\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/canary.js\":\"a8eba6b6d7254e17\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/contentHash.js\":\"1a267c92d7a790dd\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/contentKey.js\":\"df73edd965e8d6d4\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/derivedIdNamespace.js\":\"8bcba0da3e851511\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/envelope.js\":\"2c960240a518e3f1\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/hex.js\":\"deacebe40882b4ca\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/sha256Hex.js\":\"299ce295039ba1cc\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/workspaceKey.js\":\"a89995f1638b5946\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/conversionState.js\":\"7cf0c71c3cd8beeb\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/createEncryptedWorkspace.js\":\"96cd2bc3b865639f\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/pastedKey.js\":\"0e439b490b1fa7e3\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"3b24a1b10c897fa9\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/upgradeWorkspacePin.js\":\"bd0cc17a00116ef7\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/keyStore.js\":\"366be9f054205f99\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/mintWorkspaceKey.js\":\"56f7047a398fc342\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/modePin.js\":\"3cfbb3b609c295fe\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/openWorkspaceKeys.js\":\"60aef0b60b9345ab\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/resolveWorkspaceEntry.js\":\"15defbf4cb12d081\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/resolver.js\":\"6278e1577c93e6f4\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/workspaceAccess.js\":\"7c6852ccdc45c25f\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/transform.js\":\"10cbe12a3a195cfe\",\"/knowledge-medium/pr-preview/pr-1884/src/themeBootDefaults.js\":\"459001e9fd351492\",\"/knowledge-medium/pr-preview/pr-1884/src/types.js\":\"8810f842b834f63b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/ClientLocalSettings.js\":\"43e8cb3c4dc07e1d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/abortableSleep.js\":\"0f823213a3ec3d2c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/array.js\":\"bd774ee733415441\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/backlinkAutocomplete.js\":\"7f457adca6a9170a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/blockCrumbs.js\":\"f131a5ed4d6571be\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/blockrefAutocomplete.js\":\"3bc4e9e35798e2fb\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/cadencedIdleJob.js\":\"60bd933635894fc2\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/callbackSet.js\":\"3e94a2cde7e919d4\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/clientId.js\":\"ba31faa430fa4980\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/codemirror.js\":\"7548f6fbee30470b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/codemirrorCompletion.js\":\"9a29fb27f4e60ea6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/copy.js\":\"961f49e96ce906c6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dailyPage.js\":\"fb2d6199789e55b5\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dbForensics.js\":\"5e4fad1bcd07685d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dbForensicsHooks.js\":\"9ee0d3d68031515a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/deleteBlockThroughUi.js\":\"66570fb94b86893b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dialogs.js\":\"6adbe3ea2f90c36d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dom.js\":\"a47c2a8b332ce576\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/downloadBlob.js\":\"6fe512eca1b680a9\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/drawnWalk.js\":\"febfe95333eaf07a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/exportSqliteDb.js\":\"ae2eb2e1d7e3dc81\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fileSystemAccess.js\":\"01d5c547e5f74e04\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/flipSlide.js\":\"a96145dc940d90cc\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fnv1a.js\":\"f59d8611db53859c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/formatBytes.js\":\"d6edb559c98119dd\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fuzzyRank.js\":\"eb74445efe29a944\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/idbKeyedStore.js\":\"744341c84dcd47a4\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/idleCallbackPolyfill.js\":\"f2bebd22ef20f09f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/keyboardAwareScroll.js\":\"62679e8c78e8c8af\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/keyboardViewport.js\":\"98e83552da38703d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/lastWorkspace.js\":\"78ca508c65553160\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutColumns.js\":\"83e0725972e46c5c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutSessionDom.js\":\"83384a3e2350881e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutSessionId.js\":\"7549958d9211e752\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/linkClickGestures.js\":\"fbc2bec9d8af5fcd\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/linkTargetAutocomplete.js\":\"fd1b7fcd84eaba2c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/localDbCorruption.js\":\"79ca40db7eb99cdd\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/localDbRecovery.js\":\"7ea732cb303947cd\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/markdownParser.js\":\"b4a61c0fb8703e54\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/memoize.js\":\"584a37715ef4019f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/nameFieldCommit.js\":\"cf46d9ac724455fb\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/nameList.js\":\"23f439904189328d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/navigation.js\":\"1d694077423ef32c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/omnilinerNamespace.js\":\"6baf42d4ddadea41\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/opfsPageScan.js\":\"074efed7d90f4eb5\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelClearance.js\":\"17a6a4b6522f5dd9\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelHistory.js\":\"b80edb4932dd7193\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelLanes.js\":\"87cc4ce105713e2d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelLayoutProjection.js\":\"a1fb5cab75a2fba1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelScrollAnchor.js\":\"3451d450f794e9b8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelUrlFlags.js\":\"cf55a6cd82068adb\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/platform.js\":\"b062cd2204934833\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/pluralize.js\":\"40934e7f37e5a020\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyCreation.js\":\"8a8ecd9b2ea29fad\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyNavigation.js\":\"1b38041226dcc32e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyValueContext.js\":\"43a81816fb57c50f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/react.js\":\"f96accd81cc934a0\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/relativeDate.js\":\"876ffc3259210d9d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/relativeTime.js\":\"2710c65713b282da\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/renderScope.js\":\"943763fd46e38f01\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/resolvedThenable.js\":\"08cf6830b2053b49\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/routing.js\":\"490747de55209561\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/safeMode.js\":\"645a556cc4d2f8af\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/scheduleIdle.js\":\"22ac137c7a36ac39\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/screenWakeLock.js\":\"dcce3a05e50c7e52\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/selection.js\":\"c44d50a1cfa22102\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/softKeyboardGrab.js\":\"4c10bf9424fc982e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/startupTimeline.js\":\"8c47127d6a37cc58\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/state.js\":\"3d6bc1e4217d96de\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/string.js\":\"6a23222ad13d32b8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/surfaceZoom.js\":\"956f634809c85ebe\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/time.js\":\"242c55fe8364e807\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/toast.js\":\"d1c765201d568234\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/toggleStore.js\":\"457be2209b6c9e06\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/untilStopped.js\":\"9b95ee11a50b2846\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/userActivity.js\":\"cb06ca15c39ccf4d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/viewTransition.js\":\"15f2dbee24d31e55\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/viewport.js\":\"4c3c45b7c2c9f14f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/webLock.js\":\"445520806f89ed92\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/workspaceRecovery.js\":\"0cca03fa9c50c9c8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/workspaceSnapshotStore.js\":\"baaa217ef9d0f1a3\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-compiler-runtime.js\":\"717fe876909fe51c\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-client.js\":\"53de90f6f1394c1a\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-server-edge.js\":\"2ae38b45501ba4fb\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-server.js\":\"d39a621c646d40ef\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-static-edge.js\":\"d39c6c6f7a0469a2\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-static.js\":\"07fb62e7bc91019c\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-test-utils.js\":\"3155e1747ec2aea0\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom.js\":\"f7dda5b9dd1b7a65\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-jsx-runtime.js\":\"01fd51ac433ffbe0\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react.js\":\"75d808219388b5ca\",\"/knowledge-medium/pr-preview/pr-1884/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1884/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1884/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
