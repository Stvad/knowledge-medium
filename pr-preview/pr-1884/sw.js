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
		buildId: "9cac3da71964-c80e45cb",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/\":\"74ffe630d160f6b5\",\"/knowledge-medium/pr-preview/pr-1884/index.html\":\"74ffe630d160f6b5\",\"/knowledge-medium/pr-preview/pr-1884/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1884/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1884/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1884/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1884/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/app.css\":\"d6b85c2ba5dde3ba\",\"/knowledge-medium/pr-preview/pr-1884/assets/FacadeVFS-CZaZubyA.js\":\"452ee8ccaf3632a7\",\"/knowledge-medium/pr-preview/pr-1884/assets/OPFSCoopSyncVFS-DRXZrIUY.js\":\"b8ea73ac2df32151\",\"/knowledge-medium/pr-preview/pr-1884/assets/OPFSWriteAheadVFS-B-yZHJr3.js\":\"b0a02404a97ed504\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-BS2QWGnH.js\":\"0517618f12db4340\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-async-BPFsksgB.js\":\"17f6a60a8fd23bf0\",\"/knowledge-medium/pr-preview/pr-1884/assets/worker-9LcMb2Hh.js\":\"aef896ed4be63d75\",\"/knowledge-medium/pr-preview/pr-1884/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1884/chunks/app-DXHTLgoZ.js\":\"5ed5d396bfa916c4\",\"/knowledge-medium/pr-preview/pr-1884/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1884/index.js\":\"baa1c2298fe456bb\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1884/assets/AccessHandlePoolVFS-EiQkhSYC.js\":\"fd1ee9ae005ac7f1\",\"/knowledge-medium/pr-preview/pr-1884/assets/IDBBatchAtomicVFS-ByKXhiwu.js\":\"d87443cd047eff78\",\"/knowledge-medium/pr-preview/pr-1884/assets/MemoryVFS-C994MB5Q.js\":\"b6c1d748ad1ed335\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-DpNyrni7.js\":\"14aa37c3d28ad0fa\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-async-l6kr3bLo.js\":\"31eed6ab5c5837a9\",\"/knowledge-medium/pr-preview/pr-1884/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1884/chunks/AccessHandlePoolVFS-d2v2_H64.js\":\"f6c4c167ec9413af\",\"/knowledge-medium/pr-preview/pr-1884/chunks/FacadeVFS-CfM4h4b-.js\":\"f31a7790202f9067\",\"/knowledge-medium/pr-preview/pr-1884/chunks/IDBBatchAtomicVFS-BkfbUAzH.js\":\"ef47267a249e0c16\",\"/knowledge-medium/pr-preview/pr-1884/chunks/MemoryVFS-DRg35wyr.js\":\"9878151d0f624a26\",\"/knowledge-medium/pr-preview/pr-1884/chunks/OPFSCoopSyncVFS-qiQhBank.js\":\"b49d6a3ce8346f09\",\"/knowledge-medium/pr-preview/pr-1884/chunks/OPFSWriteAheadVFS-BRU28DeP.js\":\"e6db2ab81a36b7b8\",\"/knowledge-medium/pr-preview/pr-1884/chunks/Preview-Ck6Azzim.js\":\"dd2c77a59e87b9e4\",\"/knowledge-medium/pr-preview/pr-1884/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1884/chunks/card-BX7EPVIT.js\":\"134dd86a013e58ea\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-C8391k-J.js\":\"c31498f5e5649887\",\"/knowledge-medium/pr-preview/pr-1884/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1884/chunks/mc-wa-sqlite-DFyKaaxw.js\":\"b99c56c32a3d3a91\",\"/knowledge-medium/pr-preview/pr-1884/chunks/mc-wa-sqlite-async-DDdztWG6.js\":\"4f4dac2e549d9d9d\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-BiJru54g.js\":\"4aed9e1100101a51\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-CYxLw6-A.js\":\"ad881cb2f0ca73ca\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-CxVe4R1D.js\":\"2625a4bc3a7370c3\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-DgRwzNoX.js\":\"0dd653f7634580e2\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-Dne3hQO_.js\":\"351633ecf00c22c7\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-PvnnMEq9.js\":\"ead457de817c6746\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-bHxdkD1M.js\":\"d36735d1911be259\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server-legacy.browser.production-SRBdTNC1.js\":\"3de3b348baddfc28\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server.browser.production-CHEGsvGZ.js\":\"0e55b413a8bc9136\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server.edge.production-DdZvKrGf.js\":\"f822cc7bb6bb76f0\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-v28fVdH_.js\":\"933917a6a40bae38\",\"/knowledge-medium/pr-preview/pr-1884/chunks/server.browser-C3BqCcKM.js\":\"17585d49347d187c\",\"/knowledge-medium/pr-preview/pr-1884/chunks/textarea-CiBs8l9R.js\":\"ad92c1102fdc074f\",\"/knowledge-medium/pr-preview/pr-1884/chunks/ui-CRdprsiF.js\":\"4a6c6662ac5f5589\",\"/knowledge-medium/pr-preview/pr-1884/chunks/wa-sqlite-CcK4Ra1E.js\":\"249711f0f25cd8ab\",\"/knowledge-medium/pr-preview/pr-1884/chunks/wa-sqlite-async-C4pAzbgW.js\":\"4ac3bd399a8977e3\",\"/knowledge-medium/pr-preview/pr-1884/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1884/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1884/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1884/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1884/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1884/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1884/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1884/src/App.js\":\"047228b63ad885f1\",\"/knowledge-medium/pr-preview/pr-1884/src/appUpdate.js\":\"8c1504d57b3afcd9\",\"/knowledge-medium/pr-preview/pr-1884/src/appVersion.js\":\"28692a6f82ea9abb\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/initialLayout.js\":\"d999a7dc3d57e312\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/openWorkspaceData.js\":\"ffac8e56ccf0c7e6\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/resolveWorkspace.js\":\"34e7e0c5c62eb306\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/workspaceBootstrap.js\":\"0879bf5f1f293938\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockComponent.js\":\"7b226e245e086f71\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockCrumbs.js\":\"94b9ed5a99c3f6b4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockEditor.js\":\"dd9afd0ea07d58e1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockLoadingPlaceholder.js\":\"4fae18b23bb8d8d7\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockProperties.js\":\"55614c6eb3314e70\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockSearchPicker.js\":\"d0fa1de52f138206\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ConfirmBulkDeleteDialog.js\":\"ff3eb088acb6164e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/DividerHandle.js\":\"25a7e74b1c99dc4c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/DraftEditor.js\":\"b64031cca8656dd7\",\"/knowledge-medium/pr-preview/pr-1884/src/components/GutterPill.js\":\"db6ee574d94ff009\",\"/knowledge-medium/pr-preview/pr-1884/src/components/Header.js\":\"fd50bf6e2ef335ad\",\"/knowledge-medium/pr-preview/pr-1884/src/components/LazyBlockComponent.js\":\"4a4fd3192443cb8b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/Login.js\":\"7b1749907870f735\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ZoomableSurface.js\":\"e2365af0fe79a4ce\",\"/knowledge-medium/pr-preview/pr-1884/src/components/editModeKeepalive.js\":\"4b26a4cb512716ff\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyDisplay/PropertyDisplayScope.js\":\"78e0673b01b475b9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"df1d63a9a04b01a6\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/RefPropertyEditor.js\":\"5a3d7f4782eb6d49\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/RefTargetTypePicker.js\":\"21e1fdae022073bd\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/SelectPropertyEditor.js\":\"70d9e96b457435e0\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/TypesPropertyEditor.js\":\"354691c7e60c1668\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/defaults.js\":\"ae4ef8a944fb1955\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/kernelValuePresets.js\":\"a9375aaa9696b08f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/selectablePresets.js\":\"ecea5194656b1bfa\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/typesPropertyUi.js\":\"a38dfb5aa765dbcc\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/AddPropertyForm.js\":\"f72d1bd100e53eaf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/PropertyPicker.js\":\"cf609c4f78d0a1b8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/PropertyRow.js\":\"f7c4574e6199e31b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/Rows.js\":\"fd5694c0f59f0408\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/actions.js\":\"b08a71123128bc34\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/declarationOnly.js\":\"096a2734ac0cadf4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/layout.js\":\"11bb66b11f83bfa7\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/model.js\":\"0e5824d81cea3838\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/shapeUi.js\":\"5300f1fb2803e937\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/shapes.js\":\"5bbf4fd9ea815504\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b63a805cdcdbed48\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/visibility.js\":\"bbfea0ee650c2805\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanelSections.js\":\"90fee66d77d5e6aa\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockEmbed.js\":\"5d65a5d2647fa2d4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockLink.js\":\"b3028f4f713d5ce3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockRef.js\":\"71fbde68592df9f1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/CompactReferenceLink.js\":\"84114233d09790b4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/ReferenceLink.js\":\"a3f9adac37f8ba73\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/cycleGuard.js\":\"fa7e7e2f99f86f0f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/cycleGuardContext.js\":\"d7d4d8cfbab166cd\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/linkInteraction.js\":\"dd81d3f75c9c9850\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/referenceLayout.js\":\"9d949ccb2c8866fe\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/useBlockRefAncestors.js\":\"859bb6c893de4a80\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockGutter.js\":\"593bca37d478d0b8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockInfoDialog.js\":\"fb5b583728719ff5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockReadText.js\":\"ede67a582d363826\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockTypeBlockRenderer.js\":\"cca18c5cf6016018\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BulletHoverCard.js\":\"3dda513f965d883b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/CodeMirrorContentRenderer.js\":\"5407b21f1223514c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"36d23870c81a8988\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/ColumnResizeHandles.js\":\"6a9d6cb9088b5411\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c8ff0350f398f952\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/DefaultBlockRenderer.js\":\"3dd22a79c954b6b3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/LayoutRenderer.js\":\"9ab1ef5bc6da28db\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/MarkdownContentRenderer.js\":\"4116c2fab5d5f84b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/MissingDataRenderer.js\":\"6d4e43d2bc867c95\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/PanelRenderer.js\":\"0ea566fb2905a940\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/PropertySchemaBlockRenderer.js\":\"1f2a317a0e5209d4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/TopLevelRenderer.js\":\"ea4e77a8a2a99cdc\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/blockGutterMode.js\":\"4c906dd561543ebb\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/blockTitleText.js\":\"8d3e76461e7a127f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/fieldCreationKeydown.js\":\"fe25b64cfee41877\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/layoutRootContext.js\":\"cefdf1090ee0c7f3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/typeChip/TypeChip.js\":\"4dc863a85ddf163d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/typeChip/chipStyle.js\":\"2e2319ceeed99ff3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/anchored-floating.js\":\"05dff6f3cc0d047e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/button.js\":\"f96b1758845a1e2b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/card.js\":\"dec633816ccd6102\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/checkbox.js\":\"1fd27aceee832667\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/collapsible.js\":\"62644b72307fcbd8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/command.js\":\"6027b58139c50cdd\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/context-menu.js\":\"de14bd80e2594b5f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/dialog.js\":\"eafabd911f7c1bc5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/dropdown-menu.js\":\"795980020c196272\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/floating-listbox.js\":\"17c22140b85ed342\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/index.js\":\"6d470ef40e1e314a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/input.js\":\"9ae3cca8f6a890a9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/kbd.js\":\"67f9a540ee977eab\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/label.js\":\"8ea81de816dcf7bd\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/textarea.js\":\"e9b3639b043f52e3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/useEditModeYieldKeepalive.js\":\"1c1a43ee7d03ba50\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/BootFallback.js\":\"36ea03446d6beab9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/FocusedRowLazyMount.js\":\"a2abba82143ee63d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/LazyViewportMount.js\":\"8b8a22c529c6f6fe\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/LocalDbCorruptionFallback.js\":\"28544c04921f119e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/error.js\":\"8f512f0c624ff3bf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/lazyMountRegistry.js\":\"810a321642237ccb\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/suspense.js\":\"59566097cec3099b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/CreateWorkspaceDialog.js\":\"e7f1dd6b90250baf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/PendingInvitations.js\":\"d75d1341b194c983\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/SyncProgress.js\":\"8638cb9c416de8c2\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/UnlockProgress.js\":\"3475dd99b981e768\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceKeyGate.js\":\"a17fe3a58f13529e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSettingsDialog.js\":\"11b849f151720625\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSwitcher.js\":\"9a4b29eb150f2b76\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSyncGate.js\":\"e2756306786b14a1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/ConversionFlow.js\":\"5651f45e8d994ed4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/ConversionFlowHost.js\":\"b0e3b5be8357d755\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/EncryptionSection.js\":\"130e53578fa5d8e1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/attachmentPrompts.js\":\"df00a0675f00d3b8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/bundleFolderPrompts.js\":\"66f116ba5dceb0ff\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/conversionFlowDeps.js\":\"4f7b313e48134bd0\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/conversionFlowStore.js\":\"666454ed1975bfe8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/flowUi.js\":\"2a2475e5406e9399\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/useConversionRun.js\":\"a8ecb32efd4ef605\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/keyUi.js\":\"22b0c618b618694e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/useCloseOnKeyLoss.js\":\"60d609394253e3aa\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/useCloseOnServerE2ee.js\":\"c3227aae995567c9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/workspaceUnlocked.js\":\"43d6435a20f5c6eb\",\"/knowledge-medium/pr-preview/pr-1884/src/context/backgroundSubtree.js\":\"3ae29ea2d592a6d4\",\"/knowledge-medium/pr-preview/pr-1884/src/context/block.js\":\"6ff33eae02d8d866\",\"/knowledge-medium/pr-preview/pr-1884/src/context/layoutWsContext.js\":\"9328859ff81f8da7\",\"/knowledge-medium/pr-preview/pr-1884/src/context/propertyDisplay.js\":\"d225487f56689e8d\",\"/knowledge-medium/pr-preview/pr-1884/src/context/repo.js\":\"5a391672c5f2c4c2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/aliasClaim.js\":\"ffeb24cb97671405\",\"/knowledge-medium/pr-preview/pr-1884/src/data/aliasSeatNamespace.js\":\"acd42de333b1042e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/blockData.js\":\"bf54df40b1a5fff5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/blockType.js\":\"2173efb718d8cbc8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/changeScope.js\":\"ee9f6e6cefaca404\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/codecs.js\":\"0a5947baad2cf719\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/derivedData.js\":\"9fcd3237b13886a8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/errors.js\":\"89743b6fec7f6753\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/events.js\":\"d98815658c32e270\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/handle.js\":\"809bff60344ac7fd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/index.js\":\"2b7d425a49fef806\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/mutator.js\":\"c6480ba6a13a4408\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/processor.js\":\"7aae5027439b43ad\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/propertySchema.js\":\"83babccb2c70be53\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/query.js\":\"42140906b82baf6f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/sameTxProcessor.js\":\"8cee7dc87b171143\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/schema.js\":\"809bff60344ac7fd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/tx.js\":\"809bff60344ac7fd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/typedBlockQuery.js\":\"0caabb35b511ae8c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/user.js\":\"e2e25c9120e4bb7b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/valuePresetCore.js\":\"0c984db831cf65cd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/valuePresets.js\":\"04301c921b5a9b88\",\"/knowledge-medium/pr-preview/pr-1884/src/data/attachmentCleanerIOVerb.js\":\"1944d89655cdf679\",\"/knowledge-medium/pr-preview/pr-1884/src/data/block.js\":\"f04cc748e9cca979\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockCache.js\":\"3c624b4b1e3a4270\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockId.js\":\"88e53c8a80e7bf7e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockLiveness.js\":\"03adf6ec5f656a4e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockMerge.js\":\"3ce1fac57bf0e937\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockSchema.js\":\"edb845ca1541136e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockTypeLookup.js\":\"25a54e2595c51425\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockTypes.js\":\"ac3af82a87ba4537\",\"/knowledge-medium/pr-preview/pr-1884/src/data/childrenView.js\":\"be8eb7ee66f6e258\",\"/knowledge-medium/pr-preview/pr-1884/src/data/clientContext.js\":\"5a0f7b07e0ffc486\",\"/knowledge-medium/pr-preview/pr-1884/src/data/dbFileSiblings.js\":\"7f02f757d16bb63a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/definitionSeeds.js\":\"75a120ac170edd5d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/derivedIds.js\":\"45254702eeb17d6d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/drawnSubtree.js\":\"1ccb16ad4828b9f5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/facetBridge.js\":\"c181a6a41afbd339\",\"/knowledge-medium/pr-preview/pr-1884/src/data/facets.js\":\"bde9f114ce21abfa\",\"/knowledge-medium/pr-preview/pr-1884/src/data/globalState.js\":\"220be9225969c781\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/aliasClaimRederiveProcessor.js\":\"1e361fc37c4510cb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/ancestorBatch.js\":\"c28e21fde3502c2a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/blockTypeTypeifyProcessor.js\":\"8f429226b90a35cd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/clientSchema.js\":\"71a7ccb2a0a3848a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/commitPipeline.js\":\"51876e8181e09184\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/devAssertions.js\":\"58ebc4c5a7acc3f5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/firstSync.js\":\"3aa22855982e16ee\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/freshInitialLoad.js\":\"3a8d37363d472b68\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/graphBackfillClaim.js\":\"04b4c97f9fbb1fba\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/handleStore.js\":\"166d38d783db1d2a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/idleMarkerJobs.js\":\"5ac781f5e964907e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/initialDownload.js\":\"d99b4107722d376d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/initializeClientDatabase.js\":\"ebfafa4ee631b55d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/jsonCanonical.js\":\"baac9e1d7a7516cd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelInvalidation.js\":\"69b511f042b47352\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelProcessors.js\":\"2d3f5fd900243bd5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelQueries.js\":\"a55099556eea0ce5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/mergeTypeMembershipProcessor.js\":\"0197f2237d1b2c9a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/normalizeReferencesProcessor.js\":\"0bb9b78795c48a57\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/poolInstrumentation.js\":\"8dba858748cc4781\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/processorRunner.js\":\"7e7487632ae474ea\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyCellBackfill.js\":\"8a21720cb56df9e3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyChildMint.js\":\"166794b58275aae0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyChildrenProcessor.js\":\"1fe5945b6a20c99f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyDefinitionChangeProcessor.js\":\"cfa370e204fdd475\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyDefinitionSynthesis.js\":\"2c8e4e4a0b9b3120\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyKeyScan.js\":\"b63b4dc2ab2380b5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertySchemaResolution.js\":\"fb3b54bfa75aeb00\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyValueEdits.js\":\"93fd7822ea8e0445\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/raiseProtocol.js\":\"9fd337b2d23a2df2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/readBatch.js\":\"d5d44d28bba43ffd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/refProjection.js\":\"796eaff966f54dc4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/referenceTargetLookups.js\":\"3a8ba859ae10f857\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/referenceTargetProcessor.js\":\"a9ba2ea648773bca\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/replayMerge.js\":\"86807a603538cb3a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/sqlBinds.js\":\"d18c7751b0802f26\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6ed16bd4eff17c7f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/arrivalProcessors.js\":\"2ab708df423b07c5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/invalidate.js\":\"b5f4b03fa1155cfd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/materialize.js\":\"a6438a57baa34e3c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/observer.js\":\"4beae13723477f37\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/reconcile.js\":\"b8b7dde6c129ca65\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/timingMetrics.js\":\"633bd1160379f7e8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/treeQueries.js\":\"6ee6db2cd30452e1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/txEngine.js\":\"4695c5d8dd8ed60e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/txSnapshots.js\":\"aee00badb20a8885\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/typedBlockQuery.js\":\"7b9a5f102584d7af\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/undoManager.js\":\"aae1a6cab93d3ece\",\"/knowledge-medium/pr-preview/pr-1884/src/data/invalidation.js\":\"4937a0730fdf8452\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelDataExtension.js\":\"db67910b0e91ffd6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelPage.js\":\"c66670da4e554393\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelValuePresetCores.js\":\"1f5ebd78a55eadf5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbCorruptionSignal.js\":\"2caa4e6519956cc1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbStorage.js\":\"a07873dc9f68aeb7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbVfs.js\":\"4fa40ea11a53882c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localSchema.js\":\"af9cee8a09dad7f5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/maintenance.js\":\"aa1cec68c2d0e2bc\",\"/knowledge-medium/pr-preview/pr-1884/src/data/mergeProperties.js\":\"6ed1e3e1488785ce\",\"/knowledge-medium/pr-preview/pr-1884/src/data/metricsConsoleHook.js\":\"a2650e9564ce17be\",\"/knowledge-medium/pr-preview/pr-1884/src/data/migrationsPage.js\":\"23cb9f3d01b8819c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/mutators.js\":\"6c184663418ba804\",\"/knowledge-medium/pr-preview/pr-1884/src/data/orderKey.js\":\"d6aeef806a8c5217\",\"/knowledge-medium/pr-preview/pr-1884/src/data/orderKeyPlacement.js\":\"e4ab99b054f6900e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/outlineSurface.js\":\"39937886a5f837b1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pendingEditorContent.js\":\"ff9f31356fd07fff\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pendingUploadsSql.js\":\"acf0e2343a1376b0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pluginStateExtensions.js\":\"4dcac6b8f57e8e31\",\"/knowledge-medium/pr-preview/pr-1884/src/data/powerSyncLogger.js\":\"53b0c03bffe9a802\",\"/knowledge-medium/pr-preview/pr-1884/src/data/projectorRuntime.js\":\"023137982db4901f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/properties.js\":\"97ca1a8b849e5d05\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertiesPage.js\":\"65098fc29ad5bc85\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyChildren.js\":\"fc8eb1cc5cfccae5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionFanout.js\":\"c123cdd910da5253\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionMetadata.js\":\"9e56b9b311795bc6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionRegistry.js\":\"369d02a38a48c4ab\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDisplayMode.js\":\"7da9dcf9db35dd56\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyRowCreation.js\":\"8f74069c4fd253a5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertySchemaCreation.js\":\"a47a2b2150bd3177\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertySeeds.js\":\"136d15a43fa37146\",\"/knowledge-medium/pr-preview/pr-1884/src/data/recentsPage.js\":\"55d02ab1b99ca79e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/refTargetComparableProperty.js\":\"779bbe21c30a47c0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/referenceBlock.js\":\"e8ecdd182d2ea51b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/rejectedUploads.js\":\"ef1f7f90cf0ab37a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/releasePowerSyncConnection.js\":\"cbdd6c10b0c695b3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/repo.js\":\"f1c18d6aeb9a0cb6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/repoProvider.js\":\"d6104349ffdbac91\",\"/knowledge-medium/pr-preview/pr-1884/src/data/rowProperty.js\":\"af5256ca63a17929\",\"/knowledge-medium/pr-preview/pr-1884/src/data/searchFilter.js\":\"eab8edd506ceb57b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/seedIdentityLedger.js\":\"ac84d68859cb0f2d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/stateBlocks.js\":\"efd201afab9ef0c8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/structuralEditPolicy.js\":\"f7f8155261790490\",\"/knowledge-medium/pr-preview/pr-1884/src/data/structuralInsert.js\":\"4b0ba80b2eab825c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/subtreeDelete.js\":\"4f6583ec2cd3330a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncStreamLock.js\":\"1dbc0f2ba47abef8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncedTableSqlRecognizer.js\":\"2cdd37dfda303cec\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncedTableWriteGuard.js\":\"ec207dd2799cff6d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/targets.js\":\"4d843c73abcce5e6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeColors.js\":\"d20918f02d8962de\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeDefinitionMetadata.js\":\"1f38bebfd1fbbbde\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeDefinitionRegistry.js\":\"611888b42e3d6bcb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeExtraction.js\":\"273a344bfdf8a77b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeInitialValues.js\":\"5ffb313158f01a4a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typePropertyGroups.js\":\"7e026b3b5d9b4476\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeSeeds.js\":\"972bb56b13258dc7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeTagger.js\":\"f09a38f215daa5dc\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typedRecords.js\":\"84193186b43413fa\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typesPage.js\":\"f834cd327c96f43c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userPrefs.js\":\"9d22da8177d65e97\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userSchemasService.js\":\"d7c9a14158f7695e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userTypesService.js\":\"da5fadfe2a1ec38a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/valuePresetRegistry.js\":\"6b498fe968ca9f23\",\"/knowledge-medium/pr-preview/pr-1884/src/data/visibleChildren.js\":\"e4e4cbf0c0df93ff\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceConversion.js\":\"7e85355680a0daab\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceFirstSync.js\":\"c44fc85bee43d9f1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceIdNamespace.js\":\"4b7ef0855fb2b5bf\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceSchema.js\":\"82cc62aa11228fa3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaces.js\":\"89675a5433f42ae3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/writeAheadLog.js\":\"a4df32386988f11a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/BlockPasteShellDecorator.js\":\"3c6cf7ebc5e33756\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/atTrigger.js\":\"6976243fb6376dad\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/autocomplete.js\":\"68ffc620c8d09f3b\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/codeMirrorExtensions.js\":\"fceac417e8ee7ba2\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/contentFlush.js\":\"b58272df00f11a1b\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/defaultInteractions.js\":\"76b16deb1f7afc19\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/editSettleSignal.js\":\"3b58a2df8ae09223\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/insertImage.js\":\"45817932c67f9b61\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/referenceCompletionRange.js\":\"932b06269fa80778\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/referenceTargetTypes.js\":\"15ad5a50b6af4423\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/syntaxContext.js\":\"bbe8ac697af881d4\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/triggerMatch.js\":\"ce69f68735faa1ad\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/AppRuntimeProvider.js\":\"b96177e348bd597d\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/BlockFocusShellDecorator.js\":\"81820ec2a0ce45ef\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/ExtensionRenderBoundary.js\":\"3d7e776022c2dbbf\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/PanelContentRecovery.js\":\"dc6a6f1a7a11ea39\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/apiCatalog.js\":\"5cbd38f2ea80d52e\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/approveExtensionHere.js\":\"c96a7e9aaad5b896\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/armedCutAppMount.js\":\"dcd18dfd38af27ea\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/batchableKeyedStore.js\":\"118ca38235afb498\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/blockInteraction.js\":\"4cf07815127c186a\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/blockSelectionAction.js\":\"65594feedf308305\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/compileExtensionModule.js\":\"f53a717fad1d7b7f\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/compiledModuleCache.js\":\"d020d24959da5290\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/continuousGestures.js\":\"0b89e818d009d06c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/core.js\":\"75e9f9a4310b7bda\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/defaultRenderers.js\":\"dbfb3e9da5552dfa\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/definitionFanoutAppMount.js\":\"c82c5cd15ca07e46\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dialogAppMount.js\":\"a7ebe0d4047cd7bd\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dynamicExtensionSeeds.js\":\"4b4a78facdfce023\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dynamicExtensions.js\":\"67fb0ae536f35720\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/exampleExtensions.js\":\"d154624cb027a023\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionApprovalStatus.js\":\"8bda44f4801b76d6\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLoadErrorToast.js\":\"c995808ad7a17dfb\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLoadErrors.js\":\"196e9176f81f26e8\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLookup.js\":\"a2ce047627b99b20\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionToggles.js\":\"26747f2ce299f5d5\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionUtilitiesCss.js\":\"2d3e8b1ef43d7f15\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/kernelPageDeletionGuard.js\":\"4b0a2a259ead6e32\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/liveRuntime.js\":\"f733421fe93549c0\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/openExtensionsSettings.js\":\"8ffb393b9760bdf2\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/overridesCache.js\":\"e8f0973aa6fe96f6\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/pluginIds.js\":\"825231c95694d858\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/processorRejectionToast.js\":\"453cd868c88c1612\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/runtimeActions.js\":\"0830b5880dd43b9f\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/runtimeContext.js\":\"ee4ac43b603a9f2d\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/staticAppExtensions.js\":\"2a8e7a68e27981c6\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/staticDataExtensions.js\":\"2c006d0eb3f6507f\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/toastAppMount.js\":\"73ca9c561f2bcfaf\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/useOverrides.js\":\"ccbe6351104a11bd\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/useShortcutSurfaceActivations.js\":\"0ee8975f4a31298f\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/discoverToggleTree.js\":\"44fb4b6b65c6e242\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/facet.js\":\"f0a7d75bdc501f06\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/resolveAppRuntime.js\":\"a7383e454a7a4a45\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/runtimeEvents.js\":\"8310d29459bded43\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/togglable.js\":\"e4c03a40079e3726\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/variantFacet.js\":\"dc6571005dd77209\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/verbFacet.js\":\"c21b49ff3fdd3f61\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/block.js\":\"aa1c19f2bcd3f5f7\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/focusedChild.js\":\"15d01e3d3d4618c4\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/propertySchemas.js\":\"086b19796cda43fc\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/typeRegistry.js\":\"fb41f75418285768\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useAncestorCrumbs.js\":\"64f00a94207a63a2\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useAutocompleteListbox.js\":\"01706bce91cbc575\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useDebouncedSearch.js\":\"29f33b2b9f3d0626\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useDebouncedValue.js\":\"e4ceb90be0e612c2\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useFacetValue.js\":\"db22e67ce98c8bd4\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useIsFocalRender.js\":\"8e9c4ebe7341e7a5\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useIsReadOnly.js\":\"a86b50482d0e2dbf\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useMaterializeBacklog.js\":\"db1ee7e0fa3ff30a\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useMinuteClock.js\":\"360ed8dc7f3202fa\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/usePanelLayoutProjection.js\":\"8f6f1f27ba5af91c\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/usePendingInvitations.js\":\"b04df170a19ce796\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useRendererRegistry.js\":\"64bb0418465a9d00\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useRetainedFieldRows.js\":\"a192740c6a48b685\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useWorkspaces.js\":\"54cdec1d5208a8a6\",\"/knowledge-medium/pr-preview/pr-1884/src/lib/utils.js\":\"2ddfc927199e576a\",\"/knowledge-medium/pr-preview/pr-1884/src/main.js\":\"dcabbd47f1e97ca1\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/MarkdownImage.js\":\"32febd0e13c1f0a0\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/blockSeparators.js\":\"220fe1ee1557ff4a\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/context.js\":\"7c5c4fc10e02cc35\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/defaultMarkdownExtension.js\":\"9834bb44c4fc85df\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/extensions.js\":\"181e92fd8102ff28\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/renderMarkdownHtml.js\":\"9dd1768d885bd9fc\",\"/knowledge-medium/pr-preview/pr-1884/src/minimal-editor.js\":\"4a708c2631d947ed\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/armedCut.js\":\"ee74423d0cc846a7\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/captureMediaVerb.js\":\"7ce38e6eeba33490\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/clipboard.js\":\"656c1245d4b9c29e\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/decision.js\":\"a9eb6b7565330cab\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/operations.js\":\"6dba37255f426713\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/account-header/AccountHeaderItem.js\":\"e58d8145688c1c00\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/account-header/index.js\":\"c412af8c17c57e9e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"09a7f5fad5ec8f5b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/askAgent.js\":\"c484f9d1947e11ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/askedStore.js\":\"3eaf4725820b5193\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"40f7c5db36593637\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/chipState.js\":\"a3b8067b73cec1e2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3422d0b78bc0c78c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/index.js\":\"c58b41f2455c026b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"849a28b1a63c8003\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/schema.js\":\"c6cc5ce25f348c3c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/AgentTokensDialog.js\":\"86fbd350c1fcc953\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2e2d3548a5e6b28b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/addMedia.js\":\"fc2c0acb83670a67\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/backlinks.js\":\"01a8c903e05444ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/block.js\":\"4437b906b1cdf70f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/context.js\":\"8d316fbf6ad9250c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d9875d1d7370b430\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/index.js\":\"5ae61ed5517a2b29\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/outline.js\":\"e9a3085a5b7116bf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/properties.js\":\"3189d27ba2d03e64\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/refs.js\":\"a5e853f3b07a1738\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b8a954b0a668c614\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/search.js\":\"7d86d7dd5994843b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/shared.js\":\"53cfefce8ad88aa3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"790415b70c6ebcc3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/text.js\":\"bb6dd5461808ca3d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentWrites.js\":\"8314fbf8441a6329\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/authoringCatalog.js\":\"38e0a6e4b665175d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/blockRefTargets.js\":\"036adb1bcb7dfd59\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/bridge.js\":\"9ae77d783704f26b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/bridgeLoop.js\":\"4a4af56c887c0045\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/changeHistory.js\":\"00666587d0263158\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/commands.js\":\"ed50f36873283f52\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/commentsCommands.js\":\"7a7538d3ca6998ed\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dataExtension.js\":\"31bc54162428de3e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dataModelGuide.js\":\"3512b0dc40785635\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dayPropertyInputs.js\":\"b8c42e2ccac84cca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/describeRuntime.js\":\"b33dfc1a569d2d74\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/extensionLint.js\":\"68ddcbfc920310b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/grainAudit.js\":\"1e365f16da11f3d8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/healthCommand.js\":\"3e374887ce1655b5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/index.js\":\"27315870b959aafe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/presetIdentity.js\":\"4d22236335797458\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"62554eb2f3127d0d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/readMedia.js\":\"2a7bb888f8280386\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/schema.js\":\"4b6cf9657865604f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/serialization.js\":\"88859a6add9498dc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/targets.js\":\"e3fddb08943c4b4d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/tokens.js\":\"45b8f0b7acce7a50\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/watchEvents.js\":\"11e340e3aac6e2af\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/workspaceGuard.js\":\"f3f3618b858acef2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/writeCommands.js\":\"402ec7e50ad47bf4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/AliasCollisionToast.js\":\"b2a0a2fcb2072887\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/DuplicateNameBanner.js\":\"a92cddac3bd0fcdf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/collisionMerge.js\":\"b26e745df45d3237\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/dataExtension.js\":\"83d8ca3289fdc910\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/index.js\":\"24c88c42407834a4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/mergeCollisionAction.js\":\"2f8392327ffb6f25\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/pageStyling.js\":\"8849ded9901c6283\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/rejectionToast.js\":\"82cee40e8557240e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/syncProcessor.js\":\"6148b3aad3174d40\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/actions.js\":\"1407cc219d107875\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/addComment.js\":\"b7e273b11335303c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/anchor.js\":\"a34a3dcbf168a70f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/anchorState.js\":\"1eac17c8bfe02c5f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/commentLinks.js\":\"96de68846520e934\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/confirmThreadDeletion.js\":\"8f844fa91dca4d0c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/container.js\":\"a66288031bf40de3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/dataExtension.js\":\"ae1793d57680dd21\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/deleteComment.js\":\"87096be437a128c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/highlights.js\":\"42f2ea11a0d0ea51\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/index.js\":\"978a9d559a892512\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/linkedCommentsPill.js\":\"d504fdf53b3cc9b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/margin.js\":\"e14f78eddbe6a55b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/marginAnchorLinks.js\":\"54dc92f5bbd29e94\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/marginSchema.js\":\"bf130e0addc11e99\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/newComment.js\":\"c1e20f9996c1d141\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/ownThreadPicker.js\":\"36bc17d816c2c06a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/placement.js\":\"c5beac9b50e02d06\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/queries.js\":\"d775c3a334478881\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotePosition.js\":\"43faa1ad7a82f051\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotedIn.js\":\"5a7f8e7436c5d21f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotedRange.js\":\"37a713df9f68de1a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/rangeRefs.js\":\"b3eef924e142af2c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readHighlights.js\":\"698d26b8acc492e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readSelection.js\":\"c3c985e71c2f1d97\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readSelectionUi.js\":\"9f73fb3c5bade2c3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/reanchor.js\":\"1335121ed3fe97aa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/schema.js\":\"e44f9d90a98fc3cb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/scope.js\":\"a9e6c212c1127b7f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/scopeThreads.js\":\"ec6f685636d7c723\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/splitRetarget.js\":\"1ace17261fec4932\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/suggestionCard.js\":\"fbd722e3fc839c84\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/suggestions.js\":\"2fdedc31d9dc4a85\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/summaries.js\":\"ccd255419d552183\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/summaryBatch.js\":\"fb0c06b5c2fd69a5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/surface.js\":\"f4732ed4cd385f9a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/threadNavigation.js\":\"d56cdf1371a50d8b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/threads.js\":\"ad0f1f02a93cd615\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/ui.js\":\"6ddbd1174f456b0d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/uiStore.js\":\"c7553979dd813cbc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-intents/appIntents.js\":\"3b82e37a1f1d84a6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-intents/index.js\":\"25d0ab2eec669f37\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-update-prompt/index.js\":\"51ad32b5eb23f823\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-update-prompt/status.js\":\"6f14e6b52c6f495d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7228c5cebf059805\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaBlockRenderer.js\":\"23b4b9169881f5cb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaDownLaneReplicator.js\":\"26073c92f76671a8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaUploadReconciler.js\":\"dccbfce7e1c1f606\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetDownLane.js\":\"af7d03564b53b885\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetResolver.js\":\"6acfb80580c76d51\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetUpload.js\":\"bec4cc178b10a501\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/attachmentCleanerIO.js\":\"70a4bbfaeb3f2b99\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/supabaseAuditIO.js\":\"71c026886db65522\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/blobStore.js\":\"9d1ec74d5f4d20ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/browserMedia.js\":\"12d9af7dde566c8c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/byteStore.js\":\"7b7734f3cfa5e908\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/cleanerIO.js\":\"0e214a61890d1202\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/cleanupAttachments.js\":\"5efe26d8ebdb8a4a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/dataExtension.js\":\"91039a7cedc37467\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/downLane.js\":\"f1c1a981b6ffde61\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/index.js\":\"bb03ef85b09cddf9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/insertImageContribution.js\":\"2753f4d0126014ac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/laneArming.js\":\"6e7bea6f276ff331\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/laneLock.js\":\"9e312a541a396342\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaBlock.js\":\"c3a17511df261522\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaCapture.js\":\"a651466494b34046\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaLanes.js\":\"54ff97cb20614c32\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaViewers.js\":\"0bb1eafe7f8daa9c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaViewersFacet.js\":\"27859169f7b1aab9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/pasteCapture.js\":\"6b748c8c5d2b57bc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/resolver.js\":\"82eeea30b068b764\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/retryUploadsAction.js\":\"c033e9e293624d65\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/storagePaths.js\":\"378dedfdc61494c3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadDrain.js\":\"ee0e6882548f56e5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadLaneStatus.js\":\"15c57225507269dd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadReconcile.js\":\"e012957438de4cb6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadRecovery.js\":\"02729373f9821b6e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadStore.js\":\"b65722b1e8b80129\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/useAssetObjectUrl.js\":\"f9204b8751362c61\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"37802504f0183cd8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/BacklinksViewSection.js\":\"97e9d93935e7e723\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/facet.js\":\"ac4ae34afd65572f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/index.js\":\"23a473fb0ba8d633\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/prop.js\":\"778cda84f1af3c75\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BacklinkFilters.js\":\"8c3431a6e36695b5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"2d3110c27d50beb0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BlockEntry.js\":\"3118751505652e06\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/LinkedReferences.js\":\"6237950d28776c28\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"fb3e1f396888f9da\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/dailyNoteDefaults.js\":\"0fd57c5a8583e314\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/dataExtension.js\":\"98266bffd0069b13\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/edgeExclusions.js\":\"1ba52887591ec78a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/filterProperty.js\":\"d6e8f70dd7752d02\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/index.js\":\"658730808d8e4e1e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"812bf2e8b1f0730c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/applies.js\":\"e420e3838caaf0f4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/countQuery.js\":\"9890f4b417cdf64a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/expansionStore.js\":\"852a18774d435802\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/index.js\":\"ecfbf9af1437845f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"18e980b662a39eb9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/presentationInvalidation.js\":\"bdd109b94617413c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/propertyEditorOverride.js\":\"fd4fb65cffd6ff84\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/propertyFilter.js\":\"e438aab510624d95\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/query.js\":\"39aa7e27065dbccf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/resolveFilter.js\":\"0e3a603152858df6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/sourceBatch.js\":\"2d2359f6bf560001\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/sources.js\":\"cebd0897e6918177\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/useBacklinks.js\":\"05d836d0f06c8432\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"6733c43bc6783882\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/BirthdayCelebration.js\":\"46ee7116a876dbd2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/BirthdayOverlay.js\":\"ee29413e2348d80a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/gate.js\":\"76fb29b08ed3363c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/index.js\":\"3e2682c874c345e6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/wolfTheme.js\":\"1596c58a7851ec9b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/BlockDragLayer.js\":\"dbe2ad17b4a674cb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/dragController.js\":\"fc6bb6cc5b36598c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/dropTarget.js\":\"4f7179adb639ea93\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/index.js\":\"1088d10c405c4d8b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/projection.js\":\"faa8bb090a91c927\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-info/BlockMetaCard.js\":\"fda4f7346f6475a4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-info/index.js\":\"eb8e49d577180f9e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/AddTagDialog.js\":\"a186905047cd405d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6f5cf6d793143ffb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/TagNameIssueHint.js\":\"2002303254b1d920\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/addTagAction.js\":\"b2e8af43049cddec\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/appendTag.js\":\"fc84091af6048182\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/config.js\":\"d51442c4c51e1ac7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/dataExtension.js\":\"12fe6cd06a69cdb9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/index.js\":\"da580e0b80b266a8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/propertyEditorOverride.js\":\"215cc868a8a04d3c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/BreadcrumbList.js\":\"1d8c279db1aeb847\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"630280e5606e0198\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c0641fb619e638a4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"3072b3a2cb09ecc4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d750136a8a5e73c9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/index.js\":\"a47a0120b6fd3d80\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"492fa2241278359a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/CharacterCountItem.js\":\"2dd8f6b4dc7da848\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f7711d2e1e4606e6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/actions.js\":\"ae36dbb0843a2321\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/blockType.js\":\"91a5a409857725a5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/charCount.js\":\"4f21687b5967074b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/dataExtension.js\":\"8f61e3ede3200ce4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/index.js\":\"ea6096b9163c13ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/profiles.js\":\"bd60b817996160fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/properties.js\":\"f326828d6dc69734\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/subtree.js\":\"c387b3f5c7f69188\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/textCounts.js\":\"ba5d01cc863d4b2e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/colemak-keybindings/index.js\":\"3081661cf519e27c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/CommandPalette.js\":\"c5114b3a68004506\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/HeaderItem.js\":\"ad2bcf31975ee62f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/context.js\":\"078f73e3bcdc024f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/index.js\":\"e81da5e39a1b8635\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/selection.js\":\"29f9d2efaaf8dba7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/toggleStore.js\":\"4c831df55bdd8768\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/useCommandPaletteActions.js\":\"f5c1ed8b714a6349\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/ContributorBadges.js\":\"7668db50e23ec1fe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/author.js\":\"53a52e11f418adaa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/codeMirrorExtensions.js\":\"fcf39dde5cad965f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/dataExtension.js\":\"fa2061bd5ec67089\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/index.js\":\"8c2ae51be56f49bc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/mentionAutocomplete.js\":\"69bb88e1282bd4e5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/processor.js\":\"b035b7af7c512639\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/profiles.js\":\"c2d45119a84c7d66\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/queries.js\":\"853a202007fc9097\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/schema.js\":\"1137ee0517622b84\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"442a2ed49648d467\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/followOrigin.js\":\"96ef029fe7403ac8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/index.js\":\"c0ad2013bd3b1403\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b7a549bc60ccdd39\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"1495f2421f1d4ba1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/CalendarGrid.js\":\"b0ce98b4545c5acf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DailyNotePicker.js\":\"c2eef15b4adce279\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9bf449fdd2016776\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateNavDecorator.js\":\"7bc818a0d64d8dd5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateScrubOverlay.js\":\"b1eb5f55ecf3d209\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DayIdReferenceControl.js\":\"19b7f44808fa7800\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DayPropertyControl.js\":\"791d4a01ebdbbb58\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/HeaderItem.js\":\"e8e152e8ae2869ad\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/ReschedulePicker.js\":\"20f524e3c7eb7a12\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/SpreadDatesDialog.js\":\"cdf534490ad636a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/actions.js\":\"b4eb44c93fe4e305\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/blockDateAdapter.js\":\"1a6e3fb4eaf9417e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/calendar.js\":\"89a8099e30beb1ec\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dailyNotes.js\":\"c18d7b5e0890a685\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dataExtension.js\":\"f2b45043a1da9171\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubActions.js\":\"c3b4e250efa8d91f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubGesture.js\":\"48e60978c0e898c0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0ad88a6a71cff637\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubRecognizer.js\":\"913eca87a2d7e794\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dayIdReferenceAdapter.js\":\"9ed5c11ce5dfb2f5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dayProperty.js\":\"63fdbb9f24609e29\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/deletionGuard.js\":\"7e6715582af7248f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dueQuery.js\":\"c75d9a1310c6fa8b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/index.js\":\"a61e2d71107660bb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/landing.js\":\"9ced5eae9bcbbadc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/localSchema.js\":\"1a0ce5fa57375090\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/referenceDateAdapter.js\":\"fdace7bc095582ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/rescheduleAction.js\":\"4ec8b3dd0c834594\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/schema.js\":\"2edcd03028a7efa9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/spreadBlockDates.js\":\"d83ee228ecab3d72\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/spreadDatesAction.js\":\"5e815c11904773c1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/today.js\":\"c5c44a5f7e017efd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"5649f8514ec1472a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6daffcea42594630\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/audit.js\":\"73063e37e8088572\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/auditAction.js\":\"884993787997d539\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/auditRanges.js\":\"7e4ee2c61143a0cb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/diagnosticsSource.js\":\"7fca53781aa81618\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/divergenceScan.js\":\"61fae18b9dc21c09\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/index.js\":\"eed4ff4df4d3a81a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/propertyChildrenChecks.js\":\"944fe37f5b4c7d8f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/referencesMirror.js\":\"1bdf239d951e4346\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/rowJson.js\":\"dec14c07d3cf42ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/schedule.js\":\"6ea50afba63c400b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/store.js\":\"94b8c1796c2567a8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/action.js\":\"a9a924083b50f45b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/index.js\":\"39c9c4b272d5027e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/plugin.js\":\"62dffbdccf9675a1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"47f30acf65852386\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/actions.js\":\"62d1d25387157b81\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/changeMarker.js\":\"2b1d75f89a9a3d99\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/diagnostics.js\":\"c54fd4c7ad48a585\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/fileSystemAccess.js\":\"748f06ab578a770a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/filenames.js\":\"c56e7d0487696904\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/index.js\":\"59f5dbff2c89a793\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/mirror.js\":\"10262983eb595c5b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/runLock.js\":\"57393051706f0567\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/runtimeHealth.js\":\"141141a69179d100\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/schedule.js\":\"e239c3c3f37d2278\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/store.js\":\"e0cb2b2e303b496f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/default-themes/index.js\":\"7d8bd7a3817cc2ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/default-themes/themes.js\":\"026956991a88b831\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/diagnostics/facet.js\":\"2eb52eff4ea5e208\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/diagnostics/useDiagnostics.js\":\"ef26c7352f843b0b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/dismissals.js\":\"cbf95eb7272e11d0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/index.js\":\"85c549dc81a2f1e6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/status.js\":\"58dd82f195b5883d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/store.js\":\"bf0f62aed7983013\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"19d2092d3c0c478f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/ExtensionsSettings.js\":\"73fb1f0fc7f43d1d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/actions.js\":\"84ab0be0ac7afd04\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/config.js\":\"2d0fe69c4368be43\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/dataExtension.js\":\"628f1be74a74a79f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/effect.js\":\"43fc503e5bcef766\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/index.js\":\"159e545fa29a8ab9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f3e1d36f81f6f01b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/useToggleTree.js\":\"2b60959d59a66f83\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/ExtractTypeDialog.js\":\"f73b97bfd19fe718\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"13e985e070c91a63\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/PropertyShapePicker.js\":\"7ab2cee7ce6f1add\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/action.js\":\"d95d075813ae6c11\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/index.js\":\"831fc49d6cb3a4db\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/FindReplaceDialog.js\":\"45718a1399b9ca69\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/HeaderItem.js\":\"4b0764846cd35de4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/dataExtension.js\":\"3b3863a057c237d2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/index.js\":\"00b96742527b4a1c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/search.js\":\"1e14cd5e60809789\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/toggleStore.js\":\"6607e4ca942e68da\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/LocationPropertyEditor.js\":\"4bddc400484e6d84\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/MapView.js\":\"d07e113c57b347ac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/blockTypes.js\":\"c25f8febe21ec229\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/codeMirrorExtensions.js\":\"b6e62c180066b0b5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/createOrFindPlace.js\":\"0a2ff64300b26a82\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/currentLocation.js\":\"7df80859d4dd1fa4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/dataExtension.js\":\"7234ea22b4b127b5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/geoContentDecorator.js\":\"1fbafb0356760aaf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/googlePlacesClient.js\":\"3805daf36bcebc6e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/index.js\":\"9e488178fb5df3cf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/locationsPage.js\":\"8f9d8581d210f567\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/mapViewport.js\":\"312af4a3898c07a6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/pickCurrentLocation.js\":\"c329acf207e5ed87\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/placeAutocomplete.js\":\"10fd917c66daa6bf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/placeNameCollision.js\":\"5bd9e53cec955ab1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/properties.js\":\"91a5c79451f0b0ab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/propertyEditorOverrides.js\":\"fc8b8d11a1ab7aa4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/query.js\":\"0bc8487a2e23a0ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/usePlaceSearch.js\":\"12a8fe19f7ae9126\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"940e3ad10d185ef0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"317711fa89bd94fe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"83ae6c0ad86711bf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/config.js\":\"cfa997ed5b36caab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/dataExtension.js\":\"d4876347eed1e9a6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/facet.js\":\"e7c0e8ffef2be416\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/grouping.js\":\"f76be93aaeaabf4a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/index.js\":\"9634a1b6d483d303\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"eb7d53f76c83e5de\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/query.js\":\"899980fef589c7ed\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/resolveConfig.js\":\"e39b24a28a71c6a4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"2afc0a1bdbdd0717\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d026c3e82d58b0fb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/HtmlDocumentContent.js\":\"f72af37b85c14536\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/HtmlFrame.js\":\"64ee7f5fe89951fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/actions.js\":\"6ff5fe1148980d1d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/blockType.js\":\"375753887eedb564\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/confirmRunScripts.js\":\"0d88aff5a42e2841\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/dataExtension.js\":\"b869cfe2a42c3e1f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameAnnotations.js\":\"45ef857cf80c56e6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameDocument.js\":\"3302d4f2c3e3f26f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameTheme.js\":\"70f62799adfa5d68\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/index.js\":\"d53ebd016f8dbfbe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/scriptConsent.js\":\"de0842a35340447d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/sourceMap.js\":\"6ffedfdccd577a36\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/useDocumentScripts.js\":\"e2b31652f88c2344\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/index.js\":\"6d45cbb5ced201f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/record.js\":\"39c33c60f18b7b1f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/recordStore.js\":\"0563dd0a2d54e4c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/responsiveness.js\":\"58bf10331f81ea83\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/schedule.js\":\"233a3ee64da8741e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/sessionContext.js\":\"540dc52656584294\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"3e67b706a7cc7216\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3b660c8c03430af6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/actions.js\":\"fd9d1e831c3a842f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/config.js\":\"3596ab89f8cc8430\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/dataExtension.js\":\"45671b8c48e86936\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/effect.js\":\"de2948e005f998d7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/index.js\":\"9333a96fa8b22277\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/keyCapture.js\":\"63a97f148ea862ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/overrideStore.js\":\"498911713594e09e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"68fa4ac819297b6c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/HeaderItem.js\":\"40ce0984390c7f6f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/LeftSidebar.js\":\"8ca999541be0b7a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/actions.js\":\"2fda916ff37762cd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/facet.js\":\"b800a85841f07a0f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/index.js\":\"a1f2f67449bfe27b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/shortcuts.js\":\"147f6375c8a410f5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/toggleStore.js\":\"0a60ff1fec39888e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/MergePicker.js\":\"a1c2e765b5059f24\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/index.js\":\"11eb7e200e49a5fe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/mergeAction.js\":\"336f7849662408c3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/strategy.js\":\"583357c01f66517f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/Button.js\":\"6a80ad17274897c3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"77b3a8ea437eb7f5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/defaultItems.js\":\"51dbd6d833d98e8f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/facet.js\":\"9738bd00265a3fdc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/index.js\":\"abe0aa665e0b8c17\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"9f5f573e16956388\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/actions.js\":\"1e8e185801315d6b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"38c767926ac1d8e9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6395fad53d8f9bdc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/index.js\":\"eac1aa95a7171c31\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/MoveDestinationPicker.js\":\"744e8f497c583162\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/blockSubtreeMembership.js\":\"28341795060b30c6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/contextMenuItem.js\":\"218260ae490d6b85\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/index.js\":\"15a9910368b71023\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/moveAction.js\":\"8b7020aff980857e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/moveBlocks.js\":\"8d013af2233da831\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/selectionAfterMove.js\":\"cc6fc62c23b92e27\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/TutorialBanner.js\":\"1b63981c9b6220a0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/action.js\":\"9928c0f3948a7e68\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/bannerDismissal.js\":\"621e580aa5871062\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/documents/cheatSheet.js\":\"b5e50b384a9a903a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/index.js\":\"32cb03ce9d7ac562\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/keys.js\":\"2be4decdb8585f2d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/landing.js\":\"23dd659a92565df3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/outline.js\":\"5c09843ccfcc95e0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/seed.js\":\"2b7ea8c08d8246cc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/PerfTrendDialog.js\":\"355b109a84dc96b1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/analyze.js\":\"870cab542d5ade12\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/diagnosticsSource.js\":\"5c6046e6baee18f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/index.js\":\"52d8ed52e6fbe3af\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/load.js\":\"56f10c30feff3f1a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/monitorRun.js\":\"c7919e055aa90a34\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/schedule.js\":\"d69423601b05bf59\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/series.js\":\"09ade9d8176683a9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/store.js\":\"3ff423522db0106f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/trendAction.js\":\"64f46c05413f6933\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/verdict.js\":\"75a1514aa0b54d56\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/clickToEditAction.js\":\"b7d3631f5028cfcb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/index.js\":\"3547107d5020d54d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/interactions.js\":\"c8e7589282c6f2a8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f8a42439a3b62139\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/MigrationGate.js\":\"0b4b65da597ea810\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/MigrationGateDialog.js\":\"0a62244efeb35124\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/action.js\":\"8516743f8916d466\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/index.js\":\"5351fa3c934fe787\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/localRunMessage.js\":\"670c6881d6d22a63\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/plugin.js\":\"a140ef654b725163\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/progressReport.js\":\"2a63c827355f24ef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/sweepProgress.js\":\"b6c2dcdfa186c7cf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/FieldRowRenderer.js\":\"6bc9c3877d7182e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/ValueRowRenderer.js\":\"3f355688723a1bb3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/actions.js\":\"4033e278f1681748\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/autocomplete.js\":\"2b67ba02d3d13a09\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/fieldRow.js\":\"d2a16b4772f627f6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/index.js\":\"1a69f79ea2ddfb6f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/referenceWarning.js\":\"7abbbce65ecc56a8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/valueAutocomplete.js\":\"0c99e07ea41b5330\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/valueSchema.js\":\"42c0d5478ddfb89f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/HeaderItem.js\":\"6d2d8e175fd0f467\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/QuickFind.js\":\"b5664926472e01bb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/index.js\":\"5c60fc037f2d0566\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/recents.js\":\"da68b99f1f1d6190\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/resultItems.js\":\"0d74d31c7348fe8d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/selection.js\":\"ebfa022d2083b305\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/toggleStore.js\":\"efcca5f29fd610eb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/HeaderItem.js\":\"ad6d11b10c13a623\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/RecentsPageBlockRenderer.js\":\"3aeb864af4a54e7a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/grouping.js\":\"1a967164692df135\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/index.js\":\"9b974731f2e11216\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/target.js\":\"547a4a614cce3458\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/codeMirrorExtensions.js\":\"f168c9e57a06204c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/contentPrefill.js\":\"05491e6f2bfa1239\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/dataExtension.js\":\"c6f48a5362e813b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/index.js\":\"cce178e92a3539bd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7b3d4cb54e755e5b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/invalidation.js\":\"635ab18851f5d205\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/localSchema.js\":\"fdfa32518464f16a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/blockrefs/index.js\":\"cae9507ff04b806b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"a244d809f72de679\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/index.js\":\"d90cb8d47e619c3d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/referenceNode.js\":\"b806421b19086aa3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/remark-reference-occurrences.js\":\"9a06e542eb969e62\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"33fc9a6191c37f8d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/index.js\":\"34b0eb425c06fd06\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"d0e9080de4c816e5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"f2d19594b995026f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/mergeRetargetProcessor.js\":\"dcdde20b77c4e1d9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/parseFence.js\":\"5a1977c44dad0823\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referenceParser.js\":\"4da0b6f517ff401c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referenceProjection.js\":\"9c3a9735c4bb5d34\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referencesProcessor.js\":\"105a0ab89a8f8a79\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/renameProcessor.js\":\"a7fdb2e24e003d4f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/spanReplacement.js\":\"9613c159c40711bb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/htmlToOutline.js\":\"83cc7a1d144cec91\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/index.js\":\"264d97efd973ce93\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/normalizeClipboardDom.js\":\"8437c7cccfa170a0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/pasteDecision.js\":\"1972c775d3ed942e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/action.js\":\"356fbb2f98db938d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/blockIds.js\":\"1f9957eda5b78dba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/content.js\":\"5c0ed1ac0473a6ae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/effect.js\":\"b9250dab87bd6ec6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/ids.js\":\"ede95d42a298cef4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/import.js\":\"46803b41f95e80b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/index.js\":\"7ce72a5808a2e883\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/plan.js\":\"2e34afe7f4e64836\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/plugin.js\":\"3fe7df2f75bf49d4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/promotion.js\":\"802a6168525935bc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/properties.js\":\"8129476708dd7a52\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/references.js\":\"603fbcbd8adb0485\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/report.js\":\"84bbe5815e081cda\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/roamMemo.js\":\"604bfe4d46b63b16\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/runtime.js\":\"2eb2a9a779ad1947\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/schemaReconciliation.js\":\"53f82c8165581d63\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/srsMarkers.js\":\"ed0654a90d3ed959\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/todo.js\":\"c61d8cbda2782182\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/typeCandidates.js\":\"8488029c68f13ede\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/types.js\":\"ba5c91da542822b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/search-health/index.js\":\"b30afd4fc40730ee\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/search-health/store.js\":\"d5559f5aaa669cda\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/HeaderItem.js\":\"d2d6c70c198550cd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"bda69941f5b47399\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/index.js\":\"adf93601ab09453b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/model.js\":\"0103fef69ba6c3ea\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/toggleStore.js\":\"516304fe5bac1198\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/useKeyInspector.js\":\"1e0b227252c082d3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d2e23b9867c275eb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/ShellDecorator.js\":\"74c1d597a352d29f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/actions.js\":\"40c03d502bf7c21c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/exclusionsFacet.js\":\"0cd7b84be7fc4e87\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/index.js\":\"7aec43e253cb2e52\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/shell.js\":\"4600bd4396671675\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/surface.js\":\"7031208b59078e24\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/walker.js\":\"b672318fbcebf290\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f64dbf1879c0c33d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/dataExtension.js\":\"d8a818d5c9b616bd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/index.js\":\"b604d799cd638be9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/indicator.js\":\"aa182d7dee0e34a8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/moveSrsState.js\":\"ee96982b75a1fc7a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d14cb586aae773be\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/scheduler.js\":\"fe095ff7d27d0f7e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/schema.js\":\"b4a2226499196ab5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"312fe192773c80c5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/srsClipboard.js\":\"72b2323ecc7f5ba5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"9aae993c8afdbd44\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/DailyNoteReviewHint.js\":\"810ec7bfe1abc50c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/DeckPicker.js\":\"249505e6f5c0dde2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewControls.js\":\"76501ca4ed425e90\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewDeckRenderer.js\":\"5cb2ff04f27f68b0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewSession.js\":\"fee4307b3804f54e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/actions.js\":\"2ac3cab1b347504f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/archive.js\":\"f3a6da5157957960\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/dataExtension.js\":\"ea59c1d57ec1981f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/deck.js\":\"72b6c36117e64e64\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/dueQuery.js\":\"f3af3ec7d04acb30\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/gradeDecision.js\":\"0d3f9020de4ca595\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/index.js\":\"9c75302af60b7baa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/keyHints.js\":\"1a2062bbc07a5758\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/reviewCardLayout.js\":\"f8ef81d8eb278dc3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/reviewProgress.js\":\"aaeda90e55695a6b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/schema.js\":\"5cce42b06904650a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/useDueCards.js\":\"6b020d09c5f0cdb2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/startup-metrics/index.js\":\"d972dc29a8da8f78\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/startup-metrics/record.js\":\"ce7c5fc7b94c3356\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/index.js\":\"4ae39c7af49b10be\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/persistenceStatus.js\":\"8a130abd47188d97\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/requestAction.js\":\"9df9321378f144ae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/TypeChipsDecorator.js\":\"ef096f4bb84cacac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/codeMirrorExtensions.js\":\"134d60fe2fd8c8a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/index.js\":\"9d0e0fc9fb162385\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/typeAutocomplete.js\":\"3f9cc47c87ee3d8f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"373e15f15520d34c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/actions.js\":\"3e7a5ca83eab20f8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/anchor.js\":\"61feb23e8be35534\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/events.js\":\"b7094bf51ff8195c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/gestureActions.js\":\"240b11762041409b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/index.js\":\"fcfeffefc388a63b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"348a4d0c41698efd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/collect.js\":\"99088c175ee17ef5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/index.js\":\"72eed0397f57b720\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/record.js\":\"e003c6165aa90f75\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/RejectionDialog.js\":\"f036847b139695f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/SystemStatusHeaderItem.js\":\"48fb0998f8624ef1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/index.js\":\"3b1766e740b7f3b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/model.js\":\"050ed9b73e1dc574\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/queueCounts.js\":\"fea6be7f8f18e288\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/rejectedHelpers.js\":\"999408988edd831b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/rematerializeAction.js\":\"3eec316466f55643\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/useHysteresis.js\":\"afffe804394e1939\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/ColumnHeaders.js\":\"c513890181299cf5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/QueryUi.js\":\"3157121b7dc49d4f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/TableLayout.js\":\"18aff1a8473f9095\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/actions.js\":\"69cf6c2b5066deba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/cellEdits.js\":\"fd491f6e45ed5fa7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/childrenViews.js\":\"b162557eaa36d8df\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/columns.js\":\"cd4dabcd22055f37\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/controller.js\":\"15c47db4dc81433a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/convert.js\":\"4a9dfe46d3befc48\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/dataExtension.js\":\"16be30bf6ecb19c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/index.js\":\"acb27324580bcb06\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/keys.js\":\"75eb889620d44f40\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/model.js\":\"f1910192afef9ff6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/QueryText.js\":\"eaea369685fd23f8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/backfill.js\":\"8a93be8608303341\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/completion.js\":\"bba56bf5453d6b9d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/format.js\":\"57a09633143a79fa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/parse.js\":\"2312f37e3e8ccdd3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/queryValue.js\":\"d70c32496b0ac013\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/registrations.js\":\"167c123baf15ec21\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/source.js\":\"de5ead743b2b6832\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/registry.js\":\"a8c2b1e6fdf85991\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/rowGutter.js\":\"92aee3ade8070929\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/rowVerbs.js\":\"e671ef918c961552\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/schema.js\":\"a7cfebd312ed0ca8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/sort.js\":\"1386b6ace968e9c0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/effect.js\":\"95f6e5469c2f9d0f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/index.js\":\"d68af45aebeffe26\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/theme.js\":\"6cc4994de2dd5894\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/actions.js\":\"13395a2de9116098\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/dataExtension.js\":\"b0327975ec165fdf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/index.js\":\"b5e81cabc2878dc0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/schema.js\":\"1a6d257232127091\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a938029ff41584ae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/actions.js\":\"ddf92d30c010ca16\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/defaultItems.js\":\"d88e929a19410efe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/facet.js\":\"e01241db4615d4ae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/holdRecognizer.js\":\"8d16850d850fd872\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/index.js\":\"4dc0b25c00d633d4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/UpdateIndicator.js\":\"2d52eb4539fa4259\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/index.js\":\"92dccaccb66b5048\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/loadTimes.js\":\"2acd96f59f1eac23\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoNotesRenderer.js\":\"db7ed0c6a351b950\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoPlayerRenderer.js\":\"c4100fd91efc1738\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoTimeStamp.js\":\"69dcf3ed5abb1a88\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/actions.js\":\"f9637442446ac4cb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/index.js\":\"d1179439faff7eaa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/markdown.js\":\"e2aa68c67fea260c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/notes.js\":\"9975830adf3fe7e8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/registry.js\":\"4289833abb00beb6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/remark-timestamps.js\":\"600ffd111c6097fb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/view.js\":\"806a8547b14e2677\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/LinkHints.js\":\"df1ffa7d8fa88c9b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/index.js\":\"9f5ab7c07494876a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/model.js\":\"fa631c95eb9d20d9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/settings.js\":\"e5d041747a5ab544\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/actions.js\":\"6c6b11234733e5d5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/index.js\":\"162e229c6c730b45\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/interactions.js\":\"6e6b713d7383ca4e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/workspace-header/index.js\":\"d1f861b53762504a\",\"/knowledge-medium/pr-preview/pr-1884/src/registerServiceWorker.js\":\"777fc89a76c70922\",\"/knowledge-medium/pr-preview/pr-1884/src/requestPersistentStorage.js\":\"11ee8c653a2d5dc2\",\"/knowledge-medium/pr-preview/pr-1884/src/services/authRequestDeadline.js\":\"3e0805e72a93edcf\",\"/knowledge-medium/pr-preview/pr-1884/src/services/authStorage.js\":\"62d3f4da14c22144\",\"/knowledge-medium/pr-preview/pr-1884/src/services/powersync.js\":\"70409b2dbf90cfc5\",\"/knowledge-medium/pr-preview/pr-1884/src/services/supabase.js\":\"eceb36c02ffe4423\",\"/knowledge-medium/pr-preview/pr-1884/src/services/uploadErrorClassifier.js\":\"d2246b9d7193016d\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/ActiveContexts.js\":\"2063cc227595d3c6\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/HotkeyReconciler.js\":\"19e2f52b45a69a5f\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/WipeLocalDataDialog.js\":\"8cb761ff58bf9493\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/actionDispatch.js\":\"42064662fc545177\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/actionRefItems.js\":\"1f4b2cf658ca100e\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/applyKeybindingOverrides.js\":\"eea09430243d89f5\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/blockActions.js\":\"218d806210593761\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/blockMergeGesture.js\":\"c8cccae345fe1e6f\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/canonicalizeChord.js\":\"272fd8aaf7bc9360\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/defaultContexts.js\":\"cb31f91f42039232\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/defaultShortcuts.js\":\"24699b65def9a28d\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/effectiveActions.js\":\"448b4276658deb1e\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/gestureAction.js\":\"581279b88440728e\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/gestureBinding.js\":\"3e30f40cc7c03e66\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/holdRegistry.js\":\"3329ac9dbe075a56\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/keybindingConflicts.js\":\"c154c2ea2a11bbb4\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/keybindingOverrides.js\":\"631e6423310f1d7d\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/pointerAction.js\":\"5724220e23638a5c\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/resolve.js\":\"8f7b40260fdde2db\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/runAction.js\":\"52c9c66c8cfb8b15\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/sequenceMatcher.js\":\"074e8c5426b2451a\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/types.js\":\"46a016dc53e58640\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/useActionContext.js\":\"aa92ec080519aac0\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/useActionDiscovery.js\":\"6370380954cb9a03\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/utils.js\":\"70a70b876fdb9bee\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/bootStore.js\":\"99aeb0b57d4f7c87\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/previewDatabases.js\":\"44c51b4d584d658e\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/byteTransform.js\":\"485ccc34bd202013\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/attachmentCleaner.js\":\"86017570f5126a12\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/attachmentParts.js\":\"e63957583997e030\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/bundleParts.js\":\"8547fef20ab8cbca\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/bundleRecord.js\":\"7c16fa703b013b99\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/manifest.js\":\"3df171b01bedb641\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/takeBundle.js\":\"438ddf1d17d78d09\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/verifyBundle.js\":\"01d04e5d327fd0e0\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/cleaningStage.js\":\"cd5c467f572ecdbf\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionKey.js\":\"f4819ad79c2801c4\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionServer.js\":\"cb76c6e5ca3127aa\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/flip.js\":\"f32445cca9ce068a\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/flipAttempts.js\":\"4b3bf5ee8a6e5a87\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/pages.js\":\"bcf70af58bdf911c\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/preflight.js\":\"79c21bb8962e06a0\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/reseal.js\":\"bb305e69b9373dff\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/runConversion.js\":\"74106f35e6df0a6d\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/runLock.js\":\"dcc2a6fc039d699e\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/sealing.js\":\"e32879abe15842bf\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/sealingStage.js\":\"efd5384522e9bedb\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/stage.js\":\"622a9d1f13ae5a4d\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/verifyReseal.js\":\"55daf295ca1b9aba\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/aad.js\":\"66d2dbf9ca2aded1\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/aead.js\":\"896441cc5caf7e1b\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/base32.js\":\"7f532d2a1d834617\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/base64url.js\":\"4ac854f459044a8c\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/binaryEnvelope.js\":\"65340915208f0279\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/byteAead.js\":\"fb13c30cb964d724\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/canary.js\":\"9f8143223349e760\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/contentHash.js\":\"95c58ac47012a8a4\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/contentKey.js\":\"0fb66848fb11120c\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/derivedIdNamespace.js\":\"311bd350152b1e43\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/envelope.js\":\"4fe18b308985ebaa\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/hex.js\":\"104a0a06e84b2bd2\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/sha256Hex.js\":\"b79ab65f8d5d81c9\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/workspaceKey.js\":\"42cc1e15245f9102\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/conversionState.js\":\"b4d508f7fd237026\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/createEncryptedWorkspace.js\":\"f1673a787ea34380\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/pastedKey.js\":\"065b06d436452574\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2bbaaf505b339ec2\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/upgradeWorkspacePin.js\":\"39f7c37e2f06b352\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/keyStore.js\":\"394233d573644005\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/mintWorkspaceKey.js\":\"ae890ec589ac11a5\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/modePin.js\":\"aa0adcf1de6f0c8d\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/openWorkspaceKeys.js\":\"9610287bc8000b27\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/resolveWorkspaceEntry.js\":\"a051e22020d31744\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/resolver.js\":\"0f650ab94032e99d\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/workspaceAccess.js\":\"8ea90a85e002d33a\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/transform.js\":\"2a238d02191d4076\",\"/knowledge-medium/pr-preview/pr-1884/src/themeBootDefaults.js\":\"e1ffa8a67d027ecd\",\"/knowledge-medium/pr-preview/pr-1884/src/types.js\":\"5fc6af459f420b76\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/ClientLocalSettings.js\":\"d821e1b973c29bfd\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/abortableSleep.js\":\"30cd6f4fe17cb97c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/array.js\":\"ecdffab81288422d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/backlinkAutocomplete.js\":\"75b5d0bbfbbeb480\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/blockCrumbs.js\":\"61a8b81d741dd592\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/blockrefAutocomplete.js\":\"888c47f30da34d12\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/cadencedIdleJob.js\":\"56071b187579421b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/callbackSet.js\":\"1fd41164fc4a053d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/clientId.js\":\"7ed3e3456eb9b9e4\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/codemirror.js\":\"0be822fced3476e9\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/codemirrorCompletion.js\":\"78e2b91822b8b98d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/copy.js\":\"cd213292127a25be\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dailyPage.js\":\"484a9e680c465116\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dbForensics.js\":\"eb4b0f04ec6c2309\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dbForensicsHooks.js\":\"fea9ecd9929b8e5c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/deleteBlockThroughUi.js\":\"ec54eaf1d00c2dcd\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dialogs.js\":\"b2d0956c8af8cce5\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dom.js\":\"55490178269c3b46\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/downloadBlob.js\":\"ce97c9aac328db35\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/drawnWalk.js\":\"0a28977c971bde57\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/exportSqliteDb.js\":\"f3787d4b776b7e77\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fileSystemAccess.js\":\"315980320649e185\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/flipSlide.js\":\"603d2f4100d37fec\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fnv1a.js\":\"e8b3b234e950ca55\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/formatBytes.js\":\"3162d8a11e9315ca\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fuzzyRank.js\":\"fe04050c384de63e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/idbKeyedStore.js\":\"ec357527a9b6d67b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/idleCallbackPolyfill.js\":\"141f593806575662\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/keyboardAwareScroll.js\":\"3b94860c6d6ad883\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/keyboardViewport.js\":\"46c37688797ea1f5\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/lastWorkspace.js\":\"b4e8a826e7c1416e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutColumns.js\":\"fc33a52488fd4571\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutSessionDom.js\":\"49de32d9f0fb3c5f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutSessionId.js\":\"20ce0276b5ddd519\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/linkClickGestures.js\":\"753cdf2ef5bbd69f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/linkTargetAutocomplete.js\":\"d20ac6949e14d8bc\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/localDbCorruption.js\":\"158b2f236be1db3d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/localDbRecovery.js\":\"59b1a73ee4cfb038\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/markdownParser.js\":\"dbf424ba97cf3f0f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/memoize.js\":\"2e8601854c82ebc6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/nameFieldCommit.js\":\"f6f93e81ce239e97\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/nameList.js\":\"1ab99c8094908c83\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/navigation.js\":\"331647d5b6d45929\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/omnilinerNamespace.js\":\"d3c30c6e88904ad8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/opfsPageScan.js\":\"80d23e6c5f33e33c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelClearance.js\":\"1947ebf15c6c99d1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelHistory.js\":\"74224d7df5106c4a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelLanes.js\":\"c169ed4b5c13ef79\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelLayoutProjection.js\":\"4dc26e598ebd24d1\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelScrollAnchor.js\":\"a8acaf8c6fac8ff8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelUrlFlags.js\":\"15c1afab1f544b46\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/platform.js\":\"38157159604057d0\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/pluralize.js\":\"64ce482fd51d7875\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyCreation.js\":\"1fe5ebec72e38104\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyNavigation.js\":\"be3c9142096a2546\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyValueContext.js\":\"14ef9ea93e8f8051\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/react.js\":\"2846a8928f518848\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/relativeDate.js\":\"4977b3c7c95fa2b2\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/relativeTime.js\":\"7450a8fc1c71d5ba\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/renderScope.js\":\"d563981697ac395c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/resolvedThenable.js\":\"c137e4540735bd2f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/routing.js\":\"6333c486ee287fef\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/safeMode.js\":\"1d689b89458e73ea\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/scheduleIdle.js\":\"b5748192a0405914\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/screenWakeLock.js\":\"5f53c4513a052add\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/selection.js\":\"48e4bff8f914dc42\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/softKeyboardGrab.js\":\"bb6f05e030a7eb2e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/startupTimeline.js\":\"993cc758bc8ccb2e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/state.js\":\"3aa8df480c35a4b3\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/string.js\":\"44388d7124d75015\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/surfaceZoom.js\":\"302f2e7bf2b954e0\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/time.js\":\"4f94f6417a192619\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/toast.js\":\"dee88b38748c3ba0\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/toggleStore.js\":\"baa95fd4bac0cf29\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/untilStopped.js\":\"6c7eb47954964062\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/userActivity.js\":\"5633beb4e3740c66\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/viewTransition.js\":\"eda3d402039b440c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/viewport.js\":\"d7d5890a73564027\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/webLock.js\":\"96e8e68c6e0866e9\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/workspaceRecovery.js\":\"7bac67e239e8d59d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/workspaceSnapshotStore.js\":\"a5505a36d2e7cf06\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-compiler-runtime.js\":\"8f7a60e749786121\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-client.js\":\"ed6cdd56cd7890f2\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-server-edge.js\":\"f88c8037817e9283\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-server.js\":\"57e78a4b60f76494\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-static-edge.js\":\"57f3b14c2f5e386c\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-static.js\":\"9caa82d9737bed07\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-test-utils.js\":\"ac8d198cc5f45280\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom.js\":\"c375b57941589255\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-jsx-runtime.js\":\"45e9738891982794\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react.js\":\"c290bd2c304e37c4\",\"/knowledge-medium/pr-preview/pr-1884/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1884/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1884/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
