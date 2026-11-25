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
		buildId: "cab835586ff7-361a7bd5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1888/\":\"5671b70e94515a35\",\"/knowledge-medium/pr-preview/pr-1888/index.html\":\"5671b70e94515a35\",\"/knowledge-medium/pr-preview/pr-1888/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1888/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1888/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1888/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1888/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1888/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1888/app.css\":\"6e3bd4a005b4bc56\",\"/knowledge-medium/pr-preview/pr-1888/assets/FacadeVFS-v3hofnCT.js\":\"f16ced331fe92af4\",\"/knowledge-medium/pr-preview/pr-1888/assets/OPFSCoopSyncVFS-D2VR6Q8D.js\":\"d25deacd185f2dd3\",\"/knowledge-medium/pr-preview/pr-1888/assets/OPFSWriteAheadVFS-NjNkkRm6.js\":\"99c1caf65834296b\",\"/knowledge-medium/pr-preview/pr-1888/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1888/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1888/assets/wa-sqlite-async-CLCfhVkJ.js\":\"d0585fbef5057ab2\",\"/knowledge-medium/pr-preview/pr-1888/assets/wa-sqlite-b_2Vynz-.js\":\"87a7565efa00cbed\",\"/knowledge-medium/pr-preview/pr-1888/assets/worker-U0KErDeB.js\":\"e4bbfad47039963b\",\"/knowledge-medium/pr-preview/pr-1888/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1888/chunks/app-Bp0aTqda.js\":\"fa5476a6f10fad94\",\"/knowledge-medium/pr-preview/pr-1888/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1888/index.js\":\"73c9a210e129eed5\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1888/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1888/assets/AccessHandlePoolVFS-CJjLlcGP.js\":\"4488bbd4d94f31d1\",\"/knowledge-medium/pr-preview/pr-1888/assets/IDBBatchAtomicVFS-D2PBgd0X.js\":\"b3e7fc59964bca56\",\"/knowledge-medium/pr-preview/pr-1888/assets/MemoryVFS-BbLyeMXg.js\":\"6c1992b5fda3cc11\",\"/knowledge-medium/pr-preview/pr-1888/assets/mc-wa-sqlite-Bl3TTTjN.js\":\"068314132bbc4d67\",\"/knowledge-medium/pr-preview/pr-1888/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1888/assets/mc-wa-sqlite-async-CxII14RO.js\":\"8f842326df97bbc5\",\"/knowledge-medium/pr-preview/pr-1888/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1888/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1888/chunks/AccessHandlePoolVFS-DPdjLdTG.js\":\"b105b4cfb084c5dc\",\"/knowledge-medium/pr-preview/pr-1888/chunks/FacadeVFS-B3_2hJ1l.js\":\"57c6e9ad62de4651\",\"/knowledge-medium/pr-preview/pr-1888/chunks/IDBBatchAtomicVFS-D7GbY8q4.js\":\"4d6411b231ada300\",\"/knowledge-medium/pr-preview/pr-1888/chunks/MemoryVFS-DYbzRxNH.js\":\"1e3a96d54d1abc0f\",\"/knowledge-medium/pr-preview/pr-1888/chunks/OPFSCoopSyncVFS-X9sUKojC.js\":\"88f6a7a60074531a\",\"/knowledge-medium/pr-preview/pr-1888/chunks/OPFSWriteAheadVFS-Dzpl0WAL.js\":\"d85b7def62091c0f\",\"/knowledge-medium/pr-preview/pr-1888/chunks/Preview-CGV1hNgm.js\":\"6ca3f98c3ec55910\",\"/knowledge-medium/pr-preview/pr-1888/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1888/chunks/card-Bxif3V4h.js\":\"b2d42db656b8ba1f\",\"/knowledge-medium/pr-preview/pr-1888/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1888/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1888/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1888/chunks/dist-CMAzUcmF.js\":\"f2b76a7085871d78\",\"/knowledge-medium/pr-preview/pr-1888/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1888/chunks/mc-wa-sqlite-RM63D4uB.js\":\"9934b19ad439182d\",\"/knowledge-medium/pr-preview/pr-1888/chunks/mc-wa-sqlite-async-DlM64AQj.js\":\"a478ca8f40e08f7d\",\"/knowledge-medium/pr-preview/pr-1888/chunks/react-2U4UUhNM.js\":\"e2e0ce251759e837\",\"/knowledge-medium/pr-preview/pr-1888/chunks/react-Av3511FT.js\":\"742542f7ed3387de\",\"/knowledge-medium/pr-preview/pr-1888/chunks/react-CPjbR0_P.js\":\"46a6c997e5ab29e9\",\"/knowledge-medium/pr-preview/pr-1888/chunks/react-CZPBL0BC.js\":\"ece74041c670a717\",\"/knowledge-medium/pr-preview/pr-1888/chunks/react-D8BWZGRp.js\":\"6e5291b18f9624ea\",\"/knowledge-medium/pr-preview/pr-1888/chunks/react-DdFuFqK-.js\":\"42f112d5806a9215\",\"/knowledge-medium/pr-preview/pr-1888/chunks/react-DmlhFYhi.js\":\"13fab676b1ce9fb1\",\"/knowledge-medium/pr-preview/pr-1888/chunks/react-UdiHGjlh.js\":\"147afa91773e2c48\",\"/knowledge-medium/pr-preview/pr-1888/chunks/react-dom-server-legacy.browser.production-CT5vMxkj.js\":\"11f5e05704173ef4\",\"/knowledge-medium/pr-preview/pr-1888/chunks/react-dom-server.browser.production-DW3cyAmU.js\":\"39b4e3c851183165\",\"/knowledge-medium/pr-preview/pr-1888/chunks/react-dom-server.edge.production-CMCsnTc2.js\":\"11159ada4e0df2d1\",\"/knowledge-medium/pr-preview/pr-1888/chunks/server.browser-DuSREWeL.js\":\"8dfa5b093bc81c24\",\"/knowledge-medium/pr-preview/pr-1888/chunks/textarea-DqLW0Se_.js\":\"b0d1e602703a3477\",\"/knowledge-medium/pr-preview/pr-1888/chunks/ui-Y-ZCfiN0.js\":\"e7e5954fd92f6040\",\"/knowledge-medium/pr-preview/pr-1888/chunks/wa-sqlite-BJshnkCi.js\":\"aa3cead0d005ae32\",\"/knowledge-medium/pr-preview/pr-1888/chunks/wa-sqlite-async-CxumAzHy.js\":\"6c90c0cc2a97ff03\",\"/knowledge-medium/pr-preview/pr-1888/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1888/extension-utilities.css\":\"d939c4575e1c3411\",\"/knowledge-medium/pr-preview/pr-1888/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1888/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1888/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1888/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1888/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1888/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1888/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1888/src/App.js\":\"d0c4125d3af77d44\",\"/knowledge-medium/pr-preview/pr-1888/src/appUpdate.js\":\"27b22013bf7fbd5d\",\"/knowledge-medium/pr-preview/pr-1888/src/appVersion.js\":\"3ff9ac00dc200a20\",\"/knowledge-medium/pr-preview/pr-1888/src/bootstrap/initialLayout.js\":\"2963e7af0f60ec9c\",\"/knowledge-medium/pr-preview/pr-1888/src/bootstrap/openWorkspaceData.js\":\"c17937c54a146d97\",\"/knowledge-medium/pr-preview/pr-1888/src/bootstrap/resolveWorkspace.js\":\"c73cce62825c640f\",\"/knowledge-medium/pr-preview/pr-1888/src/bootstrap/workspaceBootstrap.js\":\"33ca47c2f8bfbc13\",\"/knowledge-medium/pr-preview/pr-1888/src/components/BlockComponent.js\":\"59db8b403b88dbeb\",\"/knowledge-medium/pr-preview/pr-1888/src/components/BlockCrumbs.js\":\"7cebcdbae71065b2\",\"/knowledge-medium/pr-preview/pr-1888/src/components/BlockEditor.js\":\"e1349575259ace1d\",\"/knowledge-medium/pr-preview/pr-1888/src/components/BlockLoadingPlaceholder.js\":\"4ce6f88c0de773d6\",\"/knowledge-medium/pr-preview/pr-1888/src/components/BlockProperties.js\":\"0f14385eb7342ab6\",\"/knowledge-medium/pr-preview/pr-1888/src/components/BlockSearchPicker.js\":\"88764ac55811d6dd\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ConfirmBulkDeleteDialog.js\":\"7f118729093764bd\",\"/knowledge-medium/pr-preview/pr-1888/src/components/DividerHandle.js\":\"107701e897b6bd28\",\"/knowledge-medium/pr-preview/pr-1888/src/components/DraftEditor.js\":\"0fd85c4906c7f83b\",\"/knowledge-medium/pr-preview/pr-1888/src/components/GutterPill.js\":\"b48840e3da77604e\",\"/knowledge-medium/pr-preview/pr-1888/src/components/Header.js\":\"12512b45981536f8\",\"/knowledge-medium/pr-preview/pr-1888/src/components/LazyBlockComponent.js\":\"1a99dccdd3c2a047\",\"/knowledge-medium/pr-preview/pr-1888/src/components/Login.js\":\"13d9b9619c9e0332\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ZoomableSurface.js\":\"403c003e4aea36ee\",\"/knowledge-medium/pr-preview/pr-1888/src/components/editModeKeepalive.js\":\"167c584583512002\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyDisplay/PropertyDisplayScope.js\":\"8be6045ed7239279\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1707c86e5b80733c\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyEditors/RefPropertyEditor.js\":\"53ac65031171f2b8\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyEditors/RefTargetTypePicker.js\":\"a3d5f54f766097fe\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyEditors/SelectPropertyEditor.js\":\"7f9b1fcb76220060\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyEditors/TypesPropertyEditor.js\":\"8193f4d4d7d012e7\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyEditors/defaults.js\":\"3f63cc48d9e0ab3b\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyEditors/kernelValuePresets.js\":\"c2c15ce90f13b4f1\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyEditors/selectablePresets.js\":\"a016e5beb1bfe1a4\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyEditors/typesPropertyUi.js\":\"c8a401bf92e2ffd8\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyPanel/AddPropertyForm.js\":\"d92bfc450b758e83\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyPanel/PropertyPicker.js\":\"6b6e9b94b50d59b2\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyPanel/PropertyRow.js\":\"e6344aa7eb54107d\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyPanel/Rows.js\":\"d57e391128e3aa46\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyPanel/actions.js\":\"77148554cd1ae6f0\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyPanel/declarationOnly.js\":\"d43a7e94f44acf8d\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyPanel/layout.js\":\"d8e333c60fcf9ed7\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyPanel/model.js\":\"ef4bfd901e2cc70b\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyPanel/shapeUi.js\":\"f00d9667e5a3393e\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyPanel/shapes.js\":\"547b44b6d754d027\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyPanel/usePropertyEditingActivation.js\":\"3c40c1d70d8778c7\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyPanel/visibility.js\":\"7aa32becdf5d4122\",\"/knowledge-medium/pr-preview/pr-1888/src/components/propertyPanelSections.js\":\"3cd4849753111959\",\"/knowledge-medium/pr-preview/pr-1888/src/components/references/BlockEmbed.js\":\"99abace09c23b68e\",\"/knowledge-medium/pr-preview/pr-1888/src/components/references/BlockLink.js\":\"b25b3c208e8d66b6\",\"/knowledge-medium/pr-preview/pr-1888/src/components/references/BlockRef.js\":\"cb3c3a366fed6fe5\",\"/knowledge-medium/pr-preview/pr-1888/src/components/references/ReferenceLink.js\":\"f120187aa84d908d\",\"/knowledge-medium/pr-preview/pr-1888/src/components/references/cycleGuard.js\":\"787643dd539c14da\",\"/knowledge-medium/pr-preview/pr-1888/src/components/references/cycleGuardContext.js\":\"9a659cf7e9b717b4\",\"/knowledge-medium/pr-preview/pr-1888/src/components/references/linkInteraction.js\":\"977d9e36d5fe5967\",\"/knowledge-medium/pr-preview/pr-1888/src/components/references/referenceLayout.js\":\"a1c4f24de61f0a97\",\"/knowledge-medium/pr-preview/pr-1888/src/components/references/useBlockRefAncestors.js\":\"9b8816eff32f19af\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/BlockGutter.js\":\"c9df287c5e4a9b36\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/BlockInfoDialog.js\":\"dc2aa755420a3150\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/BlockReadText.js\":\"ce5a0d38b0028f02\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/BlockTypeBlockRenderer.js\":\"3bfa089c0d62bfde\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/BulletHoverCard.js\":\"a5dd699d7344a317\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/CodeMirrorContentRenderer.js\":\"f656dc64165da6bc\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"fb293abf117c6151\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/ColumnResizeHandles.js\":\"7363d49fe564dd1c\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a518bc723e82a62e\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/DefaultBlockRenderer.js\":\"79c1d3b4ffd36cb3\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/LayoutRenderer.js\":\"5337ba34fb94b819\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/MarkdownContentRenderer.js\":\"b55f9b429aade8a5\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/MissingDataRenderer.js\":\"03fef7ccf0423cc2\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/PanelRenderer.js\":\"2747497e14bf619b\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/PropertySchemaBlockRenderer.js\":\"3006387cabcc393e\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/TopLevelRenderer.js\":\"52fa4f2102948157\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/blockGutterMode.js\":\"8fa51033bea69111\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/blockTitleText.js\":\"08cc6e1136a63db6\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/fieldCreationKeydown.js\":\"872a2e9b63bb2056\",\"/knowledge-medium/pr-preview/pr-1888/src/components/renderer/layoutRootContext.js\":\"e8e31457399dcda4\",\"/knowledge-medium/pr-preview/pr-1888/src/components/typeChip/TypeChip.js\":\"675f474e81f7812e\",\"/knowledge-medium/pr-preview/pr-1888/src/components/typeChip/chipStyle.js\":\"b1d2c19fd2834ac0\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/anchored-floating.js\":\"c6740922b15cd0ab\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/button.js\":\"6495769cb3c4bdcd\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/card.js\":\"b71a34407ac43d58\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/checkbox.js\":\"79ed2a8620b45c67\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/collapsible.js\":\"271ed271e99021a5\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/command.js\":\"ee764f92bb1a1ac3\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/context-menu.js\":\"70971bd202bad8ea\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/dialog.js\":\"4c3c0f38b1cc3ae5\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/dropdown-menu.js\":\"a7b392aaff1aa61c\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/floating-listbox.js\":\"c93c707e5251fd13\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/index.js\":\"b9c11ca3b1ebdab5\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/input.js\":\"0f9a1db59b9508ae\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/kbd.js\":\"ba1c332be7b7ad28\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/label.js\":\"029a00f905e4f0f3\",\"/knowledge-medium/pr-preview/pr-1888/src/components/ui/textarea.js\":\"5b282d970b4fdc44\",\"/knowledge-medium/pr-preview/pr-1888/src/components/useEditModeYieldKeepalive.js\":\"1b4d2ea79c3c1cba\",\"/knowledge-medium/pr-preview/pr-1888/src/components/util/BootFallback.js\":\"52c98efd40e2660c\",\"/knowledge-medium/pr-preview/pr-1888/src/components/util/FocusedRowLazyMount.js\":\"e774ed40fdc30240\",\"/knowledge-medium/pr-preview/pr-1888/src/components/util/LazyViewportMount.js\":\"d1f39749a702e26c\",\"/knowledge-medium/pr-preview/pr-1888/src/components/util/LocalDbCorruptionFallback.js\":\"af33e0d10bad10b6\",\"/knowledge-medium/pr-preview/pr-1888/src/components/util/error.js\":\"913c30aba79481e2\",\"/knowledge-medium/pr-preview/pr-1888/src/components/util/lazyMountRegistry.js\":\"07985fe4ade0859e\",\"/knowledge-medium/pr-preview/pr-1888/src/components/util/suspense.js\":\"430b61a26ac7145a\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/CreateWorkspaceDialog.js\":\"53b4aa532db4bf17\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/PendingInvitations.js\":\"f515cdcc3e0143b1\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/SyncProgress.js\":\"495a60127fdcc2f6\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/UnlockProgress.js\":\"cd3d26f616ab33fc\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/WorkspaceKeyGate.js\":\"ce0cfb1dace1f9ec\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/WorkspaceSettingsDialog.js\":\"906976170db2ea3a\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/WorkspaceSwitcher.js\":\"e8483bc6e453a02c\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/WorkspaceSyncGate.js\":\"8648cfa596fddde9\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/conversion/ConversionFlow.js\":\"ee95441fd7993178\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/conversion/ConversionFlowHost.js\":\"47dd7455f365d1a0\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/conversion/EncryptionSection.js\":\"b68f8fd36b34a52c\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/conversion/attachmentPrompts.js\":\"bf90fd57e4a98513\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/conversion/bundleFolderPrompts.js\":\"5f5f43ff99aea073\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/conversion/conversionFlowDeps.js\":\"055f78b73555d287\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/conversion/conversionFlowStore.js\":\"8169a07a356bacc7\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/conversion/flowUi.js\":\"bb3deb3fb95966e4\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/conversion/useConversionRun.js\":\"a3b9722d6eb0f07e\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/keyUi.js\":\"d07ea2ce6d5654c1\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/useCloseOnKeyLoss.js\":\"c1d323d3d9721989\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/useCloseOnServerE2ee.js\":\"de7946a3c256cba3\",\"/knowledge-medium/pr-preview/pr-1888/src/components/workspace/workspaceUnlocked.js\":\"751e015ab8186bdd\",\"/knowledge-medium/pr-preview/pr-1888/src/context/backgroundSubtree.js\":\"960ccf8e1d262ab6\",\"/knowledge-medium/pr-preview/pr-1888/src/context/block.js\":\"682054ed630bcd4c\",\"/knowledge-medium/pr-preview/pr-1888/src/context/layoutWsContext.js\":\"36fa712d98961b67\",\"/knowledge-medium/pr-preview/pr-1888/src/context/propertyDisplay.js\":\"68e2fffd09b3921d\",\"/knowledge-medium/pr-preview/pr-1888/src/context/repo.js\":\"6d87c3671101afc2\",\"/knowledge-medium/pr-preview/pr-1888/src/data/aliasClaim.js\":\"d6cc86ae9667544b\",\"/knowledge-medium/pr-preview/pr-1888/src/data/aliasSeatNamespace.js\":\"10a73c997e82d47a\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/blockData.js\":\"f5c163c44f8edf35\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/blockType.js\":\"d995788d28a8fa2c\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/changeScope.js\":\"6c4221889a002503\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/codecs.js\":\"9a98148ae9987c1e\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/derivedData.js\":\"db218e3f724394c9\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/errors.js\":\"c78c58e42a4c8722\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/events.js\":\"f58d3b817cc82ba3\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/handle.js\":\"4d910b07c56421b8\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/index.js\":\"7d789dca936fd00b\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/mutator.js\":\"7bc8993c987f1af4\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/processor.js\":\"09f4ff2f344034cf\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/propertySchema.js\":\"3557192d686cd9cb\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/query.js\":\"8ca321315a00973d\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/sameTxProcessor.js\":\"97fc68c1e1f95ca8\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/schema.js\":\"4d910b07c56421b8\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/tx.js\":\"4d910b07c56421b8\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/typedBlockQuery.js\":\"85412b8a1f6e6e26\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/user.js\":\"bb184342a2c5a8b9\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/valuePresetCore.js\":\"d83092bc31a9d4d0\",\"/knowledge-medium/pr-preview/pr-1888/src/data/api/valuePresets.js\":\"5ac983c24df639ca\",\"/knowledge-medium/pr-preview/pr-1888/src/data/attachmentCleanerIOVerb.js\":\"559e872c200981e6\",\"/knowledge-medium/pr-preview/pr-1888/src/data/block.js\":\"f15abe2b78e94ccf\",\"/knowledge-medium/pr-preview/pr-1888/src/data/blockCache.js\":\"53fe7aaffc35b541\",\"/knowledge-medium/pr-preview/pr-1888/src/data/blockId.js\":\"48ffef2366d65aa2\",\"/knowledge-medium/pr-preview/pr-1888/src/data/blockLiveness.js\":\"0fd684b925ba5cb5\",\"/knowledge-medium/pr-preview/pr-1888/src/data/blockMerge.js\":\"a6502a951a8178b0\",\"/knowledge-medium/pr-preview/pr-1888/src/data/blockSchema.js\":\"3d888ba02df73d0f\",\"/knowledge-medium/pr-preview/pr-1888/src/data/blockTypeLookup.js\":\"39a2c2ce094c37bf\",\"/knowledge-medium/pr-preview/pr-1888/src/data/blockTypes.js\":\"a5374e430bba3a8f\",\"/knowledge-medium/pr-preview/pr-1888/src/data/childrenView.js\":\"6ed4315fd5681518\",\"/knowledge-medium/pr-preview/pr-1888/src/data/clientContext.js\":\"2aa4222291e2a852\",\"/knowledge-medium/pr-preview/pr-1888/src/data/dbFileSiblings.js\":\"0b45451d6247b9ac\",\"/knowledge-medium/pr-preview/pr-1888/src/data/definitionSeeds.js\":\"bbe947d07f3a32bb\",\"/knowledge-medium/pr-preview/pr-1888/src/data/derivedIds.js\":\"54874662500fd0a1\",\"/knowledge-medium/pr-preview/pr-1888/src/data/drawnSubtree.js\":\"38c99e1c3a938afd\",\"/knowledge-medium/pr-preview/pr-1888/src/data/facetBridge.js\":\"32e243d42c0dee37\",\"/knowledge-medium/pr-preview/pr-1888/src/data/facets.js\":\"5510489f73c3fc8b\",\"/knowledge-medium/pr-preview/pr-1888/src/data/globalState.js\":\"d550dab0ae169dd8\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/aliasClaimRederiveProcessor.js\":\"8252d06c17b10dd6\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/ancestorBatch.js\":\"bf77e5b1a03eaf53\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/blockTypeTypeifyProcessor.js\":\"ca58813497bf34ef\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/clientSchema.js\":\"79690d2f9e4ff573\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/commitPipeline.js\":\"7096ae9e8971ea14\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/devAssertions.js\":\"6923d1f00ebd615e\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/firstSync.js\":\"05c1b5215ab14ec5\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/freshInitialLoad.js\":\"b4342a97c14b21a7\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/graphBackfillClaim.js\":\"d15420219b13ed1f\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/handleStore.js\":\"cb4358d4da8a35ca\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/idleMarkerJobs.js\":\"665043e606dd85c7\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/initialDownload.js\":\"54abcadd0c7d4d01\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/initializeClientDatabase.js\":\"6020158c7c4d17f9\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/jsonCanonical.js\":\"182406839b519c05\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/kernelInvalidation.js\":\"eb444504946bea70\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/kernelProcessors.js\":\"14571a44a2e7d396\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/kernelQueries.js\":\"05846a4ee3b373c0\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/mergeTypeMembershipProcessor.js\":\"9aac24303689572c\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/normalizeReferencesProcessor.js\":\"14cee20a47f00b8e\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/poolInstrumentation.js\":\"9f212cf060457ee1\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/processorRunner.js\":\"d7018eb0562d24ad\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/propertyCellBackfill.js\":\"edf3ba3664ecb196\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/propertyChildMint.js\":\"9939331f260b0c7c\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/propertyChildrenProcessor.js\":\"ba5d1e02c3e7809e\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/propertyDefinitionChangeProcessor.js\":\"aacbf7ad4a3b8e89\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/propertyDefinitionSynthesis.js\":\"bd056eef8855a401\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/propertyKeyScan.js\":\"055d83d3502c7868\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/propertySchemaResolution.js\":\"ca4a1a4cc598b218\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/propertyValueEdits.js\":\"b70766f4079a6127\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/raiseProtocol.js\":\"8365baa2538c2cd2\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/readBatch.js\":\"12634bf70111006e\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/refProjection.js\":\"683ed528b5412a46\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/referenceTargetLookups.js\":\"d82fcd291d1ac199\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/referenceTargetProcessor.js\":\"60b49598d5d362b8\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/replayMerge.js\":\"45893f7a410ee5a1\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/sqlBinds.js\":\"1053701651585fb7\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"9f91c282f2ad1b05\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/syncObserver/arrivalProcessors.js\":\"fcabd45ae630147d\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/syncObserver/invalidate.js\":\"82eeef9c60fb7211\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/syncObserver/materialize.js\":\"e68b7a5bb1bb52f2\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/syncObserver/observer.js\":\"4726cc894847fd0a\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/syncObserver/reconcile.js\":\"6b35a41eb323bd63\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/timingMetrics.js\":\"fc7a2b47ac61829f\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/treeQueries.js\":\"fab3b99de1d7f6dd\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/txEngine.js\":\"e35739ae1694e3a1\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/txSnapshots.js\":\"7ded2a22ba154584\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/typedBlockQuery.js\":\"2977ad271ff2b545\",\"/knowledge-medium/pr-preview/pr-1888/src/data/internals/undoManager.js\":\"bf11b165f9e7dc9e\",\"/knowledge-medium/pr-preview/pr-1888/src/data/invalidation.js\":\"3cafc28fe56795e7\",\"/knowledge-medium/pr-preview/pr-1888/src/data/kernelDataExtension.js\":\"91d9d7bbf71cffc9\",\"/knowledge-medium/pr-preview/pr-1888/src/data/kernelPage.js\":\"bed5f16fcf289d05\",\"/knowledge-medium/pr-preview/pr-1888/src/data/kernelValuePresetCores.js\":\"56852a210f1f41d7\",\"/knowledge-medium/pr-preview/pr-1888/src/data/localDbCorruptionSignal.js\":\"0746361ea595ab45\",\"/knowledge-medium/pr-preview/pr-1888/src/data/localDbStorage.js\":\"79c27e3a82afa4ae\",\"/knowledge-medium/pr-preview/pr-1888/src/data/localDbVfs.js\":\"c69b76b8be382004\",\"/knowledge-medium/pr-preview/pr-1888/src/data/localSchema.js\":\"63731a73a8f87e47\",\"/knowledge-medium/pr-preview/pr-1888/src/data/maintenance.js\":\"089e062754a01dcb\",\"/knowledge-medium/pr-preview/pr-1888/src/data/mergeProperties.js\":\"d45381dfd358e51f\",\"/knowledge-medium/pr-preview/pr-1888/src/data/metricsConsoleHook.js\":\"16a55f75be084a7c\",\"/knowledge-medium/pr-preview/pr-1888/src/data/migrationsPage.js\":\"5062bac6377d93f2\",\"/knowledge-medium/pr-preview/pr-1888/src/data/mutators.js\":\"05b676206b54c4c9\",\"/knowledge-medium/pr-preview/pr-1888/src/data/orderKey.js\":\"5d2105ba3dd96e68\",\"/knowledge-medium/pr-preview/pr-1888/src/data/orderKeyPlacement.js\":\"a2823c2a25130b6d\",\"/knowledge-medium/pr-preview/pr-1888/src/data/outlineSurface.js\":\"29ec4e354908bf88\",\"/knowledge-medium/pr-preview/pr-1888/src/data/pendingEditorContent.js\":\"40387b2fe71eacc0\",\"/knowledge-medium/pr-preview/pr-1888/src/data/pendingUploadsSql.js\":\"ff288cc2df4b06d7\",\"/knowledge-medium/pr-preview/pr-1888/src/data/pluginStateExtensions.js\":\"c8674029a3b4f840\",\"/knowledge-medium/pr-preview/pr-1888/src/data/powerSyncLogger.js\":\"c3cc025574ab33e8\",\"/knowledge-medium/pr-preview/pr-1888/src/data/projectorRuntime.js\":\"b8ac25fb3bc790d1\",\"/knowledge-medium/pr-preview/pr-1888/src/data/properties.js\":\"9c909c7553ec05e2\",\"/knowledge-medium/pr-preview/pr-1888/src/data/propertiesPage.js\":\"7518732bf74a49a3\",\"/knowledge-medium/pr-preview/pr-1888/src/data/propertyChildren.js\":\"2ec514c280592fa0\",\"/knowledge-medium/pr-preview/pr-1888/src/data/propertyDefinitionFanout.js\":\"b4dd36f9134781c4\",\"/knowledge-medium/pr-preview/pr-1888/src/data/propertyDefinitionMetadata.js\":\"2ec851e36064270f\",\"/knowledge-medium/pr-preview/pr-1888/src/data/propertyDefinitionRegistry.js\":\"568cde5ed2314917\",\"/knowledge-medium/pr-preview/pr-1888/src/data/propertyDisplayMode.js\":\"5985f8b271ac1848\",\"/knowledge-medium/pr-preview/pr-1888/src/data/propertyRowCreation.js\":\"cf3b91394c4997b6\",\"/knowledge-medium/pr-preview/pr-1888/src/data/propertySchemaCreation.js\":\"2d999b15a6f456c4\",\"/knowledge-medium/pr-preview/pr-1888/src/data/propertySeeds.js\":\"d9048082024008b5\",\"/knowledge-medium/pr-preview/pr-1888/src/data/recentsPage.js\":\"2fe049b16057db0a\",\"/knowledge-medium/pr-preview/pr-1888/src/data/refTargetComparableProperty.js\":\"4a25f6b9a4d838c4\",\"/knowledge-medium/pr-preview/pr-1888/src/data/referenceBlock.js\":\"c3429e245a17f6f5\",\"/knowledge-medium/pr-preview/pr-1888/src/data/rejectedUploads.js\":\"12bb70d5e2f4a4cd\",\"/knowledge-medium/pr-preview/pr-1888/src/data/releasePowerSyncConnection.js\":\"3b9316444eef6ca9\",\"/knowledge-medium/pr-preview/pr-1888/src/data/repo.js\":\"897bcf3a7f27646c\",\"/knowledge-medium/pr-preview/pr-1888/src/data/repoProvider.js\":\"c5206ab8ea331625\",\"/knowledge-medium/pr-preview/pr-1888/src/data/rowProperty.js\":\"0d4c7cd92db2ad07\",\"/knowledge-medium/pr-preview/pr-1888/src/data/searchFilter.js\":\"e393988720b9efcc\",\"/knowledge-medium/pr-preview/pr-1888/src/data/seedIdentityLedger.js\":\"5e1b4093e70f3f66\",\"/knowledge-medium/pr-preview/pr-1888/src/data/stateBlocks.js\":\"add6571898b4d234\",\"/knowledge-medium/pr-preview/pr-1888/src/data/structuralEditPolicy.js\":\"08cf23552440dfe2\",\"/knowledge-medium/pr-preview/pr-1888/src/data/structuralInsert.js\":\"abd4c33cd26f824b\",\"/knowledge-medium/pr-preview/pr-1888/src/data/subtreeDelete.js\":\"8e87dc9e95b946ca\",\"/knowledge-medium/pr-preview/pr-1888/src/data/syncStreamLock.js\":\"d2b7c34af31e09b0\",\"/knowledge-medium/pr-preview/pr-1888/src/data/syncedTableSqlRecognizer.js\":\"5025c62a2197c4ab\",\"/knowledge-medium/pr-preview/pr-1888/src/data/syncedTableWriteGuard.js\":\"6985442dcc18565a\",\"/knowledge-medium/pr-preview/pr-1888/src/data/targets.js\":\"1777d0d0c892242a\",\"/knowledge-medium/pr-preview/pr-1888/src/data/typeColors.js\":\"e4a0c81a9d3bc043\",\"/knowledge-medium/pr-preview/pr-1888/src/data/typeDefinitionMetadata.js\":\"b5b72e30977137ec\",\"/knowledge-medium/pr-preview/pr-1888/src/data/typeDefinitionRegistry.js\":\"b2e37a482fa8889e\",\"/knowledge-medium/pr-preview/pr-1888/src/data/typeExtraction.js\":\"3a2930317097c847\",\"/knowledge-medium/pr-preview/pr-1888/src/data/typeInitialValues.js\":\"64b2332c0772cbf2\",\"/knowledge-medium/pr-preview/pr-1888/src/data/typePropertyGroups.js\":\"6cf42fff29861530\",\"/knowledge-medium/pr-preview/pr-1888/src/data/typeSeeds.js\":\"1be50d197d6a98df\",\"/knowledge-medium/pr-preview/pr-1888/src/data/typeTagger.js\":\"7ec84109dc145a3a\",\"/knowledge-medium/pr-preview/pr-1888/src/data/typedRecords.js\":\"b882ee3d2a10ab6f\",\"/knowledge-medium/pr-preview/pr-1888/src/data/typesPage.js\":\"933fffb5793fba80\",\"/knowledge-medium/pr-preview/pr-1888/src/data/userPrefs.js\":\"24fd360153832684\",\"/knowledge-medium/pr-preview/pr-1888/src/data/userSchemasService.js\":\"eb472cbde55b6cb3\",\"/knowledge-medium/pr-preview/pr-1888/src/data/userTypesService.js\":\"c63b1700564209fd\",\"/knowledge-medium/pr-preview/pr-1888/src/data/valuePresetRegistry.js\":\"16df94871a8f01d4\",\"/knowledge-medium/pr-preview/pr-1888/src/data/visibleChildren.js\":\"8655bcaa1781358b\",\"/knowledge-medium/pr-preview/pr-1888/src/data/workspaceConversion.js\":\"298a87165c701f9e\",\"/knowledge-medium/pr-preview/pr-1888/src/data/workspaceFirstSync.js\":\"87fc08891b4ecac9\",\"/knowledge-medium/pr-preview/pr-1888/src/data/workspaceIdNamespace.js\":\"8786333608c0e43a\",\"/knowledge-medium/pr-preview/pr-1888/src/data/workspaceSchema.js\":\"a41116169f9d0f8f\",\"/knowledge-medium/pr-preview/pr-1888/src/data/workspaces.js\":\"ec1c9acfb5bd5405\",\"/knowledge-medium/pr-preview/pr-1888/src/data/writeAheadLog.js\":\"22908f68db48cb4f\",\"/knowledge-medium/pr-preview/pr-1888/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1888/src/editor/BlockPasteShellDecorator.js\":\"51321c9db7e74bcd\",\"/knowledge-medium/pr-preview/pr-1888/src/editor/atTrigger.js\":\"eeea4dbd00337212\",\"/knowledge-medium/pr-preview/pr-1888/src/editor/autocomplete.js\":\"f10b12a7b1920117\",\"/knowledge-medium/pr-preview/pr-1888/src/editor/codeMirrorExtensions.js\":\"1fa959d85514a2b1\",\"/knowledge-medium/pr-preview/pr-1888/src/editor/contentFlush.js\":\"2ff8acdb0539a40f\",\"/knowledge-medium/pr-preview/pr-1888/src/editor/defaultInteractions.js\":\"fe9da5a685e69694\",\"/knowledge-medium/pr-preview/pr-1888/src/editor/editSettleSignal.js\":\"5da734ba7f60b83b\",\"/knowledge-medium/pr-preview/pr-1888/src/editor/insertImage.js\":\"178c1728c18ab17c\",\"/knowledge-medium/pr-preview/pr-1888/src/editor/referenceCompletionRange.js\":\"614aaf616ee6a849\",\"/knowledge-medium/pr-preview/pr-1888/src/editor/referenceTargetTypes.js\":\"032f191530f810ee\",\"/knowledge-medium/pr-preview/pr-1888/src/editor/syntaxContext.js\":\"b6b61b72f02304ac\",\"/knowledge-medium/pr-preview/pr-1888/src/editor/triggerMatch.js\":\"436db9f8e9d7bc5f\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/AppRuntimeProvider.js\":\"7fc25e68d0b623fa\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/BlockFocusShellDecorator.js\":\"0f048bb850c5c626\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/ExtensionRenderBoundary.js\":\"97fff9598351c3aa\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/PanelContentRecovery.js\":\"01209008e7c06b22\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/apiCatalog.js\":\"9e2654362850e678\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/approveExtensionHere.js\":\"80473fcd146a3c4d\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/armedCutAppMount.js\":\"3ad1a1cbd5287561\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/batchableKeyedStore.js\":\"d4fce44ce96a66af\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/blockInteraction.js\":\"13e09d0c7420dbff\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/blockSelectionAction.js\":\"3dd46961cc7348ef\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/compileExtensionModule.js\":\"46c42bf5dd9d9963\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/compiledModuleCache.js\":\"84522358bac9eae4\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/continuousGestures.js\":\"233eb62b6fd01452\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/core.js\":\"4e90328bba5f817e\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/defaultRenderers.js\":\"282a64b425a639bc\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/definitionFanoutAppMount.js\":\"189595ca22287e21\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/dialogAppMount.js\":\"9f52a0a3ff16c9cd\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/dynamicExtensionSeeds.js\":\"96cbc257820a9fbc\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/dynamicExtensions.js\":\"dce254f27bfa4ca5\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/exampleExtensions.js\":\"c2ca0e8b6af4c82e\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/extensionApprovalStatus.js\":\"440ce163716e5904\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/extensionLoadErrorToast.js\":\"866a8eb63016b938\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/extensionLoadErrors.js\":\"d3edb00be29bb951\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/extensionLookup.js\":\"7a6a2a1f3d832271\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/extensionToggles.js\":\"dacdcb64734e2680\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/extensionUtilitiesCss.js\":\"cd5d4c015a65f30f\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/kernelPageDeletionGuard.js\":\"dd9af6401f47e33a\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/liveRuntime.js\":\"32620c3bb1532e6a\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/openExtensionsSettings.js\":\"1b33f6950429a289\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/overridesCache.js\":\"73c83aceba92d5d4\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/pluginIds.js\":\"d155a07f4008b5ed\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/processorRejectionToast.js\":\"9c21844bb25c7fda\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/runtimeActions.js\":\"02d8c0360d5d4750\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/runtimeContext.js\":\"2f245a1121ea6df5\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/staticAppExtensions.js\":\"5e69648fc9fd5469\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/staticDataExtensions.js\":\"69f245fee7353a47\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/toastAppMount.js\":\"185dea0bf47d7367\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/useOverrides.js\":\"dd13346c5a8707c6\",\"/knowledge-medium/pr-preview/pr-1888/src/extensions/useShortcutSurfaceActivations.js\":\"b6199e21de5f678a\",\"/knowledge-medium/pr-preview/pr-1888/src/facets/discoverToggleTree.js\":\"b7cef185070b36f5\",\"/knowledge-medium/pr-preview/pr-1888/src/facets/facet.js\":\"0b4e102ada5a72bb\",\"/knowledge-medium/pr-preview/pr-1888/src/facets/resolveAppRuntime.js\":\"ef433c47bbbcd69b\",\"/knowledge-medium/pr-preview/pr-1888/src/facets/runtimeEvents.js\":\"af4ac359ab768a11\",\"/knowledge-medium/pr-preview/pr-1888/src/facets/togglable.js\":\"d8be4227584356ef\",\"/knowledge-medium/pr-preview/pr-1888/src/facets/variantFacet.js\":\"427b07d96792e576\",\"/knowledge-medium/pr-preview/pr-1888/src/facets/verbFacet.js\":\"1c5d4f551bc023ae\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/block.js\":\"a1550fca23bb2521\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/focusedChild.js\":\"0df077064231e283\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/propertySchemas.js\":\"cf08c2d2303e2d81\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/typeRegistry.js\":\"5baa4adb382113fd\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/useAncestorCrumbs.js\":\"736b42c66ad03371\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/useAutocompleteListbox.js\":\"ac9a3a51fd84611c\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/useDebouncedSearch.js\":\"33a57fedccdb9793\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/useDebouncedValue.js\":\"48d91286f183de0d\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/useFacetValue.js\":\"fd128770a650ad07\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/useIsFocalRender.js\":\"0df6765a77cf0267\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/useIsReadOnly.js\":\"f8232193135b7fc9\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/useMaterializeBacklog.js\":\"f0302237a0e57ada\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/useMinuteClock.js\":\"ea5534068b9867eb\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/usePanelLayoutProjection.js\":\"1d41270bc2ba406f\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/usePendingInvitations.js\":\"3c5dd48aed669346\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/useRendererRegistry.js\":\"07c4eb9974b8397d\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/useRetainedFieldRows.js\":\"0674f4c7ffd75949\",\"/knowledge-medium/pr-preview/pr-1888/src/hooks/useWorkspaces.js\":\"260f04bababd295f\",\"/knowledge-medium/pr-preview/pr-1888/src/lib/utils.js\":\"58fd56203f7e691c\",\"/knowledge-medium/pr-preview/pr-1888/src/main.js\":\"d926e3eb979298e6\",\"/knowledge-medium/pr-preview/pr-1888/src/markdown/MarkdownImage.js\":\"252c34779d8eaf40\",\"/knowledge-medium/pr-preview/pr-1888/src/markdown/blockSeparators.js\":\"1ed440400d0f96e0\",\"/knowledge-medium/pr-preview/pr-1888/src/markdown/context.js\":\"23bec373ccaedf0a\",\"/knowledge-medium/pr-preview/pr-1888/src/markdown/defaultMarkdownExtension.js\":\"3e80d16a5ec24efc\",\"/knowledge-medium/pr-preview/pr-1888/src/markdown/extensions.js\":\"0588b52a7875c0c0\",\"/knowledge-medium/pr-preview/pr-1888/src/markdown/renderMarkdownHtml.js\":\"7272c9657dbd9bff\",\"/knowledge-medium/pr-preview/pr-1888/src/minimal-editor.js\":\"26d62592ffcf5d96\",\"/knowledge-medium/pr-preview/pr-1888/src/paste/armedCut.js\":\"621abcc8cd5e4bb6\",\"/knowledge-medium/pr-preview/pr-1888/src/paste/captureMediaVerb.js\":\"cc2c6b7973f5d011\",\"/knowledge-medium/pr-preview/pr-1888/src/paste/clipboard.js\":\"0d304243e09a2bbc\",\"/knowledge-medium/pr-preview/pr-1888/src/paste/decision.js\":\"85f1ae301ee952e3\",\"/knowledge-medium/pr-preview/pr-1888/src/paste/operations.js\":\"d463114269c367fa\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/account-header/AccountHeaderItem.js\":\"5a30b72036eb4748\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/account-header/index.js\":\"0a5b8b2112ec2125\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5215de051a4e2324\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-dispatch-companion/askAgent.js\":\"2cd36455cd779e21\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-dispatch-companion/askedStore.js\":\"429ba10a2da30c96\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5ee4c626f8969107\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-dispatch-companion/chipState.js\":\"b61f41ae50657acd\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ddc74f05b2c41bcc\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-dispatch-companion/index.js\":\"c1ad6b86007e19ec\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"0a02b21d2632bb09\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-dispatch-companion/schema.js\":\"078c392822c8494f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1a606d4df49fe34b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6c27d22b5ba406ec\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/addMedia.js\":\"28ba1f7ec81851a5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentViews/backlinks.js\":\"56a8b3eab551761e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentViews/block.js\":\"6700742f9675a19c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentViews/context.js\":\"86f766dbf1f63f0e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e6b433798d98e9a8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentViews/index.js\":\"bdd8531c85b9f9ef\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentViews/outline.js\":\"4e3d043faa039cfc\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentViews/properties.js\":\"e13af11b66245041\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentViews/refs.js\":\"603e49d62a9863e3\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"743b996efdb6cdb7\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentViews/search.js\":\"09143563c82fe768\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentViews/shared.js\":\"344865e3f2f3570c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ea9c5df8374de873\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentViews/text.js\":\"3caf7ba501c8b28d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/agentWrites.js\":\"3f2f6c0f0fa6c54c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/authoringCatalog.js\":\"93cf62f85e0414fc\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/blockRefTargets.js\":\"d1a947cb02963220\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/bridge.js\":\"cb8ad8cd42c83445\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/bridgeLoop.js\":\"cb35c58d0df95972\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/changeHistory.js\":\"24c18e5740c35ea5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/commands.js\":\"2dd425393069ea80\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/commentsCommands.js\":\"66f88b1c0a9246ef\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/dataExtension.js\":\"88451056d1d786e9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/dataModelGuide.js\":\"079236413e304b75\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/dayPropertyInputs.js\":\"1b93f5aa893f570e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/describeRuntime.js\":\"9200bed1b30a64af\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/extensionLint.js\":\"e9f0ce66a5d26a81\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/grainAudit.js\":\"0e863f52486fc773\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/healthCommand.js\":\"5e1a95091becb4b1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/index.js\":\"a5b4e8f03ed787e8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/presetIdentity.js\":\"bcb914180fc9d147\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a1d57bef1e6a024e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/readMedia.js\":\"7fc4fae9e789ef59\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/schema.js\":\"96531116afed627f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/serialization.js\":\"84c6846df10fd128\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/targets.js\":\"d7df00ffbca8b718\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/tokens.js\":\"596eeb947928f209\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/watchEvents.js\":\"bef3a8e4b35bd618\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/workspaceGuard.js\":\"ed0655ec100bb1c3\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/agent-runtime/writeCommands.js\":\"4ddf31a61509b280\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/alias/AliasCollisionToast.js\":\"f84158f78894a016\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/alias/DuplicateNameBanner.js\":\"ad9840e951a7a26e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/alias/collisionMerge.js\":\"fc32b6effa0620e7\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/alias/dataExtension.js\":\"3a28d8cf8e5d337f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/alias/index.js\":\"008f25f15c33e767\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/alias/mergeCollisionAction.js\":\"07cb18df3ea8232c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/alias/pageStyling.js\":\"a0694696a9beaacd\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/alias/rejectionToast.js\":\"b8f7b85c466181b2\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/alias/syncProcessor.js\":\"7369a3599c793204\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/actions.js\":\"54c2563b65627f42\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/addComment.js\":\"0ce947d35914d9b9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/anchor.js\":\"839e0bdb4edf3a76\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/anchorState.js\":\"7d563bd8cc47a5b2\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/commentLinks.js\":\"4d931c183c06ee3f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/confirmThreadDeletion.js\":\"bceb7fdcb8dcf293\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/container.js\":\"4382513889918e89\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/dataExtension.js\":\"bb20c6398effa3bd\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/deleteComment.js\":\"7ab5dcb6779f7873\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/highlights.js\":\"16fb37727e9525cd\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/index.js\":\"d87df9f81e719bcd\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/linkedCommentsPill.js\":\"60fa3529bd414a34\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/margin.js\":\"d99d88174cbef726\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/marginAnchorLinks.js\":\"e1b27dff31de0500\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/marginSchema.js\":\"e22525fbb7c4c8ae\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/newComment.js\":\"f24ec179d851c7a4\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/ownThreadPicker.js\":\"d2691821751f771a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/placement.js\":\"79b5fd076952a580\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/queries.js\":\"bd6f0cba36826ea3\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/quotePosition.js\":\"53e544cbb908a155\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/quotedIn.js\":\"d2bcc4d93d9bb4cf\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/quotedRange.js\":\"888be66796e186c3\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/rangeRefs.js\":\"e59018a21be6fd02\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/readHighlights.js\":\"7955dae0d7d2dd74\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/readSelection.js\":\"c705152dd1a4f0fc\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/readSelectionUi.js\":\"aadd6136539726de\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/reanchor.js\":\"5b0140109c55fac1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/schema.js\":\"1e7ff59cb5a17972\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/scope.js\":\"a0245704b049487f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/scopeThreads.js\":\"2b3a11614bacfd55\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/splitRetarget.js\":\"8b32bb4c3747c731\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/suggestionCard.js\":\"1f4b91429c1b785f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/suggestions.js\":\"640496e7be6714e9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/summaries.js\":\"252846d454edf421\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/summaryBatch.js\":\"a07aa3b48e7c049e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/surface.js\":\"3d90335ce0b2c717\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/threadNavigation.js\":\"18009fb2d2f0ad45\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/threads.js\":\"ba0f784f95caf979\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/ui.js\":\"dbcc8136b150a6e9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/annotations/uiStore.js\":\"60a79f1315be8487\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/app-intents/appIntents.js\":\"d5de785097fea4f8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/app-intents/index.js\":\"caee51b311b28a3d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/app-update-prompt/index.js\":\"34ba4cc84ee78719\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/app-update-prompt/status.js\":\"a32b2784023bf29b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f98566b459b9ba66\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/MediaBlockRenderer.js\":\"a0c16767bf343539\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/MediaDownLaneReplicator.js\":\"6334cd7c89595452\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/MediaUploadReconciler.js\":\"820051ce2fcf2855\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/assetDownLane.js\":\"5737c419c1b2ae72\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/assetResolver.js\":\"ce0f2617ea38c8d6\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/assetUpload.js\":\"1ce073c1d710c02e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/attachmentCleanerIO.js\":\"0b4b43247dae7d02\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/audit/supabaseAuditIO.js\":\"5fa035614dfa2ae7\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/blobStore.js\":\"e9e032065bd8a122\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/browserMedia.js\":\"90c29d9d82052eec\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/byteStore.js\":\"fd6d155d85af8c7d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/cleanerIO.js\":\"a8f04bdb0c64c451\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/cleanupAttachments.js\":\"a669655e7682a934\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/dataExtension.js\":\"01dc67c884cd52b5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/downLane.js\":\"77d7ba5325fdde01\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/index.js\":\"2020f8bac6df4bf7\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/insertImageContribution.js\":\"6c06003c9d64c26a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/laneArming.js\":\"f87a7a22280d2e7b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/laneLock.js\":\"4f9cf0348ec5d980\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/mediaBlock.js\":\"eb4b1e619b4d90ab\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/mediaCapture.js\":\"d8e5c6cc17458e8b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/mediaLanes.js\":\"bc2fea63c99a180d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/mediaViewers.js\":\"b9c727bfc14a789a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/mediaViewersFacet.js\":\"5af08d5d53dbe877\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/pasteCapture.js\":\"e930f6fb9e398f98\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/resolver.js\":\"f6dd44c2f087c20e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/retryUploadsAction.js\":\"d8664b225dc10379\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/storagePaths.js\":\"709fb821730235c9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/uploadDrain.js\":\"9a9c6362fc921e62\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/uploadLaneStatus.js\":\"766dcc99877a6b1c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/uploadReconcile.js\":\"beead1c377b2d80f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/uploadRecovery.js\":\"817072b8f7b76fda\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/uploadStore.js\":\"5ec230fc5c14db9b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/attachments/useAssetObjectUrl.js\":\"db481e80f183815a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"139a047b44aed54e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks-view/BacklinksViewSection.js\":\"af4f6ddbb0c88209\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks-view/facet.js\":\"53338c5f8621ed90\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks-view/index.js\":\"370c87286c938a9f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks-view/prop.js\":\"78efc16a30435e61\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/BacklinkFilters.js\":\"db259a514d2c49da\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b94a6e0dbc2d54d0\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/BlockEntry.js\":\"c099eeca4da4f943\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/LinkedReferences.js\":\"ea25d1b74f1e3979\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"41e9b6a1a3fd10e9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/dailyNoteDefaults.js\":\"174579366e85b6d4\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/dataExtension.js\":\"680d49c9528245b6\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/edgeExclusions.js\":\"91ef7f095c432e38\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/filterProperty.js\":\"c39ceda8806c9eb8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/index.js\":\"2904a8a050841763\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"876746e7e8dbd27b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/inline-counts/applies.js\":\"5d53d63c8754f0a1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/inline-counts/countQuery.js\":\"615883cb23ea0724\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/inline-counts/expansionStore.js\":\"fe754478df60e848\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/inline-counts/index.js\":\"48c173184f029480\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"09f13c0851aba30e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/presentationInvalidation.js\":\"42addb5ed2387b60\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/propertyEditorOverride.js\":\"d4ed2933740d3281\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/propertyFilter.js\":\"8430e0e772664556\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/query.js\":\"694b86ba7a20204e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/resolveFilter.js\":\"1f2c6aa30eda0755\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/sourceBatch.js\":\"93111a587ae66d3e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/sources.js\":\"f5b9ff692716af70\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/useBacklinks.js\":\"e6332f0094c536cc\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"4192312f2267df53\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/birthday/BirthdayCelebration.js\":\"91b5d7817ac3e767\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/birthday/BirthdayOverlay.js\":\"b9754f407d576ede\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/birthday/gate.js\":\"07dd8b0ecd412395\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/birthday/index.js\":\"b0cf6946dbc38a9c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/birthday/wolfTheme.js\":\"d1655fd0322af061\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-drag/BlockDragLayer.js\":\"8102c3d41535d69a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-drag/dragController.js\":\"97fd822b71f01fa1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-drag/dropTarget.js\":\"f5aa93e65f5e0dc7\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-drag/index.js\":\"c2ff3287b0313c4c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-drag/projection.js\":\"755712d1dc40cdf1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-info/BlockMetaCard.js\":\"795e12dea62c915e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-info/index.js\":\"6c78aa9a009d8dbb\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-tagging/AddTagDialog.js\":\"eb23c6acb90e78b5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"124f94048ef2668c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-tagging/TagNameIssueHint.js\":\"460387ab71712309\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-tagging/addTagAction.js\":\"a799eae6d6527145\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-tagging/appendTag.js\":\"537ec6db4c1bce7e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-tagging/config.js\":\"6e025fcf67f51a82\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-tagging/dataExtension.js\":\"03db3e9ca319b9b9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-tagging/index.js\":\"7faa66e1a8a8a884\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/block-tagging/propertyEditorOverride.js\":\"927f87573ec4dbfb\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/breadcrumbs/BreadcrumbList.js\":\"58bccd246cb93169\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"1ed6b1cec6bc83d8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/breadcrumbs/Breadcrumbs.js\":\"aaa16cc194eeb0ed\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"55d24404717376f3\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"5dacab4fabceb0da\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/breadcrumbs/index.js\":\"86b1f2c863fb2f13\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"38bcbfb66e5395ba\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/character-counter/CharacterCountItem.js\":\"1f3e86c0b76cb7bd\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/character-counter/ProfilePropertyEditor.js\":\"fd20034004ec9c7a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/character-counter/actions.js\":\"4e4f2e32e254a10e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/character-counter/blockType.js\":\"664e29674a8f91e1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/character-counter/charCount.js\":\"4d3b547b03bd3724\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/character-counter/dataExtension.js\":\"4b4aec16a34c6f41\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/character-counter/index.js\":\"0b109481b831f9a0\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/character-counter/profiles.js\":\"fad30bc0553ed19b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/character-counter/properties.js\":\"6adec6f3485385f0\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/character-counter/subtree.js\":\"b330786daffbc72a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/character-counter/textCounts.js\":\"10ceb104e82ab541\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/colemak-keybindings/index.js\":\"f0b19e4d981fc514\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/command-palette/CommandPalette.js\":\"e842e6d9a2567e47\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/command-palette/HeaderItem.js\":\"723727bd46e464bb\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/command-palette/context.js\":\"65ddfc89895951e9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/command-palette/index.js\":\"ae4e07a57137db0c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/command-palette/selection.js\":\"3926cb294438d048\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/command-palette/toggleStore.js\":\"eee77f1438411d48\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/command-palette/useCommandPaletteActions.js\":\"5a74c5717aa9232e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/contributors/ContributorBadges.js\":\"f6abf093a9b09ee9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/contributors/author.js\":\"8a4abac4632c583a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/contributors/codeMirrorExtensions.js\":\"6f3086c985b16553\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/contributors/dataExtension.js\":\"835893a9d2af37dc\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/contributors/index.js\":\"121d670ca22dcc03\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/contributors/mentionAutocomplete.js\":\"6c65f9602e6083bc\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/contributors/processor.js\":\"b7515558e8c8e0a3\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/contributors/profiles.js\":\"9f489f03d344a63f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/contributors/queries.js\":\"c9facd94e1fa15cc\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/contributors/schema.js\":\"86d8cd3cc39b83d3\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9e828de815924ff8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/cursor-follows-scroll/followOrigin.js\":\"0464943ed1e0345e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/cursor-follows-scroll/index.js\":\"5a9ae819211331b6\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0164539c027e1f30\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c62a2091937888f5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/CalendarGrid.js\":\"37e42f552fa9dcef\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/DailyNotePicker.js\":\"93a7949f33eebe24\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"bfefe1eac35d4f9c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/DateNavDecorator.js\":\"676574ffe2d74290\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/DateScrubOverlay.js\":\"79e0aa9b93d2bf29\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/DayPropertyEditor.js\":\"4fd353a16c48dd89\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/HeaderItem.js\":\"690379d02a121645\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/ReschedulePicker.js\":\"e96b4c56d52233af\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/SpreadDatesDialog.js\":\"fcb7da0fb6cdf082\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/actions.js\":\"998a327c7cbea186\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/blockDateAdapter.js\":\"5da69d4da68f63f6\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/calendar.js\":\"1363f1943abb1117\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/dailyNotes.js\":\"9d535d2873babbb0\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/dataExtension.js\":\"7d416f18060808c1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/dateScrubActions.js\":\"e7bc67addc1b3d08\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/dateScrubGesture.js\":\"f594f59b62ebb09b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e7e7ee8d966d11d3\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b26f683fc2059368\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/dayProperty.js\":\"12fadb43f1c3cdbf\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/deletionGuard.js\":\"34417801f29e5a60\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/dueQuery.js\":\"08f28561ac94a5d1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/index.js\":\"d59d1859b6349404\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/landing.js\":\"7e601512c558998c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/localSchema.js\":\"23726ed3486d4f81\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/referenceDateAdapter.js\":\"0b41aa1c2ee7004e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/rescheduleAction.js\":\"b295f555701e8382\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/schema.js\":\"0ddcb7e33c87480e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/spreadBlockDates.js\":\"ffd08b9f41325d73\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/spreadDatesAction.js\":\"9022eeb98536953d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/today.js\":\"9efe9c6c2294d944\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"98e9f9b439ea8802\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c1164166b0157c69\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/data-integrity/audit.js\":\"5034ca57f87e0bed\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/data-integrity/auditAction.js\":\"b0eba2d20a4e0532\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/data-integrity/auditRanges.js\":\"fe1e785eed4d4362\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/data-integrity/diagnosticsSource.js\":\"b401e28390e42d97\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/data-integrity/divergenceScan.js\":\"eb652e5445cd4a28\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/data-integrity/index.js\":\"1f4ed107747e88c8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0e7e4ac7880a3879\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/data-integrity/referencesMirror.js\":\"d5f37d1f5c771eba\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/data-integrity/rowJson.js\":\"d3fc0a88c0145bcb\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/data-integrity/schedule.js\":\"f25d8d134bf59b4c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/data-integrity/store.js\":\"799dfc802a1e9b26\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-maintenance/action.js\":\"d95560797703036e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-maintenance/index.js\":\"6fae1e4fb18c4a58\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-maintenance/plugin.js\":\"c21f285b576b331a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f8d61fcd907fc366\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-mirror/actions.js\":\"34307e5a04288200\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-mirror/changeMarker.js\":\"72c62ee991c45994\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-mirror/diagnostics.js\":\"9d68f0ac818223c5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-mirror/fileSystemAccess.js\":\"13561a050677fa36\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-mirror/filenames.js\":\"2b9142665840327a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-mirror/index.js\":\"05673e6d03d6abe6\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-mirror/mirror.js\":\"d1b3739d6a7c40c7\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-mirror/runLock.js\":\"a05ab4b3b5526b9f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-mirror/runtimeHealth.js\":\"f012f8190231666f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-mirror/schedule.js\":\"d94a51fee9527a47\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/db-mirror/store.js\":\"5e8b1023166256ff\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/default-themes/index.js\":\"42e68ac0da6ad10e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/default-themes/themes.js\":\"7266ba4076825786\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/diagnostics/facet.js\":\"31c220c386ae8054\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/diagnostics/useDiagnostics.js\":\"c9b1ab8e9ab50816\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extension-prompts/dismissals.js\":\"5f1512736e213b0f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extension-prompts/index.js\":\"e5594aff75b55e53\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extension-prompts/status.js\":\"9db6a969b3ec3ef7\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extension-prompts/store.js\":\"30db5a463fe2892d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4d3052456dff006e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extensions-settings/ExtensionsSettings.js\":\"9521040ab23bebd0\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extensions-settings/actions.js\":\"cf059fb08db4e211\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extensions-settings/config.js\":\"627f773b0ae79e18\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extensions-settings/dataExtension.js\":\"f6017092cf60da9d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extensions-settings/effect.js\":\"7ae03f683e1a1491\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extensions-settings/index.js\":\"5437d3f82b2dd5e4\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extensions-settings/propertyEditorOverride.js\":\"d0b2fcee138eb281\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extensions-settings/useToggleTree.js\":\"89167f464c5c4bbf\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extract-type/ExtractTypeDialog.js\":\"b89c360d42ea75cc\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ec0d2163605fac02\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extract-type/PropertyShapePicker.js\":\"097f2d9b2f669e2e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extract-type/action.js\":\"ecfad9e384d247dd\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/extract-type/index.js\":\"6b3d70351ed2f483\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/find-replace/FindReplaceDialog.js\":\"be16850b0fb329ce\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/find-replace/HeaderItem.js\":\"8f41e8612c03ee0a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/find-replace/dataExtension.js\":\"4fa56d80134ba8b8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/find-replace/index.js\":\"e4ca0c0c5d94322f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/find-replace/search.js\":\"121d11cacfe8c732\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/find-replace/toggleStore.js\":\"ad8c08e63ce65f35\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/LocationPropertyEditor.js\":\"07b00e598e7a0d5b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/MapView.js\":\"a371666e155311f7\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/blockTypes.js\":\"43526c749abc9399\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/codeMirrorExtensions.js\":\"81f1cbc530040e1f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/createOrFindPlace.js\":\"276828f7411360db\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/currentLocation.js\":\"7850ca865a961276\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/dataExtension.js\":\"e629746e368865ae\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/geoContentDecorator.js\":\"ac43441b3f8a603a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/googlePlacesClient.js\":\"3da429981c982a42\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/index.js\":\"4fbb75863bc66cd9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/locationsPage.js\":\"a7b8d12f50f3c25e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/mapViewport.js\":\"08a0b00199611cb8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/pickCurrentLocation.js\":\"a1e8c3ab0b512fe5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/placeAutocomplete.js\":\"b862c46aa999846b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/placeNameCollision.js\":\"277e0d4a41c65f4c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/properties.js\":\"d45c7bcd79d354c6\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/propertyEditorOverrides.js\":\"6f86bd79608d0d30\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/query.js\":\"1049729424b527fe\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/geo/usePlaceSearch.js\":\"4cdb24f0dd609f2a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"79751ce189428f95\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"976a53c01661e3be\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"36d3c0c9029b93c4\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/grouped-backlinks/config.js\":\"e17c480c3d7f151a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/grouped-backlinks/dataExtension.js\":\"676218829aec46ab\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/grouped-backlinks/facet.js\":\"d4bbdf6adf22f241\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/grouped-backlinks/grouping.js\":\"d7788a9e7bf8de78\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/grouped-backlinks/index.js\":\"4bce3945d4595458\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6e6a9a1de13d0600\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/grouped-backlinks/query.js\":\"a9d9588af060835e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/grouped-backlinks/resolveConfig.js\":\"d2886e42d4f51105\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"8dbbf836f7bd7489\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"1a2041581a543b43\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/html-document/HtmlDocumentContent.js\":\"03a667c782dcd530\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/html-document/HtmlFrame.js\":\"94e24958671fa8b9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/html-document/actions.js\":\"bd9d97a120992137\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/html-document/blockType.js\":\"0b7a1508a967af36\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/html-document/confirmRunScripts.js\":\"e14d89d420218f4c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/html-document/dataExtension.js\":\"3f57fca0c25e74fb\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/html-document/frameAnnotations.js\":\"66d65ea3022ae3ca\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/html-document/frameDocument.js\":\"9774c212b9e067a9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/html-document/frameTheme.js\":\"c47a8f1edc9dd9af\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/html-document/index.js\":\"b6c4246ab47a76c8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/html-document/scriptConsent.js\":\"8f02357f120695ae\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/html-document/sourceMap.js\":\"4ed0051a8309fcff\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/html-document/useDocumentScripts.js\":\"8aa2d41aa5f7f250\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/interaction-metrics/index.js\":\"e60f0b911fbc7dcc\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/interaction-metrics/record.js\":\"425222dd1974e0c1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/interaction-metrics/recordStore.js\":\"d262ada8f36d0f3a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/interaction-metrics/responsiveness.js\":\"7ca0f4e0e89a8e05\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/interaction-metrics/schedule.js\":\"2d8a75b973c833ba\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/interaction-metrics/sessionContext.js\":\"94ce7d6b56d712fe\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"aceba18bcfb6af2f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"df9d93e048680f8e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/keybindings-settings/actions.js\":\"4a7a4021c43ac5a8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/keybindings-settings/config.js\":\"f722ce8d9765843f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/keybindings-settings/dataExtension.js\":\"2d10b3d742b56b1d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/keybindings-settings/effect.js\":\"545da5405126aa03\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/keybindings-settings/index.js\":\"5555950c73c1ee9c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/keybindings-settings/keyCapture.js\":\"9235f96b5ae4baa8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/keybindings-settings/overrideStore.js\":\"c4d60ddbd1dfab73\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"10a66aeb754201d5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/left-sidebar/HeaderItem.js\":\"de065c63baf83fe6\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/left-sidebar/LeftSidebar.js\":\"328732e734ebadfd\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/left-sidebar/actions.js\":\"f567fa7624409c88\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/left-sidebar/facet.js\":\"d16e69dbbb455420\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/left-sidebar/index.js\":\"9b94fbf156e3967c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/left-sidebar/shortcuts.js\":\"8614cd56b99b2d8b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/left-sidebar/toggleStore.js\":\"7673cb407abd3857\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/merge-blocks/MergePicker.js\":\"6ccdb21723f1bd04\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/merge-blocks/index.js\":\"80b91af5311952fa\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/merge-blocks/mergeAction.js\":\"f3ccf21d9b51113b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/merge-blocks/strategy.js\":\"7eb12324819a2c13\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/mobile-bottom-nav/Button.js\":\"b5ab1298730e4643\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"878247bfe2d6693f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/mobile-bottom-nav/defaultItems.js\":\"67221b58bb29f75c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/mobile-bottom-nav/facet.js\":\"b6869d911c27059d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/mobile-bottom-nav/index.js\":\"cca74a6ba2141c3b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"336e497b812f15ef\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/mobile-keyboard-toolbar/actions.js\":\"983a7d5da054047e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"81a87b35b09980ba\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/mobile-keyboard-toolbar/facet.js\":\"228dd0dc16a4cc8a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/mobile-keyboard-toolbar/index.js\":\"0693edfcfb805b2c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/move-blocks/MoveDestinationPicker.js\":\"758e46e0cfb4d4cc\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/move-blocks/blockSubtreeMembership.js\":\"0381bf09ba1a36d8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/move-blocks/contextMenuItem.js\":\"68f94cecfbd4bc5e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/move-blocks/index.js\":\"fabc7f5f2a7e1b05\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/move-blocks/moveAction.js\":\"3c7d773b3cb8d33f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/move-blocks/moveBlocks.js\":\"c3cdc8b45baaa674\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/move-blocks/selectionAfterMove.js\":\"029a79da4d492361\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/onboarding/TutorialBanner.js\":\"209aaa99208aa817\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/onboarding/action.js\":\"2e8aa8786628fda1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/onboarding/bannerDismissal.js\":\"aa92f939ffa0b4b8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/onboarding/documents/cheatSheet.js\":\"212f08eced3e50f6\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/onboarding/index.js\":\"57a35c9685bc6e99\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/onboarding/keys.js\":\"4e06973b0a24206b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/onboarding/landing.js\":\"5c1d1eaec6302646\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/onboarding/outline.js\":\"211c5576488372e0\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/onboarding/seed.js\":\"675a911f3719be03\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b9c0bfddc984b061\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/perf-monitor/analyze.js\":\"90759d32468957fb\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/perf-monitor/diagnosticsSource.js\":\"1c8001a7f9b73979\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/perf-monitor/index.js\":\"436c5dd185c49c11\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/perf-monitor/load.js\":\"7c29d25b4cc8d964\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/perf-monitor/monitorRun.js\":\"5a08564afdaa0902\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/perf-monitor/schedule.js\":\"0031790921cebd0a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/perf-monitor/series.js\":\"77b784d7f512eb78\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/perf-monitor/store.js\":\"e41b0193e684004e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/perf-monitor/trendAction.js\":\"77a88a46bd7b5404\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/perf-monitor/verdict.js\":\"778e22554411ba77\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/plain-outliner/clickToEditAction.js\":\"199886c11c49bc64\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/plain-outliner/index.js\":\"b43af8b2513d08b5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/plain-outliner/interactions.js\":\"67ee4ca2a3c3aca3\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9e42d9b2539ea126\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/properties-migration/MigrationGate.js\":\"bacf3c717f226166\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/properties-migration/MigrationGateDialog.js\":\"031be883d6fb54d0\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/properties-migration/action.js\":\"f1c547424df3acb5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/properties-migration/index.js\":\"c84aaebf713c347f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/properties-migration/localRunMessage.js\":\"a263de0d4f7b9cc9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/properties-migration/plugin.js\":\"eb17c2cc243ce29a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/properties-migration/progressReport.js\":\"9693d133053627ef\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/properties-migration/sweepProgress.js\":\"5d1adc7906d27b8a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/property-rows/FieldRowRenderer.js\":\"fc7de350b0d17ee1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/property-rows/ValueRowRenderer.js\":\"2787c0c04879bdac\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/property-rows/actions.js\":\"3245a89d19089d82\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/property-rows/autocomplete.js\":\"b138d47e8c7fcb19\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/property-rows/fieldRow.js\":\"86f3627b7f54bd6f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/property-rows/index.js\":\"1a1a73de3077027d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/property-rows/referenceWarning.js\":\"99d2f9b9b33df156\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/property-rows/valueAutocomplete.js\":\"f981b8c051b75484\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/property-rows/valueSchema.js\":\"c5712cc0f84e3f26\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/quick-find/HeaderItem.js\":\"69b6ae1831c00114\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/quick-find/QuickFind.js\":\"a965b8be80de4de3\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/quick-find/index.js\":\"33e90e0cbb75d214\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/quick-find/recents.js\":\"3600f2a1ef746caa\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/quick-find/resultItems.js\":\"d5e5b96d376e57cf\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/quick-find/selection.js\":\"8ec0cbc599e41f23\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/quick-find/toggleStore.js\":\"a144280e077b140f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/recents/HeaderItem.js\":\"7997ec2d8c17d862\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e5ac8a6b7d0dfdd7\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/recents/grouping.js\":\"2d24e7887d68db02\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/recents/index.js\":\"217394198a95684a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/recents/target.js\":\"417812e780f4df5f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/codeMirrorExtensions.js\":\"1fea894cb5ffa67d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/contentPrefill.js\":\"cd9c84baa3106de7\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/dataExtension.js\":\"3ea7b887756b9b88\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/index.js\":\"0992acd34330a7b9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"937cb2d92a10482c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/invalidation.js\":\"a611409cba63511c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/localSchema.js\":\"e27751a60b449f0c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/markdown/blockrefs/index.js\":\"c1dc01accc96c812\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"1c9b2612b2fc27f4\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/markdown/index.js\":\"800ffd78cb18037a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/markdown/referenceNode.js\":\"1885c39df8b194d4\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ba5ce16013c85580\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d54165303962e055\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/markdown/wikilinks/index.js\":\"906fab685daedfad\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"841a902d89a0997b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"8cd860cbc8410264\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/mergeRetargetProcessor.js\":\"4da2fe74c748962a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/parseFence.js\":\"99e760953f968f6e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/referenceParser.js\":\"440c38434e57b000\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/referenceProjection.js\":\"64b86cfe3aec7f7f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/referencesProcessor.js\":\"b9f2b2f6f64b89df\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/renameProcessor.js\":\"18e5b7fe145378c3\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/references/spanReplacement.js\":\"9db5fdb4f3d16bf1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/rich-paste/htmlToOutline.js\":\"6b5ef248ab288d21\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/rich-paste/index.js\":\"53a233487558f03f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/rich-paste/normalizeClipboardDom.js\":\"8af8e15e9c60da52\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/rich-paste/pasteDecision.js\":\"1c6367e7830f5b14\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/action.js\":\"caa83cf7730f3150\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/blockIds.js\":\"51101da643fb2531\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/content.js\":\"ec0929a8ca8d4fa8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/effect.js\":\"865562d39728fb08\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/ids.js\":\"7b9084052bf047ee\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/import.js\":\"c2e2582e7dc7ca8f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/index.js\":\"4fe5aef022aab904\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/plan.js\":\"412276b36dca2c02\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/plugin.js\":\"b543be3a526e35cc\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/promotion.js\":\"ed237264f8949bdb\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/properties.js\":\"f4c31ffdeaef8413\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/references.js\":\"09434d63599d9c48\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/report.js\":\"446607bc028c5b9e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/roamMemo.js\":\"8f8adb405e09633d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/runtime.js\":\"e28c8483c014e8a6\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/schemaReconciliation.js\":\"dde897bd8f306b44\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/srsMarkers.js\":\"9a6b30418ad90f9d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/todo.js\":\"2019d50e723aa6e1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/typeCandidates.js\":\"9651ca92599ef732\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/roam-import/types.js\":\"350bbadb33513453\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/search-health/index.js\":\"88a5da918c981a6a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/search-health/store.js\":\"423366b267ab0265\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/shortcut-help/HeaderItem.js\":\"7d9bc7d9bb351155\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"707d524680fb5bac\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/shortcut-help/index.js\":\"d2e15c09f9b919b6\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/shortcut-help/model.js\":\"752ecc6b54f3110e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/shortcut-help/toggleStore.js\":\"7ee0d4c64a6e5fa1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/shortcut-help/useKeyInspector.js\":\"86d9ffa4dca9e614\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"43e8db39ae638ed8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/spatial-navigation/ShellDecorator.js\":\"4d42970a2000c4c8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/spatial-navigation/actions.js\":\"bc7bfa0da11eaa23\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/spatial-navigation/exclusionsFacet.js\":\"483c29536650b711\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/spatial-navigation/index.js\":\"d1b85bf8ef0a15c7\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/spatial-navigation/shell.js\":\"ebaee41fb3c4c427\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/spatial-navigation/surface.js\":\"135549d70009156b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/spatial-navigation/walker.js\":\"b96c81606e0a255c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-rescheduling/RescheduleToast.js\":\"1300c1711aaeaf42\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-rescheduling/dataExtension.js\":\"81bc2221a36408bd\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-rescheduling/index.js\":\"ed399de1c5f07539\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-rescheduling/indicator.js\":\"0b210b4e58f7c3c0\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-rescheduling/moveSrsState.js\":\"678efb70460006ba\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"28be8cb6d508322f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-rescheduling/scheduler.js\":\"07188d92fee516f8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-rescheduling/schema.js\":\"20b6687a26096b04\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"bf5580ad302a83b1\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-rescheduling/srsClipboard.js\":\"b44f722267dfb08d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b4e0aadc998f48ed\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/DailyNoteReviewHint.js\":\"aa981b497a15b6f4\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/DeckPicker.js\":\"8259a68b4b054156\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/ReviewControls.js\":\"e0929872b426ca33\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/ReviewDeckRenderer.js\":\"cbf607c303d541b3\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/ReviewSession.js\":\"1ec6ed5646326ce9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/actions.js\":\"e93d774f78848b54\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/archive.js\":\"095bd1fb723ce897\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/dataExtension.js\":\"f7685ce8b35249a6\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/deck.js\":\"0f26c2eaf7122d85\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/dueQuery.js\":\"ab1b90a07f57af9d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/gradeDecision.js\":\"77f53b5f296f6a93\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/index.js\":\"fd274f8f21aa2a5c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/keyHints.js\":\"fc16bf56c53a38f3\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/reviewCardLayout.js\":\"f93fe88f09fd8d39\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/reviewProgress.js\":\"a3da94f8cd7b7a5d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/schema.js\":\"7cd01946d6806862\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/srs-review/useDueCards.js\":\"bb2f9ef23d79edf9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/startup-metrics/index.js\":\"112737267d7313d2\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/startup-metrics/record.js\":\"7937b84e6de82f44\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/storage-persistence/index.js\":\"45f2d61fc9a1726a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/storage-persistence/persistenceStatus.js\":\"45665e35c8ad7c50\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/storage-persistence/requestAction.js\":\"f7b918f0fbf7b8ab\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/supertags/TypeChipsDecorator.js\":\"d10fa641c593ef80\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/supertags/codeMirrorExtensions.js\":\"a10e361dfdccbfde\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/supertags/index.js\":\"5138ceb51732422f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/supertags/typeAutocomplete.js\":\"9c204a58b0174095\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d4bd961330a60866\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/swipe-quick-actions/actions.js\":\"76269326b17f055e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/swipe-quick-actions/anchor.js\":\"adc004d8d8a48144\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/swipe-quick-actions/events.js\":\"186ca0842aae0a2d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/swipe-quick-actions/gestureActions.js\":\"59179bc2421a02e0\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/swipe-quick-actions/index.js\":\"9476b2960308646b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e43f333d786d5118\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/sync-metrics/collect.js\":\"f1f39272f2ef3149\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/sync-metrics/index.js\":\"4f33b8f7774edb20\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/sync-metrics/record.js\":\"e4e808399ed7c89f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/system-status/RejectionDialog.js\":\"e2d4d9eff73dec17\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/system-status/SystemStatusHeaderItem.js\":\"bd9d54b86522c95f\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/system-status/index.js\":\"3b7344d4ab5a680c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/system-status/model.js\":\"cadda3c68762a1ce\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/system-status/queueCounts.js\":\"3eaa49e3c3e175d5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/system-status/rejectedHelpers.js\":\"538d5162e98a98b4\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/system-status/rematerializeAction.js\":\"f9a330e11743b1ed\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/system-status/useHysteresis.js\":\"b0949fc150838914\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/ColumnHeaders.js\":\"9e5a88c137769fb5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/QueryUi.js\":\"80221298abdc2ba2\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/TableLayout.js\":\"70365c1568203842\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/actions.js\":\"927580faf399b2e5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/cellEdits.js\":\"5af3524870b6f672\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/childrenViews.js\":\"eeef83840dc2febd\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/columns.js\":\"d6b881c4f6575c9b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/controller.js\":\"129aee08a55ad849\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/convert.js\":\"9f19495dbdbe5490\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/dataExtension.js\":\"9b1a71ee5735b9e7\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/index.js\":\"a8665dd3996bb747\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/keys.js\":\"14794bd9f9c7c9d0\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/model.js\":\"3c723b1bbbe9b164\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/query/QueryText.js\":\"39e1604506ce8a1c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/query/backfill.js\":\"d13d498714f18d15\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/query/completion.js\":\"1dac9b68b91a0fea\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/query/format.js\":\"cbf6b608372c1582\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/query/parse.js\":\"d82624d3212b11cb\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/query/queryValue.js\":\"2143288c13cfb616\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/query/registrations.js\":\"490cb33239d1f0a0\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/query/source.js\":\"65722b5493ff01bd\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/registry.js\":\"3a11c378d5661ee8\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/rowGutter.js\":\"46eff39cbe8858e9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/rowVerbs.js\":\"0ac36a6b3e997297\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/schema.js\":\"90637b1efe84eca9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/tables/sort.js\":\"c4e340fbb6e7242e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/theme-toggle/effect.js\":\"3e215b01b9407f71\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/theme-toggle/index.js\":\"d3b4b48ad5e82fe9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/theme-toggle/theme.js\":\"498661c098a74b90\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/todo/actions.js\":\"5f628b24c6511a39\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/todo/dataExtension.js\":\"e4b11f0f4f2757ab\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/todo/index.js\":\"e8671ac3d44bb917\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/todo/schema.js\":\"e7f740377878772b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d59180114e1741cf\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/touch-selection/actions.js\":\"d18da45611ff585b\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/touch-selection/defaultItems.js\":\"928c4076b2929d1e\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/touch-selection/facet.js\":\"a89e41065bbb7115\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/touch-selection/holdRecognizer.js\":\"73f7e3f984c6c389\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/touch-selection/index.js\":\"5bb08a7fef9e46c6\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/update-indicator/UpdateIndicator.js\":\"f2a3f499ec600b5a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/update-indicator/index.js\":\"0fb463946ed1cbc2\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/update-indicator/loadTimes.js\":\"dada0d66f60cf1d9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/video-player/VideoNotesRenderer.js\":\"7b1b8f79d353f48a\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/video-player/VideoPlayerRenderer.js\":\"0cd7ceb3fd818465\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/video-player/VideoTimeStamp.js\":\"d153c65ece1b13dd\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/video-player/actions.js\":\"c697a8a91c839390\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/video-player/index.js\":\"ab1a52964f32e500\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/video-player/markdown.js\":\"d9d76a1031f0e8a4\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/video-player/notes.js\":\"8cbe78a3cb831db5\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/video-player/registry.js\":\"179ce748cf47ba6d\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/video-player/remark-timestamps.js\":\"3c2f79d65adf13ba\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/video-player/view.js\":\"2d384ab9a64e834c\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/vim-link-hints/LinkHints.js\":\"498c19b7606f2da9\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/vim-link-hints/index.js\":\"3794662e278d6f69\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/vim-link-hints/model.js\":\"ccc3804c25c130a4\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/vim-link-hints/settings.js\":\"70350594297cfd60\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/vim-normal-mode/actions.js\":\"f3d80206d565aa47\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/vim-normal-mode/index.js\":\"e236a3b380059011\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/vim-normal-mode/interactions.js\":\"7d2b340227f12e86\",\"/knowledge-medium/pr-preview/pr-1888/src/plugins/workspace-header/index.js\":\"b7949eba68856dff\",\"/knowledge-medium/pr-preview/pr-1888/src/registerServiceWorker.js\":\"d2ee7263cb9c50d6\",\"/knowledge-medium/pr-preview/pr-1888/src/requestPersistentStorage.js\":\"d63c77c1b39b4e1b\",\"/knowledge-medium/pr-preview/pr-1888/src/services/authRequestDeadline.js\":\"4d206e8981e3802d\",\"/knowledge-medium/pr-preview/pr-1888/src/services/authStorage.js\":\"e6f50562f4b3da31\",\"/knowledge-medium/pr-preview/pr-1888/src/services/powersync.js\":\"b1607900596fcae0\",\"/knowledge-medium/pr-preview/pr-1888/src/services/supabase.js\":\"3829d7902ea17e7b\",\"/knowledge-medium/pr-preview/pr-1888/src/services/uploadErrorClassifier.js\":\"e062c8c3792791fa\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/ActiveContexts.js\":\"c0222f0ab0095875\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/HotkeyReconciler.js\":\"4fb3c1f37b5fb874\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/WipeLocalDataDialog.js\":\"58dfbfd3e46ebe0d\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/actionDispatch.js\":\"a423cbdbd62daabe\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/actionRefItems.js\":\"e572cca201c98822\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/applyKeybindingOverrides.js\":\"3e767c20be2e4b78\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/blockActions.js\":\"182c14cdc5217352\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/blockMergeGesture.js\":\"aab140872fdc9b39\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/canonicalizeChord.js\":\"18f6350e610fb0c4\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/defaultContexts.js\":\"3c2face09a582778\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/defaultShortcuts.js\":\"aefac86896636c9d\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/effectiveActions.js\":\"518616f0ba436b56\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/gestureAction.js\":\"87dcd4eb37fb35eb\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/gestureBinding.js\":\"5fb52b40969b1a35\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/holdRegistry.js\":\"c3bcf2b80b02dcb0\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/keybindingConflicts.js\":\"a154a3b91f0fa557\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/keybindingOverrides.js\":\"c91db53bedbf6842\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/pointerAction.js\":\"4bb304835f8ad017\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/resolve.js\":\"25ba8910cb2218cc\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/runAction.js\":\"373423a31e413193\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/sequenceMatcher.js\":\"81778db47c17adc8\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/types.js\":\"e9abd5572b92114a\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/useActionContext.js\":\"38a04b46ce887c1d\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/useActionDiscovery.js\":\"bc3f5256673c29d7\",\"/knowledge-medium/pr-preview/pr-1888/src/shortcuts/utils.js\":\"49c1499d355a82fd\",\"/knowledge-medium/pr-preview/pr-1888/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1888/src/sw/bootStore.js\":\"92a39cf05fac1b47\",\"/knowledge-medium/pr-preview/pr-1888/src/sw/previewDatabases.js\":\"7bd69438ecdb4881\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/byteTransform.js\":\"f45ef9918cd6d04e\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/attachmentCleaner.js\":\"4527c36153ff6c16\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/bundle/attachmentParts.js\":\"d95cd8a35350c268\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/bundle/bundleParts.js\":\"878ebd7b642cd0ad\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/bundle/bundleRecord.js\":\"954673b31c3680e3\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/bundle/manifest.js\":\"389936d4f149b2e1\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/bundle/takeBundle.js\":\"44d78b9bd9da0d11\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/bundle/verifyBundle.js\":\"0dae360f840aee91\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/cleaningStage.js\":\"13eade2c4278dc45\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/conversionKey.js\":\"81a9ad06dfc1b596\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/conversionServer.js\":\"08df2e77f99085f8\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/flip.js\":\"9fb6526e564aa68a\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/flipAttempts.js\":\"a3a936b764e0ff99\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/pages.js\":\"acafa178bf347337\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/preflight.js\":\"c345ef472e358f0d\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/reseal.js\":\"643d76cf54370412\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/runConversion.js\":\"2630b4620990c6c4\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/runLock.js\":\"a2fee748a30422fa\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/sealing.js\":\"def47ad057c6d450\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/sealingStage.js\":\"47fe77c0022f88f8\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/stage.js\":\"fd8b686c81f19d78\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/conversion/verifyReseal.js\":\"12dcc2b169d6dab2\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/aad.js\":\"1f4c78a7915e5ce4\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/aead.js\":\"39b40617f016a10c\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/base32.js\":\"4110c5693a797214\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/base64url.js\":\"cf04c519858f2d69\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/binaryEnvelope.js\":\"2b1c6fde17678129\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/byteAead.js\":\"2d2afc14a2c016ba\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/canary.js\":\"2417c294d61652fe\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/contentHash.js\":\"c01c85b4f4dabd7e\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/contentKey.js\":\"1c9b08112d3a60eb\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/derivedIdNamespace.js\":\"6cf9577220486c9d\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/envelope.js\":\"d5c0ee8e28fcd0b6\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/hex.js\":\"e34e232055d1e9e7\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/sha256Hex.js\":\"49128f0ae31641df\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/crypto/workspaceKey.js\":\"53f835261ccd66ef\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/keys/conversionState.js\":\"a8d7e48c85de9761\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/keys/flows/createEncryptedWorkspace.js\":\"f63e4931fbc124b7\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/keys/flows/pastedKey.js\":\"4918798fdbfc099d\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"e40d4212e1c17f21\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/keys/flows/upgradeWorkspacePin.js\":\"430483443c60e1e8\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/keys/keyStore.js\":\"65b6e7c1f6471d03\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/keys/mintWorkspaceKey.js\":\"3fe8c11a1fed8513\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/keys/modePin.js\":\"717476024a181cf8\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/keys/openWorkspaceKeys.js\":\"74581128766ca96c\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/keys/resolveWorkspaceEntry.js\":\"663e5da3397f0170\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/keys/resolver.js\":\"3a96a3ddb7e2c675\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/keys/workspaceAccess.js\":\"56aae87ee1ec8f95\",\"/knowledge-medium/pr-preview/pr-1888/src/sync/transform.js\":\"307804abdda57bf4\",\"/knowledge-medium/pr-preview/pr-1888/src/themeBootDefaults.js\":\"1a9fd8d96b186255\",\"/knowledge-medium/pr-preview/pr-1888/src/types.js\":\"dd78b2c101910bdb\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/ClientLocalSettings.js\":\"0622bc90932d41cb\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/abortableSleep.js\":\"9204f6b62385c6aa\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/array.js\":\"76f441724b803f18\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/backlinkAutocomplete.js\":\"63301a0c7a60057d\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/blockCrumbs.js\":\"15fb445eb315d923\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/blockrefAutocomplete.js\":\"17fa90dabe512939\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/cadencedIdleJob.js\":\"b95ee8b6db91a84e\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/callbackSet.js\":\"b262ed305394ecb3\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/clientId.js\":\"f3cebed9b678d173\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/codemirror.js\":\"4be6798cb3e502a8\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/codemirrorCompletion.js\":\"df9c329008fce0dd\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/copy.js\":\"8404ca7e134336cc\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/dailyPage.js\":\"2241742fea49b72b\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/dbForensics.js\":\"4384c3c7e3225d13\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/dbForensicsHooks.js\":\"b86a6c03bc9743e6\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/deleteBlockThroughUi.js\":\"bae98339eb258ad4\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/dialogs.js\":\"c7595b86fd45138f\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/dom.js\":\"aebbc13bc280251f\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/downloadBlob.js\":\"f9999b5772c6bce8\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/drawnWalk.js\":\"24c3ee64d4ba2011\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/exportSqliteDb.js\":\"91d3bfcab967aa4d\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/fileSystemAccess.js\":\"127233ff50d6a894\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/flipSlide.js\":\"1a623e2ebf6d2674\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/fnv1a.js\":\"2e910f941bdbd0f4\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/formatBytes.js\":\"2ccda1a72eeeb115\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/fuzzyRank.js\":\"38af37af750df304\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/idbKeyedStore.js\":\"0b1fbfc1fc839fbe\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/idleCallbackPolyfill.js\":\"4bd48bd884a7aa20\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/keyboardAwareScroll.js\":\"9eecd07e4e9a72d0\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/keyboardViewport.js\":\"64247bb14d883197\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/lastWorkspace.js\":\"95b3cc3d7b8d9158\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/layoutColumns.js\":\"79877c90f9a19ee0\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/layoutSessionDom.js\":\"5e2fcbaabfc1f5f4\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/layoutSessionId.js\":\"1caf1ad562d55915\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/linkClickGestures.js\":\"2e28d5349de09968\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/linkTargetAutocomplete.js\":\"ac887abfb9f54f4e\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/localDbCorruption.js\":\"8c8b73f3a7ead84e\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/localDbRecovery.js\":\"7f7ee3b8802d7a1c\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/markdownParser.js\":\"3b00dd927e9313f7\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/memoize.js\":\"d545b8580c233ac0\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/nameFieldCommit.js\":\"1f30806bee392504\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/nameList.js\":\"b5edc813ffc8c114\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/navigation.js\":\"692e9e7d6065a7bf\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/omnilinerNamespace.js\":\"c4a6a06d83e891ef\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/opfsPageScan.js\":\"8a0a032ebb0d44b3\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/panelClearance.js\":\"3f71a6cb90143166\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/panelHistory.js\":\"08ce1102bf386361\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/panelLanes.js\":\"9470e7ec17afacfa\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/panelLayoutProjection.js\":\"996d35838076d7b9\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/panelScrollAnchor.js\":\"a473403139ccaed7\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/panelUrlFlags.js\":\"08c0b9fc289e7c6d\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/platform.js\":\"009f6979acac012c\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/pluralize.js\":\"46794d0fc1d23480\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/propertyCreation.js\":\"fd53c4106e22f13c\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/propertyNavigation.js\":\"f72a23d2ae791a0c\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/propertyValueContext.js\":\"a3ea512c7a1eb412\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/react.js\":\"6ff3fac9ea395185\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/relativeDate.js\":\"dfb748a8840dc81b\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/relativeTime.js\":\"a757e87f99c4c1ff\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/renderScope.js\":\"950a1b910e3b6a48\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/resolvedThenable.js\":\"c46e466202ec51e9\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/routing.js\":\"d8cbab3ba21d85f2\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/safeMode.js\":\"964346607ea44b9e\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/scheduleIdle.js\":\"c426a8cccf94761a\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/screenWakeLock.js\":\"1986c764af8931f5\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/selection.js\":\"8fde4ade080f6374\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/softKeyboardGrab.js\":\"23f841b2c2171755\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/startupTimeline.js\":\"147fc1133e1c6bd0\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/state.js\":\"113a8863a8a942eb\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/string.js\":\"e61f69592f1e436e\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/surfaceZoom.js\":\"886ff56e9391b87c\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/time.js\":\"bd743217da2b50dd\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/toast.js\":\"513beb5ed5cc0cda\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/toggleStore.js\":\"e4a8407b5022d8fb\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/untilStopped.js\":\"14cee23872ef80f4\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/userActivity.js\":\"b09e9535e321e04b\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/viewTransition.js\":\"004f5af7eeb371f6\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/viewport.js\":\"34874e919695688c\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/webLock.js\":\"446f851df715b04a\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/workspaceRecovery.js\":\"b6a4469c0a5b2292\",\"/knowledge-medium/pr-preview/pr-1888/src/utils/workspaceSnapshotStore.js\":\"e216318db880e2ed\",\"/knowledge-medium/pr-preview/pr-1888/src/vendor/react-compiler-runtime.js\":\"7d4c57a4ffee772d\",\"/knowledge-medium/pr-preview/pr-1888/src/vendor/react-dom-client.js\":\"ebaf6db1c5a83432\",\"/knowledge-medium/pr-preview/pr-1888/src/vendor/react-dom-server-edge.js\":\"946106c11f65eaa6\",\"/knowledge-medium/pr-preview/pr-1888/src/vendor/react-dom-server.js\":\"cbd3d7c62a6ad83c\",\"/knowledge-medium/pr-preview/pr-1888/src/vendor/react-dom-static-edge.js\":\"736758686562ce64\",\"/knowledge-medium/pr-preview/pr-1888/src/vendor/react-dom-static.js\":\"a072e9d25c812da1\",\"/knowledge-medium/pr-preview/pr-1888/src/vendor/react-dom-test-utils.js\":\"ed97627147073cf8\",\"/knowledge-medium/pr-preview/pr-1888/src/vendor/react-dom.js\":\"96cdb5301528dc80\",\"/knowledge-medium/pr-preview/pr-1888/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1888/src/vendor/react-jsx-runtime.js\":\"d63fda54a552aaa6\",\"/knowledge-medium/pr-preview/pr-1888/src/vendor/react.js\":\"058647af5f4ad141\",\"/knowledge-medium/pr-preview/pr-1888/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1888/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1888/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
