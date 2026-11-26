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
		buildId: "80834e74eb15-09640e6e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1889/\":\"9164aa8a418f4830\",\"/knowledge-medium/pr-preview/pr-1889/index.html\":\"9164aa8a418f4830\",\"/knowledge-medium/pr-preview/pr-1889/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1889/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1889/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1889/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1889/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1889/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1889/app.css\":\"d6b85c2ba5dde3ba\",\"/knowledge-medium/pr-preview/pr-1889/assets/FacadeVFS-AeDrendx.js\":\"f76f9e1bcc784638\",\"/knowledge-medium/pr-preview/pr-1889/assets/OPFSCoopSyncVFS-DpO0bLJo.js\":\"cf95440091ca1be8\",\"/knowledge-medium/pr-preview/pr-1889/assets/OPFSWriteAheadVFS-BucPrgRu.js\":\"cd74cf2f96969232\",\"/knowledge-medium/pr-preview/pr-1889/assets/wa-sqlite-C1GROLo9.js\":\"166ad137b17ce69f\",\"/knowledge-medium/pr-preview/pr-1889/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1889/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1889/assets/wa-sqlite-async-CkSo0Mb0.js\":\"81ca9026fabd3fbf\",\"/knowledge-medium/pr-preview/pr-1889/assets/worker-BXVK8G_N.js\":\"b2b2aa43449c7cef\",\"/knowledge-medium/pr-preview/pr-1889/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1889/chunks/app-D6XGC5cp.js\":\"19e57b4477692c90\",\"/knowledge-medium/pr-preview/pr-1889/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1889/index.js\":\"92b857c30bf1b530\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1889/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1889/assets/AccessHandlePoolVFS-D-hMJpuL.js\":\"42adace9a244d382\",\"/knowledge-medium/pr-preview/pr-1889/assets/IDBBatchAtomicVFS-ClSdz1mG.js\":\"06ce5738c6d66e9e\",\"/knowledge-medium/pr-preview/pr-1889/assets/MemoryVFS-BPWh4knJ.js\":\"a28c27058713e598\",\"/knowledge-medium/pr-preview/pr-1889/assets/mc-wa-sqlite-B_OCVqLW.js\":\"652d63918b201332\",\"/knowledge-medium/pr-preview/pr-1889/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1889/assets/mc-wa-sqlite-async-Bqqg7sF4.js\":\"a50c27beeab7ab81\",\"/knowledge-medium/pr-preview/pr-1889/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1889/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1889/chunks/AccessHandlePoolVFS-DRzXZ5MB.js\":\"8bcc747de0707817\",\"/knowledge-medium/pr-preview/pr-1889/chunks/FacadeVFS-CBCfXTNO.js\":\"a717bbb8675ec1f9\",\"/knowledge-medium/pr-preview/pr-1889/chunks/IDBBatchAtomicVFS-DZ-IY-Ch.js\":\"6cfa254b9c800607\",\"/knowledge-medium/pr-preview/pr-1889/chunks/MemoryVFS-By6UmPnM.js\":\"76da0d34e6c8c307\",\"/knowledge-medium/pr-preview/pr-1889/chunks/OPFSCoopSyncVFS-DxLpkzj6.js\":\"6ab3f7657bbe5f7d\",\"/knowledge-medium/pr-preview/pr-1889/chunks/OPFSWriteAheadVFS-CIrxaWhR.js\":\"8398306449cf0bad\",\"/knowledge-medium/pr-preview/pr-1889/chunks/Preview-LkbSQVez.js\":\"9514fb95e6ad79cd\",\"/knowledge-medium/pr-preview/pr-1889/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1889/chunks/card-CaFMEVJQ.js\":\"4282b4b7c9eb7a29\",\"/knowledge-medium/pr-preview/pr-1889/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1889/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1889/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1889/chunks/dist-Cnc292Jy.js\":\"610b99ec3ee4879a\",\"/knowledge-medium/pr-preview/pr-1889/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1889/chunks/mc-wa-sqlite-BOYvwUPa.js\":\"4044546b490decba\",\"/knowledge-medium/pr-preview/pr-1889/chunks/mc-wa-sqlite-async-Fp4NQOhI.js\":\"fd0979c163b26e5d\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-B35yrMtz.js\":\"cf5cde580a1a32e4\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-BBuiKcr-.js\":\"35f125f94942a868\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-BDfm0Y10.js\":\"c2fa0e951d351d5d\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-Bb-sF6NC.js\":\"616953527be497ad\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-DICen4xJ.js\":\"45ab7a8fed1c7349\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-DMNnKwMN.js\":\"6a591a7e9e1a9332\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-DPCRXnwe.js\":\"7438d4646a942f9f\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-DxDJwAAc.js\":\"ef91ac343d487ef5\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-dom-server-legacy.browser.production-v_BMbP8a.js\":\"c01aa5d61e609f9e\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-dom-server.browser.production-BVkeebBO.js\":\"6684ba6e1d8d72b7\",\"/knowledge-medium/pr-preview/pr-1889/chunks/react-dom-server.edge.production-MrT9x23s.js\":\"c6362e1a0fbd4775\",\"/knowledge-medium/pr-preview/pr-1889/chunks/server.browser-CrVWKFG5.js\":\"34317f31db421a95\",\"/knowledge-medium/pr-preview/pr-1889/chunks/textarea-xupNbLTw.js\":\"5bc9ff45d0f2fb30\",\"/knowledge-medium/pr-preview/pr-1889/chunks/ui-DoagSICs.js\":\"2c09c7e1d800c9d6\",\"/knowledge-medium/pr-preview/pr-1889/chunks/wa-sqlite--W2LLHuB.js\":\"aebb3616fc5e0fc4\",\"/knowledge-medium/pr-preview/pr-1889/chunks/wa-sqlite-async-CkGaFh97.js\":\"a54023259b54401b\",\"/knowledge-medium/pr-preview/pr-1889/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1889/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1889/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1889/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1889/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1889/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1889/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1889/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1889/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1889/src/App.js\":\"9c1e6c5e42e44b67\",\"/knowledge-medium/pr-preview/pr-1889/src/appUpdate.js\":\"d041b0a60e3204eb\",\"/knowledge-medium/pr-preview/pr-1889/src/appVersion.js\":\"920565bd552d899e\",\"/knowledge-medium/pr-preview/pr-1889/src/bootstrap/initialLayout.js\":\"f464abf435dbc2e9\",\"/knowledge-medium/pr-preview/pr-1889/src/bootstrap/openWorkspaceData.js\":\"a8083b2803e43907\",\"/knowledge-medium/pr-preview/pr-1889/src/bootstrap/resolveWorkspace.js\":\"e232507ec4f9e2f6\",\"/knowledge-medium/pr-preview/pr-1889/src/bootstrap/workspaceBootstrap.js\":\"a56377832c92fb0c\",\"/knowledge-medium/pr-preview/pr-1889/src/components/BlockComponent.js\":\"3c9d4cf6012eb1b5\",\"/knowledge-medium/pr-preview/pr-1889/src/components/BlockCrumbs.js\":\"29e09b7c76da1284\",\"/knowledge-medium/pr-preview/pr-1889/src/components/BlockEditor.js\":\"e4e44da707d96ad5\",\"/knowledge-medium/pr-preview/pr-1889/src/components/BlockLoadingPlaceholder.js\":\"fd7be5666c2a45cc\",\"/knowledge-medium/pr-preview/pr-1889/src/components/BlockProperties.js\":\"a50dba51bd5da108\",\"/knowledge-medium/pr-preview/pr-1889/src/components/BlockSearchPicker.js\":\"cf1ad344e1992752\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ConfirmBulkDeleteDialog.js\":\"6eb9dacbc417b7e6\",\"/knowledge-medium/pr-preview/pr-1889/src/components/DividerHandle.js\":\"4b9323ba57d3d9f0\",\"/knowledge-medium/pr-preview/pr-1889/src/components/DraftEditor.js\":\"ccec5303d6b289c7\",\"/knowledge-medium/pr-preview/pr-1889/src/components/GutterPill.js\":\"4250994040eb0215\",\"/knowledge-medium/pr-preview/pr-1889/src/components/Header.js\":\"d23f9f613f68fb7d\",\"/knowledge-medium/pr-preview/pr-1889/src/components/LazyBlockComponent.js\":\"9cd0a6f86441ad8c\",\"/knowledge-medium/pr-preview/pr-1889/src/components/Login.js\":\"5707a75456359a74\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ZoomableSurface.js\":\"131908deca5f1cce\",\"/knowledge-medium/pr-preview/pr-1889/src/components/editModeKeepalive.js\":\"91b5c1be377544d0\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c13621f79a3d2fd4\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"de2fd766f81f7a1c\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/RefPropertyEditor.js\":\"01f800e9aa7a4808\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/RefTargetTypePicker.js\":\"7e21f2df66df1841\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/SelectPropertyEditor.js\":\"d821683e46568903\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/TypesPropertyEditor.js\":\"9ff2957ff2e00ec8\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/defaults.js\":\"8127ce454b998508\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/kernelValuePresets.js\":\"083579f776722058\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/selectablePresets.js\":\"46f76a787d8804e9\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyEditors/typesPropertyUi.js\":\"ca7e90fec1ed2422\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/AddPropertyForm.js\":\"99da16b038ac968d\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/PropertyPicker.js\":\"d6b6bf58f2066d49\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/PropertyRow.js\":\"a44c9ffad4f603e4\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/Rows.js\":\"92a6e0e50dd62ecd\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/actions.js\":\"b390e0e6591cee64\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/declarationOnly.js\":\"46aab21e9599b984\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/layout.js\":\"ad59b436308112a5\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/model.js\":\"1474157e4203894e\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/shapeUi.js\":\"f509a036f2c2c8d5\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/shapes.js\":\"41bd6769cdb7e0b3\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/usePropertyEditingActivation.js\":\"33ae452e2ca3eff1\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanel/visibility.js\":\"a7bf9472d58b0fb5\",\"/knowledge-medium/pr-preview/pr-1889/src/components/propertyPanelSections.js\":\"df933391ae91561c\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/BlockEmbed.js\":\"2dfed71b67dbd834\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/BlockLink.js\":\"94e7e099c612bc7f\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/BlockRef.js\":\"edff0a8bfe4da6e9\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/CompactReferenceLink.js\":\"78bc1464dea324c2\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/ReferenceLink.js\":\"02638b28f8dd73a9\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/cycleGuard.js\":\"780349206d93ba10\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/cycleGuardContext.js\":\"4d918edce0d8a6c2\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/linkInteraction.js\":\"78a29949ddbaa94e\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/referenceLayout.js\":\"f25daa5f6bca1c88\",\"/knowledge-medium/pr-preview/pr-1889/src/components/references/useBlockRefAncestors.js\":\"60732d2ddc9719e1\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/BlockGutter.js\":\"33244adc6ecfec8d\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/BlockInfoDialog.js\":\"e4f17538ad57ce22\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/BlockReadText.js\":\"16dee2c619b982aa\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/BlockTypeBlockRenderer.js\":\"01fe3c1bb004a6c3\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/BulletHoverCard.js\":\"55a24d6fce4cb60d\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/CodeMirrorContentRenderer.js\":\"dcf15267744729bf\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"238ec8fc659cc19b\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/ColumnResizeHandles.js\":\"f05414f41fbebe2f\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"920028904a9c0579\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/DefaultBlockRenderer.js\":\"b05cadbf5f676057\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/LayoutRenderer.js\":\"ae1eb4bd20894ad8\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/MarkdownContentRenderer.js\":\"6ba9d6eccdc2e97e\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/MissingDataRenderer.js\":\"1cb242c77d2325c5\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/PanelRenderer.js\":\"392e2c4e23deb8d8\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/PropertySchemaBlockRenderer.js\":\"abaa5874b9ee39b6\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/TopLevelRenderer.js\":\"9dad83a6dd0b2e20\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/blockGutterMode.js\":\"0e4d97ae425655a4\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/blockTitleText.js\":\"5e462f47d52f4c5b\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/fieldCreationKeydown.js\":\"b356aa19ca78edcb\",\"/knowledge-medium/pr-preview/pr-1889/src/components/renderer/layoutRootContext.js\":\"664dd8b372217bd9\",\"/knowledge-medium/pr-preview/pr-1889/src/components/typeChip/TypeChip.js\":\"0a30b92dbca1ee19\",\"/knowledge-medium/pr-preview/pr-1889/src/components/typeChip/chipStyle.js\":\"0aacfd0400201b68\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/anchored-floating.js\":\"32af55ea9726eda5\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/button.js\":\"4434bde93395da65\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/card.js\":\"c6e2148aa26d6139\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/checkbox.js\":\"c5bb1cced083fb36\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/collapsible.js\":\"cdf9b251ea5c9cd9\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/command.js\":\"c35b382cefc76df3\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/context-menu.js\":\"ad26360d1acaa9ec\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/dialog.js\":\"179e711cef673a4e\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/dropdown-menu.js\":\"f961e365ffd342e3\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/floating-listbox.js\":\"e13f668754ac4892\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/index.js\":\"7d9d2a7786217083\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/input.js\":\"686b9912a07cbbc6\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/kbd.js\":\"250178d7d5518bda\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/label.js\":\"a2719aa86a8d457b\",\"/knowledge-medium/pr-preview/pr-1889/src/components/ui/textarea.js\":\"3c3ceeb157b7779b\",\"/knowledge-medium/pr-preview/pr-1889/src/components/useEditModeYieldKeepalive.js\":\"80bad1b71a144cb7\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/BootFallback.js\":\"1d47ec81d1c3031e\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/FocusedRowLazyMount.js\":\"287d13571db851a1\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/LazyViewportMount.js\":\"a4d3014e4c0a9451\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/LocalDbCorruptionFallback.js\":\"8c33bd95649d2e06\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/error.js\":\"5b2b921834ed4386\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/lazyMountRegistry.js\":\"b6ac0c8a545412fa\",\"/knowledge-medium/pr-preview/pr-1889/src/components/util/suspense.js\":\"9c3d6604ad9967ce\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/CreateWorkspaceDialog.js\":\"c37f5a9de8224aa6\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/PendingInvitations.js\":\"64b5927884cce469\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/SyncProgress.js\":\"44b4b75b5ac885f0\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/UnlockProgress.js\":\"ac84d4dcdede0b3f\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/WorkspaceKeyGate.js\":\"a0204840334c4c54\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/WorkspaceSettingsDialog.js\":\"02bda01269b5c2cc\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/WorkspaceSwitcher.js\":\"b1259cc65f17d3c3\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/WorkspaceSyncGate.js\":\"4cede6e9dffdad68\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/ConversionFlow.js\":\"a81e920ca417f9b9\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/ConversionFlowHost.js\":\"bc8284825c8eedd7\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/EncryptionSection.js\":\"eafe772e79bee4d6\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/attachmentPrompts.js\":\"848433fe48efc0ca\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8a006582120f855a\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/conversionFlowDeps.js\":\"6aeb45373ae74556\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/conversionFlowStore.js\":\"8931b5ac50a11c2c\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/flowUi.js\":\"b098bb38326a96cc\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/conversion/useConversionRun.js\":\"006f2967e2ef8d92\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/keyUi.js\":\"68e4f0da1a4057c8\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/useCloseOnKeyLoss.js\":\"3870476173486c8c\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/useCloseOnServerE2ee.js\":\"fd0be7d56fad6cc4\",\"/knowledge-medium/pr-preview/pr-1889/src/components/workspace/workspaceUnlocked.js\":\"ab9dfee95d43fb3e\",\"/knowledge-medium/pr-preview/pr-1889/src/context/backgroundSubtree.js\":\"8306ad4eaa0a1092\",\"/knowledge-medium/pr-preview/pr-1889/src/context/block.js\":\"e225633e31fff303\",\"/knowledge-medium/pr-preview/pr-1889/src/context/layoutWsContext.js\":\"4a6975fcc8614117\",\"/knowledge-medium/pr-preview/pr-1889/src/context/propertyDisplay.js\":\"36c3650fcc21daf9\",\"/knowledge-medium/pr-preview/pr-1889/src/context/repo.js\":\"e843d8342ff93f6d\",\"/knowledge-medium/pr-preview/pr-1889/src/data/aliasClaim.js\":\"5cdc718a6f14e7e6\",\"/knowledge-medium/pr-preview/pr-1889/src/data/aliasSeatNamespace.js\":\"6862d894b1f709a7\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/blockData.js\":\"ac07dc432e9b0b1e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/blockType.js\":\"47f61dd826b33880\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/changeScope.js\":\"3a03da432bdfb4ee\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/codecs.js\":\"377431b9df5c2787\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/derivedData.js\":\"df5d4373fbe42f96\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/errors.js\":\"25a5eeb1075a6440\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/events.js\":\"56ec11abb947c256\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/handle.js\":\"7f83d2f7a4e26b5e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/index.js\":\"36e800a8806dcf87\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/mutator.js\":\"49b7cfa56ae330a5\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/processor.js\":\"e8e5b8a0d906a71f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/propertySchema.js\":\"7e98180380cab8bb\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/query.js\":\"1e23a503daf0bc8f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/sameTxProcessor.js\":\"c84947297b69f223\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/schema.js\":\"7f83d2f7a4e26b5e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/tx.js\":\"7f83d2f7a4e26b5e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/typedBlockQuery.js\":\"5c23af4c8f241915\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/user.js\":\"51fb4f2a25b63d1c\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/valuePresetCore.js\":\"b9f5ef67bc52680e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/api/valuePresets.js\":\"f4686f69697cd982\",\"/knowledge-medium/pr-preview/pr-1889/src/data/attachmentCleanerIOVerb.js\":\"b5fdbe446f3895f9\",\"/knowledge-medium/pr-preview/pr-1889/src/data/block.js\":\"37ec193b7b20d98b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockCache.js\":\"b49bce985a27f311\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockId.js\":\"f94dac4b119ac8b2\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockLiveness.js\":\"175412a668f8301d\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockMerge.js\":\"823f680806fb27ce\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockSchema.js\":\"caa1f4c24e67587f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockTypeLookup.js\":\"171b038f2402925e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/blockTypes.js\":\"8d208a94f0bfe2bf\",\"/knowledge-medium/pr-preview/pr-1889/src/data/childrenView.js\":\"b5ad4e12d4428394\",\"/knowledge-medium/pr-preview/pr-1889/src/data/clientContext.js\":\"9a9b19da7fc3cebe\",\"/knowledge-medium/pr-preview/pr-1889/src/data/dbFileSiblings.js\":\"da1adae3283efe0b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/definitionSeeds.js\":\"0f3dc97fc6045ad6\",\"/knowledge-medium/pr-preview/pr-1889/src/data/derivedIds.js\":\"d652895ae103377b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/drawnSubtree.js\":\"1e13ca778b3486d9\",\"/knowledge-medium/pr-preview/pr-1889/src/data/facetBridge.js\":\"a9bbc1176be2d83f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/facets.js\":\"2f8ab5b150a50646\",\"/knowledge-medium/pr-preview/pr-1889/src/data/globalState.js\":\"1ff7f5a6d348e805\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/aliasClaimRederiveProcessor.js\":\"0d8ebbb4dc149d6a\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/ancestorBatch.js\":\"0bbfd241e73d957d\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/blockTypeTypeifyProcessor.js\":\"a2d740087c2b073c\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/clientSchema.js\":\"af4f6ecdf962bffe\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/commitPipeline.js\":\"f19d9f2b6e52f276\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/devAssertions.js\":\"4e5bbf1f2b33d014\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/firstSync.js\":\"c9a10f3352171c70\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/freshInitialLoad.js\":\"34d211a196608850\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/graphBackfillClaim.js\":\"85b2d7a319ae4d41\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/handleStore.js\":\"a7ed82a6cdecf82c\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/idleMarkerJobs.js\":\"87e160e8cf25b380\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/initialDownload.js\":\"76757628a9707549\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/initializeClientDatabase.js\":\"c677fbbffd00a171\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/jsonCanonical.js\":\"afd14f91cbd01ff6\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/kernelInvalidation.js\":\"2b35a2636e59ee31\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/kernelProcessors.js\":\"3a925b0e3e3a700b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/kernelQueries.js\":\"9c9d52a7cd4f6bac\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/mergeTypeMembershipProcessor.js\":\"07ad87404430f382\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/normalizeReferencesProcessor.js\":\"01389ac2a1e00551\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/poolInstrumentation.js\":\"359fc2da8d4731cb\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/processorRunner.js\":\"9b9f1ad38edd0d94\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyCellBackfill.js\":\"8d5dfa49918260f8\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyChildMint.js\":\"557be546a860fa16\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyChildrenProcessor.js\":\"68816ca5f5cd7728\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyDefinitionChangeProcessor.js\":\"f5f081fd7ceb5897\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyDefinitionSynthesis.js\":\"624a9d69213e89f5\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyKeyScan.js\":\"6dfd92edda0e8d3f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertySchemaResolution.js\":\"1434fcca5f50d0f5\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/propertyValueEdits.js\":\"f960210b70b0bd32\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/raiseProtocol.js\":\"6dfb7514708e52b0\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/readBatch.js\":\"cc7f1b3efe55e51e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/refProjection.js\":\"1062f3d0ebbb357c\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/referenceTargetLookups.js\":\"49800566e46c3562\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/referenceTargetProcessor.js\":\"7bae4d6b826b0c75\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/replayMerge.js\":\"8451e9609269250c\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/sqlBinds.js\":\"6fbd64934ad3f6f3\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"3233429c401c801b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/syncObserver/arrivalProcessors.js\":\"6fe01e6acae4f988\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/syncObserver/invalidate.js\":\"c99f7d72e7f552ad\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/syncObserver/materialize.js\":\"12b27d27c4798d70\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/syncObserver/observer.js\":\"e7ac794d6c6f577b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/syncObserver/reconcile.js\":\"23e7aa0f3aac7b01\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/timingMetrics.js\":\"8f89f6624d8c2e4e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/treeQueries.js\":\"78218e78eac0871f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/txEngine.js\":\"3d66251d05a53155\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/txSnapshots.js\":\"afd03ea9dd8372a7\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/typedBlockQuery.js\":\"8c2c017348fe4972\",\"/knowledge-medium/pr-preview/pr-1889/src/data/internals/undoManager.js\":\"9686b535996d1159\",\"/knowledge-medium/pr-preview/pr-1889/src/data/invalidation.js\":\"3292fa880790ea16\",\"/knowledge-medium/pr-preview/pr-1889/src/data/kernelDataExtension.js\":\"29235a0f325542c5\",\"/knowledge-medium/pr-preview/pr-1889/src/data/kernelPage.js\":\"73c491e069766e0d\",\"/knowledge-medium/pr-preview/pr-1889/src/data/kernelValuePresetCores.js\":\"04d7724bcec53af8\",\"/knowledge-medium/pr-preview/pr-1889/src/data/localDbCorruptionSignal.js\":\"b6c703a374df0bea\",\"/knowledge-medium/pr-preview/pr-1889/src/data/localDbStorage.js\":\"93b2b83d54323529\",\"/knowledge-medium/pr-preview/pr-1889/src/data/localDbVfs.js\":\"e69f03a29713e3a7\",\"/knowledge-medium/pr-preview/pr-1889/src/data/localSchema.js\":\"9ba48da2037e403c\",\"/knowledge-medium/pr-preview/pr-1889/src/data/maintenance.js\":\"febf82c4ff3bb2d9\",\"/knowledge-medium/pr-preview/pr-1889/src/data/mergeProperties.js\":\"22f3dfc756f3bc5b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/metricsConsoleHook.js\":\"d54769a227d283a6\",\"/knowledge-medium/pr-preview/pr-1889/src/data/migrationsPage.js\":\"84a73c084f98dab4\",\"/knowledge-medium/pr-preview/pr-1889/src/data/mutators.js\":\"c7a1f3b5515cd11f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/orderKey.js\":\"f6de878fa1a62966\",\"/knowledge-medium/pr-preview/pr-1889/src/data/orderKeyPlacement.js\":\"74cf0d5f856af858\",\"/knowledge-medium/pr-preview/pr-1889/src/data/outlineSurface.js\":\"5856e59571619516\",\"/knowledge-medium/pr-preview/pr-1889/src/data/pendingEditorContent.js\":\"232452d3a6e6305b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/pendingUploadsSql.js\":\"de45f84cf8e54808\",\"/knowledge-medium/pr-preview/pr-1889/src/data/pluginStateExtensions.js\":\"2be5ead59d757490\",\"/knowledge-medium/pr-preview/pr-1889/src/data/powerSyncLogger.js\":\"96236f6f887859d1\",\"/knowledge-medium/pr-preview/pr-1889/src/data/projectorRuntime.js\":\"59a3439d3a809b37\",\"/knowledge-medium/pr-preview/pr-1889/src/data/properties.js\":\"daecb6dccd1180ee\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertiesPage.js\":\"6a70f38cd89c6705\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertyChildren.js\":\"c9257dcb477cb65b\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertyDefinitionFanout.js\":\"2dac3fe636386e97\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertyDefinitionMetadata.js\":\"7e041db93b5a72b1\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertyDefinitionRegistry.js\":\"fd69a559c08a7b3d\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertyDisplayMode.js\":\"5107f5e8881fad50\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertyRowCreation.js\":\"fbaee4333d21c426\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertySchemaCreation.js\":\"db86f32181dc7bbe\",\"/knowledge-medium/pr-preview/pr-1889/src/data/propertySeeds.js\":\"4446b10a50270748\",\"/knowledge-medium/pr-preview/pr-1889/src/data/recentsPage.js\":\"c23fdd58845529f4\",\"/knowledge-medium/pr-preview/pr-1889/src/data/refTargetComparableProperty.js\":\"2d42e6cf978979c3\",\"/knowledge-medium/pr-preview/pr-1889/src/data/referenceBlock.js\":\"c91f5ab378a0cc71\",\"/knowledge-medium/pr-preview/pr-1889/src/data/rejectedUploads.js\":\"56c5e1cf7c28c2f9\",\"/knowledge-medium/pr-preview/pr-1889/src/data/releasePowerSyncConnection.js\":\"de379058e72efaf0\",\"/knowledge-medium/pr-preview/pr-1889/src/data/repo.js\":\"80187a4de3555d49\",\"/knowledge-medium/pr-preview/pr-1889/src/data/repoProvider.js\":\"73e9b471b0fc0c98\",\"/knowledge-medium/pr-preview/pr-1889/src/data/rowProperty.js\":\"25be0c465f546a81\",\"/knowledge-medium/pr-preview/pr-1889/src/data/searchFilter.js\":\"b11a208bc73f69b7\",\"/knowledge-medium/pr-preview/pr-1889/src/data/seedIdentityLedger.js\":\"6a0dee88783fbfea\",\"/knowledge-medium/pr-preview/pr-1889/src/data/stateBlocks.js\":\"bb091ecc7fbfe300\",\"/knowledge-medium/pr-preview/pr-1889/src/data/structuralEditPolicy.js\":\"c02cec068c9db741\",\"/knowledge-medium/pr-preview/pr-1889/src/data/structuralInsert.js\":\"c6782c73beaba652\",\"/knowledge-medium/pr-preview/pr-1889/src/data/subtreeDelete.js\":\"69b6ac6d875a1fa6\",\"/knowledge-medium/pr-preview/pr-1889/src/data/syncStreamLock.js\":\"fdccbd4a8ab2e7f3\",\"/knowledge-medium/pr-preview/pr-1889/src/data/syncedTableSqlRecognizer.js\":\"8183cc30a58b83a1\",\"/knowledge-medium/pr-preview/pr-1889/src/data/syncedTableWriteGuard.js\":\"902766e3c726c840\",\"/knowledge-medium/pr-preview/pr-1889/src/data/targets.js\":\"9fddfe8e0c25374f\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeColors.js\":\"5a57471c4faca114\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeDefinitionMetadata.js\":\"f252cad9c61c6780\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeDefinitionRegistry.js\":\"a79574900e21590d\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeExtraction.js\":\"41307b252bf09b80\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeInitialValues.js\":\"66403a4b0fd73331\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typePropertyGroups.js\":\"f6ac0be370bf7a72\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeSeeds.js\":\"b4c7f1f5502ea7e5\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typeTagger.js\":\"8029fc0d3f232429\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typedRecords.js\":\"3219f121703578e1\",\"/knowledge-medium/pr-preview/pr-1889/src/data/typesPage.js\":\"0a17770ea54f94fb\",\"/knowledge-medium/pr-preview/pr-1889/src/data/userPrefs.js\":\"d948483844933ba2\",\"/knowledge-medium/pr-preview/pr-1889/src/data/userSchemasService.js\":\"3f571be46657ab3e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/userTypesService.js\":\"265a742191fcc620\",\"/knowledge-medium/pr-preview/pr-1889/src/data/valuePresetRegistry.js\":\"ef117549f6940dff\",\"/knowledge-medium/pr-preview/pr-1889/src/data/visibleChildren.js\":\"565bb6ed7b2efba9\",\"/knowledge-medium/pr-preview/pr-1889/src/data/workspaceConversion.js\":\"44339a51f16b5efa\",\"/knowledge-medium/pr-preview/pr-1889/src/data/workspaceFirstSync.js\":\"031ee02dc2c32775\",\"/knowledge-medium/pr-preview/pr-1889/src/data/workspaceIdNamespace.js\":\"5418591fd7a532a6\",\"/knowledge-medium/pr-preview/pr-1889/src/data/workspaceSchema.js\":\"5dbfe1545b7cb2e0\",\"/knowledge-medium/pr-preview/pr-1889/src/data/workspaces.js\":\"a231ca2b63dc194e\",\"/knowledge-medium/pr-preview/pr-1889/src/data/writeAheadLog.js\":\"2272c6957665943a\",\"/knowledge-medium/pr-preview/pr-1889/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/BlockPasteShellDecorator.js\":\"1bcd64db513e1471\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/atTrigger.js\":\"8210fd8039144f45\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/autocomplete.js\":\"0f86a5da835f95e4\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/codeMirrorExtensions.js\":\"abb835fe58007494\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/contentFlush.js\":\"b8568d3724b5b907\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/defaultInteractions.js\":\"ead576172d3f358c\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/editSettleSignal.js\":\"41fc8789efe30a50\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/insertImage.js\":\"d9609ee6a5ec5c71\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/referenceCompletionRange.js\":\"a3bd6f2243caa85b\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/referenceTargetTypes.js\":\"53e2753496293ca2\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/syntaxContext.js\":\"408bb1150350678a\",\"/knowledge-medium/pr-preview/pr-1889/src/editor/triggerMatch.js\":\"e4ddd353c365e9c5\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/AppRuntimeProvider.js\":\"181a49e50f4147b2\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/BlockFocusShellDecorator.js\":\"99557b58ccbd5161\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/ExtensionRenderBoundary.js\":\"b551d8260a7a9b03\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/PanelContentRecovery.js\":\"a61888f66bd0d179\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/apiCatalog.js\":\"c092aef266181716\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/approveExtensionHere.js\":\"bce5c772011ec34e\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/armedCutAppMount.js\":\"e07140038b78307e\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/batchableKeyedStore.js\":\"975fd5b55ee5efea\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/blockInteraction.js\":\"136ab9beb9bbffec\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/blockSelectionAction.js\":\"8067e5f8754dea96\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/compileExtensionModule.js\":\"d1cda81e25c6a3d1\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/compiledModuleCache.js\":\"bce5745aa11f6f8c\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/continuousGestures.js\":\"23196b3c5bc166ec\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/core.js\":\"8e201ac4407154d1\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/defaultRenderers.js\":\"aa6658c2b206ecb6\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/definitionFanoutAppMount.js\":\"c88c013bd977dda6\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/dialogAppMount.js\":\"a9d8f99a0f21da40\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/dynamicExtensionSeeds.js\":\"6b2fc87db67b3220\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/dynamicExtensions.js\":\"328992119db19b77\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/exampleExtensions.js\":\"062e8f23629eefcc\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/extensionApprovalStatus.js\":\"ef1a0ecbc2e3388b\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/extensionLoadErrorToast.js\":\"24a936c42781f2a9\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/extensionLoadErrors.js\":\"2cc5899ca53bb37f\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/extensionLookup.js\":\"4c8eee12a70c1f2e\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/extensionToggles.js\":\"1d82e9caff826a90\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/extensionUtilitiesCss.js\":\"0a524f33d918cd8b\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/kernelPageDeletionGuard.js\":\"0d883ff769a8ba82\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/liveRuntime.js\":\"465d352f7d4cde59\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/openExtensionsSettings.js\":\"19ec994ee64c40b5\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/overridesCache.js\":\"4c7077dc70a3bd5a\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/pluginIds.js\":\"665a1e1b69d2e9d2\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/processorRejectionToast.js\":\"e2ea78aab3cf07e2\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/runtimeActions.js\":\"10a52763ae8158bc\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/runtimeContext.js\":\"0f39ca131936ee5a\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/staticAppExtensions.js\":\"850421f4cd7fe638\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/staticDataExtensions.js\":\"b314beea677db749\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/toastAppMount.js\":\"2f22977926804546\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/useOverrides.js\":\"30f03cdbec789422\",\"/knowledge-medium/pr-preview/pr-1889/src/extensions/useShortcutSurfaceActivations.js\":\"78ed0697cbb03ecf\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/discoverToggleTree.js\":\"00cd09b2ef4b49d3\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/facet.js\":\"c568985b80d191e5\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/resolveAppRuntime.js\":\"b080e3e4a21b46d7\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/runtimeEvents.js\":\"35552266651a9710\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/togglable.js\":\"86c7758af6cb3cb2\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/variantFacet.js\":\"2006fc46d774fc13\",\"/knowledge-medium/pr-preview/pr-1889/src/facets/verbFacet.js\":\"81018e8d3afab592\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/block.js\":\"73e8b82af317f23c\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/focusedChild.js\":\"0b8336c0f40aa4cc\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/propertySchemas.js\":\"c87813b40b287d81\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/typeRegistry.js\":\"6459af2d3618c5fe\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useAncestorCrumbs.js\":\"e6232900304a6bbe\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useAutocompleteListbox.js\":\"463a8bfdff69e6de\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useDebouncedSearch.js\":\"505ca7476d5ee238\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useDebouncedValue.js\":\"6a3c147cab272b9b\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useFacetValue.js\":\"941474b507145cc9\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useIsFocalRender.js\":\"b041368b1c722f68\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useIsReadOnly.js\":\"f273474f3663cfb1\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useMaterializeBacklog.js\":\"b251ffe6dd57889c\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useMinuteClock.js\":\"330d2d8e9887430f\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/usePanelLayoutProjection.js\":\"a594116746b10c3b\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/usePendingInvitations.js\":\"097424ed3355f90e\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useRendererRegistry.js\":\"df083ca5010861a9\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useRetainedFieldRows.js\":\"2584e6c4a98e7741\",\"/knowledge-medium/pr-preview/pr-1889/src/hooks/useWorkspaces.js\":\"493ea96cff1e7c49\",\"/knowledge-medium/pr-preview/pr-1889/src/lib/utils.js\":\"453b5537bfd45cec\",\"/knowledge-medium/pr-preview/pr-1889/src/main.js\":\"a88cb05b62a3b910\",\"/knowledge-medium/pr-preview/pr-1889/src/markdown/MarkdownImage.js\":\"708157d321f01972\",\"/knowledge-medium/pr-preview/pr-1889/src/markdown/blockSeparators.js\":\"f4a7b0740398662d\",\"/knowledge-medium/pr-preview/pr-1889/src/markdown/context.js\":\"5774138dc1128b56\",\"/knowledge-medium/pr-preview/pr-1889/src/markdown/defaultMarkdownExtension.js\":\"ba8f8c1833f75d04\",\"/knowledge-medium/pr-preview/pr-1889/src/markdown/extensions.js\":\"77d5e1bfea441693\",\"/knowledge-medium/pr-preview/pr-1889/src/markdown/renderMarkdownHtml.js\":\"cb7a2db562bef16a\",\"/knowledge-medium/pr-preview/pr-1889/src/minimal-editor.js\":\"c57c5ca6988468f1\",\"/knowledge-medium/pr-preview/pr-1889/src/paste/armedCut.js\":\"5a1aa595fa5f2de9\",\"/knowledge-medium/pr-preview/pr-1889/src/paste/captureMediaVerb.js\":\"13aab4fc400ba757\",\"/knowledge-medium/pr-preview/pr-1889/src/paste/clipboard.js\":\"48e02a94e4463bf1\",\"/knowledge-medium/pr-preview/pr-1889/src/paste/decision.js\":\"858567eaffaa8b7b\",\"/knowledge-medium/pr-preview/pr-1889/src/paste/operations.js\":\"42c15b5dae7108f2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/account-header/AccountHeaderItem.js\":\"f16df6b17f80517f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/account-header/index.js\":\"54dc719ad42031d3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"1f49f25669fd5198\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/askAgent.js\":\"5ce1efbd754ca9e8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/askedStore.js\":\"b855c00b5606a9ec\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5c81da474aa923cb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/chipState.js\":\"f41cdf59a8c88ff5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ec7c68a30b767526\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/index.js\":\"8fa69b44de16e83c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d7a0934dbf8008a2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-dispatch-companion/schema.js\":\"e0999674682585fc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/AgentTokensDialog.js\":\"955238a1036f6164\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/BridgePairingDialog.js\":\"cf30d27a044c384e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/addMedia.js\":\"f1c31efcc04cccf6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/backlinks.js\":\"5db3b365fb254ba2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/block.js\":\"8a12c3953e2646e2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/context.js\":\"d7ca91250c0f5e0c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b6988cb4a7f5028f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/index.js\":\"3764a1aa6a6aaf00\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/outline.js\":\"71ed586417858fd1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/properties.js\":\"690ae72de4509d15\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/refs.js\":\"82e4fd573043ae6d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"da2f4009d9239304\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/search.js\":\"70ee3166f86be408\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/shared.js\":\"e63b71ce8b373f46\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"67fb73de58d35fc9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentViews/text.js\":\"7978b709758f28a1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/agentWrites.js\":\"e5eec97415af2927\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/authoringCatalog.js\":\"fcf6c616d33111a6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/blockRefTargets.js\":\"2a986f94680ddc02\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/bridge.js\":\"a931f3f201f43ba0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/bridgeLoop.js\":\"d44f705c51342c7f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/changeHistory.js\":\"50a84f8be4908bf9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/commands.js\":\"9063c7183950c650\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/commentsCommands.js\":\"5fc7b19e6c74e2e6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/dataExtension.js\":\"61f702fb8c34473e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/dataModelGuide.js\":\"8bf5051695774328\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/dayPropertyInputs.js\":\"2a8b7c55cc25626c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/describeRuntime.js\":\"521298aca93730d9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/extensionLint.js\":\"a31f434b1a685b02\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/grainAudit.js\":\"3f5fb04a36164c61\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/healthCommand.js\":\"2a3dc3df76c2f15e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/index.js\":\"b557e88c68ab17a5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/presetIdentity.js\":\"5d4f57f06f395085\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"55941c23b64ed26b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/readMedia.js\":\"12b2e9e917786114\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/schema.js\":\"60f4c366026d85e5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/serialization.js\":\"dc0f24811b0b8365\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/targets.js\":\"fbb5d18297ec8dd1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/tokens.js\":\"729cdb746de87911\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/watchEvents.js\":\"c283de0ea12b85f4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/workspaceGuard.js\":\"92c15d4c8e135b30\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/agent-runtime/writeCommands.js\":\"a1ed41515636e861\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/AliasCollisionToast.js\":\"04f20bd32617701f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/DuplicateNameBanner.js\":\"3d48de357d6e5a8c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/collisionMerge.js\":\"7766e0092ab523d5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/dataExtension.js\":\"06affa6e794bd879\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/index.js\":\"34a4fac4dbc6c4ac\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/mergeCollisionAction.js\":\"5e349abe00c6597a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/pageStyling.js\":\"270730497f61615d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/rejectionToast.js\":\"fa7dc78ddad20be8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/alias/syncProcessor.js\":\"28b08383667533df\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/actions.js\":\"501b76383917e87b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/addComment.js\":\"b5c42c094daea195\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/anchor.js\":\"0e004c79cd74a282\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/anchorState.js\":\"48dedd52a9b1cbd6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/commentLinks.js\":\"16191e16a2685d7e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/confirmThreadDeletion.js\":\"c23ff78a78880920\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/container.js\":\"97ab45aa1e9a64b6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/dataExtension.js\":\"b9edcb952418eb25\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/deleteComment.js\":\"c16b405523d044d0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/highlights.js\":\"c4e2ade674eb6aef\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/index.js\":\"0ce7d4250f81ef39\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/linkedCommentsPill.js\":\"25b013568e95bead\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/margin.js\":\"673b9b6ebb683e27\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/marginAnchorLinks.js\":\"ed6e47eac186890f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/marginSchema.js\":\"1ac9760fff2e7e14\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/newComment.js\":\"d0ee260f69e8d3e0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/ownThreadPicker.js\":\"452a28f9373dc1bf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/placement.js\":\"f18823eccf389a5a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/queries.js\":\"2be03e330fa083e1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/quotePosition.js\":\"1739f1c4eddad44d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/quotedIn.js\":\"45b537cc1857dc2b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/quotedRange.js\":\"76ce180f0fd49196\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/rangeRefs.js\":\"c1ccad66c18988bc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/readHighlights.js\":\"454bd93a5ed44c33\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/readSelection.js\":\"03a654d09f62b42e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/readSelectionUi.js\":\"ce20c3410baa4d6c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/reanchor.js\":\"7fe3fff766ec2156\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/schema.js\":\"04bde58a2009431e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/scope.js\":\"09e72679ae3bcbd8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/scopeThreads.js\":\"e9e09a7933603f57\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/splitRetarget.js\":\"74966d99321c6e9c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/suggestionCard.js\":\"4089ddaa2828077e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/suggestions.js\":\"92cb7c6cd1e5de81\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/summaries.js\":\"5e81430bb524ee5b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/summaryBatch.js\":\"638c5d6d0df1d376\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/surface.js\":\"f66137756c1a696b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/threadNavigation.js\":\"78d251eea027296e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/threads.js\":\"af7ca69ac75e5c71\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/ui.js\":\"8da6bddfd46e6247\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/annotations/uiStore.js\":\"7f9d7716f2f657d5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/app-intents/appIntents.js\":\"d6a76fdeb8bdf235\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/app-intents/index.js\":\"de064624a1f7f89b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/app-update-prompt/index.js\":\"5fb55d6242a7fa33\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/app-update-prompt/status.js\":\"8e9439ce67b2f9d2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"422f0b11a4e7aa21\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/MediaBlockRenderer.js\":\"e8a5e325126dd73b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/MediaDownLaneReplicator.js\":\"dd3ccf4ae7343607\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/MediaUploadReconciler.js\":\"7d70f16380823eb1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/assetDownLane.js\":\"71b1cf7a89184e89\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/assetResolver.js\":\"279172badd26a4ac\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/assetUpload.js\":\"96339d215c15e644\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/attachmentCleanerIO.js\":\"2601942e6640f80c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/audit/supabaseAuditIO.js\":\"323fb53154b43679\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/blobStore.js\":\"7ef73fb26b4a8d64\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/browserMedia.js\":\"ccb5582a9c2cbd74\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/byteStore.js\":\"df7d5e4b94a6cdca\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/cleanerIO.js\":\"2c6856aed110fa73\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/cleanupAttachments.js\":\"974bec89c26fe57e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/dataExtension.js\":\"bc68a9e354d853f9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/downLane.js\":\"eb386176f26cc0b2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/index.js\":\"cbbda0941e4fc11a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/insertImageContribution.js\":\"2677b6c3a5086ce4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/laneArming.js\":\"5a17de3d3c38118f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/laneLock.js\":\"518d006def61753a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/mediaBlock.js\":\"4822d96055a6f06d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/mediaCapture.js\":\"15a0a9ab1bf8e575\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/mediaLanes.js\":\"c8480d803e5e28db\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/mediaViewers.js\":\"fc8495a1c90f41a6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/mediaViewersFacet.js\":\"c11b834ea27374ef\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/pasteCapture.js\":\"0d761a2fb5b051cc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/resolver.js\":\"dd6dc4cd85c294f0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/retryUploadsAction.js\":\"e998cee0db0e2d45\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/storagePaths.js\":\"3e92ad0f04d8e5ed\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/uploadDrain.js\":\"50814281ec95f2a1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/uploadLaneStatus.js\":\"26565a92c9882263\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/uploadReconcile.js\":\"f804d1c1e74cac96\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/uploadRecovery.js\":\"3aea6bbecf78efef\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/uploadStore.js\":\"0f0e15985f3e9e1c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/attachments/useAssetObjectUrl.js\":\"96fce7a8c58d20e7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"a26ae308f3cf5d95\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e31422c5943ab998\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks-view/facet.js\":\"a336aa39d9e82c4f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks-view/index.js\":\"8bd08d1a16269172\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks-view/prop.js\":\"f8e605993611a958\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/BacklinkFilters.js\":\"c41659fcf52b780b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"594572d135da8a8f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/BlockEntry.js\":\"c8904abf2232a8a7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/LinkedReferences.js\":\"723d13d77eff76fc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"62f5f85fd4f595ae\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/dailyNoteDefaults.js\":\"7b63f6d0cdfbffc5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/dataExtension.js\":\"8612e8bfd8c6135e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/edgeExclusions.js\":\"86ff02538b86584a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/filterProperty.js\":\"33b03c2bdf111f3d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/index.js\":\"35627f28d91a4ed4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"64ce248082965025\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/inline-counts/applies.js\":\"b6b325c0169f1909\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/inline-counts/countQuery.js\":\"b8e674765ce30750\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/inline-counts/expansionStore.js\":\"2b397e2dff6593bd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/inline-counts/index.js\":\"c0db081f4d8b1bd5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"abd8e709df9e1e17\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/presentationInvalidation.js\":\"a2ec949feb05e641\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/propertyEditorOverride.js\":\"426e14e30f3cd7b3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/propertyFilter.js\":\"fe2f356d120051f8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/query.js\":\"a406651b6ba37fd3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/resolveFilter.js\":\"add01ce813d0b95a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/sourceBatch.js\":\"5676b627b5cd7c53\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/sources.js\":\"d8fdadb0b76a305d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/useBacklinks.js\":\"62e02ed42adcdb7e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"797ead1c261ca563\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/birthday/BirthdayCelebration.js\":\"182e3d480083fe3a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/birthday/BirthdayOverlay.js\":\"a0efa7c02ef28c00\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/birthday/gate.js\":\"3a756217c9d807f6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/birthday/index.js\":\"658bf987ab1b4c0f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/birthday/wolfTheme.js\":\"df8c1de639f696a7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-drag/BlockDragLayer.js\":\"ed697a8fc81804a8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-drag/dragController.js\":\"8c976030ccdf28c9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-drag/dropTarget.js\":\"4c62505e6413de25\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-drag/index.js\":\"b3e097ae03b60c8e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-drag/projection.js\":\"3b59c6dc8210aa90\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-info/BlockMetaCard.js\":\"b2352ee9cedb01ff\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-info/index.js\":\"ad99865014ed8d17\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/AddTagDialog.js\":\"758359138c8a0ae1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ef4d1f96639333b5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/TagNameIssueHint.js\":\"6490604340fd7034\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/addTagAction.js\":\"12d06d69593779a7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/appendTag.js\":\"e3f7a891c62ab622\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/config.js\":\"56e7aa8b2a85b8fe\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/dataExtension.js\":\"94246d6f89ac9e9d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/index.js\":\"ad2e571023a56002\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/block-tagging/propertyEditorOverride.js\":\"fad22407f04dcef0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ea39ca4e0e13e98c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"2c4075610b1a167a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/Breadcrumbs.js\":\"3297617e96604280\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e375e2836661b673\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"fdff4b5c3cbf3aee\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/index.js\":\"d1b6bd0db1c48657\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"f48eb1b4aa20af41\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/CharacterCountItem.js\":\"642ca66afa38538d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/ProfilePropertyEditor.js\":\"0373707262ef8e6c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/actions.js\":\"c10342eedde13039\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/blockType.js\":\"fa61371e2a767ce3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/charCount.js\":\"52ec85cc0abf984a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/dataExtension.js\":\"bab76f258b2bc596\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/index.js\":\"b40807fdb24812aa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/profiles.js\":\"a0ca1e40695b8a83\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/properties.js\":\"5b266eca984aa674\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/subtree.js\":\"575e8345751b198e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/character-counter/textCounts.js\":\"2d528695ecc0008f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/colemak-keybindings/index.js\":\"15b4248131e27728\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/CommandPalette.js\":\"59f51b3fbd28b21b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/HeaderItem.js\":\"cfcc26641f1fe636\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/context.js\":\"963f6422d77cf3c0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/index.js\":\"3bd953aaa5596a5f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/selection.js\":\"a6cbfb00d149d235\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/toggleStore.js\":\"0c0839a6645ea7c3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/command-palette/useCommandPaletteActions.js\":\"f751a5cb6376ebf4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/ContributorBadges.js\":\"cd8b19202eb8bd35\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/author.js\":\"dde818913c0b7976\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/codeMirrorExtensions.js\":\"f1d6344c8bc6cc56\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/dataExtension.js\":\"65f54c11e1fcd0fc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/index.js\":\"f791bb82c767503e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/mentionAutocomplete.js\":\"7fd4eff1dbf603da\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/processor.js\":\"978df6c86764c1dd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/profiles.js\":\"146c0e4e283db343\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/queries.js\":\"e902df6e4b2810b7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/contributors/schema.js\":\"be720de6c8117ca8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ff5887092c2267fa\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/cursor-follows-scroll/followOrigin.js\":\"3172197774776598\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/cursor-follows-scroll/index.js\":\"cbc82b7751c054e2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"44d0e6530850ac2c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c877074e33d381ad\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/CalendarGrid.js\":\"6637fc747ff840d7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/DailyNotePicker.js\":\"08c7c97b1ef40067\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"1d93ac0b5e10f214\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/DateNavDecorator.js\":\"ace7950db1989051\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/DateScrubOverlay.js\":\"199f77aadf3e676f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/DayPropertyControl.js\":\"c063e2295e3a9cac\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/DayValueReferenceControl.js\":\"24faeba3dc106e45\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/HeaderItem.js\":\"57f06be43be93b7f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/ReschedulePicker.js\":\"5ad51d1ab2c66e7a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/SpreadDatesDialog.js\":\"97f22ddfeb2c618a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/actions.js\":\"d508c211d1c3e67b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/blockDateAdapter.js\":\"4778d66ccf1a7a54\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/calendar.js\":\"69f7527e2e5cb5dd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dailyNotes.js\":\"2e2da5f38bfe3dbd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dataExtension.js\":\"5149974a73684646\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dateScrubActions.js\":\"ec28c889972a58e4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dateScrubGesture.js\":\"d592a697e3a364ee\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dateScrubGestureActions.js\":\"f0669ef32a179a8c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dateScrubRecognizer.js\":\"6527c3a30f19b14a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dayProperty.js\":\"8735f0744eb0bbcf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"3e6046de9448606b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/deletionGuard.js\":\"89c998fa44b6c3a2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/dueQuery.js\":\"f55f8ca4951f2290\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/index.js\":\"2874b71f88e6657a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/landing.js\":\"3f130cc31fd20513\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/localSchema.js\":\"718279fa7a984467\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/referenceDateAdapter.js\":\"021cab2de62b1bfe\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/rescheduleAction.js\":\"14a1647cb4ada534\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/schema.js\":\"09eb742a09cedeff\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/spreadBlockDates.js\":\"3a475d1631947545\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/spreadDatesAction.js\":\"8bb329a41ecd1f4f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/today.js\":\"516cc1e1554ebc0e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"606d57865ecb3050\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c52cc612570d101f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/audit.js\":\"98156023e0b74c98\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/auditAction.js\":\"4a30f5640e234b9d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/auditRanges.js\":\"aee5a3b494e07d28\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/diagnosticsSource.js\":\"f234753ec5220425\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/divergenceScan.js\":\"09e6a811a184ec4f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/index.js\":\"f22228f5057bcddc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/propertyChildrenChecks.js\":\"ab9cb86543c2054c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/referencesMirror.js\":\"18770e812a53dfc0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/rowJson.js\":\"71a9b80554c75ccb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/schedule.js\":\"78f768790228efdd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/data-integrity/store.js\":\"a4909046b8b59099\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-maintenance/action.js\":\"b8fbe0c3130d0a3a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-maintenance/index.js\":\"b34b6c7961db5d9c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-maintenance/plugin.js\":\"3467044222f42bf2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"321927a888d25669\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/actions.js\":\"f0c7a73d7f2927c0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/changeMarker.js\":\"94480812d566a986\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/diagnostics.js\":\"4de4ec391e4a96eb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/fileSystemAccess.js\":\"d201a050fd27cc9c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/filenames.js\":\"614ad008b8ee4123\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/index.js\":\"ad7253dda41e082a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/mirror.js\":\"c783ed678901d8f5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/runLock.js\":\"c3c17319019f0f98\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/runtimeHealth.js\":\"d5ba9cacfdabe006\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/schedule.js\":\"7bace98b1dd56ab3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/db-mirror/store.js\":\"d4f87fe5598cf51c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/default-themes/index.js\":\"d4250ee59ce5f9cd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/default-themes/themes.js\":\"c4b043f70ffc6093\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/diagnostics/facet.js\":\"a4c0e7a15ffa3edf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/diagnostics/useDiagnostics.js\":\"2b183896b0785f06\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extension-prompts/dismissals.js\":\"5a17db182eedbcc0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extension-prompts/index.js\":\"299f2dfb1d7837df\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extension-prompts/status.js\":\"62cdf42bf2239c21\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extension-prompts/store.js\":\"8b163688be33c104\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"ded676cbc0f3b810\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8cbafee50b7225c5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/actions.js\":\"89797004429a9af5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/config.js\":\"f4653971b1ac2c05\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/dataExtension.js\":\"2c70086b5dccbca0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/effect.js\":\"d86da6da1b3b0026\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/index.js\":\"ccab20ca40599ccd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/propertyEditorOverride.js\":\"76a5afa158f36345\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extensions-settings/useToggleTree.js\":\"ea693877452e8292\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extract-type/ExtractTypeDialog.js\":\"9e9bf7841c28c0e1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"034d980c9c96bc2f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extract-type/PropertyShapePicker.js\":\"b5113bdcd2465bff\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extract-type/action.js\":\"f5308a20b3ff437b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/extract-type/index.js\":\"7ec5d7b91c6e9d06\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/FindReplaceDialog.js\":\"2e5315360cc0d480\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/HeaderItem.js\":\"132c6da3628700f8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/dataExtension.js\":\"757633e202e52656\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/index.js\":\"51fafa9c43363106\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/search.js\":\"34666384706d1b48\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/toggleStore.js\":\"091667c1f00ae4d8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/LocationPropertyEditor.js\":\"7626f6ff9e2feb2c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/MapView.js\":\"f818eb023dcdf162\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/blockTypes.js\":\"b1cf9e7d9ae25c2f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/codeMirrorExtensions.js\":\"2d3dadbc23fefe39\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/createOrFindPlace.js\":\"a66a7380e8c5e668\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/currentLocation.js\":\"abe61fc6c32110ea\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/dataExtension.js\":\"72508f406bf6a397\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/geoContentDecorator.js\":\"16ee43c1cb4f729d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/googlePlacesClient.js\":\"950cf9a1a2831ccc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/index.js\":\"135b306b6bf70588\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/locationsPage.js\":\"7a8262812dc3e41d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/mapViewport.js\":\"087ef86e43367374\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/pickCurrentLocation.js\":\"6dcf8583d4022db2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/placeAutocomplete.js\":\"1102594fb6d913df\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/placeNameCollision.js\":\"d9e2218176767749\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/properties.js\":\"186c49918de63468\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/propertyEditorOverrides.js\":\"a3378c0820438f20\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/query.js\":\"b4a5f121391a2171\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/geo/usePlaceSearch.js\":\"491932401f507d2a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"90ba205faa19f4cd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b0f6ff7f2b759a1b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d45c9f9da1295a92\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/config.js\":\"a79ce72d2c947b9d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/dataExtension.js\":\"25b408ecb66d30d1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/facet.js\":\"e6d4c73505f13606\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/grouping.js\":\"9d0bda4cb0729ab0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/index.js\":\"f9785e1ebb854ddc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"9d0f2aaa13ef3b7e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/query.js\":\"1519cc4292df42b9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/resolveConfig.js\":\"7c167f771e35d8e2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e8f1c5bf95bd1020\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"19c4cb4b6c45176a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/HtmlDocumentContent.js\":\"99e0a1da6ffea784\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/HtmlFrame.js\":\"5b2ca4a621272864\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/actions.js\":\"c4171ef76d466d05\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/blockType.js\":\"d96b05b9aa43d718\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/confirmRunScripts.js\":\"6984aab92ecb1ba2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/dataExtension.js\":\"595c55463725cd4f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/frameAnnotations.js\":\"6dc1e08d214c877e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/frameDocument.js\":\"479652c0fe07c5fe\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/frameTheme.js\":\"7a5349387ddbeead\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/index.js\":\"da7c8115d72c5ed1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/scriptConsent.js\":\"b3763bb839692fed\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/sourceMap.js\":\"acaa61c20b5b0afc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/html-document/useDocumentScripts.js\":\"888afb9ca2a442d4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/interaction-metrics/index.js\":\"c8855f0027d5a59b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/interaction-metrics/record.js\":\"fbeee224b9096c18\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/interaction-metrics/recordStore.js\":\"0dd7aa2abe5254d7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/interaction-metrics/responsiveness.js\":\"23266483a79145d3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/interaction-metrics/schedule.js\":\"887632b69428d0c9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/interaction-metrics/sessionContext.js\":\"60b5522069e1f10c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"fcf1043dd0a39d12\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"31b9cb02e43b3f06\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/actions.js\":\"b4a700a0b69268e8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/config.js\":\"eb59bf26d6161081\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/dataExtension.js\":\"d3c9d28787893b9e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/effect.js\":\"0c0b657c82e7dddd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/index.js\":\"eeaec103a9381ac5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/keyCapture.js\":\"844a23bce3d43195\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/overrideStore.js\":\"7474d326af8f103c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d4b6b422f527e8f1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/HeaderItem.js\":\"9f809a581c848349\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/LeftSidebar.js\":\"2a8053c6c643d571\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/actions.js\":\"a9efc2607e45a24f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/facet.js\":\"803f8ff5035c8a89\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/index.js\":\"e7425ff3963ddf49\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/shortcuts.js\":\"75cdfa5114330292\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/left-sidebar/toggleStore.js\":\"1f3c66aa509cb25c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/merge-blocks/MergePicker.js\":\"4200b6e8c2bd2cd5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/merge-blocks/index.js\":\"53f0c911dda4fde7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/merge-blocks/mergeAction.js\":\"c85a1c2c8a7358be\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/merge-blocks/strategy.js\":\"863f0cf44442d91d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-bottom-nav/Button.js\":\"1e76e37ec10a195f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"c27d1114e30d9455\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5287d86fb8f87620\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-bottom-nav/facet.js\":\"ae61a160f7c646ee\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-bottom-nav/index.js\":\"f9e0c779ae0806bb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"91f5439bca428095\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c10afbb101971fd5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0a1a9bcb1b328244\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-keyboard-toolbar/facet.js\":\"590d2414a25dd9ce\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/mobile-keyboard-toolbar/index.js\":\"65a18ea7de89e32c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/MoveDestinationPicker.js\":\"53c26cae476bd9b6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/blockSubtreeMembership.js\":\"6b7ee303e8118672\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/contextMenuItem.js\":\"3b5940aa5ed7c2e6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/index.js\":\"7301afa134ff7473\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/moveAction.js\":\"4d88455d252cf346\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/moveBlocks.js\":\"f0eb486d14aedff8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/move-blocks/selectionAfterMove.js\":\"185da56c68fe6680\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/TutorialBanner.js\":\"e9afcdb346201000\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/action.js\":\"ebb1da28234a085f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/bannerDismissal.js\":\"e5e3de57de464839\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/documents/cheatSheet.js\":\"ad4d60e4aa50225d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/index.js\":\"70fa09c7c496fe62\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/keys.js\":\"4c165ec25fa3b513\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/landing.js\":\"b408d49653c4cce9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/outline.js\":\"1870c59b20590bab\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/onboarding/seed.js\":\"5803c1c848c26ff2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/PerfTrendDialog.js\":\"53c10e6c2748cd94\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/analyze.js\":\"21f612e93c9f9b25\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/diagnosticsSource.js\":\"e4acf97bf670e5d6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/index.js\":\"d15bba51b673d68d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/load.js\":\"de6c7aec3a98b8b4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/monitorRun.js\":\"c5c7996c3efd5cb8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/schedule.js\":\"b465409fec67fd1e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/series.js\":\"b4263dcdac33d2c3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/store.js\":\"56a018ffa1f42e19\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/trendAction.js\":\"1be0f3911f6ac2eb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/perf-monitor/verdict.js\":\"6892dee17de4c55e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/plain-outliner/clickToEditAction.js\":\"2cacccfc2b4c019b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/plain-outliner/index.js\":\"71d4317e937d757e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/plain-outliner/interactions.js\":\"e8bf2389c827936e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1eaf0a633555637e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/MigrationGate.js\":\"b90f94a8a71a8222\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/MigrationGateDialog.js\":\"30427175fe22f52d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/action.js\":\"d190019af715dedc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/index.js\":\"82e91e15d239e2f4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/localRunMessage.js\":\"821b247cfb912b07\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/plugin.js\":\"97e8dd04af8f6341\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/progressReport.js\":\"04412a5e6d459212\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/properties-migration/sweepProgress.js\":\"d41cee540fcb3699\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/FieldRowRenderer.js\":\"f1da4a1514213601\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/ValueRowRenderer.js\":\"e67e08b41f6a7905\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/actions.js\":\"3116117dc5f43e4b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/autocomplete.js\":\"63007795b913a124\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/fieldRow.js\":\"a36da3bffde6f144\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/index.js\":\"28368b95f94f77c3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/referenceWarning.js\":\"25cfb7b5a7b2e07f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/valueAutocomplete.js\":\"374ae1586845c348\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/property-rows/valueSchema.js\":\"8fff904701f821ae\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/HeaderItem.js\":\"39ff9a23afa01674\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/QuickFind.js\":\"c8b3834417e6b219\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/index.js\":\"9bdeed47f75591ed\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/recents.js\":\"22b48669d1b8278e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/resultItems.js\":\"23158d5bdc31113f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/selection.js\":\"2604d1f603b4ac5c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/quick-find/toggleStore.js\":\"ab7f7b841107d73b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/recents/HeaderItem.js\":\"44b75292c821170f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/recents/RecentsPageBlockRenderer.js\":\"94ff54e438b025c6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/recents/grouping.js\":\"2e9f93c2a51e8133\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/recents/index.js\":\"afbc89681f23bcc6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/recents/target.js\":\"1d52bccc6cba2620\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/codeMirrorExtensions.js\":\"e3eeb53307745c36\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/contentPrefill.js\":\"893137d41ca66f4c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/dataExtension.js\":\"2f4277d9afdbb21f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/index.js\":\"bb2856b0e99e3f89\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"f1c68d1c6ae62f35\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/invalidation.js\":\"77c6b348357b2e58\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/localSchema.js\":\"3135bcba93193094\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/blockrefs/index.js\":\"be4edb0f19552299\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"edc72b911b145a1a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/index.js\":\"3f21d373c761a1d5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/referenceNode.js\":\"4a98ed84d5ef5d5a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a55422930c019135\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"2bd0aaf37fbfa4ee\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/wikilinks/index.js\":\"c1e5b54a1e5fe79b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"caf614e9e185adb1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"06c9d08d5130ea8b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/mergeRetargetProcessor.js\":\"5d2ae4bb72d45b33\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/parseFence.js\":\"88e6b446183639f0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/referenceParser.js\":\"a607e978d6fcea2d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/referenceProjection.js\":\"384d245a4ed97b06\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/referencesProcessor.js\":\"277929d6e0e34bfd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/renameProcessor.js\":\"f293beb79af33dd1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/references/spanReplacement.js\":\"588b3bece12570ef\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/rich-paste/htmlToOutline.js\":\"38f3f0c2726ee817\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/rich-paste/index.js\":\"726378ebea72eeeb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/rich-paste/normalizeClipboardDom.js\":\"329119861eb86ce1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/rich-paste/pasteDecision.js\":\"8a8a0534b3a79b26\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/action.js\":\"5fb2d6c51e0c809f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/blockIds.js\":\"60727a0db852f938\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/content.js\":\"5df1ccd287f7f4b9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/effect.js\":\"18d9fabd62e4b562\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/ids.js\":\"787de46d15cd3fc0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/import.js\":\"9bd3f8b03bc09b45\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/index.js\":\"c8f6575b33bad7ac\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/plan.js\":\"c1a411c80eaeaffc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/plugin.js\":\"fbfaec275b6e900b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/promotion.js\":\"b579e18e0fa54d1c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/properties.js\":\"91f5f539cb8e07d6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/references.js\":\"057c192bf8efc44f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/report.js\":\"ceff43d32b57686e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/roamMemo.js\":\"c7645230091b4a56\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/runtime.js\":\"0c01f4ee25ee977a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/schemaReconciliation.js\":\"7dd432c9007046c5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/srsMarkers.js\":\"f30694f9a1f06e92\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/todo.js\":\"dc59c0bc8ced05c7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/typeCandidates.js\":\"945d91638c0e8e22\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/roam-import/types.js\":\"9e11e0a128007119\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/search-health/index.js\":\"2cbdb0d7a2dbeebf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/search-health/store.js\":\"98fa1f17f111fc48\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/shortcut-help/HeaderItem.js\":\"ce7110980d940263\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3720102a0032a4c7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/shortcut-help/index.js\":\"c2b1493822f83fed\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/shortcut-help/model.js\":\"b2416ac499986a08\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/shortcut-help/toggleStore.js\":\"37bcd2270af8960e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/shortcut-help/useKeyInspector.js\":\"2dfb961262ab271e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"de4c411901e4fb85\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/ShellDecorator.js\":\"572c4cccb5872c59\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/actions.js\":\"f4d2ea4077fdc9fd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d397db5e6cc32946\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/index.js\":\"19d84d7758d5d0b1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/shell.js\":\"ca058f2185880fd1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/surface.js\":\"bfb10e6203bf6be8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/spatial-navigation/walker.js\":\"7964748cf851bcbe\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/RescheduleToast.js\":\"21c1174c29a8aa6e\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/dataExtension.js\":\"768c37f6d780a270\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/index.js\":\"07da30ffa0b7fbdb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/indicator.js\":\"b5b479004976d1ce\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/moveSrsState.js\":\"41113e6d6816f74d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9b59e3cb7434272b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/scheduler.js\":\"ca32727b90a33e9c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/schema.js\":\"dbd6e9c086be1a58\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6efe66df122304bc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/srsClipboard.js\":\"9ac1a67056095643\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"7c643a324cea6736\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6766314de179d2dd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/DeckPicker.js\":\"11b4df5284f5d70c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/ReviewControls.js\":\"8b34e2bf1ec5cc92\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/ReviewDeckRenderer.js\":\"40f13de0a3677758\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/ReviewSession.js\":\"d9544d1b2783e03a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/actions.js\":\"8a785fc166896733\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/archive.js\":\"0f78416a1cd20098\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/dataExtension.js\":\"f5bed22c9d5e6f8b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/deck.js\":\"c3ea558cc69c45d7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/dueQuery.js\":\"d5e7db487dc45906\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/gradeDecision.js\":\"0716fd9babdfb30c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/index.js\":\"965097a7d77cab97\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/keyHints.js\":\"be4910bd12670b4c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/reviewCardLayout.js\":\"2d3c770e8bc99015\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/reviewProgress.js\":\"e8bc4a759d2e3263\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/schema.js\":\"4380d125c50f60b4\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/srs-review/useDueCards.js\":\"3700ad00e6813a78\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/startup-metrics/index.js\":\"ba908ccc9bf2fbdf\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/startup-metrics/record.js\":\"1dd81d3af02d7f2b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/storage-persistence/index.js\":\"cdf668d7748fa8ac\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/storage-persistence/persistenceStatus.js\":\"81589bd2b00480d6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/storage-persistence/requestAction.js\":\"d08c8c8d4ee0c701\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/supertags/TypeChipsDecorator.js\":\"32c6ad241c32c3a2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/supertags/codeMirrorExtensions.js\":\"61496de9678d4b07\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/supertags/index.js\":\"935a3ad6790269f6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/supertags/typeAutocomplete.js\":\"5847293c17c90de6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"bf81f298335d9e57\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/actions.js\":\"181e641fcdd5f3b9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/anchor.js\":\"ad3f904061c4cd9a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/events.js\":\"2a22a4066136e378\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/gestureActions.js\":\"5a2958cdeff9c3d0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/index.js\":\"6d5ba4b0220dcd17\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"cf4a0ae11489ace8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/sync-metrics/collect.js\":\"52b72cfc2a7641e9\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/sync-metrics/index.js\":\"0ce58af198212ab2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/sync-metrics/record.js\":\"60384849be8bd1ba\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/RejectionDialog.js\":\"349e80a0c7decba6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/SystemStatusHeaderItem.js\":\"77c1e258bbd03f61\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/index.js\":\"002b06e0e14faef0\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/model.js\":\"d0a5c4520ab0b28d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/queueCounts.js\":\"4069b56a477688c8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/rejectedHelpers.js\":\"a81a1718d33c328a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/rematerializeAction.js\":\"9c38c3dae72411cd\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/system-status/useHysteresis.js\":\"e316f389744ba8de\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/ColumnHeaders.js\":\"cec05b87cd27b1b2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/QueryUi.js\":\"58c4ffdd0b9f3f78\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/TableLayout.js\":\"b3c68621f4beb2eb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/actions.js\":\"64006a1bd1ff6663\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/cellEdits.js\":\"eeb2e6c2e872ea49\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/childrenViews.js\":\"66042f989bf027e7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/columns.js\":\"48f69d90a67e1e25\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/controller.js\":\"d060355af1539315\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/convert.js\":\"08d6388a55e63564\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/dataExtension.js\":\"036a8af819bdb2fb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/index.js\":\"2f5936daca8ce5eb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/keys.js\":\"daa17add57379d3b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/model.js\":\"d3d79f265dcfc18f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/QueryText.js\":\"88f3710240790bd7\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/backfill.js\":\"67944c54e2ee2202\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/completion.js\":\"b524601b0e655d05\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/format.js\":\"d2ee538109bf29a1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/parse.js\":\"2a338973868c143f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/queryValue.js\":\"d38111ba1e8de7f8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/registrations.js\":\"91d26506c63dc1be\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/query/source.js\":\"e2f0167d1d4d395c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/registry.js\":\"f6630973407a7cb2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/rowGutter.js\":\"198422a14880bcd1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/rowVerbs.js\":\"0f06bb4dc77f360b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/schema.js\":\"11ff2429db766357\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/tables/sort.js\":\"93e8a6cf653d85c8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/theme-toggle/effect.js\":\"375f25c6e837952b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/theme-toggle/index.js\":\"29c29a0b7faf4a55\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/theme-toggle/theme.js\":\"62a42d575611971a\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/todo/actions.js\":\"f50615f16fc7f67b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/todo/dataExtension.js\":\"d4e222e4d6f43a28\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/todo/index.js\":\"7a47946773a22e7b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/todo/schema.js\":\"a030844656e7965c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4fad6b2e01d52e9d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/touch-selection/actions.js\":\"88c4c90408c20d9f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/touch-selection/defaultItems.js\":\"b35f5dae8428eabb\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/touch-selection/facet.js\":\"ade44926089459e6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/touch-selection/holdRecognizer.js\":\"15cf612d71e5a5ab\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/touch-selection/index.js\":\"0cfd465e3777aea6\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/update-indicator/UpdateIndicator.js\":\"48a2096227c4054f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/update-indicator/index.js\":\"e5efaa31e95728f1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/update-indicator/loadTimes.js\":\"299c6a3297c7ec4f\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/VideoNotesRenderer.js\":\"c078667394510d3d\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/VideoPlayerRenderer.js\":\"af020dff85c46527\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/VideoTimeStamp.js\":\"df08f9891f7acbf8\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/actions.js\":\"50ea2eeb93d3633b\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/index.js\":\"1f29314276f6c9b5\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/markdown.js\":\"2d71c5f12c9904ee\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/notes.js\":\"38087d332a014692\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/registry.js\":\"b871f2888634f368\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/remark-timestamps.js\":\"4c374b81216edaac\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/video-player/view.js\":\"c7a488086a24dca3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-link-hints/LinkHints.js\":\"43389116ac20d0bc\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-link-hints/index.js\":\"e490de50d48105a2\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-link-hints/model.js\":\"0616f26eaf2e5bb3\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-link-hints/settings.js\":\"28e544460b4aaf6c\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-normal-mode/actions.js\":\"85e16f19589ffcef\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-normal-mode/index.js\":\"0254dcf7f621e040\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/vim-normal-mode/interactions.js\":\"77dc79c489d455f1\",\"/knowledge-medium/pr-preview/pr-1889/src/plugins/workspace-header/index.js\":\"7c18a2ddb6b31503\",\"/knowledge-medium/pr-preview/pr-1889/src/registerServiceWorker.js\":\"5253e974aa566e0c\",\"/knowledge-medium/pr-preview/pr-1889/src/requestPersistentStorage.js\":\"b2fd88643c102e79\",\"/knowledge-medium/pr-preview/pr-1889/src/services/authRequestDeadline.js\":\"8e4d3d12e6e835d0\",\"/knowledge-medium/pr-preview/pr-1889/src/services/authStorage.js\":\"3a9724f384145d15\",\"/knowledge-medium/pr-preview/pr-1889/src/services/powersync.js\":\"522d2a7e7540cc97\",\"/knowledge-medium/pr-preview/pr-1889/src/services/supabase.js\":\"565f6b7bd79aa0ec\",\"/knowledge-medium/pr-preview/pr-1889/src/services/uploadErrorClassifier.js\":\"fe7b9f8562a2bc22\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/ActiveContexts.js\":\"cc0c6b3ff5edf7c8\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/HotkeyReconciler.js\":\"27ab3b8d21805839\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/WipeLocalDataDialog.js\":\"fa353f39d76c5063\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/actionDispatch.js\":\"ee4d6dec5c38f027\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/actionRefItems.js\":\"2abc4ba70a5795dd\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/applyKeybindingOverrides.js\":\"6dc64e30d014497b\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/blockActions.js\":\"c32856fb6513a85b\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/blockMergeGesture.js\":\"44cbdff83476d61e\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/canonicalizeChord.js\":\"ef16cb426b178611\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/defaultContexts.js\":\"1fba8ccc94f37274\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/defaultShortcuts.js\":\"2815c05c9e8501a4\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/effectiveActions.js\":\"acdb6f312f4d98bd\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/gestureAction.js\":\"acfa747747b43a59\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/gestureBinding.js\":\"d984d75a0e8a5f05\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/holdRegistry.js\":\"71020738a25fc004\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/keybindingConflicts.js\":\"65dc79abd5c8a0ab\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/keybindingOverrides.js\":\"532e9782156c4108\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/pointerAction.js\":\"fdc225d7af4f9c23\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/resolve.js\":\"a1f52916423dfbd9\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/runAction.js\":\"9dc87f456ae14a0e\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/sequenceMatcher.js\":\"44b66e9d5e08f320\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/types.js\":\"bfb8671271ded355\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/useActionContext.js\":\"828f946b57e1229b\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/useActionDiscovery.js\":\"e66fbf90999db721\",\"/knowledge-medium/pr-preview/pr-1889/src/shortcuts/utils.js\":\"24cc5761e6eb6275\",\"/knowledge-medium/pr-preview/pr-1889/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1889/src/sw/bootStore.js\":\"4864b8003dfe2702\",\"/knowledge-medium/pr-preview/pr-1889/src/sw/previewDatabases.js\":\"774811a2a6fd0456\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/byteTransform.js\":\"6aeb05a60ae9b8fe\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/attachmentCleaner.js\":\"c1ed3c32fb54faae\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/bundle/attachmentParts.js\":\"bf50b1deba12e0d8\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/bundle/bundleParts.js\":\"6448d4505705f831\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/bundle/bundleRecord.js\":\"8562c63ab257613b\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/bundle/manifest.js\":\"c8497937b0af7d72\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/bundle/takeBundle.js\":\"34391e6ba8262604\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/bundle/verifyBundle.js\":\"57d1bcbc777875f4\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/cleaningStage.js\":\"70ba507dad248dfb\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/conversionKey.js\":\"c6951d8d8c374d71\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/conversionServer.js\":\"46b157bc6a4f911e\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/flip.js\":\"b506f772dfb378bb\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/flipAttempts.js\":\"82aa1e625f6051a0\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/pages.js\":\"685fd7f56c5dc64a\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/preflight.js\":\"4128f1580d7fd463\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/reseal.js\":\"8136571ac5a40f55\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/runConversion.js\":\"584beadec9036661\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/runLock.js\":\"ef981836220ac819\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/sealing.js\":\"779c7bdc6548b2ae\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/sealingStage.js\":\"6c5ac0297f880fa0\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/stage.js\":\"43866449944a7537\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/conversion/verifyReseal.js\":\"03cba9725d5fa2a4\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/aad.js\":\"c9c9b8fc056f52e1\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/aead.js\":\"b44ab976633af54a\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/base32.js\":\"71c2810c96c9f069\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/base64url.js\":\"dce7194cca06abfc\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/binaryEnvelope.js\":\"5a6a009ac85614c7\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/byteAead.js\":\"c2790dcaeb197f4c\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/canary.js\":\"6b3a01e347c5ac7f\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/contentHash.js\":\"db1ea0c1666c8306\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/contentKey.js\":\"d1a0e0fbea4962d6\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/derivedIdNamespace.js\":\"a9c84bca008a667d\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/envelope.js\":\"298b0631cb2dd7a4\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/hex.js\":\"0e04c2bc3670acc9\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/sha256Hex.js\":\"1df706b606a3ae18\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/crypto/workspaceKey.js\":\"1a5a40c1d1b272ee\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/conversionState.js\":\"b795d3a79ccbf134\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/flows/createEncryptedWorkspace.js\":\"bf7ebe415b2a8c68\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/flows/pastedKey.js\":\"1281fb914cff2b49\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b5f38e5cb55af5d0\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/flows/upgradeWorkspacePin.js\":\"be563eb063219f16\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/keyStore.js\":\"59d12bfbf04d92db\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/mintWorkspaceKey.js\":\"c52fb98d9a17c0a2\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/modePin.js\":\"97aece7420632f3c\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/openWorkspaceKeys.js\":\"40f97cd7e07e67dd\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/resolveWorkspaceEntry.js\":\"f91bdbd2f74420a0\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/resolver.js\":\"373ba7ac88cfc89b\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/keys/workspaceAccess.js\":\"f9eb528366da8fd4\",\"/knowledge-medium/pr-preview/pr-1889/src/sync/transform.js\":\"b1544af28ba1da4a\",\"/knowledge-medium/pr-preview/pr-1889/src/themeBootDefaults.js\":\"294c72f9ca790ed0\",\"/knowledge-medium/pr-preview/pr-1889/src/types.js\":\"21861326953e917f\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/ClientLocalSettings.js\":\"97a01ad8e6f0727f\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/abortableSleep.js\":\"176006bdbc70b9b2\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/array.js\":\"68e58417fbd35409\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/backlinkAutocomplete.js\":\"9c76cd5cb49a93c4\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/blockCrumbs.js\":\"45e44192196ce4f6\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/blockrefAutocomplete.js\":\"0898b54433bb7723\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/cadencedIdleJob.js\":\"98a75c2d812c7285\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/callbackSet.js\":\"e2ebbf37ebd71317\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/clientId.js\":\"2bbc3fb9bb4819da\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/codemirror.js\":\"6cdde7f7a3b23bf6\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/codemirrorCompletion.js\":\"6820e2641ceabe19\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/copy.js\":\"a591aebd2121b795\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/dailyPage.js\":\"933e38aaef56dc0f\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/dbForensics.js\":\"eef49dac8b35762b\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/dbForensicsHooks.js\":\"f0421c99b720581b\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/deleteBlockThroughUi.js\":\"4bb7c4874260e1d7\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/dialogs.js\":\"14ca1ea3fba49d64\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/dom.js\":\"82ec3af689c600c4\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/downloadBlob.js\":\"bc2b7183a20198de\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/drawnWalk.js\":\"b14273cc0209f64a\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/exportSqliteDb.js\":\"fdcc19222439f6da\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/fileSystemAccess.js\":\"d216ed4ec9f01cfa\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/flipSlide.js\":\"6823842002416fe5\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/fnv1a.js\":\"c1e23d1b50cff72c\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/formatBytes.js\":\"76b706554d7bd509\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/fuzzyRank.js\":\"3c6bac9a6190fec2\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/idbKeyedStore.js\":\"30d7eea6c8f09786\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/idleCallbackPolyfill.js\":\"d4597c7b62b02c6a\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/keyboardAwareScroll.js\":\"8f5e4f862a6baf36\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/keyboardViewport.js\":\"1915193e5e22833d\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/lastWorkspace.js\":\"034a3d00e49c627e\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/layoutColumns.js\":\"64515f374d12f4da\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/layoutSessionDom.js\":\"af52773c6c9775b0\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/layoutSessionId.js\":\"cd6c11abaea55fcc\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/linkClickGestures.js\":\"1f449060a31b27f0\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/linkTargetAutocomplete.js\":\"0fbaf3475f4fad7a\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/localDbCorruption.js\":\"8a0548ff71e6043d\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/localDbRecovery.js\":\"5cbdab93e65d73ed\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/markdownParser.js\":\"c778d55ab96fb7a9\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/memoize.js\":\"eb96ad2a2205b7f2\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/nameFieldCommit.js\":\"b1bfa459b49b8f31\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/nameList.js\":\"7fb4088585a99be6\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/navigation.js\":\"2eb0ab8e0f4ffe6b\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/omnilinerNamespace.js\":\"17251424d9e35ea5\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/opfsPageScan.js\":\"49fa3802adb4ce3c\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/panelClearance.js\":\"85efa8f8cbcf710c\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/panelHistory.js\":\"3a31ea290fa1b08a\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/panelLanes.js\":\"5274678e5b7c6804\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/panelLayoutProjection.js\":\"6a9b5e05b0f210ad\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/panelScrollAnchor.js\":\"c6154e3ec879fe07\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/panelUrlFlags.js\":\"4af043e95a63bb4b\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/platform.js\":\"8fd797a03b7bf986\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/pluralize.js\":\"b142034544c18b81\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/propertyCreation.js\":\"7448c43ad7bdb24c\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/propertyNavigation.js\":\"a44419a21543f794\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/propertyValueContext.js\":\"af952198b672edb6\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/react.js\":\"eb53d41303985b5e\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/relativeDate.js\":\"52d70591ce2dd426\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/relativeTime.js\":\"2c554701fc89dd88\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/renderScope.js\":\"47c23c73617b243e\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/resolvedThenable.js\":\"1b806c625c1e1865\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/routing.js\":\"07a6b2784a84b2cf\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/safeMode.js\":\"2a4e56669f98df69\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/scheduleIdle.js\":\"b22550a5c9eea099\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/screenWakeLock.js\":\"44592952c8043242\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/selection.js\":\"957c9883f765382f\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/softKeyboardGrab.js\":\"ef4f376a37f1a64f\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/startupTimeline.js\":\"dbd31efa65c8252c\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/state.js\":\"8e45d406c0928142\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/string.js\":\"0911058c70439e3f\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/surfaceZoom.js\":\"7b1ef2b338bfe408\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/time.js\":\"73ee4c3f55a1d48d\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/toast.js\":\"84f42076a6725561\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/toggleStore.js\":\"663715f792083448\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/untilStopped.js\":\"a1693ac94dceca21\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/userActivity.js\":\"5c9e179b62f25537\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/viewTransition.js\":\"ac4c43be1310c7ac\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/viewport.js\":\"4d60880812c28d77\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/webLock.js\":\"3016d0aeca7d2f58\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/workspaceRecovery.js\":\"1825e2473653f6dd\",\"/knowledge-medium/pr-preview/pr-1889/src/utils/workspaceSnapshotStore.js\":\"11c2081fa7c122a3\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-compiler-runtime.js\":\"c9d5fafa49d3ceb4\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom-client.js\":\"e0197e04a6882ae8\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom-server-edge.js\":\"6fa1d6fb6fd0f874\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom-server.js\":\"01b5dad1947c5554\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom-static-edge.js\":\"e2952dd636dd475b\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom-static.js\":\"9bcac453dd64e4e0\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom-test-utils.js\":\"1357b6435db72fa6\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-dom.js\":\"242802875b393141\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react-jsx-runtime.js\":\"8a612c8c441115dc\",\"/knowledge-medium/pr-preview/pr-1889/src/vendor/react.js\":\"d657198629d6d5cd\",\"/knowledge-medium/pr-preview/pr-1889/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1889/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1889/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
