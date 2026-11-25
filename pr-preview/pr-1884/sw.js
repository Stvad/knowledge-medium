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
		buildId: "ad55cd9747ad-34b0fd56",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/\":\"0ab5f9168e354b98\",\"/knowledge-medium/pr-preview/pr-1884/index.html\":\"0ab5f9168e354b98\",\"/knowledge-medium/pr-preview/pr-1884/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1884/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1884/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1884/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1884/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/app.css\":\"dcb68bea1e734b49\",\"/knowledge-medium/pr-preview/pr-1884/assets/FacadeVFS-CZaZubyA.js\":\"452ee8ccaf3632a7\",\"/knowledge-medium/pr-preview/pr-1884/assets/OPFSCoopSyncVFS-DRXZrIUY.js\":\"b8ea73ac2df32151\",\"/knowledge-medium/pr-preview/pr-1884/assets/OPFSWriteAheadVFS-B-yZHJr3.js\":\"b0a02404a97ed504\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-BS2QWGnH.js\":\"0517618f12db4340\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1884/assets/wa-sqlite-async-BPFsksgB.js\":\"17f6a60a8fd23bf0\",\"/knowledge-medium/pr-preview/pr-1884/assets/worker-9LcMb2Hh.js\":\"aef896ed4be63d75\",\"/knowledge-medium/pr-preview/pr-1884/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1884/chunks/app-BPzxndrP.js\":\"ac63e401a6b29baa\",\"/knowledge-medium/pr-preview/pr-1884/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1884/index.js\":\"505d59dc89063776\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1884/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1884/assets/AccessHandlePoolVFS-EiQkhSYC.js\":\"fd1ee9ae005ac7f1\",\"/knowledge-medium/pr-preview/pr-1884/assets/IDBBatchAtomicVFS-ByKXhiwu.js\":\"d87443cd047eff78\",\"/knowledge-medium/pr-preview/pr-1884/assets/MemoryVFS-C994MB5Q.js\":\"b6c1d748ad1ed335\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-DpNyrni7.js\":\"14aa37c3d28ad0fa\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1884/assets/mc-wa-sqlite-async-l6kr3bLo.js\":\"31eed6ab5c5837a9\",\"/knowledge-medium/pr-preview/pr-1884/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1884/chunks/AccessHandlePoolVFS-BJImcoMd.js\":\"6bb9f9799f1c504c\",\"/knowledge-medium/pr-preview/pr-1884/chunks/FacadeVFS-ZcTz470i.js\":\"b58251edf81c0921\",\"/knowledge-medium/pr-preview/pr-1884/chunks/IDBBatchAtomicVFS-8AJp72-l.js\":\"547b50c4a47708a9\",\"/knowledge-medium/pr-preview/pr-1884/chunks/MemoryVFS-BZ_say2M.js\":\"82a95121981fba98\",\"/knowledge-medium/pr-preview/pr-1884/chunks/OPFSCoopSyncVFS-Hfezeap_.js\":\"078f2a90b729b723\",\"/knowledge-medium/pr-preview/pr-1884/chunks/OPFSWriteAheadVFS-C10_V7-a.js\":\"646ea00a6d2431b5\",\"/knowledge-medium/pr-preview/pr-1884/chunks/Preview-Chf_VQU0.js\":\"22a6a27a510dd42b\",\"/knowledge-medium/pr-preview/pr-1884/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1884/chunks/card-CZn7xcLv.js\":\"2cb00b882631a9d5\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1884/chunks/dist-Dbq-N09q.js\":\"351ada06c688a7b2\",\"/knowledge-medium/pr-preview/pr-1884/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1884/chunks/mc-wa-sqlite-DFyKaaxw.js\":\"b99c56c32a3d3a91\",\"/knowledge-medium/pr-preview/pr-1884/chunks/mc-wa-sqlite-async-DDdztWG6.js\":\"4f4dac2e549d9d9d\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-2ABlwQhE.js\":\"0f37cda57e24acf1\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-BjSVhxYj.js\":\"a893c15408901db4\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-C98FUbvx.js\":\"b8c6495e2f23be74\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-CBoR-b23.js\":\"99bbaeb53c01983e\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-CChtes_n.js\":\"c349a0ec888dc0c9\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-Cg9T8PwP.js\":\"c2f40ddb0d081cf1\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-DElvWBep.js\":\"1fbd499772ed1347\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-Y7DozBCF.js\":\"59a7ad91f657c906\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server-legacy.browser.production-CSisnBzy.js\":\"bd9f9aa3b1db1898\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server.browser.production-3K1f900z.js\":\"6d1df7eaefabdc4d\",\"/knowledge-medium/pr-preview/pr-1884/chunks/react-dom-server.edge.production-CKt4tgup.js\":\"f8bdb53a9112f631\",\"/knowledge-medium/pr-preview/pr-1884/chunks/server.browser-BuybrP5S.js\":\"815a5db60a162da3\",\"/knowledge-medium/pr-preview/pr-1884/chunks/textarea-yHQ0joP2.js\":\"08a283334e8dc30e\",\"/knowledge-medium/pr-preview/pr-1884/chunks/ui-bbU1s8g4.js\":\"6b2e8c1f08f6d700\",\"/knowledge-medium/pr-preview/pr-1884/chunks/wa-sqlite-CcK4Ra1E.js\":\"249711f0f25cd8ab\",\"/knowledge-medium/pr-preview/pr-1884/chunks/wa-sqlite-async-C4pAzbgW.js\":\"4ac3bd399a8977e3\",\"/knowledge-medium/pr-preview/pr-1884/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1884/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1884/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1884/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1884/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1884/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1884/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1884/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1884/src/App.js\":\"c8842b2e033fed96\",\"/knowledge-medium/pr-preview/pr-1884/src/appUpdate.js\":\"131b7510f5c192ff\",\"/knowledge-medium/pr-preview/pr-1884/src/appVersion.js\":\"59cc5a35c3e4f8e9\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/initialLayout.js\":\"e209c74f51986700\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/openWorkspaceData.js\":\"8a14201089fb9225\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/resolveWorkspace.js\":\"39488ba94d572b96\",\"/knowledge-medium/pr-preview/pr-1884/src/bootstrap/workspaceBootstrap.js\":\"aa0b53721835a4a9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockComponent.js\":\"d83a53766cb0b72f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockCrumbs.js\":\"21a7621b4af86f96\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockEditor.js\":\"9075b40d1620f834\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockLoadingPlaceholder.js\":\"1fab63116f84734f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockProperties.js\":\"6a1bc7cd34c2acc4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/BlockSearchPicker.js\":\"8dcde444c59e38a8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ConfirmBulkDeleteDialog.js\":\"5fd37c89eed0e52c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/DividerHandle.js\":\"9aa8378074d668c5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/DraftEditor.js\":\"20f917f7c7e729dd\",\"/knowledge-medium/pr-preview/pr-1884/src/components/GutterPill.js\":\"8cf2fbbefd175fbf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/Header.js\":\"b6caac982700f4ee\",\"/knowledge-medium/pr-preview/pr-1884/src/components/LazyBlockComponent.js\":\"78d8bf280ab353b3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/Login.js\":\"ff7b3564f6d4ea5f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ZoomableSurface.js\":\"879a4b5a0d9823fd\",\"/knowledge-medium/pr-preview/pr-1884/src/components/editModeKeepalive.js\":\"7c6c3a3b38f4c67e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyDisplay/PropertyDisplayScope.js\":\"79c9db593b38e415\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"7c9564dd32b806fc\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/RefPropertyEditor.js\":\"7993c5c3bb004a74\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/RefTargetTypePicker.js\":\"479dc326d39ee529\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/SelectPropertyEditor.js\":\"bb377211979b7def\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/TypesPropertyEditor.js\":\"a5308f1bd39d74c7\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/defaults.js\":\"db04ec7434207cd0\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/kernelValuePresets.js\":\"362718727ee3ab41\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/selectablePresets.js\":\"0f9e2c2088e414ad\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyEditors/typesPropertyUi.js\":\"110b3aac77bdcaaf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/AddPropertyForm.js\":\"00e2082466e82322\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/PropertyPicker.js\":\"b53fea18cc7e11ef\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/PropertyRow.js\":\"73977e0a25364bec\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/Rows.js\":\"9aa5b0d56f387b9b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/actions.js\":\"c96c1ecc5e674803\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/declarationOnly.js\":\"c8940cbbc84d1f7f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/layout.js\":\"e5d3e658a00b49f4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/model.js\":\"2e3a1d8939a31e05\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/shapeUi.js\":\"392ec058f9d2edbb\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/shapes.js\":\"0e9e4f02c39d2627\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/usePropertyEditingActivation.js\":\"728011f8c3777d80\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanel/visibility.js\":\"dfc75260b24f4fe9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/propertyPanelSections.js\":\"8492f90e9c56b19d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockEmbed.js\":\"dbbc81027a4f8e01\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockLink.js\":\"c89af09aa60e8920\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/BlockRef.js\":\"a096ec06241d0785\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/ReferenceLink.js\":\"0357794ff1f38c06\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/cycleGuard.js\":\"7d13e5a650d74ee4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/cycleGuardContext.js\":\"cdc7479163cc768b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/linkInteraction.js\":\"9ee9623d49e5bd94\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/referenceLayout.js\":\"08a07c84abb7444a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/references/useBlockRefAncestors.js\":\"1759ad25f6772e78\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockGutter.js\":\"7f8e73cdd4bd26ca\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockInfoDialog.js\":\"0b9a3666b8595b34\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BlockTypeBlockRenderer.js\":\"21079ef1e1a05ff1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/BulletHoverCard.js\":\"220f8c4065e43bb7\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/CodeMirrorContentRenderer.js\":\"c3ce84ce9257c4ce\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9048a21e4b0edb97\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/ColumnResizeHandles.js\":\"c46e7f2a47bb5e13\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"087cfb0d7439ee16\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/DefaultBlockRenderer.js\":\"37d94079eb217f79\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/LayoutRenderer.js\":\"873c737543102041\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/MarkdownContentRenderer.js\":\"dd571a2eb86aa796\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/MissingDataRenderer.js\":\"feb7ec3ce709a427\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/PanelRenderer.js\":\"4f54841c7e263a3b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c45a47137c85747b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/TopLevelRenderer.js\":\"8c5b024b7e42bbad\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/blockGutterMode.js\":\"a2b3c3a15c083ed9\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/blockTitleText.js\":\"c4f82fa93680c83f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/fieldCreationKeydown.js\":\"931ad23fa325bb84\",\"/knowledge-medium/pr-preview/pr-1884/src/components/renderer/layoutRootContext.js\":\"a792adf2b129457d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/typeChip/TypeChip.js\":\"4b464a2c35d12cbf\",\"/knowledge-medium/pr-preview/pr-1884/src/components/typeChip/chipStyle.js\":\"cc8d260b7783bc98\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/anchored-floating.js\":\"5af9f26e8e87144a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/button.js\":\"130a154b95dc24ac\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/card.js\":\"d6c900f4041d830e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/checkbox.js\":\"b51fca845b32a61d\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/collapsible.js\":\"f1dd2e7e3acb85ca\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/command.js\":\"cebef3a89189844b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/context-menu.js\":\"23cebf49fcd974d8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/dialog.js\":\"9c4bd1e783d62691\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/dropdown-menu.js\":\"caf19fed5ff93a55\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/floating-listbox.js\":\"77703102786a9e88\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/index.js\":\"5d933ac58c7330c3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/input.js\":\"64cc39666e3fd937\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/kbd.js\":\"acba5f32d0d55771\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/label.js\":\"a50382cd468003df\",\"/knowledge-medium/pr-preview/pr-1884/src/components/ui/textarea.js\":\"dbfb7d710215ad6b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/useEditModeYieldKeepalive.js\":\"a3b8661aab11f6d4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/BootFallback.js\":\"e1895563e78f6d53\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/FocusedRowLazyMount.js\":\"16865d5312a8f027\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/LazyViewportMount.js\":\"9aff8bf3d0cf5447\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/LocalDbCorruptionFallback.js\":\"fc284a2f077b7dc5\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/error.js\":\"6fbd18ce9a0dcf44\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/lazyMountRegistry.js\":\"613bf81285e71a76\",\"/knowledge-medium/pr-preview/pr-1884/src/components/util/suspense.js\":\"d34368bd04b743c6\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/CreateWorkspaceDialog.js\":\"b365f74fc67014d3\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/PendingInvitations.js\":\"6a0352b6971e21f4\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/SyncProgress.js\":\"e59052ea82988748\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/UnlockProgress.js\":\"795ec9789c1b3962\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceKeyGate.js\":\"e42d878e734be9b1\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSettingsDialog.js\":\"f738f092499cf9b0\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSwitcher.js\":\"64b7daa786ecba71\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/WorkspaceSyncGate.js\":\"800155c553b8ff4e\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/ConversionFlow.js\":\"2f7a91f32d651dce\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/ConversionFlowHost.js\":\"f1e7cefe04a19c7b\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/EncryptionSection.js\":\"2b800ae87bb1967a\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/attachmentPrompts.js\":\"a04fe050bb4be724\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/bundleFolderPrompts.js\":\"bd6d70afb73605cd\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/conversionFlowDeps.js\":\"4e6c769f0a18167f\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/conversionFlowStore.js\":\"108d5a9360010498\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/flowUi.js\":\"ba840a529e9adb9c\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/conversion/useConversionRun.js\":\"5a600d7514de12ff\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/keyUi.js\":\"12199379809e2241\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/useCloseOnKeyLoss.js\":\"b291ee0e95f60fa8\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/useCloseOnServerE2ee.js\":\"3e65f43c7d7a1013\",\"/knowledge-medium/pr-preview/pr-1884/src/components/workspace/workspaceUnlocked.js\":\"a2fe5a11c11da498\",\"/knowledge-medium/pr-preview/pr-1884/src/context/backgroundSubtree.js\":\"6645a51f9be9c644\",\"/knowledge-medium/pr-preview/pr-1884/src/context/block.js\":\"9836389e9d2e9ec1\",\"/knowledge-medium/pr-preview/pr-1884/src/context/layoutWsContext.js\":\"f0b3c0e60bd5acf4\",\"/knowledge-medium/pr-preview/pr-1884/src/context/propertyDisplay.js\":\"5368432e5c44fd56\",\"/knowledge-medium/pr-preview/pr-1884/src/context/repo.js\":\"20a950d3676a4ea0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/aliasClaim.js\":\"db43ed45dc3e8423\",\"/knowledge-medium/pr-preview/pr-1884/src/data/aliasSeatNamespace.js\":\"765304b0f2457414\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/blockData.js\":\"549392558047fa44\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/blockType.js\":\"3444dbcdefcb0396\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/changeScope.js\":\"3f9a5f6ecc354ef7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/codecs.js\":\"4fadb1e5aa575858\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/derivedData.js\":\"7dbe28b75c7326df\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/errors.js\":\"66590dcb3c0449b5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/events.js\":\"6b70cc2b3c453f6e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/handle.js\":\"1e92da12fc89f12f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/index.js\":\"7da5726547c48f2c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/mutator.js\":\"ebce9c174ada4af7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/processor.js\":\"77506385f73984aa\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/propertySchema.js\":\"2e9f6b700997fa1c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/query.js\":\"69facf186d814843\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/sameTxProcessor.js\":\"adf2bb1fb1025de1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/schema.js\":\"1e92da12fc89f12f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/tx.js\":\"1e92da12fc89f12f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/typedBlockQuery.js\":\"5fe5bbeeed498f68\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/user.js\":\"d6c43fa0c7562f19\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/valuePresetCore.js\":\"2959b595a32cf372\",\"/knowledge-medium/pr-preview/pr-1884/src/data/api/valuePresets.js\":\"8cd50384e56c1795\",\"/knowledge-medium/pr-preview/pr-1884/src/data/attachmentCleanerIOVerb.js\":\"7a9bbbfd615c20c4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/block.js\":\"1f1a6c5e340d8966\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockCache.js\":\"cb14a5b7b1681038\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockId.js\":\"925fc834e6e7b099\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockLiveness.js\":\"794eb8c7c3b91000\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockMerge.js\":\"03567c78db9f42b2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockSchema.js\":\"9507188c8cf35a64\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockTypeLookup.js\":\"18038c21be22c036\",\"/knowledge-medium/pr-preview/pr-1884/src/data/blockTypes.js\":\"39049ee8e3a8f5e2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/childrenView.js\":\"5d0c88cc841a67f6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/clientContext.js\":\"a56061a2c06e972e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/dbFileSiblings.js\":\"e80e7053a2ce8bcb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/definitionSeeds.js\":\"b52751a9c9fd125c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/derivedIds.js\":\"6750867bdbb28535\",\"/knowledge-medium/pr-preview/pr-1884/src/data/drawnSubtree.js\":\"780d8a8404bb0413\",\"/knowledge-medium/pr-preview/pr-1884/src/data/facetBridge.js\":\"80f3f5678dbbcb96\",\"/knowledge-medium/pr-preview/pr-1884/src/data/facets.js\":\"e22412d8f989a3ed\",\"/knowledge-medium/pr-preview/pr-1884/src/data/globalState.js\":\"79c56a12a83206e8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/aliasClaimRederiveProcessor.js\":\"387eaeb65f846215\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/ancestorBatch.js\":\"bdc69fb592f21d1a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/blockTypeTypeifyProcessor.js\":\"b337e75eae35f925\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/clientSchema.js\":\"27d8b05713eadeeb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/commitPipeline.js\":\"1c553ce40cd8101d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/devAssertions.js\":\"445717b8937483b4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/firstSync.js\":\"2d5864e6c8c87990\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/freshInitialLoad.js\":\"de14b2263ca79058\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/graphBackfillClaim.js\":\"4cc92f1f1e706e8a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/handleStore.js\":\"c68f0e7eca9b92da\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/idleMarkerJobs.js\":\"cd166644b03348b3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/initialDownload.js\":\"c8bf9714e6e3e5d3\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/initializeClientDatabase.js\":\"968f71ba3842a7a9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/jsonCanonical.js\":\"a79567870a24dbb5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelInvalidation.js\":\"b587d03fafcdf8fa\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelProcessors.js\":\"23a14a2dca1b72dd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/kernelQueries.js\":\"aecab00f641e0dab\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/mergeTypeMembershipProcessor.js\":\"0d60b72903f5123c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/normalizeReferencesProcessor.js\":\"13b6ac9f87f87ca6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/poolInstrumentation.js\":\"8c289cc835a03111\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/processorRunner.js\":\"8a66f3c8ec9ca547\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyCellBackfill.js\":\"765ac9ade4cbdc47\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyChildMint.js\":\"0994eacd99f52c95\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyChildrenProcessor.js\":\"8c6c65cdf45573a7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyDefinitionChangeProcessor.js\":\"386edf986a5f1701\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyDefinitionSynthesis.js\":\"55d4245b7b0ad8d0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyKeyScan.js\":\"29a4818064775ee6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertySchemaResolution.js\":\"d1ebb6b130d95eff\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/propertyValueEdits.js\":\"1d7e4dd3f0029d0f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/raiseProtocol.js\":\"4948827ce73ab6b8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/readBatch.js\":\"15d90a450b26b82c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/refProjection.js\":\"aaca42f9a66ce14e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/referenceTargetLookups.js\":\"c8957db6283f8458\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/referenceTargetProcessor.js\":\"62e987525c91dbc0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/replayMerge.js\":\"e1ae60e8cc17b9fd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/sqlBinds.js\":\"0dd259adedf50e05\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"ab458669368d295c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/arrivalProcessors.js\":\"d51ed66fad9c6ebe\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/invalidate.js\":\"d356887a105816eb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/materialize.js\":\"f8ead7c32c9bf68c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/observer.js\":\"4b1d5120ab13adc0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/syncObserver/reconcile.js\":\"41d272455a40dd52\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/timingMetrics.js\":\"d91a043e965203f8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/treeQueries.js\":\"808d718a4224c48e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/txEngine.js\":\"1232dd001687ae1c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/txSnapshots.js\":\"966b58a140b58e0f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/typedBlockQuery.js\":\"b5b25d3c3b5fd789\",\"/knowledge-medium/pr-preview/pr-1884/src/data/internals/undoManager.js\":\"3e63711b761fbf15\",\"/knowledge-medium/pr-preview/pr-1884/src/data/invalidation.js\":\"e1061a1e05ad855b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelDataExtension.js\":\"adc15902eef7c625\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelPage.js\":\"85508cdeef4c29d1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/kernelValuePresetCores.js\":\"5edf7255578ce9c9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbCorruptionSignal.js\":\"5325ff8eb65d7529\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbStorage.js\":\"07abd8c09bbadcee\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localDbVfs.js\":\"46ff66217e0ebf28\",\"/knowledge-medium/pr-preview/pr-1884/src/data/localSchema.js\":\"fc1a362aa529fd8e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/maintenance.js\":\"dc4ca4214d6bf515\",\"/knowledge-medium/pr-preview/pr-1884/src/data/mergeProperties.js\":\"b5f49509242bb7ac\",\"/knowledge-medium/pr-preview/pr-1884/src/data/metricsConsoleHook.js\":\"c01761432d869a92\",\"/knowledge-medium/pr-preview/pr-1884/src/data/migrationsPage.js\":\"82ef15a129d841d2\",\"/knowledge-medium/pr-preview/pr-1884/src/data/mutators.js\":\"9de33fd85c79b1dc\",\"/knowledge-medium/pr-preview/pr-1884/src/data/orderKey.js\":\"6e8d105e7813127e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/orderKeyPlacement.js\":\"44100def511d0bf7\",\"/knowledge-medium/pr-preview/pr-1884/src/data/outlineSurface.js\":\"2a7d5fc6450b33c0\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pendingEditorContent.js\":\"a465628437815551\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pendingUploadsSql.js\":\"765553b43ddc5f87\",\"/knowledge-medium/pr-preview/pr-1884/src/data/pluginStateExtensions.js\":\"0456f02d9770ce71\",\"/knowledge-medium/pr-preview/pr-1884/src/data/powerSyncLogger.js\":\"4c92e42126257d94\",\"/knowledge-medium/pr-preview/pr-1884/src/data/projectorRuntime.js\":\"2216c73366907d75\",\"/knowledge-medium/pr-preview/pr-1884/src/data/properties.js\":\"729caa280a6f6f66\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertiesPage.js\":\"d37dbd093e294e64\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyChildren.js\":\"b1bd174bb034075c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionFanout.js\":\"0b3507fbdb25ef9e\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionMetadata.js\":\"7d7ee864e4b9640d\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDefinitionRegistry.js\":\"849ec3e9db5f4cdb\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyDisplayMode.js\":\"f919964201848510\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertyRowCreation.js\":\"cf75a12cf0305a1b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertySchemaCreation.js\":\"a5960eccc54ab39a\",\"/knowledge-medium/pr-preview/pr-1884/src/data/propertySeeds.js\":\"71969af56df118da\",\"/knowledge-medium/pr-preview/pr-1884/src/data/recentsPage.js\":\"205affdcbde58406\",\"/knowledge-medium/pr-preview/pr-1884/src/data/refTargetComparableProperty.js\":\"91c37b3c0f72319b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/referenceBlock.js\":\"830fa296cb582388\",\"/knowledge-medium/pr-preview/pr-1884/src/data/rejectedUploads.js\":\"fba70466f3a5df13\",\"/knowledge-medium/pr-preview/pr-1884/src/data/releasePowerSyncConnection.js\":\"86a14917b5b6d558\",\"/knowledge-medium/pr-preview/pr-1884/src/data/repo.js\":\"956647f7e38bd15c\",\"/knowledge-medium/pr-preview/pr-1884/src/data/repoProvider.js\":\"4fd1b446cb0f3c61\",\"/knowledge-medium/pr-preview/pr-1884/src/data/rowProperty.js\":\"65307acc3d348a57\",\"/knowledge-medium/pr-preview/pr-1884/src/data/searchFilter.js\":\"3e53ea67c8f02e6f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/seedIdentityLedger.js\":\"d1422b31375680a1\",\"/knowledge-medium/pr-preview/pr-1884/src/data/stateBlocks.js\":\"e902186e396eae23\",\"/knowledge-medium/pr-preview/pr-1884/src/data/structuralEditPolicy.js\":\"8d4216068e5a8dc4\",\"/knowledge-medium/pr-preview/pr-1884/src/data/structuralInsert.js\":\"c03ca910aafef620\",\"/knowledge-medium/pr-preview/pr-1884/src/data/subtreeDelete.js\":\"9a04226c86aeb041\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncStreamLock.js\":\"9a1bc8e9a9a5e551\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncedTableSqlRecognizer.js\":\"cacf32a7d51781f6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/syncedTableWriteGuard.js\":\"9a06cacef8ac28c9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/targets.js\":\"82b55e422993c873\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeColors.js\":\"48faaed99f810681\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeDefinitionMetadata.js\":\"6152ff897a86e23b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeDefinitionRegistry.js\":\"e4ef1ff1de857ae5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeExtraction.js\":\"549363676009ff14\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeInitialValues.js\":\"bdde0ecd5c475658\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typePropertyGroups.js\":\"15664410e08260a8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeSeeds.js\":\"bff6b267d592fa9b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typeTagger.js\":\"7b02b77b1488d2e8\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typedRecords.js\":\"7f256f3020b71db6\",\"/knowledge-medium/pr-preview/pr-1884/src/data/typesPage.js\":\"984907e58d762d28\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userPrefs.js\":\"42b8bafc910b4da9\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userSchemasService.js\":\"40741e5cac4709fc\",\"/knowledge-medium/pr-preview/pr-1884/src/data/userTypesService.js\":\"ecf8cbc4307cdf36\",\"/knowledge-medium/pr-preview/pr-1884/src/data/valuePresetRegistry.js\":\"fdf50a4b231765f5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/visibleChildren.js\":\"d522cb237eb5f8d5\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceConversion.js\":\"9d0e3113177670db\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceFirstSync.js\":\"374231ef431b88dd\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceIdNamespace.js\":\"944b2f26792cb93f\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaceSchema.js\":\"62ee4352bfb4458b\",\"/knowledge-medium/pr-preview/pr-1884/src/data/workspaces.js\":\"00e06d104c466afa\",\"/knowledge-medium/pr-preview/pr-1884/src/data/writeAheadLog.js\":\"06ab3ae4ac18a233\",\"/knowledge-medium/pr-preview/pr-1884/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/BlockPasteShellDecorator.js\":\"80108e493119c1e4\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/atTrigger.js\":\"cdc1a0a640ded4a8\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/autocomplete.js\":\"adf10ef7d05c986d\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/codeMirrorExtensions.js\":\"71bdd016969cfc76\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/contentFlush.js\":\"7fa2b9438c26466e\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/defaultInteractions.js\":\"3dcb485200a266d8\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/editSettleSignal.js\":\"395289b3f3f6f453\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/insertImage.js\":\"2957377114968589\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/referenceCompletionRange.js\":\"cf585d5dccac5b06\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/referenceTargetTypes.js\":\"43396d878b4b2bd2\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/syntaxContext.js\":\"837c7ebbc98f8eca\",\"/knowledge-medium/pr-preview/pr-1884/src/editor/triggerMatch.js\":\"58cfa592d81a5c7a\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/AppRuntimeProvider.js\":\"1c7b736314b36eb0\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/BlockFocusShellDecorator.js\":\"01b0257bbf1648c1\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/ExtensionRenderBoundary.js\":\"1abaca01ac03bdc7\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/PanelContentRecovery.js\":\"4a6af21664f9a448\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/apiCatalog.js\":\"def049a8abd2d30c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/approveExtensionHere.js\":\"ab94dcf5a761935c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/armedCutAppMount.js\":\"796acf4988e17575\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/batchableKeyedStore.js\":\"dd0c765c06cd5c9a\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/blockInteraction.js\":\"eee1c4740828b29b\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/blockSelectionAction.js\":\"b2bcfb8fbcca348e\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/compileExtensionModule.js\":\"f65d98dfe0cee331\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/compiledModuleCache.js\":\"3418b5512c568f17\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/continuousGestures.js\":\"ec123ed594652292\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/core.js\":\"184bd58bfb8ca23d\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/defaultRenderers.js\":\"a3e615ca29b0d2b8\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/definitionFanoutAppMount.js\":\"5c6d8e7a50ab35a0\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dialogAppMount.js\":\"80c87b250a930c17\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dynamicExtensionSeeds.js\":\"f8eaf667268ee557\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/dynamicExtensions.js\":\"21407dc7ce524fdc\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/exampleExtensions.js\":\"4cf9c2a67d142cd8\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionApprovalStatus.js\":\"df574478223f15cb\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLoadErrorToast.js\":\"e3b5bbc6eefd8f36\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLoadErrors.js\":\"ed0277b8a6a293e2\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionLookup.js\":\"ab672a29a338809a\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionToggles.js\":\"16c04507bbb43ed2\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/extensionUtilitiesCss.js\":\"b18b67737efc8252\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/kernelPageDeletionGuard.js\":\"f07e94376a076112\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/liveRuntime.js\":\"0d1b60763bfffe7b\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/openExtensionsSettings.js\":\"e00713a689123c1f\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/overridesCache.js\":\"ff071997373fe87c\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/pluginIds.js\":\"0e2e97260c97e895\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/processorRejectionToast.js\":\"caaa0bbf8d0b1024\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/runtimeActions.js\":\"6e53765d900d92d6\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/runtimeContext.js\":\"182f819d7c290297\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/staticAppExtensions.js\":\"65f8ee899551d648\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/staticDataExtensions.js\":\"d3e8f39b320fc5b6\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/toastAppMount.js\":\"b2244b6c70dc2758\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/useOverrides.js\":\"cdf5eb5ab81488a2\",\"/knowledge-medium/pr-preview/pr-1884/src/extensions/useShortcutSurfaceActivations.js\":\"462a25a34a6860fc\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/discoverToggleTree.js\":\"800db7f93a4958c8\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/facet.js\":\"2ac6a76490f929f0\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/resolveAppRuntime.js\":\"b97edbde68b78eea\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/runtimeEvents.js\":\"3d060ecf5056135f\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/togglable.js\":\"0b4edacb7794a765\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/variantFacet.js\":\"53a832bf224ea556\",\"/knowledge-medium/pr-preview/pr-1884/src/facets/verbFacet.js\":\"454a35e8825884f6\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/block.js\":\"cd360379fdcfcc23\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/focusedChild.js\":\"c7047879c4cc9155\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/propertySchemas.js\":\"704f215d41364877\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/typeRegistry.js\":\"db72596ab88af555\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useAncestorCrumbs.js\":\"7a40e14c99083d44\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useAutocompleteListbox.js\":\"8a1a96f6c77c5a4e\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useDebouncedSearch.js\":\"ec2f5bcb69d954dc\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useDebouncedValue.js\":\"dab845eeaefd415e\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useFacetValue.js\":\"e03eb3339bbb9687\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useIsFocalRender.js\":\"d799b78bca02f2ec\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useIsReadOnly.js\":\"004c564516a42f3b\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useMaterializeBacklog.js\":\"165e1e1183a7ef25\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useMinuteClock.js\":\"fdcfae949d509a22\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/usePanelLayoutProjection.js\":\"4c218b5c3133b529\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/usePendingInvitations.js\":\"a80635e9974f355b\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useRendererRegistry.js\":\"0fa1eb9b657150bf\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useRetainedFieldRows.js\":\"3fd2c4469dce8b1b\",\"/knowledge-medium/pr-preview/pr-1884/src/hooks/useWorkspaces.js\":\"be3bee6fb8ee7244\",\"/knowledge-medium/pr-preview/pr-1884/src/lib/utils.js\":\"fb788aa4f6578db8\",\"/knowledge-medium/pr-preview/pr-1884/src/main.js\":\"84957e1e2f1c3bb8\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/MarkdownImage.js\":\"2a0990f30bfa1d38\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/blockSeparators.js\":\"fad3dac4bc87b648\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/context.js\":\"0fda6727f69d4a5c\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/defaultMarkdownExtension.js\":\"ae7b22b6307ce200\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/extensions.js\":\"0160278ea8b85b2c\",\"/knowledge-medium/pr-preview/pr-1884/src/markdown/renderMarkdownHtml.js\":\"7b9474c8f8fd7f65\",\"/knowledge-medium/pr-preview/pr-1884/src/minimal-editor.js\":\"47b4b55239445b78\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/armedCut.js\":\"ca3214d429260393\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/captureMediaVerb.js\":\"b3f43b457ebf0519\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/clipboard.js\":\"132433e31726ba64\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/decision.js\":\"93d705ababc64362\",\"/knowledge-medium/pr-preview/pr-1884/src/paste/operations.js\":\"19f66e19ce675d7b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/account-header/AccountHeaderItem.js\":\"b6ef00ce5c2c1044\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/account-header/index.js\":\"9957ed33b6fa64e0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"2886f692c0571998\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/askAgent.js\":\"08fd3a21cd030aed\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/askedStore.js\":\"f250991326e7da52\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"21e4efe247f595ae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/chipState.js\":\"e26d7b4c820a6ad3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c14bf8123b4c5115\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/index.js\":\"3f89de4326b36673\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"f217990a73c1fa28\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-dispatch-companion/schema.js\":\"7ad27d3664a6b1c6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a9d7a42aa937755f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5987250b811963b4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/addMedia.js\":\"420f6591b8e4c27e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b9fc0b559a3e8f27\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/block.js\":\"2f81c88906ffd739\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/context.js\":\"e14a72defe6878c5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/displayIds.js\":\"804b2165729e8be8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/index.js\":\"05086e98d9e17cc1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/outline.js\":\"8153c218df44796d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/properties.js\":\"efb27024dfd81434\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/refs.js\":\"74c09fa910dc0bce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"820062e5318f929d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/search.js\":\"6e4356305d8cac29\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/shared.js\":\"6acaa76fcb5fbc43\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"1d90cfe215a8c181\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentViews/text.js\":\"49db9d4400dd318b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/agentWrites.js\":\"dc6c93c718476736\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/authoringCatalog.js\":\"94b588fbf2d20b6d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/blockRefTargets.js\":\"12c8a50eef9f5fa2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/bridge.js\":\"226a83658157a393\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/bridgeLoop.js\":\"59e991f94d7f8d73\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/changeHistory.js\":\"34d2dcf525249a41\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/commands.js\":\"011efd7072ce68f5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/commentsCommands.js\":\"36acb1194444e7bb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dataExtension.js\":\"fa88483a4a2ba221\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dataModelGuide.js\":\"66ae0b70679778a8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/dayPropertyInputs.js\":\"eb49e73ada6f5bae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/describeRuntime.js\":\"46995922c121a316\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/extensionLint.js\":\"ec6c27c0e1d07680\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/grainAudit.js\":\"89cdb63dccbca34d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/healthCommand.js\":\"608ada19c7c44c73\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/index.js\":\"0c42f79a060c223a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/presetIdentity.js\":\"d754c6f3368f66cf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"fa116a792b9cc934\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/readMedia.js\":\"a753540e004a4a1a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/schema.js\":\"ed726ee87fdbd557\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/serialization.js\":\"5c6a36dc5e744e0d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/targets.js\":\"5ee48c323fce40ec\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/tokens.js\":\"b59bb05fdafc8787\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/watchEvents.js\":\"c59c633417e52f81\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/workspaceGuard.js\":\"b7657c9f60b73838\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/agent-runtime/writeCommands.js\":\"430549bad0ef481f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/AliasCollisionToast.js\":\"ac20c22f71820e5c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/DuplicateNameBanner.js\":\"8b3f9d7f9c66e4b9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/collisionMerge.js\":\"cf526a7a55dac495\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/dataExtension.js\":\"9ede7b1fa1b78a72\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/index.js\":\"28e9dfa7ad998a02\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/mergeCollisionAction.js\":\"e6da56ed9a12d76d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/pageStyling.js\":\"cc44c49c14b0651c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/rejectionToast.js\":\"179c51fa156fa06e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/alias/syncProcessor.js\":\"9f0bd149985a784d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/actions.js\":\"a96e59830809f2a8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/addComment.js\":\"5e087431c098d56d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/anchor.js\":\"14442c31b0fa50ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/anchorState.js\":\"eb6303b6ebbd25a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/commentLinks.js\":\"cd1510fa6125883f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/confirmThreadDeletion.js\":\"f40d8dae83420f69\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/container.js\":\"83c71a1e96f26925\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/dataExtension.js\":\"887f198ade683674\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/deleteComment.js\":\"e043511d8c4abfea\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/highlights.js\":\"4b68206940564f9a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/index.js\":\"4adf82c577b0d1ce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/linkedCommentsPill.js\":\"894d50ddc47e10e7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/margin.js\":\"d7b837fdcb1ec825\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/marginAnchorLinks.js\":\"e15379f1ca28c828\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/marginSchema.js\":\"b681850f7f6f214d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/newComment.js\":\"3bce9b91c18ff9ee\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/ownThreadPicker.js\":\"0d03d4fd5d5db2fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/placement.js\":\"fd4c60facdfbd555\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/queries.js\":\"6b0e030fa8a87570\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotePosition.js\":\"ea724ff899fb9717\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotedIn.js\":\"90061b247e783372\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/quotedRange.js\":\"83652621bce84512\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/rangeRefs.js\":\"b91d3362a7b56f41\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readHighlights.js\":\"074a98f5353108a0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readSelection.js\":\"2849711c69e29174\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/readSelectionUi.js\":\"ec0de4e81b261c52\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/reanchor.js\":\"bb3ceec8fe8ed917\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/schema.js\":\"4bebc89bf12815b3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/scope.js\":\"ea95c9494ff4684b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/scopeThreads.js\":\"054a95fc09d9e17c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/splitRetarget.js\":\"08b1c3cc9eed800d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/suggestionCard.js\":\"86b65e6dc2e82352\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/suggestions.js\":\"b2a2bdf6bd68f445\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/summaries.js\":\"558bd1d7ff878607\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/summaryBatch.js\":\"bd09b5cf7155a2f4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/surface.js\":\"ac3e082b3f317192\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/threadNavigation.js\":\"17fbf2a15f673633\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/threads.js\":\"e16149d5e63469a5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/ui.js\":\"e2fec415e9d907ce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/annotations/uiStore.js\":\"27af2ad0739a8076\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-intents/appIntents.js\":\"8ee42c1ed6d32310\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-intents/index.js\":\"0d6b3a6e0f24eb5d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-update-prompt/index.js\":\"20b9c6206ddc40cb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/app-update-prompt/status.js\":\"0d9873e4f3751fce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"2a486d5e5d1f3c2d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaBlockRenderer.js\":\"181012b9b3b44fc9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaDownLaneReplicator.js\":\"db798079b66e4f50\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/MediaUploadReconciler.js\":\"58fecd13dc4d944f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetDownLane.js\":\"cb3cdbec6da3dcaf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetResolver.js\":\"1585d66120563c18\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/assetUpload.js\":\"4ad7ce0acd86816e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/attachmentCleanerIO.js\":\"73179e79b35a25de\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/supabaseAuditIO.js\":\"35d3cb59bedea426\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/blobStore.js\":\"45c2b78bfd1afa88\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/browserMedia.js\":\"96f70084063a29fe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/byteStore.js\":\"a9d880b28359573d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/cleanerIO.js\":\"6cda62ffc1f63d1f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/cleanupAttachments.js\":\"13564551742a73c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/dataExtension.js\":\"b1bd821fd2be2ac6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/downLane.js\":\"4d9d564d2fd0dbb9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/index.js\":\"dd5b934f853b8388\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/insertImageContribution.js\":\"f21a74a562c5c59c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/laneArming.js\":\"ead892dd670123f8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/laneLock.js\":\"684add1eac061b04\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaBlock.js\":\"cb4946a3d39d16d7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaCapture.js\":\"fa37007d4a8d7872\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaLanes.js\":\"5f734acaa32b5e50\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaViewers.js\":\"61ff929cad716c39\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/mediaViewersFacet.js\":\"2385fb356ad123d2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/pasteCapture.js\":\"c5ce787cc7fbbe61\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/resolver.js\":\"87f3182660081e67\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/retryUploadsAction.js\":\"93d2c862702f7e2c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/storagePaths.js\":\"bffd275d0a148ce1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadDrain.js\":\"d1a0719d2b7f96ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadLaneStatus.js\":\"0f9bbe1fb2a0b873\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadReconcile.js\":\"9856d3008ddbafd2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadRecovery.js\":\"0cbd2670412cdda4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/uploadStore.js\":\"c347a7dbb87c344f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/attachments/useAssetObjectUrl.js\":\"64d4450d25dc451d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"8c84564450c1cf7b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d3a471e41ea93ba9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/facet.js\":\"aabebc6e3c4f9c56\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/index.js\":\"bd28c06993988e8e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks-view/prop.js\":\"fe32021a786966c5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BacklinkFilters.js\":\"d313c785078fa033\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"c18447745a5b3d57\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/BlockEntry.js\":\"51250aeed19354df\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/LinkedReferences.js\":\"b985481f974566fa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"812d6edc3e4532e7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/dailyNoteDefaults.js\":\"180e5354e91dc8b6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/dataExtension.js\":\"056f77ad360a97df\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/edgeExclusions.js\":\"f392425ab29708ed\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/filterProperty.js\":\"8d707b6fbcdbbc6a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/index.js\":\"48eae86b9a817b24\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"bfe8a47f09d9b4f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/applies.js\":\"d0a64296af70eb89\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/countQuery.js\":\"6731ea6e68c795ea\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/expansionStore.js\":\"c5c6c784f2f160f4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/index.js\":\"0c4630f618b2cf8f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"90efae0f1279c812\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/presentationInvalidation.js\":\"4a22fe67e757c6e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/propertyEditorOverride.js\":\"1a5c7df9f7407574\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/propertyFilter.js\":\"e614e1c8a143d081\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/query.js\":\"a199a162ed1c5235\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/resolveFilter.js\":\"6da6bb2daf2cb5cd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/sourceBatch.js\":\"6981cc0ca6964d9f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/sources.js\":\"c6ffa63133732f22\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/useBacklinks.js\":\"56e2246cdd2ecc95\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"15a61cb9cc5ad040\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/BirthdayCelebration.js\":\"5d3bdfbb49cc509c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/BirthdayOverlay.js\":\"5a4c4331f93f6464\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/gate.js\":\"269d5ada0190a9f4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/index.js\":\"5918f73d975d2432\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/birthday/wolfTheme.js\":\"bc9a95709756d3b8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/BlockDragLayer.js\":\"d097928e73955ac4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/dragController.js\":\"5455cf5876fd9072\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/dropTarget.js\":\"15753f6a5e7356be\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/index.js\":\"efb58a39e8abbb37\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-drag/projection.js\":\"31d933612fabb780\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-info/BlockMetaCard.js\":\"4a3bb63214d75751\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-info/index.js\":\"38074934220ae4d6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/AddTagDialog.js\":\"17fe5b9597a3dfe7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"840d959322647ab6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/TagNameIssueHint.js\":\"d8fd2363377ca165\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/addTagAction.js\":\"cef4ae0925da99ea\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/appendTag.js\":\"d67401526dde57b2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/config.js\":\"f7193169cb943773\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/dataExtension.js\":\"b892c812a37d062d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/index.js\":\"59e77acaceee9d00\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/block-tagging/propertyEditorOverride.js\":\"e686f60c5c836f3a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/BreadcrumbList.js\":\"40e3a130f6a06128\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"7a7248aa0cda24a1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/Breadcrumbs.js\":\"37ff8656a7caf0aa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"79ae24631266821a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ebc7e1214e2c028d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/index.js\":\"831991287d94103d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"63b992f97cc0538c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/CharacterCountItem.js\":\"62e6bb3325770ae0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/ProfilePropertyEditor.js\":\"79a6f45ae9c271f9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/actions.js\":\"163d6bd249726501\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/blockType.js\":\"361180bda8c1e879\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/charCount.js\":\"8a5783a21a8f6471\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/dataExtension.js\":\"d6be51e1f432894c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/index.js\":\"17956b99e0a28d5f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/profiles.js\":\"caa6284c4b44457b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/properties.js\":\"4f4325b9de79f440\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/character-counter/textCounts.js\":\"9f208d13a56b5439\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/colemak-keybindings/index.js\":\"0575fe0d92eed9e9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/CommandPalette.js\":\"b688f67ec0b280b3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/HeaderItem.js\":\"1f582d3af5bf8f76\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/context.js\":\"dadab42dee1ea7f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/index.js\":\"5e878b0068b85880\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/selection.js\":\"b22ecf4ef85ada11\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/toggleStore.js\":\"378d29d673bdb74e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/command-palette/useCommandPaletteActions.js\":\"3497480cec1c49ce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/ContributorBadges.js\":\"8b8d7b63c7115024\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/author.js\":\"fd5475b533580730\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/codeMirrorExtensions.js\":\"66c92293ebf15fd3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/dataExtension.js\":\"62f851a01cdec108\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/index.js\":\"2c96f4916d0f6606\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/mentionAutocomplete.js\":\"4e2baee13be1ce9a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/processor.js\":\"2ef83412c00d746c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/profiles.js\":\"37d1a55259061e38\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/queries.js\":\"4b655086a76860e3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/contributors/schema.js\":\"962a3164e3b60844\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4c319db9d040a47c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/followOrigin.js\":\"13f22afd1aa89ccd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/index.js\":\"669cb099e694a1d5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"9ae4782c7c9d1815\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b043c9c198ab8942\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/CalendarGrid.js\":\"8c6f1cec1d473fd4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DailyNotePicker.js\":\"68fd27c5d32c7be8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7d6a0b716983e65a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateNavDecorator.js\":\"8b296d41fe6306d3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DateScrubOverlay.js\":\"1391ceb84f91f51d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/DayReferencePanelEditor.js\":\"cc49d5bd24fd9ead\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/HeaderItem.js\":\"449b8fc62f12423b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/ReschedulePicker.js\":\"05600cd37d18d565\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d984ea380ab75f90\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/actions.js\":\"41a326dfa61841ec\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/blockDateAdapter.js\":\"fd0ff55101174a82\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/calendar.js\":\"5c32c632082ffb8d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dailyNotes.js\":\"70428b1abdbd29fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dataExtension.js\":\"55be53495d819a9d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubActions.js\":\"6f49f770fd5c4f75\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubGesture.js\":\"bfaa04f2d8d5d110\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubGestureActions.js\":\"90c05136dde8f060\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e7041833a8eabdc1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dayProperty.js\":\"e0f5d41f60460704\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/deletionGuard.js\":\"3341d8449fe8e099\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/dueQuery.js\":\"c2f58c038295e7c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/index.js\":\"7baf1f6d2bdbeca4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/landing.js\":\"c7f26cc9f7a37226\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/localSchema.js\":\"00167aff16ee948d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/referenceDateAdapter.js\":\"e5dcacc2e39d0db1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/rescheduleAction.js\":\"35ca3cc8a090edf7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/schema.js\":\"64f242309ad50142\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/spreadBlockDates.js\":\"84514cc8f3e9f8ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/spreadDatesAction.js\":\"0525b15bebfc58f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/today.js\":\"15aef1751b60379d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e8f02fa97fb5f14e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"93bdbad9a39e9f56\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/audit.js\":\"f60dd01ba32c8d4f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/auditAction.js\":\"1e1624c74f25aa81\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/auditRanges.js\":\"96fc38d70ef3995d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/diagnosticsSource.js\":\"6b80ed7858de0b0b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/divergenceScan.js\":\"4d990941beb4fb52\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/index.js\":\"fb803d52f7755343\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/propertyChildrenChecks.js\":\"70b684e2808cd682\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/referencesMirror.js\":\"e3e8c758706397ba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/rowJson.js\":\"7dbeb8adc62b87f6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/schedule.js\":\"9798d14e00abf6c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/data-integrity/store.js\":\"14176cec017536fa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/action.js\":\"4ac77aefa0593632\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/index.js\":\"6baab855bc588750\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-maintenance/plugin.js\":\"cde1b18ab5330ac0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4aa8e80612f4d57a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/actions.js\":\"21045add82cb9589\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/changeMarker.js\":\"43e6a32801db92fb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/diagnostics.js\":\"102eb0830d5a520a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/fileSystemAccess.js\":\"a3f7e87aeb007aef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/filenames.js\":\"a206f089caeee29c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/index.js\":\"be1d5a49dfdec472\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/mirror.js\":\"f58014bf67d3251a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/runLock.js\":\"89e26fb40b8597e6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/runtimeHealth.js\":\"6c92ed9b808616b5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/schedule.js\":\"aadc1e0ac86f89bd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/db-mirror/store.js\":\"714d904d118166a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/default-themes/index.js\":\"f9aba470073a22da\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/default-themes/themes.js\":\"f4253fe68c1da130\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/diagnostics/facet.js\":\"d3430c25d62e6002\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/diagnostics/useDiagnostics.js\":\"8617854f9ae2c27f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/dismissals.js\":\"1b2d568f3ce3d21a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/index.js\":\"f96e52c4d667adbd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/status.js\":\"484be0d18ab65c17\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extension-prompts/store.js\":\"9dedc818ccf1263a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a2701b463010082c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/ExtensionsSettings.js\":\"fc5e4befd9d3431f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/actions.js\":\"b6281b71b96efb4a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/config.js\":\"7f185adf0ba4783f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/dataExtension.js\":\"f4d661b11bcbedd6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/effect.js\":\"52b3d48ab8bce90a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/index.js\":\"12f16ed74d3b8715\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/propertyEditorOverride.js\":\"e9d17f3782f8c966\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extensions-settings/useToggleTree.js\":\"b342361c95a94c69\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/ExtractTypeDialog.js\":\"ecef0cc73782728a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ad06cdec39fc5e39\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/PropertyShapePicker.js\":\"ba9dfc68cdd752b1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/action.js\":\"03d0ffc50ecd8ec5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/extract-type/index.js\":\"12e90bd0074cc9a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/FindReplaceDialog.js\":\"db0874353985227f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/HeaderItem.js\":\"ce4100d312065a70\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/dataExtension.js\":\"59650d9f582ae1ab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/index.js\":\"5031dd60c52cc4ab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/search.js\":\"ba9900ec56477679\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/toggleStore.js\":\"28d94d82013d0577\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/LocationPropertyEditor.js\":\"74460e4c40ec9ca7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/MapView.js\":\"3cc3515f401c2d66\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/blockTypes.js\":\"5cb4a84847e7c8f1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/codeMirrorExtensions.js\":\"5f55c415e88a68f1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/createOrFindPlace.js\":\"b8b7ac2f696e3e81\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/currentLocation.js\":\"680eaeea0a1d9fbf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/dataExtension.js\":\"27aaecc28ad1bac8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/geoContentDecorator.js\":\"0c98837d41fdd887\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/googlePlacesClient.js\":\"e89e16c23d9245a4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/index.js\":\"e76c5005d6dc6637\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/locationsPage.js\":\"94e33ca912f3a230\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/mapViewport.js\":\"f3e3ec81b44ce633\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/pickCurrentLocation.js\":\"d9013b94209d6a7a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/placeAutocomplete.js\":\"cf140356b3b91c27\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/placeNameCollision.js\":\"f4209b62b6f3ecfb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/properties.js\":\"1b18d00c76ce772d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/propertyEditorOverrides.js\":\"aff9f393c83684a7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/query.js\":\"26a27b9290ac09c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/geo/usePlaceSearch.js\":\"33c6b9c3e579275e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"2b2107076ec01649\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e48cafba2c3d59dd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6ead434e4d181ba8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/config.js\":\"e4a418b09ebfdb13\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/dataExtension.js\":\"0996690983242bc4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/facet.js\":\"2a4c546113dd7aab\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/grouping.js\":\"2127b8f061adad8f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/index.js\":\"809f5007c1ce6c8d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"5e4f4d679c61c17f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/query.js\":\"35edc628f8f0b2a2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/resolveConfig.js\":\"32a1c8d15980cd86\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c8b3d1f8b16ab666\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"01cb9019801ce153\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/HtmlDocumentContent.js\":\"b8412414680f440f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/HtmlFrame.js\":\"d76f854f1f7d6d70\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/actions.js\":\"f37bf16c51902026\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/blockType.js\":\"0124c972c7f8b3ad\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/confirmRunScripts.js\":\"faf647f8988ff0fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/dataExtension.js\":\"c4a4d3e30ab755e1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameAnnotations.js\":\"e770cfee19b8745e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameDocument.js\":\"b647ff6600e82698\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/frameTheme.js\":\"683962548318da1d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/index.js\":\"8a2efa661b47c5e9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/scriptConsent.js\":\"dc2f980c36de0691\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/sourceMap.js\":\"2e8aab01bfd0a211\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/html-document/useDocumentScripts.js\":\"339b69d555270ffb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/index.js\":\"689bb573dd8c47f4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/record.js\":\"742cc346fad6de14\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/recordStore.js\":\"a4cb83c22aa45a30\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/responsiveness.js\":\"5e2cbd2531b952fc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/schedule.js\":\"93c0667d9ff9cc34\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/interaction-metrics/sessionContext.js\":\"5d081f2554544b4b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"0773eac9b4e30394\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"9cc909114dbce5ec\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/actions.js\":\"625ccc3f3c88f13c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/config.js\":\"078c1fa9fad8a400\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/dataExtension.js\":\"693a7c7b98c585bc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/effect.js\":\"15e20e372f37aa07\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/index.js\":\"656c69e971d553f4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/keyCapture.js\":\"9a086c2c27252d5a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/overrideStore.js\":\"621bd5722889a707\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e33bee4efd047e73\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/HeaderItem.js\":\"893462cb67df8529\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/LeftSidebar.js\":\"82be7fdfde0f3d01\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/actions.js\":\"39b86cd01aec223e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/facet.js\":\"a21d436665dec464\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/index.js\":\"9b688fab9062b400\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/shortcuts.js\":\"595c7d158f7e73f0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/left-sidebar/toggleStore.js\":\"8e50d642bf4e4398\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/MergePicker.js\":\"c0dce8558a817b23\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/index.js\":\"4946f83ed0b8e010\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/mergeAction.js\":\"9d7e0f1c6341b23e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/merge-blocks/strategy.js\":\"18b7396cf997f7e5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/Button.js\":\"a8c1699811389066\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"fc979f4359036e69\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/defaultItems.js\":\"39d6de2b27d0d32a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/facet.js\":\"2fbd445b724ca640\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-bottom-nav/index.js\":\"61e1f76ffc3e4f9a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"8fcdc0df3ab42c84\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4370dbe99cd6d194\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"1c276f001aa8877a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/facet.js\":\"41c31b6393ca3b1c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/mobile-keyboard-toolbar/index.js\":\"557996b9a6eb5373\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/MoveDestinationPicker.js\":\"fb1076be9c466984\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2e243be7b079e43a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/contextMenuItem.js\":\"41ad220af09d3163\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/index.js\":\"10566bb3427685f0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/moveAction.js\":\"02fb628447dc8316\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/moveBlocks.js\":\"f7b81b80ef0d780d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/move-blocks/selectionAfterMove.js\":\"5411f6696ab230c6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/TutorialBanner.js\":\"d7de6b007e689e91\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/action.js\":\"8512115797f2aab6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/bannerDismissal.js\":\"ccdc16dd210840e9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/documents/cheatSheet.js\":\"2d4929c6f3b61bc3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/index.js\":\"7b93c5e67a6ce13d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/keys.js\":\"5b42230583db7c32\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/landing.js\":\"9f9b5424b56bbe99\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/outline.js\":\"7b1c9b595d1b61ec\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/onboarding/seed.js\":\"df6344375ce68e06\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/PerfTrendDialog.js\":\"66d01d0ef51e35c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/analyze.js\":\"6eea5f0b7b392de5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/diagnosticsSource.js\":\"156fec4dfd228388\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/index.js\":\"8eeb0701f8ce38b7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/load.js\":\"6954c994ddd1b777\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/monitorRun.js\":\"9a98e0c1ba80cc9b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/schedule.js\":\"a3c9f1cd7e7f6cc8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/series.js\":\"ccba721f9aff0d64\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/store.js\":\"d8a55a3cedf0d10f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/trendAction.js\":\"ba2c726cfbf59d6a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/perf-monitor/verdict.js\":\"00a056444b2285c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/clickToEditAction.js\":\"72813f777de90809\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/index.js\":\"b6a581848a277315\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/plain-outliner/interactions.js\":\"f064d184078633f2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"81be99a78e49a083\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/MigrationGate.js\":\"5d6a027d01cdbb5b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/MigrationGateDialog.js\":\"bedfa3de294cc52d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/action.js\":\"24fa81984b3366af\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/index.js\":\"242370d3e851f2e4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/localRunMessage.js\":\"a13dfa8118e5b650\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/plugin.js\":\"f14458ddc35bcafa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/progressReport.js\":\"1b35ebadf56e14ff\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/properties-migration/sweepProgress.js\":\"89f3fb885f405ce2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/FieldRowRenderer.js\":\"5b9ce188eb1e9bf8\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/ValueRowRenderer.js\":\"41ac9d5ba7731489\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/actions.js\":\"5798171191d859c7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/autocomplete.js\":\"35b900bec7a77dd3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/fieldRow.js\":\"15c6886f3ed666ae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/index.js\":\"cce5edf474a1897b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/referenceWarning.js\":\"20889d9c8fbc4c7a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/valueAutocomplete.js\":\"b89ee3332c84a82b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/property-rows/valueSchema.js\":\"44f410245031f61c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/HeaderItem.js\":\"b4667fd2c76a5132\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/QuickFind.js\":\"f8baa80d9849be58\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/index.js\":\"c9b1427362763680\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/recents.js\":\"9522a2f6b0df2f37\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/resultItems.js\":\"0ca6e1567f56e489\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/selection.js\":\"c7dd1c368e37e423\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/quick-find/toggleStore.js\":\"acf92e1d3ddc8841\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/HeaderItem.js\":\"f20f9340bef87d8a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f6568eb6f41da8bc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/grouping.js\":\"82a8e328cbe6ea98\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/index.js\":\"f68ac276cd3b4793\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/recents/target.js\":\"f97469ed395b6699\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/codeMirrorExtensions.js\":\"91f57112ac865bf3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/contentPrefill.js\":\"b3dc97b4df8918b3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/dataExtension.js\":\"276b6d49b4d0b0f6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/index.js\":\"6060efd583889587\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"9597cf004a2b213d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/invalidation.js\":\"3b35bb3e89b25505\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/localSchema.js\":\"e27b67d3f5eed64b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/blockrefs/index.js\":\"b19577189603756b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"5c72e33bdfb00fec\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/index.js\":\"77a444b3a21ee4f3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/referenceNode.js\":\"368b02f115509115\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/remark-reference-occurrences.js\":\"815a405f0d9bfb79\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"841ae456233984d5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/index.js\":\"8e795614bf5e4fb5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"dcc20e1e75a46dda\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"778fc48c86e73a47\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/mergeRetargetProcessor.js\":\"4337f33c769d698f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/parseFence.js\":\"c5d1f34f1da15725\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referenceParser.js\":\"98e4e3ce8e6cf31e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referenceProjection.js\":\"1bb183e8f74e4e31\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/referencesProcessor.js\":\"d180df09746a608e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/renameProcessor.js\":\"9304b83b8ac3ff1b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/references/spanReplacement.js\":\"1c709d18da287c2c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/htmlToOutline.js\":\"30ff31386d66f7a4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/index.js\":\"8f2b9f98b33e1a1c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a4069c6fd8076100\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/rich-paste/pasteDecision.js\":\"21f7a6851afbb432\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/action.js\":\"23dfce5a3de7d842\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/blockIds.js\":\"84f1aa288ace67f7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/content.js\":\"4f06306fc34d4dc4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/effect.js\":\"be0b35e9405da402\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/ids.js\":\"664a10eba9537e5b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/import.js\":\"48af1b2d2d529fcd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/index.js\":\"7fc93f9f05c21358\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/plan.js\":\"26937d99a4566a5a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/plugin.js\":\"bf870d09e756d9ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/promotion.js\":\"5c4cc4afe5582a54\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/properties.js\":\"0ab74311617e260a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/references.js\":\"3d13aa061645c70c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/report.js\":\"eb62db94dab3321a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/roamMemo.js\":\"a8acd8a3d32ef426\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/runtime.js\":\"8ceb06229ae450c2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/schemaReconciliation.js\":\"5414778383176a99\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/srsMarkers.js\":\"5358d81dd12cc28a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/todo.js\":\"2147d66d1abbcf3d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/typeCandidates.js\":\"0c93e8280504306a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/roam-import/types.js\":\"2faa6369c9541b5a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/search-health/index.js\":\"baeb4eeb1a11eb5a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/search-health/store.js\":\"9f74db99b1b04c32\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/HeaderItem.js\":\"3d9ef73dcb8be9e6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ceae807d0ed70b8e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/index.js\":\"b0c7295ca1c85009\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/model.js\":\"f52cf61c598631bb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/toggleStore.js\":\"b5f6926fbd784d59\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/shortcut-help/useKeyInspector.js\":\"3746b3de84ac3b64\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"66c82f732989e0dd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/ShellDecorator.js\":\"1d85ea4ca1468e5f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/actions.js\":\"37e8ba900fc11aa4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/exclusionsFacet.js\":\"b0aec628a57053e7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/index.js\":\"b04162e759dd490d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/shell.js\":\"2771f4a46e16012f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/surface.js\":\"1d029ad21f33fbba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/spatial-navigation/walker.js\":\"b4f91f2625719936\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/RescheduleToast.js\":\"04deb8cd90b2b421\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/dataExtension.js\":\"ebdff0da0c560722\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/index.js\":\"a8468dbae8e1f890\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/indicator.js\":\"fcc142745005cc3e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/moveSrsState.js\":\"3198621012610a78\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1ae90705789d061a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/scheduler.js\":\"925dae9c7a02b774\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/schema.js\":\"dfab4d43224319a4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"b9babd4bfc1efc94\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/srsClipboard.js\":\"5cef9f80e5940fbe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"16dbf640b042ba4a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/DailyNoteReviewHint.js\":\"0a32285e9873fe8a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/DeckPicker.js\":\"47b11bc37703fd3b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewControls.js\":\"aa569dbd3591e852\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7d72cf7ebb946f28\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/ReviewSession.js\":\"bafa3fec0d61ee99\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/actions.js\":\"4ec1bbe3b7e15ba6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/archive.js\":\"307e3eb640b89e0a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/dataExtension.js\":\"876f9a8bfd57c1d4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/deck.js\":\"d322ad688348eaa3\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/dueQuery.js\":\"2dda09820278d0dc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/gradeDecision.js\":\"49318be15343c2a6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/index.js\":\"dd69a9f03b8dfeae\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/keyHints.js\":\"2cdd443e7831e163\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/reviewCardLayout.js\":\"adf05e3bac3db7e0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/reviewProgress.js\":\"ebf9109f34a7a38a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/schema.js\":\"e7553fb0b914bb15\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/srs-review/useDueCards.js\":\"fd00394607bc77c6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/startup-metrics/index.js\":\"1286abed5c5878ac\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/startup-metrics/record.js\":\"f1836c22f28094fa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/index.js\":\"9851d5f12944980e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/persistenceStatus.js\":\"70ab46606c1e16e6\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/storage-persistence/requestAction.js\":\"0dcaa369edd50939\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/TypeChipsDecorator.js\":\"2332c122cab1d812\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/codeMirrorExtensions.js\":\"f06de56e5e41673f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/index.js\":\"76e922773824313a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/supertags/typeAutocomplete.js\":\"e60057ec6a36f209\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6f7837285da8710e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/actions.js\":\"0b9f1de95a3afbc1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/anchor.js\":\"4b1e7834031355fe\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/events.js\":\"79cf620f0c895159\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/gestureActions.js\":\"1fe32683ae93ebda\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/index.js\":\"f996444f850a8961\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"49e61099f4637f2a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/collect.js\":\"0dddaddd59a34d55\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/index.js\":\"6b80a47f63f0387b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/sync-metrics/record.js\":\"f54c89b779e198dc\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/RejectionDialog.js\":\"e432b940eda425aa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/SystemStatusHeaderItem.js\":\"99767ec6668121cb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/index.js\":\"8ccba7ac4ef3e17f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/model.js\":\"14cb0212efe932c9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/queueCounts.js\":\"891225aa066ada3e\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/rejectedHelpers.js\":\"11b33b942b15a59d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/rematerializeAction.js\":\"7db6a616f6ca55ef\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/system-status/useHysteresis.js\":\"0ab891298860d0a2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/ColumnHeaders.js\":\"2d583b71b0056652\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/QueryUi.js\":\"1307d6479f125f8d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/TableLayout.js\":\"ba375c28c025cbb7\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/actions.js\":\"3021346a4cfb4d33\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/cellEdits.js\":\"03a1fd2a4b7591cf\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/childrenViews.js\":\"e395a61c5cfb2f3b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/columns.js\":\"713bc1cb45e07a3c\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/controller.js\":\"6455feed151620b4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/convert.js\":\"06aec26a8b7b9def\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/dataExtension.js\":\"2c057ff266246a62\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/index.js\":\"5c621a3a85cb82bd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/keys.js\":\"92b78403ec636dc1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/model.js\":\"86b94a9af16eb82f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/backfill.js\":\"f4dc88c8d071608f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/completion.js\":\"645dbd429678af4a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/format.js\":\"09070205a4ff5496\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/parse.js\":\"c059f201134c9ac0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/queryValue.js\":\"fc55a8b7a5526125\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/registrations.js\":\"08e5ea315fdb47ce\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/query/source.js\":\"4abb293b5a5a12fd\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/registry.js\":\"09fec61ab667f862\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/rowGutter.js\":\"3a755f61e11f8d0f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/rowVerbs.js\":\"7705e2560fe50074\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/schema.js\":\"29b4112a36a1a330\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/tables/sort.js\":\"5acfe740cc1366a0\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/effect.js\":\"3c909002d009c6a2\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/index.js\":\"ec43333d1bde6dba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/theme-toggle/theme.js\":\"1e388e6d6e12091f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/actions.js\":\"bd25405a6c54d3b1\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/dataExtension.js\":\"49da340c32d6e1a4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/index.js\":\"ff0e052db53d7b20\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/todo/schema.js\":\"d29bc4a822fa5b66\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/TouchSelectionLayer.js\":\"838fe26924b7033d\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/actions.js\":\"da53553f31b8e71b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/defaultItems.js\":\"67ee532e3d19e683\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/facet.js\":\"31a7f68b9aa5ce78\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/holdRecognizer.js\":\"d38d448e3fd6bd30\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/touch-selection/index.js\":\"a406b92e0cd6a717\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/UpdateIndicator.js\":\"f7941d0eaa0d6ad4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/index.js\":\"aad38e17b8d7e2c4\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/update-indicator/loadTimes.js\":\"251d45eddc8d5c04\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoNotesRenderer.js\":\"e7fe0fb7bb34194f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoPlayerRenderer.js\":\"db7ae1645a54e56b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/VideoTimeStamp.js\":\"8dd736daad6de204\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/actions.js\":\"f5f84c9cb3bbd67f\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/index.js\":\"8c3dc5610ecfc5ca\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/markdown.js\":\"b3cc443d288bbab5\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/notes.js\":\"bb5c598d296688e9\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/registry.js\":\"6576a9af1ee9e8cb\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/remark-timestamps.js\":\"be2d43a879255dba\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/video-player/view.js\":\"638e108e9b175958\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/LinkHints.js\":\"051d9e60c1da796a\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/index.js\":\"9484913f3c6dbc51\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/model.js\":\"7d98d57d0ed5af81\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-link-hints/settings.js\":\"efd7dad394dd2400\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/actions.js\":\"8ed825617b911593\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/index.js\":\"00d0975d308a880b\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/vim-normal-mode/interactions.js\":\"275ba37dc46190fa\",\"/knowledge-medium/pr-preview/pr-1884/src/plugins/workspace-header/index.js\":\"e272e8d93d56d8d4\",\"/knowledge-medium/pr-preview/pr-1884/src/registerServiceWorker.js\":\"1ffc720929ddd96a\",\"/knowledge-medium/pr-preview/pr-1884/src/requestPersistentStorage.js\":\"9c54f944ecb3ec7c\",\"/knowledge-medium/pr-preview/pr-1884/src/services/authRequestDeadline.js\":\"54d734a6253ece2d\",\"/knowledge-medium/pr-preview/pr-1884/src/services/authStorage.js\":\"d149533976e9daf1\",\"/knowledge-medium/pr-preview/pr-1884/src/services/powersync.js\":\"c65a51c5687916d2\",\"/knowledge-medium/pr-preview/pr-1884/src/services/supabase.js\":\"e8ceffb4782d2df9\",\"/knowledge-medium/pr-preview/pr-1884/src/services/uploadErrorClassifier.js\":\"ced1fcce635d92be\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/ActiveContexts.js\":\"1531fed7fa9a7227\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/HotkeyReconciler.js\":\"b2816a62edc6476f\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/WipeLocalDataDialog.js\":\"86ef4217db2d1ae4\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/actionDispatch.js\":\"16c5afcb46ddc38d\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/actionRefItems.js\":\"65fb278706f0dab0\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/applyKeybindingOverrides.js\":\"fbed0b175c7603e8\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/blockActions.js\":\"d3be5aa6f9de6401\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/blockMergeGesture.js\":\"8d85a027bbb8f962\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/canonicalizeChord.js\":\"56930bf5de4d0f38\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/defaultContexts.js\":\"4699f7ff1c73d258\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/defaultShortcuts.js\":\"17f1b77a8ff4d01c\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/effectiveActions.js\":\"42bf0f60a162c406\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/gestureAction.js\":\"8ca5201e39d0c068\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/gestureBinding.js\":\"b6323b24623eee50\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/holdRegistry.js\":\"cdd7dc8fccc869c5\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/keybindingConflicts.js\":\"61f7b1852f1b0494\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/keybindingOverrides.js\":\"4e89a060e7b6a115\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/pointerAction.js\":\"7fe918015462e232\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/resolve.js\":\"0025a8c2fde4c026\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/runAction.js\":\"bb8e7391832be313\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/sequenceMatcher.js\":\"5ba422a85df710d8\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/types.js\":\"107493dc087994f7\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/useActionContext.js\":\"95e8d4a9419d9144\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/useActionDiscovery.js\":\"61054c3f3ab30feb\",\"/knowledge-medium/pr-preview/pr-1884/src/shortcuts/utils.js\":\"b62505a3657a59bb\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/bootStore.js\":\"9cdaba96d2251bbb\",\"/knowledge-medium/pr-preview/pr-1884/src/sw/previewDatabases.js\":\"3fd02652b32bab0d\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/byteTransform.js\":\"0a176baca6b12f02\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/attachmentCleaner.js\":\"70386a1bd08eb9ed\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/attachmentParts.js\":\"26f96e275a4da15b\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/bundleParts.js\":\"b9e5aae09d154180\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/bundleRecord.js\":\"a14e07afbf3003c2\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/manifest.js\":\"be59213e2bc56bcf\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/takeBundle.js\":\"dede2ce280938b24\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/bundle/verifyBundle.js\":\"40a2b7ebfa505546\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/cleaningStage.js\":\"2386341b610932c0\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionKey.js\":\"46aff37885c330ef\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/conversionServer.js\":\"1fa5039607cd6848\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/flip.js\":\"48642b7e46e0b56c\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/flipAttempts.js\":\"71b3dd02080a433a\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/pages.js\":\"d0f82340e6b6b3a1\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/preflight.js\":\"578e41debe18cfde\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/reseal.js\":\"97e745f2169f4648\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/runConversion.js\":\"243fe3fa9e418e74\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/runLock.js\":\"1f6ddd2ed98ebd7e\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/sealing.js\":\"20d87860c0edf2ba\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/sealingStage.js\":\"559ed5725cc19e9e\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/stage.js\":\"fabfaa3f9bb4b37a\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/conversion/verifyReseal.js\":\"565c12793d7523a6\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/aad.js\":\"237cd7d8ba7d88e9\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/aead.js\":\"5514602c4d0f2648\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/base32.js\":\"0499e96d8b542968\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/base64url.js\":\"d82bd2634c9d0e28\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/binaryEnvelope.js\":\"5a3816e4d25a037e\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/byteAead.js\":\"0a4e7f4551b26328\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/canary.js\":\"068f3dad83aa6599\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/contentHash.js\":\"ea0d8c8ae0ea4086\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/contentKey.js\":\"8156a8bb98d5563a\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/derivedIdNamespace.js\":\"395880dea304a332\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/envelope.js\":\"ae35c5a3dcb0f2f8\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/hex.js\":\"32020ce7c847432a\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/sha256Hex.js\":\"79639647173a739b\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/crypto/workspaceKey.js\":\"ca0e639fd54bd1dc\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/conversionState.js\":\"c720f6ac0a05352a\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/createEncryptedWorkspace.js\":\"c389eb63219d795f\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/pastedKey.js\":\"d779de1a0754dd38\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2073a2b7c08ed66f\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/flows/upgradeWorkspacePin.js\":\"15da4b5504b2d0ec\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/keyStore.js\":\"cca1684b0d40585a\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/mintWorkspaceKey.js\":\"44b4423f61ddf400\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/modePin.js\":\"330f4aaaf906c190\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/openWorkspaceKeys.js\":\"bd7d9bdd2fe5d806\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/resolveWorkspaceEntry.js\":\"ce813c60fdf92eb5\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/resolver.js\":\"77f6a5f9241feb8b\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/keys/workspaceAccess.js\":\"05bf4a4492ed958c\",\"/knowledge-medium/pr-preview/pr-1884/src/sync/transform.js\":\"3e17a56d831d3a6b\",\"/knowledge-medium/pr-preview/pr-1884/src/themeBootDefaults.js\":\"ea3a90391a1f3834\",\"/knowledge-medium/pr-preview/pr-1884/src/types.js\":\"de21dddad382d2ac\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/ClientLocalSettings.js\":\"a752144e57eb227d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/abortableSleep.js\":\"a810caf49276ed8c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/array.js\":\"2257d430b92635e8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/backlinkAutocomplete.js\":\"780cc632481bcddb\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/blockCrumbs.js\":\"9eb583e37b17d367\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/blockrefAutocomplete.js\":\"0618c2edf6d5c73a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/cadencedIdleJob.js\":\"444287aebb222dbd\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/callbackSet.js\":\"d24c4df34bf6032f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/clientId.js\":\"95fd88cd3c5b11b0\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/codemirror.js\":\"6e0cb36a26207637\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/codemirrorCompletion.js\":\"d54c5449e2d0381b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/copy.js\":\"242d020299e8cad8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dailyPage.js\":\"81400422b55b19ae\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dbForensics.js\":\"76bc7dae4a3e1ea7\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dbForensicsHooks.js\":\"52062e1b43ea4dfe\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/deleteBlockThroughUi.js\":\"8c5efcb1a29f2bca\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dialogs.js\":\"0cfbad56670bd044\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/dom.js\":\"e9a3154fcb32026f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/downloadBlob.js\":\"25e4053df5c31b60\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/drawnWalk.js\":\"f35a59b19bf5e0e8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/exportSqliteDb.js\":\"4cff533ab2cb8edf\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fileSystemAccess.js\":\"aec8ef7082581314\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/flipSlide.js\":\"030bd9585a0f7690\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fnv1a.js\":\"802be059f0a8decc\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/formatBytes.js\":\"fd0f38ffa7888cc2\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/fuzzyRank.js\":\"dc166225f179d2eb\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/idbKeyedStore.js\":\"b5391d22170f758e\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/idleCallbackPolyfill.js\":\"b473b85b9d0aa541\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/keyboardAwareScroll.js\":\"7e7663cacbfeff8a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/keyboardViewport.js\":\"6017fde4090d7e55\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/lastWorkspace.js\":\"78688dae99941033\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutColumns.js\":\"081a96ac99545de7\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutSessionDom.js\":\"742bdec5760ab61a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/layoutSessionId.js\":\"abdfc7a9086e28f2\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/linkClickGestures.js\":\"f1bdeb1fcf149222\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/linkTargetAutocomplete.js\":\"480f634674ae577f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/localDbCorruption.js\":\"0438565d37f0a879\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/localDbRecovery.js\":\"11fdbf94129f054d\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/markdownParser.js\":\"2fdcf0c475dedb76\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/memoize.js\":\"50dd5b269624c852\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/nameFieldCommit.js\":\"322fb0e7a02a6927\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/nameList.js\":\"8da1ff188b591909\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/navigation.js\":\"a1a7a775bdb53ee9\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/omnilinerNamespace.js\":\"c7d8a167ea72b617\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/opfsPageScan.js\":\"2b5c4bb07d8dd2be\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelClearance.js\":\"e09b0ca26ed117f5\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelHistory.js\":\"c61439503656bd79\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelLanes.js\":\"89b5098b4d53186f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelLayoutProjection.js\":\"86299e35f40bce4c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelScrollAnchor.js\":\"c026b2eccf7fefde\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/panelUrlFlags.js\":\"2c3b5ff8eefd3044\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/platform.js\":\"2070d69782cf46c7\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/pluralize.js\":\"db4c3f1da59a93b9\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyCreation.js\":\"cba240801b192578\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyNavigation.js\":\"1395f2d679407197\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/propertyValueContext.js\":\"b4ebc80a45bf768a\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/react.js\":\"b67fab0d2a589289\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/relativeDate.js\":\"dd16a2525d73dffa\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/relativeTime.js\":\"0aee88b7e313e9d5\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/renderScope.js\":\"d1da79e836eb9046\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/resolvedThenable.js\":\"c10b75f644a6ab94\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/routing.js\":\"3893fd1e2eb3293c\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/safeMode.js\":\"c4d820279129a4a8\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/scheduleIdle.js\":\"e92a20545f1f92eb\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/screenWakeLock.js\":\"3054632f44638d1b\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/selection.js\":\"a5168e2fac56d497\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/softKeyboardGrab.js\":\"c0d2afd7845149c0\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/startupTimeline.js\":\"ea1fe930e8df4e85\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/state.js\":\"26405ca004e27b88\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/string.js\":\"e19e5ef21087a023\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/surfaceZoom.js\":\"a8d60fae98e65a3f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/time.js\":\"9b8459c312ddd087\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/toast.js\":\"53be05335f7b3508\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/toggleStore.js\":\"7a51737a715e2b3f\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/untilStopped.js\":\"1afd99e7ce9362d3\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/userActivity.js\":\"56483c2e9aef5693\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/viewTransition.js\":\"4e6459935c78bed2\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/viewport.js\":\"75579c018ea06b70\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/webLock.js\":\"d1c1822e944c66cf\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/workspaceRecovery.js\":\"1b3c8176a2ab62f6\",\"/knowledge-medium/pr-preview/pr-1884/src/utils/workspaceSnapshotStore.js\":\"d0158e07eef2045f\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-compiler-runtime.js\":\"6ce4f8c110b3203c\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-client.js\":\"fd54d37393a0ab9c\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-server-edge.js\":\"58d474ac71b91309\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-server.js\":\"03a0c7823c905b65\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-static-edge.js\":\"931dfaf47008ba78\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-static.js\":\"90f774665abd82f0\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom-test-utils.js\":\"2f80dfaa06088675\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-dom.js\":\"512752c66b1156e9\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react-jsx-runtime.js\":\"9840849d380fcb2b\",\"/knowledge-medium/pr-preview/pr-1884/src/vendor/react.js\":\"2febc447201d6d5b\",\"/knowledge-medium/pr-preview/pr-1884/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1884/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1884/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
