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
		buildId: "c226a340b74a-cb16e729",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1889/\":\"bc0f79cd87c66207\",\"/knowledge-medium/pr-preview/pr-1889/index.html\":\"bc0f79cd87c66207\",\"/knowledge-medium/pr-preview/pr-1889/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1889/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1889/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1889/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1889/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1889/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1889/app.css\":\"d6b85c2ba5dde3ba\",\"/knowledge-medium/pr-preview/pr-1889/assets/FacadeVFS-AeDrendx.js\":\"f76f9e1bcc784638\",\"/knowledge-medium/pr-preview/pr-1889/assets/OPFSCoopSyncVFS-DpO0bLJo.js\":\"cf95440091ca1be8\",\"/knowledge-medium/pr-preview/pr-1889/assets/OPFSWriteAheadVFS-BucPrgRu.js\":\"cd74cf2f96969232\",\"/knowledge-medium/pr-preview/pr-1889/assets/wa-sqlite-C1GROLo9.js\":\"166ad137b17ce69f\",\"/knowledge-medium/pr-preview/pr-1889/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1889/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1889/assets/wa-sqlite-async-CkSo0Mb0.js\":\"81ca9026fabd3fbf\",\"/knowledge-medium/pr-preview/pr-1889/assets/worker-BXVK8G_N.js\":\"b2b2aa43449c7cef\",\"/knowledge-medium/pr-preview/pr-1889/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1889/chunks/app-D29iEcsW.js\":\"20a740f51c1f5861\",\"/knowledge-medium/pr-preview/pr-1889/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1889/index.js\":\"c9406f19f5868a2a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1889/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1889/assets/AccessHandlePoolVFS-D-hMJpuL.js\":\"42adace9a244d382\",\"/knowledge-medium/pr-preview/pr-1889/assets/IDBBatchAtomicVFS-ClSdz1mG.js\":\"06ce5738c6d66e9e\",\"/knowledge-medium/pr-preview/pr-1889/assets/MemoryVFS-BPWh4knJ.js\":\"a28c27058713e598\",\"/knowledge-medium/pr-preview/pr-1889/assets/mc-wa-sqlite-B_OCVqLW.js\":\"652d63918b201332\",\"/knowledge-medium/pr-preview/pr-1889/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1889/assets/mc-wa-sqlite-async-Bqqg7sF4.js\":\"a50c27beeab7ab81\",\"/knowledge-medium/pr-preview/pr-1889/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1889/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1889/chunks/AccessHandlePoolVFS-B1kMNHBq.js\":\"0a4fae0c6eafc2a2\",\"/knowledge-medium/pr-preview/pr-1889/chunks/FacadeVFS-DES7YKMg.js\":\"8dc4f6fa2c7f7b16\",\"/knowledge-medium/pr-preview/pr-1889/chunks/IDBBatchAtomicVFS-CceGGRx3.js\":\"868dac1b45770300\",\"/knowledge-medium/pr-preview/pr-1889/chunks/MemoryVFS-tYBTRdRW.js\":\"2d48e39f9ee942eb\",\"/knowledge-medium/pr-preview/pr-1889/chunks/OPFSCoopSyncVFS-BUncwhgP.js\":\"c2e3d6aedea284e3\",\"/knowledge-medium/pr-preview/pr-1889/chunks/OPFSWriteAheadVFS-D8b-rE13.js\":\"66dcbd7ec6b7890f\",\"/knowledge-medium/pr-preview/pr-1889/chunks/Preview-B9eMnyO8.js\":\"749621be7ace3c27\",\"/knowledge-medium/pr-preview/pr-1889/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1889/chunks/card-CbNFZ74I.js\":\"cfa70c08ba338fd6\",\"/knowledge-medium/pr-preview/pr-1889/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1889/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1889/chunks/dist-BtHhEWbE.js\":\"d60c958d71206364\",\"/knowledge-medium/pr-preview/pr-1889/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1889/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1889/chunks/mc-wa-sqlite-BOYvwUPa.js\":\"4044546b490decba\",\"/knowledge-medium/pr-preview/pr-1889/chunks/mc-wa-sqlite-async-Fp4NQOhI.js\":\"fd0979c163b26e5d\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-3yrEODf2.js\":\"468109f410689b92\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-7Baedbqf.js\":\"87ec83030e937a0e\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-B9YcNj3f.js\":\"f69d89ee557ece10\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-CwyD5hZu.js\":\"0f87ba0054d642cb\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-CyHFMDKQ.js\":\"1a84ee2a4ea2f2b8\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-DrXfy97J.js\":\"c8d27a6014b78f0b\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-HG8JJU3k.js\":\"f4f33a07f264c982\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-dom-server-legacy.browser.production-kD65u8-T.js\":\"604d16669a3bfb30\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-dom-server.browser.production-ChlY8Vu0.js\":\"56f1ef5f010d2c77\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-dom-server.edge.production-B8Zaxfmf.js\":\"bc091e6626704237\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-lZB9ZxJk.js\":\"d5c708eb4ed54d92\",\"/knowledge-medium/pr-preview/pr-1889/chunks/server.browser-DXWpIOFX.js\":\"9a83e2782154a1e9\",\"/knowledge-medium/pr-preview/pr-1889/chunks/textarea-BV40E8c_.js\":\"beee486f23fa3ed2\",\"/knowledge-medium/pr-preview/pr-1889/chunks/ui-BNxGhMpC.js\":\"e77fd5c2e218386b\",\"/knowledge-medium/pr-preview/pr-1889/chunks/wa-sqlite--W2LLHuB.js\":\"aebb3616fc5e0fc4\",\"/knowledge-medium/pr-preview/pr-1889/chunks/wa-sqlite-async-CkGaFh97.js\":\"a54023259b54401b\",\"/knowledge-medium/pr-preview/pr-1889/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1889/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1889/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1889/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1889/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1889/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1889/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1889/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1889/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1889/src/App.js\":\"c68217f0264c7d63\",\"/knowledge-medium/pr-preview/pr-1889/src/appUpdate.js\":\"15cfc591ded7d409\",\"/knowledge-medium/pr-preview/pr-1889/src/appVersion.js\":\"0f0014247394b48f\",\"/knowledge-medium/pr-preview/pr-1889/src/bootstrap/initialLayout.js\":\"039da2b12e535c3e\",\"/knowledge-medium/pr-preview/pr-1889/src/bootstrap/openWorkspaceData.js\":\"e8af154a9d509bf1\",\"/knowledge-medium/pr-preview/pr-1889/src/bootstrap/resolveWorkspace.js\":\"df436278acbed383\",\"/knowledge-medium/pr-preview/pr-1889/src/bootstrap/workspaceBootstrap.js\":\"5b4c9b799a7d2ec1\",\"/knowledge-medium/pr-preview/pr-1889/src/components/BlockComponent.js\":\"1de2d4f68283823e\",\"/knowledge-medium/pr-preview/pr-1889/src/components/BlockCrumbs.js\":\"0a413009181ec347\",\"/knowledge-medium/pr-preview/pr-1889/src/components/BlockEditor.js\":\"040f20c97d95d05d\",\"/knowledge-medium/pr-preview/pr-1889/src/components/BlockLoadingPlaceholder.js\":\"be909a3c8579ad2e\",\"/knowledge-medium/pr-preview/pr-1889/src/components/BlockProperties.js\":\"7a21cdec01c5ff7b\",\"/knowledge-medium/pr-preview/pr-1889/src/components/BlockSearchPicker.js\":\"d00a587e2e899a5f\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ConfirmBulkDeleteDialog.js\":\"bffde48db8dbf9a9\",\"/knowledge-medium/pr-preview/pr-1889/src/components/DividerHandle.js\":\"4ee2fd3a9b18c89a\",\"/knowledge-medium/pr-preview/pr-1889/src/components/DraftEditor.js\":\"68e346e62f2df498\",\"/knowledge-medium/pr-preview/pr-1889/src/components/GutterPill.js\":\"669a85e939bb1e16\",\"/knowledge-medium/pr-preview/pr-1889/src/components/Header.js\":\"43b82a2934d240da\",\"/knowledge-medium/pr-preview/pr-1889/src/components/LazyBlockComponent.js\":\"fb8b8659e3d51e55\",\"/knowledge-medium/pr-preview/pr-1889/src/components/Login.js\":\"ec785a28ea0ad84a\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ZoomableSurface.js\":\"650f911ab74f373e\",\"/knowledge-medium/pr-preview/pr-1889/src/components/editModeKeepalive.js\":\"d4575cbf1549da8b\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyDisplay/PropertyDisplayScope.js\":\"58f7b30d77145a0d\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"578d164d16fa5089\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/RefPropertyEditor.js\":\"ea5f6e591d9645aa\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/RefTargetTypePicker.js\":\"52bd8581d5998a63\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/SelectPropertyEditor.js\":\"38bbe2c4f3a301b2\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/TypesPropertyEditor.js\":\"12b6f0a62e8bf95f\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/defaults.js\":\"b5a5781670692c50\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/kernelValuePresets.js\":\"e111949b0b079306\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/selectablePresets.js\":\"1ca8d784b81dc1f7\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/typesPropertyUi.js\":\"2cfde627fb723f36\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/AddPropertyForm.js\":\"573160a69385be2e\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/PropertyPicker.js\":\"e7a8e2e19c985743\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/PropertyRow.js\":\"b94d6d8cdfc7e3de\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/Rows.js\":\"877d85e89a1d33e7\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/actions.js\":\"2230617c67fa7127\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/declarationOnly.js\":\"e2abeee4237a03dd\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/layout.js\":\"4426ba058a76b770\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/model.js\":\"9da42802388a5702\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/shapeUi.js\":\"429ec0ab88394f06\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/shapes.js\":\"dcdd3b6f88d11e13\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/usePropertyEditingActivation.js\":\"cbd2661964b3e313\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/visibility.js\":\"e134697a20ef1d5c\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanelSections.js\":\"a81c99ce098d3178\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/BlockEmbed.js\":\"92cedb9eea910b89\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/BlockLink.js\":\"41325e5b94a18268\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/BlockRef.js\":\"159de61c52b6cdb0\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/CompactReferenceLink.js\":\"61044f57c40999a4\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/ReferenceLink.js\":\"edd0af43bd98e5e9\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/cycleGuard.js\":\"e66f7d7643ebfb6a\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/cycleGuardContext.js\":\"5a5974ccd8cfe363\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/linkInteraction.js\":\"27160f5e1f2ccb5f\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/referenceLayout.js\":\"b16ab37182191503\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/useBlockRefAncestors.js\":\"90ea941b309c2810\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/BlockGutter.js\":\"d2286501344e951a\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/BlockInfoDialog.js\":\"835ff41658e35ec8\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/BlockReadText.js\":\"9363df36ff25baaf\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/BlockTypeBlockRenderer.js\":\"e5aa341b7870c016\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/BulletHoverCard.js\":\"32915ada4055b510\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/CodeMirrorContentRenderer.js\":\"ac814bab1c18b786\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7440b888e8efbd35\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/ColumnResizeHandles.js\":\"916bb0c6313d180f\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"6082376d5d17d09f\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/DefaultBlockRenderer.js\":\"3d91bbb604f2ed25\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/LayoutRenderer.js\":\"1fef752c15d2693f\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/MarkdownContentRenderer.js\":\"4c0c4caef27ccdd1\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/MissingDataRenderer.js\":\"c3d5b21e5a452864\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/PanelRenderer.js\":\"5c3d4a54ba2cd39d\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/PropertySchemaBlockRenderer.js\":\"027efe544cd32fcd\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/TopLevelRenderer.js\":\"a7cfa531201729e1\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/blockGutterMode.js\":\"181d56c511ad0982\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/blockTitleText.js\":\"6d81fa6589de1a6e\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/fieldCreationKeydown.js\":\"14a451d892d1ae4e\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/layoutRootContext.js\":\"dd1eb9c7c9e726fd\",\"/knowledge-medium/pr-preview/pr-1889/src/components/typeChip/TypeChip.js\":\"52bfcea5ea2ea273\",\"/knowledge-medium/pr-preview/pr-1889/src/components/typeChip/chipStyle.js\":\"a92b211616a5f1bb\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/anchored-floating.js\":\"ad4212a2ebfd7546\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/button.js\":\"abf4feacdb0adde9\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/card.js\":\"e3b91826f4b31b0b\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/checkbox.js\":\"386522519f4a030b\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/collapsible.js\":\"e88c20ad98196068\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/command.js\":\"b767fb0d9fdbb9da\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/context-menu.js\":\"6d3d9454719c9bde\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/dialog.js\":\"47b71766257c9376\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/dropdown-menu.js\":\"9bc4161d195d75af\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/floating-listbox.js\":\"cc570858be5fc951\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/index.js\":\"f91966ff4f550060\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/input.js\":\"4b0471a26d942692\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/kbd.js\":\"50068a6bdc74bde7\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/label.js\":\"a3be0f6d86020b89\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/textarea.js\":\"80c96c0a4dbb2910\",\"/knowledge-medium/pr-preview/pr-1889/src/components/useEditModeYieldKeepalive.js\":\"379f4d5293f0f6f6\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/BootFallback.js\":\"8ccb0dae81aa7b35\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/FocusedRowLazyMount.js\":\"b73d7379bb972b5c\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/LazyViewportMount.js\":\"c3a169b6a1c596f5\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/LocalDbCorruptionFallback.js\":\"f0137d7eed8d1735\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/error.js\":\"8ab9ddd5e377ea77\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/lazyMountRegistry.js\":\"956b13b5e782ff0c\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/suspense.js\":\"90dcd7b1231f8000\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/CreateWorkspaceDialog.js\":\"9cb51f6465622839\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/PendingInvitations.js\":\"fd37bb6d9a83e6c9\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/SyncProgress.js\":\"06c0334ba9a71067\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/UnlockProgress.js\":\"103ca5d786ca9522\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/WorkspaceKeyGate.js\":\"801adf7f44778215\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/WorkspaceSettingsDialog.js\":\"0f353288167ef524\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/WorkspaceSwitcher.js\":\"e88b4da533816004\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/WorkspaceSyncGate.js\":\"fe969b459b40a2b5\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/ConversionFlow.js\":\"7fe8334b4f1a9b43\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/ConversionFlowHost.js\":\"518cba5f43503ed6\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/EncryptionSection.js\":\"36544ac6f661af43\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/attachmentPrompts.js\":\"41228608edfe2076\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d4f6a71e73eb06b8\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/conversionFlowDeps.js\":\"22088a6801fab72b\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/conversionFlowStore.js\":\"ed3c72e46a320f9c\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/flowUi.js\":\"c8528add594d1b23\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/useConversionRun.js\":\"3a714cbd12ff83b8\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/keyUi.js\":\"7cc21fa8150989c3\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/useCloseOnKeyLoss.js\":\"3440a01c1b57ffa6\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/useCloseOnServerE2ee.js\":\"2fc26f302ab72d95\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/workspaceUnlocked.js\":\"63d71960f22774c7\",\"/knowledge-medium/pr-preview/pr-1889/src/context/backgroundSubtree.js\":\"83c966f8424583d1\",\"/knowledge-medium/pr-preview/pr-1889/src/context/block.js\":\"0775e84a81479bce\",\"/knowledge-medium/pr-preview/pr-1889/src/context/layoutWsContext.js\":\"66267276f2f81013\",\"/knowledge-medium/pr-preview/pr-1889/src/context/propertyDisplay.js\":\"7188fe03c5e5e3ed\",\"/knowledge-medium/pr-preview/pr-1889/src/context/repo.js\":\"6c9e860ee9a7419e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/aliasClaim.js\":\"6743c347bdf89e58\",\"/knowledge-medium/pr-preview/pr-1889/src/data/aliasSeatNamespace.js\":\"11a30c0fdf0c50be\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/blockData.js\":\"1329499cb2cb1b91\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/blockType.js\":\"80820e7264720e34\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/changeScope.js\":\"e61ec3243efabdc3\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/codecs.js\":\"058d4aa6daf114b9\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/derivedData.js\":\"5e2269dae52487cf\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/errors.js\":\"a4b852142a39ebd7\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/events.js\":\"38357e828095fd0e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/handle.js\":\"ddab86107aca895f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/index.js\":\"96c83969363fecb8\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/mutator.js\":\"4ce1e43bb1b9d973\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/processor.js\":\"50a1d014c641bb53\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/propertySchema.js\":\"fd54d6a91430187b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/query.js\":\"ee1534c269ba5dda\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/sameTxProcessor.js\":\"b03fd15a2d1374a1\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/schema.js\":\"ddab86107aca895f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/tx.js\":\"ddab86107aca895f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/typedBlockQuery.js\":\"a1146811facd60f0\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/user.js\":\"c2f35fe4c3400525\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/valuePresetCore.js\":\"a61bbb2f94f65c19\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/valuePresets.js\":\"52b0d5bae63f63db\",\"/knowledge-medium/pr-preview/pr-1889/src/data/attachmentCleanerIOVerb.js\":\"076829d7e80171d9\",\"/knowledge-medium/pr-preview/pr-1889/src/data/block.js\":\"c30370663ef2b8e7\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockCache.js\":\"9dc9b57a4156e855\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockId.js\":\"a20d9788bd390587\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockLiveness.js\":\"1c48c0fa4add1b28\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockMerge.js\":\"68dfe550a942f691\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockSchema.js\":\"f4e24cfc79fee6a6\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockTypeLookup.js\":\"12b6e353d0568305\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockTypes.js\":\"402fca58857f5dbd\",\"/knowledge-medium/pr-preview/pr-1889/src/data/childrenView.js\":\"a285bbdbbb16028b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/clientContext.js\":\"2086af8fd8d3358d\",\"/knowledge-medium/pr-preview/pr-1889/src/data/dbFileSiblings.js\":\"d71a879044a0c3ff\",\"/knowledge-medium/pr-preview/pr-1889/src/data/definitionSeeds.js\":\"4f6f4490c9037af2\",\"/knowledge-medium/pr-preview/pr-1889/src/data/derivedIds.js\":\"6f314f65f268e9bb\",\"/knowledge-medium/pr-preview/pr-1889/src/data/drawnSubtree.js\":\"32b6dec5f98dc3a0\",\"/knowledge-medium/pr-preview/pr-1889/src/data/facetBridge.js\":\"7b5183b71b36ae39\",\"/knowledge-medium/pr-preview/pr-1889/src/data/facets.js\":\"9484209afeda46ea\",\"/knowledge-medium/pr-preview/pr-1889/src/data/globalState.js\":\"a5ae3b66fe5eb0b9\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/aliasClaimRederiveProcessor.js\":\"5002775435e14cbb\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/ancestorBatch.js\":\"db3896d71ffdf1fc\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/blockTypeTypeifyProcessor.js\":\"4ff51bfca8e68dab\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/clientSchema.js\":\"1b21aa52070737ae\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/commitPipeline.js\":\"5260895e276b0c62\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/devAssertions.js\":\"fa80e3eb3a296cc7\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/firstSync.js\":\"836004b92f7a36aa\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/freshInitialLoad.js\":\"81d0e45b5e01a1d2\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/graphBackfillClaim.js\":\"d80a83079d0dba29\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/handleStore.js\":\"378752ea3501dcd5\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/idleMarkerJobs.js\":\"24c8c5220b88d0b5\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/initialDownload.js\":\"832ec9c015fbddf6\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/initializeClientDatabase.js\":\"8e0a02721bcbd4e7\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/jsonCanonical.js\":\"8ed567d2f13014d2\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/kernelInvalidation.js\":\"2f74bcb9d09904ca\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/kernelProcessors.js\":\"9fe06af5e9218e56\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/kernelQueries.js\":\"2b629148be52f71f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/mergeTypeMembershipProcessor.js\":\"bc316bc6ceea2434\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/normalizeReferencesProcessor.js\":\"358ece1d8ddfc63f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/poolInstrumentation.js\":\"ad593fc6f6aae219\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/processorRunner.js\":\"9614005e5da6bef2\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyCellBackfill.js\":\"a211f365a0285e31\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyChildMint.js\":\"ecadfd812ea27da2\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyChildrenProcessor.js\":\"d64780c69448ee6a\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e5daad218c0fb953\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyDefinitionSynthesis.js\":\"d6e4d511d01fdf48\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyKeyScan.js\":\"bb8aed6602b1eb1a\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertySchemaResolution.js\":\"32391ecb1957114e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyValueEdits.js\":\"13973585f8334af6\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/raiseProtocol.js\":\"7e5a721dbecf6882\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/readBatch.js\":\"62b01444a94fc5da\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/refProjection.js\":\"f7c833230fd7d42d\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/referenceTargetLookups.js\":\"dce30658a0f87175\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/referenceTargetProcessor.js\":\"de9b22b94f43434d\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/replayMerge.js\":\"25009cae8fb97e46\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/sqlBinds.js\":\"528aadce5e2231d5\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"fb64e50a65cb6d7e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/syncObserver/arrivalProcessors.js\":\"ea0f8e3b7dfa6a24\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/syncObserver/invalidate.js\":\"c46cd750800642db\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/syncObserver/materialize.js\":\"051c59377f0018f0\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/syncObserver/observer.js\":\"c9e3687973416466\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/syncObserver/reconcile.js\":\"5432302502f368a5\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/timingMetrics.js\":\"4692a2edd830ef26\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/treeQueries.js\":\"6491f720727d404c\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/txEngine.js\":\"dc4820f9f95280f3\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/txSnapshots.js\":\"bd198cce3dfac33d\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/typedBlockQuery.js\":\"24b68b6cb8b65b80\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/undoManager.js\":\"dd168b53c1c62ac8\",\"/knowledge-medium/pr-preview/pr-1889/src/data/invalidation.js\":\"5631b1e6f8d9c10f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/kernelDataExtension.js\":\"77945ff88027a684\",\"/knowledge-medium/pr-preview/pr-1889/src/data/kernelPage.js\":\"f7fca1b582a2131b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/kernelValuePresetCores.js\":\"163319664fe0d7c7\",\"/knowledge-medium/pr-preview/pr-1889/src/data/localDbCorruptionSignal.js\":\"3d022a5b36fdcae8\",\"/knowledge-medium/pr-preview/pr-1889/src/data/localDbStorage.js\":\"7299c6b8b1fc3f5f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/localDbVfs.js\":\"5a81ab11b2fb26fd\",\"/knowledge-medium/pr-preview/pr-1889/src/data/localSchema.js\":\"9b0af3f0c56e94a3\",\"/knowledge-medium/pr-preview/pr-1889/src/data/maintenance.js\":\"2f474138644ff549\",\"/knowledge-medium/pr-preview/pr-1889/src/data/mergeProperties.js\":\"c19587ac552dbe71\",\"/knowledge-medium/pr-preview/pr-1889/src/data/metricsConsoleHook.js\":\"1381b0296ff17924\",\"/knowledge-medium/pr-preview/pr-1889/src/data/migrationsPage.js\":\"414bf64a54f52d56\",\"/knowledge-medium/pr-preview/pr-1889/src/data/mutators.js\":\"ffb97ba12aa77efa\",\"/knowledge-medium/pr-preview/pr-1889/src/data/orderKey.js\":\"d50f3e974208d64e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/orderKeyPlacement.js\":\"aae695845a80b6ff\",\"/knowledge-medium/pr-preview/pr-1889/src/data/outlineSurface.js\":\"86d270d391cd43bc\",\"/knowledge-medium/pr-preview/pr-1889/src/data/pendingEditorContent.js\":\"51ce2b9183e344de\",\"/knowledge-medium/pr-preview/pr-1889/src/data/pendingUploadsSql.js\":\"c0f100e34b7df4c5\",\"/knowledge-medium/pr-preview/pr-1889/src/data/pluginStateExtensions.js\":\"8027cc7e5f2ae108\",\"/knowledge-medium/pr-preview/pr-1889/src/data/powerSyncLogger.js\":\"aaedf2d2b602cfaf\",\"/knowledge-medium/pr-preview/pr-1889/src/data/projectorRuntime.js\":\"658207255c5f7552\",\"/knowledge-medium/pr-preview/pr-1889/src/data/properties.js\":\"535033d3197172b6\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertiesPage.js\":\"87df33e3dcfa422e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertyChildren.js\":\"ba8d2cb72196f653\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertyDefinitionFanout.js\":\"9480a303611fb524\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertyDefinitionMetadata.js\":\"2f619e8d3dc12055\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertyDefinitionRegistry.js\":\"96a9dce2cbb5273f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertyDisplayMode.js\":\"797c4951e513afc7\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertyRowCreation.js\":\"0151af47276fce80\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertySchemaCreation.js\":\"6aa1b9f50f06e7fe\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertySeeds.js\":\"ec4d004010b19d30\",\"/knowledge-medium/pr-preview/pr-1889/src/data/recentsPage.js\":\"e25f89de89ce217d\",\"/knowledge-medium/pr-preview/pr-1889/src/data/refTargetComparableProperty.js\":\"b3d527ea4664c048\",\"/knowledge-medium/pr-preview/pr-1889/src/data/referenceBlock.js\":\"a100f48cc9c3df93\",\"/knowledge-medium/pr-preview/pr-1889/src/data/rejectedUploads.js\":\"d26b520fa16f8cb5\",\"/knowledge-medium/pr-preview/pr-1889/src/data/releasePowerSyncConnection.js\":\"3b763292f11e101b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/repo.js\":\"c159b7e606a3b7c4\",\"/knowledge-medium/pr-preview/pr-1889/src/data/repoProvider.js\":\"a3360ecf162e1727\",\"/knowledge-medium/pr-preview/pr-1889/src/data/rowProperty.js\":\"cae7c035cb61538b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/searchFilter.js\":\"1e1dc7a4443f19ce\",\"/knowledge-medium/pr-preview/pr-1889/src/data/seedIdentityLedger.js\":\"ca9b499bc936e243\",\"/knowledge-medium/pr-preview/pr-1889/src/data/stateBlocks.js\":\"e5cb6b9c51330f11\",\"/knowledge-medium/pr-preview/pr-1889/src/data/structuralEditPolicy.js\":\"343bb399f0c5b5f4\",\"/knowledge-medium/pr-preview/pr-1889/src/data/structuralInsert.js\":\"705226a3284eca26\",\"/knowledge-medium/pr-preview/pr-1889/src/data/subtreeDelete.js\":\"7d69548fed8b5983\",\"/knowledge-medium/pr-preview/pr-1889/src/data/syncStreamLock.js\":\"5a5e982c3b3debc0\",\"/knowledge-medium/pr-preview/pr-1889/src/data/syncedTableSqlRecognizer.js\":\"f730d2eece634b9e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/syncedTableWriteGuard.js\":\"ce9d89707421434a\",\"/knowledge-medium/pr-preview/pr-1889/src/data/targets.js\":\"f044674c29dd7383\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeColors.js\":\"7224660b795528ac\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeDefinitionMetadata.js\":\"700efcfb279caa83\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeDefinitionRegistry.js\":\"3147008b1da15150\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeExtraction.js\":\"4700f0cc88e3fd11\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeInitialValues.js\":\"689f82fc3c7a7d65\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typePropertyGroups.js\":\"32dd8ec409c3ff89\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeSeeds.js\":\"d117e91948728a2a\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeTagger.js\":\"63c67a231280b3f4\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typedRecords.js\":\"df8807ba5dd73f45\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typesPage.js\":\"20fa18391ceecfc4\",\"/knowledge-medium/pr-preview/pr-1889/src/data/userPrefs.js\":\"105f21f7a82c2a35\",\"/knowledge-medium/pr-preview/pr-1889/src/data/userSchemasService.js\":\"b6f191eed69b5cae\",\"/knowledge-medium/pr-preview/pr-1889/src/data/userTypesService.js\":\"9128070118ac0639\",\"/knowledge-medium/pr-preview/pr-1889/src/data/valuePresetRegistry.js\":\"04219767eeca6460\",\"/knowledge-medium/pr-preview/pr-1889/src/data/visibleChildren.js\":\"2bebf8f6257c3104\",\"/knowledge-medium/pr-preview/pr-1889/src/data/workspaceConversion.js\":\"247a8e2e8c963acc\",\"/knowledge-medium/pr-preview/pr-1889/src/data/workspaceFirstSync.js\":\"556b8dc5033b1b1b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/workspaceIdNamespace.js\":\"fef92b9194e82837\",\"/knowledge-medium/pr-preview/pr-1889/src/data/workspaceSchema.js\":\"77f2e899448502f7\",\"/knowledge-medium/pr-preview/pr-1889/src/data/workspaces.js\":\"8e1cb56db9f3fdfc\",\"/knowledge-medium/pr-preview/pr-1889/src/data/writeAheadLog.js\":\"003d26a369ba545c\",\"/knowledge-medium/pr-preview/pr-1889/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/BlockPasteShellDecorator.js\":\"2f9f3918865242cf\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/atTrigger.js\":\"4a6a2a2b6331e84d\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/autocomplete.js\":\"306048557e96864f\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/codeMirrorExtensions.js\":\"293285c69e3cfd25\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/contentFlush.js\":\"444733b77d5e5b31\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/defaultInteractions.js\":\"16538854fe27228e\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/editSettleSignal.js\":\"0f5679d800b91a49\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/insertImage.js\":\"e722a20b48202b49\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/referenceCompletionRange.js\":\"3649d23162890f7e\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/referenceTargetTypes.js\":\"c661867e53277b58\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/syntaxContext.js\":\"13e578f72bf74841\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/triggerMatch.js\":\"705cb8b2230df5b1\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/AppRuntimeProvider.js\":\"956f1ca098f39e3b\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/BlockFocusShellDecorator.js\":\"47c062f83b4dbec6\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/ExtensionRenderBoundary.js\":\"3b2a353985bc2459\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/PanelContentRecovery.js\":\"50b25383e3464155\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/apiCatalog.js\":\"bf376cd298c77a9d\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/approveExtensionHere.js\":\"6fa06d23c8afe62c\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/armedCutAppMount.js\":\"bd9b51c267da1ca5\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/batchableKeyedStore.js\":\"35b7de28fc3bf0bc\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/blockInteraction.js\":\"9879824c9803c2d4\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/blockSelectionAction.js\":\"a6f67d91673badb4\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/compileExtensionModule.js\":\"7d54dd8458f1559c\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/compiledModuleCache.js\":\"86fbb1b5b15ada66\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/continuousGestures.js\":\"b730767e97b7bd0f\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/core.js\":\"1aa47a164074c771\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/defaultRenderers.js\":\"4015728219400c38\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/definitionFanoutAppMount.js\":\"719094de708ab950\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/dialogAppMount.js\":\"684c30094b445577\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/dynamicExtensionSeeds.js\":\"2c438afd52122d6e\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/dynamicExtensions.js\":\"23fee181030a3f8f\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/exampleExtensions.js\":\"3ef4cc97976856a6\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/extensionApprovalStatus.js\":\"3fdc4e192a1c3657\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/extensionLoadErrorToast.js\":\"8f8e070f9cf606af\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/extensionLoadErrors.js\":\"b60df1ce2a2321b8\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/extensionLookup.js\":\"a2f5c0fc9ad7f972\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/extensionToggles.js\":\"ffb66460faad373f\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/extensionUtilitiesCss.js\":\"302d4b3e4286512c\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/kernelPageDeletionGuard.js\":\"6a6d505b1268f817\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/liveRuntime.js\":\"ff149adc74587c6b\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/openExtensionsSettings.js\":\"6bba7eae5890c9b8\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/overridesCache.js\":\"c602100b1751287b\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/pluginIds.js\":\"872bc5c6b9f6272a\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/processorRejectionToast.js\":\"83673d42f0a1e38e\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/runtimeActions.js\":\"ddd983726ae54e28\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/runtimeContext.js\":\"0442b8cb0707c1f3\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/staticAppExtensions.js\":\"3f834b4bf595408b\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/staticDataExtensions.js\":\"da6272466eb0176f\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/toastAppMount.js\":\"11501baef6b6ce60\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/useOverrides.js\":\"f05bfaaf26a83edc\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/useShortcutSurfaceActivations.js\":\"4b8bda403d7cf299\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/discoverToggleTree.js\":\"390fbcd111467165\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/facet.js\":\"58f175fa872b0995\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/resolveAppRuntime.js\":\"9e976c8996e75c7f\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/runtimeEvents.js\":\"cb8aee96391a646c\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/togglable.js\":\"06cb3955a168edff\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/variantFacet.js\":\"b3e1a9f748e49944\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/verbFacet.js\":\"7378802d895d91de\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/block.js\":\"0e76e2a6bc00ad26\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/focusedChild.js\":\"f6ab3eb314243b02\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/propertySchemas.js\":\"d7cd15ed029b48ad\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/typeRegistry.js\":\"2fa644dbaad435ef\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useAncestorCrumbs.js\":\"bbd59c2acde337ca\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useAutocompleteListbox.js\":\"fcb4dd1ef301f62d\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useDebouncedSearch.js\":\"ae45294a340d39aa\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useDebouncedValue.js\":\"6c356ff1b57aa6b7\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useFacetValue.js\":\"8523c8008ae9af1c\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useIsFocalRender.js\":\"fb62f070ecf929e7\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useIsReadOnly.js\":\"47b8f7a8a76902f8\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useMaterializeBacklog.js\":\"5e405b01a73d7dde\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useMinuteClock.js\":\"322ab7c4bdb502b6\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/usePanelLayoutProjection.js\":\"6089019f61435b47\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/usePendingInvitations.js\":\"afc5b0d4cadcf392\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useRendererRegistry.js\":\"60818d6d498883bf\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useRetainedFieldRows.js\":\"eee0e3989ff66074\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useWorkspaces.js\":\"b1fa855c390a3211\",\"/knowledge-medium/pr-preview/pr-1889/src/lib/utils.js\":\"93536c41e3e8ad47\",\"/knowledge-medium/pr-preview/pr-1889/src/main.js\":\"80a304cb5cc6c259\",\"/knowledge-medium/pr-preview/pr-1889/src/markdown/MarkdownImage.js\":\"ac847bef5a74490f\",\"/knowledge-medium/pr-preview/pr-1889/src/markdown/blockSeparators.js\":\"704ba51460fb3677\",\"/knowledge-medium/pr-preview/pr-1889/src/markdown/context.js\":\"b082ad272cc8848b\",\"/knowledge-medium/pr-preview/pr-1889/src/markdown/defaultMarkdownExtension.js\":\"789ea6e835753eb9\",\"/knowledge-medium/pr-preview/pr-1889/src/markdown/extensions.js\":\"bf6b5c498a509f75\",\"/knowledge-medium/pr-preview/pr-1889/src/markdown/renderMarkdownHtml.js\":\"800189e8dff0f756\",\"/knowledge-medium/pr-preview/pr-1889/src/minimal-editor.js\":\"1112ef4de2983aa7\",\"/knowledge-medium/pr-preview/pr-1889/src/paste/armedCut.js\":\"a4f173336f3865d9\",\"/knowledge-medium/pr-preview/pr-1889/src/paste/captureMediaVerb.js\":\"6bdd2d06d677a570\",\"/knowledge-medium/pr-preview/pr-1889/src/paste/clipboard.js\":\"96f2abd1f7344d6a\",\"/knowledge-medium/pr-preview/pr-1889/src/paste/decision.js\":\"c959cc0155657197\",\"/knowledge-medium/pr-preview/pr-1889/src/paste/operations.js\":\"ef64761cf0b88fa3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/account-header/AccountHeaderItem.js\":\"ba383c7fb6d7c1f9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/account-header/index.js\":\"f3479b0450a43363\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"90b93da55bd73ecb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/askAgent.js\":\"828f38102d83772d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/askedStore.js\":\"4b9fa4afec089bb8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3206b01c5b343edd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/chipState.js\":\"faca1a68214b4380\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/dataExtension.js\":\"a0de8f746aee1cf8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/index.js\":\"d645e7fa16a6042e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7a799f4554f482d3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/schema.js\":\"638437cb3a3c84d8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/AgentTokensDialog.js\":\"0a0a867810696faa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/BridgePairingDialog.js\":\"e9ec99ddf25a6595\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/addMedia.js\":\"021b139c541215b0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/backlinks.js\":\"10e1381e1a411f04\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/block.js\":\"276b60d901eca86e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/context.js\":\"b9332228c9e4886f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/displayIds.js\":\"34def9dfc28ad7b9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/index.js\":\"25050f6acb1233e2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/outline.js\":\"dab4d998354b5628\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/properties.js\":\"342a9379e404830e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/refs.js\":\"930f0f5ab1221314\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"604c485b007cb5cb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/search.js\":\"6d49f1b2364914e0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/shared.js\":\"ec5eeb8f7060fca1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a3bf457316b8ea28\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/text.js\":\"8217a12caa245f5a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentWrites.js\":\"cc6130cf56640681\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/authoringCatalog.js\":\"74d03e786f1e68f4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/blockRefTargets.js\":\"e891494807aef29f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/bridge.js\":\"2e8c897779442d8b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/bridgeLoop.js\":\"3817aa9e59a300c8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/changeHistory.js\":\"e1a14f7b6a8e7f5d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/commands.js\":\"27567214d5195aec\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/commentsCommands.js\":\"bddff9736d424006\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/dataExtension.js\":\"9ab24c2b2fd674aa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/dataModelGuide.js\":\"df69de647bf18934\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/dayPropertyInputs.js\":\"2e111f0e04eba1c4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/describeRuntime.js\":\"35580b8e308718eb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/extensionLint.js\":\"5914ead17b363fc8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/grainAudit.js\":\"296564c6aa37034e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/healthCommand.js\":\"a01200b66a88f0d2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/index.js\":\"63773125e7f2722c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/presetIdentity.js\":\"a921452b23e7788d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"dc6048c7a51ffdab\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/readMedia.js\":\"b1d99a1d08538f56\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/schema.js\":\"6852287de8c79d4c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/serialization.js\":\"874c2d8ed89dab1f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/targets.js\":\"4477af7a47bdbeb6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/tokens.js\":\"30d255426263046d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/watchEvents.js\":\"dc4d6717e43c1bff\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/workspaceGuard.js\":\"9d0815a975fef356\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/writeCommands.js\":\"cae12fc53ba22611\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/AliasCollisionToast.js\":\"a02d3040150c424d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/DuplicateNameBanner.js\":\"b73517391fca868c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/collisionMerge.js\":\"d5041cf8793e9010\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/dataExtension.js\":\"02ff50fb07578a00\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/index.js\":\"cccde7c7573b3150\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/mergeCollisionAction.js\":\"69dfdbcef67e111c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/pageStyling.js\":\"c6870c1db74a4528\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/rejectionToast.js\":\"3061d1037513070c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/syncProcessor.js\":\"e010f4e8befe7c9e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/actions.js\":\"0e0d1b2b94b0c0b8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/addComment.js\":\"41fee51d9f144408\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/anchor.js\":\"0e62a4d8fcf0a207\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/anchorState.js\":\"66d776ce8828945c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/commentLinks.js\":\"64cfd3fb6e345a1e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/confirmThreadDeletion.js\":\"6c1ff91ab983ef9d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/container.js\":\"4a1441ddafa82062\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/dataExtension.js\":\"0195cba1ecd82ad6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/deleteComment.js\":\"f4877e096b1290a3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/highlights.js\":\"0f8e36dfc8c58103\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/index.js\":\"7e1bc05d629dd915\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/linkedCommentsPill.js\":\"c832cafd12eb9e26\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/margin.js\":\"4914d981180df9bf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/marginAnchorLinks.js\":\"8f64c66c65ef60b4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/marginSchema.js\":\"c9e0b86d22d676f6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/newComment.js\":\"0d63377322bd44d5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/ownThreadPicker.js\":\"8ea6d4a2d5c90e36\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/placement.js\":\"00fecd047c5f1718\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/queries.js\":\"1ec8444dd46ae4dd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/quotePosition.js\":\"7cc648124b3ac621\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/quotedIn.js\":\"6a21fc3906fdb520\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/quotedRange.js\":\"168dd3ac9178bef0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/rangeRefs.js\":\"e1cc6530148e7d40\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/readHighlights.js\":\"cf10d5d8cc16f117\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/readSelection.js\":\"cd2a2471d422e6a2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/readSelectionUi.js\":\"e946807d3bb8e90c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/reanchor.js\":\"778a023d460b2b20\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/schema.js\":\"5d4f029b6e463cfa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/scope.js\":\"7dd3495419010ccf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/scopeThreads.js\":\"d39d612ed90e4b72\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/splitRetarget.js\":\"00c4d1de02621603\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/suggestionCard.js\":\"993a8110295c01f3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/suggestions.js\":\"37bdcefe8fa3779d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/summaries.js\":\"96f0759428a54d13\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/summaryBatch.js\":\"6fc16ffbeb3a12c3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/surface.js\":\"9328267f8c79985c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/threadNavigation.js\":\"f96b6b97135f15cc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/threads.js\":\"c568d10bba59f295\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/ui.js\":\"3285c2c865f0e2cf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/uiStore.js\":\"9724378ac0ffaf9e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/app-intents/appIntents.js\":\"134c9c1c1810158a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/app-intents/index.js\":\"f3736692ab6ef7b9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/app-update-prompt/index.js\":\"453bfd1192fe33a1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/app-update-prompt/status.js\":\"ecfdfbca727ae7f0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"af01e4cc06a9b8d6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/MediaBlockRenderer.js\":\"c62b20a4fca824cf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/MediaDownLaneReplicator.js\":\"20193440fbc7790d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/MediaUploadReconciler.js\":\"62b2bb119df7b045\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/assetDownLane.js\":\"1496cfdc02b7de46\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/assetResolver.js\":\"c11e00c292ed90c0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/assetUpload.js\":\"2bb441f852f1494f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/attachmentCleanerIO.js\":\"04440babcfb1eee6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/audit/supabaseAuditIO.js\":\"6d651cd20dce17da\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/blobStore.js\":\"42e075b68ceef31e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/browserMedia.js\":\"e42c5241c18f5f14\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/byteStore.js\":\"4d0020d506093e3f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/cleanerIO.js\":\"fd06f8abb8520fc6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/cleanupAttachments.js\":\"47f13afb3241b097\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/dataExtension.js\":\"94a56fc7a6c28332\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/downLane.js\":\"58567e362736904d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/index.js\":\"baa6a85a67ac0f81\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/insertImageContribution.js\":\"38bea19f6036826c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/laneArming.js\":\"ed0c8a583650dc5f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/laneLock.js\":\"e32c5589de652424\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/mediaBlock.js\":\"f1c3a3d444ea2a30\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/mediaCapture.js\":\"1a1fbd7d5af782cb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/mediaLanes.js\":\"22529b6102a7f7e0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/mediaViewers.js\":\"cb3529a9de7f2b0a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/mediaViewersFacet.js\":\"8a6475fd1f418958\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/pasteCapture.js\":\"9669f349ecfa32c9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/resolver.js\":\"af8da078771ef853\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/retryUploadsAction.js\":\"8467242ef32df3e4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/storagePaths.js\":\"a1848c4edf1201ba\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/uploadDrain.js\":\"09b170e7ab6d76f0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/uploadLaneStatus.js\":\"edb6938c03ee5204\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/uploadReconcile.js\":\"9441773a7661da1d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/uploadRecovery.js\":\"329052aa60ac85a6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/uploadStore.js\":\"1f4e549758c0fffd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/useAssetObjectUrl.js\":\"224e86a7f67f6fa9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"87c821e2fb79b70d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d66bd7aa273795d5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks-view/facet.js\":\"b99bdb42b6305a83\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks-view/index.js\":\"ca7bc5feea887130\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks-view/prop.js\":\"cb64f6e8fe4ea7e3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/BacklinkFilters.js\":\"57037c569bfce422\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"65351a756d71f74c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/BlockEntry.js\":\"a09fcfa59cc12cc0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/LinkedReferences.js\":\"aa42daa05186f626\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b1a8b8a432257dfc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/dailyNoteDefaults.js\":\"a6c3668f1f493b5c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/dataExtension.js\":\"fc6c5bee120f6b05\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/edgeExclusions.js\":\"73c50c91bd74c9cb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/filterProperty.js\":\"f8077a5c3799fd49\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/index.js\":\"9766d1193ef3399d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0d56800ed58be745\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/inline-counts/applies.js\":\"b8323c51666e088f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/inline-counts/countQuery.js\":\"46e337ed04545486\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/inline-counts/expansionStore.js\":\"8161f8cc0daa89bf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/inline-counts/index.js\":\"3daffec968be7933\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"561c5abc5b7eacb8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/presentationInvalidation.js\":\"d88fb8aed7306212\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/propertyEditorOverride.js\":\"462cfefe8afd3a11\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/propertyFilter.js\":\"8a2ec845e870812a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/query.js\":\"de72db6f0fcee084\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/resolveFilter.js\":\"a11f07f626ed0a61\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/sourceBatch.js\":\"70e38bed07801164\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/sources.js\":\"23b4162c37223b8e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/useBacklinks.js\":\"97c1ce36e7d1d45e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"6688ba416d468f86\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/birthday/BirthdayCelebration.js\":\"762fdd0e13a1dbaf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/birthday/BirthdayOverlay.js\":\"9f723c56aba7afaa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/birthday/gate.js\":\"ca50121426c6224a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/birthday/index.js\":\"3e88fcc43c006494\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/birthday/wolfTheme.js\":\"78c3dde857f02371\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-drag/BlockDragLayer.js\":\"7abf0504ed563a71\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-drag/dragController.js\":\"cbe5c626570433e8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-drag/dropTarget.js\":\"ed8b33884a703c8f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-drag/index.js\":\"4475a051ef101495\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-drag/projection.js\":\"e1b6294dac87131d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-info/BlockMetaCard.js\":\"52a87edcb0f38a74\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-info/index.js\":\"e70b7e6bf974a425\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/AddTagDialog.js\":\"b2bfbbc657e1fce1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4988482e890a891c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/TagNameIssueHint.js\":\"5fe89a1659e9394c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/addTagAction.js\":\"380207c32c88ba48\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/appendTag.js\":\"499bd504668e927e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/config.js\":\"26f27e51398464ce\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/dataExtension.js\":\"e64444d53f2f270c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/index.js\":\"c881d5daca0de8bc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/propertyEditorOverride.js\":\"f4fd72e483f97501\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e1c10bb36941a2db\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c76f3b05b47f4d7c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/Breadcrumbs.js\":\"79ba5e5fd2cfb25c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"d26344e86c43e259\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"607fddd355a2778c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/index.js\":\"2bad6fe40fa233b0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7fa67a15f569b735\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/CharacterCountItem.js\":\"467328e7c79c6b09\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/ProfilePropertyEditor.js\":\"6da6148cda0e7779\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/actions.js\":\"cd09fca52aede7bb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/blockType.js\":\"16482803e2b39fd0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/charCount.js\":\"b4877b251108f914\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/dataExtension.js\":\"4de89b4c61d5664f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/index.js\":\"8c8432922280df65\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/profiles.js\":\"7dc0bd408a83c715\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/properties.js\":\"6a7f2fb23da11d6c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/subtree.js\":\"78122f886f2aea79\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/textCounts.js\":\"5cb894d7505e8255\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/colemak-keybindings/index.js\":\"ea9be4628c5042d2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/CommandPalette.js\":\"f9664928fcb17d2c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/HeaderItem.js\":\"a3e54c566995dfa3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/context.js\":\"1793219ba089041f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/index.js\":\"af5b4c99e4215daf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/selection.js\":\"2642b350ec1cacfa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/toggleStore.js\":\"d070f823e1b7651c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/useCommandPaletteActions.js\":\"561970c13d7435aa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/ContributorBadges.js\":\"ed1fab196189d774\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/author.js\":\"7c5ea678dfffb6e3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/codeMirrorExtensions.js\":\"850b555385f9227a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/dataExtension.js\":\"c8497f42e65d9500\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/index.js\":\"a3e0f1008ea3713a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/mentionAutocomplete.js\":\"1b7865f031494c7c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/processor.js\":\"606fe9e9526aa99e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/profiles.js\":\"ca02886b95a6cfdb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/queries.js\":\"82a2242d964204f7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/schema.js\":\"e0ff5dfac8fc83ea\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7a3a90e196e04e40\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7b0ad47c96b9312b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/cursor-follows-scroll/index.js\":\"f780fc73bd0562ef\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"ecbc633583ebbccd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"57e2339e03229734\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/CalendarGrid.js\":\"f146e3abab2c4299\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/DailyNotePicker.js\":\"f649100c13716a29\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"6f24652cc1eca412\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/DateNavDecorator.js\":\"146907b94ce40edf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/DateScrubOverlay.js\":\"678c167549cc6c20\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/DayPropertyControl.js\":\"ca8a625e9813efeb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/DayValueReferenceControl.js\":\"49436ecf81322e72\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/HeaderItem.js\":\"6a0d82e840ce36ba\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/ReschedulePicker.js\":\"e47891e485e3bcf5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/SpreadDatesDialog.js\":\"18ea358a3fc187df\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/actions.js\":\"d96923e55b6002ef\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/blockDateAdapter.js\":\"739a27ef5058c699\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/calendar.js\":\"e9ce7ce1b7f920d5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dailyNotes.js\":\"2cefcf0156c4d694\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dataExtension.js\":\"63e1d9bca7c00d25\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dateScrubActions.js\":\"57b9974f987f8a74\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dateScrubGesture.js\":\"88f48342ac68208e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dateScrubGestureActions.js\":\"7e3da8ce88965a3f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c497492c827f8da6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dayProperty.js\":\"6f3f710d39e290e0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"f6b4a03b05236549\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/deletionGuard.js\":\"b6d0966dd99e5084\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dueQuery.js\":\"32b05093c9492069\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/index.js\":\"ff270fd15255a8b7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/landing.js\":\"c0005f23255ce8a8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/localSchema.js\":\"006b49d998d839ca\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/referenceDateAdapter.js\":\"2b3018285b8ae371\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/rescheduleAction.js\":\"5104e3e8f9a10432\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/schema.js\":\"b4e29e39fa46f17d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/spreadBlockDates.js\":\"3b86abb710e40677\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/spreadDatesAction.js\":\"39a0a679654465ca\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/today.js\":\"4bcf0fde39182da8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"9e585ad5ed8bc2b1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"398fe4bd7c869a7b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/audit.js\":\"bbd1ecd59a4516fc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/auditAction.js\":\"017401c84d59b9a8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/auditRanges.js\":\"b98818729dca16c1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/diagnosticsSource.js\":\"c9985389b1296660\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/divergenceScan.js\":\"d05dfe833657c920\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/index.js\":\"cef731a183474688\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/propertyChildrenChecks.js\":\"aee947788bc99650\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/referencesMirror.js\":\"f60c53463e9d0756\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/rowJson.js\":\"a8458a409c77e9af\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/schedule.js\":\"a011d690803764cb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/store.js\":\"1c95995d4af512f0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-maintenance/action.js\":\"b3400de793b2a663\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-maintenance/index.js\":\"13843192e4bd53f7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-maintenance/plugin.js\":\"d0ed17c37c5ce7e2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"3f5283f7b2c096c2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/actions.js\":\"d6f85c8bcd20cde2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/changeMarker.js\":\"5f8ce21557d44b2d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/diagnostics.js\":\"8e5fc36d9f8db523\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/fileSystemAccess.js\":\"3cfbd5d7e29dbe88\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/filenames.js\":\"8ddf5ae287b7ffdc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/index.js\":\"e619b38ee985ad45\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/mirror.js\":\"91b064ae940a819c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/runLock.js\":\"8b6dca41400a1630\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/runtimeHealth.js\":\"c70389d6c3084022\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/schedule.js\":\"17650b5b8debe15c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/store.js\":\"3a0e6784787e6f9c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/default-themes/index.js\":\"8613f3e010d0eaf1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/default-themes/themes.js\":\"6121fe4c3ee97ad2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/diagnostics/facet.js\":\"585ea8a0b816894e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/diagnostics/useDiagnostics.js\":\"0c71f912d4373d03\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extension-prompts/dismissals.js\":\"8d9d0e8cf4d55dd9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extension-prompts/index.js\":\"187c21c2e26f07b2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extension-prompts/status.js\":\"d432fa9972a78f92\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extension-prompts/store.js\":\"8246bbe7dfb64627\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"edcc352a02893673\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d072be00dcb41f00\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/actions.js\":\"38d3b0a4b7730256\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/config.js\":\"1860b48621676f12\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/dataExtension.js\":\"672356af5076d9bb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/effect.js\":\"7660a9699388d53a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/index.js\":\"3c29c7d035c0dcda\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/propertyEditorOverride.js\":\"9d039b4c79964ab4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/useToggleTree.js\":\"fa74534be9558bac\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extract-type/ExtractTypeDialog.js\":\"0abcb94805f0d81d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"bd43efe2d3eb0e0a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extract-type/PropertyShapePicker.js\":\"44aa08d62f140fab\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extract-type/action.js\":\"adff1dd0ad7ae942\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extract-type/index.js\":\"df8a3bdaa430302b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/FindReplaceDialog.js\":\"9440430e9a215a8b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/HeaderItem.js\":\"297a4defda18215b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/dataExtension.js\":\"5dba8b0e35b3250e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/index.js\":\"5a36cf811e677873\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/search.js\":\"2df42ced0f5422b7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/toggleStore.js\":\"9a2e425ab1910989\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/LocationPropertyEditor.js\":\"38d9a36981782df4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/MapView.js\":\"a3754191127b95e6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/blockTypes.js\":\"55e37c671c69dbc9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/codeMirrorExtensions.js\":\"2ea367a1f0064ffa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/createOrFindPlace.js\":\"39362eef010a368a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/currentLocation.js\":\"7ba573d8f0f74c0a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/dataExtension.js\":\"91570d2945a00bf3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/geoContentDecorator.js\":\"2f7dc6837217c944\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/googlePlacesClient.js\":\"312ac908c47b1acc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/index.js\":\"b168cb03d3b697c4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/locationsPage.js\":\"b7406b17ac19e701\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/mapViewport.js\":\"dec269eeb0146ee9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/pickCurrentLocation.js\":\"274510caa395d854\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/placeAutocomplete.js\":\"6edb2379eed9f3b6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/placeNameCollision.js\":\"82ab796103c649bb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/properties.js\":\"feaac9e32a46d0da\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/propertyEditorOverrides.js\":\"6aa1ef056331c9cb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/query.js\":\"615d63313e7f3079\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/usePlaceSearch.js\":\"fb80e34a34ae5a3b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"9a42308207692a6a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"11084bd07e0607cb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d28b2796e0217295\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/config.js\":\"be9c8a8d80d3c9a5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/dataExtension.js\":\"e29954397cd5f292\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/facet.js\":\"299ed485f83539ab\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/grouping.js\":\"bc243a561cd50895\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/index.js\":\"c52384f5630e877c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"5ebc592bd6f75273\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/query.js\":\"057c79075277e5c6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/resolveConfig.js\":\"4e8d8eca90f55f36\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"cf9c36f9246cf19d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"1f46a2b756b27da4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/HtmlDocumentContent.js\":\"25bd0131ca45a179\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/HtmlFrame.js\":\"9133b589a54c2e5c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/actions.js\":\"f15e4fd4a06a9bdd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/blockType.js\":\"d0e0ec3dd8e17e9d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/confirmRunScripts.js\":\"65cda0d225c7d43e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/dataExtension.js\":\"b42e21ad5846d14c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/frameAnnotations.js\":\"9815b91d9832302d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/frameDocument.js\":\"1e7f6e5476ee5388\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/frameTheme.js\":\"c3e033cf94edf2ef\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/index.js\":\"e617df07f3aa7ec8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/scriptConsent.js\":\"d01acce31933fcf9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/sourceMap.js\":\"9fa5a7c108880ec4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/useDocumentScripts.js\":\"08d46f5eb141200b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/interaction-metrics/index.js\":\"03d8135267208102\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/interaction-metrics/record.js\":\"8732924e926b6db9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/interaction-metrics/recordStore.js\":\"4f01c1fe2cbd63c7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/interaction-metrics/responsiveness.js\":\"49c7be7fdba0f875\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/interaction-metrics/schedule.js\":\"2396e15da785ec8f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/interaction-metrics/sessionContext.js\":\"56b3ee88955eba4c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"6cc532f106346858\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"aee320575cb5c74f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/actions.js\":\"d0d79cbe2c44c1ed\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/config.js\":\"3fb9b255432b53e6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/dataExtension.js\":\"78768feeff940dfa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/effect.js\":\"9f0b1bc07fb2587a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/index.js\":\"6b051717d6c1efe7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/keyCapture.js\":\"106a0e4e7f1e7690\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/overrideStore.js\":\"670fb1a48ff3a82c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f153a957b5303f72\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/HeaderItem.js\":\"ba1c452db4ca3b51\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/LeftSidebar.js\":\"bc8b038e54b4f605\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/actions.js\":\"053cc84f19f8dc3e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/facet.js\":\"50ae70d24cfa57f9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/index.js\":\"833308aacbf4f022\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/shortcuts.js\":\"1d797a6ed1a3f472\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/toggleStore.js\":\"96ecff88fa759f32\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/merge-blocks/MergePicker.js\":\"53c31fb2cebf1a70\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/merge-blocks/index.js\":\"92e47a158b561e65\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/merge-blocks/mergeAction.js\":\"9ac1593499b21eb0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/merge-blocks/strategy.js\":\"140a3e8231b8eb4c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-bottom-nav/Button.js\":\"717456939baa002e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"519ac98844de5899\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-bottom-nav/defaultItems.js\":\"1df19f8b5ba55d46\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-bottom-nav/facet.js\":\"b13a6cce98e4b430\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-bottom-nav/index.js\":\"d1cb40369acd8b6a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4da553aef36629c9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-keyboard-toolbar/actions.js\":\"0dd7e2cdca9fffa8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7685940c9ab34fd2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-keyboard-toolbar/facet.js\":\"8e8443e53c3df769\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-keyboard-toolbar/index.js\":\"abdb9feffdad9e77\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/MoveDestinationPicker.js\":\"514a2d3199c99e95\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1fda27de60db6297\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/contextMenuItem.js\":\"857b167bcbfa168d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/index.js\":\"4f00737b147b0a72\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/moveAction.js\":\"e0329310980b9bb6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/moveBlocks.js\":\"76aa511e7efe226d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/selectionAfterMove.js\":\"67a28f0376878ecd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/TutorialBanner.js\":\"a06cce2482fa8868\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/action.js\":\"035ca99558caee7d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/bannerDismissal.js\":\"283cc644cf9ae108\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/documents/cheatSheet.js\":\"e7884b20da7a33ea\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/index.js\":\"8cb7a3424e0a4d85\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/keys.js\":\"1647161e8fe6db73\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/landing.js\":\"05f6b5c8b330814c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/outline.js\":\"e7985811f99627b7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/seed.js\":\"8061a3aabf8c8bbb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/PerfTrendDialog.js\":\"181e3345b8ac3e2f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/analyze.js\":\"f1ac0ba41d1488de\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/diagnosticsSource.js\":\"711df35d8fd92c37\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/index.js\":\"86cbdea9bfa32f74\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/load.js\":\"239ff981ac0daf9a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/monitorRun.js\":\"1988d0e53d7415e8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/schedule.js\":\"85eaea75c5fe06c3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/series.js\":\"730b58ef99b636ba\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/store.js\":\"94fc03fe605b42d8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/trendAction.js\":\"05c2fffba76a4ee9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/verdict.js\":\"8a9c9fd4c7e67ca8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/plain-outliner/clickToEditAction.js\":\"a751ce72edf205c1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/plain-outliner/index.js\":\"45ea1d0d8bf581a8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/plain-outliner/interactions.js\":\"04dc2a2b33739bab\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"dfe8a72f01c18f33\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/MigrationGate.js\":\"53c496f2f115cd5f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/MigrationGateDialog.js\":\"bebc09e26bc084ce\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/action.js\":\"1689fe6a8ae08f33\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/index.js\":\"1f77aa353a3bcd91\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/localRunMessage.js\":\"0b22527d64e1288c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/plugin.js\":\"bba61faa2690de48\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/progressReport.js\":\"8bfec54c256d86c7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/sweepProgress.js\":\"8464b399dfccd68b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/FieldRowRenderer.js\":\"8715046df4b55e84\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/ValueRowRenderer.js\":\"bda1490cfaf7fa9b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/actions.js\":\"20b185ef5e7b81f1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/autocomplete.js\":\"c140102068ee78d0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/fieldRow.js\":\"81a2962214a5b2f6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/index.js\":\"96a7dc08f228c6f3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/referenceWarning.js\":\"711764c54cb3c7fc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/valueAutocomplete.js\":\"54539c44977d0d9b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/valueSchema.js\":\"206e510487bc7850\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/HeaderItem.js\":\"2a6724190382c470\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/QuickFind.js\":\"0bcbd1e5e7c46d64\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/index.js\":\"c50a38106ab9e9fc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/recents.js\":\"846e34b8a13eb46d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/resultItems.js\":\"a279fbe91baa7e2a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/selection.js\":\"7350996699224bd3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/toggleStore.js\":\"6d28b4b29668d63d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/recents/HeaderItem.js\":\"4c0f541c0ff8719c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5d356869e738a7d5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/recents/grouping.js\":\"ea1e5d8de67847c7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/recents/index.js\":\"d6cb37460ad61f8e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/recents/target.js\":\"875bee6fc1803324\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/codeMirrorExtensions.js\":\"f6cc5677cbe4c44f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/contentPrefill.js\":\"f2bddb744031757a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/dataExtension.js\":\"993986e4c2c42dc5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/index.js\":\"fcbaef7e140fde8c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d5e4ed19c53e257a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/invalidation.js\":\"d60e0dc0d1f43a64\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/localSchema.js\":\"e3ad2d9dd255a2ea\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/blockrefs/index.js\":\"35029808dcc76908\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"692baa23a091c521\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/index.js\":\"b4a25be2a5ebf9c2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/referenceNode.js\":\"7334ccd3b9d13519\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/remark-reference-occurrences.js\":\"44147e4590fff3bd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"8be1d85349d27e28\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/wikilinks/index.js\":\"86443c2496093315\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7ee75608e45a65e0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"10a17e85ee6d854b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/mergeRetargetProcessor.js\":\"867efdebf8f72304\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/parseFence.js\":\"efe1dbb08dfde78e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/referenceParser.js\":\"53e46008dc761c49\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/referenceProjection.js\":\"f330368d5cd53202\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/referencesProcessor.js\":\"cccf63bdb06280bd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/renameProcessor.js\":\"695a93e5edaa83b1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/spanReplacement.js\":\"6b7e6bc2cbe7261e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/rich-paste/htmlToOutline.js\":\"01bc7e89e69cc09c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/rich-paste/index.js\":\"ecd87b145076885c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/rich-paste/normalizeClipboardDom.js\":\"535d8e7fa48b7eb9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/rich-paste/pasteDecision.js\":\"1be1a993fef370e3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/action.js\":\"4ce2ef7a77f39748\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/blockIds.js\":\"1cc6b29978fb4096\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/content.js\":\"0fb329451a76c30b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/effect.js\":\"e73b3af12a34a18f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/ids.js\":\"81d7fc4fe9488d88\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/import.js\":\"cc9a782b5876603a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/index.js\":\"ff9ced72bf74c2f0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/plan.js\":\"8925fe416ce64a52\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/plugin.js\":\"f0c47fde274a97db\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/promotion.js\":\"96c04324e3ef0b46\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/properties.js\":\"28199a595cbc0b27\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/references.js\":\"a0084a32a51e909c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/report.js\":\"bb8ae370c613aed6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/roamMemo.js\":\"dad948ab7e27e29d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/runtime.js\":\"1299bf3cecb661c1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/schemaReconciliation.js\":\"85fc4b4e53361504\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/srsMarkers.js\":\"6702cfb5b75859d1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/todo.js\":\"add54209f1d74cc8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/typeCandidates.js\":\"945da38c65166516\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/types.js\":\"c408df8b91aea3ab\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/search-health/index.js\":\"852758fe13295cfd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/search-health/store.js\":\"675b254889123133\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/shortcut-help/HeaderItem.js\":\"fac000b76815574a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"736513790d7aa8f1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/shortcut-help/index.js\":\"56e50e1e0cbef6d3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/shortcut-help/model.js\":\"00b728dbd99124db\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/shortcut-help/toggleStore.js\":\"e5dc77d78b07f20d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/shortcut-help/useKeyInspector.js\":\"de3f558f83dcc69c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"50a472d83adec54c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/ShellDecorator.js\":\"fe0056c1ad7d7c4e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/actions.js\":\"042436fe1753e743\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/exclusionsFacet.js\":\"5ad3bf788c580b5f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/index.js\":\"c17d698268fe8112\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/shell.js\":\"e26deb12056ba0c4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/surface.js\":\"480de26b52039ba1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/walker.js\":\"91a85e361ea57c00\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/RescheduleToast.js\":\"9b2a186c4d38a995\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/dataExtension.js\":\"23ff0466486562ec\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/index.js\":\"37d05d3ed6781386\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/indicator.js\":\"d920cef6307311b6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/moveSrsState.js\":\"8d2e0a996b19786f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f19b4df84d0a8d4a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/scheduler.js\":\"260ba2c60b6ef7e7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/schema.js\":\"163fda1fc1ccf754\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"f0528aec753959e5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/srsClipboard.js\":\"f0e42bde72f7741a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"36e042e4253b3e84\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6eec52d2c9e2b9e5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/DeckPicker.js\":\"d3b147b90e66b561\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/ReviewControls.js\":\"cf81fc714db63fcf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/ReviewDeckRenderer.js\":\"b3a439ac6d761daa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/ReviewSession.js\":\"99f4fb53a92e3d49\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/actions.js\":\"446854382bde33e1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/archive.js\":\"648dd1a586812af7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/dataExtension.js\":\"49cf9103a53f902b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/deck.js\":\"a6c16d020cf7f6b9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/dueQuery.js\":\"bdb35786fead0d28\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/gradeDecision.js\":\"808bc171245ecc7a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/index.js\":\"c4b76757f67667f5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/keyHints.js\":\"9cc87771a50621bf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/reviewCardLayout.js\":\"63338e3dd40c6860\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/reviewProgress.js\":\"f01272657c8235a0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/schema.js\":\"3f78f88552ad533b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/useDueCards.js\":\"382e17d7e4da2ce4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/startup-metrics/index.js\":\"fb30e49298b85d42\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/startup-metrics/record.js\":\"fded828611d084ae\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/storage-persistence/index.js\":\"51236c3bd3c864d9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/storage-persistence/persistenceStatus.js\":\"4691a639afd8fec0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/storage-persistence/requestAction.js\":\"b5a446a00236a629\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/supertags/TypeChipsDecorator.js\":\"69eb542f0039d5bb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/supertags/codeMirrorExtensions.js\":\"c85ab5626c362bed\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/supertags/index.js\":\"e87d8408b0d61bd4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/supertags/typeAutocomplete.js\":\"4c594405969d6f91\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"07f101f0285e32d6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/actions.js\":\"29a160afc3e97a03\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/anchor.js\":\"06cb852d6554c261\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/events.js\":\"630f51233b99d71b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/gestureActions.js\":\"9f7cf75c9d034aaf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/index.js\":\"952507faa38e1054\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"443a68cbc0e744d1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/sync-metrics/collect.js\":\"026ff5cc29e104e1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/sync-metrics/index.js\":\"95da1b4a8e9614c8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/sync-metrics/record.js\":\"3715296a89ee0323\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/RejectionDialog.js\":\"5bb658eb2524eb6a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/SystemStatusHeaderItem.js\":\"3d8645040d1d34a2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/index.js\":\"97c84d5443f45ac5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/model.js\":\"fd4f6016422234d2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/queueCounts.js\":\"fd3071460ef7c2e7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/rejectedHelpers.js\":\"a21d155f62591b25\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/rematerializeAction.js\":\"38dfddb67851c75c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/useHysteresis.js\":\"8c4834539d7f7c84\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/ColumnHeaders.js\":\"99d948b659926d27\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/QueryUi.js\":\"8a57f95384738faa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/TableLayout.js\":\"0b99fb6c76fcb3a3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/actions.js\":\"d1ea54541c99cb68\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/cellEdits.js\":\"e03db9673ff043c2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/childrenViews.js\":\"61a94648c5eda606\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/columns.js\":\"65b89bc0cbe98a1a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/controller.js\":\"6c65b0532a2e2a6d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/convert.js\":\"41f9c6d177b26aa3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/dataExtension.js\":\"c34e37c37199a068\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/index.js\":\"66a1bfd3133353ed\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/keys.js\":\"b1ac32f2db473050\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/model.js\":\"61e3090034473b4d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/QueryText.js\":\"8d6d559dee386081\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/backfill.js\":\"3901d7f02c047ed2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/completion.js\":\"e05c78f223f40c19\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/format.js\":\"e9ebdcaf72b6c797\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/parse.js\":\"c9436e82ff11e4ba\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/queryValue.js\":\"231b6ffa91fd46aa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/registrations.js\":\"9fbc30b3032b2b64\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/source.js\":\"0f2c48c1c292f6d4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/registry.js\":\"cac38cb85242b5a9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/rowGutter.js\":\"be1076967e315d02\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/rowVerbs.js\":\"7b0162e31e7fcb8f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/schema.js\":\"35626f8dd129fa44\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/sort.js\":\"de9bc1df59ca7cab\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/theme-toggle/effect.js\":\"ac427617971f168b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/theme-toggle/index.js\":\"aa393a849168948b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/theme-toggle/theme.js\":\"113fb0e67ceb4519\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/todo/actions.js\":\"479dd138956a401c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/todo/dataExtension.js\":\"cbcb96967c7f91b7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/todo/index.js\":\"97946ad5517d867c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/todo/schema.js\":\"e2fda8394203ea33\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f7eba1cddaccae5a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/touch-selection/actions.js\":\"f855bc570febd4c7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/touch-selection/defaultItems.js\":\"8379613e46308806\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/touch-selection/facet.js\":\"0f11c25baa2bd3e1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/touch-selection/holdRecognizer.js\":\"f9a3da14a11ac74a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/touch-selection/index.js\":\"2b4883e014da2b7f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/update-indicator/UpdateIndicator.js\":\"94ff8a1539b1515b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/update-indicator/index.js\":\"39e21d48d8737d35\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/update-indicator/loadTimes.js\":\"c383ca1f4d4e8ee8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/VideoNotesRenderer.js\":\"f2189c4be7e590c7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/VideoPlayerRenderer.js\":\"15482ddcedc37d1a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/VideoTimeStamp.js\":\"a8b6fc2d3a86789e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/actions.js\":\"000cda24ba31defa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/index.js\":\"bf70ec7d763a120a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/markdown.js\":\"8a313c945b51c9c3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/notes.js\":\"7f1f9bb6cb73ac19\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/registry.js\":\"616d84472cf06bbb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/remark-timestamps.js\":\"87da3b97c1ead18b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/view.js\":\"5dd2d0196933950f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-link-hints/LinkHints.js\":\"ac1056f88443eaee\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-link-hints/index.js\":\"e8bac38034ab6b41\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-link-hints/model.js\":\"83626f52d8be9aec\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-link-hints/settings.js\":\"24d5fe0ac59f72d1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-normal-mode/actions.js\":\"6a9f62c7c4df3b7c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-normal-mode/index.js\":\"b59bb487fd414bda\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-normal-mode/interactions.js\":\"425d157b1935d1fe\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/workspace-header/index.js\":\"0c92f06319b30057\",\"/knowledge-medium/pr-preview/pr-1889/src/registerServiceWorker.js\":\"be6fc90a11aa99e6\",\"/knowledge-medium/pr-preview/pr-1889/src/requestPersistentStorage.js\":\"f9f3f83a827ff023\",\"/knowledge-medium/pr-preview/pr-1889/src/services/authRequestDeadline.js\":\"f599132f10ca28cc\",\"/knowledge-medium/pr-preview/pr-1889/src/services/authStorage.js\":\"717c9ea1f7796a20\",\"/knowledge-medium/pr-preview/pr-1889/src/services/powersync.js\":\"fadb42ff0961aa6b\",\"/knowledge-medium/pr-preview/pr-1889/src/services/supabase.js\":\"1197a54b8eb4bd0b\",\"/knowledge-medium/pr-preview/pr-1889/src/services/uploadErrorClassifier.js\":\"4ad191889ad9ec40\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/ActiveContexts.js\":\"1141da353125f548\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/HotkeyReconciler.js\":\"e03edaacb67426e3\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/WipeLocalDataDialog.js\":\"6891c890be2770f3\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/actionDispatch.js\":\"0fcb1fd4ffc732a1\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/actionRefItems.js\":\"b07911b9c6ee7dee\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/applyKeybindingOverrides.js\":\"b8d350ed78790d33\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/blockActions.js\":\"a372a80380b7cb84\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/blockMergeGesture.js\":\"b061bae02be039dc\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/canonicalizeChord.js\":\"6bba18ea4ddeb16b\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/defaultContexts.js\":\"1c0b86589844a355\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/defaultShortcuts.js\":\"e8ef117f7f33b25f\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/effectiveActions.js\":\"4fb4f619a28c17f0\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/gestureAction.js\":\"cbbd6ba95a3d73ad\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/gestureBinding.js\":\"74533b39d00d7997\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/holdRegistry.js\":\"0461f9d6518f1944\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/keybindingConflicts.js\":\"174e5a8567f04a1b\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/keybindingOverrides.js\":\"529f29b0ca47e369\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/pointerAction.js\":\"f4e32471ffafdd30\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/resolve.js\":\"7248ddad00aa15dc\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/runAction.js\":\"2dcea8855f3e6bc4\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/sequenceMatcher.js\":\"832fa0f275a4c095\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/types.js\":\"49ff17f00aaa6f39\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/useActionContext.js\":\"30683df7d5b177bb\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/useActionDiscovery.js\":\"1009a71142f716ed\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/utils.js\":\"62a6afa7d98aaa19\",\"/knowledge-medium/pr-preview/pr-1889/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1889/src/sw/bootStore.js\":\"116c66ba302726ce\",\"/knowledge-medium/pr-preview/pr-1889/src/sw/previewDatabases.js\":\"5f7f58cd11b3ef76\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/byteTransform.js\":\"983e0664abf77b9b\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/attachmentCleaner.js\":\"e134b240dd3795fd\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/bundle/attachmentParts.js\":\"6c93464f92d64a60\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/bundle/bundleParts.js\":\"fcd22ff72e4ee685\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/bundle/bundleRecord.js\":\"4d77db604041b4c5\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/bundle/manifest.js\":\"0b64baf81b21b571\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/bundle/takeBundle.js\":\"4a8e9442f0d55099\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/bundle/verifyBundle.js\":\"53bdb5a1e86df2a1\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/cleaningStage.js\":\"9dc80437eafbebc9\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/conversionKey.js\":\"39cdc2ad48b90eb5\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/conversionServer.js\":\"f5f4bdd4735c6050\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/flip.js\":\"da04253eb625e82c\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/flipAttempts.js\":\"2b4a73c50e02d70e\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/pages.js\":\"b68bf80a084de7f9\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/preflight.js\":\"ab47ec0c1636f1b6\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/reseal.js\":\"f3bfaa7bc1af5d12\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/runConversion.js\":\"640ea9735e8f1b9c\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/runLock.js\":\"2697885b28f07acd\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/sealing.js\":\"33c2bf8968503bad\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/sealingStage.js\":\"83312d1fff285452\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/stage.js\":\"1e788f7473a3d6c8\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/verifyReseal.js\":\"ea73c9b2a409752d\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/aad.js\":\"e7aaf43ddc6ec03a\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/aead.js\":\"169fab99fc3c2e01\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/base32.js\":\"4c68c32429a58f77\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/base64url.js\":\"c8b9c755d6d376b2\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/binaryEnvelope.js\":\"efcbb5d512948a8f\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/byteAead.js\":\"4f821e73214544eb\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/canary.js\":\"c9a96970d3f7e791\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/contentHash.js\":\"b8981c101408dd42\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/contentKey.js\":\"0eb125f89942f8db\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/derivedIdNamespace.js\":\"cb6c46bb9050aa12\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/envelope.js\":\"81b9bf0368bd189f\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/hex.js\":\"05a0116ba06b307f\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/sha256Hex.js\":\"2ee5a0c00c1e65b7\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/workspaceKey.js\":\"9760fb0242c4393d\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/conversionState.js\":\"3c1cb3021db0330a\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0ea92f6fa98a0ef0\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/flows/pastedKey.js\":\"1c8646046d00ea34\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"7fd7e73b145ce009\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/flows/upgradeWorkspacePin.js\":\"696ca7afaf20d738\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/keyStore.js\":\"4db33a9b23cb8f96\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/mintWorkspaceKey.js\":\"fec1110b05d0b3a6\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/modePin.js\":\"c580c666bda7eea1\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/openWorkspaceKeys.js\":\"8522145f24da5a15\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/resolveWorkspaceEntry.js\":\"56b8156d9e4cd0b1\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/resolver.js\":\"13b1fad9d58fed9a\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/workspaceAccess.js\":\"763c45e6aac3b71f\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/transform.js\":\"579d6505353fa6c9\",\"/knowledge-medium/pr-preview/pr-1889/src/themeBootDefaults.js\":\"e69ee954b088237a\",\"/knowledge-medium/pr-preview/pr-1889/src/types.js\":\"5305383caa4706a1\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/ClientLocalSettings.js\":\"92408cba25c2e300\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/abortableSleep.js\":\"45cae01ca83272c3\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/array.js\":\"4de2046bde68a2e9\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/backlinkAutocomplete.js\":\"a0f875b950eedb96\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/blockCrumbs.js\":\"eb38b3211ebcd23c\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/blockrefAutocomplete.js\":\"d146f0e2f65202cd\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/cadencedIdleJob.js\":\"58341fbede4aac28\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/callbackSet.js\":\"713fe8f9af6d5138\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/clientId.js\":\"b98682b08e85e322\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/codemirror.js\":\"151e48351387598f\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/codemirrorCompletion.js\":\"d8b3669b877733cb\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/copy.js\":\"07137e03d20d5e79\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/dailyPage.js\":\"d5ebbb0a2541c4e9\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/dbForensics.js\":\"a662110d9451b2fc\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/dbForensicsHooks.js\":\"1a7678abefe454b4\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/deleteBlockThroughUi.js\":\"0453fc6ac0d91644\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/dialogs.js\":\"334e6d22c2efd87c\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/dom.js\":\"a2e77a0c2478c6c3\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/downloadBlob.js\":\"272368c5b76fe4a6\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/drawnWalk.js\":\"fbef37ef35b6d0d2\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/exportSqliteDb.js\":\"1ee133fb2fabd365\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/fileSystemAccess.js\":\"01a94022672a1ac4\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/flipSlide.js\":\"f11f673589134770\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/fnv1a.js\":\"fe6523907110a419\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/formatBytes.js\":\"ff56dedf2866f72e\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/fuzzyRank.js\":\"3727e38d6403fa71\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/idbKeyedStore.js\":\"006f961fcf3fb6c6\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/idleCallbackPolyfill.js\":\"6471e607496c3028\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/keyboardAwareScroll.js\":\"9cd3ee5927ce44e7\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/keyboardViewport.js\":\"7174e673c68c2697\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/lastWorkspace.js\":\"21c9345ccdacb1e1\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/layoutColumns.js\":\"9b3bc709c73b2608\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/layoutSessionDom.js\":\"5f9d6fb72c5371c9\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/layoutSessionId.js\":\"bd99555f474509a0\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/linkClickGestures.js\":\"f35970bbd8f28e39\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/linkTargetAutocomplete.js\":\"154b5ddca1760bae\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/localDbCorruption.js\":\"9a63599a5563cf4d\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/localDbRecovery.js\":\"c954c6ce5197ad6c\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/markdownParser.js\":\"c12e87dd7cd374d0\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/memoize.js\":\"b755b982efd10baa\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/nameFieldCommit.js\":\"1b909dec7aeb2a20\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/nameList.js\":\"6a3366abb7d386a4\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/navigation.js\":\"9109f28e728b9813\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/omnilinerNamespace.js\":\"51b270cace30a2c4\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/opfsPageScan.js\":\"a8a775977fdd1967\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/panelClearance.js\":\"12d4e1b260beb149\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/panelHistory.js\":\"12f3d623a66421d0\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/panelLanes.js\":\"366b87bb75f78239\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/panelLayoutProjection.js\":\"d55eebbad75d5cc4\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/panelScrollAnchor.js\":\"3ec5736ed050e159\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/panelUrlFlags.js\":\"d5b74d09eb1447c6\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/platform.js\":\"5cd89c1ef0ad3ff9\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/pluralize.js\":\"b1fd38093f0ccc37\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/propertyCreation.js\":\"c7e154224efe98e1\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/propertyNavigation.js\":\"3f807127987020e5\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/propertyValueContext.js\":\"987f296d098700d3\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/react.js\":\"fd37d7ef025b6edc\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/relativeDate.js\":\"04b7f2a197c626af\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/relativeTime.js\":\"2792bdff04bfd641\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/renderScope.js\":\"1b1c82ab5d1cf523\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/resolvedThenable.js\":\"10a6e70e7118d694\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/routing.js\":\"24a40d2159f5018c\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/safeMode.js\":\"1d8b847eb09cd26b\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/scheduleIdle.js\":\"31398323acfb2d00\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/screenWakeLock.js\":\"7748eb316c198852\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/selection.js\":\"938c74b1dcdcda92\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/softKeyboardGrab.js\":\"b4f571ba4b7ee8ab\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/startupTimeline.js\":\"8030bacc5077f846\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/state.js\":\"086a606a3e0cf9c4\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/string.js\":\"3b8b6db23ea6ac3c\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/surfaceZoom.js\":\"333afa90ad2611e4\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/time.js\":\"75c320970535abda\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/toast.js\":\"bf8409d311adc233\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/toggleStore.js\":\"1fac0311a405d685\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/untilStopped.js\":\"958bd4fa1b314aaf\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/userActivity.js\":\"b536f3f2daaf2456\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/viewTransition.js\":\"db9defc8d4dd300d\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/viewport.js\":\"31920c9371e05834\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/webLock.js\":\"125de6ffb6ddedfb\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/workspaceRecovery.js\":\"509fb348b7f0582d\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/workspaceSnapshotStore.js\":\"9d6497d6c365ba6f\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-compiler-runtime.js\":\"bb3517a5a73a0a23\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom-client.js\":\"dc3fccd2aada124c\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom-server-edge.js\":\"0eb311ddaa17e63d\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom-server.js\":\"8443d8f43b04fa89\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom-static-edge.js\":\"ebf69200d89a2ab5\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom-static.js\":\"9aeb4a1601f787fb\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom-test-utils.js\":\"17c512c93e744116\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom.js\":\"0c7e393bbf01f638\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-jsx-runtime.js\":\"a0e712ca0d9f2098\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react.js\":\"ff3968b5dfede333\",\"/knowledge-medium/pr-preview/pr-1889/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1889/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1889/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
