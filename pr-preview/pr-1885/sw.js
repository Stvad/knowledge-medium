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
		buildId: "258b50c79028-21543190",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1885/\":\"0514e2586167fdf6\",\"/knowledge-medium/pr-preview/pr-1885/index.html\":\"0514e2586167fdf6\",\"/knowledge-medium/pr-preview/pr-1885/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1885/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1885/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1885/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1885/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1885/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1885/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1885/assets/FacadeVFS-BEA4bXRc.js\":\"e31ca45f7aeed5b4\",\"/knowledge-medium/pr-preview/pr-1885/assets/OPFSCoopSyncVFS-Pa42VKLc.js\":\"56880f9bd72e08bb\",\"/knowledge-medium/pr-preview/pr-1885/assets/OPFSWriteAheadVFS-wqcepo5V.js\":\"c9ebbf11f0380d0c\",\"/knowledge-medium/pr-preview/pr-1885/assets/wa-sqlite-BoFS5RED.js\":\"ab5d535fa1d8503a\",\"/knowledge-medium/pr-preview/pr-1885/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1885/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1885/assets/wa-sqlite-async-CtlLozeS.js\":\"1a35bd904dd72081\",\"/knowledge-medium/pr-preview/pr-1885/assets/worker-CeBdWffy.js\":\"8fcc1e8eccdcaa91\",\"/knowledge-medium/pr-preview/pr-1885/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1885/chunks/app-BH24-13C.js\":\"860c58718ca9117d\",\"/knowledge-medium/pr-preview/pr-1885/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1885/index.js\":\"11da50e77b500137\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1885/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1885/assets/AccessHandlePoolVFS-D7qkRMTq.js\":\"10e7691ee36dba17\",\"/knowledge-medium/pr-preview/pr-1885/assets/IDBBatchAtomicVFS-CGTRitD2.js\":\"5d7cbc074ee8857f\",\"/knowledge-medium/pr-preview/pr-1885/assets/MemoryVFS-BRcnzeRH.js\":\"d8511efc1c0a6599\",\"/knowledge-medium/pr-preview/pr-1885/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1885/assets/mc-wa-sqlite-async-BvI5Sqtf.js\":\"57c3cc94e74230f0\",\"/knowledge-medium/pr-preview/pr-1885/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1885/assets/mc-wa-sqlite-tR0x7wJO.js\":\"0515ba460145f721\",\"/knowledge-medium/pr-preview/pr-1885/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1885/chunks/AccessHandlePoolVFS-PWjrBIIn.js\":\"4e67954abb270c47\",\"/knowledge-medium/pr-preview/pr-1885/chunks/FacadeVFS-C1ntcJC9.js\":\"84927c12331dd355\",\"/knowledge-medium/pr-preview/pr-1885/chunks/IDBBatchAtomicVFS-DOAv650F.js\":\"d765912c1331053e\",\"/knowledge-medium/pr-preview/pr-1885/chunks/MemoryVFS-W135cM9g.js\":\"db32b5a4c556f075\",\"/knowledge-medium/pr-preview/pr-1885/chunks/OPFSCoopSyncVFS-BU9dJP-J.js\":\"fae0c78ba526d551\",\"/knowledge-medium/pr-preview/pr-1885/chunks/OPFSWriteAheadVFS-7Nzwclxz.js\":\"998dcd3d62bed9df\",\"/knowledge-medium/pr-preview/pr-1885/chunks/Preview-CLeD5vlj.js\":\"bedde5226f486b8d\",\"/knowledge-medium/pr-preview/pr-1885/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1885/chunks/card-pb2Cvz6Q.js\":\"814ee6ef44e4e766\",\"/knowledge-medium/pr-preview/pr-1885/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1885/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1885/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1885/chunks/dist-DDqaUz5f.js\":\"71efdef03a30cd0f\",\"/knowledge-medium/pr-preview/pr-1885/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1885/chunks/mc-wa-sqlite-DrkZqFGx.js\":\"ee00074b8218db0c\",\"/knowledge-medium/pr-preview/pr-1885/chunks/mc-wa-sqlite-async-D-QnxCi0.js\":\"0bc985c379c96cb7\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-7XXTMnBL.js\":\"2cc5b76a06d5d326\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-B5A-uedK.js\":\"4115b089578c0197\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-BMV8hfka.js\":\"197de7d3df1010ac\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-CAPPzCEu.js\":\"16b90ac4fdbbdd8e\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-CiiukOsB.js\":\"996752962fa9b68c\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-DqNHXqem.js\":\"7a748dda58016538\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-XS6UD_74.js\":\"7cbbc2f2ab0797f7\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-dom-server-legacy.browser.production-As8JInBo.js\":\"8d6f0e870dc33415\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-dom-server.browser.production-CiEGCWIc.js\":\"63c410ed8d69de0d\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-dom-server.edge.production-CEZuN3WB.js\":\"43d4dba7dbf74ec6\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-sR-oRdGv.js\":\"fa1f75f145ddbee3\",\"/knowledge-medium/pr-preview/pr-1885/chunks/server.browser-BoTm5Ew4.js\":\"e5ffc7bec8397452\",\"/knowledge-medium/pr-preview/pr-1885/chunks/textarea-D43dLccH.js\":\"bc4e6257222da9ae\",\"/knowledge-medium/pr-preview/pr-1885/chunks/ui-3UTjyWmN.js\":\"d68ddee1cf920ff0\",\"/knowledge-medium/pr-preview/pr-1885/chunks/wa-sqlite-DKhZTeeS.js\":\"da0600f9f8389406\",\"/knowledge-medium/pr-preview/pr-1885/chunks/wa-sqlite-async-B62ov03s.js\":\"32f2a1a7ff3c2f01\",\"/knowledge-medium/pr-preview/pr-1885/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1885/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1885/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1885/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1885/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1885/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1885/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1885/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1885/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1885/src/App.js\":\"1006945985507182\",\"/knowledge-medium/pr-preview/pr-1885/src/appUpdate.js\":\"3da2f3dd04666c80\",\"/knowledge-medium/pr-preview/pr-1885/src/appVersion.js\":\"9969a79dd3588ea3\",\"/knowledge-medium/pr-preview/pr-1885/src/bootstrap/initialLayout.js\":\"6e53495b255f4492\",\"/knowledge-medium/pr-preview/pr-1885/src/bootstrap/openWorkspaceData.js\":\"168752ff4dd1b210\",\"/knowledge-medium/pr-preview/pr-1885/src/bootstrap/resolveWorkspace.js\":\"b8feb61c42dded3b\",\"/knowledge-medium/pr-preview/pr-1885/src/bootstrap/workspaceBootstrap.js\":\"354d8409e5176a13\",\"/knowledge-medium/pr-preview/pr-1885/src/components/BlockComponent.js\":\"5beb8e114e7bd063\",\"/knowledge-medium/pr-preview/pr-1885/src/components/BlockCrumbs.js\":\"72c32576bc28d8ac\",\"/knowledge-medium/pr-preview/pr-1885/src/components/BlockEditor.js\":\"d90650862f3d9bc6\",\"/knowledge-medium/pr-preview/pr-1885/src/components/BlockLoadingPlaceholder.js\":\"4c65c94cc02506eb\",\"/knowledge-medium/pr-preview/pr-1885/src/components/BlockProperties.js\":\"a3afa2d6f8bbfd7b\",\"/knowledge-medium/pr-preview/pr-1885/src/components/BlockSearchPicker.js\":\"8d750ce1eba82d39\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ConfirmBulkDeleteDialog.js\":\"18ffb9b75bcdb586\",\"/knowledge-medium/pr-preview/pr-1885/src/components/DividerHandle.js\":\"2310b4e7041f8af0\",\"/knowledge-medium/pr-preview/pr-1885/src/components/DraftEditor.js\":\"0b5537d07d18258f\",\"/knowledge-medium/pr-preview/pr-1885/src/components/GutterPill.js\":\"39b90c7aae4d9c6b\",\"/knowledge-medium/pr-preview/pr-1885/src/components/Header.js\":\"bc4d606aad16bbcc\",\"/knowledge-medium/pr-preview/pr-1885/src/components/LazyBlockComponent.js\":\"87582c70d24b2365\",\"/knowledge-medium/pr-preview/pr-1885/src/components/Login.js\":\"a35d16eebf74b29c\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ZoomableSurface.js\":\"29e46e08caf7b67e\",\"/knowledge-medium/pr-preview/pr-1885/src/components/editModeKeepalive.js\":\"bcbb7cf0583ecf44\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyDisplay/PropertyDisplayScope.js\":\"ddc7642138e88eca\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0cd3ca43e6e7282a\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/RefPropertyEditor.js\":\"e70ff41b8c1f3485\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/RefTargetTypePicker.js\":\"ac06871040312dcc\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/SelectPropertyEditor.js\":\"91824ddd3b9c7552\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/TypesPropertyEditor.js\":\"0f436412fda92c09\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/defaults.js\":\"516ae07c359543a6\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/kernelValuePresets.js\":\"ccb9a6ef4d98a992\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/selectablePresets.js\":\"a896fd849a2b9a96\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/typesPropertyUi.js\":\"9252f40981accf84\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/AddPropertyForm.js\":\"c8e4726cefcd62e4\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/PropertyPicker.js\":\"3bd0bd6a3d7c2470\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/PropertyRow.js\":\"91548e384a165d1e\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/Rows.js\":\"4fbf493de56e17bf\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/actions.js\":\"1b197eada1422acf\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/declarationOnly.js\":\"7328908db01323e9\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/layout.js\":\"52798fb917f10127\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/model.js\":\"6368a4807382d222\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/shapeUi.js\":\"ad1b6193607b458e\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/shapes.js\":\"d9f48f27016b5365\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a4ce16f61b293b7d\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/visibility.js\":\"982348b1cf4ee190\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanelSections.js\":\"a849f4545afa11ce\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/BlockEmbed.js\":\"28549c0619e1c700\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/BlockLink.js\":\"8b7436bb69ecddb3\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/BlockRef.js\":\"6388e2119b091eb5\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/ReferenceLink.js\":\"d035428ebf00e9d1\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/cycleGuard.js\":\"049b14cb4be87ca2\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/cycleGuardContext.js\":\"56e3f1ba197b53e3\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/linkInteraction.js\":\"ddc3da3ed598be1b\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/referenceLayout.js\":\"0bd0ca3f0cc405fb\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/useBlockRefAncestors.js\":\"3cd41085fd657a88\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/BlockGutter.js\":\"f6832a611f6e8b3b\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/BlockInfoDialog.js\":\"609a7ec1734290dc\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/BlockTypeBlockRenderer.js\":\"563053fdf64800b2\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/BulletHoverCard.js\":\"81025af631820b5f\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/CodeMirrorContentRenderer.js\":\"6527caa615f5c707\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f9e3964e44a2b655\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/ColumnResizeHandles.js\":\"594efdd64428da91\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"96b7447650daf6ed\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/DefaultBlockRenderer.js\":\"24005276e0884374\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/LayoutRenderer.js\":\"f602b8e9a59e2739\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/MarkdownContentRenderer.js\":\"753929ed5d183d0f\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/MissingDataRenderer.js\":\"d02082e1f8372c8c\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/PanelRenderer.js\":\"77a33cffcd5cd126\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/PropertySchemaBlockRenderer.js\":\"100e0f2afb495165\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/TopLevelRenderer.js\":\"c8efc9e10b90dd3d\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/blockGutterMode.js\":\"e8f4a2365fe08830\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/blockTitleText.js\":\"ef99379a98cbdfa6\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/fieldCreationKeydown.js\":\"3892de0c0625dc77\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/layoutRootContext.js\":\"16f5b14f9c152f6c\",\"/knowledge-medium/pr-preview/pr-1885/src/components/typeChip/TypeChip.js\":\"82c47401cc1bd14f\",\"/knowledge-medium/pr-preview/pr-1885/src/components/typeChip/chipStyle.js\":\"1cfa352fc422d9a4\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/anchored-floating.js\":\"4c1d73ee04ee7dd6\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/button.js\":\"b20a3529cd9fb9fc\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/card.js\":\"eeb6498e1fab13ca\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/checkbox.js\":\"8fc7179f742cb4e3\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/collapsible.js\":\"7012f74be74b9b70\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/command.js\":\"da775a72164a290f\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/context-menu.js\":\"3ac840b7dcb2a66b\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/dialog.js\":\"c045cbe890cc9115\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/dropdown-menu.js\":\"2d1e39521787f74e\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/floating-listbox.js\":\"4511b0e4050a2846\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/index.js\":\"28ec213f5f93f085\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/input.js\":\"c9e62a0c519ac0ec\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/kbd.js\":\"14c1de8f01f092f9\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/label.js\":\"c2a0fc1c8eac9645\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/textarea.js\":\"7833426031448b5e\",\"/knowledge-medium/pr-preview/pr-1885/src/components/useEditModeYieldKeepalive.js\":\"7f7f06c270db1bd7\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/BootFallback.js\":\"dcd4bee74a78ce5b\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/FocusedRowLazyMount.js\":\"6ffd566bb86612c1\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/LazyViewportMount.js\":\"43456f0cab45c347\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/LocalDbCorruptionFallback.js\":\"796fef39acd8007e\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/error.js\":\"526157b2181e7c78\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/lazyMountRegistry.js\":\"e63beddd59e2fb3d\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/suspense.js\":\"26feea221c67d6ab\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/CreateWorkspaceDialog.js\":\"7406e72898ee8fa9\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/PendingInvitations.js\":\"c52ca81744e82a54\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/SyncProgress.js\":\"4bddfa074ed709c6\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/UnlockProgress.js\":\"014c5721e32dc0b5\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/WorkspaceKeyGate.js\":\"ce938dedb6da108d\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/WorkspaceSettingsDialog.js\":\"e3ca1a94d739856d\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/WorkspaceSwitcher.js\":\"d2a8901d8e347e15\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/WorkspaceSyncGate.js\":\"7fd0a653384d8104\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/ConversionFlow.js\":\"e164ff3f3173593a\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/ConversionFlowHost.js\":\"a01a58a0718cc93e\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/EncryptionSection.js\":\"f46d7a5958f43cb7\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/attachmentPrompts.js\":\"ecd0a351bec7b3fa\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ba9c91e667f228c7\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/conversionFlowDeps.js\":\"bee585d8c0eda5a7\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/conversionFlowStore.js\":\"71e9440d820d3a11\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/flowUi.js\":\"99c48fba73cdc748\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/useConversionRun.js\":\"8f2d08970d8040d1\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/keyUi.js\":\"193e19f6275a22eb\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/useCloseOnKeyLoss.js\":\"67288c8b32e38bce\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/useCloseOnServerE2ee.js\":\"ed3eb4689ffd6379\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/workspaceUnlocked.js\":\"124503ecce3e97c1\",\"/knowledge-medium/pr-preview/pr-1885/src/context/backgroundSubtree.js\":\"f7c7f776ba248776\",\"/knowledge-medium/pr-preview/pr-1885/src/context/block.js\":\"49b9e25686b43395\",\"/knowledge-medium/pr-preview/pr-1885/src/context/layoutWsContext.js\":\"ad1976be28b542d6\",\"/knowledge-medium/pr-preview/pr-1885/src/context/propertyDisplay.js\":\"c120ba0a31f768ab\",\"/knowledge-medium/pr-preview/pr-1885/src/context/repo.js\":\"6d6bf31a23215b83\",\"/knowledge-medium/pr-preview/pr-1885/src/data/aliasClaim.js\":\"c649b9ad8d44e55d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/aliasSeatNamespace.js\":\"7a5ff77b03cdedbc\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/blockData.js\":\"18b80a5b17f347cc\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/blockType.js\":\"cf42e4b3e929bb64\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/changeScope.js\":\"1d638b1b4b0b035e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/codecs.js\":\"5674abb8aa831440\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/derivedData.js\":\"e484a75fe4db0dca\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/errors.js\":\"ef7b48d53124e57d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/events.js\":\"3f1db6abab99b5ca\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/handle.js\":\"6fa70056d482a954\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/index.js\":\"b4c2b02b1426bba4\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/mutator.js\":\"32b530a047298876\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/processor.js\":\"f78111fef45e5d94\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/propertySchema.js\":\"992282d13e5306ca\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/query.js\":\"d2ee2c7e52599073\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/sameTxProcessor.js\":\"b866dec067de21b3\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/schema.js\":\"6fa70056d482a954\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/tx.js\":\"6fa70056d482a954\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/typedBlockQuery.js\":\"c9b2c5c7ce30f009\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/user.js\":\"953f123969ffd1e0\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/valuePresetCore.js\":\"7f524d85efb9120b\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/valuePresets.js\":\"56bf7f7291281523\",\"/knowledge-medium/pr-preview/pr-1885/src/data/attachmentCleanerIOVerb.js\":\"33ed4ac4817458ff\",\"/knowledge-medium/pr-preview/pr-1885/src/data/block.js\":\"d4c608eb29e32962\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockCache.js\":\"4b3145c4aa7fe45f\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockId.js\":\"05e2e769b1f9dc3e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockLiveness.js\":\"dcd038877b7e69a5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockMerge.js\":\"a8f95142bc58afeb\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockSchema.js\":\"fb85f5251c26d014\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockTypeLookup.js\":\"21e379208bc689b6\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockTypes.js\":\"cda5d23ed24169de\",\"/knowledge-medium/pr-preview/pr-1885/src/data/childrenView.js\":\"3602afbead297549\",\"/knowledge-medium/pr-preview/pr-1885/src/data/clientContext.js\":\"41b15b7331afede1\",\"/knowledge-medium/pr-preview/pr-1885/src/data/dbFileSiblings.js\":\"09a02cf6501d3990\",\"/knowledge-medium/pr-preview/pr-1885/src/data/definitionSeeds.js\":\"c051cb3d10e9c5bb\",\"/knowledge-medium/pr-preview/pr-1885/src/data/derivedIds.js\":\"51a2c32add753055\",\"/knowledge-medium/pr-preview/pr-1885/src/data/drawnSubtree.js\":\"00845d17ef3970a1\",\"/knowledge-medium/pr-preview/pr-1885/src/data/facetBridge.js\":\"0320879e83bb7215\",\"/knowledge-medium/pr-preview/pr-1885/src/data/facets.js\":\"929f5a58137efd75\",\"/knowledge-medium/pr-preview/pr-1885/src/data/globalState.js\":\"229c908d1da84b26\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/aliasClaimRederiveProcessor.js\":\"a38d8f4ed7a2e2d0\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/ancestorBatch.js\":\"b85dee075fefa53e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/blockTypeTypeifyProcessor.js\":\"00c5e5ab12307567\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/clientSchema.js\":\"9380cb4660afd0f7\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/commitPipeline.js\":\"cd4a188ec087b1e3\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/devAssertions.js\":\"aa9e9047c9fb0673\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/firstSync.js\":\"8b5e2f0893b982f5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/freshInitialLoad.js\":\"eb5b142c4f2d8f88\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/graphBackfillClaim.js\":\"080c4f6b29604721\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/handleStore.js\":\"a7ca6705f0be6c93\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/idleMarkerJobs.js\":\"8f11bc27c96fef09\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/initialDownload.js\":\"4306449d798f378a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/initializeClientDatabase.js\":\"397875ca79b4e9ff\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/jsonCanonical.js\":\"ff05ce69d4718aa9\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/kernelInvalidation.js\":\"4b63dc759b1e6568\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/kernelProcessors.js\":\"e0fdbc7b1441dc83\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/kernelQueries.js\":\"c7d6afe30e814ec3\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/mergeTypeMembershipProcessor.js\":\"ec66b2fa5281f67e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/normalizeReferencesProcessor.js\":\"6ce0e7ee41019c20\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/poolInstrumentation.js\":\"8201f7943be747bd\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/processorRunner.js\":\"caed135cf33b6ab7\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyCellBackfill.js\":\"0757ad7eb7bd6116\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyChildMint.js\":\"b57e0cb5014d3610\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyChildrenProcessor.js\":\"fd1070919b9f42df\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyDefinitionChangeProcessor.js\":\"ee802101df3856de\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyDefinitionSynthesis.js\":\"697d0564f11cb16d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyKeyScan.js\":\"aae45e806afa7137\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertySchemaResolution.js\":\"3acbaf747a8081ad\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyValueEdits.js\":\"d869efb75fdd1563\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/raiseProtocol.js\":\"d05b743dd79d909a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/readBatch.js\":\"2f9605c761379284\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/refProjection.js\":\"9f2d62b6bb7ce53c\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/referenceTargetLookups.js\":\"f726dc22b24a2efc\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/referenceTargetProcessor.js\":\"a1f3c1af6e5dc0f0\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/replayMerge.js\":\"f70bcdd59871db97\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/sqlBinds.js\":\"1cd5c4aaffbb6b39\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"37b81a87824bdf4e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/syncObserver/arrivalProcessors.js\":\"bd05aefbc7b4598d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/syncObserver/invalidate.js\":\"21b81d081afedf23\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/syncObserver/materialize.js\":\"93fe400bd83d78b0\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/syncObserver/observer.js\":\"8de25e1b11f5af44\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/syncObserver/reconcile.js\":\"076ad6214e3deb4c\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/timingMetrics.js\":\"09fc7484689035aa\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/treeQueries.js\":\"a213839eb097d87c\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/txEngine.js\":\"447ec2d4e71a75d2\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/txSnapshots.js\":\"a3e237b23ccd84c9\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/typedBlockQuery.js\":\"84890b867a7c8b6d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/undoManager.js\":\"723818348e74f15e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/invalidation.js\":\"b41960a2957d0366\",\"/knowledge-medium/pr-preview/pr-1885/src/data/kernelDataExtension.js\":\"8a3098649caa1a8b\",\"/knowledge-medium/pr-preview/pr-1885/src/data/kernelPage.js\":\"21809c8753e8f320\",\"/knowledge-medium/pr-preview/pr-1885/src/data/kernelValuePresetCores.js\":\"1854166402528c3f\",\"/knowledge-medium/pr-preview/pr-1885/src/data/localDbCorruptionSignal.js\":\"ec2b97040cc6282d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/localDbStorage.js\":\"9289c77c4b93ef3b\",\"/knowledge-medium/pr-preview/pr-1885/src/data/localDbVfs.js\":\"07bd92a1b2e6af0b\",\"/knowledge-medium/pr-preview/pr-1885/src/data/localSchema.js\":\"f9db64034ac0f633\",\"/knowledge-medium/pr-preview/pr-1885/src/data/maintenance.js\":\"750786045d502294\",\"/knowledge-medium/pr-preview/pr-1885/src/data/mergeProperties.js\":\"aeeeebd76367dd65\",\"/knowledge-medium/pr-preview/pr-1885/src/data/metricsConsoleHook.js\":\"69ff3a720a4285ff\",\"/knowledge-medium/pr-preview/pr-1885/src/data/migrationsPage.js\":\"7b65c3034fc1352e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/mutators.js\":\"6617a453b5757105\",\"/knowledge-medium/pr-preview/pr-1885/src/data/orderKey.js\":\"b1c4f457f53a85c5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/orderKeyPlacement.js\":\"e307cfe3eb4a2a5c\",\"/knowledge-medium/pr-preview/pr-1885/src/data/outlineSurface.js\":\"f1d9fcc5c23affaf\",\"/knowledge-medium/pr-preview/pr-1885/src/data/pendingEditorContent.js\":\"f31fe79a03453a86\",\"/knowledge-medium/pr-preview/pr-1885/src/data/pendingUploadsSql.js\":\"712efbc3fa80a21f\",\"/knowledge-medium/pr-preview/pr-1885/src/data/pluginStateExtensions.js\":\"1eba90dfce281bd8\",\"/knowledge-medium/pr-preview/pr-1885/src/data/powerSyncLogger.js\":\"b8095e8fb0cb6f64\",\"/knowledge-medium/pr-preview/pr-1885/src/data/projectorRuntime.js\":\"76c55c96db7cc83d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/properties.js\":\"eea3f35418205203\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertiesPage.js\":\"cfbeb9018b4e199f\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertyChildren.js\":\"6ed169ac5708175c\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertyDefinitionFanout.js\":\"9706f5fb5a19c14f\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertyDefinitionMetadata.js\":\"7f769047876a9283\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertyDefinitionRegistry.js\":\"96522f647ff94ec4\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertyDisplayMode.js\":\"f456b5a490ae67cf\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertyRowCreation.js\":\"e76b43c5ac7c0ab2\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertySchemaCreation.js\":\"49691f4f42b63e78\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertySeeds.js\":\"53eab50d4dfea533\",\"/knowledge-medium/pr-preview/pr-1885/src/data/recentsPage.js\":\"4282c03f1e12520e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/refTargetComparableProperty.js\":\"cd19e9f823776873\",\"/knowledge-medium/pr-preview/pr-1885/src/data/referenceBlock.js\":\"94dc1cc361fdf80e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/rejectedUploads.js\":\"978a36f979c8c2f5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/releasePowerSyncConnection.js\":\"422b1d3fbd2d69b6\",\"/knowledge-medium/pr-preview/pr-1885/src/data/repo.js\":\"89cd65fc03c75454\",\"/knowledge-medium/pr-preview/pr-1885/src/data/repoProvider.js\":\"c71e65572557ff02\",\"/knowledge-medium/pr-preview/pr-1885/src/data/rowProperty.js\":\"d806d6962df5cd81\",\"/knowledge-medium/pr-preview/pr-1885/src/data/searchFilter.js\":\"99d4267866061b4b\",\"/knowledge-medium/pr-preview/pr-1885/src/data/seedIdentityLedger.js\":\"eae60a2c2328051a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/stateBlocks.js\":\"955d7a3f5c3bdca5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/structuralEditPolicy.js\":\"be102fe346f9ba5e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/structuralInsert.js\":\"60ecf9ff3571f01a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/subtreeDelete.js\":\"bdde8f4c8656ea91\",\"/knowledge-medium/pr-preview/pr-1885/src/data/syncStreamLock.js\":\"29243a864dfb8661\",\"/knowledge-medium/pr-preview/pr-1885/src/data/syncedTableSqlRecognizer.js\":\"9b03db829fdeb745\",\"/knowledge-medium/pr-preview/pr-1885/src/data/syncedTableWriteGuard.js\":\"a9d2e73bd0332fd3\",\"/knowledge-medium/pr-preview/pr-1885/src/data/targets.js\":\"f5a8536ba564a0ee\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeColors.js\":\"0021d8e34134ca6e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeDefinitionMetadata.js\":\"5b5dda6afa85a01a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeDefinitionRegistry.js\":\"95b79d7cc9c21c31\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeExtraction.js\":\"3b0b9bb70654f21d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeInitialValues.js\":\"4c55f9740634d09a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typePropertyGroups.js\":\"bdb70cbcd238ce8a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeSeeds.js\":\"c0386a1e02e31d83\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeTagger.js\":\"217f1a391e4bece4\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typedRecords.js\":\"baed2ce694c4a344\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typesPage.js\":\"059492316ea3d361\",\"/knowledge-medium/pr-preview/pr-1885/src/data/userPrefs.js\":\"29841d074540ff47\",\"/knowledge-medium/pr-preview/pr-1885/src/data/userSchemasService.js\":\"5ed7810c316acf79\",\"/knowledge-medium/pr-preview/pr-1885/src/data/userTypesService.js\":\"1c721b0ded9b012c\",\"/knowledge-medium/pr-preview/pr-1885/src/data/valuePresetRegistry.js\":\"0895f37011a5ffb5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/visibleChildren.js\":\"ff724737327f3924\",\"/knowledge-medium/pr-preview/pr-1885/src/data/workspaceConversion.js\":\"16df8742fd2fe7e1\",\"/knowledge-medium/pr-preview/pr-1885/src/data/workspaceFirstSync.js\":\"6b83e9a6b9e8d52d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/workspaceIdNamespace.js\":\"8867d0461bf55b98\",\"/knowledge-medium/pr-preview/pr-1885/src/data/workspaceSchema.js\":\"18549077e06dfa4b\",\"/knowledge-medium/pr-preview/pr-1885/src/data/workspaces.js\":\"b77d4ca8b417d8ca\",\"/knowledge-medium/pr-preview/pr-1885/src/data/writeAheadLog.js\":\"be5cb3cce3e2da92\",\"/knowledge-medium/pr-preview/pr-1885/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/BlockPasteShellDecorator.js\":\"6d1d15798e17e6d7\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/atTrigger.js\":\"ab0c74dc6c9914a3\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/autocomplete.js\":\"b927c3124e928318\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/codeMirrorExtensions.js\":\"b19c8d4631a94a9a\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/contentFlush.js\":\"33a20a2679d659ae\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/defaultInteractions.js\":\"72e9d7d1e68694c0\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/editSettleSignal.js\":\"4b7e5ba28c1cd24e\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/insertImage.js\":\"c4442a01988232f2\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/referenceCompletionRange.js\":\"d7caab73d744693b\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/referenceTargetTypes.js\":\"159ba80add90bddd\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/syntaxContext.js\":\"daddaaada9593990\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/triggerMatch.js\":\"751439f9eed44d97\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/AppRuntimeProvider.js\":\"23857378dc1dbc3e\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/BlockFocusShellDecorator.js\":\"a2749ec5bab9f048\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/ExtensionRenderBoundary.js\":\"29e5b6a26d92f0cb\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/PanelContentRecovery.js\":\"0ac4ed5c51555125\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/apiCatalog.js\":\"2828dc6ccede2f8d\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/approveExtensionHere.js\":\"68837caf85d89255\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/armedCutAppMount.js\":\"4e0c74eb233b8ace\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/batchableKeyedStore.js\":\"72968ab51b23f0df\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/blockInteraction.js\":\"35a03e96ae95da7f\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/blockSelectionAction.js\":\"aeed6492c9902a08\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/compileExtensionModule.js\":\"3648dcaa03a80a89\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/compiledModuleCache.js\":\"3ecb882579501815\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/continuousGestures.js\":\"c8c671dbe3be2caf\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/core.js\":\"c60e974154977f5d\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/defaultRenderers.js\":\"35824b785f067d5f\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/definitionFanoutAppMount.js\":\"4484dbb16855058f\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/dialogAppMount.js\":\"dee0752bfb22364c\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/dynamicExtensionSeeds.js\":\"b3e01e1c6dee7578\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/dynamicExtensions.js\":\"5857925c3f0f615e\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/exampleExtensions.js\":\"8a839dee43318db4\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/extensionApprovalStatus.js\":\"01b40d64f97f64f1\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/extensionLoadErrorToast.js\":\"bde9cc1a2cb99331\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/extensionLoadErrors.js\":\"cc0aab173a515ad0\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/extensionLookup.js\":\"62b97c02d30a214a\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/extensionToggles.js\":\"a6eda98f71310866\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/extensionUtilitiesCss.js\":\"d8f5db10dff6635f\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/kernelPageDeletionGuard.js\":\"ffa8db83dad8b68d\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/liveRuntime.js\":\"6e24a364c3e08db3\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/openExtensionsSettings.js\":\"f0576c0133c31ec1\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/overridesCache.js\":\"b22989e1c6e5c341\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/pluginIds.js\":\"bcc78f7ba6827700\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/processorRejectionToast.js\":\"e38aa2fa7ba7025e\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/runtimeActions.js\":\"8e44737b64dc724a\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/runtimeContext.js\":\"6855a6b2cb78c335\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/staticAppExtensions.js\":\"ebb5c8145419ca32\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/staticDataExtensions.js\":\"fe5967612343e33a\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/toastAppMount.js\":\"ad30ba60bf07425d\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/useOverrides.js\":\"3512cb2f26c2e48e\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/useShortcutSurfaceActivations.js\":\"5788145a71412fbe\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/discoverToggleTree.js\":\"15f72c2527bd90e6\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/facet.js\":\"804fa216035cb516\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/resolveAppRuntime.js\":\"e6c570d32576a21e\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/runtimeEvents.js\":\"1a89512318a912af\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/togglable.js\":\"3adaafe689a06564\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/variantFacet.js\":\"c18b9ed9558b6c4d\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/verbFacet.js\":\"61de981c5b275cd7\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/block.js\":\"305c8dd405c67e8f\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/focusedChild.js\":\"f2f51e427fdda368\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/propertySchemas.js\":\"14b2cbc53e651125\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/typeRegistry.js\":\"765c9e7f44c93281\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useAncestorCrumbs.js\":\"b5e310dbcadebd51\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useAutocompleteListbox.js\":\"bab518dd5844f5b4\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useDebouncedSearch.js\":\"8c8b7b8d05da56c8\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useDebouncedValue.js\":\"0f1540586f2c3b61\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useFacetValue.js\":\"22c8eb20d84db45b\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useIsFocalRender.js\":\"23baf1916c54ae33\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useIsReadOnly.js\":\"b20ad954bf4afde0\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useMaterializeBacklog.js\":\"686b975d4c9ee507\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useMinuteClock.js\":\"3ae3db81e067dfd2\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/usePanelLayoutProjection.js\":\"4d79eb6cb16ca118\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/usePendingInvitations.js\":\"c0908ef536634525\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useRendererRegistry.js\":\"6e62f244e2099c21\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useRetainedFieldRows.js\":\"53536110b97c3c53\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useWorkspaces.js\":\"e631f50618ef269f\",\"/knowledge-medium/pr-preview/pr-1885/src/lib/utils.js\":\"6ab176f098552b12\",\"/knowledge-medium/pr-preview/pr-1885/src/main.js\":\"d018c04570823768\",\"/knowledge-medium/pr-preview/pr-1885/src/markdown/MarkdownImage.js\":\"103d43f38df1359a\",\"/knowledge-medium/pr-preview/pr-1885/src/markdown/blockSeparators.js\":\"ca292c83d138dc13\",\"/knowledge-medium/pr-preview/pr-1885/src/markdown/context.js\":\"4679e34d9d8484e3\",\"/knowledge-medium/pr-preview/pr-1885/src/markdown/defaultMarkdownExtension.js\":\"c0e0afdf7e962666\",\"/knowledge-medium/pr-preview/pr-1885/src/markdown/extensions.js\":\"70c231e5ecfe7901\",\"/knowledge-medium/pr-preview/pr-1885/src/markdown/renderMarkdownHtml.js\":\"2db7dfd978e27654\",\"/knowledge-medium/pr-preview/pr-1885/src/minimal-editor.js\":\"7d15e35cb410a442\",\"/knowledge-medium/pr-preview/pr-1885/src/paste/armedCut.js\":\"1e653c7141cf64e1\",\"/knowledge-medium/pr-preview/pr-1885/src/paste/captureMediaVerb.js\":\"ea6c62afbace67f5\",\"/knowledge-medium/pr-preview/pr-1885/src/paste/clipboard.js\":\"3b8687dd71a92219\",\"/knowledge-medium/pr-preview/pr-1885/src/paste/decision.js\":\"4f11acb4ee1817a8\",\"/knowledge-medium/pr-preview/pr-1885/src/paste/operations.js\":\"5f2e3cca8dd81ecc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/account-header/AccountHeaderItem.js\":\"bbb27e591d3f3bd2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/account-header/index.js\":\"7564d2bcca3569e0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"cd9bf9b047122e7d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/askAgent.js\":\"75b2b8f455d3a3d1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/askedStore.js\":\"18fdb0da4691ce02\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"cf42d8cf60b7cc98\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/chipState.js\":\"e59232f3b6459333\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c84a813832d3d79c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/index.js\":\"fa0f246a078d2b7d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"ed0f26ac859393a1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/schema.js\":\"354095259ee57842\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6cf67ec26751510f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5cd9659e70b9409e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/addMedia.js\":\"6c7bbff3b6512b1b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f2b13f1c3ab80889\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/block.js\":\"54c2076c247b8b74\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/context.js\":\"11dd35ab3b164061\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/displayIds.js\":\"0954952217391a41\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/index.js\":\"ca39d6e9a414075e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/outline.js\":\"4d1af615330b8eac\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/properties.js\":\"276a3168ab0c8663\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/refs.js\":\"096f3d134a8ddded\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b506cd3fdeff1500\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/search.js\":\"b8acf3daeaee2d7a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/shared.js\":\"0fd2c507f829c2fa\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9a4f8d6b39e17631\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/text.js\":\"15e76a8360d9b60b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentWrites.js\":\"9548bbc66028bec3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/authoringCatalog.js\":\"ad4220bd55f5ccc3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/blockRefTargets.js\":\"9fdfb6ce5216858a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/bridge.js\":\"428c27eb78b2c111\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/bridgeLoop.js\":\"46b7742d4ebab775\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/changeHistory.js\":\"b1564fb89b0df428\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/commands.js\":\"cfed813026e1ff0d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/commentsCommands.js\":\"cf9610a9cadbdb99\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/dataExtension.js\":\"e7516f38e9c774d7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/dataModelGuide.js\":\"f10d33e810d1d0a5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/dayPropertyInputs.js\":\"085e1e28c716c636\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/describeRuntime.js\":\"449c1a2af43cfea4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/extensionLint.js\":\"ad6882625376f30d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/grainAudit.js\":\"d038b13d88887374\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/healthCommand.js\":\"1461d1897a9831b6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/index.js\":\"81a7a37e009ebc8a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/presetIdentity.js\":\"5fe64e9f185f0a3a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e0c547ee34d32565\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/readMedia.js\":\"396a2ce9cc9ffd5f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/schema.js\":\"3b5ffac7654a8f5b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/serialization.js\":\"7e982cecb3f2c409\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/targets.js\":\"13ed4b1c2a96991a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/tokens.js\":\"b130a736ef4bcd1a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/watchEvents.js\":\"f420fe87d0e420bd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/workspaceGuard.js\":\"608d7103ea692594\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/writeCommands.js\":\"31562e92aff2458f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/AliasCollisionToast.js\":\"93bb8442f26a7faa\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/DuplicateNameBanner.js\":\"fd03de83bdf83bc2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/collisionMerge.js\":\"f4046984bf98e7f9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/dataExtension.js\":\"6a8e25020d32fc96\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/index.js\":\"0faf2cda1d40f593\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/mergeCollisionAction.js\":\"5e90ae2a9f034a7f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/pageStyling.js\":\"9b4bacdd4351f154\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/rejectionToast.js\":\"56c429ee5bffb917\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/syncProcessor.js\":\"61b8c8dd08127972\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/actions.js\":\"576760399d4b1c03\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/addComment.js\":\"3a3381ac8396d131\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/anchor.js\":\"91fa9cbe248c28b5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/anchorState.js\":\"c47a8c951e5cd25c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/commentLinks.js\":\"0d593ac073792428\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/confirmThreadDeletion.js\":\"32d5503d90f549f7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/container.js\":\"05bea265f57b9879\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/dataExtension.js\":\"20805355441205b4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/deleteComment.js\":\"301011b819944689\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/highlights.js\":\"9668d7a463078776\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/index.js\":\"5a4ceb4d058b9956\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/linkedCommentsPill.js\":\"95e8d4aaf8c0995e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/margin.js\":\"3a5f2d199e3cf0e7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/marginAnchorLinks.js\":\"8a2b49b539c6b68e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/marginSchema.js\":\"b89e904936b72eaf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/newComment.js\":\"d5c631cd2a3a44c4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/ownThreadPicker.js\":\"094e3c0d74f04800\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/placement.js\":\"4db77be76314c63c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/queries.js\":\"a64bd0c6f6de7327\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/quotePosition.js\":\"759bc6eab531f9f2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/quotedIn.js\":\"5c7dec875a997e75\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/quotedRange.js\":\"3299895379dcc82d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/rangeRefs.js\":\"7b6d1f758ede2a83\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/readHighlights.js\":\"32e7dda96625e647\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/readSelection.js\":\"c05b22dee817ea98\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/readSelectionUi.js\":\"0ea502f2f407995a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/reanchor.js\":\"a97baf7db687ba54\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/schema.js\":\"fdaea1c2da09bf19\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/scope.js\":\"531479d663dc4bf2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/scopeThreads.js\":\"458273e9ab388575\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/splitRetarget.js\":\"651d410b1e96c57a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/suggestionCard.js\":\"3402174b3b64271f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/suggestions.js\":\"4d5aefb2db31549f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/summaries.js\":\"3dca3b8289fb27d7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/summaryBatch.js\":\"ccb39d06bdeb4995\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/surface.js\":\"8f89453d7f23f46c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/threadNavigation.js\":\"5e140f3b1a3c82d7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/threads.js\":\"87dcbb0e16e03dce\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/ui.js\":\"107037c713ecf54c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/uiStore.js\":\"f75efd466e7e836b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/app-intents/appIntents.js\":\"13979e2dd6189128\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/app-intents/index.js\":\"a58f1630859e52b3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/app-update-prompt/index.js\":\"d8182e8281c27a29\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/app-update-prompt/status.js\":\"991d2b0879dc99a2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c266eafb1e1d410d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/MediaBlockRenderer.js\":\"3e128b398c906e6c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e318bc35395b8cc1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/MediaUploadReconciler.js\":\"89eff2ed32a8e7e3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/assetDownLane.js\":\"1d41644aa59d63f6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/assetResolver.js\":\"cdd18ff58408e7e8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/assetUpload.js\":\"0867298def750493\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/attachmentCleanerIO.js\":\"4a54b598c5fae307\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/audit/supabaseAuditIO.js\":\"8c5b8bae867dad82\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/blobStore.js\":\"6361cdc9c69cdf8b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/browserMedia.js\":\"7dbe394706bca6ab\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/byteStore.js\":\"0061e70d9f2da9c7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/cleanerIO.js\":\"72728e8297dcaa0a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/cleanupAttachments.js\":\"b75b3edda3a212ba\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/dataExtension.js\":\"6fed110fd201cdc2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/downLane.js\":\"9b845ade6a8d3154\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/index.js\":\"d21e3d1c0a71364e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/insertImageContribution.js\":\"f29138fa6d3267ab\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/laneArming.js\":\"2759dd763b1b70db\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/laneLock.js\":\"2158867a354afb94\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/mediaBlock.js\":\"9b72f8eef0af2512\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/mediaCapture.js\":\"ba2008c78c5af307\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/mediaLanes.js\":\"d44c96206db05f2f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/mediaViewers.js\":\"6ec7f350d3210e71\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/mediaViewersFacet.js\":\"f273a8b63a569fbc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/pasteCapture.js\":\"8f2f75f0ebcb2c52\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/resolver.js\":\"a7a8992415d5813c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/retryUploadsAction.js\":\"5717948a242b0753\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/storagePaths.js\":\"98cc8f585631e1da\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/uploadDrain.js\":\"34aa6af1a5427078\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/uploadLaneStatus.js\":\"0bc579d02bf80b19\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/uploadReconcile.js\":\"e38be7c7dda77a2a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/uploadRecovery.js\":\"39364c325db2220a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/uploadStore.js\":\"1ae8252e1bc40a03\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/useAssetObjectUrl.js\":\"ce88e9d949cad2bd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"6f50f78c1b1481c9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks-view/BacklinksViewSection.js\":\"36f334796e9d5828\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks-view/facet.js\":\"c765d1e094b7c68a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks-view/index.js\":\"1b25ec657965a4ec\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks-view/prop.js\":\"9fb77795be086543\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/BacklinkFilters.js\":\"364bee6e755a3f03\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b5955a4e938a5226\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/BlockEntry.js\":\"8e2db34b8d02066b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/LinkedReferences.js\":\"8d03e82ae1a6e8b3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"625002565fba9e36\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/dailyNoteDefaults.js\":\"c78a471138ce09a4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/dataExtension.js\":\"114b6738aaa9ee20\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/edgeExclusions.js\":\"664c47cb0f4aaae5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/filterProperty.js\":\"31279f30008d89c2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/index.js\":\"d85a56c1e9d6e0bb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1423fee0b72258fe\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/inline-counts/applies.js\":\"b64cd1cf9175598c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/inline-counts/countQuery.js\":\"efa7165a575f6291\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/inline-counts/expansionStore.js\":\"5605d328c7c37d7f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/inline-counts/index.js\":\"4aca227f559c7857\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"285feb818a5736bd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/presentationInvalidation.js\":\"159fb023e60bc070\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/propertyEditorOverride.js\":\"5ea0319f31582727\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/propertyFilter.js\":\"b7dc8b63aa346f40\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/query.js\":\"58928ea26112078e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/resolveFilter.js\":\"e32da6e98d81e1a7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/sourceBatch.js\":\"e22f9a72cc9568b6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/sources.js\":\"7dd94998539376dd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/useBacklinks.js\":\"ba614aef2f22740c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7a2119ceb0956107\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/birthday/BirthdayCelebration.js\":\"5460f707b464f87c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/birthday/BirthdayOverlay.js\":\"95e81388b316dcc4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/birthday/gate.js\":\"0e036af1fdb6aba0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/birthday/index.js\":\"411cb5e222c23a0f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/birthday/wolfTheme.js\":\"1d5a4d9496945657\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-drag/BlockDragLayer.js\":\"51dec40e626a8763\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-drag/dragController.js\":\"07582ca6a02d1047\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-drag/dropTarget.js\":\"a53c268efded0bf3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-drag/index.js\":\"d376dad26827a59c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-drag/projection.js\":\"1ebd050664de4830\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-info/BlockMetaCard.js\":\"9ec2babe327bb798\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-info/index.js\":\"604ea6763d15dba1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/AddTagDialog.js\":\"f5257a3a103ac008\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"5e67a12aaeef7062\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/TagNameIssueHint.js\":\"b888292265b269b1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/addTagAction.js\":\"ad0a3e013e3e5bdd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/appendTag.js\":\"e233f2895658ece4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/config.js\":\"86c4443a912afe9d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/dataExtension.js\":\"5ba79eecd9d790cc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/index.js\":\"c7c4c26e7d0186a5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/propertyEditorOverride.js\":\"847df9354364c3dc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/BreadcrumbList.js\":\"976f5c81413025c8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"0d04ada612ebc17b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/Breadcrumbs.js\":\"abbe0368a3d64914\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"f3e5246a6316d8d3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"c50299f670f430b2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/index.js\":\"dbe3b7199c07c27f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"773c0955cbe3dd4a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/CharacterCountItem.js\":\"3fcaaacc5d394aef\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/ProfilePropertyEditor.js\":\"9ff37fedd774b048\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/actions.js\":\"c35041c054b62846\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/blockType.js\":\"479037e9b998d853\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/charCount.js\":\"8daf27574b1fb038\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/dataExtension.js\":\"749cb3c705f05f79\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/index.js\":\"bc7db1cf5af6fcff\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/profiles.js\":\"f9287ff09fb58bcb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/properties.js\":\"38e33efc47754f05\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/subtree.js\":\"dfbddc80f2bad14e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/textCounts.js\":\"be013705cdffcfeb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/colemak-keybindings/index.js\":\"96ec40d1bc9c782e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/CommandPalette.js\":\"1029f90340803f20\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/HeaderItem.js\":\"9c18cd412b6cf913\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/context.js\":\"9f51eb5fa41ed956\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/index.js\":\"3a414808f0746511\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/selection.js\":\"8d1214cdd99d2106\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/toggleStore.js\":\"97eca8d1f354f83d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/useCommandPaletteActions.js\":\"503df29feb3b0947\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/ContributorBadges.js\":\"72d5b19fa2f32055\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/author.js\":\"7e5191f896a3db9e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/codeMirrorExtensions.js\":\"c4774a4790e29681\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/dataExtension.js\":\"428c8c793a5a531d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/index.js\":\"b469feb48963d8f5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/mentionAutocomplete.js\":\"e69a0b2e7f0dc5fe\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/processor.js\":\"c1786e745a4f636e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/profiles.js\":\"53c25e2b19c88600\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/queries.js\":\"b7566127dde3bc01\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/schema.js\":\"1a9d35063c83d9c2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"a1c030d5eb1922e7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/cursor-follows-scroll/followOrigin.js\":\"3e92c64292a77146\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/cursor-follows-scroll/index.js\":\"a0e56b199027980f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e93e4c56bb9faf7a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"46e8a0096281d3fa\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/CalendarGrid.js\":\"d6509b644f49aeec\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/DailyNotePicker.js\":\"06c7d51efac2004d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b1e1625bac87fdc6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/DateNavDecorator.js\":\"5133d00800dec953\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/DateScrubOverlay.js\":\"77f985286730cfbd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/DayPropertyEditor.js\":\"3e17b2d69a3977df\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/HeaderItem.js\":\"ff37edc67eabd155\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/ReschedulePicker.js\":\"cd694cdca00e97fb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/SpreadDatesDialog.js\":\"92a09715a0f2caa8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/actions.js\":\"5dcc2d08205d8b1d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/blockDateAdapter.js\":\"e5aab013500fe20a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/calendar.js\":\"185d4dadef16d781\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dailyNotes.js\":\"b4fe6e7cd90a5342\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dataExtension.js\":\"2a90d69dea5f184f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dateScrubActions.js\":\"51210cefd36f21c0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dateScrubGesture.js\":\"4b2cefb21e7a468d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dateScrubGestureActions.js\":\"7463261dc9da21b9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dateScrubRecognizer.js\":\"97372a00a3617bb4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dayProperty.js\":\"877cad5d061650d5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/deletionGuard.js\":\"e1fb0c3b94c0ff93\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dueQuery.js\":\"dfb508c5b3cc50da\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/index.js\":\"2ca4f3276f867e79\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/landing.js\":\"26c23ce88a6d28cf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/localSchema.js\":\"32791c0aab3198cf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/referenceDateAdapter.js\":\"80c0acfb90a2d877\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/rescheduleAction.js\":\"72732feb40fa5cd7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/schema.js\":\"42834e6d4fc2e900\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/spreadBlockDates.js\":\"5403183ad2361337\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/spreadDatesAction.js\":\"5931754ee8967a1e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/today.js\":\"aec5083c5443a2b1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c650b1d31df8d02a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9ca5bbd12bb5db2a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/audit.js\":\"7a6a81c80deb330d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/auditAction.js\":\"7d4fca1195dbc010\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/auditRanges.js\":\"3f08228d45cf2581\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/diagnosticsSource.js\":\"7d18e8dc2b64d681\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/divergenceScan.js\":\"6a08b9e6ad1254c5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/index.js\":\"1b4691d98d75322f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/propertyChildrenChecks.js\":\"f452b10682a94205\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/referencesMirror.js\":\"84a6f688ca89ecc8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/rowJson.js\":\"9a744c25d8d712b7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/schedule.js\":\"bd1eefd2ac4a9b46\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/store.js\":\"764c32e0ba72dc41\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-maintenance/action.js\":\"2b9313b96e69902f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-maintenance/index.js\":\"ecaa62a69f9306ba\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-maintenance/plugin.js\":\"fd3a0ebcbebe1d89\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"59acff4f3eb5fbfb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/actions.js\":\"d122dc1422798a89\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/changeMarker.js\":\"17efd05b31e0b355\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/diagnostics.js\":\"bbc01395690f692d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/fileSystemAccess.js\":\"44662e014273c289\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/filenames.js\":\"a6351e705c8f2f5b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/index.js\":\"03946f9a8a8e44f6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/mirror.js\":\"85e2912b404821ac\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/runLock.js\":\"18aea9ae1a2dab7f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/runtimeHealth.js\":\"4c60587f406dba67\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/schedule.js\":\"2d92fa312f51019f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/store.js\":\"96f9d3ff4fdeaf64\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/default-themes/index.js\":\"268acedb29109888\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/default-themes/themes.js\":\"ed7e04d5d4dd50fb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/diagnostics/facet.js\":\"14a8ad5a2ab79baf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/diagnostics/useDiagnostics.js\":\"78ace5a2dd010544\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extension-prompts/dismissals.js\":\"6b06662a7e9c2701\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extension-prompts/index.js\":\"fce5f83a34490030\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extension-prompts/status.js\":\"49ba28fd51df61bc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extension-prompts/store.js\":\"bf1243a9ec5079c5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1d7d197b1a362617\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/ExtensionsSettings.js\":\"eb224fa39375781b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/actions.js\":\"38ce187d0a43a63e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/config.js\":\"7c6036b77952b23f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/dataExtension.js\":\"9a567aee76dd8e5d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/effect.js\":\"652a125c6bcd6570\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/index.js\":\"2f5ff96ccd5c7f76\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/propertyEditorOverride.js\":\"078935a1fb912104\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/useToggleTree.js\":\"6c0ccc14849b9f2f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extract-type/ExtractTypeDialog.js\":\"5e0bd49c4d5e93f5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"8558439833f88cd2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extract-type/PropertyShapePicker.js\":\"76cd98d944870f04\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extract-type/action.js\":\"6d97bcc4755e16e2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extract-type/index.js\":\"f8b4d8bb65df0606\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/FindReplaceDialog.js\":\"e322fce87bebbbe4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/HeaderItem.js\":\"e727a380bf9bd15f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/dataExtension.js\":\"e9978f5b8c9b4b96\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/index.js\":\"6a50efd46d5389d6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/search.js\":\"51c60e599cd2a0d8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/toggleStore.js\":\"0f3dab7eb2799eb8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/LocationPropertyEditor.js\":\"8856787bc07eaab4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/MapView.js\":\"1a291157dddaa120\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/blockTypes.js\":\"6de89404f8e2daaf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/codeMirrorExtensions.js\":\"461a53a8e0d5630d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/createOrFindPlace.js\":\"7d0b668fa89ae526\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/currentLocation.js\":\"c80f99c68406ea18\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/dataExtension.js\":\"1a306197cef72554\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/geoContentDecorator.js\":\"b2c07077c43b4070\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/googlePlacesClient.js\":\"e53a9016f848b4f8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/index.js\":\"396db00daf269a07\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/locationsPage.js\":\"4ffd73da9096876d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/mapViewport.js\":\"84ede2dd83a9ce93\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/pickCurrentLocation.js\":\"92514766135abc76\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/placeAutocomplete.js\":\"210bf351479cd781\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/placeNameCollision.js\":\"fcb79bbc49eccdc7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/properties.js\":\"b723f5d4efc148fb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/propertyEditorOverrides.js\":\"c9569f0467573dc2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/query.js\":\"6aaeab8ce8cf01d4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/usePlaceSearch.js\":\"6bba94e44334b793\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"61ee6ee1c93357d8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"69b82665b062b036\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"df5e95eb441b23d9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/config.js\":\"a6a2802e646acd8f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/dataExtension.js\":\"d8649652eed31540\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/facet.js\":\"65f4465a41c8ce79\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/grouping.js\":\"b60409a951690a40\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/index.js\":\"a3c8234ed13dd5b0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"3ce802a021be325e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/query.js\":\"f0652542caa894c0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/resolveConfig.js\":\"14256037fb55c595\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"56857afe00860d79\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"ec46d483e6d65c90\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/HtmlDocumentContent.js\":\"d1b0745f491cdeff\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/HtmlFrame.js\":\"bf79f29b1e5440e8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/actions.js\":\"36fd41008122c33a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/blockType.js\":\"38a0a3d4848ba15f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/confirmRunScripts.js\":\"94fcc73fd9b295ee\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/dataExtension.js\":\"4506f2502ce7a186\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/frameAnnotations.js\":\"33ecd5af7627d69b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/frameDocument.js\":\"c3bdae37b4345077\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/frameTheme.js\":\"cae6941a0a71d2b8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/index.js\":\"915327f8867223b5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/scriptConsent.js\":\"bd5941899798d06f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/sourceMap.js\":\"e6976ad012f626f4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/useDocumentScripts.js\":\"4e69afb384836143\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/interaction-metrics/index.js\":\"4947a08fecdcf38f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/interaction-metrics/record.js\":\"e8e5eb5f6804f40c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/interaction-metrics/recordStore.js\":\"bfd80c4ef5ac2e6e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/interaction-metrics/responsiveness.js\":\"9dfcf43d33df8922\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/interaction-metrics/schedule.js\":\"9eba57d72ce9354b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/interaction-metrics/sessionContext.js\":\"c81d5a2af11bf5ee\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"3792626080c74b02\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c56560c3bcf47a34\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/actions.js\":\"12e5f82ea89ed155\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/config.js\":\"92c69f0b828ee26d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/dataExtension.js\":\"aade31197a0ac490\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/effect.js\":\"1562e25d83231060\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/index.js\":\"b14d84b7769817da\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/keyCapture.js\":\"9286bb535c13afdd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/overrideStore.js\":\"e6d041aa04ac77c8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"9a5b46012c962416\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/HeaderItem.js\":\"cee3ee8fc9fc9a45\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/LeftSidebar.js\":\"4816b366e7e5c89a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/actions.js\":\"f2714e5dd422e95d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/facet.js\":\"4b34c1a9dd6bffa8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/index.js\":\"410c54682e470b8b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/shortcuts.js\":\"7efb4f1c4d6c7a84\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/toggleStore.js\":\"690b360890f30f2d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/merge-blocks/MergePicker.js\":\"9f5567e1264959ca\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/merge-blocks/index.js\":\"9df398f839836405\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/merge-blocks/mergeAction.js\":\"ef24548bda55faf4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/merge-blocks/strategy.js\":\"d49e3237ca5689c7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-bottom-nav/Button.js\":\"27d5d49fe6158177\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"c7dab04c7b070e8b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-bottom-nav/defaultItems.js\":\"abafff6868d315e8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-bottom-nav/facet.js\":\"c061d3827e4c1ef9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-bottom-nav/index.js\":\"fb003980d35ec06a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"76f4fc07b00d9e11\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6d48562610fb61a4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"be2a6c98bc2c0709\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c99a4591891f009c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-keyboard-toolbar/index.js\":\"9b764646be8ac7dd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/MoveDestinationPicker.js\":\"14b0102afe01f07f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/blockSubtreeMembership.js\":\"dd053c390dc41bbb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/contextMenuItem.js\":\"c3d484beb6e0e769\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/index.js\":\"65e4175f4c5bc447\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/moveAction.js\":\"c0e9e1db3bf9ce0a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/moveBlocks.js\":\"2f3b8b0b84208206\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/selectionAfterMove.js\":\"28390034daadb01e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/TutorialBanner.js\":\"a4fee09cc91237c1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/action.js\":\"6f2779a6620c6f8e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/bannerDismissal.js\":\"c03411d6e8e8db1c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/documents/cheatSheet.js\":\"bcc82f1a43dc657d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/index.js\":\"ffd1b6f0a74d507e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/keys.js\":\"e19e57f7944560e8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/landing.js\":\"f361c30ade0c6d83\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/outline.js\":\"baded1e4ecc19f8f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/seed.js\":\"febfb6724e4afc37\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ae132bfebe27d298\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/analyze.js\":\"cc52e3f9075f2ca5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/diagnosticsSource.js\":\"546cfc17c483ce0f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/index.js\":\"21bc131e943f2ce1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/load.js\":\"bb205ca774782f57\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/monitorRun.js\":\"8f575ab5a4adb665\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/schedule.js\":\"5983724f99356bc7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/series.js\":\"4702c67c70651a61\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/store.js\":\"9e91fe35c127a6db\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/trendAction.js\":\"55362a84500f6fd3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/verdict.js\":\"01fae3dedafc99f0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/plain-outliner/clickToEditAction.js\":\"8663403256fcf9a2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/plain-outliner/index.js\":\"a5a1a98d7f44276f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/plain-outliner/interactions.js\":\"15032f17fc4962fd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"062119364314c7b7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/MigrationGate.js\":\"22410fa52a5827ef\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/MigrationGateDialog.js\":\"725450b0db51b21d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/action.js\":\"8c7806f7f5e54228\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/index.js\":\"fb74341f0b2fd879\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/localRunMessage.js\":\"bed331b63f4c7fa2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/plugin.js\":\"e5dcf6bf44dcacd9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/progressReport.js\":\"b24db3a0032ed9e0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/sweepProgress.js\":\"8953b9e18f0b0054\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/FieldRowRenderer.js\":\"2940aaa55567cbba\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/ValueRowRenderer.js\":\"3091dd4ded0b1ce1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/actions.js\":\"7fffcb8472cdde66\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/autocomplete.js\":\"0ac4bd32379cba4c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/fieldRow.js\":\"7b3a0a01aa633c08\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/index.js\":\"ec77d18ae96f1342\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/referenceWarning.js\":\"a4bd5d65bb2731d3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/valueAutocomplete.js\":\"741447deee39e522\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/valueSchema.js\":\"49e9d4b911481a18\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/HeaderItem.js\":\"d53e82452ad0cf88\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/QuickFind.js\":\"f8ecda83c78a15e0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/index.js\":\"5b930da3f84cf055\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/recents.js\":\"fa1a910cc4c4b3e1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/resultItems.js\":\"a836049c7649538c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/selection.js\":\"5918977d401f8703\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/toggleStore.js\":\"9e74278aa32970b2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/recents/HeaderItem.js\":\"f79dd1c19c2b82bf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a985d41b94a74ec3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/recents/grouping.js\":\"23058b00608e0d29\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/recents/index.js\":\"6060e0dad78f3f08\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/recents/target.js\":\"428b75388a30b3c7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/codeMirrorExtensions.js\":\"5b42d42e1789663f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/contentPrefill.js\":\"07c533bf65872b61\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/dataExtension.js\":\"223fce0d8fa3e79b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/index.js\":\"81ac3c0864142a65\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"765691416ab032d9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/invalidation.js\":\"44d81170c17a7029\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/localSchema.js\":\"737951502aca6ae7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/blockrefs/index.js\":\"f5a6e20e1c0d3e91\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"fa230a89e9307ca3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/index.js\":\"f65fc85323c4b9ac\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/referenceNode.js\":\"f6dc57a2381f5db9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/remark-reference-occurrences.js\":\"73e124802903cdde\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"6c8425be59d6a298\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/wikilinks/index.js\":\"0c20e2d1446423d5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3053d8e2e6842d42\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"32da6b0cbd5a4cba\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/mergeRetargetProcessor.js\":\"8022f4d09af02546\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/parseFence.js\":\"8ff62e8d891b0c4c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/referenceParser.js\":\"d84fac57ded49741\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/referenceProjection.js\":\"e2023df9608fca17\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/referencesProcessor.js\":\"7796bb664c3c3663\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/renameProcessor.js\":\"43c1c675bd7dafd9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/spanReplacement.js\":\"ae2e350aab8ba60f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/rich-paste/htmlToOutline.js\":\"416befa0896648bd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/rich-paste/index.js\":\"90657b4fb3139db9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e950dd0ae7bba53e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/rich-paste/pasteDecision.js\":\"6e9b84416a502f89\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/action.js\":\"3a2f2f3e7c9b91f2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/blockIds.js\":\"9777a35a989aeeca\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/content.js\":\"6f12d3d77aa4062c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/effect.js\":\"5189fe2acd4129a5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/ids.js\":\"f6df465c5c7e23d5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/import.js\":\"5ba7c39a0b7d0c3c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/index.js\":\"1dbfda81f9fa14a6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/plan.js\":\"a069e287b60dda39\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/plugin.js\":\"1239f1dfdca24471\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/promotion.js\":\"4368dae64f8222d4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/properties.js\":\"baccc0e6803c3078\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/references.js\":\"24b9222f862cb357\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/report.js\":\"6684ecc6259ed1dc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/roamMemo.js\":\"e260a15ad0fb4547\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/runtime.js\":\"f4ed04b8e2f6bf7a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/schemaReconciliation.js\":\"acfd653eccb1c913\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/srsMarkers.js\":\"067c4a3995367d05\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/todo.js\":\"24d31c0d0e2645d3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/typeCandidates.js\":\"9863c0225e9b275b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/types.js\":\"00763ba4e0df0d41\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/search-health/index.js\":\"f90b68eff2a62780\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/search-health/store.js\":\"a273d2314d5d4d9b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/shortcut-help/HeaderItem.js\":\"b06e51ba5428d769\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0536f01bb48f491d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/shortcut-help/index.js\":\"a291e233f5b7bd17\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/shortcut-help/model.js\":\"48ec95287d460964\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/shortcut-help/toggleStore.js\":\"4295e13f8d93073f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/shortcut-help/useKeyInspector.js\":\"97925bf64e7e3e63\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0933e65327090b31\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/ShellDecorator.js\":\"4b0517053e572432\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/actions.js\":\"b5f8bf86cccfe7ce\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e83482c06cece097\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/index.js\":\"1818ad5548b2ef14\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/shell.js\":\"df8ac985b7a1ec03\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/surface.js\":\"e192bfc2d4a222e0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/walker.js\":\"7a7876c0cfb518ba\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/RescheduleToast.js\":\"0586e0620e2544f3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/dataExtension.js\":\"3fda4fe9522ee731\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/index.js\":\"51070c3d023e8117\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/indicator.js\":\"b2ce4e251769d693\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/moveSrsState.js\":\"9aff9596aa3d38bf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"54f4739f3bd8566c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/scheduler.js\":\"7c56681cd1c417bc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/schema.js\":\"824c3d24a803f916\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"dde71d4cf91a4614\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/srsClipboard.js\":\"fb7f6c6d237a1983\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1daf2221acf7ed0d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/DailyNoteReviewHint.js\":\"d3348d33c1095325\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/DeckPicker.js\":\"e0a0b8bce2d33d9c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/ReviewControls.js\":\"2341f6f555c904ef\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/ReviewDeckRenderer.js\":\"ad5970cb25c7d97a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/ReviewSession.js\":\"73901f11808c30d3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/actions.js\":\"2981fba7507b04ac\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/archive.js\":\"c816a80694667167\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/dataExtension.js\":\"2f2800789d10ed99\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/deck.js\":\"459ab13142960abb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/dueQuery.js\":\"76f610a1e13e231f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/gradeDecision.js\":\"eaa8c0f755a5f867\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/index.js\":\"d44e31cf52e96c0c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/keyHints.js\":\"bf8f6f726f434461\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/reviewCardLayout.js\":\"e275939f555ec8b9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/reviewProgress.js\":\"3838f6e2dfa4e9de\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/schema.js\":\"afa125a0f9e3619e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/useDueCards.js\":\"15d2f71fb95a5bdc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/startup-metrics/index.js\":\"9bcd3d816f4ad75b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/startup-metrics/record.js\":\"ac1c876452ecadef\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/storage-persistence/index.js\":\"147139bf0b7f60ec\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/storage-persistence/persistenceStatus.js\":\"f2aa1063c1d9b2a9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/storage-persistence/requestAction.js\":\"19828bfa58beda68\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/supertags/TypeChipsDecorator.js\":\"65088ddaa7a73ede\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/supertags/codeMirrorExtensions.js\":\"de6240db7a93a850\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/supertags/index.js\":\"bf163b3c193928ce\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/supertags/typeAutocomplete.js\":\"249e718266a95965\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"430ee60b7da2754b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/actions.js\":\"2007f2b12b591b1b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/anchor.js\":\"a11ca8d04c5273bf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/events.js\":\"ea7e972c8ae741e0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/gestureActions.js\":\"05f137f6cffd3da5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/index.js\":\"34700b6bc773f9b3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"08225247550b27be\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/sync-metrics/collect.js\":\"e563977b62847bc6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/sync-metrics/index.js\":\"55cebcc62bdd2b37\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/sync-metrics/record.js\":\"ad4649e937eef11d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/RejectionDialog.js\":\"1210f873210893c0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/SystemStatusHeaderItem.js\":\"89431aab80e4e971\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/index.js\":\"a7da24ea280ee598\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/model.js\":\"9979ffdcb8a274fe\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/queueCounts.js\":\"38135bb46bfe9a33\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/rejectedHelpers.js\":\"c2f3a90ac0b28649\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/rematerializeAction.js\":\"220e0001a78bb255\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/useHysteresis.js\":\"1af6f34637667ebe\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/ColumnHeaders.js\":\"1427734a0be8dd4d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/QueryUi.js\":\"cb1c584b8a19e2f4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/TableLayout.js\":\"db2e456110a8d05b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/actions.js\":\"17f0f80948ef847a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/cellEdits.js\":\"a72a66a94065d6f6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/childrenViews.js\":\"3edba13412b1578a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/columns.js\":\"20742aaa029c026a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/controller.js\":\"863ccb7d40da2857\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/convert.js\":\"95282a8bbc88ca2f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/dataExtension.js\":\"a564f9251207e21f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/index.js\":\"a570d70f73464af1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/keys.js\":\"753fd2c876be128e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/model.js\":\"6cb340bee0d0db1a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/QueryText.js\":\"9ebe124488bdf5bb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/backfill.js\":\"e65d6328a1a45dbc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/completion.js\":\"6be10cd1dccd473e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/format.js\":\"9a3295992fbf173a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/parse.js\":\"98c87048c3d7e67b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/queryValue.js\":\"5a8f36989b9e7774\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/registrations.js\":\"db88defedea3212d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/source.js\":\"0c88adad77e5bd03\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/registry.js\":\"6b7f081b3fd2136a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/rowGutter.js\":\"fcf401c26a1e1bf5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/rowVerbs.js\":\"521755c3c579790a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/schema.js\":\"d000e1e5f4ca238c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/sort.js\":\"4779c3aa6ace61ba\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/theme-toggle/effect.js\":\"a5fc00e137dda08c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/theme-toggle/index.js\":\"a90d2871ecaf1a43\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/theme-toggle/theme.js\":\"f6240795379d104b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/todo/actions.js\":\"cbaac55b83f2b95f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/todo/dataExtension.js\":\"3df7895ab3374b83\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/todo/index.js\":\"e197c4073e62ae18\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/todo/schema.js\":\"260061b535e29165\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/touch-selection/TouchSelectionLayer.js\":\"ab2a8490be075534\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/touch-selection/actions.js\":\"a103a67e9c9b500c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/touch-selection/defaultItems.js\":\"c43f72d85e9b3335\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/touch-selection/facet.js\":\"ba5c6e1a3036f2ce\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/touch-selection/holdRecognizer.js\":\"5f0b8ef7a200a12b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/touch-selection/index.js\":\"5cbd16b9e8929970\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/update-indicator/UpdateIndicator.js\":\"9b6d2599a8a68bce\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/update-indicator/index.js\":\"3c50bb0ec00b7abf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/update-indicator/loadTimes.js\":\"bfe3fc7dd09dd285\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/VideoNotesRenderer.js\":\"083bca7c97f00580\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/VideoPlayerRenderer.js\":\"6897359c92774e62\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/VideoTimeStamp.js\":\"1daa2a678b66fd69\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/actions.js\":\"4d9cdb4d23ec09c5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/index.js\":\"22120a2196f35b33\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/markdown.js\":\"8d3ac8d42cc7fe99\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/notes.js\":\"ff0dbb28310fd7c0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/registry.js\":\"f72324b8bf37204d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/remark-timestamps.js\":\"22845bde5d071043\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/view.js\":\"02adf79692f6145c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-link-hints/LinkHints.js\":\"1630fef656166e8d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-link-hints/index.js\":\"996ca51bbd5c1d38\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-link-hints/model.js\":\"a70592fe99e11d48\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-link-hints/settings.js\":\"f510f37f2912ada8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-normal-mode/actions.js\":\"27e1ddd99de7de61\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-normal-mode/index.js\":\"131aa3cf825204cf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-normal-mode/interactions.js\":\"b8184be1943deb30\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/workspace-header/index.js\":\"e925400b6aeb7274\",\"/knowledge-medium/pr-preview/pr-1885/src/registerServiceWorker.js\":\"79260387a776c23b\",\"/knowledge-medium/pr-preview/pr-1885/src/requestPersistentStorage.js\":\"4ce44b4f6bd8b0f4\",\"/knowledge-medium/pr-preview/pr-1885/src/services/authRequestDeadline.js\":\"330267bbf4bd908b\",\"/knowledge-medium/pr-preview/pr-1885/src/services/authStorage.js\":\"764cb5bd2e094554\",\"/knowledge-medium/pr-preview/pr-1885/src/services/powersync.js\":\"aabc9797d2108b43\",\"/knowledge-medium/pr-preview/pr-1885/src/services/supabase.js\":\"47f1a9c499c94d18\",\"/knowledge-medium/pr-preview/pr-1885/src/services/uploadErrorClassifier.js\":\"8eddf0966f8e5dac\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/ActiveContexts.js\":\"413b652619f59234\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/HotkeyReconciler.js\":\"6010e533c1dd3330\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/WipeLocalDataDialog.js\":\"5b6b08d4772da625\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/actionDispatch.js\":\"4c16c8f5030bbc49\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/actionRefItems.js\":\"4f721d6632cd8c50\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/applyKeybindingOverrides.js\":\"aac850498915823f\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/blockActions.js\":\"c5fb15e6cc8dcc68\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/blockMergeGesture.js\":\"8bce3f343d837c02\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/canonicalizeChord.js\":\"31a6186dd7cc4851\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/defaultContexts.js\":\"82a702365995bcc4\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/defaultShortcuts.js\":\"9265fc193065f8e5\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/effectiveActions.js\":\"16e5c134336b0794\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/gestureAction.js\":\"12e0b3454e627f86\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/gestureBinding.js\":\"9dfe98ff26de51a7\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/holdRegistry.js\":\"ddf43bfaf438d41e\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/keybindingConflicts.js\":\"577f1c51cc0ddcef\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/keybindingOverrides.js\":\"1313012b0d9f65bf\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/pointerAction.js\":\"a5cdad6b0bd22795\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/resolve.js\":\"4145661b175b6e90\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/runAction.js\":\"fa1481d1422a4963\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/sequenceMatcher.js\":\"9705e40c5d6eaed9\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/types.js\":\"ab360e0c32aab58b\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/useActionContext.js\":\"f331e63dbf1c00c7\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/useActionDiscovery.js\":\"0df7e8a125d17a25\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/utils.js\":\"e13e5b026d2cb854\",\"/knowledge-medium/pr-preview/pr-1885/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1885/src/sw/bootStore.js\":\"d4a37ca2c4de8186\",\"/knowledge-medium/pr-preview/pr-1885/src/sw/previewDatabases.js\":\"6b369278656dcda0\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/byteTransform.js\":\"c8fa8c57b796d1af\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/attachmentCleaner.js\":\"032ffe8079ff2813\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/bundle/attachmentParts.js\":\"55ffe7b95960a5fd\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/bundle/bundleParts.js\":\"0cf52dc613763e31\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/bundle/bundleRecord.js\":\"964c38d044b4a3ec\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/bundle/manifest.js\":\"1a59656d098d936c\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/bundle/takeBundle.js\":\"5a0499e95d7c30ed\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/bundle/verifyBundle.js\":\"5d0f628b09a5c6ea\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/cleaningStage.js\":\"f65fe2e803d30f8d\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/conversionKey.js\":\"6d23a77a357f6c86\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/conversionServer.js\":\"f91a436bb62ee88e\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/flip.js\":\"a36a2c040b1541bb\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/flipAttempts.js\":\"34286a63502332c2\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/pages.js\":\"401695272a6de92c\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/preflight.js\":\"43c70183f10838fa\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/reseal.js\":\"82cb51d7946c902d\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/runConversion.js\":\"b9aaf882cac0f0d2\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/runLock.js\":\"224f6893c3183f77\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/sealing.js\":\"caf2be27ec384c72\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/sealingStage.js\":\"ac4c83ed83a20ace\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/stage.js\":\"f582cf5a4713e214\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/verifyReseal.js\":\"23b8c45d725f800c\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/aad.js\":\"7aab3c1b6182741b\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/aead.js\":\"7168bc1c77f7d327\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/base32.js\":\"083210b865c68e6a\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/base64url.js\":\"67127f0bf8c93f93\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/binaryEnvelope.js\":\"844eb2213968e357\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/byteAead.js\":\"e15450244a88501b\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/canary.js\":\"09ff0ed670344e85\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/contentHash.js\":\"196d7fabeaecce45\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/contentKey.js\":\"538ee127864eb7ed\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/derivedIdNamespace.js\":\"a93d32dc5e25e51c\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/envelope.js\":\"13244216b6eca780\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/hex.js\":\"b86662ae4db48402\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/sha256Hex.js\":\"77d44426fcb32097\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/workspaceKey.js\":\"015be4882586dad6\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/conversionState.js\":\"c465133192e78ccb\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/flows/createEncryptedWorkspace.js\":\"eb9002d468a392f2\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/flows/pastedKey.js\":\"752b820ba9dc4d96\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bce40e5913aa4a67\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c43e2f024fc92582\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/keyStore.js\":\"46d31588db0cb764\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/mintWorkspaceKey.js\":\"a77dbba4ac0b3441\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/modePin.js\":\"6ce7fe19be370679\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/openWorkspaceKeys.js\":\"32ca88f7715c0de0\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/resolveWorkspaceEntry.js\":\"d68dc9ca09497ddd\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/resolver.js\":\"6dddaafda6ad2cf0\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/workspaceAccess.js\":\"2048149bdc1cbdc2\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/transform.js\":\"bba73a1745dbd630\",\"/knowledge-medium/pr-preview/pr-1885/src/themeBootDefaults.js\":\"3a3856abe1d71c8a\",\"/knowledge-medium/pr-preview/pr-1885/src/types.js\":\"53860c803fc6cf54\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/ClientLocalSettings.js\":\"0ae150fa96a2aab7\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/abortableSleep.js\":\"4b642069ebda5a7f\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/array.js\":\"09b9f4926a58eba5\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/backlinkAutocomplete.js\":\"271fd459494247aa\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/blockCrumbs.js\":\"5d2bdda0008809e8\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/blockrefAutocomplete.js\":\"7a7ed6064f44488c\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/cadencedIdleJob.js\":\"b51deae179b45fa8\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/callbackSet.js\":\"91fb2099b7b00a04\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/clientId.js\":\"832561a4ac707386\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/codemirror.js\":\"9634d86baaec7c8b\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/codemirrorCompletion.js\":\"a1121fb150e26d3c\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/copy.js\":\"7199465cb366d75c\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/dailyPage.js\":\"92ffbbedf12e21db\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/dbForensics.js\":\"31313eeaeb2c68c3\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/dbForensicsHooks.js\":\"93ec1ddbfa78eeef\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/deleteBlockThroughUi.js\":\"cf4f40bb3846e22f\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/dialogs.js\":\"66e7603ba5fc0c29\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/dom.js\":\"41bfb1012c5c77a9\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/downloadBlob.js\":\"dc67d104b665eb70\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/drawnWalk.js\":\"8e0a0d521677e1c9\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/exportSqliteDb.js\":\"72f12b99850241e4\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/fileSystemAccess.js\":\"12db305fa78b910a\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/flipSlide.js\":\"e1b86def511f8310\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/fnv1a.js\":\"b3a2331be9942357\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/formatBytes.js\":\"354afe1ee9aaeedc\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/fuzzyRank.js\":\"afc173de7eb72283\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/idbKeyedStore.js\":\"e5840e3d25ee14f5\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/idleCallbackPolyfill.js\":\"8669aec41a651707\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/keyboardAwareScroll.js\":\"3f4e1e89d9ad6e09\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/keyboardViewport.js\":\"16e94a93387898b8\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/lastWorkspace.js\":\"92ddf5904a79fc73\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/layoutColumns.js\":\"74eb54e046b0cdbd\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/layoutSessionDom.js\":\"d025a56c7c40fae4\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/layoutSessionId.js\":\"9c3df77fbdd405b9\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/linkClickGestures.js\":\"49f70b3ffb4385c6\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/linkTargetAutocomplete.js\":\"f08abe19e4ac2211\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/localDbCorruption.js\":\"0f5f9ce4e7077aaf\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/localDbRecovery.js\":\"5743c3f3429821e0\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/markdownParser.js\":\"054d9a9a135cc7a9\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/memoize.js\":\"d4ab7b9d872deaf9\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/nameFieldCommit.js\":\"24f16f376d32baa9\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/nameList.js\":\"efc09220b867ca9c\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/navigation.js\":\"1f963b5a0cfe6915\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/omnilinerNamespace.js\":\"d387cc227fcb1210\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/opfsPageScan.js\":\"fe17674b7dc2c4a8\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/panelClearance.js\":\"46a8f2d4eeaf119b\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/panelHistory.js\":\"2ce05e3b36809c7a\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/panelLanes.js\":\"3d82c54aee2e47a0\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/panelLayoutProjection.js\":\"b793302307d22585\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/panelScrollAnchor.js\":\"bd710c036c94f2c3\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/panelUrlFlags.js\":\"b12a533a60a40f1c\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/platform.js\":\"1d18b3d22932c57b\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/pluralize.js\":\"37a735667cfabb4e\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/propertyCreation.js\":\"ccf6b3a51f1a9d09\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/propertyNavigation.js\":\"d29ed1fd7800fd51\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/propertyValueContext.js\":\"44a20df54c08a7cb\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/react.js\":\"cb53fae664965107\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/relativeDate.js\":\"a2fe2e779cb8a42e\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/relativeTime.js\":\"e01a1b56c039cf5f\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/renderScope.js\":\"0d1da666376a7319\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/resolvedThenable.js\":\"46ebff4e69e90bac\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/routing.js\":\"b73f59d9efbe4b72\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/safeMode.js\":\"11d4e8f34e0c434d\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/scheduleIdle.js\":\"f06192c366d56b8d\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/screenWakeLock.js\":\"d4c3dbbf7da7e13b\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/selection.js\":\"5b86cfaf7ad2a91e\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/softKeyboardGrab.js\":\"f58b04f61e456d86\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/startupTimeline.js\":\"9b8e3ebce6c2b5b4\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/state.js\":\"2cd53a899894f489\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/string.js\":\"03e945fa4cdb837a\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/surfaceZoom.js\":\"bf7e64f83eface7b\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/time.js\":\"52750792be660c34\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/toast.js\":\"64cde8e8c9016d97\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/toggleStore.js\":\"01e95918cee7513e\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/untilStopped.js\":\"dfc381b22d6b57cb\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/userActivity.js\":\"a24364eb321828da\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/viewTransition.js\":\"116b8b215d8dfe8e\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/viewport.js\":\"b094d3671f32f983\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/webLock.js\":\"19311ff59b208a94\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/workspaceRecovery.js\":\"7213b391ef9d8c46\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/workspaceSnapshotStore.js\":\"29b266d875cfe796\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-compiler-runtime.js\":\"c326c9f610ba377d\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom-client.js\":\"dde607ea92674ca1\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom-server-edge.js\":\"f0a7b7777ec1db8a\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom-server.js\":\"7cdaea1b206e699c\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom-static-edge.js\":\"775af6f4bf8cbca3\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom-static.js\":\"acdd48b99413aed3\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom-test-utils.js\":\"ef8b0caeee80e133\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom.js\":\"802a2b353268f083\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-jsx-runtime.js\":\"acde54675a030401\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react.js\":\"a383a0a0d6286441\",\"/knowledge-medium/pr-preview/pr-1885/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1885/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1885/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
