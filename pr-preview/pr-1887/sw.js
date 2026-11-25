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
		buildId: "22fe928441ca-066f3735",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1887/\":\"5cd291cb1634adcc\",\"/knowledge-medium/pr-preview/pr-1887/index.html\":\"5cd291cb1634adcc\",\"/knowledge-medium/pr-preview/pr-1887/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1887/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1887/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1887/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1887/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1887/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1887/app.css\":\"4158d0feb5da5128\",\"/knowledge-medium/pr-preview/pr-1887/assets/FacadeVFS-B_3QeIuN.js\":\"a88958c05690d6df\",\"/knowledge-medium/pr-preview/pr-1887/assets/OPFSCoopSyncVFS-msZKmNUp.js\":\"a6d5b824443c5b76\",\"/knowledge-medium/pr-preview/pr-1887/assets/OPFSWriteAheadVFS-B6t9bRMU.js\":\"edbc3e2dd9b1d835\",\"/knowledge-medium/pr-preview/pr-1887/assets/wa-sqlite-9oiC5HgP.js\":\"8a58b90842cb6fd1\",\"/knowledge-medium/pr-preview/pr-1887/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1887/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1887/assets/wa-sqlite-async-CK2f_Q6i.js\":\"c32d476fd12037da\",\"/knowledge-medium/pr-preview/pr-1887/assets/worker-v1TUi7jS.js\":\"4f7266bfbd43395f\",\"/knowledge-medium/pr-preview/pr-1887/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1887/chunks/app-SnObPfS_.js\":\"a4d7dbade53f6510\",\"/knowledge-medium/pr-preview/pr-1887/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1887/index.js\":\"c1a1f23cb5253227\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1887/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1887/assets/AccessHandlePoolVFS-CKG5tYdi.js\":\"294a3ac19d74b4a6\",\"/knowledge-medium/pr-preview/pr-1887/assets/IDBBatchAtomicVFS-CW-fKPCU.js\":\"a12898b4374df66f\",\"/knowledge-medium/pr-preview/pr-1887/assets/MemoryVFS-Pqn53b5N.js\":\"ce12ba8417ece70a\",\"/knowledge-medium/pr-preview/pr-1887/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1887/assets/mc-wa-sqlite-D9bsBre6.js\":\"543441a0f637314b\",\"/knowledge-medium/pr-preview/pr-1887/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1887/assets/mc-wa-sqlite-async-mi8dcOa1.js\":\"acf3eeca344c7a5a\",\"/knowledge-medium/pr-preview/pr-1887/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1887/chunks/AccessHandlePoolVFS-Man_ewN1.js\":\"71ef2de2f3391e69\",\"/knowledge-medium/pr-preview/pr-1887/chunks/FacadeVFS-ipz7NlBe.js\":\"c2f4e08ae394766c\",\"/knowledge-medium/pr-preview/pr-1887/chunks/IDBBatchAtomicVFS-VRNj14Xp.js\":\"54efa3944ea9ff3f\",\"/knowledge-medium/pr-preview/pr-1887/chunks/MemoryVFS-FucNIBMa.js\":\"e6061be68e83acac\",\"/knowledge-medium/pr-preview/pr-1887/chunks/OPFSCoopSyncVFS-CwoeUMfa.js\":\"501e450f0caa3f48\",\"/knowledge-medium/pr-preview/pr-1887/chunks/OPFSWriteAheadVFS-CT_0Ynnr.js\":\"3e109bbab2f8754c\",\"/knowledge-medium/pr-preview/pr-1887/chunks/Preview-CrF5GDje.js\":\"970d4d6698facfbf\",\"/knowledge-medium/pr-preview/pr-1887/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1887/chunks/card-u6zeVIRd.js\":\"1245e20afa2446d6\",\"/knowledge-medium/pr-preview/pr-1887/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1887/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1887/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1887/chunks/dist-DbIGXlR6.js\":\"7de53e9521c5121f\",\"/knowledge-medium/pr-preview/pr-1887/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1887/chunks/mc-wa-sqlite-DD2iHAZE.js\":\"aa027bab34c1a7c0\",\"/knowledge-medium/pr-preview/pr-1887/chunks/mc-wa-sqlite-async-CyoRxKKs.js\":\"5cb03c89cf039795\",\"/knowledge-medium/pr-preview/pr-1887/chunks/react-B5nmw7de.js\":\"6973849c3ab74588\",\"/knowledge-medium/pr-preview/pr-1887/chunks/react-BdOdCFkz.js\":\"e766f3842da85100\",\"/knowledge-medium/pr-preview/pr-1887/chunks/react-C7B2Tatw.js\":\"1798d89696559cba\",\"/knowledge-medium/pr-preview/pr-1887/chunks/react-ChWdDea7.js\":\"ed5d96c34eec2ee2\",\"/knowledge-medium/pr-preview/pr-1887/chunks/react-DgCbzlrb.js\":\"5bfd5db0302a42aa\",\"/knowledge-medium/pr-preview/pr-1887/chunks/react-DnrJW9Cf.js\":\"f66c24f737d78090\",\"/knowledge-medium/pr-preview/pr-1887/chunks/react-YmtzkPsr.js\":\"ade1c098ac6abd54\",\"/knowledge-medium/pr-preview/pr-1887/chunks/react-dom-server-legacy.browser.production-DzWsViDh.js\":\"c28491d7f69d271f\",\"/knowledge-medium/pr-preview/pr-1887/chunks/react-dom-server.browser.production-D-kxun-w.js\":\"8220737c7c9f5e3a\",\"/knowledge-medium/pr-preview/pr-1887/chunks/react-dom-server.edge.production-B41TkZg_.js\":\"3ba456ffc97e1849\",\"/knowledge-medium/pr-preview/pr-1887/chunks/react-nIqLqOkV.js\":\"694bc2a042752e55\",\"/knowledge-medium/pr-preview/pr-1887/chunks/server.browser-Dbwunnof.js\":\"7d814393e0729ee8\",\"/knowledge-medium/pr-preview/pr-1887/chunks/textarea-D09iGUGV.js\":\"9781cc4984cf28f4\",\"/knowledge-medium/pr-preview/pr-1887/chunks/ui-CEWJVeaN.js\":\"44c955faaf718a77\",\"/knowledge-medium/pr-preview/pr-1887/chunks/wa-sqlite-DaD7S5oT.js\":\"6892af905fecf456\",\"/knowledge-medium/pr-preview/pr-1887/chunks/wa-sqlite-async-Bjw5xIBs.js\":\"1fcbef6b232b3ad9\",\"/knowledge-medium/pr-preview/pr-1887/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1887/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1887/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1887/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1887/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1887/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1887/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1887/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1887/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1887/src/App.js\":\"c729ba93733ce962\",\"/knowledge-medium/pr-preview/pr-1887/src/appUpdate.js\":\"2b17ffcaef6b5766\",\"/knowledge-medium/pr-preview/pr-1887/src/appVersion.js\":\"bf128c14b0e08b74\",\"/knowledge-medium/pr-preview/pr-1887/src/bootstrap/initialLayout.js\":\"241562b7881e4f81\",\"/knowledge-medium/pr-preview/pr-1887/src/bootstrap/openWorkspaceData.js\":\"96a17b33fe384756\",\"/knowledge-medium/pr-preview/pr-1887/src/bootstrap/resolveWorkspace.js\":\"45d069d991803b9e\",\"/knowledge-medium/pr-preview/pr-1887/src/bootstrap/workspaceBootstrap.js\":\"223b62214e39f43a\",\"/knowledge-medium/pr-preview/pr-1887/src/components/BlockComponent.js\":\"e7fd6a51ec2ecb43\",\"/knowledge-medium/pr-preview/pr-1887/src/components/BlockCrumbs.js\":\"45f71673469a2078\",\"/knowledge-medium/pr-preview/pr-1887/src/components/BlockEditor.js\":\"e0b4713cd2206238\",\"/knowledge-medium/pr-preview/pr-1887/src/components/BlockLoadingPlaceholder.js\":\"2f1441a5e3b5f627\",\"/knowledge-medium/pr-preview/pr-1887/src/components/BlockProperties.js\":\"fcc9852389123e91\",\"/knowledge-medium/pr-preview/pr-1887/src/components/BlockSearchPicker.js\":\"9dffe4ec2759b818\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ConfirmBulkDeleteDialog.js\":\"784c43d3c260cae1\",\"/knowledge-medium/pr-preview/pr-1887/src/components/DividerHandle.js\":\"125df274526e10e4\",\"/knowledge-medium/pr-preview/pr-1887/src/components/DraftEditor.js\":\"757cc79c38bcf2ae\",\"/knowledge-medium/pr-preview/pr-1887/src/components/GutterPill.js\":\"d110985225325290\",\"/knowledge-medium/pr-preview/pr-1887/src/components/Header.js\":\"78f8ddf568ef62f2\",\"/knowledge-medium/pr-preview/pr-1887/src/components/LazyBlockComponent.js\":\"946d59c5e15aa72e\",\"/knowledge-medium/pr-preview/pr-1887/src/components/Login.js\":\"39f02a083b4a85d7\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ZoomableSurface.js\":\"3d87da89a2fcae3f\",\"/knowledge-medium/pr-preview/pr-1887/src/components/editModeKeepalive.js\":\"b7040976836c71eb\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b718717a279b9b48\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"118eb3d1302f8d02\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyEditors/RefPropertyEditor.js\":\"6e6b67219c0f1a38\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyEditors/RefTargetTypePicker.js\":\"ba24cfcd91d67ffc\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyEditors/SelectPropertyEditor.js\":\"9c3e96aca96b0575\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyEditors/TypesPropertyEditor.js\":\"37bda6faad69e8ff\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyEditors/defaults.js\":\"bbc0a5a99eeee821\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyEditors/kernelValuePresets.js\":\"dde06b1f33f221f4\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyEditors/selectablePresets.js\":\"6f521cd47e2368ad\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyEditors/typesPropertyUi.js\":\"4d6e218cda2ef4fc\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyPanel/AddPropertyForm.js\":\"fbb761cb5b25c162\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyPanel/PropertyPicker.js\":\"6aa1d0c544c22429\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyPanel/PropertyRow.js\":\"a6cbf6bb5c232f74\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyPanel/Rows.js\":\"fd1f9e94a59af507\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyPanel/actions.js\":\"dc8774a00bc1aed2\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyPanel/declarationOnly.js\":\"ce27ce6ee0603b22\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyPanel/layout.js\":\"b9e84275ce36e6cc\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyPanel/model.js\":\"82eb63ed7d16963d\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyPanel/shapeUi.js\":\"306c5a178a76efde\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyPanel/shapes.js\":\"63dd4f473d8d1d64\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyPanel/usePropertyEditingActivation.js\":\"11fd83fc5278e13c\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyPanel/visibility.js\":\"0c47823cb08b6b81\",\"/knowledge-medium/pr-preview/pr-1887/src/components/propertyPanelSections.js\":\"dbd376935aecbd7a\",\"/knowledge-medium/pr-preview/pr-1887/src/components/references/BlockEmbed.js\":\"85d04b08a45b585b\",\"/knowledge-medium/pr-preview/pr-1887/src/components/references/BlockLink.js\":\"dd4273c939fcf7fd\",\"/knowledge-medium/pr-preview/pr-1887/src/components/references/BlockRef.js\":\"7f6335692128f06f\",\"/knowledge-medium/pr-preview/pr-1887/src/components/references/ReferenceLink.js\":\"863fe02f97f80160\",\"/knowledge-medium/pr-preview/pr-1887/src/components/references/cycleGuard.js\":\"2bbd15135fbad33b\",\"/knowledge-medium/pr-preview/pr-1887/src/components/references/cycleGuardContext.js\":\"7e55157543f5337b\",\"/knowledge-medium/pr-preview/pr-1887/src/components/references/linkInteraction.js\":\"1586c0e4791b278e\",\"/knowledge-medium/pr-preview/pr-1887/src/components/references/referenceLayout.js\":\"314ef56f2387c82a\",\"/knowledge-medium/pr-preview/pr-1887/src/components/references/useBlockRefAncestors.js\":\"d40bde033380c14c\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/BlockGutter.js\":\"6db57fd13f576650\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/BlockInfoDialog.js\":\"eb3a30f5a5329211\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/BlockTypeBlockRenderer.js\":\"d114e971a5e7ad29\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/BulletHoverCard.js\":\"10cf8c6a3ec29628\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/CodeMirrorContentRenderer.js\":\"12c27027216398d5\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c547415474316e89\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/ColumnResizeHandles.js\":\"3db1ec8e7f04286c\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c9dcb93f70a112ca\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/DefaultBlockRenderer.js\":\"29d9e8857bb763ef\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/LayoutRenderer.js\":\"50474b015f436748\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/MarkdownContentRenderer.js\":\"cfcd4b3388bef757\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/MissingDataRenderer.js\":\"0aaaa0ac632989ae\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/PanelRenderer.js\":\"3b8897f8615bc27d\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/PropertySchemaBlockRenderer.js\":\"60cb9bd787238482\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/TopLevelRenderer.js\":\"39bdcc9e770486b7\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/blockGutterMode.js\":\"fb3668878715afaa\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/blockTitleText.js\":\"b6b45d54a0389a7b\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/fieldCreationKeydown.js\":\"4b8c9736928156fa\",\"/knowledge-medium/pr-preview/pr-1887/src/components/renderer/layoutRootContext.js\":\"58d12f7d49eda84d\",\"/knowledge-medium/pr-preview/pr-1887/src/components/typeChip/TypeChip.js\":\"415454492fc1760c\",\"/knowledge-medium/pr-preview/pr-1887/src/components/typeChip/chipStyle.js\":\"2ae2f98fbf8e950f\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/anchored-floating.js\":\"e1deea4dd6fe9b87\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/button.js\":\"ab27a3446ee9142c\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/card.js\":\"ffdbf0cf949f940b\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/checkbox.js\":\"636178ca39a20037\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/collapsible.js\":\"5c5cf40e2b958a1f\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/command.js\":\"637356c278c882ab\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/context-menu.js\":\"ad704ad8f6ba30b9\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/dialog.js\":\"35cdcb4460fb4394\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/dropdown-menu.js\":\"238f51e680ecb915\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/floating-listbox.js\":\"7cdc41b3456e69ee\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/index.js\":\"be77e9e1b59a2b2f\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/input.js\":\"d46814d769b90051\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/kbd.js\":\"d568e72174974816\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/label.js\":\"93eb4a0b754f3539\",\"/knowledge-medium/pr-preview/pr-1887/src/components/ui/textarea.js\":\"69cb01d9292b0f37\",\"/knowledge-medium/pr-preview/pr-1887/src/components/useEditModeYieldKeepalive.js\":\"ae29b0444488a17f\",\"/knowledge-medium/pr-preview/pr-1887/src/components/util/BootFallback.js\":\"54d7674cd778f2fc\",\"/knowledge-medium/pr-preview/pr-1887/src/components/util/FocusedRowLazyMount.js\":\"f2b0fa9392c88369\",\"/knowledge-medium/pr-preview/pr-1887/src/components/util/LazyViewportMount.js\":\"815b031bc6177d96\",\"/knowledge-medium/pr-preview/pr-1887/src/components/util/LocalDbCorruptionFallback.js\":\"0fd91f34308cc34d\",\"/knowledge-medium/pr-preview/pr-1887/src/components/util/error.js\":\"7a4dbe0bf6c9f004\",\"/knowledge-medium/pr-preview/pr-1887/src/components/util/lazyMountRegistry.js\":\"0845ad29187e7fc5\",\"/knowledge-medium/pr-preview/pr-1887/src/components/util/suspense.js\":\"cf82dbcf96164daa\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/CreateWorkspaceDialog.js\":\"4d1db258ebe663d6\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/PendingInvitations.js\":\"f7c3c96267522fb1\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/SyncProgress.js\":\"381c9f9d3d5b7d35\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/UnlockProgress.js\":\"c453e0bfa1781190\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/WorkspaceKeyGate.js\":\"c638bc4076f4d7c2\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/WorkspaceSettingsDialog.js\":\"4c30c8617b77e7e9\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/WorkspaceSwitcher.js\":\"1ce89be8d5bd2e6a\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/WorkspaceSyncGate.js\":\"8e90b2f28e6a13f3\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/conversion/ConversionFlow.js\":\"b086347f00ac9623\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/conversion/ConversionFlowHost.js\":\"42593f8822b78b66\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/conversion/EncryptionSection.js\":\"9e44466bbaa52724\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/conversion/attachmentPrompts.js\":\"20bd32f58e75804a\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b7046070ca888808\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/conversion/conversionFlowDeps.js\":\"5f49b06f7247c494\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/conversion/conversionFlowStore.js\":\"17ff03f8f859fbe0\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/conversion/flowUi.js\":\"9191277d0a5b7dbd\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/conversion/useConversionRun.js\":\"4473bc1c18066f48\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/keyUi.js\":\"6236dcbff11c24f4\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/useCloseOnKeyLoss.js\":\"d197bb11002c971c\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/useCloseOnServerE2ee.js\":\"6719fcc1809c7e71\",\"/knowledge-medium/pr-preview/pr-1887/src/components/workspace/workspaceUnlocked.js\":\"dff64b2355e91979\",\"/knowledge-medium/pr-preview/pr-1887/src/context/backgroundSubtree.js\":\"18f4a39c6d09d54a\",\"/knowledge-medium/pr-preview/pr-1887/src/context/block.js\":\"25583250f0fdc4c7\",\"/knowledge-medium/pr-preview/pr-1887/src/context/layoutWsContext.js\":\"e54c753f01a06673\",\"/knowledge-medium/pr-preview/pr-1887/src/context/propertyDisplay.js\":\"d24238547778e161\",\"/knowledge-medium/pr-preview/pr-1887/src/context/repo.js\":\"de6b04ad41b55646\",\"/knowledge-medium/pr-preview/pr-1887/src/data/aliasClaim.js\":\"d56ad9aab1fdf576\",\"/knowledge-medium/pr-preview/pr-1887/src/data/aliasSeatNamespace.js\":\"d9ebdaafe094936e\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/blockData.js\":\"64399b623225d611\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/blockType.js\":\"a0111ab966ac7da4\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/changeScope.js\":\"bfd95775c7439426\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/codecs.js\":\"fc8a00cad74a30e3\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/derivedData.js\":\"6d95794f40b3a949\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/errors.js\":\"bc862fe50808f8d9\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/events.js\":\"1dd89b7d4be663a1\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/handle.js\":\"30fce388986066f2\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/index.js\":\"276228d448abb145\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/mutator.js\":\"a2f1820c0605a76d\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/processor.js\":\"fd92d8a3a405f1eb\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/propertySchema.js\":\"6edf7082282ce239\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/query.js\":\"cc641a4aa44999dd\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/sameTxProcessor.js\":\"d01e84f412ebcb44\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/schema.js\":\"30fce388986066f2\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/tx.js\":\"30fce388986066f2\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/typedBlockQuery.js\":\"819daeef2eaac7eb\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/user.js\":\"f4f6227be1813395\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/valuePresetCore.js\":\"740c2353471d04f8\",\"/knowledge-medium/pr-preview/pr-1887/src/data/api/valuePresets.js\":\"492768f645836a97\",\"/knowledge-medium/pr-preview/pr-1887/src/data/attachmentCleanerIOVerb.js\":\"f40adcaa1984f62f\",\"/knowledge-medium/pr-preview/pr-1887/src/data/block.js\":\"a36a447ece1e5964\",\"/knowledge-medium/pr-preview/pr-1887/src/data/blockCache.js\":\"04f2534ad38e42e7\",\"/knowledge-medium/pr-preview/pr-1887/src/data/blockId.js\":\"f17ac658bd7d2003\",\"/knowledge-medium/pr-preview/pr-1887/src/data/blockLiveness.js\":\"3249a9ef0f2a08ed\",\"/knowledge-medium/pr-preview/pr-1887/src/data/blockMerge.js\":\"2d6997ac4f2cadb8\",\"/knowledge-medium/pr-preview/pr-1887/src/data/blockSchema.js\":\"92d8181bc525cafc\",\"/knowledge-medium/pr-preview/pr-1887/src/data/blockTypeLookup.js\":\"dff751f7244baec7\",\"/knowledge-medium/pr-preview/pr-1887/src/data/blockTypes.js\":\"500aa236c7dc9d6c\",\"/knowledge-medium/pr-preview/pr-1887/src/data/childrenView.js\":\"55ca728e2650a6d5\",\"/knowledge-medium/pr-preview/pr-1887/src/data/clientContext.js\":\"4b99a8c504813335\",\"/knowledge-medium/pr-preview/pr-1887/src/data/dbFileSiblings.js\":\"819d9eb186289cf1\",\"/knowledge-medium/pr-preview/pr-1887/src/data/definitionSeeds.js\":\"a111b80ea707b0fd\",\"/knowledge-medium/pr-preview/pr-1887/src/data/derivedIds.js\":\"22d2dc7b536dc39f\",\"/knowledge-medium/pr-preview/pr-1887/src/data/drawnSubtree.js\":\"b5799607d11e68cd\",\"/knowledge-medium/pr-preview/pr-1887/src/data/facetBridge.js\":\"514cac5f59497776\",\"/knowledge-medium/pr-preview/pr-1887/src/data/facets.js\":\"6515363484f208f6\",\"/knowledge-medium/pr-preview/pr-1887/src/data/globalState.js\":\"977f28b4176bc523\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/aliasClaimRederiveProcessor.js\":\"f0d1917dee722d83\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/ancestorBatch.js\":\"4e13a11a03a5a5ea\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/blockTypeTypeifyProcessor.js\":\"9ca1a06a3cb53868\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/clientSchema.js\":\"4f59d13d0dee8131\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/commitPipeline.js\":\"8acf22044bcfcf36\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/devAssertions.js\":\"d0475badba2e58b0\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/firstSync.js\":\"d0e918d27121a4b3\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/freshInitialLoad.js\":\"f96c5112d02371d5\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/graphBackfillClaim.js\":\"dd8d04f766378eb9\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/handleStore.js\":\"4472382255f4f81e\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/idleMarkerJobs.js\":\"252d79e5d1bb3052\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/initialDownload.js\":\"7a616089b3337f72\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/initializeClientDatabase.js\":\"54941dc003f25444\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/jsonCanonical.js\":\"b0bfec0323f09788\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/kernelInvalidation.js\":\"98072c509f59fe38\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/kernelProcessors.js\":\"3f2332fe7b5fba2f\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/kernelQueries.js\":\"3de87ace2eb8fd0e\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/mergeTypeMembershipProcessor.js\":\"4c60fe34f33cf433\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/normalizeReferencesProcessor.js\":\"e72b188e53034f9a\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/poolInstrumentation.js\":\"344e49559bbf9e62\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/processorRunner.js\":\"e14a204d0810e3c5\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/propertyCellBackfill.js\":\"9ee759c300b890ed\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/propertyChildMint.js\":\"55676741f92a0a53\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/propertyChildrenProcessor.js\":\"519d6733d83c9511\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e4de7df85261f0c5\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/propertyDefinitionSynthesis.js\":\"27a1443b946ffdd2\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/propertyKeyScan.js\":\"72edcdef55f8d891\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/propertySchemaResolution.js\":\"e4b41d3bb1cb69f3\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/propertyValueEdits.js\":\"8ff9ec13e31f9dd2\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/raiseProtocol.js\":\"8a8b91751c1c49a4\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/readBatch.js\":\"1c25c7b58f1e2cc5\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/refProjection.js\":\"ff60250cfea8a6ba\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/referenceTargetLookups.js\":\"947b6979117f5316\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/referenceTargetProcessor.js\":\"8588145908106878\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/replayMerge.js\":\"06e47bc019340cdf\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/sqlBinds.js\":\"19745b1b457b2fbe\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"adcb4ff457cd848c\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/syncObserver/arrivalProcessors.js\":\"fc98ff167412642e\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/syncObserver/invalidate.js\":\"0b4f62fdaad59ddf\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/syncObserver/materialize.js\":\"797455f275083242\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/syncObserver/observer.js\":\"3d60386a838cd3e5\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/syncObserver/reconcile.js\":\"1d6310d1e23b6472\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/timingMetrics.js\":\"48ea1a2d79d7c71f\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/treeQueries.js\":\"1a9c8b8464c48019\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/txEngine.js\":\"b999a7b171ae294c\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/txSnapshots.js\":\"fe6b03d793fb6986\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/typedBlockQuery.js\":\"b355a8e72b4ac9f0\",\"/knowledge-medium/pr-preview/pr-1887/src/data/internals/undoManager.js\":\"2a10b757c5c1522c\",\"/knowledge-medium/pr-preview/pr-1887/src/data/invalidation.js\":\"80453a698411eae0\",\"/knowledge-medium/pr-preview/pr-1887/src/data/kernelDataExtension.js\":\"5b8c311dbaf373d7\",\"/knowledge-medium/pr-preview/pr-1887/src/data/kernelPage.js\":\"69c0569d2b53064f\",\"/knowledge-medium/pr-preview/pr-1887/src/data/kernelValuePresetCores.js\":\"54a735574366cc76\",\"/knowledge-medium/pr-preview/pr-1887/src/data/localDbCorruptionSignal.js\":\"9acae4056c59b67c\",\"/knowledge-medium/pr-preview/pr-1887/src/data/localDbStorage.js\":\"4adcd227d5c6dcc0\",\"/knowledge-medium/pr-preview/pr-1887/src/data/localDbVfs.js\":\"a95be93f138978f3\",\"/knowledge-medium/pr-preview/pr-1887/src/data/localSchema.js\":\"2c5e638cee83736e\",\"/knowledge-medium/pr-preview/pr-1887/src/data/maintenance.js\":\"99690a145ff4f7c0\",\"/knowledge-medium/pr-preview/pr-1887/src/data/mergeProperties.js\":\"4b91ff9e469a2005\",\"/knowledge-medium/pr-preview/pr-1887/src/data/metricsConsoleHook.js\":\"1f72184ab9dab41b\",\"/knowledge-medium/pr-preview/pr-1887/src/data/migrationsPage.js\":\"623d372e24d1043c\",\"/knowledge-medium/pr-preview/pr-1887/src/data/mutators.js\":\"4aa05b4fa520ff21\",\"/knowledge-medium/pr-preview/pr-1887/src/data/orderKey.js\":\"ce17fbc1b8d8d315\",\"/knowledge-medium/pr-preview/pr-1887/src/data/orderKeyPlacement.js\":\"0f0afbecdf8f7a98\",\"/knowledge-medium/pr-preview/pr-1887/src/data/outlineSurface.js\":\"e23d0328d3d26f27\",\"/knowledge-medium/pr-preview/pr-1887/src/data/pendingEditorContent.js\":\"2739ad64e3462b7e\",\"/knowledge-medium/pr-preview/pr-1887/src/data/pendingUploadsSql.js\":\"3fa8f02f402d364a\",\"/knowledge-medium/pr-preview/pr-1887/src/data/pluginStateExtensions.js\":\"27e73aad93d323f9\",\"/knowledge-medium/pr-preview/pr-1887/src/data/powerSyncLogger.js\":\"e7401bdbd5ffc92a\",\"/knowledge-medium/pr-preview/pr-1887/src/data/projectorRuntime.js\":\"d852f8c0135cf4c4\",\"/knowledge-medium/pr-preview/pr-1887/src/data/properties.js\":\"7643f608eeea9621\",\"/knowledge-medium/pr-preview/pr-1887/src/data/propertiesPage.js\":\"3e89bde990e9049d\",\"/knowledge-medium/pr-preview/pr-1887/src/data/propertyChildren.js\":\"772bc3245ea839da\",\"/knowledge-medium/pr-preview/pr-1887/src/data/propertyDefinitionFanout.js\":\"349bb5ea2a615bc6\",\"/knowledge-medium/pr-preview/pr-1887/src/data/propertyDefinitionMetadata.js\":\"456e7bb2762af5d4\",\"/knowledge-medium/pr-preview/pr-1887/src/data/propertyDefinitionRegistry.js\":\"bc5895e8331778c3\",\"/knowledge-medium/pr-preview/pr-1887/src/data/propertyDisplayMode.js\":\"d510896496866b16\",\"/knowledge-medium/pr-preview/pr-1887/src/data/propertyRowCreation.js\":\"57670b9a529c881c\",\"/knowledge-medium/pr-preview/pr-1887/src/data/propertySchemaCreation.js\":\"533c6ec8f54ff76f\",\"/knowledge-medium/pr-preview/pr-1887/src/data/propertySeeds.js\":\"bb785922f95ac7b3\",\"/knowledge-medium/pr-preview/pr-1887/src/data/recentsPage.js\":\"8000d448543f0059\",\"/knowledge-medium/pr-preview/pr-1887/src/data/refTargetComparableProperty.js\":\"a1e8aa4ba2d86fe0\",\"/knowledge-medium/pr-preview/pr-1887/src/data/referenceBlock.js\":\"f1eabccf4bca551f\",\"/knowledge-medium/pr-preview/pr-1887/src/data/rejectedUploads.js\":\"2affe451e0027ae3\",\"/knowledge-medium/pr-preview/pr-1887/src/data/releasePowerSyncConnection.js\":\"7eba19fb10f65afd\",\"/knowledge-medium/pr-preview/pr-1887/src/data/repo.js\":\"cf1852e4ae6a2807\",\"/knowledge-medium/pr-preview/pr-1887/src/data/repoProvider.js\":\"fe62f72a61c03252\",\"/knowledge-medium/pr-preview/pr-1887/src/data/rowProperty.js\":\"dc972fcc640bf378\",\"/knowledge-medium/pr-preview/pr-1887/src/data/searchFilter.js\":\"033ada5e99338f04\",\"/knowledge-medium/pr-preview/pr-1887/src/data/seedIdentityLedger.js\":\"1b8a5a93daa9f5b8\",\"/knowledge-medium/pr-preview/pr-1887/src/data/stateBlocks.js\":\"33d8916c24b70c29\",\"/knowledge-medium/pr-preview/pr-1887/src/data/structuralEditPolicy.js\":\"6b6ccb92947b7182\",\"/knowledge-medium/pr-preview/pr-1887/src/data/structuralInsert.js\":\"4f3127f6a1eccf8b\",\"/knowledge-medium/pr-preview/pr-1887/src/data/subtreeDelete.js\":\"e9e32af29de8d79b\",\"/knowledge-medium/pr-preview/pr-1887/src/data/syncStreamLock.js\":\"ab387689b3dac7cc\",\"/knowledge-medium/pr-preview/pr-1887/src/data/syncedTableSqlRecognizer.js\":\"4ccbd7b6f6aa08e1\",\"/knowledge-medium/pr-preview/pr-1887/src/data/syncedTableWriteGuard.js\":\"1631b18b438e4146\",\"/knowledge-medium/pr-preview/pr-1887/src/data/targets.js\":\"4328180335b26591\",\"/knowledge-medium/pr-preview/pr-1887/src/data/typeColors.js\":\"a80217b1ad48e7b5\",\"/knowledge-medium/pr-preview/pr-1887/src/data/typeDefinitionMetadata.js\":\"a3412657d7125923\",\"/knowledge-medium/pr-preview/pr-1887/src/data/typeDefinitionRegistry.js\":\"bbf5862ce1e21aa0\",\"/knowledge-medium/pr-preview/pr-1887/src/data/typeExtraction.js\":\"fafc18109dd1417b\",\"/knowledge-medium/pr-preview/pr-1887/src/data/typeInitialValues.js\":\"e96f7d4ef5740159\",\"/knowledge-medium/pr-preview/pr-1887/src/data/typePropertyGroups.js\":\"f92134831c70979f\",\"/knowledge-medium/pr-preview/pr-1887/src/data/typeSeeds.js\":\"3c58a49a74b58fdf\",\"/knowledge-medium/pr-preview/pr-1887/src/data/typeTagger.js\":\"5579192db44909c7\",\"/knowledge-medium/pr-preview/pr-1887/src/data/typedRecords.js\":\"38d0a8ebe1f17385\",\"/knowledge-medium/pr-preview/pr-1887/src/data/typesPage.js\":\"3f7e9f13912a2362\",\"/knowledge-medium/pr-preview/pr-1887/src/data/userPrefs.js\":\"bc99e83ec548a714\",\"/knowledge-medium/pr-preview/pr-1887/src/data/userSchemasService.js\":\"e05572f4696b5ab0\",\"/knowledge-medium/pr-preview/pr-1887/src/data/userTypesService.js\":\"56276d6ffdb39203\",\"/knowledge-medium/pr-preview/pr-1887/src/data/valuePresetRegistry.js\":\"b258ccc25f7ee5c2\",\"/knowledge-medium/pr-preview/pr-1887/src/data/visibleChildren.js\":\"4920c184d1fc19c7\",\"/knowledge-medium/pr-preview/pr-1887/src/data/workspaceConversion.js\":\"ada042bba867a81b\",\"/knowledge-medium/pr-preview/pr-1887/src/data/workspaceFirstSync.js\":\"343b8ac13e05f070\",\"/knowledge-medium/pr-preview/pr-1887/src/data/workspaceIdNamespace.js\":\"198550ad26aab2d8\",\"/knowledge-medium/pr-preview/pr-1887/src/data/workspaceSchema.js\":\"bcc08084b342f330\",\"/knowledge-medium/pr-preview/pr-1887/src/data/workspaces.js\":\"1d5475069c7e82d4\",\"/knowledge-medium/pr-preview/pr-1887/src/data/writeAheadLog.js\":\"98c55a43d6970aca\",\"/knowledge-medium/pr-preview/pr-1887/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1887/src/editor/BlockPasteShellDecorator.js\":\"40b05f18dde7bf9f\",\"/knowledge-medium/pr-preview/pr-1887/src/editor/atTrigger.js\":\"2c4b2fd8f26e178d\",\"/knowledge-medium/pr-preview/pr-1887/src/editor/autocomplete.js\":\"7b9754b706628c72\",\"/knowledge-medium/pr-preview/pr-1887/src/editor/codeMirrorExtensions.js\":\"f8ba42c78c41524b\",\"/knowledge-medium/pr-preview/pr-1887/src/editor/contentFlush.js\":\"b61e6f0c2fb02c38\",\"/knowledge-medium/pr-preview/pr-1887/src/editor/defaultInteractions.js\":\"9fc0655ec73f5748\",\"/knowledge-medium/pr-preview/pr-1887/src/editor/editSettleSignal.js\":\"4cbfd14aeada7560\",\"/knowledge-medium/pr-preview/pr-1887/src/editor/insertImage.js\":\"8bfd13c1a8c435c0\",\"/knowledge-medium/pr-preview/pr-1887/src/editor/referenceCompletionRange.js\":\"2cfd846614a33a4e\",\"/knowledge-medium/pr-preview/pr-1887/src/editor/referenceTargetTypes.js\":\"76ac4ed1ea69c213\",\"/knowledge-medium/pr-preview/pr-1887/src/editor/syntaxContext.js\":\"3315be0e7c3413c3\",\"/knowledge-medium/pr-preview/pr-1887/src/editor/triggerMatch.js\":\"a0b46f9469676da4\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/AppRuntimeProvider.js\":\"143cf5ec89bfdd3c\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/BlockFocusShellDecorator.js\":\"f521c65013524722\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/ExtensionRenderBoundary.js\":\"18bffe4f3b8a123c\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/PanelContentRecovery.js\":\"97d1842641869fed\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/apiCatalog.js\":\"f50ee50f6486ed23\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/approveExtensionHere.js\":\"228bf6d7f2e7538d\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/armedCutAppMount.js\":\"eb976c78dcb44f4b\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/batchableKeyedStore.js\":\"4f08c1d022d9f78f\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/blockInteraction.js\":\"f9f4915cc75da323\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/blockSelectionAction.js\":\"630bc0efcff0a5d5\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/compileExtensionModule.js\":\"adf679d7874194a1\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/compiledModuleCache.js\":\"21f14a4528d452fb\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/continuousGestures.js\":\"34cbb85ed4129d74\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/core.js\":\"ab2bb48dc9800aac\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/defaultRenderers.js\":\"8de6b8ffbc3789c0\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/definitionFanoutAppMount.js\":\"fe418ae40a0a4e67\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/dialogAppMount.js\":\"a818063e001fd9a9\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/dynamicExtensionSeeds.js\":\"0c473433de845ce7\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/dynamicExtensions.js\":\"4eadc5f124992faf\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/exampleExtensions.js\":\"b589947ba6407633\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/extensionApprovalStatus.js\":\"084e6c226ba9a484\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/extensionLoadErrorToast.js\":\"90bee6eb7846caf8\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/extensionLoadErrors.js\":\"92073f4aab7c0f80\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/extensionLookup.js\":\"2509b2450a5bb100\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/extensionToggles.js\":\"9f1e890f47abad8c\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/extensionUtilitiesCss.js\":\"a0a9b000e13d7f5f\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/kernelPageDeletionGuard.js\":\"c0f482a55d4a3cd1\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/liveRuntime.js\":\"879825f22bf342b1\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/openExtensionsSettings.js\":\"388c2f6a7f5a36f1\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/overridesCache.js\":\"ba1d598c157659f1\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/pluginIds.js\":\"8ea5adcb3316d224\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/processorRejectionToast.js\":\"2229c4ea0cc73911\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/runtimeActions.js\":\"24a21dd07763d618\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/runtimeContext.js\":\"2d913d196b54ea6e\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/staticAppExtensions.js\":\"bd97b70d368f6344\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/staticDataExtensions.js\":\"67f83cb4ec922ba9\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/toastAppMount.js\":\"da25fb9a3e8edba8\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/useOverrides.js\":\"e3852419822df4e9\",\"/knowledge-medium/pr-preview/pr-1887/src/extensions/useShortcutSurfaceActivations.js\":\"1aa7b2dbd0069eac\",\"/knowledge-medium/pr-preview/pr-1887/src/facets/discoverToggleTree.js\":\"0195795d51fe6c21\",\"/knowledge-medium/pr-preview/pr-1887/src/facets/facet.js\":\"92d803ea0fcd2e37\",\"/knowledge-medium/pr-preview/pr-1887/src/facets/resolveAppRuntime.js\":\"08b2051c77254dc7\",\"/knowledge-medium/pr-preview/pr-1887/src/facets/runtimeEvents.js\":\"330808361251bc47\",\"/knowledge-medium/pr-preview/pr-1887/src/facets/togglable.js\":\"88fbcad5d972180a\",\"/knowledge-medium/pr-preview/pr-1887/src/facets/variantFacet.js\":\"8e0bf90501f2079e\",\"/knowledge-medium/pr-preview/pr-1887/src/facets/verbFacet.js\":\"0f03616f9432e395\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/block.js\":\"4efa7587fdedc2c4\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/focusedChild.js\":\"87021fff2c64d57d\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/propertySchemas.js\":\"175de323d2fbbf4a\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/typeRegistry.js\":\"be91a999cca6d524\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/useAncestorCrumbs.js\":\"f499baac0eab3581\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/useAutocompleteListbox.js\":\"a4c3a22737723079\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/useDebouncedSearch.js\":\"221fa4a09b542407\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/useDebouncedValue.js\":\"52d3496c9d3fdf7b\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/useFacetValue.js\":\"628092fd6cd90654\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/useIsFocalRender.js\":\"255758d0c8b06b7c\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/useIsReadOnly.js\":\"ad74e284a3e00303\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/useMaterializeBacklog.js\":\"56b5e05fe19852c3\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/useMinuteClock.js\":\"85a079c97317bd48\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/usePanelLayoutProjection.js\":\"ca91f4666621774b\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/usePendingInvitations.js\":\"51be8879017888e0\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/useRendererRegistry.js\":\"5d9ba7f8c1807a70\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/useRetainedFieldRows.js\":\"fea5ac7b013a6391\",\"/knowledge-medium/pr-preview/pr-1887/src/hooks/useWorkspaces.js\":\"6c379dab00f7c01c\",\"/knowledge-medium/pr-preview/pr-1887/src/lib/utils.js\":\"9aaf6fe34541e531\",\"/knowledge-medium/pr-preview/pr-1887/src/main.js\":\"9986ab1732058d8d\",\"/knowledge-medium/pr-preview/pr-1887/src/markdown/MarkdownImage.js\":\"79527ebab79811f5\",\"/knowledge-medium/pr-preview/pr-1887/src/markdown/blockSeparators.js\":\"0860cd0a422b6820\",\"/knowledge-medium/pr-preview/pr-1887/src/markdown/context.js\":\"1f45b0af3a4ef9f7\",\"/knowledge-medium/pr-preview/pr-1887/src/markdown/defaultMarkdownExtension.js\":\"88e53e5e8d3065c4\",\"/knowledge-medium/pr-preview/pr-1887/src/markdown/extensions.js\":\"4f18943faeee056d\",\"/knowledge-medium/pr-preview/pr-1887/src/markdown/renderMarkdownHtml.js\":\"6cb146d347bf4b9d\",\"/knowledge-medium/pr-preview/pr-1887/src/minimal-editor.js\":\"fbde63343b0a6140\",\"/knowledge-medium/pr-preview/pr-1887/src/paste/armedCut.js\":\"21c8cbbf4d7b40d4\",\"/knowledge-medium/pr-preview/pr-1887/src/paste/captureMediaVerb.js\":\"3b4f5bdba3c421e2\",\"/knowledge-medium/pr-preview/pr-1887/src/paste/clipboard.js\":\"9bcf9024c173d7c5\",\"/knowledge-medium/pr-preview/pr-1887/src/paste/decision.js\":\"8e42383eef4b8e68\",\"/knowledge-medium/pr-preview/pr-1887/src/paste/operations.js\":\"6ed3f6ca5f2efa22\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/account-header/AccountHeaderItem.js\":\"da175925fc122693\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/account-header/index.js\":\"16d4480bddaacc5b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"401dcfdb0f170f8e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-dispatch-companion/askAgent.js\":\"ab07079e82cc9a5b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-dispatch-companion/askedStore.js\":\"5e768ab515d65b22\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"cc1b6bd91ad44528\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-dispatch-companion/chipState.js\":\"5627ef7b80303766\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-dispatch-companion/dataExtension.js\":\"6c8ed86d392b8417\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-dispatch-companion/index.js\":\"d41457e56eea9991\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c31062bf1f6ffecb\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-dispatch-companion/schema.js\":\"2db6cbb7d2313d64\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c6a27df884fc7c93\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/BridgePairingDialog.js\":\"bc0dd167aaced35b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/addMedia.js\":\"50071f6821b0c995\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentViews/backlinks.js\":\"25d74a517a6ea936\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentViews/block.js\":\"4428f14b16af2047\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentViews/context.js\":\"800e942501faf699\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentViews/displayIds.js\":\"0e5afaf1f14d9dbb\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentViews/index.js\":\"fd0d5d2515bfd024\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentViews/outline.js\":\"934cc1b360ac053e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentViews/properties.js\":\"ac993f3331f7f7bc\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentViews/refs.js\":\"6da568e46494c930\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"dd6888f20ee07b38\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentViews/search.js\":\"e07eb6bddc52de16\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentViews/shared.js\":\"c0691a38a4eed8d4\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"e62008c3dc7b743e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentViews/text.js\":\"f51c700391d90c21\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/agentWrites.js\":\"0de8a647c14fbd92\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/authoringCatalog.js\":\"f6f95ecce861e6ff\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/blockRefTargets.js\":\"7abba9e682583368\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/bridge.js\":\"58cc4cd2e12f96c5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/bridgeLoop.js\":\"3a7a6acbaa163fd1\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/changeHistory.js\":\"58b2e4997748e524\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/commands.js\":\"fe9ac019b5f0b37b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/commentsCommands.js\":\"01203bea3503ac6f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/dataExtension.js\":\"e64d0d90229641c3\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/dataModelGuide.js\":\"894da0b0d747e761\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/dayPropertyInputs.js\":\"45d39c853e18d2da\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/describeRuntime.js\":\"7ed20016cb3a1553\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/extensionLint.js\":\"920584c32840611b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/grainAudit.js\":\"eea86b55b549a42d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/healthCommand.js\":\"65e52ec53eefdf03\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/index.js\":\"3873d97775be1498\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/presetIdentity.js\":\"8a9b2347d92e3119\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"526cc75285cf0521\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/readMedia.js\":\"0c83adaba4d24073\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/schema.js\":\"6a1f5ab73fd0402b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/serialization.js\":\"e7a0dd66319ff27f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/targets.js\":\"2a514157b1c2fc56\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/tokens.js\":\"eb20368d86487808\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/watchEvents.js\":\"2e97feba173c7c2a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/workspaceGuard.js\":\"70764cc0b4c8b68e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/agent-runtime/writeCommands.js\":\"674e10dcfd48ac8d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/alias/AliasCollisionToast.js\":\"84ecf92eca2d2b38\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/alias/DuplicateNameBanner.js\":\"46bc78912c4c89bd\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/alias/collisionMerge.js\":\"2970063d71b5dc86\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/alias/dataExtension.js\":\"5681bb520497532f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/alias/index.js\":\"d8c68379675e0a68\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/alias/mergeCollisionAction.js\":\"2dd0ac7dd1272e1a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/alias/pageStyling.js\":\"d3fae4cbe3920901\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/alias/rejectionToast.js\":\"3f11ec83664a1501\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/alias/syncProcessor.js\":\"33096d7b178cb1a6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/actions.js\":\"afcaec3a92cff224\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/addComment.js\":\"31b35f48023dc9df\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/anchor.js\":\"2e84ad46dc33c6eb\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/anchorState.js\":\"5c0f865424e951ad\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/commentLinks.js\":\"3006077b27f1d022\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/confirmThreadDeletion.js\":\"ea83762f49e26630\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/container.js\":\"ef5fe47902a927f5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/dataExtension.js\":\"e86d778bb4a47b61\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/deleteComment.js\":\"e7ea8c640abc4920\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/highlights.js\":\"a45a2362e7b6c25d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/index.js\":\"ff612ad69691ab5e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/linkedCommentsPill.js\":\"2cc80772b90b9d48\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/margin.js\":\"c87ffa08e0d70fe2\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/marginAnchorLinks.js\":\"41f96e68ceba6a83\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/marginSchema.js\":\"818abb534558bd55\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/newComment.js\":\"2ca93aa949a8086b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/ownThreadPicker.js\":\"99e6457a7592c461\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/placement.js\":\"76a6704a1333652b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/queries.js\":\"06395f98960039ed\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/quotePosition.js\":\"c7c2b3dda0620b11\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/quotedIn.js\":\"86db4ebc5f0435cf\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/quotedRange.js\":\"024e8946e07d10ce\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/rangeRefs.js\":\"bbf83c423cb068b2\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/readHighlights.js\":\"c314e10f299e0595\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/readSelection.js\":\"a8f3cc1bbf7a61f6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/readSelectionUi.js\":\"3fca607662f5aacb\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/reanchor.js\":\"6567b2a9bf27dcc4\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/schema.js\":\"8b8939b4a69bb6b2\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/scope.js\":\"c4779f575925a7c6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/scopeThreads.js\":\"caa02860ebefb421\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/splitRetarget.js\":\"e7742ef2bae8d8ce\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/suggestionCard.js\":\"127c18897784e961\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/suggestions.js\":\"f54a3a57a7eb984b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/summaries.js\":\"1e6bc8a2ae15de12\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/summaryBatch.js\":\"8a232fe296e9c881\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/surface.js\":\"2d41f040e579e592\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/threadNavigation.js\":\"04f833545112ecba\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/threads.js\":\"d43da15fe708a5d7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/ui.js\":\"704e61ddc4425345\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/annotations/uiStore.js\":\"b29907685f16cbb4\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/app-intents/appIntents.js\":\"079b5a07f36557a1\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/app-intents/index.js\":\"880f5f9a59de83c9\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/app-update-prompt/index.js\":\"08e3c696354c36aa\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/app-update-prompt/status.js\":\"7874b3aa4bc51a51\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"482b83f15cb61117\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/MediaBlockRenderer.js\":\"e3c938c771ee30f0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c7730cbc3061a22d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/MediaUploadReconciler.js\":\"11aee7025cc0a50a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/assetDownLane.js\":\"e515c9fad99259c3\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/assetResolver.js\":\"941871c9675e8ab6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/assetUpload.js\":\"f0f49a2ba7ef6650\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/attachmentCleanerIO.js\":\"d28687a6ac3024e7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/audit/supabaseAuditIO.js\":\"e54e799a69595cc8\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/blobStore.js\":\"d4972e81744b5890\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/browserMedia.js\":\"2626f20872f43c7f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/byteStore.js\":\"243195cc0377e676\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/cleanerIO.js\":\"8429769b19e17d4e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/cleanupAttachments.js\":\"5425be5abca29ac4\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/dataExtension.js\":\"996e619f4eaa667f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/downLane.js\":\"f553fdb4b072ef97\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/index.js\":\"f2b61638780e0c9a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/insertImageContribution.js\":\"e6cc83ecf695f554\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/laneArming.js\":\"2af7370868e75714\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/laneLock.js\":\"f110ab362a1b3c9a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/mediaBlock.js\":\"3a727ce03e7cc613\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/mediaCapture.js\":\"3ade79dd3215c322\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/mediaLanes.js\":\"9359046714be07ac\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/mediaViewers.js\":\"3bf36a43ed1ad5b7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/mediaViewersFacet.js\":\"f035c04a3445324e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/pasteCapture.js\":\"886c76aa89e0a2b9\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/resolver.js\":\"582389822a1f222f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/retryUploadsAction.js\":\"498a250f755ddbc7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/storagePaths.js\":\"541f6f4a0747a67a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/uploadDrain.js\":\"91f4977d5abbf6af\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/uploadLaneStatus.js\":\"d1daf0c54f25975a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/uploadReconcile.js\":\"9d5b9587c0e33278\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/uploadRecovery.js\":\"85a1526004547dd9\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/uploadStore.js\":\"d2c5e0938784e4ac\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/attachments/useAssetObjectUrl.js\":\"65566ae9c4717d3f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9e56da1f93efc903\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks-view/BacklinksViewSection.js\":\"10dd3157099b65db\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks-view/facet.js\":\"e7daefe20379813c\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks-view/index.js\":\"f74476c9a70d83d6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks-view/prop.js\":\"64a510ff8c6c0266\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/BacklinkFilters.js\":\"5ef43c1effad7b0d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"14acb08bf7294b81\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/BlockEntry.js\":\"f074dac96aa0e06c\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/LinkedReferences.js\":\"9e25b56277be4499\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"163f00552943879c\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/dailyNoteDefaults.js\":\"afe551ae59c002cc\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/dataExtension.js\":\"fec003c079a96c37\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/edgeExclusions.js\":\"a8729557a327b5af\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/filterProperty.js\":\"480c08d5ec740bfb\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/index.js\":\"d64c1aec6369ccda\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"db1348938be07541\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/inline-counts/applies.js\":\"15505c9476f46986\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/inline-counts/countQuery.js\":\"c053f65ac16dfb70\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a1959d05d5a2bc1e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/inline-counts/index.js\":\"00037a4fe8efce42\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"57b34005dd2b1758\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/presentationInvalidation.js\":\"a9d8f567d32bba2c\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/propertyEditorOverride.js\":\"a796493a8080e356\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/propertyFilter.js\":\"a41d221c2e312597\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/query.js\":\"64c5215e0b67b84c\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/resolveFilter.js\":\"1c6edba1530c8bc4\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/sourceBatch.js\":\"b218b7a2ff4b5bf5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/sources.js\":\"40e0bf037163cc50\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/useBacklinks.js\":\"e1366a5958678058\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"81694db39dcd371a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/birthday/BirthdayCelebration.js\":\"d5f431d7de75231a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/birthday/BirthdayOverlay.js\":\"26b6a8643c21fc98\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/birthday/gate.js\":\"0909d1a27deaa7b3\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/birthday/index.js\":\"dd983ae555a1eed5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/birthday/wolfTheme.js\":\"d72f988ca869c32b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-drag/BlockDragLayer.js\":\"305d434fb7163302\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-drag/dragController.js\":\"eba72db9bb21c1e9\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-drag/dropTarget.js\":\"97792a0d6fddccc1\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-drag/index.js\":\"3dc9b1ab47fe149c\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-drag/projection.js\":\"4cc8f9d839876b70\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-info/BlockMetaCard.js\":\"69ca6931b1e5c527\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-info/index.js\":\"0167bf4ed9857c1d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-tagging/AddTagDialog.js\":\"0d00910dc1610f83\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7eaa1912a391e349\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-tagging/TagNameIssueHint.js\":\"b8a1b5814b099628\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-tagging/addTagAction.js\":\"1dd0f99d4f9ae440\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-tagging/appendTag.js\":\"8cd1dba29d25675e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-tagging/config.js\":\"1e41d5e7d316d2d9\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-tagging/dataExtension.js\":\"ba4f33a9cdb300b7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-tagging/index.js\":\"4f6890e4a2f29292\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/block-tagging/propertyEditorOverride.js\":\"c0e89c726c99f187\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/breadcrumbs/BreadcrumbList.js\":\"556bbddd4b1ac66a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3dd42aaf8c77b14a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/breadcrumbs/Breadcrumbs.js\":\"412c1de4e4714a85\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"bdaddfab612e1d19\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"0916e1d69d5ba345\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/breadcrumbs/index.js\":\"6f10ca5dc6b5ee1b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"412b9e937ad9c4b9\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/character-counter/CharacterCountItem.js\":\"5adf0eb9ab7c3904\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5563ee9b7d7925b5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/character-counter/actions.js\":\"f5b874fe70558af6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/character-counter/blockType.js\":\"371383cfadb0947c\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/character-counter/charCount.js\":\"c050149d5861d28a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/character-counter/dataExtension.js\":\"786216cf4d105806\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/character-counter/index.js\":\"c9aad51332bf7694\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/character-counter/profiles.js\":\"fe15411e89416eca\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/character-counter/properties.js\":\"02afefe063e368d0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/character-counter/subtree.js\":\"4251b28592a10deb\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/character-counter/textCounts.js\":\"e6f269aed3533186\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/colemak-keybindings/index.js\":\"d17f8a634e395722\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/command-palette/CommandPalette.js\":\"8240bc58f83b3874\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/command-palette/HeaderItem.js\":\"b8dbff468c4440f1\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/command-palette/context.js\":\"c69d9c39f83d27d4\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/command-palette/index.js\":\"301a3b48795e010a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/command-palette/selection.js\":\"14f83ac271190039\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/command-palette/toggleStore.js\":\"66fb02c9f1a5c44d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/command-palette/useCommandPaletteActions.js\":\"532213d3bb97e494\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/contributors/ContributorBadges.js\":\"03c85a96247eccbf\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/contributors/author.js\":\"ab2fd985280ca569\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/contributors/codeMirrorExtensions.js\":\"624a5497de6e025e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/contributors/dataExtension.js\":\"51b31dcf6edca8d7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/contributors/index.js\":\"1675b02bafa8afcd\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/contributors/mentionAutocomplete.js\":\"993d7154c3341f88\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/contributors/processor.js\":\"453adb8dea4aa8aa\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/contributors/profiles.js\":\"58ab83bb2f74c8f5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/contributors/queries.js\":\"67d6e9fbc1aa0029\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/contributors/schema.js\":\"554ab04ad837170e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"726d648fec66461e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/cursor-follows-scroll/followOrigin.js\":\"22c1ae481d0e28e4\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/cursor-follows-scroll/index.js\":\"7ffcd5a994f7aa6b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d3c736842499f4d2\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5a3c5b885c1ab31b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/CalendarGrid.js\":\"0a6ef6ad68cedfa8\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/DailyNotePicker.js\":\"9af881853cce428d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"2152527909f8fef9\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/DateNavDecorator.js\":\"926d660293ace561\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/DateScrubOverlay.js\":\"a19d9c563f27c680\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/DayPropertyEditor.js\":\"18b0a4e51a8b072d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/HeaderItem.js\":\"8d85e56fb54f6105\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/ReschedulePicker.js\":\"613ce16c1e508299\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/SpreadDatesDialog.js\":\"f53470f96f16559a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/actions.js\":\"af78da3ae0d7a9cb\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/blockDateAdapter.js\":\"363fcde3a9ae7f2a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/calendar.js\":\"6b942a7036904868\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/dailyNotes.js\":\"77e8cc86db662f31\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/dataExtension.js\":\"c8b789c3fb6ef3ac\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/dateScrubActions.js\":\"d121211c520efccc\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/dateScrubGesture.js\":\"f656d421ce817e3d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8f55218955d5def6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/dateScrubRecognizer.js\":\"815f05834fad7c86\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/dayProperty.js\":\"c34efd15a0884fb9\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/deletionGuard.js\":\"d5c57459f18af40a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/dueQuery.js\":\"d75c6fbbb6c1a359\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/index.js\":\"baa9ff6ec7d18ab7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/landing.js\":\"53d920c4257b5c84\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/localSchema.js\":\"38b03b1c11191779\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/referenceDateAdapter.js\":\"ccdb23bf1aa37f92\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/rescheduleAction.js\":\"8990bdc675f6f451\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/schema.js\":\"77f7bc2c7183600e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/spreadBlockDates.js\":\"6b05d1700a9648a4\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/spreadDatesAction.js\":\"73de7607a5535687\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/today.js\":\"dfa885977148fac3\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"261f2d6e27882838\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"18c8cc68afb20621\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/data-integrity/audit.js\":\"0523e6f7839d0aa7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/data-integrity/auditAction.js\":\"f53d010456ed1158\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/data-integrity/auditRanges.js\":\"8d731f76cfa3e106\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/data-integrity/diagnosticsSource.js\":\"4993d193bd7697b0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/data-integrity/divergenceScan.js\":\"6dc5c30e5f97b746\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/data-integrity/index.js\":\"357315dca6244a30\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/data-integrity/propertyChildrenChecks.js\":\"4296b8d1f15306bc\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/data-integrity/referencesMirror.js\":\"1bf51c3993b2ae58\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/data-integrity/rowJson.js\":\"33960d784b025e80\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/data-integrity/schedule.js\":\"6ce8cb3742a88586\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/data-integrity/store.js\":\"9a4049ed0fe4329a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-maintenance/action.js\":\"7cfaa538787b1479\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-maintenance/index.js\":\"a8e4c006cfa4cd5a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-maintenance/plugin.js\":\"0410fcb1633f90bb\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2ac43bb5f2182c8d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-mirror/actions.js\":\"2275e8186653940d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-mirror/changeMarker.js\":\"98cbb5cb47fb3eb2\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-mirror/diagnostics.js\":\"8468b89cdd9c9a99\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-mirror/fileSystemAccess.js\":\"a6144a284ba0ee69\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-mirror/filenames.js\":\"7971c73c68ced9bb\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-mirror/index.js\":\"891350fd3c5cfc59\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-mirror/mirror.js\":\"edc9c9169096c08e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-mirror/runLock.js\":\"2c83b77887ff7286\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-mirror/runtimeHealth.js\":\"d7681f9aec5289a5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-mirror/schedule.js\":\"c8374dd230594161\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/db-mirror/store.js\":\"e7859287888a2a2b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/default-themes/index.js\":\"17e2fddb4716e283\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/default-themes/themes.js\":\"9f14d6af2c45f74a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/diagnostics/facet.js\":\"807233f683cf6f5a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/diagnostics/useDiagnostics.js\":\"91926351d565d6c7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extension-prompts/dismissals.js\":\"1e6dc056765aa20a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extension-prompts/index.js\":\"0fd98cdef0b79f24\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extension-prompts/status.js\":\"b7aeeef00722d717\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extension-prompts/store.js\":\"a001282251236728\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c4690c5e104d75da\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ee314cf00fd7708b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extensions-settings/actions.js\":\"1fa6137165cb2b61\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extensions-settings/config.js\":\"b64abf569f6648e0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extensions-settings/dataExtension.js\":\"556445af90c60823\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extensions-settings/effect.js\":\"169f36cdadc5a3ee\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extensions-settings/index.js\":\"4ec02643ee924da0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0806391eaa753c66\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extensions-settings/useToggleTree.js\":\"61f7707cec41cffd\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extract-type/ExtractTypeDialog.js\":\"c71b4a24149d0b29\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"13b6d32f8c70db28\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extract-type/PropertyShapePicker.js\":\"35df1f62d860b660\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extract-type/action.js\":\"cbaf72a65987e355\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/extract-type/index.js\":\"cfd43749484c8654\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/find-replace/FindReplaceDialog.js\":\"cc940cde25a28d12\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/find-replace/HeaderItem.js\":\"e77ae7c24ec95491\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/find-replace/dataExtension.js\":\"e8848998ed0a2798\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/find-replace/index.js\":\"84fa84ffcb90a7ec\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/find-replace/search.js\":\"974b052afe8b86a6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/find-replace/toggleStore.js\":\"5a910d8ecfe51d76\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/LocationPropertyEditor.js\":\"c1651c2e64217719\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/MapView.js\":\"bd89c61652438d84\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/blockTypes.js\":\"9bc9ce3c1dc195e0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/codeMirrorExtensions.js\":\"19b6bd7a6c1370eb\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/createOrFindPlace.js\":\"0ceea59bf4ef47a0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/currentLocation.js\":\"e3806013e47ea7e2\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/dataExtension.js\":\"2c49a548b6c522f0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/geoContentDecorator.js\":\"93cbda8f4c019c78\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/googlePlacesClient.js\":\"46c48f4e2ae77097\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/index.js\":\"2a6b17d5b01a5d76\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/locationsPage.js\":\"507ca004e2e49bc3\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/mapViewport.js\":\"04d5e88599de2b11\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/pickCurrentLocation.js\":\"68ce74052623cbee\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/placeAutocomplete.js\":\"8f2fe7f3074a9d66\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/placeNameCollision.js\":\"30b3c42d970469aa\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/properties.js\":\"71bcea7c54403a3d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/propertyEditorOverrides.js\":\"7f0990821796fde8\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/query.js\":\"38a28f7dc5de31c5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/geo/usePlaceSearch.js\":\"216eaf8735f7691f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"546921a35684f2ee\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"2696a12506c3ebb1\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4e70880ab2f0b461\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/grouped-backlinks/config.js\":\"48dddd27408b8447\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/grouped-backlinks/dataExtension.js\":\"d9d3bcd77b1863d3\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/grouped-backlinks/facet.js\":\"bd81295b90f2f3bd\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/grouped-backlinks/grouping.js\":\"e97a161cb155592a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/grouped-backlinks/index.js\":\"66cca991b27419b5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"d3298109aa4dea1f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/grouped-backlinks/query.js\":\"db55e828c861fd47\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/grouped-backlinks/resolveConfig.js\":\"1470dfca82c387e1\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"42ae3aff9393d681\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"53490042289ef924\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/html-document/HtmlDocumentContent.js\":\"d11da323260e4a33\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/html-document/HtmlFrame.js\":\"6674067163870450\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/html-document/actions.js\":\"758168f854e014b3\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/html-document/blockType.js\":\"377d895fdf5bc8a5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/html-document/confirmRunScripts.js\":\"7a52bf25b5eeb7f2\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/html-document/dataExtension.js\":\"59f1be70593275a2\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/html-document/frameAnnotations.js\":\"82c6411f4c41eb58\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/html-document/frameDocument.js\":\"d7b4879d4f1b8cf5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/html-document/frameTheme.js\":\"c2ab42bb7eb4453e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/html-document/index.js\":\"0f9e93b660744bc7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/html-document/scriptConsent.js\":\"64e8bfe0c9076c0f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/html-document/sourceMap.js\":\"c27841efaa4ba47b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/html-document/useDocumentScripts.js\":\"28905e6fc61156a7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/interaction-metrics/index.js\":\"2725c4316259b904\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/interaction-metrics/record.js\":\"196dde3e45ce4ded\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/interaction-metrics/recordStore.js\":\"00813bf39f300739\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/interaction-metrics/responsiveness.js\":\"d8f811a31c8bdd07\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/interaction-metrics/schedule.js\":\"70922d03a70d2e6a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/interaction-metrics/sessionContext.js\":\"ade757ea7bf138d0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5df0295de7779cbf\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"955a16e155460bb6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/keybindings-settings/actions.js\":\"c6048c2de7020c9d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/keybindings-settings/config.js\":\"4bd9cda2459f8e9b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/keybindings-settings/dataExtension.js\":\"5f4c007f050e785a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/keybindings-settings/effect.js\":\"ddcc72da4d8d278b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/keybindings-settings/index.js\":\"d712b1710ca8a82e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/keybindings-settings/keyCapture.js\":\"e0202fe8c88c06f4\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/keybindings-settings/overrideStore.js\":\"f9e9a1b6d8af964a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8082f07c83dfddab\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/left-sidebar/HeaderItem.js\":\"db719b30661ddc4f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/left-sidebar/LeftSidebar.js\":\"24e633c8eac8ab32\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/left-sidebar/actions.js\":\"97627b1cc6e21ffb\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/left-sidebar/facet.js\":\"0386319fd8886979\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/left-sidebar/index.js\":\"c4bf26aa34e5b6e9\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/left-sidebar/shortcuts.js\":\"728f6c089e8e6346\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/left-sidebar/toggleStore.js\":\"8cf4f8ac8cdad0d7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/merge-blocks/MergePicker.js\":\"fd0fcd153b7f538e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/merge-blocks/index.js\":\"afc141a12b320719\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/merge-blocks/mergeAction.js\":\"53828712c1920c0f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/merge-blocks/strategy.js\":\"14f785b0997554aa\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/mobile-bottom-nav/Button.js\":\"d8967a51d9aeb310\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"89cce1b47baa8838\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f42034ef39c89796\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/mobile-bottom-nav/facet.js\":\"41065fc39f090f8e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/mobile-bottom-nav/index.js\":\"fb17a5e84affdc04\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"901be06d36bace74\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/mobile-keyboard-toolbar/actions.js\":\"695dff4e899dc335\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"90343db524bc9a89\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/mobile-keyboard-toolbar/facet.js\":\"f7090cd7e8348725\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/mobile-keyboard-toolbar/index.js\":\"7cb771c78c20f8de\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9952549facb323b2\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/move-blocks/blockSubtreeMembership.js\":\"918cbd2385cecb23\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/move-blocks/contextMenuItem.js\":\"ecad787442306558\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/move-blocks/index.js\":\"95f57bbb6d39857a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/move-blocks/moveAction.js\":\"aa1ed7b3668049d3\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/move-blocks/moveBlocks.js\":\"ec1e87cec090db7c\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/move-blocks/selectionAfterMove.js\":\"8d9209467e0f9e17\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/onboarding/TutorialBanner.js\":\"10c350e8e266e8d0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/onboarding/action.js\":\"19263a0017619ea4\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/onboarding/bannerDismissal.js\":\"db795b483ba1fa52\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/onboarding/documents/cheatSheet.js\":\"39f7518033ddca5e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/onboarding/index.js\":\"eee1a8d424d959ad\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/onboarding/keys.js\":\"ddccd045e16b5a1e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/onboarding/landing.js\":\"34ff2c4944908174\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/onboarding/outline.js\":\"2d7fa1897d486380\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/onboarding/seed.js\":\"95fc5cc23b554141\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/perf-monitor/PerfTrendDialog.js\":\"c92b8136b40ec00e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/perf-monitor/analyze.js\":\"084ef6ccdadc7291\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/perf-monitor/diagnosticsSource.js\":\"68f4e4c56ae8a9bf\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/perf-monitor/index.js\":\"4e14098fb59b286d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/perf-monitor/load.js\":\"a3e1e7a1f1a33431\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/perf-monitor/monitorRun.js\":\"da9b26d2ed49270b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/perf-monitor/schedule.js\":\"5525ab5cae5b32e5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/perf-monitor/series.js\":\"cb5aa3189d163272\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/perf-monitor/store.js\":\"2834cfd8588f9ac6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/perf-monitor/trendAction.js\":\"4b5d8dbd3a7df3f5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/perf-monitor/verdict.js\":\"f3f7a74302cc85d3\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/plain-outliner/clickToEditAction.js\":\"f77bbf8aa9edc4c5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/plain-outliner/index.js\":\"010cf7f3550a94f9\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/plain-outliner/interactions.js\":\"b0ef82c53534b922\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"cb1e18e086bc3a3f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/properties-migration/MigrationGate.js\":\"82a635366d1f08b7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/properties-migration/MigrationGateDialog.js\":\"1d51d353da1539f3\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/properties-migration/action.js\":\"3cae6112c90204fc\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/properties-migration/index.js\":\"5baa44626a59504a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/properties-migration/localRunMessage.js\":\"467e2b5e4768ad62\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/properties-migration/plugin.js\":\"5e89a825406c74d0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/properties-migration/progressReport.js\":\"5fcf1dd9c3a1274d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/properties-migration/sweepProgress.js\":\"7c21b399d96b0e04\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/property-rows/FieldRowRenderer.js\":\"cbbe6ba294c5af2c\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/property-rows/ValueRowRenderer.js\":\"551c1bc1c81a087a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/property-rows/actions.js\":\"49bbc0e4b80fc60e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/property-rows/autocomplete.js\":\"d1c289d78962b917\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/property-rows/fieldRow.js\":\"aafb878f9001cc3a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/property-rows/index.js\":\"21c6291b963f60eb\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/property-rows/referenceWarning.js\":\"f477bb0c503e4753\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/property-rows/valueAutocomplete.js\":\"a2f2f9c418d12ae7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/property-rows/valueSchema.js\":\"60be0a8ce335df15\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/quick-find/HeaderItem.js\":\"85e35e2878f55007\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/quick-find/QuickFind.js\":\"07047537300a9d0a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/quick-find/index.js\":\"f4be1a31ced71ecd\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/quick-find/recents.js\":\"84a77b232e0cad21\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/quick-find/resultItems.js\":\"6808dc693b74d0d8\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/quick-find/selection.js\":\"c6d95153be035413\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/quick-find/toggleStore.js\":\"29820e0c8160e638\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/recents/HeaderItem.js\":\"7c71592ff5793d9e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/recents/RecentsPageBlockRenderer.js\":\"523e5f52386b4caf\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/recents/grouping.js\":\"4b43374217f32de8\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/recents/index.js\":\"70538f2155fa67df\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/recents/target.js\":\"84ee8adee9614c3b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/codeMirrorExtensions.js\":\"4c41fc11aaa27a00\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/contentPrefill.js\":\"4ca2f115c66951b2\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/dataExtension.js\":\"f11edd9d9da14531\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/index.js\":\"0e7e8c89fccd8adf\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"5a88ff225034d07e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/invalidation.js\":\"0f0a96f70591eb32\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/localSchema.js\":\"91ebd721c71906ab\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/markdown/blockrefs/index.js\":\"6b9b6939aaac14d5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f7d87adc87580f93\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/markdown/index.js\":\"f5955d4233a887f1\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/markdown/referenceNode.js\":\"d3ce9558ba086ae0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/markdown/remark-reference-occurrences.js\":\"2905db8f68f30aca\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"23c46bd9a6709874\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/markdown/wikilinks/index.js\":\"f629dafaaccca8e5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"b6f973c0668fbe59\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6120ee4a071ac614\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/mergeRetargetProcessor.js\":\"38053394dde16e76\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/parseFence.js\":\"14c8dbfb1aed32d7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/referenceParser.js\":\"29a79c284d5732a5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/referenceProjection.js\":\"ab97036df84216ad\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/referencesProcessor.js\":\"da17891cc3c4ff4f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/renameProcessor.js\":\"182a56fc52eaf87a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/references/spanReplacement.js\":\"fd589fbf45c89524\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/rich-paste/htmlToOutline.js\":\"149208645c4f388e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/rich-paste/index.js\":\"0880ca5704342115\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/rich-paste/normalizeClipboardDom.js\":\"fbc1efcbd7342b2f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/rich-paste/pasteDecision.js\":\"a13575951f742894\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/action.js\":\"e576ca36f0c8e898\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/blockIds.js\":\"efbb24ce594d62d8\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/content.js\":\"0ffe84fe4aac7677\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/effect.js\":\"bc47533ee40ef3d3\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/ids.js\":\"7893874a0218fdac\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/import.js\":\"e245950a0f3bb7e4\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/index.js\":\"bf39ee49cde80067\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/plan.js\":\"486309a9a2a1ac22\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/plugin.js\":\"a6700ee2ad83cae6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/promotion.js\":\"7acb12e7758d1107\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/properties.js\":\"337828288711d507\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/references.js\":\"8332a592d36a2352\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/report.js\":\"09c8d879ec279a26\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/roamMemo.js\":\"5c703d2873b31b6d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/runtime.js\":\"4a2ed686b21da6af\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/schemaReconciliation.js\":\"858c237b1981e24f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/srsMarkers.js\":\"612c536a46a2fe25\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/todo.js\":\"f1790c5586848c97\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/typeCandidates.js\":\"064190edec2dd03e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/roam-import/types.js\":\"105ced10690a6912\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/search-health/index.js\":\"e599a1fb1e1cfb40\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/search-health/store.js\":\"18796080f3c45ddd\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/shortcut-help/HeaderItem.js\":\"7ff0cfb996052a1e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"d9f40641293267f7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/shortcut-help/index.js\":\"c31b11853e7cfd39\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/shortcut-help/model.js\":\"4b8d8ea80b5d3c55\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/shortcut-help/toggleStore.js\":\"4b5bca5932cd8966\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/shortcut-help/useKeyInspector.js\":\"66aeb86d7b2211b5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f718b285c78b07f0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/spatial-navigation/ShellDecorator.js\":\"fd0ca8a50ad9c6f6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/spatial-navigation/actions.js\":\"0d6f8d6d94f7abe8\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c13e9154d7a1fc74\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/spatial-navigation/index.js\":\"94242a3287c6ae21\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/spatial-navigation/shell.js\":\"45408a1de216f4be\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/spatial-navigation/surface.js\":\"459568a5d40e004b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/spatial-navigation/walker.js\":\"4e52133d24fe1002\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f2eb451a2d161cb4\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-rescheduling/dataExtension.js\":\"21aae39cb6e3bcfa\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-rescheduling/index.js\":\"266a5fd4473f1dda\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-rescheduling/indicator.js\":\"42a62ddfe8b718ea\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-rescheduling/moveSrsState.js\":\"e6bd88e81254cdf6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e11488316d5b6bc6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-rescheduling/scheduler.js\":\"cced86e76c4640be\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-rescheduling/schema.js\":\"91924c876661a7ec\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2da97fcca2592be5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-rescheduling/srsClipboard.js\":\"3bf0fc2e62bd8e57\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5cd58f3dcff2b5af\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7a520314d37998f2\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/DeckPicker.js\":\"955455b50ecec453\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/ReviewControls.js\":\"7b11e0e2574b77ee\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/ReviewDeckRenderer.js\":\"06389762e77cf03f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/ReviewSession.js\":\"a1fe310b2768bfab\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/actions.js\":\"abf4ecca6555496f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/archive.js\":\"cb37be7d5b1eb721\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/dataExtension.js\":\"3a91f9611e19a6bf\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/deck.js\":\"a098ed0c6d821a22\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/dueQuery.js\":\"f4a0938619fa8299\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/gradeDecision.js\":\"a5d2489deb6826de\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/index.js\":\"81e97ecf815c7e45\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/keyHints.js\":\"39df6c79f8fa7807\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/reviewCardLayout.js\":\"db514a98f0932673\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/reviewProgress.js\":\"e94a29b8c0ee8b58\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/schema.js\":\"b4cbb3eb070bdfbd\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/srs-review/useDueCards.js\":\"3c9ed384121cd223\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/startup-metrics/index.js\":\"4f9b5f9313a27087\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/startup-metrics/record.js\":\"2d34f0eabe63a6bf\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/storage-persistence/index.js\":\"10a1904884e3fab7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/storage-persistence/persistenceStatus.js\":\"6dda29acdb10f4a1\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/storage-persistence/requestAction.js\":\"95cd4f5db8638128\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/supertags/TypeChipsDecorator.js\":\"1300111704afe199\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/supertags/codeMirrorExtensions.js\":\"be8e8595bef9821d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/supertags/index.js\":\"6f66426ff3b089ac\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/supertags/typeAutocomplete.js\":\"29fb7c9aeafa308a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"4ab170265a0fe090\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/swipe-quick-actions/actions.js\":\"2f5bc7d3d81ab4ef\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/swipe-quick-actions/anchor.js\":\"c55efe41c6335e2d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/swipe-quick-actions/events.js\":\"11b367cb3743bc73\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/swipe-quick-actions/gestureActions.js\":\"2da21720c7ca7645\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/swipe-quick-actions/index.js\":\"0c74a2a332b2f4ef\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"13586d7a0256acbc\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/sync-metrics/collect.js\":\"11338a8018265756\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/sync-metrics/index.js\":\"9b8f1f34972e2646\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/sync-metrics/record.js\":\"44365819dd99ada2\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/system-status/RejectionDialog.js\":\"1b9347ca4e2a8ef8\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/system-status/SystemStatusHeaderItem.js\":\"292795dd41b446cf\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/system-status/index.js\":\"88139e7d1ef9a717\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/system-status/model.js\":\"39d5337d59f076da\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/system-status/queueCounts.js\":\"df400e9fa1b7856a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/system-status/rejectedHelpers.js\":\"329ed70665cfb2b2\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/system-status/rematerializeAction.js\":\"9c5b80d67f9b7395\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/system-status/useHysteresis.js\":\"009285fb87db0584\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/ColumnHeaders.js\":\"736c09c8e7dac412\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/QueryUi.js\":\"620068db6c4b218f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/TableLayout.js\":\"c10d94119a6a4566\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/actions.js\":\"f3656e12f2f6e9e7\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/cellEdits.js\":\"3ad8dec4d9335030\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/childrenViews.js\":\"2de1ad9a174bedd3\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/columns.js\":\"deb7e2c224b650dc\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/controller.js\":\"55c7717867eda7a5\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/convert.js\":\"1cd526b0314e8518\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/dataExtension.js\":\"70581e130246f7b8\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/index.js\":\"b69cda064f002a14\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/keys.js\":\"680350bef20d4d7a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/model.js\":\"859d2cc73de78ae3\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/query/QueryText.js\":\"d7040894c154af7a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/query/backfill.js\":\"c9e472ca0b859122\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/query/completion.js\":\"f7c4c78409f9c44f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/query/format.js\":\"81b656d3bdf17219\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/query/parse.js\":\"ca11500ab22a6665\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/query/queryValue.js\":\"8e1620ca9f759e44\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/query/registrations.js\":\"00b0156f9eabde29\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/query/source.js\":\"5475978d0cc3b650\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/registry.js\":\"6daea7a61b974e72\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/rowGutter.js\":\"8781c157d742a03e\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/rowVerbs.js\":\"facd619cb8860e30\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/schema.js\":\"fa6baf91a6a2a06c\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/tables/sort.js\":\"2287afd71ca40630\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/theme-toggle/effect.js\":\"6527058219c69ce0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/theme-toggle/index.js\":\"a8c75faebe4592e1\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/theme-toggle/theme.js\":\"6e089eb66ad23406\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/todo/actions.js\":\"aa634a457a786cff\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/todo/dataExtension.js\":\"1ac7e8adcd1205ce\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/todo/index.js\":\"2f8bbb1f605c322d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/todo/schema.js\":\"86c9e6def546bc78\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/touch-selection/TouchSelectionLayer.js\":\"11eaf0adfbdddbc6\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/touch-selection/actions.js\":\"dc3f7092b7b2f987\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/touch-selection/defaultItems.js\":\"2fa921cb6aa8f048\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/touch-selection/facet.js\":\"7044d3a713272a55\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/touch-selection/holdRecognizer.js\":\"79f1847617d02338\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/touch-selection/index.js\":\"30a3f1f649a93632\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/update-indicator/UpdateIndicator.js\":\"85f09b19f76d1d7d\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/update-indicator/index.js\":\"22594472608862ac\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/update-indicator/loadTimes.js\":\"5e38da022f73669c\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/video-player/VideoNotesRenderer.js\":\"f30441177db6525b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/video-player/VideoPlayerRenderer.js\":\"142380985e630c01\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/video-player/VideoTimeStamp.js\":\"aa24cda870ce07e1\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/video-player/actions.js\":\"105ae8da960cc5ce\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/video-player/index.js\":\"b1f4ab639b81c3e4\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/video-player/markdown.js\":\"52a46d71844bfd1f\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/video-player/notes.js\":\"0bccc7e2537f2820\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/video-player/registry.js\":\"9280246aadb251b0\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/video-player/remark-timestamps.js\":\"3dbc9178bb18fca9\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/video-player/view.js\":\"f91894fce2584936\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/vim-link-hints/LinkHints.js\":\"8460e6062410fb6a\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/vim-link-hints/index.js\":\"adc1b890d718a08c\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/vim-link-hints/model.js\":\"4ade4aa23aaf4ebb\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/vim-link-hints/settings.js\":\"ebf4fda169bcc91b\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/vim-normal-mode/actions.js\":\"7267fbcac94d96ec\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/vim-normal-mode/index.js\":\"d12bc18823f87d72\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/vim-normal-mode/interactions.js\":\"24f6d2e11ea27905\",\"/knowledge-medium/pr-preview/pr-1887/src/plugins/workspace-header/index.js\":\"5f07d567daf0618e\",\"/knowledge-medium/pr-preview/pr-1887/src/registerServiceWorker.js\":\"e32ab288f22b28d5\",\"/knowledge-medium/pr-preview/pr-1887/src/requestPersistentStorage.js\":\"7ea2d114a1bacf49\",\"/knowledge-medium/pr-preview/pr-1887/src/services/authRequestDeadline.js\":\"bdb903b7a7ff1c5e\",\"/knowledge-medium/pr-preview/pr-1887/src/services/authStorage.js\":\"bac63622f9b890f0\",\"/knowledge-medium/pr-preview/pr-1887/src/services/powersync.js\":\"1f236e8169ec3691\",\"/knowledge-medium/pr-preview/pr-1887/src/services/supabase.js\":\"18a6e149ee355a89\",\"/knowledge-medium/pr-preview/pr-1887/src/services/uploadErrorClassifier.js\":\"a8d72d19e0755daa\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/ActiveContexts.js\":\"6283211da6e58fd1\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/HotkeyReconciler.js\":\"4874e92875e44415\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/WipeLocalDataDialog.js\":\"ef9e8798b7cff703\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/actionDispatch.js\":\"b5c62e637172d84c\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/actionRefItems.js\":\"77f29f7db9410786\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/applyKeybindingOverrides.js\":\"42de092bc118b10d\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/blockActions.js\":\"6b075bc5102b2cb1\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/blockMergeGesture.js\":\"064c59b9188e7c31\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/canonicalizeChord.js\":\"7d3bc46383673eca\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/defaultContexts.js\":\"bcba3ce827f8a34a\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/defaultShortcuts.js\":\"505b264efb9814ab\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/effectiveActions.js\":\"a6b9ef673883c87d\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/gestureAction.js\":\"f6ce96588110da2e\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/gestureBinding.js\":\"68e15308576e0da9\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/holdRegistry.js\":\"1df773f4f6905b7a\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/keybindingConflicts.js\":\"865520bfe22d91bb\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/keybindingOverrides.js\":\"bb7f8ea818c144f1\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/pointerAction.js\":\"cf84a20ecbf4d433\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/resolve.js\":\"34a54c7201cf68f1\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/runAction.js\":\"3260015af185dd0f\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/sequenceMatcher.js\":\"13e31390c44a4cc7\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/types.js\":\"b956d8264472bfa3\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/useActionContext.js\":\"31c3f4e189f9a6af\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/useActionDiscovery.js\":\"7eca6510b072dc36\",\"/knowledge-medium/pr-preview/pr-1887/src/shortcuts/utils.js\":\"3220a760aa090b8d\",\"/knowledge-medium/pr-preview/pr-1887/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1887/src/sw/bootStore.js\":\"7f735e6c69ebd808\",\"/knowledge-medium/pr-preview/pr-1887/src/sw/previewDatabases.js\":\"536d2c1318375243\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/byteTransform.js\":\"fc74d12c30c563a2\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/attachmentCleaner.js\":\"3953825c18c5c607\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/bundle/attachmentParts.js\":\"05d55c28d36b7022\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/bundle/bundleParts.js\":\"09ef31ce9c1f931d\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/bundle/bundleRecord.js\":\"d4bcf731be905d77\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/bundle/manifest.js\":\"7e77a9ea8b874f81\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/bundle/takeBundle.js\":\"45f96c0d42df74ff\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/bundle/verifyBundle.js\":\"3bb618375163688f\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/cleaningStage.js\":\"e03eb1501c48eab1\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/conversionKey.js\":\"6a369bd705ad1f79\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/conversionServer.js\":\"456d908f576ff6cb\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/flip.js\":\"64ce367122586621\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/flipAttempts.js\":\"d69c943d2d4a38ec\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/pages.js\":\"4780c93c62702c4e\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/preflight.js\":\"3435966a8dc9c0e9\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/reseal.js\":\"6a08da6ac6588917\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/runConversion.js\":\"1f9668ca6ee19604\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/runLock.js\":\"6685c1b2595fd6e8\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/sealing.js\":\"1b8218e1dd6715f4\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/sealingStage.js\":\"776a46c519358d22\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/stage.js\":\"b2c26409d22e0f41\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/conversion/verifyReseal.js\":\"ca13268160e0ca3d\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/aad.js\":\"86ebc68a0555b6f1\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/aead.js\":\"e78681c51dc9be66\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/base32.js\":\"836d5e9231cfa57f\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/base64url.js\":\"7bce06ef7262d93d\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/binaryEnvelope.js\":\"3b78e96b6c76fbe9\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/byteAead.js\":\"17acf2b141af6eb6\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/canary.js\":\"ad829525a24c6900\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/contentHash.js\":\"b3037db5fcda0410\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/contentKey.js\":\"435690d37619f0a2\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/derivedIdNamespace.js\":\"e23c92ab24ea713d\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/envelope.js\":\"6e5cc6917fd334fa\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/hex.js\":\"3762c3a384d180e0\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/sha256Hex.js\":\"f0fa090d12689455\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/crypto/workspaceKey.js\":\"22568ba314d5a69d\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/keys/conversionState.js\":\"955ea77f0b6fd61a\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/keys/flows/createEncryptedWorkspace.js\":\"2fc045db01366a53\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/keys/flows/pastedKey.js\":\"58fca83a12de10a1\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2c6454c09d87b972\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/keys/flows/upgradeWorkspacePin.js\":\"426da38bbb735b2b\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/keys/keyStore.js\":\"ee61800e192162b8\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/keys/mintWorkspaceKey.js\":\"379e335ce350c251\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/keys/modePin.js\":\"8508970421f9e15a\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/keys/openWorkspaceKeys.js\":\"5291123519fcb3eb\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/keys/resolveWorkspaceEntry.js\":\"e614a8c120a81a19\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/keys/resolver.js\":\"3dc872817a0f4a4e\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/keys/workspaceAccess.js\":\"7714dc150d13a226\",\"/knowledge-medium/pr-preview/pr-1887/src/sync/transform.js\":\"4cfedeaf825dae58\",\"/knowledge-medium/pr-preview/pr-1887/src/themeBootDefaults.js\":\"ebb01a5ecf941177\",\"/knowledge-medium/pr-preview/pr-1887/src/types.js\":\"9504cf98cc61ea86\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/ClientLocalSettings.js\":\"58bedee27e987137\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/abortableSleep.js\":\"038e7529d2e23709\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/array.js\":\"a85075fbfd9f4541\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/backlinkAutocomplete.js\":\"24658707f555c373\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/blockCrumbs.js\":\"7a65c40ed21fecd3\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/blockrefAutocomplete.js\":\"af8ac03e9576db1e\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/cadencedIdleJob.js\":\"436007265b2ee218\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/callbackSet.js\":\"5525beb80a7a24a7\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/clientId.js\":\"fcc89538dcced82d\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/codemirror.js\":\"e3300ed0b654ecb2\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/codemirrorCompletion.js\":\"60fdbdeca72aae6a\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/copy.js\":\"4b9bc6f20b5f3db8\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/dailyPage.js\":\"9c611cde4618b8d4\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/dbForensics.js\":\"6322d58c0141206e\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/dbForensicsHooks.js\":\"91c264f27d8ec9cf\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/deleteBlockThroughUi.js\":\"24766a41ea500697\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/dialogs.js\":\"8c6c93d734002276\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/dom.js\":\"9a7a16ad9f33a51f\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/downloadBlob.js\":\"9b9fa628308f47a0\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/drawnWalk.js\":\"009ab4ec93fdd80d\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/exportSqliteDb.js\":\"1acb8a6ca3cd4067\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/fileSystemAccess.js\":\"dd53a8c9a993e7e7\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/flipSlide.js\":\"2c2ee8ca791f1f74\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/fnv1a.js\":\"418696577b462aef\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/formatBytes.js\":\"b1f85c1ec0a0c76d\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/fuzzyRank.js\":\"20672784de9b1f62\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/idbKeyedStore.js\":\"f0683a0033aebe0d\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/idleCallbackPolyfill.js\":\"c59f32e02bf8cde0\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/keyboardAwareScroll.js\":\"435080a1c5375eea\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/keyboardViewport.js\":\"18052cb4b843f434\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/lastWorkspace.js\":\"110f5ee6d1f00daf\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/layoutColumns.js\":\"057de6f7fe4b9be0\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/layoutSessionDom.js\":\"69196133e45f167d\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/layoutSessionId.js\":\"b7d858dad8b409be\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/linkClickGestures.js\":\"26af27e4a9bb7334\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/linkTargetAutocomplete.js\":\"abe74541bb773334\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/localDbCorruption.js\":\"37644a5729cc3bd3\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/localDbRecovery.js\":\"dee74110bd282fb9\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/markdownParser.js\":\"fb2dce4beec3bb69\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/memoize.js\":\"4bfc63190058fb6e\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/nameFieldCommit.js\":\"f182469f09dbf1bb\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/nameList.js\":\"ed70f76b9e673171\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/navigation.js\":\"78c49fa745f286e9\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/omnilinerNamespace.js\":\"de7e0ec6f36543ae\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/opfsPageScan.js\":\"479aca9a62255d1d\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/panelClearance.js\":\"b53ad8e4fdebaacd\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/panelHistory.js\":\"ab648d7e3383bccc\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/panelLanes.js\":\"0c176cb71a88390c\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/panelLayoutProjection.js\":\"a25aa87d57172198\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/panelScrollAnchor.js\":\"ef8c08912ea6e777\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/panelUrlFlags.js\":\"bf09dc32a44d919c\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/platform.js\":\"431dfc3c692fac6e\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/pluralize.js\":\"cd59256a02a22f05\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/propertyCreation.js\":\"84fbd4677232b3a2\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/propertyNavigation.js\":\"eacdda02c1a72e04\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/propertyValueContext.js\":\"ed1b18c7dae4146d\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/react.js\":\"a0f29e21338ef8f1\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/relativeDate.js\":\"98caa66b5a59b497\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/relativeTime.js\":\"fe80a29ba1915ce2\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/renderScope.js\":\"c53792804981355c\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/resolvedThenable.js\":\"236416d509d57752\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/routing.js\":\"8890a2a6cc52b23b\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/safeMode.js\":\"05af92843a54841d\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/scheduleIdle.js\":\"63f80fc593511c45\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/screenWakeLock.js\":\"05c36b87340d1f68\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/selection.js\":\"0164f2d9890020f7\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/softKeyboardGrab.js\":\"ef7f5aee9c304a25\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/startupTimeline.js\":\"be6abea0ddbcee63\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/state.js\":\"edf9d51ed9df3f9e\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/string.js\":\"a646ec023584c2a0\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/surfaceZoom.js\":\"008eb9edda8070d2\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/time.js\":\"300eba83b3025653\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/toast.js\":\"845f5ef27ddabcd4\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/toggleStore.js\":\"59c95b22728740fc\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/untilStopped.js\":\"dc1eb0b02fbff2b4\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/userActivity.js\":\"339b3c89dd2bf9f5\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/viewTransition.js\":\"a0c652f02ac1bba3\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/viewport.js\":\"fae422b8ddcd9c62\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/webLock.js\":\"90b06013eadcc5b3\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/workspaceRecovery.js\":\"5e45b8f2febbc411\",\"/knowledge-medium/pr-preview/pr-1887/src/utils/workspaceSnapshotStore.js\":\"c2a4a4c85686c13c\",\"/knowledge-medium/pr-preview/pr-1887/src/vendor/react-compiler-runtime.js\":\"f27ed26fcd6de974\",\"/knowledge-medium/pr-preview/pr-1887/src/vendor/react-dom-client.js\":\"75bfc8bb973874c1\",\"/knowledge-medium/pr-preview/pr-1887/src/vendor/react-dom-server-edge.js\":\"dd21904141c41e9b\",\"/knowledge-medium/pr-preview/pr-1887/src/vendor/react-dom-server.js\":\"ab5260eac6b6b922\",\"/knowledge-medium/pr-preview/pr-1887/src/vendor/react-dom-static-edge.js\":\"e019b9cc0d18aee0\",\"/knowledge-medium/pr-preview/pr-1887/src/vendor/react-dom-static.js\":\"1adf22e98fa41e8c\",\"/knowledge-medium/pr-preview/pr-1887/src/vendor/react-dom-test-utils.js\":\"61f5a23898da3d79\",\"/knowledge-medium/pr-preview/pr-1887/src/vendor/react-dom.js\":\"4a00d128f3ad3f13\",\"/knowledge-medium/pr-preview/pr-1887/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1887/src/vendor/react-jsx-runtime.js\":\"52c2c4265c9fb0e0\",\"/knowledge-medium/pr-preview/pr-1887/src/vendor/react.js\":\"733f9817a11bb623\",\"/knowledge-medium/pr-preview/pr-1887/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1887/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1887/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
