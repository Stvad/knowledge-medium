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
		buildId: "c3a5d27dd86c-16c91cc1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1890/\":\"735cc12d57eb0303\",\"/knowledge-medium/pr-preview/pr-1890/index.html\":\"735cc12d57eb0303\",\"/knowledge-medium/pr-preview/pr-1890/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1890/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1890/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1890/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1890/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1890/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1890/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1890/assets/FacadeVFS-CWWVJXBa.js\":\"8d22608ce174875b\",\"/knowledge-medium/pr-preview/pr-1890/assets/OPFSCoopSyncVFS-B1JuhnS4.js\":\"34df7982aad43199\",\"/knowledge-medium/pr-preview/pr-1890/assets/OPFSWriteAheadVFS-BGeanTw8.js\":\"73091d69ef5d86e2\",\"/knowledge-medium/pr-preview/pr-1890/assets/wa-sqlite-CFlJlckp.js\":\"78b22fb4bf7526e0\",\"/knowledge-medium/pr-preview/pr-1890/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1890/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1890/assets/wa-sqlite-async-D-vR5WaQ.js\":\"4185d891b688cddc\",\"/knowledge-medium/pr-preview/pr-1890/assets/worker-DFKYeJQS.js\":\"8dbd9e10bc17fe7b\",\"/knowledge-medium/pr-preview/pr-1890/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1890/chunks/app-CRxnbHRN.js\":\"fc11d60b3f9c0411\",\"/knowledge-medium/pr-preview/pr-1890/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1890/index.js\":\"3adedd8c91c1f977\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1890/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1890/assets/AccessHandlePoolVFS-BlHOFuZs.js\":\"764d7097609bb87e\",\"/knowledge-medium/pr-preview/pr-1890/assets/IDBBatchAtomicVFS-BPGb0TGh.js\":\"384835a5cee09069\",\"/knowledge-medium/pr-preview/pr-1890/assets/MemoryVFS-st-3oyFN.js\":\"76f7ad554bb15018\",\"/knowledge-medium/pr-preview/pr-1890/assets/mc-wa-sqlite-C-QrkzwZ.js\":\"3a3b38f23f71ecb5\",\"/knowledge-medium/pr-preview/pr-1890/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1890/assets/mc-wa-sqlite-async-DRWw4dli.js\":\"07a7833b35fbe5c3\",\"/knowledge-medium/pr-preview/pr-1890/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1890/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1890/chunks/AccessHandlePoolVFS-Cp2D5g3D.js\":\"2caba1001679460d\",\"/knowledge-medium/pr-preview/pr-1890/chunks/FacadeVFS-D2WJ8Jy5.js\":\"e6f059b8c1898367\",\"/knowledge-medium/pr-preview/pr-1890/chunks/IDBBatchAtomicVFS-CNOX9l_Q.js\":\"e45b09e630fc55b1\",\"/knowledge-medium/pr-preview/pr-1890/chunks/MemoryVFS-CjeuxuXj.js\":\"64bf34e4158a37bb\",\"/knowledge-medium/pr-preview/pr-1890/chunks/OPFSCoopSyncVFS-BQrn1AaH.js\":\"bb06d033a07bf2a5\",\"/knowledge-medium/pr-preview/pr-1890/chunks/OPFSWriteAheadVFS-G0dqlbz8.js\":\"8d908b483567c421\",\"/knowledge-medium/pr-preview/pr-1890/chunks/Preview-sTJeusqu.js\":\"ea9c41f061ee80a3\",\"/knowledge-medium/pr-preview/pr-1890/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1890/chunks/card-Dpcf_X5_.js\":\"f5136534a2ce9923\",\"/knowledge-medium/pr-preview/pr-1890/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1890/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1890/chunks/dist-Buq0imtU.js\":\"0377f83770962b34\",\"/knowledge-medium/pr-preview/pr-1890/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1890/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1890/chunks/mc-wa-sqlite-CViA4Rwh.js\":\"d16622f999d64e42\",\"/knowledge-medium/pr-preview/pr-1890/chunks/mc-wa-sqlite-async-DyTCBSIC.js\":\"6767b9b6921fce23\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-B5xv9du6.js\":\"065f7b81c5a7f79b\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-B8fhQDex.js\":\"7b01ad75d18d588f\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-BBxWfWU8.js\":\"c06c8e7796f854d0\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-BKGIhNrm.js\":\"86e1bb907d1ce8f2\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-CJ4zPL5V.js\":\"8c5fad40ea92195b\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-D-4jkcYR.js\":\"fede5d4d7847201b\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-DkY-BhwB.js\":\"6c3f6f61780fef2b\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-GX8ZExY-.js\":\"357da52ad646f787\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-dom-server-legacy.browser.production-DXscZhR3.js\":\"8d36bfe2aa941760\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-dom-server.browser.production-DQ2m8jnR.js\":\"1bf059d4ae720bbb\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-dom-server.edge.production-DK8cNROV.js\":\"5725a57894847d6c\",\"/knowledge-medium/pr-preview/pr-1890/chunks/server.browser-BUOz51g-.js\":\"9b2cb18b0957dd3d\",\"/knowledge-medium/pr-preview/pr-1890/chunks/textarea-BTUX3X8I.js\":\"239365120afb50ed\",\"/knowledge-medium/pr-preview/pr-1890/chunks/ui-C9p9ZycS.js\":\"abd2cd12a5e14bc7\",\"/knowledge-medium/pr-preview/pr-1890/chunks/wa-sqlite-CgMEm8nV.js\":\"88c99187c826c1e4\",\"/knowledge-medium/pr-preview/pr-1890/chunks/wa-sqlite-async-C0DbaxPK.js\":\"c81d14c064849915\",\"/knowledge-medium/pr-preview/pr-1890/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1890/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1890/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1890/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1890/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1890/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1890/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1890/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1890/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1890/src/App.js\":\"fa7ef12627087032\",\"/knowledge-medium/pr-preview/pr-1890/src/appUpdate.js\":\"5eed0dd1ac3fbf3f\",\"/knowledge-medium/pr-preview/pr-1890/src/appVersion.js\":\"61ee85d589ec6d2d\",\"/knowledge-medium/pr-preview/pr-1890/src/bootstrap/initialLayout.js\":\"e800112a4d4610c3\",\"/knowledge-medium/pr-preview/pr-1890/src/bootstrap/openWorkspaceData.js\":\"873007575776cfa9\",\"/knowledge-medium/pr-preview/pr-1890/src/bootstrap/resolveWorkspace.js\":\"236de4295d019f5f\",\"/knowledge-medium/pr-preview/pr-1890/src/bootstrap/workspaceBootstrap.js\":\"70bcce9edd579422\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockComponent.js\":\"e324dd693cd89690\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockCrumbs.js\":\"da46500d0c66da15\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockEditor.js\":\"0adff1c886c13909\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockLoadingPlaceholder.js\":\"6603a3444947e6b4\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockProperties.js\":\"cb7566db8534991a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockSearchPicker.js\":\"2e1f6a2d682b8d97\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ConfirmBulkDeleteDialog.js\":\"60e79717419ffb09\",\"/knowledge-medium/pr-preview/pr-1890/src/components/DividerHandle.js\":\"e7f0cd1006491cf2\",\"/knowledge-medium/pr-preview/pr-1890/src/components/DraftEditor.js\":\"1efb447e4c8e3bca\",\"/knowledge-medium/pr-preview/pr-1890/src/components/GutterPill.js\":\"afe96c5ad7863a98\",\"/knowledge-medium/pr-preview/pr-1890/src/components/Header.js\":\"d85caa2fdf46849c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/LazyBlockComponent.js\":\"4b0afc0761148e7b\",\"/knowledge-medium/pr-preview/pr-1890/src/components/Login.js\":\"42f7b5ca66b4fcf3\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ZoomableSurface.js\":\"5b3b45a319d3218e\",\"/knowledge-medium/pr-preview/pr-1890/src/components/editModeKeepalive.js\":\"84e69687d0644544\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyDisplay/PropertyDisplayScope.js\":\"5dd194bcaabee9b0\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3602f55f9140f5dc\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/RefPropertyEditor.js\":\"ea28ffe7b5c1c4b0\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/RefTargetTypePicker.js\":\"5ffe2fb413d0105c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/SelectPropertyEditor.js\":\"091c51ca7daef516\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/TypesPropertyEditor.js\":\"94d4813146ea4008\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/defaults.js\":\"5ff2126a5b9cb409\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/kernelValuePresets.js\":\"cc01cd5f466577c8\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/selectablePresets.js\":\"ef3a9dc873cb4e08\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/typesPropertyUi.js\":\"30d7ad12bdd77a34\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/AddPropertyForm.js\":\"0c9feb62564182cf\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/PropertyPicker.js\":\"d0735332f1c9d2d5\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/PropertyRow.js\":\"fff072144f772073\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/Rows.js\":\"a7ca8881d3032485\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/actions.js\":\"15925c9caaf40c12\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/declarationOnly.js\":\"2ace0b1c470d7714\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/layout.js\":\"73a7e6214e6cd45b\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/model.js\":\"75465aef3608571d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/shapeUi.js\":\"78c161500c888659\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/shapes.js\":\"894380a3787bf29e\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/usePropertyEditingActivation.js\":\"7eb7af52e54a5e90\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/visibility.js\":\"c5fde37dbf23307a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanelSections.js\":\"d3a087d99ca84624\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/BlockEmbed.js\":\"d89960e7e0af1dc8\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/BlockLink.js\":\"32c0ae0a7c599cc7\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/BlockRef.js\":\"a3e0199ca694f87a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/CompactReferenceLink.js\":\"1ca15e93c9844fc3\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/ReferenceLink.js\":\"107d0cce062b7ff1\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/cycleGuard.js\":\"fa1e20f10f2c6b02\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/cycleGuardContext.js\":\"18de231baec79c40\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/linkInteraction.js\":\"c2250ab96b8f320e\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/referenceLayout.js\":\"f5bc983aca81cb3b\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/useBlockRefAncestors.js\":\"d24c305d39ee84db\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BlockGutter.js\":\"d9675dfea53067b0\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BlockInfoDialog.js\":\"d7cb28ea09fbe2b4\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BlockReadText.js\":\"29e66e4e9a97ff1e\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BlockTypeBlockRenderer.js\":\"647a0b7c467fdcc1\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BulletHoverCard.js\":\"4cc0330ec9bf6eab\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/CodeMirrorContentRenderer.js\":\"bbadd51dcffcf58c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7e2813a6b7317071\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/ColumnResizeHandles.js\":\"fb8312bd22639833\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a89d264f70fddf73\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/DefaultBlockRenderer.js\":\"29ff271c1ab0ff13\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/LayoutRenderer.js\":\"4276e8c263b71a2d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/MarkdownContentRenderer.js\":\"e3a61ba39cb6190b\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/MissingDataRenderer.js\":\"f828db5fe47bd1d2\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/PanelRenderer.js\":\"c17e1ed5e4e5c6f8\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/PropertySchemaBlockRenderer.js\":\"435940b38f85e71b\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/TopLevelRenderer.js\":\"8f4a9c2bf9e88c00\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/blockGutterMode.js\":\"1b5eff4d04b23e6f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/blockTitleText.js\":\"a8b44e7dc6bb60e9\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/fieldCreationKeydown.js\":\"aececcb2d55c14fb\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/layoutRootContext.js\":\"1298e4f5496cafbf\",\"/knowledge-medium/pr-preview/pr-1890/src/components/typeChip/TypeChip.js\":\"d53366dbda5a318c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/typeChip/chipStyle.js\":\"05e1dfa8c6a2dced\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/anchored-floating.js\":\"ef43dc850b47d3fd\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/button.js\":\"d7b9bd6b550fd6e8\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/card.js\":\"e15d3d6c49d91476\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/checkbox.js\":\"3ca8e420cd91ffeb\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/collapsible.js\":\"f01f665c82ed8766\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/command.js\":\"13e8e95a072b91df\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/context-menu.js\":\"4ea4b1f587e7800e\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/dialog.js\":\"d7fccf1a01b1d9b4\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/dropdown-menu.js\":\"7ef9d97b4b1f32cc\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/floating-listbox.js\":\"51763c125aaca6c3\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/index.js\":\"7a4756b851b0af1c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/input.js\":\"4c83dc21a8276095\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/kbd.js\":\"445ca404b7924673\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/label.js\":\"ffcc5ed09d59b478\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/textarea.js\":\"685ea7b32f6f516d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/useEditModeYieldKeepalive.js\":\"583ebe929dac2577\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/BootFallback.js\":\"813b7ce82a21f056\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/FocusedRowLazyMount.js\":\"63833ed0d994c396\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/LazyViewportMount.js\":\"b1cfbaeba707966a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/LocalDbCorruptionFallback.js\":\"4a0f8fd54e569199\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/error.js\":\"5314b1b8ec7edc5b\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/lazyMountRegistry.js\":\"28915383a7857c4d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/suspense.js\":\"af93f7ef0c3952d5\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/CreateWorkspaceDialog.js\":\"2bafad1bf07e0bae\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/PendingInvitations.js\":\"abd133755d63e7a4\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/SyncProgress.js\":\"307197a2f8844517\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/UnlockProgress.js\":\"33c73101c82f112e\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/WorkspaceKeyGate.js\":\"6f74fb4862ca2c40\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/WorkspaceSettingsDialog.js\":\"e5a96bf894e685d0\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/WorkspaceSwitcher.js\":\"a5bdd5a05fc64a58\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/WorkspaceSyncGate.js\":\"54fb983677bc333e\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/ConversionFlow.js\":\"76a8b998692cf3e3\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/ConversionFlowHost.js\":\"0575cf9f8ad766e9\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/EncryptionSection.js\":\"174f5310e61397e5\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/attachmentPrompts.js\":\"c408026b0ac16eb7\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/bundleFolderPrompts.js\":\"006838ca1b5ac2d6\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/conversionFlowDeps.js\":\"5adee76d4ac6baae\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/conversionFlowStore.js\":\"50a009d9a088e9d2\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/flowUi.js\":\"830a9c8e53e7b93d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/useConversionRun.js\":\"79669d28f1ba84c4\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/keyUi.js\":\"a7b051f125f2c99c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/useCloseOnKeyLoss.js\":\"a81486fc1a19036a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/useCloseOnServerE2ee.js\":\"3352d4aec03a7ec3\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/workspaceUnlocked.js\":\"36c11eaa59ddf137\",\"/knowledge-medium/pr-preview/pr-1890/src/context/backgroundSubtree.js\":\"ffc4a4a491626f34\",\"/knowledge-medium/pr-preview/pr-1890/src/context/block.js\":\"dbad90fb7e2f43b2\",\"/knowledge-medium/pr-preview/pr-1890/src/context/layoutWsContext.js\":\"679044e0105d4de3\",\"/knowledge-medium/pr-preview/pr-1890/src/context/propertyDisplay.js\":\"b644adb8b644beb3\",\"/knowledge-medium/pr-preview/pr-1890/src/context/repo.js\":\"c6348993c0ce76aa\",\"/knowledge-medium/pr-preview/pr-1890/src/data/aliasClaim.js\":\"bbe30c8615dc9efb\",\"/knowledge-medium/pr-preview/pr-1890/src/data/aliasSeatNamespace.js\":\"799f66dba75cd7cf\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/blockData.js\":\"4f23e305261a98ac\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/blockType.js\":\"8889cf8d172e6919\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/changeScope.js\":\"8d6ff2fed348c6a5\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/codecs.js\":\"108c990fbf13cb52\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/derivedData.js\":\"603ea7faa084dfc9\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/errors.js\":\"dfd70ce71ecd58b6\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/events.js\":\"f3431aff4888fe4d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/handle.js\":\"a0d1bee8a80b2bec\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/index.js\":\"39ee760bbe2f8a89\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/mutator.js\":\"1364be850370eb3a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/processor.js\":\"79a5dd556730ec33\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/propertySchema.js\":\"c1524d37a60ccbf0\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/query.js\":\"0e05401356d276ed\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/sameTxProcessor.js\":\"48714334bb0a5c11\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/schema.js\":\"a0d1bee8a80b2bec\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/tx.js\":\"a0d1bee8a80b2bec\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/typedBlockQuery.js\":\"737f2303c38f4d31\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/user.js\":\"f3bc0aaba4959b3d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/valuePresetCore.js\":\"95a079f8362e5a1f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/valuePresets.js\":\"ab67622a7386cf40\",\"/knowledge-medium/pr-preview/pr-1890/src/data/attachmentCleanerIOVerb.js\":\"f3a4e99864381a3b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/block.js\":\"ccfda9f0d3742d07\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockCache.js\":\"7b88bacb0e37c212\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockId.js\":\"c77c0742b5677ef2\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockLiveness.js\":\"bf4edf570875378e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockMerge.js\":\"152e58a953272e02\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockSchema.js\":\"c9470d3da397d73b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockTypeLookup.js\":\"ce5e3152cad8c210\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockTypes.js\":\"80ffd4308ce48b5b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/childrenView.js\":\"89d154cfab90646a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/clientContext.js\":\"0163eff0da826bd2\",\"/knowledge-medium/pr-preview/pr-1890/src/data/dbFileSiblings.js\":\"f678783b76084a88\",\"/knowledge-medium/pr-preview/pr-1890/src/data/definitionSeeds.js\":\"f99f1f8b043bff91\",\"/knowledge-medium/pr-preview/pr-1890/src/data/derivedIds.js\":\"e2eb9849972ab670\",\"/knowledge-medium/pr-preview/pr-1890/src/data/drawnSubtree.js\":\"294363ec2179f25b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/facetBridge.js\":\"a63b11cc859d2f65\",\"/knowledge-medium/pr-preview/pr-1890/src/data/facets.js\":\"b2302a9889cd9d96\",\"/knowledge-medium/pr-preview/pr-1890/src/data/globalState.js\":\"501f75b43068d89a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/aliasClaimRederiveProcessor.js\":\"f75c19f3454a54c5\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/ancestorBatch.js\":\"97b74d42ba795043\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/blockTypeTypeifyProcessor.js\":\"134b17030a20896d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/clientSchema.js\":\"00be892230dc1c09\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/commitPipeline.js\":\"d8cca2e94a1f491d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/devAssertions.js\":\"4722be8b883298f4\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/firstSync.js\":\"0b2a986ef8f5ad10\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/freshInitialLoad.js\":\"f93394e49e0afea3\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/graphBackfillClaim.js\":\"65f555c3b007d770\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/handleStore.js\":\"05ab50ce0f457c43\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/idleMarkerJobs.js\":\"e5e8fb17b63e82cd\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/initialDownload.js\":\"c29f1ca7a12f098d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/initializeClientDatabase.js\":\"30006541c69e5bdc\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/jsonCanonical.js\":\"fb8f89aa928a3816\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/kernelInvalidation.js\":\"59ee0b6d57211105\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/kernelProcessors.js\":\"2ccdfa92150b9378\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/kernelQueries.js\":\"3bb440d4d82cf87c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/mergeTypeMembershipProcessor.js\":\"3d9321d66b89438e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/normalizeReferencesProcessor.js\":\"631d086cdb7c9262\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/poolInstrumentation.js\":\"b4348880bd2104a0\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/processorRunner.js\":\"cda92c52c8455df9\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyCellBackfill.js\":\"43d0c02301623534\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyChildMint.js\":\"f31f7ee693f92822\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyChildrenProcessor.js\":\"e243b7a3801f30f5\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3c6685c4b1a08c70\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyDefinitionSynthesis.js\":\"83be6ea60a2127a8\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyKeyScan.js\":\"f5c4495d13cd6ebb\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertySchemaResolution.js\":\"4e70daa01d45d957\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyValueEdits.js\":\"0885ca7a792aa147\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/raiseProtocol.js\":\"144850f89c99fe6b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/readBatch.js\":\"cc9f690b9f2f8593\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/refProjection.js\":\"2c28f57315636d7e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/referenceTargetLookups.js\":\"bdff458f40f28817\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/referenceTargetProcessor.js\":\"8850dfb97eddf089\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/replayMerge.js\":\"d238e197181b98df\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/sqlBinds.js\":\"5a13655cb76a9b79\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"125c665ab59fc178\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/arrivalProcessors.js\":\"62f0fdde020fba6e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/invalidate.js\":\"fe2a701913bf4abe\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/materialize.js\":\"a0b6d320d48aa348\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/observer.js\":\"8703b0b701a1f0eb\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/reconcile.js\":\"411a633224c56b86\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/timingMetrics.js\":\"209743bff3774ccf\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/treeQueries.js\":\"53ad9c49438fa353\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/txEngine.js\":\"1f33c62fcd22d60e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/txSnapshots.js\":\"d7a789cb790f4e99\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/typedBlockQuery.js\":\"90a0d8256c279d0d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/undoManager.js\":\"13f5d79671ef7805\",\"/knowledge-medium/pr-preview/pr-1890/src/data/invalidation.js\":\"76a2caac9752b2c8\",\"/knowledge-medium/pr-preview/pr-1890/src/data/kernelDataExtension.js\":\"b712c91ff99fb4a4\",\"/knowledge-medium/pr-preview/pr-1890/src/data/kernelPage.js\":\"976a8ecacff73b8b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/kernelValuePresetCores.js\":\"cc42a9213fb8ab11\",\"/knowledge-medium/pr-preview/pr-1890/src/data/localDbCorruptionSignal.js\":\"586fcf9b7338e97d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/localDbStorage.js\":\"4ea95976c1eb4429\",\"/knowledge-medium/pr-preview/pr-1890/src/data/localDbVfs.js\":\"a1b6ac62289a65d8\",\"/knowledge-medium/pr-preview/pr-1890/src/data/localSchema.js\":\"d40a06636b70d62f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/maintenance.js\":\"0c5faca3113b21e4\",\"/knowledge-medium/pr-preview/pr-1890/src/data/mergeProperties.js\":\"ca259157af21cacc\",\"/knowledge-medium/pr-preview/pr-1890/src/data/metricsConsoleHook.js\":\"515ef5db4d5a1c96\",\"/knowledge-medium/pr-preview/pr-1890/src/data/migrationsPage.js\":\"5aefe19dc8de0709\",\"/knowledge-medium/pr-preview/pr-1890/src/data/mutators.js\":\"980d6bf0b2b6cfaa\",\"/knowledge-medium/pr-preview/pr-1890/src/data/orderKey.js\":\"1d64017869325703\",\"/knowledge-medium/pr-preview/pr-1890/src/data/orderKeyPlacement.js\":\"43495a0ba62788f5\",\"/knowledge-medium/pr-preview/pr-1890/src/data/outlineSurface.js\":\"92c90c92d88dbee0\",\"/knowledge-medium/pr-preview/pr-1890/src/data/pendingEditorContent.js\":\"6d1f407d6054b764\",\"/knowledge-medium/pr-preview/pr-1890/src/data/pendingUploadsSql.js\":\"1b620e32072e1728\",\"/knowledge-medium/pr-preview/pr-1890/src/data/pluginStateExtensions.js\":\"e5ab0860f2bb3aff\",\"/knowledge-medium/pr-preview/pr-1890/src/data/powerSyncLogger.js\":\"0bdff36feaead184\",\"/knowledge-medium/pr-preview/pr-1890/src/data/projectorRuntime.js\":\"3da55c14dfde2d64\",\"/knowledge-medium/pr-preview/pr-1890/src/data/properties.js\":\"6cf4313362748c80\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertiesPage.js\":\"7cc9006435eb87ca\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyChildren.js\":\"a40ca112a91bad78\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyDefinitionFanout.js\":\"6dfd067f79f2f3e0\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyDefinitionMetadata.js\":\"429d6ce3e32ad7db\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyDefinitionRegistry.js\":\"8df86524ad099ef0\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyDisplayMode.js\":\"f92a5029099becc1\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyRowCreation.js\":\"034c5fd1ea64b1e2\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertySchemaCreation.js\":\"aa49c616ea4881a5\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertySeeds.js\":\"91c309b11845b164\",\"/knowledge-medium/pr-preview/pr-1890/src/data/recentsPage.js\":\"3e5381cda3f311a5\",\"/knowledge-medium/pr-preview/pr-1890/src/data/refTargetComparableProperty.js\":\"656d351e0471d6a5\",\"/knowledge-medium/pr-preview/pr-1890/src/data/referenceBlock.js\":\"da6f966c783e648b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/rejectedUploads.js\":\"a4e85334e504e9c0\",\"/knowledge-medium/pr-preview/pr-1890/src/data/releasePowerSyncConnection.js\":\"e6ee4b9c539b710c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/repo.js\":\"53fa8dfac2496326\",\"/knowledge-medium/pr-preview/pr-1890/src/data/repoProvider.js\":\"b88930e5c257f9f6\",\"/knowledge-medium/pr-preview/pr-1890/src/data/rowProperty.js\":\"4365161c1ba4834d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/searchFilter.js\":\"bd6c1a037fb114bc\",\"/knowledge-medium/pr-preview/pr-1890/src/data/seedIdentityLedger.js\":\"eff8760fa4dea936\",\"/knowledge-medium/pr-preview/pr-1890/src/data/stateBlocks.js\":\"68914cf7d4011d5a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/structuralEditPolicy.js\":\"ac20b159b467b0c9\",\"/knowledge-medium/pr-preview/pr-1890/src/data/structuralInsert.js\":\"f78bf929971faa5e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/subtreeDelete.js\":\"8ef54375f6763373\",\"/knowledge-medium/pr-preview/pr-1890/src/data/syncStreamLock.js\":\"fafbc92d98a1740c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/syncedTableSqlRecognizer.js\":\"dd577f7715cda0ad\",\"/knowledge-medium/pr-preview/pr-1890/src/data/syncedTableWriteGuard.js\":\"c5a4cd03c633d00d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/targets.js\":\"b1e47b646b7a614b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeColors.js\":\"ed0427ea9e5351b7\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeDefinitionMetadata.js\":\"d1e1384048b3209f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeDefinitionRegistry.js\":\"d277ae944eda6842\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeExtraction.js\":\"ab288611b432c5a6\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeInitialValues.js\":\"5775bf9b2243c27e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typePropertyGroups.js\":\"8b7b3fcb31ecc51e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeSeeds.js\":\"361769733c2106aa\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeTagger.js\":\"512798e0f59dc294\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typedRecords.js\":\"06f6750fa6a70692\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typesPage.js\":\"6a1a28bca5c7d38e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/userPrefs.js\":\"eeb7eadf6690cda3\",\"/knowledge-medium/pr-preview/pr-1890/src/data/userSchemasService.js\":\"35468cd34154df7e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/userTypesService.js\":\"379121cec47ab603\",\"/knowledge-medium/pr-preview/pr-1890/src/data/valuePresetRegistry.js\":\"9f8658f88f1b9e55\",\"/knowledge-medium/pr-preview/pr-1890/src/data/visibleChildren.js\":\"71d83a525f83b76f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaceConversion.js\":\"c273d667d887067b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaceFirstSync.js\":\"26968f022b917ac0\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaceIdNamespace.js\":\"a4a545ef780adc81\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaceSchema.js\":\"dcbb1f953b04c89c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaces.js\":\"d6d3f8db25ad06be\",\"/knowledge-medium/pr-preview/pr-1890/src/data/writeAheadLog.js\":\"090a14e68207a69a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/BlockPasteShellDecorator.js\":\"16c60a5aca8c54bd\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/atTrigger.js\":\"c7f698a5ca968bd1\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/autocomplete.js\":\"0e65d4b35bf38f76\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/codeMirrorExtensions.js\":\"3d3a55f62adf59b6\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/contentFlush.js\":\"c3716719602df2a3\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/defaultInteractions.js\":\"3c5187decf14286c\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/editSettleSignal.js\":\"3175a32cabef6eea\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/insertImage.js\":\"204f9730051160a5\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/referenceCompletionRange.js\":\"f4fce35b104340bb\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/referenceTargetTypes.js\":\"1047ea7c57c296f0\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/syntaxContext.js\":\"65e72cbeba1612ea\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/triggerMatch.js\":\"dfafd46da6330bad\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/AppRuntimeProvider.js\":\"a76cb0b1d1109a9f\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/BlockFocusShellDecorator.js\":\"d3d7f8b328796c8c\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/ExtensionRenderBoundary.js\":\"b6ed343e32b2b73b\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/PanelContentRecovery.js\":\"a356be10fb06dfd8\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/apiCatalog.js\":\"4aa511feef1b48ad\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/approveExtensionHere.js\":\"806a788601de521c\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/armedCutAppMount.js\":\"c11c2b3e8dd102f4\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/batchableKeyedStore.js\":\"08e8d220fcc87a56\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/blockInteraction.js\":\"c01b14f8c69346ee\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/blockSelectionAction.js\":\"c8da86460a622cb3\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/compileExtensionModule.js\":\"6ffe0d872094f666\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/compiledModuleCache.js\":\"d56d74891ad66e87\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/continuousGestures.js\":\"549c196f44f827dd\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/core.js\":\"179d3fc8a1d4efff\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/defaultRenderers.js\":\"abb0a911070c0d2d\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/definitionFanoutAppMount.js\":\"6607dfc7e0d6a65a\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/dialogAppMount.js\":\"4bea454d65d7c234\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/dynamicExtensionSeeds.js\":\"49b79d68ac8a9f19\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/dynamicExtensions.js\":\"d6e5cbccbcc9738c\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/exampleExtensions.js\":\"850ce47f06ef5339\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionApprovalStatus.js\":\"9546e321e2f67d41\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionLoadErrorToast.js\":\"f3894cf22776b724\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionLoadErrors.js\":\"9ba924e78a82670b\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionLookup.js\":\"884c0978fc4fc568\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionToggles.js\":\"341d4956887a6b8a\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionUtilitiesCss.js\":\"6baea2db7f8132cd\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/kernelPageDeletionGuard.js\":\"5422838ff821da44\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/liveRuntime.js\":\"245650de4cdff7ee\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/openExtensionsSettings.js\":\"15ef0fc6f3c8c8ff\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/overridesCache.js\":\"ba6e8330ef49e22c\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/pluginIds.js\":\"ec131f6de3850ec4\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/processorRejectionToast.js\":\"fa31719f9617d296\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/runtimeActions.js\":\"cf17efca91bc4468\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/runtimeContext.js\":\"8315179ce92fc238\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/staticAppExtensions.js\":\"1e6a2a18e0775d41\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/staticDataExtensions.js\":\"60a19db12bd4ca14\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/toastAppMount.js\":\"2e219e648e25934c\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/useOverrides.js\":\"94a1e8bac6da92ed\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/useShortcutSurfaceActivations.js\":\"637a540d7a93b194\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/discoverToggleTree.js\":\"ba62bb26cfbc1d27\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/facet.js\":\"c567270c1e8d7c1c\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/resolveAppRuntime.js\":\"ecfd185f47c24914\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/runtimeEvents.js\":\"0d74f4b6c9c9fa8a\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/togglable.js\":\"f89c7a444493afdf\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/variantFacet.js\":\"bc6f93a3dead462e\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/verbFacet.js\":\"140cba5d1add6598\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/block.js\":\"108bfc987c7c3e59\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/focusedChild.js\":\"2ac44611d9f0dd49\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/propertySchemas.js\":\"9adc6a8ad0ffd721\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/typeRegistry.js\":\"56770a42d888fc8c\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useAncestorCrumbs.js\":\"9e45e6d6004a52ce\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useAutocompleteListbox.js\":\"4af116f75e55501c\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useDebouncedSearch.js\":\"3f25dfe6de62eb5a\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useDebouncedValue.js\":\"3cbfe5d42439e6c0\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useFacetValue.js\":\"75a165ce6ff9d7e9\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useIsFocalRender.js\":\"9ce56d114d9a4076\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useIsReadOnly.js\":\"4e9f1a2e8809bed7\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useMaterializeBacklog.js\":\"319b9bc0cbb51e2b\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useMinuteClock.js\":\"2533f4e7e877413c\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/usePanelLayoutProjection.js\":\"9e8a5981e95f6260\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/usePendingInvitations.js\":\"1f021b0ddc4b2e4d\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useRendererRegistry.js\":\"439acbf1240a9b5a\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useRetainedFieldRows.js\":\"6cefb6f0a3b993bd\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useWorkspaces.js\":\"09a00d173d974a12\",\"/knowledge-medium/pr-preview/pr-1890/src/lib/utils.js\":\"908e880c19dbbb4e\",\"/knowledge-medium/pr-preview/pr-1890/src/main.js\":\"cf0b71aa8c14ff05\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/MarkdownImage.js\":\"c1bcd3f297d73321\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/blockSeparators.js\":\"889cb254bbd434e1\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/context.js\":\"41ea00c23f2190fd\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/defaultMarkdownExtension.js\":\"f3b920a37b59ab59\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/extensions.js\":\"5740826f8ab77110\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/renderMarkdownHtml.js\":\"464cffa4db373180\",\"/knowledge-medium/pr-preview/pr-1890/src/minimal-editor.js\":\"89b48f71bf3ee1f4\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/armedCut.js\":\"9e001c5e727a8f10\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/captureMediaVerb.js\":\"453180ba73f2a27c\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/clipboard.js\":\"97b26b335577bdc0\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/decision.js\":\"440f6080ad75ca9d\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/operations.js\":\"260b4c649608c41f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/account-header/AccountHeaderItem.js\":\"85efb6afef158b75\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/account-header/index.js\":\"9f47b864aec9edd3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"74f4739ed1082755\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/askAgent.js\":\"a4d1d4bbe3ab8469\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/askedStore.js\":\"5f7ac50c6e930b41\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"2c798b20b9530a14\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/chipState.js\":\"41ead107be97deeb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ec764e4c4ebef455\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/index.js\":\"3b093f2a41920867\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"ad6f1e4d94a6d78c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/schema.js\":\"812caac86e4f1849\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a5fb8e207c5bb6f0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5a464f88ce87c384\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/addMedia.js\":\"67ce236703bc9b91\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/backlinks.js\":\"3f478764b0b3f363\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/block.js\":\"d2b7a699d87a3f08\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/context.js\":\"9ad39331890ba83d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/displayIds.js\":\"31fbce71dda30a2f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/index.js\":\"4e35170438aa1bf9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/outline.js\":\"d6a5c5c7a5221a6a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/properties.js\":\"6a27ecabdebee0e6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/refs.js\":\"7bcc77a12717183e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"eb4610fdbd8d63c7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/search.js\":\"e98888c6f4865830\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/shared.js\":\"3c04fa2d3424f3d6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d6a16af69c84c73e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/text.js\":\"6445fac27451f257\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentWrites.js\":\"ec73b4758724da84\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/authoringCatalog.js\":\"2535e0ccf8a8b68f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/blockRefTargets.js\":\"51d211319ff1cb9c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/bridge.js\":\"356cf4e5bdd08af3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/bridgeLoop.js\":\"4249c327a86a4f15\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/changeHistory.js\":\"898fa47a9d4a8966\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/commands.js\":\"b62cb11218f2d7db\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/commentsCommands.js\":\"281291f73eda6a5f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/dataExtension.js\":\"3dbc3f7a4157b86b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/dataModelGuide.js\":\"36401983396a477e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/dayPropertyInputs.js\":\"c85cd02b6e942097\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/describeRuntime.js\":\"3e3c2911d8eaa52d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/extensionLint.js\":\"a4819b8767f211a6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/grainAudit.js\":\"59c64cc68f9697ef\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/healthCommand.js\":\"d957276aadfba725\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/index.js\":\"acbc6c6650d19f3a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/presetIdentity.js\":\"17ead43d6c0f5e3d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2ef4af4ec2e7ed79\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/readMedia.js\":\"f281a183e31a160a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/schema.js\":\"af1cd381cef3b5f4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/serialization.js\":\"adbd18cdf44fda12\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/targets.js\":\"1effdae434d37d98\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/tokens.js\":\"38b5a020b99f38bd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/watchEvents.js\":\"9d9662a508dfb4e8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/workspaceGuard.js\":\"3f26f5858099cee2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/writeCommands.js\":\"09c31143727c24b6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/AliasCollisionToast.js\":\"4e8f9a10f4b10054\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/DuplicateNameBanner.js\":\"d54870589bd8c180\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/collisionMerge.js\":\"00bc3ad285b6fc07\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/dataExtension.js\":\"0cdbb332f51bf688\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/index.js\":\"1f50986223ccc49a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/mergeCollisionAction.js\":\"d9d5b6ab24f735dc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/pageStyling.js\":\"dd818ade5539d4ea\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/rejectionToast.js\":\"96df6e730296c215\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/syncProcessor.js\":\"1d3dd8fd5e00248a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/actions.js\":\"2a17b954ac53912d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/addComment.js\":\"1c9ad19aa7b770e2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/anchor.js\":\"04dba3aff6c41bf0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/anchorState.js\":\"b8f6815b2cfa40ad\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/commentLinks.js\":\"979f8fa3e8585ad7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/confirmThreadDeletion.js\":\"d6f57ae9f016ddea\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/container.js\":\"ddecdc9a2b7cb513\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/dataExtension.js\":\"9ef6f112bcaa8077\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/deleteComment.js\":\"2f16c9a38c763790\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/highlights.js\":\"da7d6d1d35c29e1f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/index.js\":\"5f3d11d8e53df2cd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/linkedCommentsPill.js\":\"7e7e7d39fdcb9c8b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/margin.js\":\"4293fabca55a6f62\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/marginAnchorLinks.js\":\"c1246d8f238b092d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/marginSchema.js\":\"c8d5e24e54b76e1b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/newComment.js\":\"2a9e665e5591c937\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/ownThreadPicker.js\":\"2b43df522cd20121\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/placement.js\":\"baa9bedd83c9061a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/queries.js\":\"f51e37f17a1d5e37\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/quotePosition.js\":\"cb60c25dba75eece\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/quotedIn.js\":\"ea2c65a5eba1d8d9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/quotedRange.js\":\"680f1c08b83ac7a9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/rangeRefs.js\":\"45286564e7858e6a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/readHighlights.js\":\"3e6471cf7386f587\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/readSelection.js\":\"78f029ca2a4189af\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/readSelectionUi.js\":\"c17ae58c91e4aba0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/reanchor.js\":\"9cb98bc8b8d70b22\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/schema.js\":\"c4621381938ac3eb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/scope.js\":\"57e96508f41e2745\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/scopeThreads.js\":\"9a94badb82a7ea33\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/splitRetarget.js\":\"f59c9be3b85d0e3e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/suggestionCard.js\":\"6f94080adc8c891e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/suggestions.js\":\"a815c2d56b014b5b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/summaries.js\":\"36b5832783ce0d09\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/summaryBatch.js\":\"67c63d8c6dec16f6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/surface.js\":\"43106475083702da\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/threadNavigation.js\":\"5b558ffbd3fe4693\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/threads.js\":\"03447f433ce8f508\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/ui.js\":\"d2d5700c5830a623\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/uiStore.js\":\"cee36dde12803781\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/app-intents/appIntents.js\":\"4b798012fba87344\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/app-intents/index.js\":\"ac7b5136d2925224\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/app-update-prompt/index.js\":\"b923ab4e7ef4abdf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/app-update-prompt/status.js\":\"f0db1bba30a37e99\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"50cbebfac0606cf2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/MediaBlockRenderer.js\":\"13a1364bc33df463\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/MediaDownLaneReplicator.js\":\"689122aa456b8eef\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/MediaUploadReconciler.js\":\"a6236ebf2fe52493\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/assetDownLane.js\":\"5dec1d77d0fcc34c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/assetResolver.js\":\"4a965305911f4f40\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/assetUpload.js\":\"6b5cea74943398a6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/attachmentCleanerIO.js\":\"3b5716696883e72c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4b12e7bfdf44fe26\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/blobStore.js\":\"e4e116cec6c26e68\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/browserMedia.js\":\"a50e5a15b523741e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/byteStore.js\":\"b423880d14d8efb6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/cleanerIO.js\":\"93d080052445c92f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/cleanupAttachments.js\":\"82f9922152b4a19a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/dataExtension.js\":\"c794acd00716705b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/downLane.js\":\"8518f6b5389ed1b3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/index.js\":\"d1d148f14fcb1638\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/insertImageContribution.js\":\"309a022916789bee\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/laneArming.js\":\"bc401632877eac43\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/laneLock.js\":\"445803ed4f3962df\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaBlock.js\":\"5b1b5771c1a6f1a5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaCapture.js\":\"e094a3885b59bd4f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaLanes.js\":\"2fb26b019da40ba4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaViewers.js\":\"ef537150bfdf92b7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaViewersFacet.js\":\"3e8aeb37dbbc381d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/pasteCapture.js\":\"061f51303849ac05\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/resolver.js\":\"88c9f0413663d9cc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/retryUploadsAction.js\":\"c1f9d3d22eea149a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/storagePaths.js\":\"c154747a00319c74\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadDrain.js\":\"229a4a67cdbc1f19\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadLaneStatus.js\":\"463d8206ca1f0835\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadReconcile.js\":\"b31ca697996ddcec\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadRecovery.js\":\"0acf8be46ef1b35a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadStore.js\":\"24ab99b86e6254b9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/useAssetObjectUrl.js\":\"9949adf07fc2aa8b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c7d7693e9215c5e1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c997bc03e44f8d2e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/facet.js\":\"80b159694d3cc879\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/index.js\":\"ea2cb04e2a788c1f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/prop.js\":\"59b0f48d2f511491\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/BacklinkFilters.js\":\"c190bea9fbd008be\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"5105ea5646dd975b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/BlockEntry.js\":\"f9896d02d39ea91b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/LinkedReferences.js\":\"bf50b135c282d005\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"dd3b1a2504cd6695\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/dailyNoteDefaults.js\":\"33c807ca94e15387\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/dataExtension.js\":\"67ede9e664df6263\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/edgeExclusions.js\":\"b5b1d742ec32a100\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/filterProperty.js\":\"4a99e2750bbb401b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/index.js\":\"2fa5b829d8ba43cb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"264bc07920f8f22e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/applies.js\":\"eea906a419cc2251\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/countQuery.js\":\"e4e145d12d55daa0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d31cc9223b37f163\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/index.js\":\"6e745686168acef5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"7228fb18f15bec09\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/presentationInvalidation.js\":\"9bbfcacad57dc19a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/propertyEditorOverride.js\":\"4397c9e53f0a80a7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/propertyFilter.js\":\"bece554dbb8b9904\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/query.js\":\"02ab90db7d245378\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/resolveFilter.js\":\"61fa66e0e7ad5b7a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/sourceBatch.js\":\"7217e0075a1a81f5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/sources.js\":\"4aeaf0506440d9e6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/useBacklinks.js\":\"fa34d88f15b954fb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"81d69c8187f7a39a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/BirthdayCelebration.js\":\"5a6d18dcf53154fe\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/BirthdayOverlay.js\":\"035f664fb9314e85\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/gate.js\":\"da032e5de6a24679\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/index.js\":\"dfd1c96813a51355\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/wolfTheme.js\":\"00333f9bdc1446b0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/BlockDragLayer.js\":\"1f3689e210835bfd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/dragController.js\":\"6978c259e8affd7b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/dropTarget.js\":\"a6337b0e846e2663\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/index.js\":\"ef20a92574217be4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/projection.js\":\"93e654527ca5f230\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-info/BlockMetaCard.js\":\"6e39a7398cf887f0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-info/index.js\":\"6c5ddba3d79aa89f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/AddTagDialog.js\":\"4dfd257314e46dbe\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"5740a15fa055e603\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/TagNameIssueHint.js\":\"8be08305538684b4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/addTagAction.js\":\"4a0db9bffa2ba9a3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/appendTag.js\":\"653fc26b9b17775b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/config.js\":\"16e2165489256686\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/dataExtension.js\":\"e0ae970cceeba4e8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/index.js\":\"5df7a1c0da263513\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/propertyEditorOverride.js\":\"7cf8d021b0f5514c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c19f674101424be2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"2a9c054f3474e203\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/Breadcrumbs.js\":\"bcdbaf097d408c4b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7c4f13a1e2d8ab29\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a1e476040d81f2c6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/index.js\":\"8ddad41e542fede1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"721da97bce80e3c0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/CharacterCountItem.js\":\"9eb28c451352bbdb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3c5018213586abe2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/actions.js\":\"c20a1822e1d04fb0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/blockType.js\":\"9300b04bcf22df61\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/charCount.js\":\"1c877a1fd3aac5e8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/dataExtension.js\":\"535d762a33887634\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/index.js\":\"5bd63a4ecba457ca\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/profiles.js\":\"7f070d2a4a9d87a3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/properties.js\":\"836faa09032b6ea0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/subtree.js\":\"c2cdbc0d396da685\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/textCounts.js\":\"2af77cb9631e23e3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/colemak-keybindings/index.js\":\"a2bea45d1e8f4a3d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/CommandPalette.js\":\"53ed7700bb4abc8a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/HeaderItem.js\":\"42a4aa9300fdae80\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/context.js\":\"8d50c6a4a069ded4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/index.js\":\"dcc17d1240fd2d80\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/selection.js\":\"f01af9f74a2eb0fe\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/toggleStore.js\":\"857fe54e963493af\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/useCommandPaletteActions.js\":\"be4df15c5ebdecd9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/ContributorBadges.js\":\"27b6ddd43eb0e9c0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/ProfilePicture.js\":\"13f153f89264c320\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/author.js\":\"a88d152ad6b36a27\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/codeMirrorExtensions.js\":\"d148ef559b22aec9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/dataExtension.js\":\"cf5db789b18d4605\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/index.js\":\"a0ee7d51a65506c2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/mentionAutocomplete.js\":\"583fca90b17d6216\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/processor.js\":\"1af5ae4c77fcc8e7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/profiles.js\":\"7c9f61ceb6b550df\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/queries.js\":\"ae23dac8bb2d470f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/schema.js\":\"e3900e7dea0e01d0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/useCommentAuthor.js\":\"11beb2781af3dc43\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9236e8aabf67a62a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6c254478a029dabd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/index.js\":\"c12a6059dc186e67\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c940772727af39ed\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"3be157b87523bc72\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/CalendarGrid.js\":\"50c2c6599c1d0619\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DailyNotePicker.js\":\"586df5b7eea0e7b4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"0caeae2f7d7b7a30\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DateNavDecorator.js\":\"30060fee4c2d1968\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DateScrubOverlay.js\":\"dc27c2634ed39c24\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DayPropertyControl.js\":\"2c0d06e54e9b7523\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DayValueReferenceControl.js\":\"d98084f282379c81\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/HeaderItem.js\":\"77b8caab8b0a80be\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/ReschedulePicker.js\":\"3b254acfed141f54\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/SpreadDatesDialog.js\":\"6a50743405e95f37\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/actions.js\":\"a1bb1621ce90078e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/blockDateAdapter.js\":\"c7c88380ae5a4050\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/calendar.js\":\"113a37df7bdf4642\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dailyNotes.js\":\"fce40d66bb4b8eda\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dataExtension.js\":\"85e91ac127570706\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dateScrubActions.js\":\"e4f77fd1af285f0c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dateScrubGesture.js\":\"fb1ea614e93deabf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dateScrubGestureActions.js\":\"359e433b459da810\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b893a00527ec7cf0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dayProperty.js\":\"7b1c93dd94d46aef\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"b3a64fdf765700a1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/deletionGuard.js\":\"b19d813be3bc736d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dueQuery.js\":\"224ce76783f6559b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/index.js\":\"f28c159af873d50f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/landing.js\":\"a4b9ec53cddd1a07\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/localSchema.js\":\"19a8c5b97afdb268\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/referenceDateAdapter.js\":\"4e471e012268ab80\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/rescheduleAction.js\":\"e49c8b4f12f41a4e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/schema.js\":\"a96a8528ca0d8850\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/spreadBlockDates.js\":\"4362b4c8fc651552\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/spreadDatesAction.js\":\"52ac7d8fa48d59b6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/today.js\":\"b50442d606ac528a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"0e83a0af81756503\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"07a4b01e5066597b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/audit.js\":\"dea2fe6bdf5d4e33\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/auditAction.js\":\"68355fccc49c23ac\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/auditRanges.js\":\"c9dc5cdf01444a3e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/diagnosticsSource.js\":\"a8efd75d5643cb71\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/divergenceScan.js\":\"33df242d604582b2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/index.js\":\"c7834254ee5027cc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d15f5262c785e23f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/referencesMirror.js\":\"dbf60a026705fb6c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/rowJson.js\":\"360bcb72152ab047\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/schedule.js\":\"c3345dbe5ce68dae\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/store.js\":\"194e205bd5bfb5db\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-maintenance/action.js\":\"809285aec3179d21\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-maintenance/index.js\":\"651b2552bcbaf47f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-maintenance/plugin.js\":\"41a4728a96b94489\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"38a432feea315125\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/actions.js\":\"c9ecd2972ea3ba59\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/changeMarker.js\":\"418f96387cd4a959\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/diagnostics.js\":\"396b63de7b0f7f02\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/fileSystemAccess.js\":\"257c810d41a41966\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/filenames.js\":\"e0bdbb6f522f85c4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/index.js\":\"7e9ce4a9af656500\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/mirror.js\":\"77450f242fd54637\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/runLock.js\":\"3e14b33a6b9ef393\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/runtimeHealth.js\":\"8c7a64ee76599c03\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/schedule.js\":\"0d5845b815e2c1a9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/store.js\":\"cfda9ed72687d165\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/default-themes/index.js\":\"192ca030cd62205a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/default-themes/themes.js\":\"d50d7c4be27a4228\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/diagnostics/facet.js\":\"999e1879aca68228\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/diagnostics/useDiagnostics.js\":\"e5917c0ecd33c85a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extension-prompts/dismissals.js\":\"9df8e1d982fc0d6b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extension-prompts/index.js\":\"73f42f14e7908400\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extension-prompts/status.js\":\"019acec3f9fadb8c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extension-prompts/store.js\":\"67af41507c5f41bc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"341fe49a76c21e21\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/ExtensionsSettings.js\":\"dce3b429e30d65f6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/actions.js\":\"e295db0b0418afdb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/config.js\":\"6fefefdf182d924c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/dataExtension.js\":\"09f102fce4965177\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/effect.js\":\"ae241fc6b25cfda7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/index.js\":\"1ab543f488e2474d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ebadbfcf3a4a7b8a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/useToggleTree.js\":\"0f75a857a6afda79\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/ExtractTypeDialog.js\":\"686bee597147c734\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"baa6b417e38c4881\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/PropertyShapePicker.js\":\"c8fe35251cf7622d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/action.js\":\"ae80089b414232f7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/index.js\":\"6290e48b7ccc0cdd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/FindReplaceDialog.js\":\"3e18f04742c5c186\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/HeaderItem.js\":\"dce257c1bc2c690f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/dataExtension.js\":\"8495fcbd10588e5b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/index.js\":\"20f1233daeaa3aba\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/search.js\":\"ceec3203c6bc559f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/toggleStore.js\":\"713b332bd99bd400\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/LocationPropertyEditor.js\":\"f44ba1b0edb082dc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/MapView.js\":\"0dfa1a30d1308850\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/blockTypes.js\":\"50874bc787879166\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/codeMirrorExtensions.js\":\"dd492deb214905ab\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/createOrFindPlace.js\":\"580d09992850d313\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/currentLocation.js\":\"8d3b21cacbe2afd8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/dataExtension.js\":\"e3bf54eef8e39748\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/geoContentDecorator.js\":\"a27276d3839b3e49\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/googlePlacesClient.js\":\"c4eb6855e2690c1a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/index.js\":\"a038be0d7c1b7d0a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/locationsPage.js\":\"0655fb4846797824\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/mapViewport.js\":\"77707668b72f2c6d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/pickCurrentLocation.js\":\"57b42ee046ce78b7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/placeAutocomplete.js\":\"515cf73fbb63c67c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/placeNameCollision.js\":\"9ff06cbb7195e5d8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/properties.js\":\"99f47f3cf33b9dd2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/propertyEditorOverrides.js\":\"e17e778367fefd6e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/query.js\":\"62ed805c00949d0c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/usePlaceSearch.js\":\"0e9a7484fa424fe6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"3a897373ad702647\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"cef3c8997277c2bb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8bdacdcbf9a650ed\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/config.js\":\"641e8c00563ca6c2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/dataExtension.js\":\"bc6370989ce9fcc0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/facet.js\":\"3a34b15df9e8be72\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/grouping.js\":\"8b250e695fd39903\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/index.js\":\"26f3d3a362739862\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"81677eca3ce8fae2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/query.js\":\"3957fd705ff2a7aa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/resolveConfig.js\":\"441c3014dc2fb1ed\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"f00d9e96d6d08469\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"810c13c120e9a4fa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/HtmlDocumentContent.js\":\"88d62b84621cfae7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/HtmlFrame.js\":\"a92e8f25d0a4e7bd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/actions.js\":\"6d913ffa48d1da39\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/blockType.js\":\"e4baa0ee0b5a0df7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/confirmRunScripts.js\":\"05177319769c1eee\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/dataExtension.js\":\"01d946ccb320c82f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/frameAnnotations.js\":\"f6399d3dfcb6a840\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/frameDocument.js\":\"ff29d8296eb9f3ad\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/frameTheme.js\":\"a3256ad455c47fc8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/index.js\":\"ef088c728036fa3c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/scriptConsent.js\":\"5c69712eb414a54d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/sourceMap.js\":\"994af7b5046c4061\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/useDocumentScripts.js\":\"6d45ee0a0779ed13\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/index.js\":\"56f37f14cfbc0e22\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/record.js\":\"e1ac454074405ccd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/recordStore.js\":\"f5cf8dc085429411\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/responsiveness.js\":\"2966a66e8309bbd8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/schedule.js\":\"a05d5face53cd5f3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/sessionContext.js\":\"fc03875fe7b5c1ea\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c3cc03406f69f236\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"b84a138c72b942b1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/actions.js\":\"548d2fbbead866aa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/config.js\":\"17faa82c22fdc9f1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/dataExtension.js\":\"a0b47e8784841616\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/effect.js\":\"aec3d88cf8433660\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/index.js\":\"b720e911ce461707\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/keyCapture.js\":\"8851f0ce1cf5fe54\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/overrideStore.js\":\"0b0c00db944ccd34\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"82a467d4755cea48\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/HeaderItem.js\":\"e311680d0e0cbc77\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/LeftSidebar.js\":\"0805b9bbe955da50\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/actions.js\":\"0a181c633fe6c52e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/facet.js\":\"86584fcf8d37c589\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/index.js\":\"542a2beefaddd8aa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/shortcuts.js\":\"5043857f565b9980\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/toggleStore.js\":\"161af14637b55d44\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/merge-blocks/MergePicker.js\":\"c660d9f0456dc904\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/merge-blocks/index.js\":\"475bc960d384f5e7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/merge-blocks/mergeAction.js\":\"c67070bf56b499b6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/merge-blocks/strategy.js\":\"2f0239a44db6ab85\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/Button.js\":\"55c890ee433fcf1d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0362c1ea16debf62\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/defaultItems.js\":\"ba93a57f35bcdcb5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/facet.js\":\"92c4b84b76213109\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/index.js\":\"ea8554d1aab91824\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"42786b2b66fe619d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6ae5e2025b7c2e49\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"addd98df2b2c267c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/facet.js\":\"da888634f4565601\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/index.js\":\"c7f8573be1c0ba82\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a8266a50ff7f3a86\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/blockSubtreeMembership.js\":\"35b1baa5ff6b9695\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/contextMenuItem.js\":\"1cbdf047333f0855\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/index.js\":\"fd26467fb89702d6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/moveAction.js\":\"6bc3c8d0f7477a52\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/moveBlocks.js\":\"962a0234f0be1482\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/selectionAfterMove.js\":\"fdd4cdb68d07d857\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/TutorialBanner.js\":\"6bc941830ba907bb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/action.js\":\"7e4fa54a26f946c6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/bannerDismissal.js\":\"78c8f53978bbf041\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/documents/cheatSheet.js\":\"ad733d89faed5396\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/index.js\":\"1804492236b3e320\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/keys.js\":\"72ef9555095942a8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/landing.js\":\"f4598d127e44dff3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/outline.js\":\"369f500ace16ba19\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/seed.js\":\"1e66cc7d8f9b1483\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/PerfTrendDialog.js\":\"92d79827d10de0c5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/analyze.js\":\"cacb6d3a46f4a827\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/diagnosticsSource.js\":\"6c5282db64ab0ece\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/index.js\":\"ed942def70715eb5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/load.js\":\"4d72fd5eb0dd68ec\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/monitorRun.js\":\"3b8bc765db66177f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/schedule.js\":\"96625f0756dcb0a3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/series.js\":\"b0a4ef7601e71dce\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/store.js\":\"bc4aaf10e0cd4289\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/trendAction.js\":\"023a2cfb66d3eefa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/verdict.js\":\"15bd5b27c0ae9795\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/plain-outliner/clickToEditAction.js\":\"c4de325db5ccff2b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/plain-outliner/index.js\":\"1b9ba142d3aa12ba\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/plain-outliner/interactions.js\":\"f2257bb88d9aa32c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"afdacb35ea5b1e18\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/MigrationGate.js\":\"02a1e59c0eb8063a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/MigrationGateDialog.js\":\"655cb5183b26a2b8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/action.js\":\"bfbdf6576643dcd2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/index.js\":\"5e41194204db0577\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/localRunMessage.js\":\"db2f4bb4abbac17f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/plugin.js\":\"f00d4519507330fb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/progressReport.js\":\"989f07763dc78151\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/sweepProgress.js\":\"57c304acc09962b5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/FieldRowRenderer.js\":\"0b7fae5ceccaf6be\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/ValueRowRenderer.js\":\"f96e8508b1fba105\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/actions.js\":\"8f706bd0ba10891a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/autocomplete.js\":\"5cfdd34a34fe8643\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/fieldRow.js\":\"532a4125ec0bff47\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/index.js\":\"c0bcecc59eac3f15\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/referenceWarning.js\":\"85fd1c949d9f9ee2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/valueAutocomplete.js\":\"dd21a1db6deacedb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/valueSchema.js\":\"3e47246b0e6c20ca\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/HeaderItem.js\":\"357f4b0702595b0d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/QuickFind.js\":\"448154253e142c1e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/index.js\":\"eff520007878a0a2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/recents.js\":\"39f591e202a29e89\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/resultItems.js\":\"5edc3952c1826d3f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/selection.js\":\"539a88b305ab8300\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/toggleStore.js\":\"561b5b7f3068f917\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/HeaderItem.js\":\"41d59d29180ef6fd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/RecentsPageBlockRenderer.js\":\"961f8e6c5ac0092a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/grouping.js\":\"0938cd6e025e6a74\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/index.js\":\"52985e30fed6fce0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/target.js\":\"8ce68f77cd02c640\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/codeMirrorExtensions.js\":\"81cf6833847b0134\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/contentPrefill.js\":\"cb27f54a477da92f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/dataExtension.js\":\"cd1e23d47f92bd68\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/index.js\":\"d8128b2132b8a242\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"44c197fe19e458cc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/invalidation.js\":\"86712830c8e241a9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/localSchema.js\":\"e98b5216117886a6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/blockrefs/index.js\":\"d7f170650e5812c2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"1afed64a2e9da3f1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/index.js\":\"e99b4f4fabc49112\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/referenceNode.js\":\"ed8056e670c36b46\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/remark-reference-occurrences.js\":\"bbc18931527fc688\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ae25cf43e5b1a8e4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/wikilinks/index.js\":\"217aff0fab59eb9c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5e822513bfa6c8ca\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c12b96339dc5ca70\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/mergeRetargetProcessor.js\":\"bd2cf04a2adac54e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/parseFence.js\":\"53843813a5d5df6a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/referenceParser.js\":\"761365b2fb94ca70\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/referenceProjection.js\":\"0906b04e9bc899f3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/referencesProcessor.js\":\"9913e67bd42d078c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/renameProcessor.js\":\"baf72d3a57717d65\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/spanReplacement.js\":\"e7157c2f1bef1bd1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/rich-paste/htmlToOutline.js\":\"7504bfc6099ca6f4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/rich-paste/index.js\":\"3269e34314e18f54\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/rich-paste/normalizeClipboardDom.js\":\"3819e8211c4ea8c7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/rich-paste/pasteDecision.js\":\"d9ffb45629cace98\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/action.js\":\"5b8ebcf3f8b83980\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/blockIds.js\":\"69172bb16f3c1da4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/content.js\":\"e2be47016459440f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/effect.js\":\"4ca26d45a3f4f627\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/ids.js\":\"0b27991ff32c2317\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/import.js\":\"49f57bc0ab336b35\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/index.js\":\"42183e9a2ba29c9b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/plan.js\":\"25602665435a4607\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/plugin.js\":\"3a8134e821877956\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/promotion.js\":\"bc0feda55d5abc23\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/properties.js\":\"c093d8f58fffae08\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/references.js\":\"b79adab1174680ed\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/report.js\":\"71a5178a78d847fb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/roamMemo.js\":\"e16ecf674f0a64f9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/runtime.js\":\"4c7ca4839d375dde\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/schemaReconciliation.js\":\"a5b4444de4e263aa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/srsMarkers.js\":\"244ef5cf933fd7a6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/todo.js\":\"505aa0418f236248\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/typeCandidates.js\":\"61ba54d92e2b1c25\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/types.js\":\"37934ccd002f8179\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/search-health/index.js\":\"3d59eee509d5b44c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/search-health/store.js\":\"75426892297b2fbc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/HeaderItem.js\":\"6bf60128c32431a9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"561c4e3c6b9edcf2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/index.js\":\"7d083602d6d69e18\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/model.js\":\"096be73a9cb20ad4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/toggleStore.js\":\"0e6723c8e1cdee35\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/useKeyInspector.js\":\"95abbf8b8bb386ec\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"98eeec419ab32dee\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/ShellDecorator.js\":\"7de4d1159e9d642d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/actions.js\":\"6651a08fb03622be\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/exclusionsFacet.js\":\"9f22573557d29dd0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/index.js\":\"514eb4a63fc356af\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/shell.js\":\"dc766edd37ab05c5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/surface.js\":\"1705a1217ddc3a9f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/walker.js\":\"7002a45efe89992c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/RescheduleToast.js\":\"32bb06105bc82384\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/dataExtension.js\":\"0feb1ea28bcb730e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/index.js\":\"13e299e1bcab7c0e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/indicator.js\":\"0c4ab5aabb9fdfc0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/moveSrsState.js\":\"20fab5d2cd05a961\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"933c645c8547595c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/scheduler.js\":\"7a234560693446d2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/schema.js\":\"f868ee2d7108c163\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"729e459702e47c0f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/srsClipboard.js\":\"d368ee2c21c1e7b2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"be0d4126cbd0ebaa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/DailyNoteReviewHint.js\":\"dec4b3ea8d4f8e5f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/DeckPicker.js\":\"08b82aab011af250\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/ReviewControls.js\":\"08d917f972f28c53\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/ReviewDeckRenderer.js\":\"102425a0ac2196e7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/ReviewSession.js\":\"250bc1769ece8ac4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/actions.js\":\"eb2fdbac21b09463\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/archive.js\":\"937f46e2d1cb62ad\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/dataExtension.js\":\"bc8fba30c9a8a63b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/deck.js\":\"c579282a96fbc871\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/dueQuery.js\":\"7f0f90f482fbf580\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/gradeDecision.js\":\"6e52392e179120d1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/index.js\":\"bbc8ce8d73dfe44c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/keyHints.js\":\"768a3bc3ce5d3e7f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/reviewCardLayout.js\":\"5651832e86ba9465\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/reviewProgress.js\":\"4c30ede94c560b1e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/schema.js\":\"63be7764749481b4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/useDueCards.js\":\"955355563790a9f2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/startup-metrics/index.js\":\"8bd81395898f0636\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/startup-metrics/record.js\":\"893a556eb64bd372\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/storage-persistence/index.js\":\"104475398d5fba7c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/storage-persistence/persistenceStatus.js\":\"e3a12d40f182fc3e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/storage-persistence/requestAction.js\":\"e45a12cb2f12d4ae\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/supertags/TypeChipsDecorator.js\":\"565558c6a32ff4ff\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/supertags/codeMirrorExtensions.js\":\"07d8c17d03f829d0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/supertags/index.js\":\"7d017aab7b024892\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/supertags/typeAutocomplete.js\":\"e93fd7cb0d6d312b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c9da9fb1f27783dd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/actions.js\":\"c82a8953f876babf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/anchor.js\":\"270a79311bd6413a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/events.js\":\"3896bedc3209c5cd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/gestureActions.js\":\"f825ed3a46e2f7d4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/index.js\":\"e234090b40ddb864\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"b73748af93edde00\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/sync-metrics/collect.js\":\"d49d4fc86a8ccb67\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/sync-metrics/index.js\":\"8410086c94f8722c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/sync-metrics/record.js\":\"22339d9588bf1383\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/RejectionDialog.js\":\"d1c1b91f6e257959\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d5e8f844a92e5589\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/index.js\":\"dacaaa2a03efdac3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/model.js\":\"b71628b91b13a61b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/queueCounts.js\":\"e4835726b972b8c2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/rejectedHelpers.js\":\"d9335732ece9017b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/rematerializeAction.js\":\"d10b81e4580e73a1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/useHysteresis.js\":\"d90074b662bee600\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/ColumnHeaders.js\":\"b7b1944f6928d24e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/QueryUi.js\":\"e7e3dd81dc7a38ee\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/TableLayout.js\":\"c11b7bee13643423\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/actions.js\":\"9b9aae32c54b1325\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/cellEdits.js\":\"427a7f945a5f00db\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/childrenViews.js\":\"5ef494cf825af2c4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/columns.js\":\"d8ab4857456e347a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/controller.js\":\"da07c466769bd70f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/convert.js\":\"c019b7d09cc547c3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/dataExtension.js\":\"9cd995125c1ac720\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/index.js\":\"e5694a8769c8ecc8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/keys.js\":\"68b3bea90b0804c1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/model.js\":\"907c0c8e3ba5dc0c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/QueryText.js\":\"926340fbd48f9e9a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/backfill.js\":\"a338b5b02313db12\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/completion.js\":\"6475feb3e139a307\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/format.js\":\"6db5a158192b67b1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/parse.js\":\"ea1faddab264752b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/queryValue.js\":\"c60ccd4363222d4f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/registrations.js\":\"8c6171fcf9efd3fa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/source.js\":\"725e78fa195cd3ac\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/registry.js\":\"889db1c9b5b27c97\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/rowGutter.js\":\"8e8dc5ebbc0c6c19\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/rowVerbs.js\":\"2f4b0c835a1f4973\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/schema.js\":\"305e7e8e4ecf8ea2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/sort.js\":\"3831487db53a4251\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/theme-toggle/effect.js\":\"99099067958ecfec\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/theme-toggle/index.js\":\"f214ecaa490078a8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/theme-toggle/theme.js\":\"e25a40e795bcf665\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/todo/actions.js\":\"1bfbfb333e1a9697\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/todo/dataExtension.js\":\"0230b9418c8fac72\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/todo/index.js\":\"ff9d67abfca69e61\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/todo/schema.js\":\"1ac4a4e5374641ca\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/TouchSelectionLayer.js\":\"76ed9f61a8227690\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/actions.js\":\"4de5e6891523fa9a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/defaultItems.js\":\"64c8a91cc61571fb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/facet.js\":\"4e326ee480d8f8df\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/holdRecognizer.js\":\"13ff3f12ef88a124\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/index.js\":\"e9eebbee681eafa2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/update-indicator/UpdateIndicator.js\":\"f32d60b5419ece82\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/update-indicator/index.js\":\"444abf6b437074bd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/update-indicator/loadTimes.js\":\"996e961cc8753cf2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/VideoNotesRenderer.js\":\"f7bdf69bd10a4650\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/VideoPlayerRenderer.js\":\"e672949c6dd8dc58\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/VideoTimeStamp.js\":\"8421ebdb4ccbe2fa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/actions.js\":\"923308034208f4ce\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/index.js\":\"dc29c9aaa7855ab5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/markdown.js\":\"c9a44c8953aec21b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/notes.js\":\"18d4dc3ee2fca577\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/registry.js\":\"f3d77d75026763c7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/remark-timestamps.js\":\"b4cb3cd15fc4b06c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/view.js\":\"a73553ca1d8fe15d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-link-hints/LinkHints.js\":\"202e0370709bc341\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-link-hints/index.js\":\"dfd255f7e183c367\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-link-hints/model.js\":\"926b0057c055aab2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-link-hints/settings.js\":\"cb04c50c1e4b46fc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-normal-mode/actions.js\":\"b88a88e9ffe70bf8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-normal-mode/index.js\":\"b54ce7d954d4699b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-normal-mode/interactions.js\":\"da7cd571f5658a82\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/workspace-header/index.js\":\"683a2eee0f15edae\",\"/knowledge-medium/pr-preview/pr-1890/src/registerServiceWorker.js\":\"ba294c091319d061\",\"/knowledge-medium/pr-preview/pr-1890/src/requestPersistentStorage.js\":\"d40c4dff77733b56\",\"/knowledge-medium/pr-preview/pr-1890/src/services/authRequestDeadline.js\":\"6d5f1d7dabd84d5a\",\"/knowledge-medium/pr-preview/pr-1890/src/services/authStorage.js\":\"03832d5276aa082b\",\"/knowledge-medium/pr-preview/pr-1890/src/services/powersync.js\":\"f1dc61009d798eac\",\"/knowledge-medium/pr-preview/pr-1890/src/services/supabase.js\":\"960cdcad7fbcb73d\",\"/knowledge-medium/pr-preview/pr-1890/src/services/uploadErrorClassifier.js\":\"068820a3d88a79e8\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/ActiveContexts.js\":\"f009f433d62471e6\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/HotkeyReconciler.js\":\"f3767a77dde2e3eb\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/WipeLocalDataDialog.js\":\"ed89e7db5d03df28\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/actionDispatch.js\":\"42bb6bffb1d66903\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/actionRefItems.js\":\"939eb833eb39c5ad\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/applyKeybindingOverrides.js\":\"bbe1887a55945bb7\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/blockActions.js\":\"6bd2e9dbc4d8a4d9\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/blockMergeGesture.js\":\"6e10c213f441471e\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/canonicalizeChord.js\":\"ec86a46ec18f8776\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/defaultContexts.js\":\"e592dd924a40aab4\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/defaultShortcuts.js\":\"ecc729f3abb58138\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/effectiveActions.js\":\"0cde6216461f54ed\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/gestureAction.js\":\"4c66f49ced3102f6\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/gestureBinding.js\":\"41cddf215f63e7f7\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/holdRegistry.js\":\"75135ce1a38b051f\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/keybindingConflicts.js\":\"59b202878fd577c0\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/keybindingOverrides.js\":\"c7df7eca5a3ffe12\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/pointerAction.js\":\"da6c14b76c3a9c04\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/resolve.js\":\"053def8a2a302da0\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/runAction.js\":\"75d260f27cde7f45\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/sequenceMatcher.js\":\"dd13dfae86b079bf\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/types.js\":\"3ca72b96b10eaa94\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/useActionContext.js\":\"bf62881397b8510d\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/useActionDiscovery.js\":\"f8ba14b938757206\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/utils.js\":\"5cd966911490f020\",\"/knowledge-medium/pr-preview/pr-1890/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1890/src/sw/bootStore.js\":\"c2ef2943571f733b\",\"/knowledge-medium/pr-preview/pr-1890/src/sw/previewDatabases.js\":\"34509837fe67f546\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/byteTransform.js\":\"aa472cc9ea2fa157\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/attachmentCleaner.js\":\"60addd0dcdb3518e\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/attachmentParts.js\":\"ff1d2e5fdfa6edd3\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/bundleParts.js\":\"ee56d8e5c92edd25\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/bundleRecord.js\":\"12104ac47aeda09c\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/manifest.js\":\"57c51da62ed55236\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/takeBundle.js\":\"38853d97eedfb39b\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/verifyBundle.js\":\"d88c11b723708037\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/cleaningStage.js\":\"2122dfad6513917a\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/conversionKey.js\":\"19e6de1732f5e0f7\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/conversionServer.js\":\"1a3c197626afad8c\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/flip.js\":\"d8fe14dc41101a92\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/flipAttempts.js\":\"2f8c759b5a74a900\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/pages.js\":\"b29a6d557932f89a\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/preflight.js\":\"14f8e04d739aa2d3\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/reseal.js\":\"449643b8bece3055\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/runConversion.js\":\"5c9dcf2b279677ff\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/runLock.js\":\"1a2a9fca1046f267\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/sealing.js\":\"2feba7e7a3320f0a\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/sealingStage.js\":\"ee7f550bbf0cab4f\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/stage.js\":\"62b09d99ab4905db\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/verifyReseal.js\":\"c4eae5b0ef4dd26d\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/aad.js\":\"47f2263fe919590d\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/aead.js\":\"b995a01eace48411\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/base32.js\":\"90ca3742f0eab49f\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/base64url.js\":\"14bc957e30d52d42\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/binaryEnvelope.js\":\"10291332ae31adb6\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/byteAead.js\":\"7fc502809424660d\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/canary.js\":\"d530e113798818a4\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/contentHash.js\":\"068e578102f4ab45\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/contentKey.js\":\"e7ff4f2d792c9e81\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/derivedIdNamespace.js\":\"ea4d9ca7391ea270\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/envelope.js\":\"02479f6ae8cb6f3b\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/hex.js\":\"525522ebfe6ffa50\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/sha256Hex.js\":\"b670a2eebb03112f\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/workspaceKey.js\":\"556eb04ed4cf223a\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/conversionState.js\":\"ab8d6eb05e99fdf6\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3b3512c4e03520c9\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/flows/pastedKey.js\":\"312519f9f0b9874d\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"074b5260338e43e7\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/flows/upgradeWorkspacePin.js\":\"bc8f387f5cf7dfcb\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/keyStore.js\":\"c5b7010108e7b2e9\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/mintWorkspaceKey.js\":\"034ddb1aba14752d\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/modePin.js\":\"9050acc1e137318d\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/openWorkspaceKeys.js\":\"365e9794801e52b4\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/resolveWorkspaceEntry.js\":\"cc5a18b0e1459f22\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/resolver.js\":\"3b5125841329cddc\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/workspaceAccess.js\":\"21abe568917884c4\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/transform.js\":\"d716b0b1d1f79eb5\",\"/knowledge-medium/pr-preview/pr-1890/src/themeBootDefaults.js\":\"89bc354d076f9c04\",\"/knowledge-medium/pr-preview/pr-1890/src/types.js\":\"845f4d5e26115177\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/ClientLocalSettings.js\":\"7c89427b9d3ed2a3\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/abortableSleep.js\":\"f44004cf6df15859\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/array.js\":\"34e0dc5a97a4d0be\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/backlinkAutocomplete.js\":\"1b12f387bd39ae71\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/blockCrumbs.js\":\"17c33430e1c59b6f\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/blockrefAutocomplete.js\":\"22066db0b8dfd5ab\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/cadencedIdleJob.js\":\"02771584810889f7\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/callbackSet.js\":\"8a81af547800ac14\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/clientId.js\":\"3278626ae938af19\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/codemirror.js\":\"353c5e1ba856c787\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/codemirrorCompletion.js\":\"9cf07a26785c7e52\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/copy.js\":\"cd4ac72d93f224d9\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dailyPage.js\":\"a4ceeef980360ea9\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dbForensics.js\":\"a781e3f80b80f746\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dbForensicsHooks.js\":\"6a04bf610547ed01\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/deleteBlockThroughUi.js\":\"6aaf29dcacff78b4\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dialogs.js\":\"67fe07cac299c48b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dom.js\":\"f90e69d72f5efb8f\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/downloadBlob.js\":\"4065f8f8cd96ff39\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/drawnWalk.js\":\"c9bbb90ed0caa6bd\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/exportSqliteDb.js\":\"aac2f7985b641f65\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/fileSystemAccess.js\":\"a0fcc2a96cc20cdc\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/flipSlide.js\":\"6b8b498d5f137425\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/fnv1a.js\":\"b50ef7a84d6c07a2\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/formatBytes.js\":\"314aa55a92ac97d8\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/fuzzyRank.js\":\"22aaa19c1eef61b8\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/idbKeyedStore.js\":\"1812048c68a15ba9\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/idleCallbackPolyfill.js\":\"ad54f28497cfce61\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/keyboardAwareScroll.js\":\"47876658d96fa24f\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/keyboardViewport.js\":\"885a499d5a75e7db\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/lastWorkspace.js\":\"4896ff08a10aba19\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/layoutColumns.js\":\"c679a7a6ab831687\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/layoutSessionDom.js\":\"486dd65a901b37df\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/layoutSessionId.js\":\"bbae483d0c7999c2\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/linkClickGestures.js\":\"7a9fbd9372428fe0\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/linkTargetAutocomplete.js\":\"6b59346eb8d58e9b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/localDbCorruption.js\":\"99b0bd23167dd835\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/localDbRecovery.js\":\"b39ba966eb97f186\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/markdownParser.js\":\"c446b7af4b2dd0c4\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/memoize.js\":\"b3d4f11f2d463ced\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/nameFieldCommit.js\":\"a209a645a7c57c72\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/nameList.js\":\"77ad9a0bd7c85c95\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/navigation.js\":\"1da7838a92b74d37\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/omnilinerNamespace.js\":\"8f9976b1b3275014\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/opfsPageScan.js\":\"95c24a1f73da169d\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelClearance.js\":\"10edadd96ff67148\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelHistory.js\":\"e2f6e8aa88e24b0a\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelLanes.js\":\"cf49883d29d3579b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelLayoutProjection.js\":\"2a3bfe5577e8c24b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelScrollAnchor.js\":\"28d736e11bfb5d13\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelUrlFlags.js\":\"319bebcc762a20b7\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/platform.js\":\"f57e89c26e2f903c\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/pluralize.js\":\"7aede52a4f4cd0cb\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/propertyCreation.js\":\"d878b828cf9d80b0\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/propertyNavigation.js\":\"3e0a085b9dd0d62e\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/propertyValueContext.js\":\"e1c42f90cbae1f9a\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/react.js\":\"ee15f0c8dde0d18e\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/relativeDate.js\":\"e5cf8b15c132ab25\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/relativeTime.js\":\"dae599588b333baf\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/renderScope.js\":\"ac82343922598cac\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/resolvedThenable.js\":\"7702984d32a838b1\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/routing.js\":\"c687868503c6b83b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/safeMode.js\":\"f9cc9fddf0970cbf\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/scheduleIdle.js\":\"e967e50e6c81e3f5\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/screenWakeLock.js\":\"02a4143c65e4c8e9\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/selection.js\":\"be1ec5657af8c0c5\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/softKeyboardGrab.js\":\"994abcf522e34720\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/startupTimeline.js\":\"0497b972f74530cc\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/state.js\":\"29aad3f30320511e\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/string.js\":\"d8b10fc0778b7ce8\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/surfaceZoom.js\":\"5f76241144fa93d0\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/time.js\":\"5a73649003ca6eda\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/toast.js\":\"9573a7e111425e45\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/toggleStore.js\":\"3232497c38b10f35\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/untilStopped.js\":\"5ee5905a882db3df\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/userActivity.js\":\"2da8801d12652029\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/viewTransition.js\":\"d22ba38c7f78e6c1\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/viewport.js\":\"6e4f729757776bc4\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/webLock.js\":\"7ba7e9665bc7fcaa\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/workspaceRecovery.js\":\"8508c6c0194081f8\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/workspaceSnapshotStore.js\":\"c2800a8c26e56b17\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-compiler-runtime.js\":\"405bc0f244a5f189\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-client.js\":\"a2b4d3b6e2097d9e\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-server-edge.js\":\"dd11cfc041f0f6fb\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-server.js\":\"e16490565488fe3c\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-static-edge.js\":\"c644bedc4dc1a321\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-static.js\":\"02abab8028f09136\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-test-utils.js\":\"36b966edab89e0b4\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom.js\":\"edaab44b22300e1d\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-jsx-runtime.js\":\"6a6b109954d38e52\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react.js\":\"d37164e411aee49e\",\"/knowledge-medium/pr-preview/pr-1890/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1890/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1890/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
