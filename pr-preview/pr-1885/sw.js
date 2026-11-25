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
		buildId: "1413749f6bcf-a41e541a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1885/\":\"a81f85985355ad3d\",\"/knowledge-medium/pr-preview/pr-1885/index.html\":\"a81f85985355ad3d\",\"/knowledge-medium/pr-preview/pr-1885/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1885/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1885/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1885/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1885/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1885/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1885/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1885/assets/FacadeVFS-BEA4bXRc.js\":\"e31ca45f7aeed5b4\",\"/knowledge-medium/pr-preview/pr-1885/assets/OPFSCoopSyncVFS-Pa42VKLc.js\":\"56880f9bd72e08bb\",\"/knowledge-medium/pr-preview/pr-1885/assets/OPFSWriteAheadVFS-wqcepo5V.js\":\"c9ebbf11f0380d0c\",\"/knowledge-medium/pr-preview/pr-1885/assets/wa-sqlite-BoFS5RED.js\":\"ab5d535fa1d8503a\",\"/knowledge-medium/pr-preview/pr-1885/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1885/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1885/assets/wa-sqlite-async-CtlLozeS.js\":\"1a35bd904dd72081\",\"/knowledge-medium/pr-preview/pr-1885/assets/worker-CeBdWffy.js\":\"8fcc1e8eccdcaa91\",\"/knowledge-medium/pr-preview/pr-1885/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1885/chunks/app-DlFEfcGd.js\":\"af3b264cfbb29ddf\",\"/knowledge-medium/pr-preview/pr-1885/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1885/index.js\":\"d334d73d71550b9f\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1885/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1885/assets/AccessHandlePoolVFS-D7qkRMTq.js\":\"10e7691ee36dba17\",\"/knowledge-medium/pr-preview/pr-1885/assets/IDBBatchAtomicVFS-CGTRitD2.js\":\"5d7cbc074ee8857f\",\"/knowledge-medium/pr-preview/pr-1885/assets/MemoryVFS-BRcnzeRH.js\":\"d8511efc1c0a6599\",\"/knowledge-medium/pr-preview/pr-1885/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1885/assets/mc-wa-sqlite-async-BvI5Sqtf.js\":\"57c3cc94e74230f0\",\"/knowledge-medium/pr-preview/pr-1885/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1885/assets/mc-wa-sqlite-tR0x7wJO.js\":\"0515ba460145f721\",\"/knowledge-medium/pr-preview/pr-1885/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1885/chunks/AccessHandlePoolVFS-CFUemHZV.js\":\"81cd4260a5bedcb0\",\"/knowledge-medium/pr-preview/pr-1885/chunks/FacadeVFS-C9xmSCHm.js\":\"e6398289a90ef018\",\"/knowledge-medium/pr-preview/pr-1885/chunks/IDBBatchAtomicVFS-D4ilh5Wz.js\":\"4f7aab5c3baba7be\",\"/knowledge-medium/pr-preview/pr-1885/chunks/MemoryVFS-D8z2Gj2h.js\":\"e992c39746404c2a\",\"/knowledge-medium/pr-preview/pr-1885/chunks/OPFSCoopSyncVFS-hHzkvjRR.js\":\"3f0560c1055877ca\",\"/knowledge-medium/pr-preview/pr-1885/chunks/OPFSWriteAheadVFS-D7G8n1vA.js\":\"21f7e3c56ef41bf2\",\"/knowledge-medium/pr-preview/pr-1885/chunks/Preview-ByAkYNFx.js\":\"9e0c26b881c8d7d6\",\"/knowledge-medium/pr-preview/pr-1885/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1885/chunks/card-A6UobORS.js\":\"605a070ec40a1121\",\"/knowledge-medium/pr-preview/pr-1885/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1885/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1885/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1885/chunks/dist-DTzxvjNa.js\":\"4901896c79050983\",\"/knowledge-medium/pr-preview/pr-1885/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1885/chunks/mc-wa-sqlite-DrkZqFGx.js\":\"ee00074b8218db0c\",\"/knowledge-medium/pr-preview/pr-1885/chunks/mc-wa-sqlite-async-D-QnxCi0.js\":\"0bc985c379c96cb7\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-B7LdvlkQ.js\":\"f9fddd4102aabe74\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-B9BUxw1r.js\":\"5c577d3d81612529\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-BMOPcx-H.js\":\"12941887b41c73ae\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-BeSBm_7d.js\":\"0820868926f34302\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-BgfjdwpW.js\":\"d706ec758e7152b1\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-CexrA6DJ.js\":\"68381424f90f09c3\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-D4JshnLE.js\":\"369e96616cbfac01\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-DXOSx-2W.js\":\"26a8fb6d84af477a\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-dom-server-legacy.browser.production-CsT_BSph.js\":\"c7423470fe7d0df7\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-dom-server.browser.production-BpiMYh6i.js\":\"8984b7bb03102273\",\"/knowledge-medium/pr-preview/pr-1885/chunks/react-dom-server.edge.production-B2VFJ1Po.js\":\"796da431c09552de\",\"/knowledge-medium/pr-preview/pr-1885/chunks/server.browser-BVMX-eeS.js\":\"019ef2f2a001b8cd\",\"/knowledge-medium/pr-preview/pr-1885/chunks/textarea-DKOb2ntU.js\":\"bdb66fdcc15d93cb\",\"/knowledge-medium/pr-preview/pr-1885/chunks/ui-qDak87y0.js\":\"4bbf8ed30ad02f83\",\"/knowledge-medium/pr-preview/pr-1885/chunks/wa-sqlite-DKhZTeeS.js\":\"da0600f9f8389406\",\"/knowledge-medium/pr-preview/pr-1885/chunks/wa-sqlite-async-B62ov03s.js\":\"32f2a1a7ff3c2f01\",\"/knowledge-medium/pr-preview/pr-1885/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1885/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1885/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1885/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1885/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1885/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1885/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1885/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1885/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1885/src/App.js\":\"65f696af8f2246dd\",\"/knowledge-medium/pr-preview/pr-1885/src/appUpdate.js\":\"cffc3ac5be61a9e0\",\"/knowledge-medium/pr-preview/pr-1885/src/appVersion.js\":\"6fa28d8f05178f03\",\"/knowledge-medium/pr-preview/pr-1885/src/bootstrap/initialLayout.js\":\"24e1f051db10c0b9\",\"/knowledge-medium/pr-preview/pr-1885/src/bootstrap/openWorkspaceData.js\":\"ee3547ee722b0af4\",\"/knowledge-medium/pr-preview/pr-1885/src/bootstrap/resolveWorkspace.js\":\"9419a47cda633ba0\",\"/knowledge-medium/pr-preview/pr-1885/src/bootstrap/workspaceBootstrap.js\":\"995e7ad2fc2273fb\",\"/knowledge-medium/pr-preview/pr-1885/src/components/BlockComponent.js\":\"950ea4b97b6baecb\",\"/knowledge-medium/pr-preview/pr-1885/src/components/BlockCrumbs.js\":\"ac9e9fd9bbad3249\",\"/knowledge-medium/pr-preview/pr-1885/src/components/BlockEditor.js\":\"5f1f84d1bbb5cdfc\",\"/knowledge-medium/pr-preview/pr-1885/src/components/BlockLoadingPlaceholder.js\":\"7473eb49fff18749\",\"/knowledge-medium/pr-preview/pr-1885/src/components/BlockProperties.js\":\"458815fe42e54dd7\",\"/knowledge-medium/pr-preview/pr-1885/src/components/BlockSearchPicker.js\":\"8e4e656469cf0f9b\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ConfirmBulkDeleteDialog.js\":\"4c002445dda10bb1\",\"/knowledge-medium/pr-preview/pr-1885/src/components/DividerHandle.js\":\"791e1445ca91c70e\",\"/knowledge-medium/pr-preview/pr-1885/src/components/DraftEditor.js\":\"46ffb36bf7b4f89c\",\"/knowledge-medium/pr-preview/pr-1885/src/components/GutterPill.js\":\"7dbe18699b71b2e9\",\"/knowledge-medium/pr-preview/pr-1885/src/components/Header.js\":\"e9bab017dd1a7d54\",\"/knowledge-medium/pr-preview/pr-1885/src/components/LazyBlockComponent.js\":\"12b912b771f2419f\",\"/knowledge-medium/pr-preview/pr-1885/src/components/Login.js\":\"0783e6e1a7aeb1bf\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ZoomableSurface.js\":\"8fe912a5c663c365\",\"/knowledge-medium/pr-preview/pr-1885/src/components/editModeKeepalive.js\":\"c334c69327137e1b\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyDisplay/PropertyDisplayScope.js\":\"60647beb2035a1a4\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a6c98665230a0b8b\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/RefPropertyEditor.js\":\"d4b28af7e7376d8f\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/RefTargetTypePicker.js\":\"63a451492a5896eb\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/SelectPropertyEditor.js\":\"f75e7cfdbd2744c7\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/TypesPropertyEditor.js\":\"805fb4cdc2263125\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/defaults.js\":\"4ca94d47584498ea\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/kernelValuePresets.js\":\"308cfe4b2c8302e0\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/selectablePresets.js\":\"9e89ae1759d685fc\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyEditors/typesPropertyUi.js\":\"1f24853d6c5794c3\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/AddPropertyForm.js\":\"29dd5ac4fdc60b33\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/PropertyPicker.js\":\"28ddc427f2008f5b\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/PropertyRow.js\":\"d0a21305f566bbd8\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/Rows.js\":\"e21e863a01810d89\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/actions.js\":\"52045772c2a262f0\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/declarationOnly.js\":\"0220621118d48844\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/layout.js\":\"e04a05257f75b16d\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/model.js\":\"30b2866e7e4991f6\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/shapeUi.js\":\"8e01b67611b0e965\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/shapes.js\":\"19eb0b3d2c2396c8\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e6129cc80966af81\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanel/visibility.js\":\"287400e61fd64f02\",\"/knowledge-medium/pr-preview/pr-1885/src/components/propertyPanelSections.js\":\"7e66986fcf913e04\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/BlockEmbed.js\":\"95bccda9f1f4f5f2\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/BlockLink.js\":\"d0f26e118fcbdf23\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/BlockRef.js\":\"5453a0ebe38529c9\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/ReferenceLink.js\":\"7b6415124a6f5c11\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/cycleGuard.js\":\"a3c73caf1e79cb00\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/cycleGuardContext.js\":\"0deca1d62c94c8af\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/linkInteraction.js\":\"4797e9492bdf5db1\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/referenceLayout.js\":\"4a07f38d6430715e\",\"/knowledge-medium/pr-preview/pr-1885/src/components/references/useBlockRefAncestors.js\":\"1ae970a5ae687375\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/BlockGutter.js\":\"a63bbcde4a51d4f2\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/BlockInfoDialog.js\":\"f685405c96b860ec\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/BlockTypeBlockRenderer.js\":\"db18426c03661496\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/BulletHoverCard.js\":\"c0477877287aaed1\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/CodeMirrorContentRenderer.js\":\"00714bfb6bf42ffe\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"87dac718be20c2d5\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/ColumnResizeHandles.js\":\"126e314bfc55af3a\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"726e092517ccd098\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/DefaultBlockRenderer.js\":\"218c2870ad589529\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/LayoutRenderer.js\":\"5157c73eb947be04\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/MarkdownContentRenderer.js\":\"9b3fafc0048baf1e\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/MissingDataRenderer.js\":\"c1e308da5114641d\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/PanelRenderer.js\":\"c3219553601bee5c\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e513ece7d7424e8d\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/TopLevelRenderer.js\":\"9b2146dbaa15d7c8\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/blockGutterMode.js\":\"237da89e44d3da68\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/blockTitleText.js\":\"00cd6350f860d65d\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/fieldCreationKeydown.js\":\"5948183bac5393f6\",\"/knowledge-medium/pr-preview/pr-1885/src/components/renderer/layoutRootContext.js\":\"e6085cbe7e311f83\",\"/knowledge-medium/pr-preview/pr-1885/src/components/typeChip/TypeChip.js\":\"632b94ff1e008139\",\"/knowledge-medium/pr-preview/pr-1885/src/components/typeChip/chipStyle.js\":\"b7e3fce7aeee855c\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/anchored-floating.js\":\"157a2e572b348fb5\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/button.js\":\"5cff0e0483158885\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/card.js\":\"8328ef1321d2545c\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/checkbox.js\":\"f4e409f548074296\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/collapsible.js\":\"d85f9ee9192be6b1\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/command.js\":\"22088e996b804c80\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/context-menu.js\":\"6c43c2076bbef08b\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/dialog.js\":\"68fdeaf47bf2caec\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/dropdown-menu.js\":\"7cdb2b8ccd48f4ef\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/floating-listbox.js\":\"673becffd0b067e4\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/index.js\":\"468493668f4fbc85\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/input.js\":\"a1047976a9c9b346\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/kbd.js\":\"229c9ea4cde8c4d5\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/label.js\":\"1443ac3f52270d21\",\"/knowledge-medium/pr-preview/pr-1885/src/components/ui/textarea.js\":\"f2a6c15dd6de6eff\",\"/knowledge-medium/pr-preview/pr-1885/src/components/useEditModeYieldKeepalive.js\":\"aa85343c45117aaf\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/BootFallback.js\":\"264c7aa83b913025\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/FocusedRowLazyMount.js\":\"298f05bf083861c1\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/LazyViewportMount.js\":\"4852723c1999cc20\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/LocalDbCorruptionFallback.js\":\"ad151f3974375407\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/error.js\":\"b1b80857898cdb2d\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/lazyMountRegistry.js\":\"abf992d90d918fba\",\"/knowledge-medium/pr-preview/pr-1885/src/components/util/suspense.js\":\"c26d0192d80d9d29\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/CreateWorkspaceDialog.js\":\"8af730bea42aa7ef\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/PendingInvitations.js\":\"36ebfa4451ae6588\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/SyncProgress.js\":\"39cb2524364c1201\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/UnlockProgress.js\":\"41d5cf864a812034\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/WorkspaceKeyGate.js\":\"78a3bab397677d91\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/WorkspaceSettingsDialog.js\":\"7212f0e613131f0f\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/WorkspaceSwitcher.js\":\"e1ad1536d824ff92\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/WorkspaceSyncGate.js\":\"a4000a2571e477de\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/ConversionFlow.js\":\"f845a17ce1c049b4\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/ConversionFlowHost.js\":\"5fdf0aeb2a8d2fbc\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/EncryptionSection.js\":\"198ed5cc73e441ce\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/attachmentPrompts.js\":\"484a0a587f7ccd0a\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/bundleFolderPrompts.js\":\"25b24086a91438fd\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/conversionFlowDeps.js\":\"5216f5ece3e38ab0\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/conversionFlowStore.js\":\"956d64846c0f8c56\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/flowUi.js\":\"e32ec8367d16185a\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/conversion/useConversionRun.js\":\"157b34976a80b004\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/keyUi.js\":\"5d5ca38b2d2c82d3\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/useCloseOnKeyLoss.js\":\"ff2b5fc7e07ab8c1\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/useCloseOnServerE2ee.js\":\"7f31f99fc4f92ca1\",\"/knowledge-medium/pr-preview/pr-1885/src/components/workspace/workspaceUnlocked.js\":\"f0f4fc225c996d79\",\"/knowledge-medium/pr-preview/pr-1885/src/context/backgroundSubtree.js\":\"1a77fed6992e449e\",\"/knowledge-medium/pr-preview/pr-1885/src/context/block.js\":\"d03deaaf34525af3\",\"/knowledge-medium/pr-preview/pr-1885/src/context/layoutWsContext.js\":\"b9b0b0256a35ae0f\",\"/knowledge-medium/pr-preview/pr-1885/src/context/propertyDisplay.js\":\"fe87556bcb224c1b\",\"/knowledge-medium/pr-preview/pr-1885/src/context/repo.js\":\"a2b575387e27e9a4\",\"/knowledge-medium/pr-preview/pr-1885/src/data/aliasClaim.js\":\"64ec6351ebb6b482\",\"/knowledge-medium/pr-preview/pr-1885/src/data/aliasSeatNamespace.js\":\"a8d4ba82d9ed58a4\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/blockData.js\":\"e1e9622533f4ee68\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/blockType.js\":\"eecd17373b61b73c\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/changeScope.js\":\"58a38df522bdc14a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/codecs.js\":\"dfe78a5cc1282446\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/derivedData.js\":\"2669742b376a71fb\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/errors.js\":\"30578943ed462aa7\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/events.js\":\"8051da163d188f88\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/handle.js\":\"36dd29c51453156e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/index.js\":\"fc8d769bfcb52fa5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/mutator.js\":\"e9cb8bb0c7142cf4\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/processor.js\":\"ea7e39641d7a92b0\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/propertySchema.js\":\"1b90cf9bfb4b463b\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/query.js\":\"61cf65a055099da6\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/sameTxProcessor.js\":\"713863616a6a9506\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/schema.js\":\"36dd29c51453156e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/tx.js\":\"36dd29c51453156e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/typedBlockQuery.js\":\"cf12134243efd119\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/user.js\":\"8ca798d5721505e7\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/valuePresetCore.js\":\"b2f9c9acdc22a03e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/api/valuePresets.js\":\"3df33f958a8dd961\",\"/knowledge-medium/pr-preview/pr-1885/src/data/attachmentCleanerIOVerb.js\":\"d6cb8d64222f40f0\",\"/knowledge-medium/pr-preview/pr-1885/src/data/block.js\":\"31c153e5ecdad7d4\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockCache.js\":\"26b25fa139d904a5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockId.js\":\"57248bf8773f6497\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockLiveness.js\":\"4e7bc4698f070879\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockMerge.js\":\"12402d44836f76b7\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockSchema.js\":\"c5866f36121fe1e5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockTypeLookup.js\":\"9ee584c07dec76d9\",\"/knowledge-medium/pr-preview/pr-1885/src/data/blockTypes.js\":\"793955b54803f217\",\"/knowledge-medium/pr-preview/pr-1885/src/data/childrenView.js\":\"d17922200087f98a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/clientContext.js\":\"0fa400282e69c31a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/dbFileSiblings.js\":\"39ba09244947d8d2\",\"/knowledge-medium/pr-preview/pr-1885/src/data/definitionSeeds.js\":\"dc4dd9ee1fdda6ec\",\"/knowledge-medium/pr-preview/pr-1885/src/data/derivedIds.js\":\"a54d4a85b8990f00\",\"/knowledge-medium/pr-preview/pr-1885/src/data/drawnSubtree.js\":\"3026e758abe2abc2\",\"/knowledge-medium/pr-preview/pr-1885/src/data/facetBridge.js\":\"5337e8b2d8f8ecf1\",\"/knowledge-medium/pr-preview/pr-1885/src/data/facets.js\":\"fd389a29cf717803\",\"/knowledge-medium/pr-preview/pr-1885/src/data/globalState.js\":\"c42cff964155db47\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/aliasClaimRederiveProcessor.js\":\"46de62c8db2f734c\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/ancestorBatch.js\":\"8ab74b06691c9c89\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/blockTypeTypeifyProcessor.js\":\"a31d6e3bb30fb4b1\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/clientSchema.js\":\"cbec2fb44ebc45b6\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/commitPipeline.js\":\"61671675afaf2d71\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/devAssertions.js\":\"57a35955b0b35927\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/firstSync.js\":\"27f3f4e05da3f3ef\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/freshInitialLoad.js\":\"b557d8c72d91025b\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/graphBackfillClaim.js\":\"7fd0d42af05595a0\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/handleStore.js\":\"135eff5c20d18767\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/idleMarkerJobs.js\":\"257a93d7371ac0b5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/initialDownload.js\":\"f4177c50fc027fef\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/initializeClientDatabase.js\":\"234e9bcffca8a7bc\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/jsonCanonical.js\":\"5ee96bce023d15ae\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/kernelInvalidation.js\":\"44e5bedbbcdf10ef\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/kernelProcessors.js\":\"e46e79aab78bca4f\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/kernelQueries.js\":\"fd2f1308e8c19a5f\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/mergeTypeMembershipProcessor.js\":\"696a7805841b9747\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/normalizeReferencesProcessor.js\":\"aa19ecbc681995e6\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/poolInstrumentation.js\":\"138d052c7f68e465\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/processorRunner.js\":\"3b362aed4a94d6e4\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyCellBackfill.js\":\"04413bb7b2117375\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyChildMint.js\":\"2966a19186ccdd98\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyChildrenProcessor.js\":\"f19a590dded67f00\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyDefinitionChangeProcessor.js\":\"dfed777fbcf93fb9\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyDefinitionSynthesis.js\":\"dababd4f9ba91941\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyKeyScan.js\":\"84d38ab4bac446a6\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertySchemaResolution.js\":\"694c00c68196c34e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/propertyValueEdits.js\":\"c5bba2198cca6cd1\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/raiseProtocol.js\":\"4cc12c2b87cba3f1\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/readBatch.js\":\"5f37cad715debbbc\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/refProjection.js\":\"da347414236e5da5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/referenceTargetLookups.js\":\"28ee69a9b38e9a32\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/referenceTargetProcessor.js\":\"509e80401cc09281\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/replayMerge.js\":\"74b46c9d1626b749\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/sqlBinds.js\":\"58cda0ff5f7a0573\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"3a1a61daa438f636\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/syncObserver/arrivalProcessors.js\":\"0c2c38b8491c69c3\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/syncObserver/invalidate.js\":\"d7ef4d8e673ba660\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/syncObserver/materialize.js\":\"91819179725c1a1a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/syncObserver/observer.js\":\"d06bc9e9afbd6e64\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/syncObserver/reconcile.js\":\"a1752cba459c32ba\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/timingMetrics.js\":\"435fa8584e0358c7\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/treeQueries.js\":\"d43c43e7712552b5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/txEngine.js\":\"527b06e53e71d01d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/txSnapshots.js\":\"249395c4a74b97a8\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/typedBlockQuery.js\":\"3ead4a16540336c3\",\"/knowledge-medium/pr-preview/pr-1885/src/data/internals/undoManager.js\":\"6b1854faf36f1917\",\"/knowledge-medium/pr-preview/pr-1885/src/data/invalidation.js\":\"ed649b0cff0c7b67\",\"/knowledge-medium/pr-preview/pr-1885/src/data/kernelDataExtension.js\":\"a976d38584d092e7\",\"/knowledge-medium/pr-preview/pr-1885/src/data/kernelPage.js\":\"a678336b149bc4ad\",\"/knowledge-medium/pr-preview/pr-1885/src/data/kernelValuePresetCores.js\":\"53c7ee1f05ceb2d2\",\"/knowledge-medium/pr-preview/pr-1885/src/data/localDbCorruptionSignal.js\":\"3715a7a3ba81fee5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/localDbStorage.js\":\"a9ff3859ef238e6c\",\"/knowledge-medium/pr-preview/pr-1885/src/data/localDbVfs.js\":\"366015b541a8a6ee\",\"/knowledge-medium/pr-preview/pr-1885/src/data/localSchema.js\":\"a99faafae621008a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/maintenance.js\":\"6a192eee996ecc88\",\"/knowledge-medium/pr-preview/pr-1885/src/data/mergeProperties.js\":\"68772bf409ada71d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/metricsConsoleHook.js\":\"40f84828430199cd\",\"/knowledge-medium/pr-preview/pr-1885/src/data/migrationsPage.js\":\"c08fbb5de19cf309\",\"/knowledge-medium/pr-preview/pr-1885/src/data/mutators.js\":\"33afb34069472a7c\",\"/knowledge-medium/pr-preview/pr-1885/src/data/orderKey.js\":\"4ca996f86fcee69a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/orderKeyPlacement.js\":\"b2b8f44afce7171e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/outlineSurface.js\":\"eafd9784a06c745e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/pendingEditorContent.js\":\"09160c26938eaa42\",\"/knowledge-medium/pr-preview/pr-1885/src/data/pendingUploadsSql.js\":\"bc2f08e84521bad9\",\"/knowledge-medium/pr-preview/pr-1885/src/data/pluginStateExtensions.js\":\"da45300271688943\",\"/knowledge-medium/pr-preview/pr-1885/src/data/powerSyncLogger.js\":\"8a40698449f59ae1\",\"/knowledge-medium/pr-preview/pr-1885/src/data/projectorRuntime.js\":\"1587c87934d72815\",\"/knowledge-medium/pr-preview/pr-1885/src/data/properties.js\":\"fe819c3a3fb30b79\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertiesPage.js\":\"174c3ecb1700330e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertyChildren.js\":\"cda412f9676f3bf0\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertyDefinitionFanout.js\":\"725aeaab2a0ec6e5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertyDefinitionMetadata.js\":\"2bf8182607ef8326\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertyDefinitionRegistry.js\":\"5f297673e6479534\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertyDisplayMode.js\":\"3a91132784089f93\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertyRowCreation.js\":\"1012619f39b09856\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertySchemaCreation.js\":\"d8e696aed8e62bf4\",\"/knowledge-medium/pr-preview/pr-1885/src/data/propertySeeds.js\":\"84660184caff0318\",\"/knowledge-medium/pr-preview/pr-1885/src/data/recentsPage.js\":\"8359fe2f6a8d1ff4\",\"/knowledge-medium/pr-preview/pr-1885/src/data/refTargetComparableProperty.js\":\"a2b1b690396172d7\",\"/knowledge-medium/pr-preview/pr-1885/src/data/referenceBlock.js\":\"8ade96c4b1ff90a0\",\"/knowledge-medium/pr-preview/pr-1885/src/data/rejectedUploads.js\":\"8786404230b22a16\",\"/knowledge-medium/pr-preview/pr-1885/src/data/releasePowerSyncConnection.js\":\"d01ad0bf5635fc1c\",\"/knowledge-medium/pr-preview/pr-1885/src/data/repo.js\":\"700946f6df18a8f8\",\"/knowledge-medium/pr-preview/pr-1885/src/data/repoProvider.js\":\"548857a00ef4dac6\",\"/knowledge-medium/pr-preview/pr-1885/src/data/rowProperty.js\":\"ca24770b52e485a0\",\"/knowledge-medium/pr-preview/pr-1885/src/data/searchFilter.js\":\"ca69a32b3dd3b472\",\"/knowledge-medium/pr-preview/pr-1885/src/data/seedIdentityLedger.js\":\"8e22aa3b91ced130\",\"/knowledge-medium/pr-preview/pr-1885/src/data/stateBlocks.js\":\"092f11e703cce493\",\"/knowledge-medium/pr-preview/pr-1885/src/data/structuralEditPolicy.js\":\"64f9d6246580613b\",\"/knowledge-medium/pr-preview/pr-1885/src/data/structuralInsert.js\":\"375affa755934172\",\"/knowledge-medium/pr-preview/pr-1885/src/data/subtreeDelete.js\":\"382176e20f45bc8d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/syncStreamLock.js\":\"04cb10f34fd0194a\",\"/knowledge-medium/pr-preview/pr-1885/src/data/syncedTableSqlRecognizer.js\":\"9ab780417825a256\",\"/knowledge-medium/pr-preview/pr-1885/src/data/syncedTableWriteGuard.js\":\"7a3bdb4bce200ff5\",\"/knowledge-medium/pr-preview/pr-1885/src/data/targets.js\":\"efdd9adaee732908\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeColors.js\":\"a422058f48eeaee3\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeDefinitionMetadata.js\":\"125387eb41599e21\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeDefinitionRegistry.js\":\"52f201196d6beb9d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeExtraction.js\":\"e6abce906956927e\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeInitialValues.js\":\"1560399edea059b3\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typePropertyGroups.js\":\"f71a71245744e556\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeSeeds.js\":\"a8bc6e5a19bca4a6\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typeTagger.js\":\"8c61487cfc5c2f67\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typedRecords.js\":\"f1aa56685945373d\",\"/knowledge-medium/pr-preview/pr-1885/src/data/typesPage.js\":\"878f4ca700b3f0ca\",\"/knowledge-medium/pr-preview/pr-1885/src/data/userPrefs.js\":\"f803923c3d1efd35\",\"/knowledge-medium/pr-preview/pr-1885/src/data/userSchemasService.js\":\"d9e31c2bba5d56ed\",\"/knowledge-medium/pr-preview/pr-1885/src/data/userTypesService.js\":\"2a304c24d97e8730\",\"/knowledge-medium/pr-preview/pr-1885/src/data/valuePresetRegistry.js\":\"546b462d31cb65a4\",\"/knowledge-medium/pr-preview/pr-1885/src/data/visibleChildren.js\":\"44c6d8a7aa437294\",\"/knowledge-medium/pr-preview/pr-1885/src/data/workspaceConversion.js\":\"79f2ea612cefa6c6\",\"/knowledge-medium/pr-preview/pr-1885/src/data/workspaceFirstSync.js\":\"24f127acd8840fcc\",\"/knowledge-medium/pr-preview/pr-1885/src/data/workspaceIdNamespace.js\":\"8de0d5cf5d414bc1\",\"/knowledge-medium/pr-preview/pr-1885/src/data/workspaceSchema.js\":\"39c39e034625d900\",\"/knowledge-medium/pr-preview/pr-1885/src/data/workspaces.js\":\"26e11d6ed028d959\",\"/knowledge-medium/pr-preview/pr-1885/src/data/writeAheadLog.js\":\"02f6c18ba40241ac\",\"/knowledge-medium/pr-preview/pr-1885/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/BlockPasteShellDecorator.js\":\"b2da7d6cf8033d54\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/atTrigger.js\":\"7c7dce3521ba87e1\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/autocomplete.js\":\"7397d7c78d94f26e\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/codeMirrorExtensions.js\":\"a54489d0ddbfc11f\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/contentFlush.js\":\"e2f513efb9d27c43\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/defaultInteractions.js\":\"cc4c9eb9b613e6f5\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/editSettleSignal.js\":\"c5a4b4b3f38fc134\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/insertImage.js\":\"cc87d0da1a4e33e0\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/referenceCompletionRange.js\":\"7423cc6b9997a769\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/referenceTargetTypes.js\":\"4713c1ea48286c2f\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/syntaxContext.js\":\"dd0cfb110a5bc2eb\",\"/knowledge-medium/pr-preview/pr-1885/src/editor/triggerMatch.js\":\"fff2e726a5f63566\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/AppRuntimeProvider.js\":\"9b1265695fa8a4a5\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/BlockFocusShellDecorator.js\":\"a951bf79824689ca\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/ExtensionRenderBoundary.js\":\"95a1be90d1e5cf3a\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/PanelContentRecovery.js\":\"730fce8e09b2b981\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/apiCatalog.js\":\"ea1dc68121bf2d0f\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/approveExtensionHere.js\":\"040e7e3a2bdcd212\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/armedCutAppMount.js\":\"7458fb7b81510e7a\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/batchableKeyedStore.js\":\"a290b360355ac9da\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/blockInteraction.js\":\"1143e8bc35612587\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/blockSelectionAction.js\":\"bcdd5641336bfd8a\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/compileExtensionModule.js\":\"82c01aa4f8e7fb00\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/compiledModuleCache.js\":\"e7e2d0e0cf9acaf1\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/continuousGestures.js\":\"549f4136fc238a47\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/core.js\":\"979e94ce03bc5dfc\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/defaultRenderers.js\":\"0bc6d1df057d74ef\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/definitionFanoutAppMount.js\":\"667e58b9a7c2cc3b\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/dialogAppMount.js\":\"3e748875b341fd51\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/dynamicExtensionSeeds.js\":\"b9b7307b4e8de3b4\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/dynamicExtensions.js\":\"d9c49ae550f29d67\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/exampleExtensions.js\":\"95bd5593541dbd38\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/extensionApprovalStatus.js\":\"f6f2e24057dac25e\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/extensionLoadErrorToast.js\":\"98295d5727a6cc67\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/extensionLoadErrors.js\":\"13b31d54e2cb9e43\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/extensionLookup.js\":\"685ade17e81f6e6f\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/extensionToggles.js\":\"9a898d08e357354b\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/extensionUtilitiesCss.js\":\"4b16df4f2871b749\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/kernelPageDeletionGuard.js\":\"59f960fcdf651a01\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/liveRuntime.js\":\"6ea879e04e2bb841\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/openExtensionsSettings.js\":\"4407a84f9c943d84\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/overridesCache.js\":\"9e8aa4c91db21831\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/pluginIds.js\":\"23e8c744875516b5\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/processorRejectionToast.js\":\"4c0d263f523e869a\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/runtimeActions.js\":\"f2180d3f223d8a85\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/runtimeContext.js\":\"07e3a1813a76ce6b\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/staticAppExtensions.js\":\"48379ebea309e92e\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/staticDataExtensions.js\":\"b168e544225ae9d3\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/toastAppMount.js\":\"b42a5a96c42bf3ed\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/useOverrides.js\":\"003f41924e4959a6\",\"/knowledge-medium/pr-preview/pr-1885/src/extensions/useShortcutSurfaceActivations.js\":\"e4517bbe372802d3\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/discoverToggleTree.js\":\"4d5ce5455046e18a\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/facet.js\":\"bf8422a056424c14\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/resolveAppRuntime.js\":\"6e0433fa1e94ecd5\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/runtimeEvents.js\":\"86bd9d76bd865933\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/togglable.js\":\"432c0650a5ab0746\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/variantFacet.js\":\"ba5156f7def5f4b5\",\"/knowledge-medium/pr-preview/pr-1885/src/facets/verbFacet.js\":\"aa88bcb33640df51\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/block.js\":\"c372e4b7503d37a1\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/focusedChild.js\":\"125ba3f5f02d6390\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/propertySchemas.js\":\"a64c6f77a9ee9dbc\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/typeRegistry.js\":\"442763eb893b839f\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useAncestorCrumbs.js\":\"d81bff103dcac4ed\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useAutocompleteListbox.js\":\"f0a4136709f6fdc3\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useDebouncedSearch.js\":\"35d0ca06b063d054\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useDebouncedValue.js\":\"d62cb1b76d82da05\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useFacetValue.js\":\"f817e9b3b52b0932\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useIsFocalRender.js\":\"ff900905b93108a0\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useIsReadOnly.js\":\"e582d4482d3715e5\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useMaterializeBacklog.js\":\"79cbb1bd59a5330f\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useMinuteClock.js\":\"83e09ad4211df909\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/usePanelLayoutProjection.js\":\"4926f8c2dab60f29\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/usePendingInvitations.js\":\"c39edc647fe3c117\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useRendererRegistry.js\":\"72dc6b285857547f\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useRetainedFieldRows.js\":\"ac7fd2908c2ffb29\",\"/knowledge-medium/pr-preview/pr-1885/src/hooks/useWorkspaces.js\":\"5fa8bbf0b5276d47\",\"/knowledge-medium/pr-preview/pr-1885/src/lib/utils.js\":\"228027feec1cfbd1\",\"/knowledge-medium/pr-preview/pr-1885/src/main.js\":\"8058732cce5df2cd\",\"/knowledge-medium/pr-preview/pr-1885/src/markdown/MarkdownImage.js\":\"c2c81b8a0746e569\",\"/knowledge-medium/pr-preview/pr-1885/src/markdown/blockSeparators.js\":\"fa5e46b2dc79ea9a\",\"/knowledge-medium/pr-preview/pr-1885/src/markdown/context.js\":\"0ae176fc74169899\",\"/knowledge-medium/pr-preview/pr-1885/src/markdown/defaultMarkdownExtension.js\":\"3a862059e007e823\",\"/knowledge-medium/pr-preview/pr-1885/src/markdown/extensions.js\":\"2f7dd1c8bec2ebc0\",\"/knowledge-medium/pr-preview/pr-1885/src/markdown/renderMarkdownHtml.js\":\"6774c88b988e71c3\",\"/knowledge-medium/pr-preview/pr-1885/src/minimal-editor.js\":\"f7545120a35bc1b0\",\"/knowledge-medium/pr-preview/pr-1885/src/paste/armedCut.js\":\"03da4b4b3ea51ace\",\"/knowledge-medium/pr-preview/pr-1885/src/paste/captureMediaVerb.js\":\"68268d083b51b616\",\"/knowledge-medium/pr-preview/pr-1885/src/paste/clipboard.js\":\"3c6850a093ac4dc9\",\"/knowledge-medium/pr-preview/pr-1885/src/paste/decision.js\":\"e4c8c026baa5c777\",\"/knowledge-medium/pr-preview/pr-1885/src/paste/operations.js\":\"84e5946e92afd8eb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/account-header/AccountHeaderItem.js\":\"e812033fc4f8cdb6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/account-header/index.js\":\"34c3a8ee2173eda7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4e29e68e52d76072\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/askAgent.js\":\"7be8f84253c1f6f7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/askedStore.js\":\"48faa77bee95b62f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"cf9c7bdad534d616\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/chipState.js\":\"0dee8e1c4562a670\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/dataExtension.js\":\"fde347a0267dcb33\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/index.js\":\"ea2c5dbc1f302b8e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"fd70773b40642ebb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-dispatch-companion/schema.js\":\"1f113f2375815402\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/AgentTokensDialog.js\":\"fd4d2411bad6675e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5af5c6f178ab16cc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/addMedia.js\":\"bdb08cbe268b1c4b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/backlinks.js\":\"46ac65c45da4b190\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/block.js\":\"4e44b28cb7df8d5a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/context.js\":\"5d5768b8c2c4f1a7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5c00caa45a8a0660\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/index.js\":\"0df6046b3959ec61\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/outline.js\":\"1c988c9ee71653bf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/properties.js\":\"d62c3f82446fec7c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/refs.js\":\"83ca272a8befec33\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"1fce2b43d55d21db\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/search.js\":\"8682850e55d413ea\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/shared.js\":\"3add1b199b54df40\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f81ee9faf1fe982c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentViews/text.js\":\"edc38ead89bd58a1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/agentWrites.js\":\"8169e7631892f362\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/authoringCatalog.js\":\"c2120d6556e3fe45\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/blockRefTargets.js\":\"258d965ded42022e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/bridge.js\":\"0a39b27c86720a96\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/bridgeLoop.js\":\"00311f6541e9f01d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/changeHistory.js\":\"5d16aa3fdcda86a3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/commands.js\":\"77fa09de3bc893f8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/commentsCommands.js\":\"4f88fe2e4af48768\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/dataExtension.js\":\"f29596beefb08155\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/dataModelGuide.js\":\"0348431a6fcb0850\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/dayPropertyInputs.js\":\"027855f27d7b3759\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/describeRuntime.js\":\"218b56b599e98a01\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/extensionLint.js\":\"9f31a9ca6bf64df1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/grainAudit.js\":\"b4d7c778c739f342\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/healthCommand.js\":\"7e971143440e6290\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/index.js\":\"d7619a8de50256f0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/presetIdentity.js\":\"8b86b975264e5190\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e929553be17a6530\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/readMedia.js\":\"0e5a095b4e7f468a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/schema.js\":\"f3b801f63e0a1140\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/serialization.js\":\"466179bf7f002c7a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/targets.js\":\"7400c06d1ff1d8d6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/tokens.js\":\"509f31351e9441f6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/watchEvents.js\":\"dfb27fc6e57b08a0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/workspaceGuard.js\":\"bc0b5b9fe5f8fcbb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/agent-runtime/writeCommands.js\":\"5de4a32ac891e847\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/AliasCollisionToast.js\":\"9ab24be11d963e2d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/DuplicateNameBanner.js\":\"6da0e0030bc820e5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/collisionMerge.js\":\"3db7ae2b41d226e8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/dataExtension.js\":\"ba1abbdcd8d9cdd0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/index.js\":\"3a2f389a3589ba5a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/mergeCollisionAction.js\":\"4d62ad79ccb62c90\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/pageStyling.js\":\"525ac127e1866425\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/rejectionToast.js\":\"bf378330e49a794c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/alias/syncProcessor.js\":\"958bcef490aeb546\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/actions.js\":\"b2d2750e81e9edfd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/addComment.js\":\"916d32ed9abf3dd6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/anchor.js\":\"19ae43055ce3ef26\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/anchorState.js\":\"ebdd5b8f81b5288b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/commentLinks.js\":\"976908edc4f4698b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/confirmThreadDeletion.js\":\"4ea31146347f6eca\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/container.js\":\"60c936c5f1bba86c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/dataExtension.js\":\"daff85809412e4f7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/deleteComment.js\":\"ba07b16e2e31583f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/highlights.js\":\"3f11100c1584005e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/index.js\":\"fbbb198d52165963\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/linkedCommentsPill.js\":\"cea77d144fec09a0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/margin.js\":\"e9f1008b9126a9d2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/marginAnchorLinks.js\":\"9dfa0b71cbba7377\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/marginSchema.js\":\"3bb5d092ca976c09\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/newComment.js\":\"690773eca8b25b89\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/ownThreadPicker.js\":\"e6d98abb9d82974e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/placement.js\":\"3cbe277ee83a5c48\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/queries.js\":\"a30f02f8865e73fc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/quotePosition.js\":\"84936309b2b7f59f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/quotedIn.js\":\"f0657b6508745de2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/quotedRange.js\":\"1d599183c49d6cfc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/rangeRefs.js\":\"142c881e7edfb958\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/readHighlights.js\":\"82c7c4f698874828\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/readSelection.js\":\"2505627b2756b32b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/readSelectionUi.js\":\"d0b29fa596541b4a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/reanchor.js\":\"5398c1882d03686c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/schema.js\":\"53ed7c9677f1043b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/scope.js\":\"90d9f1abc1475a5a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/scopeThreads.js\":\"7d2e57bb43383b97\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/splitRetarget.js\":\"548f158b1a7d5a15\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/suggestionCard.js\":\"ed959e55175d8daa\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/suggestions.js\":\"d7a24c96fbda998d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/summaries.js\":\"34e3c5bb7841550c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/summaryBatch.js\":\"03de784bdbc02899\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/surface.js\":\"8ae4b274d6dbdd75\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/threadNavigation.js\":\"b7795ae7207e2dc3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/threads.js\":\"0b7e1bc0d81d29bd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/ui.js\":\"8c28c831401f1e30\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/annotations/uiStore.js\":\"f910fac7ff3a5faf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/app-intents/appIntents.js\":\"71f497b88c5c97c9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/app-intents/index.js\":\"b999d2ed1960b799\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/app-update-prompt/index.js\":\"cbc6d38b4365ff46\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/app-update-prompt/status.js\":\"01c43d3b058ed09e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"aabb036f436de633\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/MediaBlockRenderer.js\":\"bd18ba5b6eaff9e9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ed32c0783d4ff2a4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/MediaUploadReconciler.js\":\"0418763423d7101a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/assetDownLane.js\":\"f4737814e505ad85\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/assetResolver.js\":\"1dbf99a6b12cc551\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/assetUpload.js\":\"f6c8b4c5a6b84ce2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/attachmentCleanerIO.js\":\"d3c935dccfca23fc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2c7026d0bcd6cf42\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/blobStore.js\":\"8772359898fbf097\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/browserMedia.js\":\"b1610788a624b672\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/byteStore.js\":\"08cef93421ac260b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/cleanerIO.js\":\"0210e6b44d409ebf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/cleanupAttachments.js\":\"044a9bdcb416e093\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/dataExtension.js\":\"58bcb42c9e6bcc7d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/downLane.js\":\"56f77aa47e585915\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/index.js\":\"835c972a6c2310b2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/insertImageContribution.js\":\"2c6b251ecc9e3398\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/laneArming.js\":\"5fa360a7c4a31359\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/laneLock.js\":\"d8e135a7498227a8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/mediaBlock.js\":\"e725c3ad9fbb5aa6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/mediaCapture.js\":\"3ceaa665fba74d5c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/mediaLanes.js\":\"121ae97e5aaad616\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/mediaViewers.js\":\"3435de1f4d8707fd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/mediaViewersFacet.js\":\"2e0870483f27dc35\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/pasteCapture.js\":\"bf22798771398c16\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/resolver.js\":\"d87733523d153b80\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/retryUploadsAction.js\":\"93b1f80f48d98b1d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/storagePaths.js\":\"12412bf8d54bb813\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/uploadDrain.js\":\"85b2b7c706e5be65\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/uploadLaneStatus.js\":\"a34ca2d756e12302\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/uploadReconcile.js\":\"48f317d1dfb8851a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/uploadRecovery.js\":\"aca9d8bb74af4313\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/uploadStore.js\":\"b9e948e3d701819e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/attachments/useAssetObjectUrl.js\":\"05d83aed35136a9e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"10cfd0df8ed42cb7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e98ed234973c5b32\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks-view/facet.js\":\"5d63902dfd2a6747\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks-view/index.js\":\"3e6e7fa159bd9cf3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks-view/prop.js\":\"e05961425b9de48b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/BacklinkFilters.js\":\"605abb4b7abd62be\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"847354d9f0e534bd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/BlockEntry.js\":\"eac879d3e7a0fa53\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/LinkedReferences.js\":\"9d5b26ea180ff51e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8ea50b9902d9f786\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/dailyNoteDefaults.js\":\"a6af9eddf6c61c48\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/dataExtension.js\":\"739f926a59109ec3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/edgeExclusions.js\":\"a029b98515a8acbf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/filterProperty.js\":\"a8637dcab555f73b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/index.js\":\"b6edacd92249a8d7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"d0bfa0a9b54f08ce\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/inline-counts/applies.js\":\"a76dcaa8b90b8c0c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/inline-counts/countQuery.js\":\"801e5ee890d134f0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f2d06c22246a56b0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/inline-counts/index.js\":\"2e0304c286b658dc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"4c86a7febbc6292b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/presentationInvalidation.js\":\"cbd037e278990d6b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/propertyEditorOverride.js\":\"a454dd0108af4c7a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/propertyFilter.js\":\"2107f52bac216e64\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/query.js\":\"a50776fe5c606858\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/resolveFilter.js\":\"38907842f8c15094\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/sourceBatch.js\":\"245431cbb584ba7a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/sources.js\":\"e2600a867ed8d172\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/useBacklinks.js\":\"174c813737eedbe3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"a6b1aee2b8ff447f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/birthday/BirthdayCelebration.js\":\"2bf38af1f5dad734\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/birthday/BirthdayOverlay.js\":\"ab989ad5856b353a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/birthday/gate.js\":\"73dd62b0622d63ee\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/birthday/index.js\":\"9300f9dc456dbce9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/birthday/wolfTheme.js\":\"68929a177e445c15\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-drag/BlockDragLayer.js\":\"ad2976d231ca0fc3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-drag/dragController.js\":\"fa9c73aa9e7704e5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-drag/dropTarget.js\":\"87883f703fcb8136\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-drag/index.js\":\"018c94aff2ef805c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-drag/projection.js\":\"fe861615ff319625\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-info/BlockMetaCard.js\":\"37569f721677c848\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-info/index.js\":\"a5fdaa04d850038a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/AddTagDialog.js\":\"78ee7c6d8d5956b9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"93b081326f1c7df3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/TagNameIssueHint.js\":\"d85b8adc3d451cc4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/addTagAction.js\":\"f5a07ae67b07b57f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/appendTag.js\":\"407691065a7280be\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/config.js\":\"9e760326a62a2bf5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/dataExtension.js\":\"f40fccf90c62b1ea\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/index.js\":\"2d0ab95db7edc4e2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/block-tagging/propertyEditorOverride.js\":\"c65a9789eb8eeeb2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/BreadcrumbList.js\":\"bc09c8e0fa70bcbe\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d2c8260457cc862f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4bb6070148a821de\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"09c6ef483571f881\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"6bb8afab2be07c5a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/index.js\":\"b1fa4570e2947255\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9007e9e4990a827b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/CharacterCountItem.js\":\"e61f474f72062bfe\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/ProfilePropertyEditor.js\":\"aa0487b67466067f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/actions.js\":\"f8133b7eba484d1d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/blockType.js\":\"65e305045f48d094\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/charCount.js\":\"23bb0ca13d5fa6e9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/dataExtension.js\":\"584d03c3830ca768\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/index.js\":\"06b97e60cc6ff233\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/profiles.js\":\"798fe92b8c76b988\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/properties.js\":\"7e3f1c870cd417c2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/subtree.js\":\"fe278391337b102f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/character-counter/textCounts.js\":\"db21b755f09db663\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/colemak-keybindings/index.js\":\"7fb02c565ff0c7a0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/CommandPalette.js\":\"7d2b672864f02c87\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/HeaderItem.js\":\"ae3c04308ab4c41e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/context.js\":\"670404484dc965f5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/index.js\":\"b3984d2f74cdc7f3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/selection.js\":\"7c143fbed4f00415\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/toggleStore.js\":\"f74ab62b1f53b90e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/command-palette/useCommandPaletteActions.js\":\"e418d5f815ac34ba\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/ContributorBadges.js\":\"70b1a05a2fcb5e82\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/author.js\":\"1929bd8eb08e2a19\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/codeMirrorExtensions.js\":\"7dead167b2de5c18\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/dataExtension.js\":\"c24623d72bff12be\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/index.js\":\"440c313e30b372e4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/mentionAutocomplete.js\":\"94c2c38f2985f3a4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/processor.js\":\"e7a477fba9197b2e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/profiles.js\":\"bf6a45d9f2573e35\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/queries.js\":\"40baf1266e7fb48f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/contributors/schema.js\":\"4c5d629e8524f725\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ffc2cdb54e74506c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4e2ace68a6373987\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/cursor-follows-scroll/index.js\":\"91477c73abecc646\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"36bc36395ddc7336\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"8be5b72bceaa0bd3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/CalendarGrid.js\":\"caa33e91c401e4d0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/DailyNotePicker.js\":\"fd02ea9ce124bcf8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"15f3d64ac5782e29\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/DateNavDecorator.js\":\"4799ce0e5afdcbfb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/DateScrubOverlay.js\":\"0e066b7d2bd71d0a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/DayPropertyEditor.js\":\"60196777b99138fe\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/HeaderItem.js\":\"8868e37737fe8e72\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/ReschedulePicker.js\":\"d8d286178d81d035\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/SpreadDatesDialog.js\":\"dc741ce7b0e9108b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/actions.js\":\"963324a73a176fb2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/blockDateAdapter.js\":\"9350d4fdf880fd60\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/calendar.js\":\"74de839ed5d873ea\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dailyNotes.js\":\"ee99702541bf32b1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dataExtension.js\":\"c79b077cc588fb73\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dateScrubActions.js\":\"229147a97dd13de5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dateScrubGesture.js\":\"d2fa457e3d6df866\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dateScrubGestureActions.js\":\"07946e835cd51fe5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d7af108ccb212b31\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dayProperty.js\":\"fd5c38470e756453\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/deletionGuard.js\":\"35a9af44171b1a26\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/dueQuery.js\":\"6a17565c04c39cf4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/index.js\":\"6d9cc459a4df7883\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/landing.js\":\"121ac4a6039f3dd6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/localSchema.js\":\"095f82cd401ced2f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/referenceDateAdapter.js\":\"c9e593086dafd669\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/rescheduleAction.js\":\"d61c3e99de1c1700\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/schema.js\":\"93c7dfe1a5d9555d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/spreadBlockDates.js\":\"00b3037d74fa8c8b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/spreadDatesAction.js\":\"815134c19f5c9cfd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/today.js\":\"1a73e2dfc050a6d7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"42ad31c29f35997c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"805ed9d36dbad83c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/audit.js\":\"15e2d08d08bf6dee\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/auditAction.js\":\"c893660acc2a87a6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/auditRanges.js\":\"e05bdde62e5600e2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/diagnosticsSource.js\":\"18998793c584cab0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/divergenceScan.js\":\"f14f5d57cd1d54f5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/index.js\":\"432e7d245416d5f4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/propertyChildrenChecks.js\":\"1c7840aab53a878a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/referencesMirror.js\":\"ef50aa75e7c9d4be\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/rowJson.js\":\"1fc30453850587a0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/schedule.js\":\"d5120e733dd667b0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/data-integrity/store.js\":\"df7a7040e44e6c38\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-maintenance/action.js\":\"24a04868d95d0710\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-maintenance/index.js\":\"56b96f0c051a2cfa\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-maintenance/plugin.js\":\"1c8e00aeec6225c1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d86eaabd625cfaac\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/actions.js\":\"c99355a0b5a2e076\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/changeMarker.js\":\"a5610cbf7dc4c510\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/diagnostics.js\":\"74fbbd1e9dfb98cc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/fileSystemAccess.js\":\"e620db8ba3c8c4c1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/filenames.js\":\"ce561681c48d6db9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/index.js\":\"5c16895de616ab98\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/mirror.js\":\"9d5603736ee6ca04\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/runLock.js\":\"921b839e300b062b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/runtimeHealth.js\":\"4e47652f87877aca\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/schedule.js\":\"145bf5f96e79aa39\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/db-mirror/store.js\":\"0a186c237faaef59\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/default-themes/index.js\":\"b992d82f33a7f124\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/default-themes/themes.js\":\"e8bbb5779c8762b0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/diagnostics/facet.js\":\"59bef49cbb1ee224\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/diagnostics/useDiagnostics.js\":\"855f883b8a7f28a6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extension-prompts/dismissals.js\":\"62d0248d91964fc2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extension-prompts/index.js\":\"5e3a008806a836a5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extension-prompts/status.js\":\"57228dd3385ae80e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extension-prompts/store.js\":\"33192bd1d55777da\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"db43700a1e408fb4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ec8b8d1cd7548c73\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/actions.js\":\"a1bdcd0b9fe84571\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/config.js\":\"36d23de515592ba7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/dataExtension.js\":\"0d7c84b0e98c5f37\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/effect.js\":\"9f8adf4a7629a414\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/index.js\":\"246f4dd268375333\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/propertyEditorOverride.js\":\"d033667abd8cc08d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extensions-settings/useToggleTree.js\":\"b12b76f6201ff740\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extract-type/ExtractTypeDialog.js\":\"14270403f74f5553\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b0245feaa0b39ad5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extract-type/PropertyShapePicker.js\":\"fd36aa0e9057fb99\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extract-type/action.js\":\"d737e863e836d57f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/extract-type/index.js\":\"04a7255dba37fa6e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/FindReplaceDialog.js\":\"08bf4319b547ea5d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/HeaderItem.js\":\"4f09a45aa7cdcb53\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/dataExtension.js\":\"5e08926b6233d1d3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/index.js\":\"268ce0b6806f53d4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/search.js\":\"70d1c55a5c5f13e9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/toggleStore.js\":\"a7b51121c95832e5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/LocationPropertyEditor.js\":\"13443f2bc58cc273\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/MapView.js\":\"55fca58c80729fae\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/blockTypes.js\":\"7c85dfe39645ca6d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/codeMirrorExtensions.js\":\"2185317bb60185d4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/createOrFindPlace.js\":\"9d3032c37607733b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/currentLocation.js\":\"e5dc4394cbb3f57b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/dataExtension.js\":\"cf00084ad2b9893f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/geoContentDecorator.js\":\"374bc5073256a5ed\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/googlePlacesClient.js\":\"ac25b9c0774656bf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/index.js\":\"dffeea70d02315ce\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/locationsPage.js\":\"c56e7c858cda3048\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/mapViewport.js\":\"60654487e902827b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/pickCurrentLocation.js\":\"79e51cd8cd0a0cc1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/placeAutocomplete.js\":\"56c97d03468b3fbd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/placeNameCollision.js\":\"048466e334dd0e67\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/properties.js\":\"33193b418a421cbe\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/propertyEditorOverrides.js\":\"fc88ba5dd90ee5a2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/query.js\":\"da6a5a04a992cbd8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/geo/usePlaceSearch.js\":\"ee24c2ef21161b13\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"3057b836dd0d78b8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"01072232f102d3a6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"763123f5e571b4ae\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/config.js\":\"1acd8da40e9d6d72\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/dataExtension.js\":\"ffabe4003fdbdb73\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/facet.js\":\"a396e5e6bf02f97c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/grouping.js\":\"eedcbec767d64467\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/index.js\":\"2aa34c3da2404c78\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"bc05e8a2b804c550\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/query.js\":\"73cebea49c18ef59\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/resolveConfig.js\":\"e5e262c1b94fe556\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c5ffb65a3aa42b57\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b113b8f5b1476d07\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/HtmlDocumentContent.js\":\"81fadecb8f6127bf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/HtmlFrame.js\":\"3bf5da41bcd4f7da\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/actions.js\":\"a622529ae3e6e399\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/blockType.js\":\"05c31cc86963f3b3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/confirmRunScripts.js\":\"9ceb5f25faed5197\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/dataExtension.js\":\"469b2736e9322055\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/frameAnnotations.js\":\"e726398faf43736d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/frameDocument.js\":\"c2d12a4bec33d8df\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/frameTheme.js\":\"062b1ff33009ff7b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/index.js\":\"9167927caf47c033\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/scriptConsent.js\":\"50c6f3618f01e419\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/sourceMap.js\":\"35cf24a224002dcc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/html-document/useDocumentScripts.js\":\"c0ec85d14eaf7ba1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/interaction-metrics/index.js\":\"83207516b8c4246c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/interaction-metrics/record.js\":\"129afb9457b5d039\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/interaction-metrics/recordStore.js\":\"0154af7b7790cf37\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/interaction-metrics/responsiveness.js\":\"db40719e7e6c214c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/interaction-metrics/schedule.js\":\"c8aaf9fc21681b22\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/interaction-metrics/sessionContext.js\":\"34ebe57a0d253ca8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b41fef8b29cfad7d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e00f5fa55ab3d0a5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/actions.js\":\"b3e7670573ee0e78\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/config.js\":\"c51666da501f4c90\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/dataExtension.js\":\"368c6363194416c3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/effect.js\":\"d7362aad129b4298\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/index.js\":\"e2bf6f8d8e8a2161\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/keyCapture.js\":\"51c050a7e3569b24\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/overrideStore.js\":\"cc921393a5d0b478\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d89ff4611a1b6a21\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/HeaderItem.js\":\"943da6bc7d9b6f5a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/LeftSidebar.js\":\"b29745e0ed0070dc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/actions.js\":\"ba4050929e0a448c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/facet.js\":\"431dd4380d0400fd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/index.js\":\"a179d344d3bdccfb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/shortcuts.js\":\"e63e03d1495ae318\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/left-sidebar/toggleStore.js\":\"29f08dafac3edfc6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/merge-blocks/MergePicker.js\":\"87850cf7651d88f8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/merge-blocks/index.js\":\"d4e0e020c5b28d64\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/merge-blocks/mergeAction.js\":\"95c2d10f01c3471a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/merge-blocks/strategy.js\":\"c0a85659eb224e90\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-bottom-nav/Button.js\":\"2d3328d743f28e69\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b9c44e9259482d72\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-bottom-nav/defaultItems.js\":\"953a5df399150870\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-bottom-nav/facet.js\":\"7f5afa59bbfcb283\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-bottom-nav/index.js\":\"12f4d3673041562f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"9e0f9e6a0fe580d5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d3c577d4b2e8875c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"e1a1ad9e706fa458\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-keyboard-toolbar/facet.js\":\"53106a6495b9911f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/mobile-keyboard-toolbar/index.js\":\"637fac0e2c2b6e88\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/MoveDestinationPicker.js\":\"8b1334ecfcb563ef\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/blockSubtreeMembership.js\":\"14f50def009ed187\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/contextMenuItem.js\":\"604f7696fe0353bc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/index.js\":\"dc2d85b04609721e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/moveAction.js\":\"4678077d7548a8e8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/moveBlocks.js\":\"d1b1c336254a51f0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/move-blocks/selectionAfterMove.js\":\"1202ef4b2e48e391\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/TutorialBanner.js\":\"0eabd5f66a294328\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/action.js\":\"5bdbbf6ef438e0d2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/bannerDismissal.js\":\"2595b842ef117d64\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/documents/cheatSheet.js\":\"8135752ccdbd56aa\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/index.js\":\"75632f4a4595e530\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/keys.js\":\"c1e983a5b47a578a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/landing.js\":\"d241040a3a82c613\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/outline.js\":\"7564824befeedd39\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/onboarding/seed.js\":\"c1429373eb4e2b30\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/PerfTrendDialog.js\":\"01268204f28488b2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/analyze.js\":\"416bd6b77875ebce\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/diagnosticsSource.js\":\"a9b9720c7f59c059\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/index.js\":\"f7f3d2239538b633\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/load.js\":\"2a3ad5537868e6d7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/monitorRun.js\":\"dc12667f5a95055f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/schedule.js\":\"43039e9991f4dedb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/series.js\":\"2d370638571e7463\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/store.js\":\"8d33f23793761b1c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/trendAction.js\":\"bd704fba31b5f3cc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/perf-monitor/verdict.js\":\"b3b9297960eac6e3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/plain-outliner/clickToEditAction.js\":\"5d1ef48b9557a24a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/plain-outliner/index.js\":\"5b7948c0553d3fa4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/plain-outliner/interactions.js\":\"19fe99199878eeb3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1a820876594ee4d6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/MigrationGate.js\":\"20383c0d85319299\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/MigrationGateDialog.js\":\"f156179774a2d8e4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/action.js\":\"5e78285dd69387ab\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/index.js\":\"188ddf5a337737b9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/localRunMessage.js\":\"fba976a738d87bba\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/plugin.js\":\"4483a3babb526772\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/progressReport.js\":\"ddb3569edfc388a1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/properties-migration/sweepProgress.js\":\"214c0f53537221f5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/FieldRowRenderer.js\":\"9417a4192ac1933f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/ValueRowRenderer.js\":\"bbc29496200bdea6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/actions.js\":\"ab75c971a8238896\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/autocomplete.js\":\"5c69fc9adcfad9c3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/fieldRow.js\":\"cb823d7f2c2b0dea\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/index.js\":\"b956b2768b4ccf5b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/referenceWarning.js\":\"cb766cf182002b66\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/valueAutocomplete.js\":\"d33f2b71e33b4f7e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/property-rows/valueSchema.js\":\"4ebb45c9b97c0377\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/HeaderItem.js\":\"2a10e7aafbc40dad\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/QuickFind.js\":\"a1eeb8d5424b69ab\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/index.js\":\"8fadc529a0a3ef79\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/recents.js\":\"d9519bc4525f4b22\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/resultItems.js\":\"d0c2b29a901b9bf6\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/selection.js\":\"431ab3886da0d936\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/quick-find/toggleStore.js\":\"114741281633f5ad\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/recents/HeaderItem.js\":\"a28224064bf4209c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/recents/RecentsPageBlockRenderer.js\":\"7b9819d5b439189e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/recents/grouping.js\":\"f213a478e56c6cad\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/recents/index.js\":\"f91e1374d92b1b22\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/recents/target.js\":\"1ae982f99657b9a4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/codeMirrorExtensions.js\":\"bb2ec387a3fe447c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/contentPrefill.js\":\"c93d436065047e1b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/dataExtension.js\":\"f70930c5a42a3bd4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/index.js\":\"8d1d32e824e9e518\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"21dc153779b6611a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/invalidation.js\":\"3fea8fae2a511dfe\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/localSchema.js\":\"527d989d2da8fb19\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/blockrefs/index.js\":\"654cf6df13b9b53f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b80d26fb2c30b8c1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/index.js\":\"2cbfc3e263b64f88\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/referenceNode.js\":\"5f867d756ca8e4f1\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cb9db97936bb6486\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ece9f89f9d2eb097\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/wikilinks/index.js\":\"6cf50f842f151856\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8bc3c76780ebed63\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2363ea0cf0368876\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/mergeRetargetProcessor.js\":\"f0cabc6be82f1513\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/parseFence.js\":\"f729feb1a9dc1266\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/referenceParser.js\":\"1aae67bb58405b6b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/referenceProjection.js\":\"ce1e43907e7076ee\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/referencesProcessor.js\":\"621f1fe92a4b8d3f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/renameProcessor.js\":\"c94551a956e3f9cc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/references/spanReplacement.js\":\"f235ed2f03ffe4ae\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/rich-paste/htmlToOutline.js\":\"9f0fcb214139b705\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/rich-paste/index.js\":\"69a1f015a4547e76\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f21a0b1f22eee5e2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/rich-paste/pasteDecision.js\":\"e6dcc0e5ea4f30a4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/action.js\":\"e04e9fb38a603e32\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/blockIds.js\":\"1a6551b4a1d99bfc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/content.js\":\"0dd34aed5d031712\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/effect.js\":\"841983faeb4e75e9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/ids.js\":\"1826c74c0af769c3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/import.js\":\"b9df65a48a0aaf0b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/index.js\":\"dc6582cbd4f40b98\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/plan.js\":\"5318d4a1529cbb93\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/plugin.js\":\"f5b8c402fc8d78d9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/promotion.js\":\"4c0b7bed117f5aa8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/properties.js\":\"79a5a2762bea1d1a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/references.js\":\"fc52e54ed39f5c9d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/report.js\":\"d619a35cdceb1193\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/roamMemo.js\":\"5aa57830a3fae540\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/runtime.js\":\"47562dfb7e7232f7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/schemaReconciliation.js\":\"895309dfdfb3eeff\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/srsMarkers.js\":\"43da645ec7c451fa\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/todo.js\":\"e2685d994f1d8d4f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/typeCandidates.js\":\"3e7fe2e9b24957a8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/roam-import/types.js\":\"201a622e6ff3664e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/search-health/index.js\":\"95346a8f64593000\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/search-health/store.js\":\"d54efcdd9334e541\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/shortcut-help/HeaderItem.js\":\"3b8897e88b40f2d5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"00b7f734a294cddf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/shortcut-help/index.js\":\"c3984d9e7f62bd2d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/shortcut-help/model.js\":\"4a0644b0a80e954d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/shortcut-help/toggleStore.js\":\"2ec43527d31379b2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/shortcut-help/useKeyInspector.js\":\"6c7a8156d9e802d9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d585ca231335828b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/ShellDecorator.js\":\"173649ad1a2930ec\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/actions.js\":\"cc206abe18ffcad7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d8d1454c7b8fc911\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/index.js\":\"7f9f5e86ab6d9acf\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/shell.js\":\"f36ea3bf4575e649\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/surface.js\":\"8fee6ac3f8ebce52\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/spatial-navigation/walker.js\":\"86d9899581784432\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/RescheduleToast.js\":\"868fbb42ee7b56ca\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/dataExtension.js\":\"feb6d8869c728f5d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/index.js\":\"8cc825ae84459cc0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/indicator.js\":\"ef619cae5d3eaa97\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/moveSrsState.js\":\"6445a1741faeb496\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9c993308a1835d48\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/scheduler.js\":\"cb00c846c31a0828\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/schema.js\":\"f31510043da2b1f9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e7e84d23f6980d42\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/srsClipboard.js\":\"2c47eda16543368f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"d6ab74165ea0e49a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f224021f5e98769f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/DeckPicker.js\":\"fc9c00154b227e9d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/ReviewControls.js\":\"44156d6afa87b069\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8249d5a1467f7aad\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/ReviewSession.js\":\"494e45d6abdeb622\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/actions.js\":\"42085a9c4d3fa0ee\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/archive.js\":\"1f91f449c1eeee69\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/dataExtension.js\":\"0f25a74f312357ac\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/deck.js\":\"6ce85134a8888788\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/dueQuery.js\":\"558bc7b9f931c3db\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/gradeDecision.js\":\"f326d5ec460e1688\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/index.js\":\"c3a8573145720e23\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/keyHints.js\":\"2d62016d0315bf40\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/reviewCardLayout.js\":\"0f56afb123f3ee91\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/reviewProgress.js\":\"35d4bfba90f44852\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/schema.js\":\"0ef33e70c77375c7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/srs-review/useDueCards.js\":\"210c02fa56032a2a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/startup-metrics/index.js\":\"f85b68d2bbabe65e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/startup-metrics/record.js\":\"375e11f6e4b0e971\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/storage-persistence/index.js\":\"6b0bd6a33b49ed72\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/storage-persistence/persistenceStatus.js\":\"1221f9221ec365da\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/storage-persistence/requestAction.js\":\"8540113b4656a90e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/supertags/TypeChipsDecorator.js\":\"16813a22e22722d7\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/supertags/codeMirrorExtensions.js\":\"216eba6cf2a47120\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/supertags/index.js\":\"33984205cba28891\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/supertags/typeAutocomplete.js\":\"2ae9f87c56ec51b4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"74216f8ce3d92ddb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/actions.js\":\"b64a09173e9b0311\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/anchor.js\":\"57c6784e4a5eed6c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/events.js\":\"a7c060f9f99a4647\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/gestureActions.js\":\"2a6b90aefdb4f0ec\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/index.js\":\"91a3a3708999c5e4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"33186907eaa1fffe\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/sync-metrics/collect.js\":\"0fe4bb73f9639565\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/sync-metrics/index.js\":\"d4e1798b81415fee\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/sync-metrics/record.js\":\"adf6afaf961aa2fb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/RejectionDialog.js\":\"6e041681124949fd\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/SystemStatusHeaderItem.js\":\"4cea1f6e300148c5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/index.js\":\"d2bc2ef85c11830c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/model.js\":\"c9fdd8f9b1cf2c3c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/queueCounts.js\":\"d9cdeb2692699e02\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/rejectedHelpers.js\":\"566d47a7adca79d3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/rematerializeAction.js\":\"5a28bffd7c72cf66\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/system-status/useHysteresis.js\":\"2d1dcf38279a91f4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/ColumnHeaders.js\":\"15cf1894c09ee8fc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/QueryUi.js\":\"0905bcfe6c7a13ff\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/TableLayout.js\":\"b7d961929e3bb22d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/actions.js\":\"4d4265570104be01\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/cellEdits.js\":\"32b018688e8028e8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/childrenViews.js\":\"8e01fb541bf31b8c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/columns.js\":\"81d58712e21546e5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/controller.js\":\"3481c3e6c1d9729a\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/convert.js\":\"1eab17c178d55e52\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/dataExtension.js\":\"bcce9672f654c7e2\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/index.js\":\"986690381b5fb052\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/keys.js\":\"ffb170945b985570\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/model.js\":\"9980d94988e863d8\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/backfill.js\":\"490fd0c984275b3d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/completion.js\":\"48bcc82afa394a0b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/format.js\":\"c8bb8ef5438f7241\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/parse.js\":\"c1bd56cf9f4d8c20\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/queryValue.js\":\"5d9ca80fa2167589\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/registrations.js\":\"eb0e0cc870c08e96\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/query/source.js\":\"eb62223accb5a675\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/registry.js\":\"61800510294d1a83\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/rowGutter.js\":\"045a26499888ba3c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/rowVerbs.js\":\"fe504cee4c017f2c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/schema.js\":\"482a8dd4b8130c90\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/tables/sort.js\":\"45695642fcc043d4\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/theme-toggle/effect.js\":\"572d602b0e5da41b\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/theme-toggle/index.js\":\"5e9e7256564d2742\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/theme-toggle/theme.js\":\"c35627a3dbce128f\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/todo/actions.js\":\"1c4ccc033fc025e3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/todo/dataExtension.js\":\"b0b60fe56175c301\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/todo/index.js\":\"629dc95e3cf159eb\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/todo/schema.js\":\"95892c9c9ed68ed9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7ef8bf3e7bdee05d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/touch-selection/actions.js\":\"0612c308c6833921\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/touch-selection/defaultItems.js\":\"0417c50b800040c5\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/touch-selection/facet.js\":\"caad195272267a0c\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/touch-selection/holdRecognizer.js\":\"a5f0ca9b943223e9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/touch-selection/index.js\":\"806e0bfc9795ab23\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/update-indicator/UpdateIndicator.js\":\"648fbe4ee375d673\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/update-indicator/index.js\":\"9e19caf73cc58228\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/update-indicator/loadTimes.js\":\"8865745ebf0e7aa9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/VideoNotesRenderer.js\":\"d73558794f427388\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/VideoPlayerRenderer.js\":\"5e196cccac608328\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/VideoTimeStamp.js\":\"7eaf245dc3a3449e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/actions.js\":\"3bb33e366c50bc06\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/index.js\":\"5bec6a7b15bb9cd9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/markdown.js\":\"8df4beb7ec57bcaa\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/notes.js\":\"8bf7b650202e034e\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/registry.js\":\"7f94fb9077cd4cad\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/remark-timestamps.js\":\"ae578e56e108e9c0\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/video-player/view.js\":\"b0e7135ba776e134\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-link-hints/LinkHints.js\":\"754eda166f15b363\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-link-hints/index.js\":\"932842c13ae19bf9\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-link-hints/model.js\":\"3fd856f1156925c3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-link-hints/settings.js\":\"d7ff02d4523ba147\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-normal-mode/actions.js\":\"5be9046d2a765dd3\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-normal-mode/index.js\":\"2d896eb1b45668dc\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/vim-normal-mode/interactions.js\":\"f465df9a8c68e41d\",\"/knowledge-medium/pr-preview/pr-1885/src/plugins/workspace-header/index.js\":\"ad34e7f3ca8092a8\",\"/knowledge-medium/pr-preview/pr-1885/src/registerServiceWorker.js\":\"812b679797e87988\",\"/knowledge-medium/pr-preview/pr-1885/src/requestPersistentStorage.js\":\"02fb47ed385d2af8\",\"/knowledge-medium/pr-preview/pr-1885/src/services/authRequestDeadline.js\":\"2f460b8c4d1514b5\",\"/knowledge-medium/pr-preview/pr-1885/src/services/authStorage.js\":\"31e9ac9094562de5\",\"/knowledge-medium/pr-preview/pr-1885/src/services/powersync.js\":\"9ff265e6bbeeaf45\",\"/knowledge-medium/pr-preview/pr-1885/src/services/supabase.js\":\"f30aadecfdd8fcdb\",\"/knowledge-medium/pr-preview/pr-1885/src/services/uploadErrorClassifier.js\":\"3eba0d838b5f2473\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/ActiveContexts.js\":\"63d49effdae38959\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/HotkeyReconciler.js\":\"746415d9981459e0\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/WipeLocalDataDialog.js\":\"c2d4e3617179e626\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/actionDispatch.js\":\"2ebee97938527781\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/actionRefItems.js\":\"8ec1e0e6b5cb5a38\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/applyKeybindingOverrides.js\":\"0eaf0ceb5f5b3d57\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/blockActions.js\":\"ee4e2a86ddf2714b\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/blockMergeGesture.js\":\"849ad0b2f7e6ee6f\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/canonicalizeChord.js\":\"07ed34491be55c9a\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/defaultContexts.js\":\"bfe9917c9f7e4213\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/defaultShortcuts.js\":\"6c9fd777e462c0d0\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/effectiveActions.js\":\"ea8f1522f2915c9b\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/gestureAction.js\":\"b2b9a4b89d5b1dd3\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/gestureBinding.js\":\"0bc04ca3ef98a424\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/holdRegistry.js\":\"be203c8080b1bc13\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/keybindingConflicts.js\":\"dc9b0017106703d7\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/keybindingOverrides.js\":\"b3f0384e7a548da0\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/pointerAction.js\":\"23e555ec5ce48910\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/resolve.js\":\"93c18ff91fbb46fa\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/runAction.js\":\"22dea8b0c22500e4\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/sequenceMatcher.js\":\"27fd7e11a6b25fb9\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/types.js\":\"67bf065352603732\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/useActionContext.js\":\"7f06284064980b4b\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/useActionDiscovery.js\":\"8d7e855a388d31ca\",\"/knowledge-medium/pr-preview/pr-1885/src/shortcuts/utils.js\":\"32e89669f4e83bcc\",\"/knowledge-medium/pr-preview/pr-1885/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1885/src/sw/bootStore.js\":\"f3c187cf56c6678b\",\"/knowledge-medium/pr-preview/pr-1885/src/sw/previewDatabases.js\":\"4e18572b4f08a9dd\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/byteTransform.js\":\"bbb49f9e7b59e300\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/attachmentCleaner.js\":\"17675b792142be42\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/bundle/attachmentParts.js\":\"36a9e7c99982057a\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/bundle/bundleParts.js\":\"3c4403231d914a17\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/bundle/bundleRecord.js\":\"c8e82c77181b9a52\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/bundle/manifest.js\":\"28baaf7a69a8815d\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/bundle/takeBundle.js\":\"f0dd83d7e6b6a6b9\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/bundle/verifyBundle.js\":\"6128d5ad0f903a35\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/cleaningStage.js\":\"6f0960f1002857c1\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/conversionKey.js\":\"71c6572982f100a3\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/conversionServer.js\":\"ba071ee2be8d83ae\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/flip.js\":\"9459ea2e5316899e\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/flipAttempts.js\":\"53f56391bf4e1257\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/pages.js\":\"f9848fd3fb7babb5\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/preflight.js\":\"8b65c78a6aa9fbed\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/reseal.js\":\"25f6025bde2a826d\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/runConversion.js\":\"f26e3ee9f0eef458\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/runLock.js\":\"d4811fde9bfcc169\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/sealing.js\":\"e007b64e7272eed6\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/sealingStage.js\":\"2d65fa0040bcbf35\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/stage.js\":\"761a6889607377e2\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/conversion/verifyReseal.js\":\"9bd0e8e7d8de06e2\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/aad.js\":\"37ca2bf13cd01aaf\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/aead.js\":\"7727ffa0f0a1b1b8\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/base32.js\":\"a0d14a3e00e9efe7\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/base64url.js\":\"2dc2f4b1c5f0407e\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/binaryEnvelope.js\":\"7fb3e7720fb22375\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/byteAead.js\":\"1f70f50c67be11bc\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/canary.js\":\"b2681d590839d4ca\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/contentHash.js\":\"48e1d2ffa1f034ef\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/contentKey.js\":\"d452f8a0c3167f8f\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/derivedIdNamespace.js\":\"b84a86f39c77fa19\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/envelope.js\":\"c2b058c56bfcd434\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/hex.js\":\"edf4ec662713b0be\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/sha256Hex.js\":\"f90d5b091600c294\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/crypto/workspaceKey.js\":\"eb9982edba317f73\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/conversionState.js\":\"7fcaa12634e84477\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3b49b4e6c3ceeeca\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/flows/pastedKey.js\":\"534675af801863f7\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"adb6fca3d1b2738e\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/flows/upgradeWorkspacePin.js\":\"55e4b343d9abdf54\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/keyStore.js\":\"ad7a6ca44f0308a1\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/mintWorkspaceKey.js\":\"b58e0d228e3fcda6\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/modePin.js\":\"eab4400a2732a63a\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/openWorkspaceKeys.js\":\"0e78c3a6e9d8b5d4\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/resolveWorkspaceEntry.js\":\"f94a2674150f1396\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/resolver.js\":\"0317b883a4da93f5\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/keys/workspaceAccess.js\":\"0ae59249925d2d57\",\"/knowledge-medium/pr-preview/pr-1885/src/sync/transform.js\":\"d89262d707cdbda6\",\"/knowledge-medium/pr-preview/pr-1885/src/themeBootDefaults.js\":\"913c431aa466f4fb\",\"/knowledge-medium/pr-preview/pr-1885/src/types.js\":\"d23db986ee2d3e24\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/ClientLocalSettings.js\":\"117269cd9a8d3cc8\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/abortableSleep.js\":\"1071310d6c7a6411\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/array.js\":\"ee0644e59bdda76b\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/backlinkAutocomplete.js\":\"3f5da315e2bfd99a\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/blockCrumbs.js\":\"7cbeb26854fa7f61\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/blockrefAutocomplete.js\":\"7acef71d21099285\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/cadencedIdleJob.js\":\"37143fd43b3f510a\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/callbackSet.js\":\"fe11479fae3622bf\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/clientId.js\":\"c928492f734b10b7\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/codemirror.js\":\"9687f78abda58509\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/codemirrorCompletion.js\":\"dda43f4d4d4d8202\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/copy.js\":\"1c124a3c1aa0da07\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/dailyPage.js\":\"ce5d2293d9160d11\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/dbForensics.js\":\"436817ff9a65a4d1\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/dbForensicsHooks.js\":\"26870b7d9e666c4c\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/deleteBlockThroughUi.js\":\"dd11dda977448e85\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/dialogs.js\":\"960d3d4c0b229d8d\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/dom.js\":\"4f557b99493fefba\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/downloadBlob.js\":\"aea6b37fd2a9d313\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/drawnWalk.js\":\"958529ae18ccf545\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/exportSqliteDb.js\":\"83804cccce3ea75b\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/fileSystemAccess.js\":\"9d96b5670382120c\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/flipSlide.js\":\"305c59411b554947\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/fnv1a.js\":\"34dad9420dd1f10a\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/formatBytes.js\":\"d41d5c437fedf714\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/fuzzyRank.js\":\"22ac7c9aa13fe856\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/idbKeyedStore.js\":\"26d2fe44ae6d3dfd\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/idleCallbackPolyfill.js\":\"42ef46dbe1bd51a6\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/keyboardAwareScroll.js\":\"9552bd5901faff94\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/keyboardViewport.js\":\"2a894d07f73139f1\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/lastWorkspace.js\":\"23325c4e26e9e95e\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/layoutColumns.js\":\"0f1adf332a580ac4\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/layoutSessionDom.js\":\"12b99bf1c0f644d4\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/layoutSessionId.js\":\"af6ce2122ebb83be\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/linkClickGestures.js\":\"151162da0d450f49\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/linkTargetAutocomplete.js\":\"976afba33744afd3\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/localDbCorruption.js\":\"7f17abf5cb7af5a0\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/localDbRecovery.js\":\"0929eb347d2b9b84\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/markdownParser.js\":\"e1fd0b1cccbce5ad\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/memoize.js\":\"ed880edd357e2ef1\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/nameFieldCommit.js\":\"d560d25155335450\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/nameList.js\":\"2521f1eb0a30f64c\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/navigation.js\":\"3bba406f65ce9dbc\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/omnilinerNamespace.js\":\"d3248e65f94a6dc0\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/opfsPageScan.js\":\"2344c7f6ce318304\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/panelClearance.js\":\"34c4a2c52fc2e70d\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/panelHistory.js\":\"617581deafa51c7b\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/panelLanes.js\":\"e6f6954a4a7889dd\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/panelLayoutProjection.js\":\"fb5b86dd4b6adeaf\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/panelScrollAnchor.js\":\"7eaa695201584bcc\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/panelUrlFlags.js\":\"acc16013b7211552\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/platform.js\":\"014881e329bcce83\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/pluralize.js\":\"c4486e862753b16b\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/propertyCreation.js\":\"d823a6490f1704c4\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/propertyNavigation.js\":\"a8375b10aefd0452\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/propertyValueContext.js\":\"8e9d4b9dfe0f2f2d\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/react.js\":\"fd0673dbba67b447\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/relativeDate.js\":\"c64436f0c27dcc37\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/relativeTime.js\":\"374541a967655951\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/renderScope.js\":\"99fbbdd6159dcc96\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/resolvedThenable.js\":\"0063fe456d259333\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/routing.js\":\"c1cf2dbb9db74ee8\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/safeMode.js\":\"d43b5ad41d797b1e\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/scheduleIdle.js\":\"5b71d7912f26f9f7\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/screenWakeLock.js\":\"5c8278f82dac80c2\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/selection.js\":\"bcb89057254f78ed\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/softKeyboardGrab.js\":\"deb3e8ddb61d5cc1\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/startupTimeline.js\":\"25b2ff6740674829\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/state.js\":\"d26b70cd8d8b7bbe\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/string.js\":\"9471e9adee86d84b\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/surfaceZoom.js\":\"4621ea49a8dbd749\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/time.js\":\"1fd69a621bdeb865\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/toast.js\":\"ad5113c1519cb65c\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/toggleStore.js\":\"8efe31ff60c5ce47\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/untilStopped.js\":\"558867344ca0622a\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/userActivity.js\":\"943c400a6b7b62d3\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/viewTransition.js\":\"b646e916abf1dcaf\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/viewport.js\":\"51b555f094e0fa0c\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/webLock.js\":\"322062eaf1c31097\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/workspaceRecovery.js\":\"a38705a633b1b9fd\",\"/knowledge-medium/pr-preview/pr-1885/src/utils/workspaceSnapshotStore.js\":\"0dc1f99852b70f2c\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-compiler-runtime.js\":\"d460b1ac8045cbf6\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom-client.js\":\"1dda67e803b2d0ff\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom-server-edge.js\":\"fb239b38652f85bb\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom-server.js\":\"89005fd67b639ca4\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom-static-edge.js\":\"a5dade3e1801f9fb\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom-static.js\":\"7383a3fd5a4a8930\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom-test-utils.js\":\"a43ab5d29a37352e\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-dom.js\":\"587dd6ba42d384f3\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react-jsx-runtime.js\":\"e104914e55bce2aa\",\"/knowledge-medium/pr-preview/pr-1885/src/vendor/react.js\":\"68b185c2ff33f80a\",\"/knowledge-medium/pr-preview/pr-1885/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1885/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1885/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
