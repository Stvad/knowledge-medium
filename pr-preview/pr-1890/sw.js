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
		buildId: "098614f0d3af-5a9b080c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1890/\":\"98e69d00de8cdab1\",\"/knowledge-medium/pr-preview/pr-1890/index.html\":\"98e69d00de8cdab1\",\"/knowledge-medium/pr-preview/pr-1890/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1890/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1890/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1890/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1890/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1890/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1890/app.css\":\"6211a4bfca173ff0\",\"/knowledge-medium/pr-preview/pr-1890/assets/FacadeVFS-CWWVJXBa.js\":\"8d22608ce174875b\",\"/knowledge-medium/pr-preview/pr-1890/assets/OPFSCoopSyncVFS-B1JuhnS4.js\":\"34df7982aad43199\",\"/knowledge-medium/pr-preview/pr-1890/assets/OPFSWriteAheadVFS-BGeanTw8.js\":\"73091d69ef5d86e2\",\"/knowledge-medium/pr-preview/pr-1890/assets/wa-sqlite-CFlJlckp.js\":\"78b22fb4bf7526e0\",\"/knowledge-medium/pr-preview/pr-1890/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1890/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1890/assets/wa-sqlite-async-D-vR5WaQ.js\":\"4185d891b688cddc\",\"/knowledge-medium/pr-preview/pr-1890/assets/worker-DFKYeJQS.js\":\"8dbd9e10bc17fe7b\",\"/knowledge-medium/pr-preview/pr-1890/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1890/chunks/app-e8dR1_7W.js\":\"94888aa3cb5a322f\",\"/knowledge-medium/pr-preview/pr-1890/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1890/index.js\":\"41077a6d621a77ce\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1890/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1890/assets/AccessHandlePoolVFS-BlHOFuZs.js\":\"764d7097609bb87e\",\"/knowledge-medium/pr-preview/pr-1890/assets/IDBBatchAtomicVFS-BPGb0TGh.js\":\"384835a5cee09069\",\"/knowledge-medium/pr-preview/pr-1890/assets/MemoryVFS-st-3oyFN.js\":\"76f7ad554bb15018\",\"/knowledge-medium/pr-preview/pr-1890/assets/mc-wa-sqlite-C-QrkzwZ.js\":\"3a3b38f23f71ecb5\",\"/knowledge-medium/pr-preview/pr-1890/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1890/assets/mc-wa-sqlite-async-DRWw4dli.js\":\"07a7833b35fbe5c3\",\"/knowledge-medium/pr-preview/pr-1890/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1890/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1890/chunks/AccessHandlePoolVFS-C-2Z7-11.js\":\"aa98fa26faad232d\",\"/knowledge-medium/pr-preview/pr-1890/chunks/FacadeVFS-DBV1bXUB.js\":\"265ea237d9c918ef\",\"/knowledge-medium/pr-preview/pr-1890/chunks/IDBBatchAtomicVFS-BxN_Z5Hm.js\":\"f85c6883557d83f8\",\"/knowledge-medium/pr-preview/pr-1890/chunks/MemoryVFS-o98xIp1G.js\":\"80245a99f12b8ff8\",\"/knowledge-medium/pr-preview/pr-1890/chunks/OPFSCoopSyncVFS-DkKMOrHB.js\":\"3ab8766531943312\",\"/knowledge-medium/pr-preview/pr-1890/chunks/OPFSWriteAheadVFS-Ba06Kh9H.js\":\"596bfb9ccf5890ae\",\"/knowledge-medium/pr-preview/pr-1890/chunks/Preview-gOH06z2r.js\":\"995debc07c6a8c4c\",\"/knowledge-medium/pr-preview/pr-1890/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1890/chunks/card-CmvkE2LM.js\":\"233d4d89f7f4842f\",\"/knowledge-medium/pr-preview/pr-1890/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1890/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1890/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1890/chunks/dist-CQJzDkmw.js\":\"2f5bbc112c86e5c6\",\"/knowledge-medium/pr-preview/pr-1890/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1890/chunks/mc-wa-sqlite-CViA4Rwh.js\":\"d16622f999d64e42\",\"/knowledge-medium/pr-preview/pr-1890/chunks/mc-wa-sqlite-async-DyTCBSIC.js\":\"6767b9b6921fce23\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-BFdqp7Pg.js\":\"9e721b6500e6e99d\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-BGO6y81G.js\":\"12bb45ecca51f10b\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-BRZguaZL.js\":\"20c927c137321310\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-BtG725pI.js\":\"9e8b264d7e5bb970\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-COdKURyF.js\":\"798105dfb9268194\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-CYC4rG-U.js\":\"3685efdb87e5d734\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-CjXgb7mI.js\":\"3d5fd4dd7bd0036a\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-DEP56hsA.js\":\"a9e29deb570008ec\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-dom-server-legacy.browser.production-BekS90vF.js\":\"cafe36367e0495cf\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-dom-server.browser.production-Bs_1dyX8.js\":\"74b498de83b0d7ce\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-dom-server.edge.production-BdClF0NG.js\":\"96fdab92134689a8\",\"/knowledge-medium/pr-preview/pr-1890/chunks/server.browser-h5O0LeFh.js\":\"e75ac188523c1783\",\"/knowledge-medium/pr-preview/pr-1890/chunks/textarea-B1neV60_.js\":\"1274fc8e27e97bc9\",\"/knowledge-medium/pr-preview/pr-1890/chunks/ui-EGCjbM7f.js\":\"c3f86707e2851142\",\"/knowledge-medium/pr-preview/pr-1890/chunks/wa-sqlite-CgMEm8nV.js\":\"88c99187c826c1e4\",\"/knowledge-medium/pr-preview/pr-1890/chunks/wa-sqlite-async-C0DbaxPK.js\":\"c81d14c064849915\",\"/knowledge-medium/pr-preview/pr-1890/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1890/extension-utilities.css\":\"ebbf920af5d994cb\",\"/knowledge-medium/pr-preview/pr-1890/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1890/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1890/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1890/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1890/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1890/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1890/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1890/src/App.js\":\"54f7edc980fee668\",\"/knowledge-medium/pr-preview/pr-1890/src/appUpdate.js\":\"4d0093234142ad15\",\"/knowledge-medium/pr-preview/pr-1890/src/appVersion.js\":\"431d782b8e4a56f5\",\"/knowledge-medium/pr-preview/pr-1890/src/bootstrap/initialLayout.js\":\"19b120b4a72ed26c\",\"/knowledge-medium/pr-preview/pr-1890/src/bootstrap/openWorkspaceData.js\":\"7fc94a5b302af830\",\"/knowledge-medium/pr-preview/pr-1890/src/bootstrap/resolveWorkspace.js\":\"9d8189f3e575f4b3\",\"/knowledge-medium/pr-preview/pr-1890/src/bootstrap/workspaceBootstrap.js\":\"e9f9d0f06846ab3d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockComponent.js\":\"397910af96fd906b\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockCrumbs.js\":\"317f247a7435cca2\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockEditor.js\":\"9962037b7494776d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockLoadingPlaceholder.js\":\"689125d27067dc98\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockProperties.js\":\"a1c20e4790c12533\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockSearchPicker.js\":\"2ec386589f73bb25\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ConfirmBulkDeleteDialog.js\":\"f6c3151779133fcf\",\"/knowledge-medium/pr-preview/pr-1890/src/components/DividerHandle.js\":\"0b6129321747e7ad\",\"/knowledge-medium/pr-preview/pr-1890/src/components/DraftEditor.js\":\"cb4182ebba4d348d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/GutterPill.js\":\"0f0ccbe5d0294e4a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/Header.js\":\"68f75dcdf29144ad\",\"/knowledge-medium/pr-preview/pr-1890/src/components/LazyBlockComponent.js\":\"e31239cf313c04e4\",\"/knowledge-medium/pr-preview/pr-1890/src/components/Login.js\":\"1bca1146eba57453\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ZoomableSurface.js\":\"24cfb592827055c6\",\"/knowledge-medium/pr-preview/pr-1890/src/components/editModeKeepalive.js\":\"2ba2897c5c95dcaa\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyDisplay/PropertyDisplayScope.js\":\"7a9271f31771efec\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"11fe264d753770ab\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/RefPropertyEditor.js\":\"3c04aaa66a0de68a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/RefTargetTypePicker.js\":\"c36c88328dc3264f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/SelectPropertyEditor.js\":\"4da1daba74d63cb8\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/TypesPropertyEditor.js\":\"68f037700f88d4f9\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/defaults.js\":\"43568ae8f7cded8a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/kernelValuePresets.js\":\"d6b23726eb57adf9\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/selectablePresets.js\":\"cf500b61afbb996c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/typesPropertyUi.js\":\"4873f0683cd5d6c7\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/AddPropertyForm.js\":\"6b2f557863b41528\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/PropertyPicker.js\":\"39633d9cc7614d31\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/PropertyRow.js\":\"edfed169f92d99f2\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/Rows.js\":\"5697786c1844d6a5\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/actions.js\":\"8d71f9c75966d06f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/declarationOnly.js\":\"83bcbe01737b7b6d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/layout.js\":\"0efb8abfc44188ea\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/model.js\":\"7bc9b7df36841506\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/shapeUi.js\":\"3dead429c6abeb4a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/shapes.js\":\"576271f8c030a0aa\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/usePropertyEditingActivation.js\":\"69d2d3cbe628d2da\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/visibility.js\":\"e7b4693a6d426b3c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanelSections.js\":\"aeb780dd24617801\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/BlockEmbed.js\":\"9f29891b5197ec50\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/BlockLink.js\":\"209fd3bfc8415887\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/BlockRef.js\":\"b23b974f1c32ff7a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/CompactReferenceLink.js\":\"9c07a3d7921eef93\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/ReferenceLink.js\":\"b67d5457063b8f97\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/cycleGuard.js\":\"ce371968830e23bb\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/cycleGuardContext.js\":\"11aa8470d53e4544\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/linkInteraction.js\":\"3e20840e92459879\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/referenceLayout.js\":\"53f548afec8afe34\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/useBlockRefAncestors.js\":\"8176f43d15590333\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BlockGutter.js\":\"b194f7ca06eada22\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BlockInfoDialog.js\":\"c46b3f377983e533\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BlockReadText.js\":\"e65b84e3425931a9\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BlockTypeBlockRenderer.js\":\"130bf1dd9f110658\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BulletHoverCard.js\":\"32769986c5fbb42a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/CodeMirrorContentRenderer.js\":\"7eb881d9c8a55826\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2c10d929c4d79691\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/ColumnResizeHandles.js\":\"b73fdb862067e451\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a42ea42dc970b816\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/DefaultBlockRenderer.js\":\"902ef78486286a0c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/LayoutRenderer.js\":\"de8db827679e1bb9\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/MarkdownContentRenderer.js\":\"ec14b8911ef6a228\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/MissingDataRenderer.js\":\"c7727f355a4e851a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/PanelRenderer.js\":\"793981f0e6e8b960\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/PropertySchemaBlockRenderer.js\":\"cb1b2aeb354b3052\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/TopLevelRenderer.js\":\"e989b6f4b175393f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/blockGutterMode.js\":\"922990953405d95d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/blockTitleText.js\":\"35a1b949a4fc5630\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/fieldCreationKeydown.js\":\"15711ca75557a473\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/layoutRootContext.js\":\"d79cf3c5c9500664\",\"/knowledge-medium/pr-preview/pr-1890/src/components/typeChip/TypeChip.js\":\"61a516c7f005adf7\",\"/knowledge-medium/pr-preview/pr-1890/src/components/typeChip/chipStyle.js\":\"2a9cf79514747aa4\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/anchored-floating.js\":\"3141a8189fac55c3\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/button.js\":\"61d0daf536cbf49f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/card.js\":\"3529c6f588b47b08\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/checkbox.js\":\"a620887b12a21ff6\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/collapsible.js\":\"bc75d369e8e04f05\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/command.js\":\"5ee1520bd601949f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/context-menu.js\":\"e4f72a777a03743c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/dialog.js\":\"575208930f64ad5a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/dropdown-menu.js\":\"9e403f6e545dc7cb\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/floating-listbox.js\":\"d307b6efc65f5678\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/index.js\":\"e3c38c0f430dfdff\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/input.js\":\"7248485770dada80\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/kbd.js\":\"a5558540a95c9039\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/label.js\":\"6ae49486a3119d81\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/textarea.js\":\"166f67d302d170ae\",\"/knowledge-medium/pr-preview/pr-1890/src/components/useEditModeYieldKeepalive.js\":\"57381c17a6163ec3\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/BootFallback.js\":\"6b01f563af3863bf\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/FocusedRowLazyMount.js\":\"ea530bb4ec0fa3e6\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/LazyViewportMount.js\":\"d605139bdab97030\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/LocalDbCorruptionFallback.js\":\"03a689fe4cf9f387\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/error.js\":\"602bb81d0f2c91c1\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/lazyMountRegistry.js\":\"18b0e5dd0ad48c36\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/suspense.js\":\"ca068d0b1b1ece37\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/CreateWorkspaceDialog.js\":\"477ea5c0f0b1e4b4\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/PendingInvitations.js\":\"37c341801a8bdb47\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/SyncProgress.js\":\"f6780079211fcf61\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/UnlockProgress.js\":\"4f9e362722459239\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/WorkspaceKeyGate.js\":\"e9298d71f6e33a1e\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/WorkspaceSettingsDialog.js\":\"7a3c0124ae31aacf\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/WorkspaceSwitcher.js\":\"0202e4cdcf5914ea\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/WorkspaceSyncGate.js\":\"313cb202ab4ca124\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/ConversionFlow.js\":\"ba17837e05bf1ade\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/ConversionFlowHost.js\":\"f022157beb8d977f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/EncryptionSection.js\":\"ae1d53ad6c1fcd74\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/attachmentPrompts.js\":\"0e510ad83219d6ed\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/bundleFolderPrompts.js\":\"8b84e998bafdfdeb\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/conversionFlowDeps.js\":\"d733369f7150898c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/conversionFlowStore.js\":\"60cd447aae09a083\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/flowUi.js\":\"c1b45f6ce5bb608f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/useConversionRun.js\":\"24994c1e4300a3e7\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/keyUi.js\":\"29cf4cb152f7399a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/useCloseOnKeyLoss.js\":\"6b91524609b43b50\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/useCloseOnServerE2ee.js\":\"7cd17442513a985b\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/workspaceUnlocked.js\":\"0adfdb32bef98a35\",\"/knowledge-medium/pr-preview/pr-1890/src/context/backgroundSubtree.js\":\"983195eb7716001a\",\"/knowledge-medium/pr-preview/pr-1890/src/context/block.js\":\"7888381ce32e7697\",\"/knowledge-medium/pr-preview/pr-1890/src/context/layoutWsContext.js\":\"84d8a9f44fec435c\",\"/knowledge-medium/pr-preview/pr-1890/src/context/propertyDisplay.js\":\"40aa9f4a00eb6c0c\",\"/knowledge-medium/pr-preview/pr-1890/src/context/repo.js\":\"9a2321cba9a83ce2\",\"/knowledge-medium/pr-preview/pr-1890/src/data/aliasClaim.js\":\"8a36916d90b87c5a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/aliasSeatNamespace.js\":\"cac66c18b65fcb89\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/blockData.js\":\"f837aa7e8f779328\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/blockType.js\":\"23dbf4768a92c681\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/changeScope.js\":\"bbe4fe5dcbf1957e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/codecs.js\":\"01e2a4c0b3dd99ce\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/derivedData.js\":\"98b6ba4accda253d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/errors.js\":\"6e6ed4d27896b8a3\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/events.js\":\"833a6de5a5009d44\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/handle.js\":\"be9846086ceb4b6e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/index.js\":\"844ee490086e423d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/mutator.js\":\"c3a8b6f3862b4f1f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/processor.js\":\"f1e0150137cad32a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/propertySchema.js\":\"3a6ec363a0a16e2d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/query.js\":\"34bfa66d4db67024\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/sameTxProcessor.js\":\"03383e5e350af2ca\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/schema.js\":\"be9846086ceb4b6e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/tx.js\":\"be9846086ceb4b6e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/typedBlockQuery.js\":\"e89ea6d75e741df8\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/user.js\":\"31c5b7de75adb0db\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/valuePresetCore.js\":\"744c8bf3fbe40aba\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/valuePresets.js\":\"ed26ff177baac3d2\",\"/knowledge-medium/pr-preview/pr-1890/src/data/attachmentCleanerIOVerb.js\":\"4941f68fdcd04b5a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/block.js\":\"ac3d447df89b404d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockCache.js\":\"a3046ec5c6605ed5\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockId.js\":\"858cf51ab790f298\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockLiveness.js\":\"f1d0951d84714432\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockMerge.js\":\"57d7401385cbde75\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockSchema.js\":\"a696dac1eadfb2d2\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockTypeLookup.js\":\"73d81889d4260328\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockTypes.js\":\"faa6d185888c64ca\",\"/knowledge-medium/pr-preview/pr-1890/src/data/childrenView.js\":\"d74de16f55e0fa6e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/clientContext.js\":\"49690ee5b4999436\",\"/knowledge-medium/pr-preview/pr-1890/src/data/dbFileSiblings.js\":\"0e0cac574f42611c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/definitionSeeds.js\":\"5f3ddc2e6826d8fe\",\"/knowledge-medium/pr-preview/pr-1890/src/data/derivedIds.js\":\"ffd0f72cc9b1bd31\",\"/knowledge-medium/pr-preview/pr-1890/src/data/drawnSubtree.js\":\"9efdc65addfd922c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/facetBridge.js\":\"d9848ae53a865b80\",\"/knowledge-medium/pr-preview/pr-1890/src/data/facets.js\":\"981e61ac436a2334\",\"/knowledge-medium/pr-preview/pr-1890/src/data/globalState.js\":\"825f849cf18b8d98\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/aliasClaimRederiveProcessor.js\":\"3b138e0e151fd509\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/ancestorBatch.js\":\"db7a18513fc9f05a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/blockTypeTypeifyProcessor.js\":\"86c736d155e0e4c2\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/clientSchema.js\":\"47dcc895bef12512\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/commitPipeline.js\":\"5af9103b0ec35f11\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/devAssertions.js\":\"e2b11ca43b7f6005\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/firstSync.js\":\"68341bdc3cfd9777\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/freshInitialLoad.js\":\"c369062c30b66537\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/graphBackfillClaim.js\":\"0995d8593040f3d7\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/handleStore.js\":\"a6eb837a6754b060\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/idleMarkerJobs.js\":\"ab2250b12ce9007b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/initialDownload.js\":\"97774c5f50cd5af1\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/initializeClientDatabase.js\":\"af0b269c4be9b451\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/jsonCanonical.js\":\"44d2083df9e86ceb\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/kernelInvalidation.js\":\"838ec19481c0ac53\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/kernelProcessors.js\":\"fcd518a690a4f6db\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/kernelQueries.js\":\"8f5ae5a4d9369c70\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/mergeTypeMembershipProcessor.js\":\"fe2c4318227c8902\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/normalizeReferencesProcessor.js\":\"36270738150ef79d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/poolInstrumentation.js\":\"fed4e8d92a11c7eb\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/processorRunner.js\":\"8a32f84c461a4b8e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyCellBackfill.js\":\"be85e836beb9ad86\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyChildMint.js\":\"7ada2186c1da8ffd\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyChildrenProcessor.js\":\"db26c11d0a9b0d4c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyDefinitionChangeProcessor.js\":\"72434ffca41d6fd5\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyDefinitionSynthesis.js\":\"88b1ee637357063c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyKeyScan.js\":\"ffa2c7ea0bbf05a7\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertySchemaResolution.js\":\"ae9698e2904546ab\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyValueEdits.js\":\"a7b202e2d0b7132d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/raiseProtocol.js\":\"8f43b7a0586a54ca\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/readBatch.js\":\"2fd7c429fd1f6c6f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/refProjection.js\":\"b73ea12b87a9a8db\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/referenceTargetLookups.js\":\"c233b4ea251e24cc\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/referenceTargetProcessor.js\":\"973b12d43bfce68e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/replayMerge.js\":\"573c27783a47d18c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/sqlBinds.js\":\"5d6eefb0281da5ee\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"416d19fc8bd6fe3e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/arrivalProcessors.js\":\"9955d14cdd5f4a26\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/invalidate.js\":\"7b8b3dbb5b299767\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/materialize.js\":\"143bc4fc6ca1a533\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/observer.js\":\"f94f312c58f48476\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/reconcile.js\":\"65104b65f5d37792\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/timingMetrics.js\":\"0071b4adac43b8ab\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/treeQueries.js\":\"60430e294b9eaaf2\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/txEngine.js\":\"074b6ffe89d54e05\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/txSnapshots.js\":\"7b624bb1d6b3fbe9\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/typedBlockQuery.js\":\"21ae9c08bf3e9048\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/undoManager.js\":\"0e2ee2522796dddc\",\"/knowledge-medium/pr-preview/pr-1890/src/data/invalidation.js\":\"e2e7ac77e04bd2ca\",\"/knowledge-medium/pr-preview/pr-1890/src/data/kernelDataExtension.js\":\"45d29d8bb8e71aa8\",\"/knowledge-medium/pr-preview/pr-1890/src/data/kernelPage.js\":\"676685bad97ba9a5\",\"/knowledge-medium/pr-preview/pr-1890/src/data/kernelValuePresetCores.js\":\"28683e308b55c200\",\"/knowledge-medium/pr-preview/pr-1890/src/data/localDbCorruptionSignal.js\":\"bfb7642c045ae50f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/localDbStorage.js\":\"f6fe26b130259fe9\",\"/knowledge-medium/pr-preview/pr-1890/src/data/localDbVfs.js\":\"0847a6ffc37f7cde\",\"/knowledge-medium/pr-preview/pr-1890/src/data/localSchema.js\":\"6a40532f78705b03\",\"/knowledge-medium/pr-preview/pr-1890/src/data/maintenance.js\":\"61cfb13c7324e1a4\",\"/knowledge-medium/pr-preview/pr-1890/src/data/mergeProperties.js\":\"471ff564fb0ec9b0\",\"/knowledge-medium/pr-preview/pr-1890/src/data/metricsConsoleHook.js\":\"c83700eef6e5ba9a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/migrationsPage.js\":\"e53dd53f660e1070\",\"/knowledge-medium/pr-preview/pr-1890/src/data/mutators.js\":\"a34f9d369956a293\",\"/knowledge-medium/pr-preview/pr-1890/src/data/orderKey.js\":\"e06505922dfbe25d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/orderKeyPlacement.js\":\"1f0d20997ff7d4e1\",\"/knowledge-medium/pr-preview/pr-1890/src/data/outlineSurface.js\":\"dd6a7fcd52a4b7e9\",\"/knowledge-medium/pr-preview/pr-1890/src/data/pendingEditorContent.js\":\"b0b01b260a0c6cd7\",\"/knowledge-medium/pr-preview/pr-1890/src/data/pendingUploadsSql.js\":\"f89ad5b4f926e49d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/pluginStateExtensions.js\":\"e44d55bc17146a10\",\"/knowledge-medium/pr-preview/pr-1890/src/data/powerSyncLogger.js\":\"4825ed9c3c40d76a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/projectorRuntime.js\":\"7bcfb1e16310ccae\",\"/knowledge-medium/pr-preview/pr-1890/src/data/properties.js\":\"23b941da26589ea7\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertiesPage.js\":\"a4683f58f777c1b6\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyChildren.js\":\"1997c457fa0f0b75\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyDefinitionFanout.js\":\"07732bc88e0ecfce\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyDefinitionMetadata.js\":\"67047517f4982ca9\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyDefinitionRegistry.js\":\"e1100727881f426b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyDisplayMode.js\":\"644c71f71b963f49\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyRowCreation.js\":\"fac9d0ed6ed7b234\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertySchemaCreation.js\":\"a5f76103242ebd60\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertySeeds.js\":\"0e8fd08516c90361\",\"/knowledge-medium/pr-preview/pr-1890/src/data/recentsPage.js\":\"188d96bf92973c8d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/refTargetComparableProperty.js\":\"356d9c799e21f369\",\"/knowledge-medium/pr-preview/pr-1890/src/data/referenceBlock.js\":\"5c4824c911cdf169\",\"/knowledge-medium/pr-preview/pr-1890/src/data/rejectedUploads.js\":\"6fb1b3b87339d601\",\"/knowledge-medium/pr-preview/pr-1890/src/data/releasePowerSyncConnection.js\":\"7c58133a82cec992\",\"/knowledge-medium/pr-preview/pr-1890/src/data/repo.js\":\"cfd3c2765ef2bb45\",\"/knowledge-medium/pr-preview/pr-1890/src/data/repoProvider.js\":\"fc90eb856842dd4a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/rowProperty.js\":\"703de6e43157ccf3\",\"/knowledge-medium/pr-preview/pr-1890/src/data/searchFilter.js\":\"9695b78fbb7ddb6c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/seedIdentityLedger.js\":\"36bed994decd2bd8\",\"/knowledge-medium/pr-preview/pr-1890/src/data/stateBlocks.js\":\"b612ae9329695519\",\"/knowledge-medium/pr-preview/pr-1890/src/data/structuralEditPolicy.js\":\"6d6a8d5d4a6fcf89\",\"/knowledge-medium/pr-preview/pr-1890/src/data/structuralInsert.js\":\"7a6c6c742698fe2a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/subtreeDelete.js\":\"052175c3cb776bae\",\"/knowledge-medium/pr-preview/pr-1890/src/data/syncStreamLock.js\":\"c60fcf740dd18fda\",\"/knowledge-medium/pr-preview/pr-1890/src/data/syncedTableSqlRecognizer.js\":\"2f269c093e0af396\",\"/knowledge-medium/pr-preview/pr-1890/src/data/syncedTableWriteGuard.js\":\"7a2182bf03cbd471\",\"/knowledge-medium/pr-preview/pr-1890/src/data/targets.js\":\"9e7e426070a8de91\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeColors.js\":\"103c3d92b31cf4e9\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeDefinitionMetadata.js\":\"90894957aeb7ba88\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeDefinitionRegistry.js\":\"6acc23bbb9a79697\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeExtraction.js\":\"d73a307953f0877e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeInitialValues.js\":\"31e6000307bb4b1b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typePropertyGroups.js\":\"615d8080160b5a58\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeSeeds.js\":\"14a8e89a4ec3fceb\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeTagger.js\":\"d2cdbc023a47a04c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typedRecords.js\":\"46e0c10dfa47f1d7\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typesPage.js\":\"c6ca931f535fc16b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/userPrefs.js\":\"47f36d5ac7bc74f6\",\"/knowledge-medium/pr-preview/pr-1890/src/data/userSchemasService.js\":\"c40613775e2c9da3\",\"/knowledge-medium/pr-preview/pr-1890/src/data/userTypesService.js\":\"ff96da7a10da2a4e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/valuePresetRegistry.js\":\"5c0e825edff8a0f8\",\"/knowledge-medium/pr-preview/pr-1890/src/data/visibleChildren.js\":\"0215efd36d016e4e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaceConversion.js\":\"ea475a9d26f0a4d5\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaceFirstSync.js\":\"f0fd3ec0b07091de\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaceIdNamespace.js\":\"4ff25e60d1bd009a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaceSchema.js\":\"92238818423cc558\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaces.js\":\"e104980436a15050\",\"/knowledge-medium/pr-preview/pr-1890/src/data/writeAheadLog.js\":\"50e0c99b5887c422\",\"/knowledge-medium/pr-preview/pr-1890/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/BlockPasteShellDecorator.js\":\"375989df2457f83d\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/atTrigger.js\":\"3cfe63c036e29de9\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/autocomplete.js\":\"fef0fa2da382b09b\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/codeMirrorExtensions.js\":\"34ad0fbea7401593\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/contentFlush.js\":\"c46df7931f244164\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/defaultInteractions.js\":\"a36aeab1ed518bbc\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/editSettleSignal.js\":\"2d9ffb16ca7618d4\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/insertImage.js\":\"9cbe209656c3b96b\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/referenceCompletionRange.js\":\"81c4b5677ad28b78\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/referenceTargetTypes.js\":\"368c8a5c8ee4a251\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/syntaxContext.js\":\"1a9d1f75e7a7cf45\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/triggerMatch.js\":\"302abfff562fe3cb\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/AppRuntimeProvider.js\":\"f32326b06b9843b2\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/BlockFocusShellDecorator.js\":\"63e6621e564bf571\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/ExtensionRenderBoundary.js\":\"a5435a96d60c0431\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/PanelContentRecovery.js\":\"c3a32f96dfeee083\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/apiCatalog.js\":\"cf5795629b6d9667\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/approveExtensionHere.js\":\"73119f5dcf616c20\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/armedCutAppMount.js\":\"8a3d74ed2280bd6b\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/batchableKeyedStore.js\":\"54dfa7032e4b199e\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/blockInteraction.js\":\"138747591790d0c5\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/blockSelectionAction.js\":\"b9112f5c1e3807f9\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/compileExtensionModule.js\":\"bb59f1975d348317\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/compiledModuleCache.js\":\"db2ecdb7ab7493d0\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/continuousGestures.js\":\"9461e87f280e889e\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/core.js\":\"334666007a277b99\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/defaultRenderers.js\":\"03b9a2a9d03ee829\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/definitionFanoutAppMount.js\":\"c7210640554cef0b\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/dialogAppMount.js\":\"9f545a9cda02446e\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/dynamicExtensionSeeds.js\":\"ba496b9e536ced36\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/dynamicExtensions.js\":\"5fcc163d9dbf3ae4\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/exampleExtensions.js\":\"dfe59264028701dd\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionApprovalStatus.js\":\"949761da46948206\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionLoadErrorToast.js\":\"59470f0611808db6\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionLoadErrors.js\":\"2f9d9ac8f47e0fb7\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionLookup.js\":\"bc3d5a72a47605fe\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionToggles.js\":\"173f8b03b9d690eb\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionUtilitiesCss.js\":\"ffa8e4500b5617ae\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/kernelPageDeletionGuard.js\":\"af46b4699b18ff84\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/liveRuntime.js\":\"282d296b3a2a5faf\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/openExtensionsSettings.js\":\"e26c2f6c7c4db537\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/overridesCache.js\":\"c15cffbc124aa23e\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/pluginIds.js\":\"3a33955c3e7f546d\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/processorRejectionToast.js\":\"59de409278470cbe\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/runtimeActions.js\":\"41071f62b9d99ba1\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/runtimeContext.js\":\"338e350f81a45d10\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/staticAppExtensions.js\":\"392d52a7559c7915\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/staticDataExtensions.js\":\"df9353c5c6bbe8e3\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/toastAppMount.js\":\"6007ca95fcaeb493\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/useOverrides.js\":\"1fbdc9cfe24d4fde\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/useShortcutSurfaceActivations.js\":\"0cb47a27fd040508\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/discoverToggleTree.js\":\"33b284ede883ba81\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/facet.js\":\"6dd80ee91d1dbef5\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/resolveAppRuntime.js\":\"7e90f7d8e2e4c1ed\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/runtimeEvents.js\":\"a5f8ce969c37f645\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/togglable.js\":\"b2b0f781cfe6ee4c\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/variantFacet.js\":\"5268aabe74a7d9ef\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/verbFacet.js\":\"64c3db379b7715b7\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/block.js\":\"339383cd757b2327\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/focusedChild.js\":\"6549a8ad92633752\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/propertySchemas.js\":\"2dcb623911df12fb\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/typeRegistry.js\":\"ba5ae6e3f1aee5ac\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useAncestorCrumbs.js\":\"267b9902dd56778b\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useAutocompleteListbox.js\":\"4e6fccfee702582f\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useDebouncedSearch.js\":\"ecdfda80da9de94a\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useDebouncedValue.js\":\"08d127dd3f8a2830\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useFacetValue.js\":\"d5d0a2cdcdfa87b5\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useIsFocalRender.js\":\"33d7ca6e44a84f5c\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useIsReadOnly.js\":\"dfdff4138c75bea5\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useMaterializeBacklog.js\":\"bf819aadf81b7905\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useMinuteClock.js\":\"107b1e6c4f2538b8\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/usePanelLayoutProjection.js\":\"71001474a87b6941\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/usePendingInvitations.js\":\"e68baa43db19d54a\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useRendererRegistry.js\":\"33303c694e67197f\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useRetainedFieldRows.js\":\"38d0f6ef1387575a\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useWorkspaces.js\":\"42398c772c1c35c0\",\"/knowledge-medium/pr-preview/pr-1890/src/lib/utils.js\":\"94173d515849a021\",\"/knowledge-medium/pr-preview/pr-1890/src/main.js\":\"730875d684ec1e6c\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/MarkdownImage.js\":\"8343154f519ef28e\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/blockSeparators.js\":\"dbbb20bdf80ce068\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/context.js\":\"4552ffd91f34a8cb\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/defaultMarkdownExtension.js\":\"914631bdae63cae9\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/extensions.js\":\"7a06451e974e2f81\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/renderMarkdownHtml.js\":\"fdfea71fe0b80e66\",\"/knowledge-medium/pr-preview/pr-1890/src/minimal-editor.js\":\"ea9a6c78d2cc7c92\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/armedCut.js\":\"f06c18faa0564429\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/captureMediaVerb.js\":\"a6bbf0ff7d475fdc\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/clipboard.js\":\"6ee1a558c678b184\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/decision.js\":\"dd12b9693a4fa751\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/operations.js\":\"2e861a64919020c9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/account-header/AccountHeaderItem.js\":\"ddd425744e5a1558\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/account-header/index.js\":\"98414b6a65c2128c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"cbf2ab923244d730\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/askAgent.js\":\"fbec5b537156369e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/askedStore.js\":\"a5fb74f5cd3e9474\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6be3876aa59fcc64\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/chipState.js\":\"34b1057e0858c6d8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/dataExtension.js\":\"e504e51307b940f0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/index.js\":\"69ed40877d013875\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"752a161325b3ef10\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/schema.js\":\"d8ecae75d1b194c1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d80501ec2a40a06f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/BridgePairingDialog.js\":\"7335af85f7978b37\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/addMedia.js\":\"1904acc8d4add549\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/backlinks.js\":\"000af78e7bdd087e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/block.js\":\"65f92dfa736b1cd0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/context.js\":\"705dc8afccf78536\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/displayIds.js\":\"1fe425553e06bc13\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/index.js\":\"01e3807c03a352a4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/outline.js\":\"fa6e55311459b631\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/properties.js\":\"204bc11ea0bacbe1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/refs.js\":\"1cc8eb707b276edb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"440750a5cdd70b88\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/search.js\":\"aabd2ed69f4a0691\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/shared.js\":\"52e9c009b14cace2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"9f6ec99a06ef0760\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/text.js\":\"705ad2779c72be44\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentWrites.js\":\"9e1341daebd18e45\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/authoringCatalog.js\":\"6ca68a5b1766a03d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/blockRefTargets.js\":\"a99a7d2fbcdbe263\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/bridge.js\":\"7e50ed91ddb77f07\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/bridgeLoop.js\":\"6c1c484e200aaa79\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/changeHistory.js\":\"6e6b816583d83087\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/commands.js\":\"c20cd16bc1e5a071\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/commentsCommands.js\":\"33ef0d18f7d873d3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/dataExtension.js\":\"0374905f2806d58a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/dataModelGuide.js\":\"e113b3d16ae2b69f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/dayPropertyInputs.js\":\"a23ea7036a316f18\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/describeRuntime.js\":\"eec1e1302c996ce3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/extensionLint.js\":\"63a38f53ada90245\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/grainAudit.js\":\"513f04a6f64cdc6e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/healthCommand.js\":\"106e662f134ec471\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/index.js\":\"cbafe4ec9368c015\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/presetIdentity.js\":\"c9493db41d1992c2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"355c0f6f3b6d9500\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/readMedia.js\":\"4f6fb277d9c8b296\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/schema.js\":\"0b58aecc4360646e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/serialization.js\":\"057f7677d9d85a2d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/targets.js\":\"1b3d16d311c80722\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/tokens.js\":\"0ed2c4b00653f133\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/watchEvents.js\":\"e8d38edc38e735f4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/workspaceGuard.js\":\"c2e61aa2970fa334\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/writeCommands.js\":\"996fcdc354714994\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/AliasCollisionToast.js\":\"a3cd8e338ae31523\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/DuplicateNameBanner.js\":\"14ff2a8c256c2a6a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/collisionMerge.js\":\"e43d7f71c0e872a8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/dataExtension.js\":\"f314c0d63b5535bb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/index.js\":\"19b198fee39e9e7d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/mergeCollisionAction.js\":\"c4fc36273d898b2d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/pageStyling.js\":\"b13d72ff67df169a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/rejectionToast.js\":\"be7b57b2e79b4a08\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/syncProcessor.js\":\"6280e33cd1e00c5f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/actions.js\":\"aa0d243b35c85a18\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/addComment.js\":\"fa07c265aa31175b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/anchor.js\":\"7e504499585e87de\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/anchorState.js\":\"539980c01c1b18e0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/commentLinks.js\":\"f1a713bf806a532a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/confirmThreadDeletion.js\":\"97926625693644a4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/container.js\":\"e84e53f3a30ad748\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/dataExtension.js\":\"1b960793379fda56\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/deleteComment.js\":\"ce6698257dd9975a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/highlights.js\":\"57d92cb312aa182d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/index.js\":\"bde8e3d4fca6baab\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/linkedCommentsPill.js\":\"bafd5d79a88dee68\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/margin.js\":\"562ff7d013cbc35c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/marginAnchorLinks.js\":\"f21661cf8bc3ceba\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/marginSchema.js\":\"67ff0f949075e55e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/newComment.js\":\"429f23b2fa087aa9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/ownThreadPicker.js\":\"86be029deaaf69f1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/placement.js\":\"161b2f1a4de17b8a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/queries.js\":\"e93ce853e60271ed\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/quotePosition.js\":\"5ef9c04f389acbee\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/quotedIn.js\":\"6827985433c51ea1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/quotedRange.js\":\"508b2a8c4aecf560\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/rangeRefs.js\":\"8e1e6a16e02caded\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/readHighlights.js\":\"06560e11a5521aab\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/readSelection.js\":\"cc1658b991107f3f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/readSelectionUi.js\":\"d258e89e27e0a7c0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/reanchor.js\":\"308a44eb0cef1cde\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/schema.js\":\"c732175bd32d9af9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/scope.js\":\"6146b63fae628ad3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/scopeThreads.js\":\"f0a192566021e8d9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/splitRetarget.js\":\"16a2d332555f108e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/suggestionCard.js\":\"362dab56dbdc3005\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/suggestions.js\":\"b7fc1c53a75d3161\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/summaries.js\":\"5d16229c42505f08\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/summaryBatch.js\":\"0abf7302171f054f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/surface.js\":\"b1b441b15cfc5b61\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/threadNavigation.js\":\"b508af206b0f231a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/threads.js\":\"334e033b043e6d4f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/ui.js\":\"8868a50548567102\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/uiStore.js\":\"e4a1ce52c92f90bf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/app-intents/appIntents.js\":\"63b257772489a686\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/app-intents/index.js\":\"f4a889c633c40078\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/app-update-prompt/index.js\":\"08a98afda3d988a6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/app-update-prompt/status.js\":\"829f9cad4e8eeadb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"10109c6c82e41357\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/MediaBlockRenderer.js\":\"263771f92af1c328\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c0afa98db4bba8ce\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/MediaUploadReconciler.js\":\"4bed45261c6982b5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/assetDownLane.js\":\"324fabd118846ac8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/assetResolver.js\":\"34977bb6b6a5f5d3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/assetUpload.js\":\"2df62938996d0cef\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/attachmentCleanerIO.js\":\"ad9735d21b3d4f57\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/supabaseAuditIO.js\":\"a4fc8b52ad0d7698\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/blobStore.js\":\"eea1d78bc716c719\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/browserMedia.js\":\"d20c47d4fdf456aa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/byteStore.js\":\"474013270fd35a4b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/cleanerIO.js\":\"6274a6046c60f7b6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/cleanupAttachments.js\":\"79b977c118dcd671\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/dataExtension.js\":\"3b67ee9f55764df3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/downLane.js\":\"fa500dd1441f6b83\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/index.js\":\"c72c90671aef0199\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/insertImageContribution.js\":\"e8411fbbcdf11b54\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/laneArming.js\":\"cb822e0625e5072b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/laneLock.js\":\"68aaf8d362464575\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaBlock.js\":\"638b4477d4b82917\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaCapture.js\":\"b9e4e588e3e01d9e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaLanes.js\":\"9f48f0fd76a28ed3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaViewers.js\":\"1e86cf7b6c66173e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaViewersFacet.js\":\"5d3685780d30a2b9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/pasteCapture.js\":\"8920ad33393822b6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/resolver.js\":\"807f532b1ffc4ba5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/retryUploadsAction.js\":\"0c793f9da9283123\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/storagePaths.js\":\"bc812f253fa5009e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadDrain.js\":\"98d8f29f4fdde691\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadLaneStatus.js\":\"807e4bee0d2eedb6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadReconcile.js\":\"5a1488b136678405\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadRecovery.js\":\"10e98e4b1428b853\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadStore.js\":\"384321c2cd168287\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/useAssetObjectUrl.js\":\"0bd32dcae41b8dc0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0866306cd3882761\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/BacklinksViewSection.js\":\"605f13606ce9b010\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/facet.js\":\"57785d9318901ccc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/index.js\":\"ae6ea54da326a9b5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/prop.js\":\"4aaf8fef7c1b2642\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/BacklinkFilters.js\":\"88298ccc2f18228d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"7949d826ff4c0ece\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/BlockEntry.js\":\"3d106b3fab7d8bc1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/LinkedReferences.js\":\"080d5bbf3933eb4b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8b337f57899eaf1f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/dailyNoteDefaults.js\":\"b8eddc8bd9af3fd2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/dataExtension.js\":\"f9652eda03be85ee\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/edgeExclusions.js\":\"67c1e60cd726e8af\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/filterProperty.js\":\"4a9dc3d98457adca\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/index.js\":\"034a904eab5204fd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"cd2a4428569e9369\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/applies.js\":\"65f59979e9661abd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/countQuery.js\":\"524a16542694a27e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7f3487ead7c3f0f4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/index.js\":\"b2b40a835f3611bf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a393acf98a9b7a07\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/presentationInvalidation.js\":\"a2557610cbff674c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/propertyEditorOverride.js\":\"7e25199ef02d980f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/propertyFilter.js\":\"0c2460b3fb71d28d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/query.js\":\"d6da5fc5282eee69\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/resolveFilter.js\":\"3e761bb36e2b32b4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/sourceBatch.js\":\"53de5c2974287a85\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/sources.js\":\"b77341655064fa7c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/useBacklinks.js\":\"1ade64e44a3661c1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"e937fee487737aae\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/BirthdayCelebration.js\":\"7f7ca7559cdfc288\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/BirthdayOverlay.js\":\"598f976dfc62c0c2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/gate.js\":\"4ec65b98e24bc7bc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/index.js\":\"de6b8c04aad1d156\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/wolfTheme.js\":\"094b1e1cf0ab153d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/BlockDragLayer.js\":\"2435acd57c5743f2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/dragController.js\":\"56ff0ac9b1c7e899\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/dropTarget.js\":\"eb736c14218f81de\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/index.js\":\"750526997c3af2c4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/projection.js\":\"5a6c3d51f07c051a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-info/BlockMetaCard.js\":\"0b872e90cd16b002\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-info/index.js\":\"e49eea3c3dd2841d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/AddTagDialog.js\":\"7c13ce942cd87e33\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"54d3a8ad1b32957d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/TagNameIssueHint.js\":\"be2911646e4bdc41\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/addTagAction.js\":\"3e2ec4a11060f1a6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/appendTag.js\":\"b31db5b96762c231\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/config.js\":\"d9442cbb878c81bb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/dataExtension.js\":\"528482ea2135cc37\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/index.js\":\"fd4255a79ed6c18a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/propertyEditorOverride.js\":\"835baaf41f35d4b9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/BreadcrumbList.js\":\"05552196e18ad830\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"29ffa402ad12c82e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5976db153c17fbdc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"14f228702e0a2cce\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"52138875d20dc80e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/index.js\":\"28830bd2a7fdc527\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"cd68fd788f9da37a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/CharacterCountItem.js\":\"41bec87c05b3b9d6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/ProfilePropertyEditor.js\":\"ac6f1e14b1232f98\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/actions.js\":\"a40433e181e97fe7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/blockType.js\":\"b10f72ec78822efc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/charCount.js\":\"cc3276a82201b463\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/dataExtension.js\":\"06600cca5b470bcf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/index.js\":\"5ab6b90102b4159a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/profiles.js\":\"0949f24ddca1f031\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/properties.js\":\"0bb3fd4e9e62fec6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/subtree.js\":\"26816e4fc53c471e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/textCounts.js\":\"ed57b496da3f5fe2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/colemak-keybindings/index.js\":\"c3ec312836c5e9bc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/CommandPalette.js\":\"0930886e960f9e0b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/HeaderItem.js\":\"c8b744aaa8aaee4c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/context.js\":\"bd8f01641873b598\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/index.js\":\"4ce3f7fa0d240466\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/selection.js\":\"0a995527313eeac1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/toggleStore.js\":\"46525b626232f9a6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/useCommandPaletteActions.js\":\"9fa42aa4163098e3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/ContributorBadges.js\":\"c4e4879523cdde76\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/ProfilePicture.js\":\"a42dfcddfdc101d2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/author.js\":\"c6450a5cf696402e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/codeMirrorExtensions.js\":\"d12dea968a4e72df\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/dataExtension.js\":\"7ecc506e9dde1cec\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/index.js\":\"64b38a01bd139499\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/mentionAutocomplete.js\":\"d506672cf02da914\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/processor.js\":\"4354f4a9c729d6ab\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/profiles.js\":\"02215468c3112fe3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/queries.js\":\"2c4ee218d61d3b5a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/schema.js\":\"8af96550f2c54cf7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/useCommentAuthor.js\":\"d712436df6a2611b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"2281c093104e8136\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/followOrigin.js\":\"367135e1664752d5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/index.js\":\"e24032680cfe2775\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"ca712fb1be31c3cd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7cf0c96cae0b6f82\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/CalendarGrid.js\":\"6f1be3d340494cc6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DailyNotePicker.js\":\"1ebb2b3da60922ed\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"f75cb2a557fa0ce0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DateNavDecorator.js\":\"e227d9884faa30c1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DateScrubOverlay.js\":\"16d731f9587c5bbd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DayPropertyControl.js\":\"2adbcaba3f70b14d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DayValueReferenceControl.js\":\"7fb3a1a4da66e755\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/HeaderItem.js\":\"8613412b7473ac0d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/ReschedulePicker.js\":\"389c7b532c46d63e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/SpreadDatesDialog.js\":\"19445b0882b61007\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/actions.js\":\"7e3a1f416be06f6f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/blockDateAdapter.js\":\"325de71aa1df1f6c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/calendar.js\":\"facf6827bbcd0f03\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dailyNotes.js\":\"36b6fa5e2eba6491\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dataExtension.js\":\"30d61961fe9d6c8c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dateScrubActions.js\":\"aaee054de1284878\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dateScrubGesture.js\":\"423d7598f104d602\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dateScrubGestureActions.js\":\"9834dcd98dd3e8a0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1bed32ab14f92d2b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dayProperty.js\":\"4f5c4c815b996ca2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"b0c87070a835d906\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/deletionGuard.js\":\"f5c929972abcf41b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dueQuery.js\":\"2d1d5f6662d8a402\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/index.js\":\"77b587d0de339c40\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/landing.js\":\"512815aa5f4c7d74\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/localSchema.js\":\"4e281ac02960521f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/referenceDateAdapter.js\":\"27531d8bca5ea5ee\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/rescheduleAction.js\":\"6c9de36f2f2a4146\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/schema.js\":\"a58c5204d4911457\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/spreadBlockDates.js\":\"de3b889cdb153e5d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/spreadDatesAction.js\":\"0e8bfa03a28d9fc1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/today.js\":\"5d1ac6edcbf05332\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"61226713432571a8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9660639bf5bf1cd6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/audit.js\":\"42e1d05ec3d92ee4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/auditAction.js\":\"1263193e48146ed6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/auditRanges.js\":\"3d36cbac52941562\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/diagnosticsSource.js\":\"4376147116595e7f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/divergenceScan.js\":\"aef7b2f8806f0788\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/index.js\":\"d054acac4a0041d6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0522d6813030ef09\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/referencesMirror.js\":\"253d22c629b45764\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/rowJson.js\":\"505ab1a3a6a9a9ff\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/schedule.js\":\"06421dbe400d74be\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/store.js\":\"05b2d2785877803c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-maintenance/action.js\":\"ae5b0598ad9005c3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-maintenance/index.js\":\"9da80a2db8d00cd8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-maintenance/plugin.js\":\"122df74a93c97e3a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0e70925425314669\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/actions.js\":\"2df518fbb301d9d3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/changeMarker.js\":\"4a68d224d61131f6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/diagnostics.js\":\"6f88511ee8e08bd9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/fileSystemAccess.js\":\"cb29a7c5d71f624d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/filenames.js\":\"d46b880732843316\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/index.js\":\"d8097af5bc296552\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/mirror.js\":\"ead0ec59022b908a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/runLock.js\":\"5ae93bf00d897336\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/runtimeHealth.js\":\"0a855afd8e324ee9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/schedule.js\":\"67e9dd2c28ce4fb4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/store.js\":\"cca84bdbb59132d5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/default-themes/index.js\":\"b7a67f9635489791\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/default-themes/themes.js\":\"3485be4043ae572f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/diagnostics/facet.js\":\"4328cf4a970baa60\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/diagnostics/useDiagnostics.js\":\"53dd7ae826f3c931\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extension-prompts/dismissals.js\":\"83fd82f2ea7995bb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extension-prompts/index.js\":\"7409e17eeb42aa2c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extension-prompts/status.js\":\"2f6f85f6a3fecdd3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extension-prompts/store.js\":\"fbeffa34b4ae1bdf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"136899b590b0645a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/ExtensionsSettings.js\":\"5698eb7d4ad693f4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/actions.js\":\"5dea20304ed4f510\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/config.js\":\"9f7009247b6fd3ba\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/dataExtension.js\":\"fab3b088dd535ec1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/effect.js\":\"713b0331987ac2ed\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/index.js\":\"fb44efeb1f3297bd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a2872130ff184778\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/useToggleTree.js\":\"367e4ec1546410f0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/ExtractTypeDialog.js\":\"5d2e94367469626a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"faa84f15da360faf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/PropertyShapePicker.js\":\"ecbe92c5acd42b76\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/action.js\":\"59d85310625a91c1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/index.js\":\"e66b4f185ffd787c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/FindReplaceDialog.js\":\"cc43a25674c11eef\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/HeaderItem.js\":\"85cce295ac3788be\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/dataExtension.js\":\"0464f6e37305b08d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/index.js\":\"f36c4247fa91ce08\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/search.js\":\"5452deecd17b847f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/toggleStore.js\":\"6e10c0e4e0259c58\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/LocationPropertyEditor.js\":\"ff1c19796326775b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/MapView.js\":\"21f5f5acd18c108a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/blockTypes.js\":\"b5bc916660fbe26c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/codeMirrorExtensions.js\":\"a14be866dd568503\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/createOrFindPlace.js\":\"82af401f8aab0300\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/currentLocation.js\":\"5a70e47a0d3c9c5d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/dataExtension.js\":\"aad65e91b19adffb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/geoContentDecorator.js\":\"6b5dd42451761a09\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/googlePlacesClient.js\":\"8a476c8bb65ad70b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/index.js\":\"f48fb1a23b09a9c4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/locationsPage.js\":\"e7ce30d81f328e72\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/mapViewport.js\":\"08e8459b2b208764\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/pickCurrentLocation.js\":\"a66a11e3f41af2b0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/placeAutocomplete.js\":\"14f79e3efd3a34cb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/placeNameCollision.js\":\"99fb63980d5aaf4a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/properties.js\":\"f3e9e8c4bf0fc32f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/propertyEditorOverrides.js\":\"090c97c89abb8944\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/query.js\":\"0e2782a204060a68\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/usePlaceSearch.js\":\"725905e62ca69f56\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"e92ff1a71361bffb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"64fb78983da4ae06\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"03074961623f2c52\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/config.js\":\"3dfeac4f66c90c50\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/dataExtension.js\":\"50ab0dcb793f637d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/facet.js\":\"4fd13f45ed83ac27\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/grouping.js\":\"727838ca2139699f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/index.js\":\"bed8c28c0302d516\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2fd4c9220a1885f0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/query.js\":\"9c8cb899a1a8784f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/resolveConfig.js\":\"689ce1c2d3934705\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d3670c0911f14baf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"51d8f0846ad0b1e9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/HtmlDocumentContent.js\":\"78ec8c5ad9e63897\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/HtmlFrame.js\":\"f68b9dd078a7be53\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/actions.js\":\"ed22f3975275ba87\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/blockType.js\":\"022cc97d6859287e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/confirmRunScripts.js\":\"4e93ca2e1eba8a1b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/dataExtension.js\":\"fc2ba40b4d40a23c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/frameAnnotations.js\":\"116a854ad1414bb6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/frameDocument.js\":\"b6b9838eebfbc9c2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/frameTheme.js\":\"369b1991b4fbe274\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/index.js\":\"3528380278a20372\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/scriptConsent.js\":\"ffd0b851d4c7ae15\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/sourceMap.js\":\"e4ade7674cd662fb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/useDocumentScripts.js\":\"fcaf8904f8366d69\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/index.js\":\"7c43d5504ac6af9b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/record.js\":\"2689ca383f91d93a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/recordStore.js\":\"ee11a881a505e917\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/responsiveness.js\":\"1ebb46098a82381e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/schedule.js\":\"b671f31b35058cc6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/sessionContext.js\":\"41411bf785a5daa0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"eba42a38fd6d95f4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ed64e351c7fcfe73\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/actions.js\":\"ac151af1a124c876\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/config.js\":\"eaad3f369ac93bbb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/dataExtension.js\":\"899a3891af67f3ef\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/effect.js\":\"092ec54d060e6049\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/index.js\":\"8bc1a0e9028104cd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/keyCapture.js\":\"e8288ec76100d094\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/overrideStore.js\":\"065334e423f2920d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"887499b9489b4afa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/HeaderItem.js\":\"43bd195b58977de6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/LeftSidebar.js\":\"9050b1bdd3563fdc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/actions.js\":\"4fc08d14318d439b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/facet.js\":\"87cc7a4627c34e91\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/index.js\":\"5846379dc6810a1f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/shortcuts.js\":\"bb2b77db0399230e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/toggleStore.js\":\"9b8459b0c7f712ae\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/merge-blocks/MergePicker.js\":\"bce9afd1cbfcb94c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/merge-blocks/index.js\":\"17abd875ad1daa64\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/merge-blocks/mergeAction.js\":\"c04a98357188a1f2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/merge-blocks/strategy.js\":\"34b9e6a24c60c70e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/Button.js\":\"e0ca0ca2dcfabeaf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e09e2658d19892ab\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d10dc44fb75b7de8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/facet.js\":\"3fa2638856e447c8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/index.js\":\"b91cd6e400c64f0e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"2e6d1a4d1f9b3c3b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c92f74304fb64128\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"a62a57dc13e02f05\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/facet.js\":\"bff66f36ce6588d0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/index.js\":\"27093bf1fc598415\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9ad88d8b366fddd1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/blockSubtreeMembership.js\":\"369db21d190db57d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/contextMenuItem.js\":\"e9fe40500d2028ce\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/index.js\":\"125b7086cfe0a233\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/moveAction.js\":\"4c3c1c300a8f0e07\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/moveBlocks.js\":\"a6c0afc89b7a3705\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/selectionAfterMove.js\":\"2808ed30411f1b42\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/TutorialBanner.js\":\"b4cf69f67f762074\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/action.js\":\"0481e84224ed585e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/bannerDismissal.js\":\"dcf3ce00263ed270\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/documents/cheatSheet.js\":\"91d9ee7824759483\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/index.js\":\"a706e648bcc185ba\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/keys.js\":\"76b28eb20bd51ba6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/landing.js\":\"3f88527511e2f2c5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/outline.js\":\"cf20978f0d820069\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/seed.js\":\"d82347fefdce87f6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a96f19833e3f2180\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/analyze.js\":\"fd8e1c6c8212ebd9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/diagnosticsSource.js\":\"6e1f604ff037716e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/index.js\":\"22d9a13131de36ba\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/load.js\":\"8a70d2c0f9d3e2ce\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/monitorRun.js\":\"460384dcbe0ba8a3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/schedule.js\":\"d0531cdbc77510cd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/series.js\":\"7b3675a8d8841efa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/store.js\":\"26d198496b8dbaad\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/trendAction.js\":\"81f032e2ee4f0c2a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/verdict.js\":\"d2bd67ed6dee94d6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/plain-outliner/clickToEditAction.js\":\"b99b56711101ab73\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/plain-outliner/index.js\":\"88271a941c7f7721\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/plain-outliner/interactions.js\":\"4b90d85b4b457b0d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"42d83a5faf1b9090\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/MigrationGate.js\":\"3dbf5049aeadb3a4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/MigrationGateDialog.js\":\"7c0cfefbff30cdf0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/action.js\":\"a5fa7a17bdcba348\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/index.js\":\"e27dd7cd4a8d074d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/localRunMessage.js\":\"97a28cc99ea1f6d3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/plugin.js\":\"be478bb39aceb8bd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/progressReport.js\":\"dbff09e5a7fd9cde\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/sweepProgress.js\":\"98d29422db5632e2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/FieldRowRenderer.js\":\"2be0e5112fc678d3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/ValueRowRenderer.js\":\"bab7c5b0c897fd46\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/actions.js\":\"5787c5a111d67413\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/autocomplete.js\":\"7c8d2c2b7d5b623c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/fieldRow.js\":\"f8d4e063c4578f4c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/index.js\":\"2d6af4b63077e198\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/referenceWarning.js\":\"dad0268a6abd3669\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/valueAutocomplete.js\":\"16a26f335fa2c37b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/valueSchema.js\":\"f8ca84c50db43c34\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/HeaderItem.js\":\"cd6fc17288016179\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/QuickFind.js\":\"8af0d2af8089f4d3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/index.js\":\"e56726f1ff33344d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/recents.js\":\"6d0fb18f196576c6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/resultItems.js\":\"ca6c8b1135b96230\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/selection.js\":\"98675c3c592b8cde\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/toggleStore.js\":\"6c93949f5a6be274\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/HeaderItem.js\":\"98d44fdfa51791fd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e80e732c4b8b95d1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/grouping.js\":\"fb18bd5fbebe84e5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/index.js\":\"b570eb95c15e74af\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/target.js\":\"20f55a7bce24a68d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/codeMirrorExtensions.js\":\"d5116529f3ec37c1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/contentPrefill.js\":\"2336355ce6a01d0c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/dataExtension.js\":\"d9fe8db2972090e9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/index.js\":\"f9ca0fa7b2747aa1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"ed2204a83e473b62\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/invalidation.js\":\"796c3d3c33621839\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/localSchema.js\":\"b5a214c0f25b1566\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/blockrefs/index.js\":\"b93eba13e9611d91\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"73d3caff32ce88ae\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/index.js\":\"849b6968478c126b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/referenceNode.js\":\"f00cf1a5ac7db62b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/remark-reference-occurrences.js\":\"915b4129113855b3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"e4aeeb1d4e4f8f1a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/wikilinks/index.js\":\"c22a16543b085a93\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"40ec7c0b17f1aaef\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"95f11e1712a67ae4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/mergeRetargetProcessor.js\":\"e6480cf7beab81d0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/parseFence.js\":\"768fc9076b2ad905\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/referenceParser.js\":\"bc258b067ac17200\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/referenceProjection.js\":\"e224d4529d45af3b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/referencesProcessor.js\":\"0cb5d316ddfc3b5f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/renameProcessor.js\":\"5ad034c32e5f1622\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/spanReplacement.js\":\"8e89a0cc5c912d2b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/rich-paste/htmlToOutline.js\":\"1b327ec45019cece\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/rich-paste/index.js\":\"c4afa71f8d772c3a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/rich-paste/normalizeClipboardDom.js\":\"25e847c0e6a4d445\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/rich-paste/pasteDecision.js\":\"f4480553f20dbbd6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/action.js\":\"0fcb289d348a9f0b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/blockIds.js\":\"a20d28a9f713a9c5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/content.js\":\"5ebb58c7fa68721b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/effect.js\":\"37bee2b1c3a04c33\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/ids.js\":\"85ccc5d5418971de\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/import.js\":\"c9ec8ae2c7f727f9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/index.js\":\"fb43c0c7c12ff8d4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/plan.js\":\"f8a96d051b82ff01\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/plugin.js\":\"07e33637a738a68a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/promotion.js\":\"4cf6e961a80bceb7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/properties.js\":\"c8948adab8ce1cb0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/references.js\":\"dc0862731cefc0a5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/report.js\":\"7f6ed4e50139e1e3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/roamMemo.js\":\"607634d8e4a10aeb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/runtime.js\":\"af4372037ec79e25\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/schemaReconciliation.js\":\"d9280b301e0638eb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/srsMarkers.js\":\"07854dd1480b0560\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/todo.js\":\"83b0a037a633fa7a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/typeCandidates.js\":\"a4e29cd54fe21d2c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/types.js\":\"65ea84f7eb9421da\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/search-health/index.js\":\"fc65ca9e2806e757\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/search-health/store.js\":\"1b04c7bc27712662\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/HeaderItem.js\":\"c302fa279519c028\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"38f94b563272ec68\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/index.js\":\"9ef46b8c8260fb19\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/model.js\":\"899156cea3e2289a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/toggleStore.js\":\"4aa2bbf0f3b15133\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/useKeyInspector.js\":\"ac2d099071aefa4c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"216710aade069cf4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/ShellDecorator.js\":\"7cf48b79ba7b409d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/actions.js\":\"f4b213c6ea65a071\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/exclusionsFacet.js\":\"566ba1fcd3c9c3a8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/index.js\":\"bd828fa39d58f800\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/shell.js\":\"311f53f8b4803e57\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/surface.js\":\"9dfcb05306073ae0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/walker.js\":\"151b7fa69d275e49\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/RescheduleToast.js\":\"2ec40faca6e82435\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/dataExtension.js\":\"a78e05beba6a3aa1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/index.js\":\"7f33ca622463fdfd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/indicator.js\":\"2045c5f2f386aeaa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/moveSrsState.js\":\"881d562a0daac5a0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e6477895be57bc04\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/scheduler.js\":\"089a3702eab9ef65\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/schema.js\":\"4060306fc85adf73\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ad1a1f3f0d4e000f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/srsClipboard.js\":\"6d4eda1b1f8e3d5b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e357fb1d5c1fd475\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/DailyNoteReviewHint.js\":\"fd41d7deea5b0340\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/DeckPicker.js\":\"d2f3b384124ff19c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/ReviewControls.js\":\"7d253506013a29ac\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/ReviewDeckRenderer.js\":\"fb0da7a03f4cfb31\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/ReviewSession.js\":\"7880cda460168303\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/actions.js\":\"a07555cce0f58703\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/archive.js\":\"11024248fe0e832d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/dataExtension.js\":\"3f27f6fd849395c4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/deck.js\":\"db38844e00991e31\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/dueQuery.js\":\"f376c0e660ab4e6f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/gradeDecision.js\":\"bf896a77967c5f5c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/index.js\":\"1e35ae3d7fd63eaa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/keyHints.js\":\"a49b49bf1bffcdfd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/reviewCardLayout.js\":\"d49fb7b4e9510717\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/reviewProgress.js\":\"0ffb80e7c80c8648\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/schema.js\":\"de483ab96df98e3a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/useDueCards.js\":\"b81a58d5b407e9a8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/startup-metrics/index.js\":\"f316a570621ba007\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/startup-metrics/record.js\":\"4b2955739f7e6178\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/storage-persistence/index.js\":\"8bf541a0ae4f1217\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/storage-persistence/persistenceStatus.js\":\"ec1ee95b9161e9b2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/storage-persistence/requestAction.js\":\"6a666e81262e5bfd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/supertags/TypeChipsDecorator.js\":\"48958c374c00479b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/supertags/codeMirrorExtensions.js\":\"fb2cd2f001c48406\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/supertags/index.js\":\"d692190dcf2c3062\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/supertags/typeAutocomplete.js\":\"bc7fee4ddee7486f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e01f94a4bf9b8517\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/actions.js\":\"9a5bd127881ba6cb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/anchor.js\":\"d5946ae9b4d574e9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/events.js\":\"203fa015ceec395a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/gestureActions.js\":\"10a0011e1303ebdf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/index.js\":\"19311aee624db9c8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"18891d72f1f2d6d9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/sync-metrics/collect.js\":\"699fcb7a4975cb21\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/sync-metrics/index.js\":\"635d4ae47911dd3d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/sync-metrics/record.js\":\"e669754d86714dff\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/RejectionDialog.js\":\"53d4214d6f28db40\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9c7d1dec9b151bf6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/index.js\":\"5bf1c833725f8b12\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/model.js\":\"2b7f38410e36bb03\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/queueCounts.js\":\"02d8f9010595e85f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/rejectedHelpers.js\":\"2ceecd040c8f08a0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/rematerializeAction.js\":\"ab8f585c88472646\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/useHysteresis.js\":\"3530a4473e39b413\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/ColumnHeaders.js\":\"cef49797fb1fa6c5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/QueryUi.js\":\"711160d32a6ff6c0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/TableLayout.js\":\"a1ae167ebcb9d89a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/actions.js\":\"8acfa12eafc47993\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/cellEdits.js\":\"39d156214064ac59\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/childrenViews.js\":\"43e5c37ea749b1c7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/columns.js\":\"920a78cab4eead88\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/controller.js\":\"77fda65d3ddf8ec0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/convert.js\":\"15645851893a17d7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/dataExtension.js\":\"ce01950f4d6ffbe2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/index.js\":\"ff7fceac6bff8a5b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/keys.js\":\"d92e0129137e5948\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/model.js\":\"3a6aab01bbc89b6e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/QueryText.js\":\"4d2d4b583f8a96a3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/backfill.js\":\"8d1c4771dc492023\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/completion.js\":\"f476c5268fbb4e19\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/format.js\":\"b87e236ba4fb32c7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/parse.js\":\"e825d98012526e0e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/queryValue.js\":\"e8172df092057b10\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/registrations.js\":\"eb699ebf416ddbbc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/source.js\":\"b7c002310f46930a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/registry.js\":\"19f26613ad4e2933\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/rowGutter.js\":\"c77b21a7f261298e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/rowVerbs.js\":\"aff14650010bf156\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/schema.js\":\"9a92e22bf6395856\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/sort.js\":\"bbff3f2c5f319080\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/theme-toggle/effect.js\":\"06c91376eaea60af\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/theme-toggle/index.js\":\"422a84c605f89aaa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/theme-toggle/theme.js\":\"5fbd6d3ae4b6b0cc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/todo/actions.js\":\"1d09610f4ac99463\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/todo/dataExtension.js\":\"7200bc2bda2ee3ee\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/todo/index.js\":\"cb37d782d4d25418\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/todo/schema.js\":\"e2bb155d9074364c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d98b3ad2ae16f85b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/actions.js\":\"096cbe0910af5a47\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/defaultItems.js\":\"14882ee2475618e3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/facet.js\":\"052c3c1d93ffaaa2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/holdRecognizer.js\":\"599c9652afa2d4e7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/index.js\":\"f168a6241fc30513\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/update-indicator/UpdateIndicator.js\":\"c70ecad15f35c811\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/update-indicator/index.js\":\"77c5152be140b030\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/update-indicator/loadTimes.js\":\"f4ac2cea1750fbdb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/VideoNotesRenderer.js\":\"5b4acabba810b4da\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/VideoPlayerRenderer.js\":\"e60ccbb8b2302fa5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/VideoTimeStamp.js\":\"99479c7d6cccf769\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/actions.js\":\"3d93368a6865fe6e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/index.js\":\"edbf278804ea570e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/markdown.js\":\"d024d3766cf1055e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/notes.js\":\"e2fb29439c7225ea\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/registry.js\":\"77ab2575df5a5829\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/remark-timestamps.js\":\"51fd4e065fbec1ec\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/view.js\":\"0ae43a500724ede3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-link-hints/LinkHints.js\":\"03a973337151f4b9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-link-hints/index.js\":\"32287eaef96aa890\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-link-hints/model.js\":\"e2628f40238ca8a1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-link-hints/settings.js\":\"aaf7a127aa125147\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-normal-mode/actions.js\":\"6cf20e7c21f44390\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-normal-mode/index.js\":\"59766fc7019351bd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-normal-mode/interactions.js\":\"071b52df3a6e300d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/workspace-header/index.js\":\"8c21c0b52c2691cb\",\"/knowledge-medium/pr-preview/pr-1890/src/registerServiceWorker.js\":\"930cc47106d247b8\",\"/knowledge-medium/pr-preview/pr-1890/src/requestPersistentStorage.js\":\"96ea5125396760e7\",\"/knowledge-medium/pr-preview/pr-1890/src/services/authRequestDeadline.js\":\"4886b3c3775a28cc\",\"/knowledge-medium/pr-preview/pr-1890/src/services/authStorage.js\":\"282b2f695c9eac7b\",\"/knowledge-medium/pr-preview/pr-1890/src/services/powersync.js\":\"de8792c2c63da942\",\"/knowledge-medium/pr-preview/pr-1890/src/services/supabase.js\":\"67ba57486e4a201f\",\"/knowledge-medium/pr-preview/pr-1890/src/services/uploadErrorClassifier.js\":\"26d8fbddd16715e5\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/ActiveContexts.js\":\"655ef8fb9b0cf0e5\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/HotkeyReconciler.js\":\"3260851b3b6a89e7\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/WipeLocalDataDialog.js\":\"8064ad5c269bb7e0\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/actionDispatch.js\":\"35fdb5bafd9c558e\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/actionRefItems.js\":\"740798f81e851528\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/applyKeybindingOverrides.js\":\"9596f70b3990afc9\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/blockActions.js\":\"ae7285df7fb75776\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/blockMergeGesture.js\":\"e182ff2fca4f5af7\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/canonicalizeChord.js\":\"e74593564e467c97\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/defaultContexts.js\":\"dbefe9055e6e72b9\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/defaultShortcuts.js\":\"0a4f85b33143c547\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/effectiveActions.js\":\"81ffca6884b4cbd3\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/gestureAction.js\":\"32bef28d86c3c40c\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/gestureBinding.js\":\"d204410ff843f5c9\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/holdRegistry.js\":\"cad36b7f5a58bd56\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/keybindingConflicts.js\":\"54af18bc5c782c07\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/keybindingOverrides.js\":\"f5887c9cb1eee9fb\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/pointerAction.js\":\"47c1c62f65e6a8b0\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/resolve.js\":\"ce021fd499ccb2c6\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/runAction.js\":\"8c6a0a0a94ab0c08\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/sequenceMatcher.js\":\"2833c2f4c6e4f998\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/types.js\":\"8336d585ad590b93\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/useActionContext.js\":\"7de17bb772a8e6a3\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/useActionDiscovery.js\":\"d20e46162bf1bc60\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/utils.js\":\"30160345bcafa37e\",\"/knowledge-medium/pr-preview/pr-1890/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1890/src/sw/bootStore.js\":\"9f9c0486782736de\",\"/knowledge-medium/pr-preview/pr-1890/src/sw/previewDatabases.js\":\"85c1e701168647b6\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/byteTransform.js\":\"e83d0cd3fdcf968d\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/attachmentCleaner.js\":\"45867627db81c774\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/attachmentParts.js\":\"ed224c1d91946026\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/bundleParts.js\":\"085babc454a33853\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/bundleRecord.js\":\"629a010cae6dce2b\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/manifest.js\":\"41f01c24e2e44f76\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/takeBundle.js\":\"f3e63cacce49723a\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/verifyBundle.js\":\"174aa20800b111fe\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/cleaningStage.js\":\"7aefabf8880a07a5\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/conversionKey.js\":\"2bda1fdd27fb2df6\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/conversionServer.js\":\"bc23874551a85825\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/flip.js\":\"f483112cb7568ed1\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/flipAttempts.js\":\"399150e8451e9212\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/pages.js\":\"cedcefbb52f76802\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/preflight.js\":\"3a4255d885e847cc\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/reseal.js\":\"76556e3110db2b3b\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/runConversion.js\":\"23da01c95dfd6153\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/runLock.js\":\"696649e3ca4f46a7\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/sealing.js\":\"048f586188d4518f\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/sealingStage.js\":\"29d636b6134523f8\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/stage.js\":\"ddc656193926a382\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/verifyReseal.js\":\"1c2a4db5a327f78e\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/aad.js\":\"829f818b5ae4dc78\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/aead.js\":\"c7c0c74f84aec948\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/base32.js\":\"ace2cc09e4e2b99c\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/base64url.js\":\"e45ff52bd02e29c4\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/binaryEnvelope.js\":\"3a5ffc33f5a8cb65\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/byteAead.js\":\"0c86db2e4505c99f\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/canary.js\":\"941cb1ea58cb03db\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/contentHash.js\":\"24ffb42bd8e9cede\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/contentKey.js\":\"f6e41140016189f5\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/derivedIdNamespace.js\":\"8fe4b75d4a4a0947\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/envelope.js\":\"ee138e230e72db97\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/hex.js\":\"d7c0c2b0417969a3\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/sha256Hex.js\":\"ddb0365e1bc4a9b4\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/workspaceKey.js\":\"afb3d1b0062414a9\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/conversionState.js\":\"1ede55f591b2d53d\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0e8b811a9eaf55b8\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/flows/pastedKey.js\":\"2f3168b6b35cf44d\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"18c1494384937307\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d27268ab992b1658\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/keyStore.js\":\"8c77bf5bb3d38b55\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/mintWorkspaceKey.js\":\"51bd7b78b76de473\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/modePin.js\":\"010928ab30d974c6\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/openWorkspaceKeys.js\":\"66fe3b201c8ef48b\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/resolveWorkspaceEntry.js\":\"cc61e9c1e0e2b6c0\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/resolver.js\":\"4857c228ff47d6ba\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/workspaceAccess.js\":\"5c86e764cad3fb58\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/transform.js\":\"6ab65804e6fa5387\",\"/knowledge-medium/pr-preview/pr-1890/src/themeBootDefaults.js\":\"93ad3b3dc20c777a\",\"/knowledge-medium/pr-preview/pr-1890/src/types.js\":\"7604bcf814135780\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/ClientLocalSettings.js\":\"ae56ba57b38b0c61\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/abortableSleep.js\":\"95d5d9cb4396a143\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/array.js\":\"020d7c3f6399640d\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/backlinkAutocomplete.js\":\"ea062560332e9e90\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/blockCrumbs.js\":\"d8f11e6739331849\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/blockrefAutocomplete.js\":\"529fab1613167484\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/cadencedIdleJob.js\":\"71bb8d701c1de9f0\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/callbackSet.js\":\"789e6a61091ab5b1\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/clientId.js\":\"d43c415f0b27ee0d\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/codemirror.js\":\"c72dd0ef04ae2610\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/codemirrorCompletion.js\":\"3ca922d312b12739\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/copy.js\":\"23b2542d4999a09d\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dailyPage.js\":\"b777fc5c64f0c4af\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dbForensics.js\":\"c066f90098914ec9\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dbForensicsHooks.js\":\"afd1730a2e7462db\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/deleteBlockThroughUi.js\":\"43d126a2c996192e\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dialogs.js\":\"57e69047561a0498\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dom.js\":\"8bce09f95cecdd77\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/downloadBlob.js\":\"3a6be9d31f32ff36\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/drawnWalk.js\":\"40015cff95b17eb6\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/exportSqliteDb.js\":\"cba72cc95a605f15\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/fileSystemAccess.js\":\"80155991905eac4c\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/flipSlide.js\":\"f743977e499ce22c\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/fnv1a.js\":\"fc7674d0c97f811d\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/formatBytes.js\":\"bd9f736a5c60555c\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/fuzzyRank.js\":\"fb13b7d0a0511a4b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/idbKeyedStore.js\":\"7c4e6ebb4005a5d5\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/idleCallbackPolyfill.js\":\"10be9c914285f6fd\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/keyboardAwareScroll.js\":\"7a4e061bd36e28a2\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/keyboardViewport.js\":\"7a4a5633a5d9507f\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/lastWorkspace.js\":\"4fe0ce355ed5a1a7\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/layoutColumns.js\":\"ce4ea285d4244f70\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/layoutSessionDom.js\":\"c7be7b911a45a3bd\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/layoutSessionId.js\":\"47907fd0e1de86e0\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/linkClickGestures.js\":\"45b3cb05db63f72c\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/linkTargetAutocomplete.js\":\"25a62e86a6b1f24d\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/localDbCorruption.js\":\"1258c57167512df6\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/localDbRecovery.js\":\"3b5cb6f35e700386\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/markdownParser.js\":\"acb2d0f696f494be\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/memoize.js\":\"a642a7537eba07ec\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/nameFieldCommit.js\":\"7403bff5c963455f\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/nameList.js\":\"54ed6f4bbc9e3042\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/navigation.js\":\"03e5a1d0339cd45e\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/omnilinerNamespace.js\":\"67f491976ae0006b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/opfsPageScan.js\":\"b5117d7e6ac38f1d\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelClearance.js\":\"ede7028a7c24babe\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelHistory.js\":\"1890f1d01426e6ea\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelLanes.js\":\"9f2d6c53253d3033\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelLayoutProjection.js\":\"4dfd1d32640008df\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelScrollAnchor.js\":\"98e176a54997c1e2\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelUrlFlags.js\":\"b8f59f5b6d2a1ff0\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/platform.js\":\"cd9452a155a56239\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/pluralize.js\":\"79bbe6ff4f84414b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/propertyCreation.js\":\"cf8832b5fa581a68\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/propertyNavigation.js\":\"26d8121962641d99\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/propertyValueContext.js\":\"8bd51174e3cbb819\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/react.js\":\"e81a84becfe58e4b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/relativeDate.js\":\"b5d44f02d9d92cec\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/relativeTime.js\":\"f9bcb3e4218e2294\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/renderScope.js\":\"0668c9a2f7204892\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/resolvedThenable.js\":\"314e9f6a4ec56265\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/routing.js\":\"369cbf9287155e2f\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/safeMode.js\":\"effb6c5b33c78205\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/scheduleIdle.js\":\"a3f8012784f4aa9c\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/screenWakeLock.js\":\"b36262df95bb52f4\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/selection.js\":\"22ca55c2fb7a29b6\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/softKeyboardGrab.js\":\"d514616f1f9bc1a3\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/startupTimeline.js\":\"218e7088e953c9a6\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/state.js\":\"0a39e8e21f538521\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/string.js\":\"dcf5521c6d233fc9\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/surfaceZoom.js\":\"a8292f4086214867\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/time.js\":\"19c7c3c06ec7b1a6\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/toast.js\":\"3c0a371b09d05ea2\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/toggleStore.js\":\"76de7c92abc935de\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/untilStopped.js\":\"005b49965a2ca7f8\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/userActivity.js\":\"976de079d366eaba\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/viewTransition.js\":\"8b41a7985b7a4026\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/viewport.js\":\"785372e6ed98b98b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/webLock.js\":\"18ebe59058a63402\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/workspaceRecovery.js\":\"b62a11a36c14d0e6\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/workspaceSnapshotStore.js\":\"95d013ec63ac882b\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-compiler-runtime.js\":\"0883f7641dee75ab\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-client.js\":\"124fcf56beb98694\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-server-edge.js\":\"da2eaa86d289647e\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-server.js\":\"d122b170a70f37a4\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-static-edge.js\":\"5dc3e3438a6a6f66\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-static.js\":\"0b7b56bf587af8b0\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-test-utils.js\":\"8ea8676cbb697e16\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom.js\":\"1af349268b4a3527\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-jsx-runtime.js\":\"69f77319d17cd59e\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react.js\":\"288e2a9e03ed7c84\",\"/knowledge-medium/pr-preview/pr-1890/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1890/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1890/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
