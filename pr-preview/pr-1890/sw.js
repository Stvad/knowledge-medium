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
		buildId: "df54fcb0e311-02e0740d",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1890/\":\"ba2b4d5dd002554a\",\"/knowledge-medium/pr-preview/pr-1890/index.html\":\"ba2b4d5dd002554a\",\"/knowledge-medium/pr-preview/pr-1890/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1890/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1890/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1890/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1890/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1890/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1890/app.css\":\"6211a4bfca173ff0\",\"/knowledge-medium/pr-preview/pr-1890/assets/FacadeVFS-CWWVJXBa.js\":\"8d22608ce174875b\",\"/knowledge-medium/pr-preview/pr-1890/assets/OPFSCoopSyncVFS-B1JuhnS4.js\":\"34df7982aad43199\",\"/knowledge-medium/pr-preview/pr-1890/assets/OPFSWriteAheadVFS-BGeanTw8.js\":\"73091d69ef5d86e2\",\"/knowledge-medium/pr-preview/pr-1890/assets/wa-sqlite-CFlJlckp.js\":\"78b22fb4bf7526e0\",\"/knowledge-medium/pr-preview/pr-1890/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1890/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1890/assets/wa-sqlite-async-D-vR5WaQ.js\":\"4185d891b688cddc\",\"/knowledge-medium/pr-preview/pr-1890/assets/worker-DFKYeJQS.js\":\"8dbd9e10bc17fe7b\",\"/knowledge-medium/pr-preview/pr-1890/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1890/chunks/app-D1FT7WZ_.js\":\"7cc152f91c2fccc1\",\"/knowledge-medium/pr-preview/pr-1890/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1890/index.js\":\"b889993f26515735\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1890/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1890/assets/AccessHandlePoolVFS-BlHOFuZs.js\":\"764d7097609bb87e\",\"/knowledge-medium/pr-preview/pr-1890/assets/IDBBatchAtomicVFS-BPGb0TGh.js\":\"384835a5cee09069\",\"/knowledge-medium/pr-preview/pr-1890/assets/MemoryVFS-st-3oyFN.js\":\"76f7ad554bb15018\",\"/knowledge-medium/pr-preview/pr-1890/assets/mc-wa-sqlite-C-QrkzwZ.js\":\"3a3b38f23f71ecb5\",\"/knowledge-medium/pr-preview/pr-1890/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1890/assets/mc-wa-sqlite-async-DRWw4dli.js\":\"07a7833b35fbe5c3\",\"/knowledge-medium/pr-preview/pr-1890/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1890/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1890/chunks/AccessHandlePoolVFS-wACri9dP.js\":\"2cc98bc8383a5d0e\",\"/knowledge-medium/pr-preview/pr-1890/chunks/FacadeVFS-C-_Jswnh.js\":\"7d795ae655d55a91\",\"/knowledge-medium/pr-preview/pr-1890/chunks/IDBBatchAtomicVFS-4V25DeUa.js\":\"f6a4d13d25888e4a\",\"/knowledge-medium/pr-preview/pr-1890/chunks/MemoryVFS-BmFcYkko.js\":\"0abcf42e7bd04012\",\"/knowledge-medium/pr-preview/pr-1890/chunks/OPFSCoopSyncVFS-BSdylcu-.js\":\"06053e402ca21412\",\"/knowledge-medium/pr-preview/pr-1890/chunks/OPFSWriteAheadVFS-BT7dli9h.js\":\"f8608adfa90e27e6\",\"/knowledge-medium/pr-preview/pr-1890/chunks/Preview-C4hhLQte.js\":\"f6dc7bce236eae74\",\"/knowledge-medium/pr-preview/pr-1890/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1890/chunks/card-B4s2Rd3g.js\":\"585baaa2f78f3665\",\"/knowledge-medium/pr-preview/pr-1890/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1890/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1890/chunks/dist-BArWKLOC.js\":\"e6f0d72624497243\",\"/knowledge-medium/pr-preview/pr-1890/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1890/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1890/chunks/mc-wa-sqlite-CViA4Rwh.js\":\"d16622f999d64e42\",\"/knowledge-medium/pr-preview/pr-1890/chunks/mc-wa-sqlite-async-DyTCBSIC.js\":\"6767b9b6921fce23\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-B2_5EhPF.js\":\"4de4a44ddff94bfb\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-B3yNpwws.js\":\"b1858ce2ce84644e\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-BICvnB7K.js\":\"6cbcc4c80e229445\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-BhEyPVrP.js\":\"4d86cd6a5341cd94\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-BopHPQEc.js\":\"aac38cbd2bbb6758\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-DeD8X8WE.js\":\"7c81319cb5db22fe\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-DmGjxnd1.js\":\"0fd65fa34bb62839\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-H3en1Ic4.js\":\"23f8708bd5f093f9\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-dom-server-legacy.browser.production-Deocoa6_.js\":\"5b4efa1ee9d66488\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-dom-server.browser.production-zJhDW0yR.js\":\"b65befa74050c961\",\"/knowledge-medium/pr-preview/pr-1890/chunks/react-dom-server.edge.production-DZvgrYG1.js\":\"1b76a49921d8e6b4\",\"/knowledge-medium/pr-preview/pr-1890/chunks/server.browser-CE5jJM07.js\":\"6d9312cfeff501a1\",\"/knowledge-medium/pr-preview/pr-1890/chunks/textarea-DYrmnBtw.js\":\"d5a2858737c75146\",\"/knowledge-medium/pr-preview/pr-1890/chunks/ui-BDEXFK9l.js\":\"2ebedb19174681e5\",\"/knowledge-medium/pr-preview/pr-1890/chunks/wa-sqlite-CgMEm8nV.js\":\"88c99187c826c1e4\",\"/knowledge-medium/pr-preview/pr-1890/chunks/wa-sqlite-async-C0DbaxPK.js\":\"c81d14c064849915\",\"/knowledge-medium/pr-preview/pr-1890/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1890/extension-utilities.css\":\"ebbf920af5d994cb\",\"/knowledge-medium/pr-preview/pr-1890/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1890/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1890/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1890/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1890/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1890/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1890/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1890/src/App.js\":\"ed308389a7879809\",\"/knowledge-medium/pr-preview/pr-1890/src/appUpdate.js\":\"c107534aca302bf4\",\"/knowledge-medium/pr-preview/pr-1890/src/appVersion.js\":\"1a4d380dd940c5fc\",\"/knowledge-medium/pr-preview/pr-1890/src/bootstrap/initialLayout.js\":\"e173cc58d0d36938\",\"/knowledge-medium/pr-preview/pr-1890/src/bootstrap/openWorkspaceData.js\":\"ccdf09970cbfadd6\",\"/knowledge-medium/pr-preview/pr-1890/src/bootstrap/resolveWorkspace.js\":\"98a6b337a898600a\",\"/knowledge-medium/pr-preview/pr-1890/src/bootstrap/workspaceBootstrap.js\":\"6328f65d047adcb1\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockComponent.js\":\"bc1b709015ca0752\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockCrumbs.js\":\"c4894f277dc9d229\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockEditor.js\":\"dc40182ef0cc5cd5\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockLoadingPlaceholder.js\":\"a32b86bcf79f4156\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockProperties.js\":\"3317ef4952615a0f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/BlockSearchPicker.js\":\"42b3f0cfd2759d0e\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ConfirmBulkDeleteDialog.js\":\"9595f127009e1e84\",\"/knowledge-medium/pr-preview/pr-1890/src/components/DividerHandle.js\":\"2d0392a4ed12711f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/DraftEditor.js\":\"982e7a3ff94b3c3a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/GutterPill.js\":\"76f8d21a772fdfa6\",\"/knowledge-medium/pr-preview/pr-1890/src/components/Header.js\":\"607efbe2fb826d4d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/LazyBlockComponent.js\":\"a95fda9dc914f670\",\"/knowledge-medium/pr-preview/pr-1890/src/components/Login.js\":\"301bfa706b9aa4db\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ZoomableSurface.js\":\"b53a6e243a8e5f0d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/editModeKeepalive.js\":\"3b712440a76a9582\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b7975c3015afcefc\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"840ad24dbe456a0a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/RefPropertyEditor.js\":\"bd5a9c8c717f1c2f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/RefTargetTypePicker.js\":\"c3effdeb09030177\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/SelectPropertyEditor.js\":\"f01837ea626b667f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/TypesPropertyEditor.js\":\"6679c1a085336544\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/defaults.js\":\"cdddf63c01048f24\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/kernelValuePresets.js\":\"b414934292a97f49\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/selectablePresets.js\":\"95036c7b27343e23\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyEditors/typesPropertyUi.js\":\"3d61ae73158e6f19\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/AddPropertyForm.js\":\"fd0e5d4a55c774ca\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/PropertyPicker.js\":\"0794611cf11bfa48\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/PropertyRow.js\":\"180f9dbfde562d21\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/Rows.js\":\"a4e333c1d73f9824\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/actions.js\":\"a7ea35591e1951cf\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/declarationOnly.js\":\"d916b5ef06660401\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/layout.js\":\"3577d21d399c6d87\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/model.js\":\"eb9cc8ebb0f34244\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/shapeUi.js\":\"ddb1466cc061ae90\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/shapes.js\":\"cdc9bb1d0832b5b9\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/usePropertyEditingActivation.js\":\"4b59a323004e9f78\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanel/visibility.js\":\"bd04f73013bbed6f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/propertyPanelSections.js\":\"55930a3573b7ec9d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/BlockEmbed.js\":\"da61005bc037ad6e\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/BlockLink.js\":\"3749d3b381d9359a\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/BlockRef.js\":\"f02d5adee8a24e9e\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/CompactReferenceLink.js\":\"76936d3ddba8ab09\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/ReferenceLink.js\":\"ea05fe3371243472\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/cycleGuard.js\":\"d1dad9a3f3d8aaee\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/cycleGuardContext.js\":\"29e2ab658e63638f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/linkInteraction.js\":\"8093a8fd83d240a1\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/referenceLayout.js\":\"1f8513086fa5f63c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/references/useBlockRefAncestors.js\":\"bb26bf7783b2a5e5\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BlockGutter.js\":\"e49655612a71d278\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BlockInfoDialog.js\":\"acc7770756cab4b2\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BlockReadText.js\":\"2ff485bb11788854\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BlockTypeBlockRenderer.js\":\"0a9f681b1c2194ea\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/BulletHoverCard.js\":\"14409de71e97270f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/CodeMirrorContentRenderer.js\":\"f211ed27883b21fb\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6abe5e9959726a5b\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/ColumnResizeHandles.js\":\"39418aa860cfe8f4\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b8cf6e29836235e3\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/DefaultBlockRenderer.js\":\"27121d97debb553e\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/LayoutRenderer.js\":\"c34cf3298f253ed0\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/MarkdownContentRenderer.js\":\"953ded009d814e02\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/MissingDataRenderer.js\":\"56ab503a771e6d05\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/PanelRenderer.js\":\"78c12a4df4cdbfdb\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/PropertySchemaBlockRenderer.js\":\"2d8b16dcf4ca146b\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/TopLevelRenderer.js\":\"349b995fb160fe79\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/blockGutterMode.js\":\"82f70b1edeb74485\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/blockTitleText.js\":\"991bf6135a6331ca\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/fieldCreationKeydown.js\":\"c033901d19d568a1\",\"/knowledge-medium/pr-preview/pr-1890/src/components/renderer/layoutRootContext.js\":\"e6b66a52fe9966a6\",\"/knowledge-medium/pr-preview/pr-1890/src/components/typeChip/TypeChip.js\":\"2e892256bd700398\",\"/knowledge-medium/pr-preview/pr-1890/src/components/typeChip/chipStyle.js\":\"993d40c3ac4a3b1f\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/anchored-floating.js\":\"df825d735b1695d7\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/button.js\":\"505797c564c18e27\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/card.js\":\"05bf1e7982a7ff72\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/checkbox.js\":\"967ebe79f9455b5d\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/collapsible.js\":\"5db9c7bbe4a8587c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/command.js\":\"37e2aa36063aa3fa\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/context-menu.js\":\"6142ddf7f5239a32\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/dialog.js\":\"c2f1514c1446f1f9\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/dropdown-menu.js\":\"28472bcb688db0df\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/floating-listbox.js\":\"eeebb8d817ceec41\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/index.js\":\"e1afbb0f8bb3c922\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/input.js\":\"ac4a7da39f35d773\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/kbd.js\":\"ecbedafd6f4cdff1\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/label.js\":\"a176d9f1a111392c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/ui/textarea.js\":\"ae13d3a030234125\",\"/knowledge-medium/pr-preview/pr-1890/src/components/useEditModeYieldKeepalive.js\":\"effc6f3e383cec11\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/BootFallback.js\":\"44498565a0e2b5f5\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/FocusedRowLazyMount.js\":\"e1518cf8d57f1746\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/LazyViewportMount.js\":\"a1af0f21541dffaa\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/LocalDbCorruptionFallback.js\":\"1a46dfec3bd79cf6\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/error.js\":\"094809ce00eac201\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/lazyMountRegistry.js\":\"a02f7a0c226b0b04\",\"/knowledge-medium/pr-preview/pr-1890/src/components/util/suspense.js\":\"6cd7109fdf79ea3c\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/CreateWorkspaceDialog.js\":\"2b14cb26cac80559\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/PendingInvitations.js\":\"88c0fe5720f249b6\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/SyncProgress.js\":\"2dd6367206108eb0\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/UnlockProgress.js\":\"90419cfdda92ba24\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/WorkspaceKeyGate.js\":\"3620318832158dcf\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/WorkspaceSettingsDialog.js\":\"ec4deb6895fbccf8\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/WorkspaceSwitcher.js\":\"e5952b54c3f499b4\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/WorkspaceSyncGate.js\":\"784767a73f51c114\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/ConversionFlow.js\":\"a44362f67bf4bc83\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/ConversionFlowHost.js\":\"8f7a57c898daffea\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/EncryptionSection.js\":\"1ba75d10cfe456e8\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/attachmentPrompts.js\":\"59bd549a4c789e9b\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/bundleFolderPrompts.js\":\"41d583abd7dd67e9\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/conversionFlowDeps.js\":\"5693b8e5aae7f652\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/conversionFlowStore.js\":\"76dd01e2fb8127b3\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/flowUi.js\":\"c4e584e97a09d8ab\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/conversion/useConversionRun.js\":\"b011bcfaa73c91c5\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/keyUi.js\":\"a0a1858b81e573f8\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/useCloseOnKeyLoss.js\":\"8ebd83fccd734dc3\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/useCloseOnServerE2ee.js\":\"e342dd62491c52b9\",\"/knowledge-medium/pr-preview/pr-1890/src/components/workspace/workspaceUnlocked.js\":\"a870d626f0d0770b\",\"/knowledge-medium/pr-preview/pr-1890/src/context/backgroundSubtree.js\":\"5f45a5683f9f4c58\",\"/knowledge-medium/pr-preview/pr-1890/src/context/block.js\":\"48a9411eebaabb17\",\"/knowledge-medium/pr-preview/pr-1890/src/context/layoutWsContext.js\":\"e3f0ff6b432200bc\",\"/knowledge-medium/pr-preview/pr-1890/src/context/propertyDisplay.js\":\"b9471ce371883832\",\"/knowledge-medium/pr-preview/pr-1890/src/context/repo.js\":\"2c6ebb84dbdcabb6\",\"/knowledge-medium/pr-preview/pr-1890/src/data/aliasClaim.js\":\"a31ff4ccf2b089d2\",\"/knowledge-medium/pr-preview/pr-1890/src/data/aliasSeatNamespace.js\":\"6955f51d884442a3\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/blockData.js\":\"73f2a050b81fdbff\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/blockType.js\":\"4f700546be22e016\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/changeScope.js\":\"fbc5ae459a380aad\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/codecs.js\":\"dade08bd652dd8ca\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/derivedData.js\":\"184924aecaf82fa0\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/errors.js\":\"be21745c12026d14\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/events.js\":\"ae72454cb7100384\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/handle.js\":\"1eed63e0a6a3ce9b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/index.js\":\"ccbca6feb8959933\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/mutator.js\":\"f873844794ccab97\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/processor.js\":\"caf72859f7593bbc\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/propertySchema.js\":\"304ef2d798e37e3b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/query.js\":\"3c1e975e9c25cb9f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/sameTxProcessor.js\":\"ce4a1eef2320adfd\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/schema.js\":\"1eed63e0a6a3ce9b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/tx.js\":\"1eed63e0a6a3ce9b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/typedBlockQuery.js\":\"51e1061a365c09c1\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/user.js\":\"51fab9c473f1ab01\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/valuePresetCore.js\":\"6eee0cae4f869fb0\",\"/knowledge-medium/pr-preview/pr-1890/src/data/api/valuePresets.js\":\"3b7dbfc69624ba31\",\"/knowledge-medium/pr-preview/pr-1890/src/data/attachmentCleanerIOVerb.js\":\"233be620e3f2c1c9\",\"/knowledge-medium/pr-preview/pr-1890/src/data/block.js\":\"96f57e58a36d27e0\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockCache.js\":\"52251ddc03f116cb\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockId.js\":\"548986779560e019\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockLiveness.js\":\"ec9a2cef10398bed\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockMerge.js\":\"c0aef08d8088fee1\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockSchema.js\":\"4891eea4d2188d98\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockTypeLookup.js\":\"80fc390d10cab2f2\",\"/knowledge-medium/pr-preview/pr-1890/src/data/blockTypes.js\":\"c8ca0e61be7f4641\",\"/knowledge-medium/pr-preview/pr-1890/src/data/childrenView.js\":\"7f8a7f73b2da3c03\",\"/knowledge-medium/pr-preview/pr-1890/src/data/clientContext.js\":\"dfc20bc9c7365948\",\"/knowledge-medium/pr-preview/pr-1890/src/data/dbFileSiblings.js\":\"c4a61d0316ff4223\",\"/knowledge-medium/pr-preview/pr-1890/src/data/definitionSeeds.js\":\"237b57528ede66ac\",\"/knowledge-medium/pr-preview/pr-1890/src/data/derivedIds.js\":\"eaf533316e76d598\",\"/knowledge-medium/pr-preview/pr-1890/src/data/drawnSubtree.js\":\"016611e4f145ad33\",\"/knowledge-medium/pr-preview/pr-1890/src/data/facetBridge.js\":\"2fd1607a7bf932cc\",\"/knowledge-medium/pr-preview/pr-1890/src/data/facets.js\":\"f51051a676678d92\",\"/knowledge-medium/pr-preview/pr-1890/src/data/globalState.js\":\"9a89981357ca3781\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/aliasClaimRederiveProcessor.js\":\"3410312cc84a049f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/ancestorBatch.js\":\"8091d9060356fb44\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/blockTypeTypeifyProcessor.js\":\"06b5193188c529ad\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/clientSchema.js\":\"536e90517c0676ea\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/commitPipeline.js\":\"4b3585fc901e3384\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/devAssertions.js\":\"7c877d93fd47cb75\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/firstSync.js\":\"77dfcd21eb428ba6\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/freshInitialLoad.js\":\"1abbd2cd41f6e7bc\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/graphBackfillClaim.js\":\"1edd57237fa6a126\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/handleStore.js\":\"748a9156daac474e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/idleMarkerJobs.js\":\"a360c8f5c2e25787\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/initialDownload.js\":\"9941bd65a4bb5790\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/initializeClientDatabase.js\":\"10d92fab62e9438e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/jsonCanonical.js\":\"30eb8dbb97bcb5be\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/kernelInvalidation.js\":\"be206ffb3ffa0e5f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/kernelProcessors.js\":\"a2db6f58d3a29fa6\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/kernelQueries.js\":\"a7d4930049e7d741\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/mergeTypeMembershipProcessor.js\":\"c28618db50bd47a5\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/normalizeReferencesProcessor.js\":\"f3db10b8cae298a3\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/poolInstrumentation.js\":\"d192887c38ac5655\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/processorRunner.js\":\"504f61497caa26ef\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyCellBackfill.js\":\"7a1868ba62289c13\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyChildMint.js\":\"ab808005997dd03d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyChildrenProcessor.js\":\"0dfc07da09709f47\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyDefinitionChangeProcessor.js\":\"03654c1338526736\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyDefinitionSynthesis.js\":\"d27a8ebc03bba226\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyKeyScan.js\":\"e99e3d42a874046d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertySchemaResolution.js\":\"7434903849ae0d1e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/propertyValueEdits.js\":\"93c3cdfe55caf25d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/raiseProtocol.js\":\"88b33f8d6e79d24e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/readBatch.js\":\"184039e7bac5c7ea\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/refProjection.js\":\"12373c26bef6baef\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/referenceTargetLookups.js\":\"b095c7bbb8832252\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/referenceTargetProcessor.js\":\"c05cba0aba06fcdb\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/replayMerge.js\":\"47c5e9f701675d4f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/sqlBinds.js\":\"eba71acfff10b731\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"838ca68d011969d2\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/arrivalProcessors.js\":\"c99c7b11197cdd64\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/invalidate.js\":\"2c1c9b49d225e76d\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/materialize.js\":\"5aeb2e039693fbaf\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/observer.js\":\"84a1e2d2e1590125\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/syncObserver/reconcile.js\":\"13b67686d4478dcf\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/timingMetrics.js\":\"eaad53fc95399ac1\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/treeQueries.js\":\"35824c775291590f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/txEngine.js\":\"fc09f273f711c203\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/txSnapshots.js\":\"8ff71041c7857b82\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/typedBlockQuery.js\":\"7f9100cc2de78ea3\",\"/knowledge-medium/pr-preview/pr-1890/src/data/internals/undoManager.js\":\"fe2ea6afae9a2a34\",\"/knowledge-medium/pr-preview/pr-1890/src/data/invalidation.js\":\"215a5dcbf4f730cc\",\"/knowledge-medium/pr-preview/pr-1890/src/data/kernelDataExtension.js\":\"daaafcad6f536d6a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/kernelPage.js\":\"2703347d0a1fed3a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/kernelValuePresetCores.js\":\"00e46fd81e3d6683\",\"/knowledge-medium/pr-preview/pr-1890/src/data/localDbCorruptionSignal.js\":\"610817cb23fefda9\",\"/knowledge-medium/pr-preview/pr-1890/src/data/localDbStorage.js\":\"70f71b0d284be843\",\"/knowledge-medium/pr-preview/pr-1890/src/data/localDbVfs.js\":\"dec963c796b1b2f1\",\"/knowledge-medium/pr-preview/pr-1890/src/data/localSchema.js\":\"44a20b20b4b5e20b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/maintenance.js\":\"7dce7f917fce9e3a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/mergeProperties.js\":\"db60b457048a4c76\",\"/knowledge-medium/pr-preview/pr-1890/src/data/metricsConsoleHook.js\":\"6f40a4ddcbaadf0e\",\"/knowledge-medium/pr-preview/pr-1890/src/data/migrationsPage.js\":\"61ecee4120858b2f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/mutators.js\":\"bc898653a73f272c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/orderKey.js\":\"ade4f6bdb6616034\",\"/knowledge-medium/pr-preview/pr-1890/src/data/orderKeyPlacement.js\":\"fb2cf3b1e84ae638\",\"/knowledge-medium/pr-preview/pr-1890/src/data/outlineSurface.js\":\"f350e92b519bcc4f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/pendingEditorContent.js\":\"60b31aa9f5deac0b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/pendingUploadsSql.js\":\"c908d5fded0cf5cd\",\"/knowledge-medium/pr-preview/pr-1890/src/data/pluginStateExtensions.js\":\"65c1d1ec5ec17b44\",\"/knowledge-medium/pr-preview/pr-1890/src/data/powerSyncLogger.js\":\"e1381c7f63ed56e1\",\"/knowledge-medium/pr-preview/pr-1890/src/data/projectorRuntime.js\":\"8a55d6e6b107daf2\",\"/knowledge-medium/pr-preview/pr-1890/src/data/properties.js\":\"463cd5fea8c5eb1a\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertiesPage.js\":\"e2eaf324ab041648\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyChildren.js\":\"5bb89538107286f4\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyDefinitionFanout.js\":\"5504a723587933dc\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyDefinitionMetadata.js\":\"06b7d120e825fbae\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyDefinitionRegistry.js\":\"540e3fc7745fb5ca\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyDisplayMode.js\":\"bdd6a7466def0a54\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertyRowCreation.js\":\"6948f7e5ae565b4b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertySchemaCreation.js\":\"83396c40409f6bda\",\"/knowledge-medium/pr-preview/pr-1890/src/data/propertySeeds.js\":\"255e4257fb912e69\",\"/knowledge-medium/pr-preview/pr-1890/src/data/recentsPage.js\":\"5455d4f0246a435b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/refTargetComparableProperty.js\":\"d16c96ece8c9e166\",\"/knowledge-medium/pr-preview/pr-1890/src/data/referenceBlock.js\":\"66995573589901ca\",\"/knowledge-medium/pr-preview/pr-1890/src/data/rejectedUploads.js\":\"a6c620cca8041304\",\"/knowledge-medium/pr-preview/pr-1890/src/data/releasePowerSyncConnection.js\":\"cdcd502070dc6d6b\",\"/knowledge-medium/pr-preview/pr-1890/src/data/repo.js\":\"380b3220fa0cf3f6\",\"/knowledge-medium/pr-preview/pr-1890/src/data/repoProvider.js\":\"6add2a590723ee59\",\"/knowledge-medium/pr-preview/pr-1890/src/data/rowProperty.js\":\"1da158d11d911c22\",\"/knowledge-medium/pr-preview/pr-1890/src/data/searchFilter.js\":\"06afda9bb1271c49\",\"/knowledge-medium/pr-preview/pr-1890/src/data/seedIdentityLedger.js\":\"ec6567334edd5ec9\",\"/knowledge-medium/pr-preview/pr-1890/src/data/stateBlocks.js\":\"103459d14b49fae9\",\"/knowledge-medium/pr-preview/pr-1890/src/data/structuralEditPolicy.js\":\"19976661d12a8719\",\"/knowledge-medium/pr-preview/pr-1890/src/data/structuralInsert.js\":\"14b5376a691a8c9f\",\"/knowledge-medium/pr-preview/pr-1890/src/data/subtreeDelete.js\":\"f11fa7bc96628eb2\",\"/knowledge-medium/pr-preview/pr-1890/src/data/syncStreamLock.js\":\"0201413ef63b6b97\",\"/knowledge-medium/pr-preview/pr-1890/src/data/syncedTableSqlRecognizer.js\":\"e6d5313261b603e8\",\"/knowledge-medium/pr-preview/pr-1890/src/data/syncedTableWriteGuard.js\":\"fe1bc33e3789cf87\",\"/knowledge-medium/pr-preview/pr-1890/src/data/targets.js\":\"b0b94b841ea2c8fa\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeColors.js\":\"68532c519ac75fac\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeDefinitionMetadata.js\":\"1588994211b39fb6\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeDefinitionRegistry.js\":\"40eaa492db09be84\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeExtraction.js\":\"f1af00a88bc67b8c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeInitialValues.js\":\"85d24533045615e4\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typePropertyGroups.js\":\"a7aa48ea2118e409\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeSeeds.js\":\"c09ebe6218ef5e7c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typeTagger.js\":\"7348a70871c1e968\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typedRecords.js\":\"1d6714e4c8a9e7f8\",\"/knowledge-medium/pr-preview/pr-1890/src/data/typesPage.js\":\"ea3eab0f2ec9568c\",\"/knowledge-medium/pr-preview/pr-1890/src/data/userPrefs.js\":\"ec49656f6659fcbc\",\"/knowledge-medium/pr-preview/pr-1890/src/data/userSchemasService.js\":\"97b558dcb4880160\",\"/knowledge-medium/pr-preview/pr-1890/src/data/userTypesService.js\":\"1279120248d33454\",\"/knowledge-medium/pr-preview/pr-1890/src/data/valuePresetRegistry.js\":\"535c4a398d10bb27\",\"/knowledge-medium/pr-preview/pr-1890/src/data/visibleChildren.js\":\"78b6978073359606\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaceConversion.js\":\"6544db6619c21e73\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaceFirstSync.js\":\"908070072850b4a9\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaceIdNamespace.js\":\"3d1f32f0bef8d877\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaceSchema.js\":\"c428b4b86a4dc0c8\",\"/knowledge-medium/pr-preview/pr-1890/src/data/workspaces.js\":\"a18409fa39344c74\",\"/knowledge-medium/pr-preview/pr-1890/src/data/writeAheadLog.js\":\"c55e9ade0bc714e0\",\"/knowledge-medium/pr-preview/pr-1890/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/BlockPasteShellDecorator.js\":\"daa363116aa242e6\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/atTrigger.js\":\"eca10747eeac2e4e\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/autocomplete.js\":\"d3411416fdfe83e3\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/codeMirrorExtensions.js\":\"5a650f4f62f0d813\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/contentFlush.js\":\"246a0b78f2605eb0\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/defaultInteractions.js\":\"b9a5bee34c18a83b\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/editSettleSignal.js\":\"f45c0b7027b667b2\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/insertImage.js\":\"35fd8768397342e3\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/referenceCompletionRange.js\":\"268ad716b94b9615\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/referenceTargetTypes.js\":\"6937244ee58aa124\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/syntaxContext.js\":\"93831fffd2c92e2e\",\"/knowledge-medium/pr-preview/pr-1890/src/editor/triggerMatch.js\":\"2d4c9db6e4ecc147\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/AppRuntimeProvider.js\":\"34b0531c68451d8c\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/BlockFocusShellDecorator.js\":\"2bf6de274a4966f7\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/ExtensionRenderBoundary.js\":\"b247725f4d789100\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/PanelContentRecovery.js\":\"b4a12a9e4c3dc9a4\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/apiCatalog.js\":\"18de3764421626cd\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/approveExtensionHere.js\":\"499dab9eebfe3bf2\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/armedCutAppMount.js\":\"29b09166cbe63974\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/batchableKeyedStore.js\":\"b9e3661e0fa56124\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/blockInteraction.js\":\"27da47eae2bd98b0\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/blockSelectionAction.js\":\"5df3a8506790e77d\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/compileExtensionModule.js\":\"a0a82a65b9e52c67\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/compiledModuleCache.js\":\"29fd6fe48b392140\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/continuousGestures.js\":\"189f1030e9c49b27\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/core.js\":\"cf0d12476745d4ae\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/defaultRenderers.js\":\"10e278bf944cd2cc\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/definitionFanoutAppMount.js\":\"cc3d41f75c63e91b\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/dialogAppMount.js\":\"08ac62e172482523\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/dynamicExtensionSeeds.js\":\"5b76b90c8fd0c7b2\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/dynamicExtensions.js\":\"0964df5b29b232b9\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/exampleExtensions.js\":\"d07357dbd7cbafde\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionApprovalStatus.js\":\"629054bdfb3d48bf\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionLoadErrorToast.js\":\"4a85878d1399c1fa\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionLoadErrors.js\":\"32b7d374c0ef00c3\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionLookup.js\":\"98acff1f09d12367\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionToggles.js\":\"da47f8c7d9776f83\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/extensionUtilitiesCss.js\":\"cbfc19c5e657118d\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/kernelPageDeletionGuard.js\":\"cac3f63e2d171907\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/liveRuntime.js\":\"5886e829fce1e0c9\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/openExtensionsSettings.js\":\"b22c56e88f1995f7\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/overridesCache.js\":\"5fb984673c99d4e6\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/pluginIds.js\":\"5ddb3e55e4ec2333\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/processorRejectionToast.js\":\"68ea3386fd5db1b0\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/runtimeActions.js\":\"400aed43b33b6023\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/runtimeContext.js\":\"a50da276eba1f98d\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/staticAppExtensions.js\":\"d04dc8c4a8a40408\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/staticDataExtensions.js\":\"b3d63224c1ffed44\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/toastAppMount.js\":\"a5c9674aa796d967\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/useOverrides.js\":\"b10937277faeccf7\",\"/knowledge-medium/pr-preview/pr-1890/src/extensions/useShortcutSurfaceActivations.js\":\"eedf0ac8da24ca96\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/discoverToggleTree.js\":\"e76e81a6d1522e8c\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/facet.js\":\"494be010a7b6794c\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/resolveAppRuntime.js\":\"d8bc7233d1462bb7\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/runtimeEvents.js\":\"37ddce3a4253c266\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/togglable.js\":\"0706c63430a3429f\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/variantFacet.js\":\"54cc7a792f15760b\",\"/knowledge-medium/pr-preview/pr-1890/src/facets/verbFacet.js\":\"d22b1226e77b4939\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/block.js\":\"602fbbef37efa0fb\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/focusedChild.js\":\"dbdc83110e73a435\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/propertySchemas.js\":\"a76112c64ed09c60\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/typeRegistry.js\":\"2d81aad7b9aeb13c\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useAncestorCrumbs.js\":\"0d7d40578948aba9\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useAutocompleteListbox.js\":\"b616dd2c6eec95a1\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useDebouncedSearch.js\":\"e7e7a67e636f054a\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useDebouncedValue.js\":\"8af6c2152a10120a\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useFacetValue.js\":\"e18dd6250b5a0ce3\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useIsFocalRender.js\":\"f2b210ce50eb60f1\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useIsReadOnly.js\":\"87400bfb3a63a9bd\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useMaterializeBacklog.js\":\"adc9e1c5146f06d0\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useMinuteClock.js\":\"170c6c2bdffac9e7\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/usePanelLayoutProjection.js\":\"3ee8160b5fdd1c45\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/usePendingInvitations.js\":\"ffb63b67f6590901\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useRendererRegistry.js\":\"6dfe34f0571d469b\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useRetainedFieldRows.js\":\"7581395ef8655baf\",\"/knowledge-medium/pr-preview/pr-1890/src/hooks/useWorkspaces.js\":\"6a936b2f23809e96\",\"/knowledge-medium/pr-preview/pr-1890/src/lib/utils.js\":\"b075b93e54799cf3\",\"/knowledge-medium/pr-preview/pr-1890/src/main.js\":\"237b75a74375c23d\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/MarkdownImage.js\":\"0794bd6a71edf2db\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/blockSeparators.js\":\"4d638baa9a4b9d8b\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/context.js\":\"6f08fbba9ee05968\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/defaultMarkdownExtension.js\":\"f03e0ce9bc38f4f9\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/extensions.js\":\"878c66ab6aa290fb\",\"/knowledge-medium/pr-preview/pr-1890/src/markdown/renderMarkdownHtml.js\":\"e9dbaf37f5763897\",\"/knowledge-medium/pr-preview/pr-1890/src/minimal-editor.js\":\"c51a3c8d9a2b8977\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/armedCut.js\":\"0807c7f140ba9fff\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/captureMediaVerb.js\":\"68b664dcb2c8da06\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/clipboard.js\":\"0f9a94e5965c9202\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/decision.js\":\"2e4d44a2c24b8122\",\"/knowledge-medium/pr-preview/pr-1890/src/paste/operations.js\":\"ee454cb260bb4e97\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/account-header/AccountHeaderItem.js\":\"ae5200bcdf1781d9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/account-header/index.js\":\"431e2562ef30fc2b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e3dfc20a5c5f3f70\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/askAgent.js\":\"186614974e834396\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/askedStore.js\":\"d28ab1216364c900\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"4f6b553511f03825\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/chipState.js\":\"9793a5e938ae93c4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ecba8de2e089de64\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/index.js\":\"bf2ea48137524551\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"45c5a3cf3a2f779e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-dispatch-companion/schema.js\":\"ed71cb2afe60aa74\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/AgentTokensDialog.js\":\"779ee9916091166e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/BridgePairingDialog.js\":\"549ae9a350cf80ce\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/addMedia.js\":\"41ae0d0d774205a5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f6a4493929eab5ca\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/block.js\":\"9923fa71bbeb5376\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/context.js\":\"3d1ee2991ebddb24\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5e139e83d402931b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/index.js\":\"2eec18504bda9064\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/outline.js\":\"f75f9e1abc1c3186\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/properties.js\":\"103a371a458078da\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/refs.js\":\"97e428dc112bafa2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"5b401e623a58a9ac\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/search.js\":\"fe9e0c22d702a814\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/shared.js\":\"6f10bdfb11b9faed\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3be8c97710f56b3d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentViews/text.js\":\"7728bc44e57dfc7a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/agentWrites.js\":\"19b3125a4570b583\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/authoringCatalog.js\":\"5281ad1ac0449921\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/blockRefTargets.js\":\"c5ef6660096f6dbf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/bridge.js\":\"a9389b585e979158\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/bridgeLoop.js\":\"2944ea2b4f79e4c0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/changeHistory.js\":\"b5f5be25ad2cbb63\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/commands.js\":\"93945c03f57f4694\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/commentsCommands.js\":\"141f013fcad9efed\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/dataExtension.js\":\"b2255609d11bb2e7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/dataModelGuide.js\":\"0783106af0b5b06a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/dayPropertyInputs.js\":\"f07e98d59171c380\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/describeRuntime.js\":\"d4f73ee1c7b26ca2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/extensionLint.js\":\"f9e2a8594d8bf8e2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/grainAudit.js\":\"dd08662fed0b4f1e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/healthCommand.js\":\"747a523daeef23f8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/index.js\":\"2282827b8c422ed6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/presetIdentity.js\":\"13ec79f4123e2ac4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c4d9ee7befdb7e97\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/readMedia.js\":\"042d7223b7e7e2d8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/schema.js\":\"296d830d28119f64\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/serialization.js\":\"ecb2bdc63b83c415\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/targets.js\":\"88fb52548d943234\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/tokens.js\":\"40d3791dc100ed27\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/watchEvents.js\":\"f929d7ff543ac859\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/workspaceGuard.js\":\"3d97360b3b60d078\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/agent-runtime/writeCommands.js\":\"a777063f04a71ecc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/AliasCollisionToast.js\":\"ed384f95971e17a4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/DuplicateNameBanner.js\":\"0318f97722995957\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/collisionMerge.js\":\"bf78d1168b554d1c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/dataExtension.js\":\"7ec52f2b14943b88\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/index.js\":\"90a411b1823308b7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/mergeCollisionAction.js\":\"a44e0b49580c0d1e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/pageStyling.js\":\"58abcfbad5271cef\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/rejectionToast.js\":\"c4573b11c7eb00b4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/alias/syncProcessor.js\":\"c45b78200bedb529\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/actions.js\":\"9178b9b80bada2a5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/addComment.js\":\"1666d5728b63ff8b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/anchor.js\":\"d02f175928c8f058\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/anchorState.js\":\"85fe9ac18e8d169b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/commentLinks.js\":\"a5cde0f624707433\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/confirmThreadDeletion.js\":\"2f7d9f508556a806\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/container.js\":\"9ee0c7f1d376efb9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/dataExtension.js\":\"36e5a9019dfafd4e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/deleteComment.js\":\"1cc9322c8e56d11c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/highlights.js\":\"f90f96b7104724c6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/index.js\":\"9c011206fb8ae62f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/linkedCommentsPill.js\":\"f6fed488d1295bb7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/margin.js\":\"04beb4475ac0e961\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/marginAnchorLinks.js\":\"8efb5292d1d2900a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/marginSchema.js\":\"f1ab9208e8c276bc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/newComment.js\":\"12d3e76647773f89\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/ownThreadPicker.js\":\"7c14fd4a869d534e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/placement.js\":\"13f90390c0be3bf8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/queries.js\":\"46e4fe47a39522b4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/quotePosition.js\":\"8cb6bb904ffc9025\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/quotedIn.js\":\"2c5e1438c75518bf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/quotedRange.js\":\"ee81550b0f7f3c62\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/rangeRefs.js\":\"875c654bf82ed656\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/readHighlights.js\":\"ad30567acef83190\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/readSelection.js\":\"16495a0d5d9be105\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/readSelectionUi.js\":\"618bfc78060b7d93\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/reanchor.js\":\"970326c1eddcc84b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/schema.js\":\"c3495f5b073559c3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/scope.js\":\"b111587b75fd460f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/scopeThreads.js\":\"093943883610f00f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/splitRetarget.js\":\"b7a43e4526cae77b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/suggestionCard.js\":\"25b5aac23b214c33\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/suggestions.js\":\"f116c696cfd12d09\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/summaries.js\":\"51876258488b4a0f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/summaryBatch.js\":\"5bbcce2a7a10f370\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/surface.js\":\"b734f1807eaba985\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/threadNavigation.js\":\"f67caf85d0918c2d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/threads.js\":\"b9251f84fdbc3b84\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/ui.js\":\"91965fa9630c6fb9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/annotations/uiStore.js\":\"6bc5ad403a78d7d0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/app-intents/appIntents.js\":\"2c53cc361b675745\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/app-intents/index.js\":\"4c4f4a7589a2a8a0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/app-update-prompt/index.js\":\"58d1adf168c91b0d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/app-update-prompt/status.js\":\"d94ba90b5b9f5a06\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f7ca7fa287986d36\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/MediaBlockRenderer.js\":\"7886c4345b112574\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/MediaDownLaneReplicator.js\":\"02547ff96e780339\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/MediaUploadReconciler.js\":\"6d83a81041d1aba1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/assetDownLane.js\":\"14a3fbc56f82eef3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/assetResolver.js\":\"99b0fb70c7e79979\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/assetUpload.js\":\"60cbb8b052d21187\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/attachmentCleanerIO.js\":\"ceb8c5c6e6ccfb6b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/supabaseAuditIO.js\":\"208fc0466a87cbd7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/blobStore.js\":\"79548f28ccff9854\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/browserMedia.js\":\"0e5dc463c934ca70\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/byteStore.js\":\"62e78502adfa7377\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/cleanerIO.js\":\"6f4abd16605d287a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/cleanupAttachments.js\":\"41e3d79379267ed0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/dataExtension.js\":\"eb28d1bf076f1589\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/downLane.js\":\"96529d4168713593\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/index.js\":\"9bac1427e27ea7aa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/insertImageContribution.js\":\"6207ea29a6814b4e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/laneArming.js\":\"87d8bab686dc9a32\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/laneLock.js\":\"e8e1d6822b2e62ab\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaBlock.js\":\"12e0e168a7879a1c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaCapture.js\":\"808102b83a955935\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaLanes.js\":\"07586f8450af0f55\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaViewers.js\":\"c30f06a0ca19e1f7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/mediaViewersFacet.js\":\"92fc1ba9609b0d17\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/pasteCapture.js\":\"699849e2c2b4837e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/resolver.js\":\"9881d4e2bcb52067\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/retryUploadsAction.js\":\"ac478791ef365cce\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/storagePaths.js\":\"afd006614bd474b7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadDrain.js\":\"df1509b6199b3059\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadLaneStatus.js\":\"04711e0bd433d398\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadReconcile.js\":\"ef1a39c0d6d19961\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadRecovery.js\":\"68ff1194fd37b89c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/uploadStore.js\":\"c8c4322d3492ffcd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/attachments/useAssetObjectUrl.js\":\"2ee5e79aef8cdf4e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"95a68c786c026fcb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/BacklinksViewSection.js\":\"8b66231d2d6b79a7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/facet.js\":\"b5328a96c9c1fe23\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/index.js\":\"acb4401124c96947\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks-view/prop.js\":\"476e6d925af3fc56\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/BacklinkFilters.js\":\"e6b70a6ac044c6e0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e67e950a27193e98\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/BlockEntry.js\":\"f22cd2279ed9303f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/LinkedReferences.js\":\"cc6ce8bebffaded4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"13cd55ab57378b9a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/dailyNoteDefaults.js\":\"962fcda695e481bd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/dataExtension.js\":\"b062a2984c372e9e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/edgeExclusions.js\":\"72980ec498c72e3e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/filterProperty.js\":\"88dcc517293c287a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/index.js\":\"4577b7bfafa49d32\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"813cb1dc1d3c8fcb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/applies.js\":\"c4d03d07cfd8c94c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/countQuery.js\":\"81c6fe600423be93\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7c258e9fa176a4e7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/index.js\":\"291cce21970151b6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"fc5fb8020caf2f1d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/presentationInvalidation.js\":\"cd35cbc7a6b3f293\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/propertyEditorOverride.js\":\"392530505e1084b5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/propertyFilter.js\":\"3c4c3e859d950a96\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/query.js\":\"a3880707a87606d0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/resolveFilter.js\":\"20e33bc0f146af1d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/sourceBatch.js\":\"e129a32913980641\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/sources.js\":\"aef4f8b378f68d78\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/useBacklinks.js\":\"1ddc6fc3ec956731\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"1baa10637d440b9c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/BirthdayCelebration.js\":\"0ba02079f165c030\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/BirthdayOverlay.js\":\"826db812261f3b72\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/gate.js\":\"c29dd79a335cf7c2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/index.js\":\"7599091e6cc4a94f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/birthday/wolfTheme.js\":\"365b824157d5d663\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/BlockDragLayer.js\":\"cbbe71b7c07f7a14\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/dragController.js\":\"2900317da71be1b5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/dropTarget.js\":\"ad22aef8b495e15c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/index.js\":\"202e616721a8393b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-drag/projection.js\":\"a5bf77bb1f80b2d2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-info/BlockMetaCard.js\":\"2b4907830638de93\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-info/index.js\":\"9354054c45b75a6a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/AddTagDialog.js\":\"5d6e03a69df8c646\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a3dfeefcfaefa4b0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/TagNameIssueHint.js\":\"ccc0d8e809eedd2c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/addTagAction.js\":\"b7c9fd2aaf2f9b39\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/appendTag.js\":\"360dc9dc77691973\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/config.js\":\"6f7efeb4ab77736e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/dataExtension.js\":\"7db7ae7540e852cf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/index.js\":\"886bb031b64d8ac5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/block-tagging/propertyEditorOverride.js\":\"f7336785f7f638a0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/BreadcrumbList.js\":\"1b3f6f70a4a0cd28\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"5f2de4b4a7cf2e3d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/Breadcrumbs.js\":\"ccea1dce4a4746b0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"dd1bf5aac86b8ae4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"93528628fa709141\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/index.js\":\"31a0a98160cd3b6f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"81d4084d9210b4bc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/CharacterCountItem.js\":\"b4efc80b812a38b1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5c26a12ee47e68b9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/actions.js\":\"2b11b9026b03ca50\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/blockType.js\":\"dc3e23b902d41c41\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/charCount.js\":\"a15ec3d2ddce921d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/dataExtension.js\":\"ce3080ad46efd228\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/index.js\":\"071b148f83f43212\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/profiles.js\":\"8ba2ee6712c56d77\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/properties.js\":\"a2600abe54940a9a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/subtree.js\":\"4559dd69b4eed17f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/character-counter/textCounts.js\":\"753e969a3dff8fe7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/colemak-keybindings/index.js\":\"0f5d1502f996e2f0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/CommandPalette.js\":\"336e28710de74c35\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/HeaderItem.js\":\"bca4f21ce1c22b9e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/context.js\":\"8d81bf20ae2eb944\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/index.js\":\"7fdd4a384e78876a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/selection.js\":\"1cb6ad782099242c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/toggleStore.js\":\"4c6359a18ccd9e3c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/command-palette/useCommandPaletteActions.js\":\"32da3274a5962aad\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/ContributorBadges.js\":\"63d0f9f3fd4b0387\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/ProfilePicture.js\":\"3c326be0a98e65b5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/author.js\":\"6537fee7a33deb8f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/codeMirrorExtensions.js\":\"240ce955dcd3706b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/dataExtension.js\":\"4c5d3b24ee914df6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/index.js\":\"18876ffbe8a38e1b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/mentionAutocomplete.js\":\"7dfa77e0df15adb1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/processor.js\":\"801e3a1d99929bd0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/profiles.js\":\"7c917aafc05dbc3c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/queries.js\":\"8e6c1b3eb75eaf6b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/schema.js\":\"f8442a459a366799\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/contributors/useCommentAuthor.js\":\"e19f95886bdec5d1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"09672423767ba1d5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6689c67bf0ab592e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/index.js\":\"b86ff813c549034e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d6efa6315f5f2b2d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"bfc22f8d1bfba5ff\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/CalendarGrid.js\":\"35779ae4efd2e364\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DailyNotePicker.js\":\"17a43cdf4d7f222a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b8a76b5d9fa0ac8c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DateNavDecorator.js\":\"2502818038056bb0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DateScrubOverlay.js\":\"39cd52939f98e914\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DayPropertyControl.js\":\"438bc257e9c9b902\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/DayValueReferenceControl.js\":\"3a5dd97354fc0374\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/HeaderItem.js\":\"eea7202503fbc5df\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/ReschedulePicker.js\":\"bb2786f19c69d889\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/SpreadDatesDialog.js\":\"87a9f6750f9da97a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/actions.js\":\"c6b8c835c8750feb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/blockDateAdapter.js\":\"cfd6ea49013bd309\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/calendar.js\":\"e7bd76bb61443be5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dailyNotes.js\":\"224b730089a94a6d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dataExtension.js\":\"f941af1b3cabc5ff\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dateScrubActions.js\":\"b5c0f611b25304d2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dateScrubGesture.js\":\"5118cfa15592cc50\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e77853387d3a2528\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4717fcadaa926b2a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dayProperty.js\":\"b6dba80c81693ae6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"c626e0f7641e3872\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/deletionGuard.js\":\"e930643fa623372a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/dueQuery.js\":\"704060c55a014b47\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/index.js\":\"7da718be2553decc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/landing.js\":\"c5d27b7f68256f92\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/localSchema.js\":\"6e392518e4320f0f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/referenceDateAdapter.js\":\"fb7365bab4c7bdbd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/rescheduleAction.js\":\"a2b62d46dc99f38d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/schema.js\":\"29dbcf9c6e96e851\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/spreadBlockDates.js\":\"355640249beea830\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/spreadDatesAction.js\":\"bd6f04acf2b95288\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/today.js\":\"e518d4228ce32f6c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"7e776f48e85f7757\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ce158716532ecefa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/audit.js\":\"8ff6038768e9601c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/auditAction.js\":\"0bf39849bdc4b216\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/auditRanges.js\":\"257a4a052b4c840e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/diagnosticsSource.js\":\"66e0ba37a7496c9f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/divergenceScan.js\":\"8c598630baec5c97\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/index.js\":\"784aa1a74755fc9d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/propertyChildrenChecks.js\":\"49a760e6d59d98a1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/referencesMirror.js\":\"0b4dff134830c2e3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/rowJson.js\":\"ce4905efa52d7474\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/schedule.js\":\"e9cd6f1b29b063fe\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/data-integrity/store.js\":\"2d5990dd39867536\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-maintenance/action.js\":\"612ab809b0f57a3b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-maintenance/index.js\":\"ef500f17b82b70cf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-maintenance/plugin.js\":\"d33b6336a0c51f51\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2a765b194dc5adaa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/actions.js\":\"38e64454bcd57f63\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/changeMarker.js\":\"50ea985ab0351973\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/diagnostics.js\":\"c22129c456e90ee8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/fileSystemAccess.js\":\"52a1160841f14f4d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/filenames.js\":\"d71b4093f7728723\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/index.js\":\"276aaa5697bc2bd8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/mirror.js\":\"535161a75e9539c0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/runLock.js\":\"00e5ddb44f252eb2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/runtimeHealth.js\":\"fe9e39b51f8be466\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/schedule.js\":\"d94b974818fe5948\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/db-mirror/store.js\":\"7cfa37b70142d60c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/default-themes/index.js\":\"a7f1bd641669d065\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/default-themes/themes.js\":\"b32e9545f4671775\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/diagnostics/facet.js\":\"d910231fc6639b1d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/diagnostics/useDiagnostics.js\":\"6bfe9c55605e3c13\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extension-prompts/dismissals.js\":\"ad9aee7bb933a41e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extension-prompts/index.js\":\"474b11ed6d436b93\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extension-prompts/status.js\":\"df53aa932987e194\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extension-prompts/store.js\":\"2d5d4346a6fdfa5a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"6a357d8746182112\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f8edf55a61bdef8f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/actions.js\":\"b865a2907575dfb1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/config.js\":\"b447b2041b79e9cc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/dataExtension.js\":\"b4363ddfe2ab4975\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/effect.js\":\"7a51b5e6ad7f1dc4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/index.js\":\"479d0dae7594dbc0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f44939e4fca8377e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extensions-settings/useToggleTree.js\":\"fd6e58d938f98b78\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/ExtractTypeDialog.js\":\"ba3f1dea02f698bc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"664d18a574441f08\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/PropertyShapePicker.js\":\"b1f8b67a96be2f38\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/action.js\":\"1102052781559a23\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/extract-type/index.js\":\"7f2c9200ec2b7523\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/FindReplaceDialog.js\":\"ba3ed750d1a02c42\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/HeaderItem.js\":\"954387afac417c57\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/dataExtension.js\":\"8676acd0ecde26f6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/index.js\":\"7481c5b3e969a3e9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/search.js\":\"e7c25ef985c1d09f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/toggleStore.js\":\"bf92acbd8f12c6db\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/LocationPropertyEditor.js\":\"82affd6a1b837a6c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/MapView.js\":\"5c065703b28381ba\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/blockTypes.js\":\"8d4eec7985fbeee2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/codeMirrorExtensions.js\":\"758621029b237a7e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/createOrFindPlace.js\":\"0a5973ace0c76a8a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/currentLocation.js\":\"54d6bafeed3bf5a2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/dataExtension.js\":\"f159c4cd828d7680\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/geoContentDecorator.js\":\"78cebd1925754689\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/googlePlacesClient.js\":\"b0239f0af68940e0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/index.js\":\"95340443eced971a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/locationsPage.js\":\"22ba0f9356738928\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/mapViewport.js\":\"2dccd57ba4575cf3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/pickCurrentLocation.js\":\"2ce5221bccc9d6f0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/placeAutocomplete.js\":\"c8cf510b5f5b5969\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/placeNameCollision.js\":\"4bed3750ee30b6b6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/properties.js\":\"8cb98e0d7089be54\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/propertyEditorOverrides.js\":\"4cb2bec439fc5251\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/query.js\":\"486c6bd58997d218\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/geo/usePlaceSearch.js\":\"8eeba25ec8173901\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"59edfa6f6d1883c2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"e226ad86717c4485\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"4e9b85e4fdaecbcf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/config.js\":\"c04164ed45036aa1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/dataExtension.js\":\"192b94b5b942ef3c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/facet.js\":\"a9b1d81a3cbb6a74\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/grouping.js\":\"32ddcb979f4c2913\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/index.js\":\"36aae26db241dfab\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4f4a7f1c3dd79362\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/query.js\":\"e8013a4831e44ad0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/resolveConfig.js\":\"70be9b7ee4dee779\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"a9c079a705325d99\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"085b86c32d6dbbd3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/HtmlDocumentContent.js\":\"ed07728e2c1a0682\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/HtmlFrame.js\":\"57251675faa69eeb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/actions.js\":\"2fd5072f163c9e5f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/blockType.js\":\"748aad09fa3f1868\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/confirmRunScripts.js\":\"c0e253bc6641c8e9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/dataExtension.js\":\"ee21b2f929645dbb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/frameAnnotations.js\":\"67812c654f54c235\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/frameDocument.js\":\"71945f5091480564\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/frameTheme.js\":\"945eb5f9c24198a7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/index.js\":\"fc923cf37a8cc92f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/scriptConsent.js\":\"14b86e6eabd46507\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/sourceMap.js\":\"bd195c7dd45401a7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/html-document/useDocumentScripts.js\":\"94186338e1d753b1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/index.js\":\"09eb958805eac436\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/record.js\":\"98177ba31c547024\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/recordStore.js\":\"e33c1daee33fd836\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/responsiveness.js\":\"d4dfade0734b9395\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/schedule.js\":\"e56f44d274b1ec2f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/interaction-metrics/sessionContext.js\":\"560cb062aa540718\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e6d9dbd8353b2b39\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"36d54a63d3bdaef7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/actions.js\":\"6e81c3a46d1a8c21\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/config.js\":\"4bae67bf637492b0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/dataExtension.js\":\"61df4cd0111304a0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/effect.js\":\"e895ed63322ec9f0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/index.js\":\"ae5b0b1d6865125f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/keyCapture.js\":\"1da05e8f30d63cba\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/overrideStore.js\":\"69adcc7f31fe280a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ff73eb2dd40e0dab\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/HeaderItem.js\":\"bc9d204401d50991\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/LeftSidebar.js\":\"341b3e0acc2960be\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/actions.js\":\"6fd4c704d5dc0d46\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/facet.js\":\"d6cca4a51103a3fa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/index.js\":\"9f3d75d2fe4877d6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/shortcuts.js\":\"ea6576e184f9e021\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/left-sidebar/toggleStore.js\":\"0fa9549d493d51d2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/merge-blocks/MergePicker.js\":\"101526c509a9c8b9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/merge-blocks/index.js\":\"5c9a4cb24a7674fa\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/merge-blocks/mergeAction.js\":\"d6d87a4f5ab5e460\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/merge-blocks/strategy.js\":\"f2812d2a742dcd58\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/Button.js\":\"bb1b7b4c434b8361\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1c22eeb487b0d61d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/defaultItems.js\":\"19a45a9ebb4cef84\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/facet.js\":\"b2b06bb2ce5b44ee\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-bottom-nav/index.js\":\"ad6828a166ae142c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0462fdeae1bc65e1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e1611a3d6889ff59\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f006140198e13b23\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/facet.js\":\"d1128729b1ea9bd9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/mobile-keyboard-toolbar/index.js\":\"83dbbcb8c00fbe6f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/MoveDestinationPicker.js\":\"da09fb0dd9b3f63d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/blockSubtreeMembership.js\":\"716de6083d102a53\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/contextMenuItem.js\":\"9b34ac93a702333c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/index.js\":\"872c0434a4c60fa4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/moveAction.js\":\"14518cea406c7cd4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/moveBlocks.js\":\"83fbcd713bdc5397\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/move-blocks/selectionAfterMove.js\":\"8fc7af17256ff7da\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/TutorialBanner.js\":\"b1f45e14b18fff43\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/action.js\":\"9fc45d8e6027febf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/bannerDismissal.js\":\"79f7a2553998d9ad\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/documents/cheatSheet.js\":\"618e541c2e7a40f2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/index.js\":\"6d3e6beff6b51176\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/keys.js\":\"5019a265cd710705\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/landing.js\":\"60730fa5936a32b7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/outline.js\":\"5583d24162eb5b96\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/onboarding/seed.js\":\"a20b2e982b642de4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a66b001a400b745d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/analyze.js\":\"2623b2d2edda1ae7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/diagnosticsSource.js\":\"47cef5356e1edde6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/index.js\":\"0c34a44a6551b0bf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/load.js\":\"a71b000332b8ab2e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/monitorRun.js\":\"90ac7579acab9617\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/schedule.js\":\"17d55d74c3566a28\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/series.js\":\"dc680ac31cd35a46\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/store.js\":\"d605fda0ee60f4ee\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/trendAction.js\":\"30da7cb9f1bb4854\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/perf-monitor/verdict.js\":\"e438777cf3f317ac\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/plain-outliner/clickToEditAction.js\":\"43172beb0f840c2d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/plain-outliner/index.js\":\"046e93263334f71c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/plain-outliner/interactions.js\":\"fc171ffd326dc8a1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d500653c606cd1b3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/MigrationGate.js\":\"7961c4b44fbd9fc1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/MigrationGateDialog.js\":\"de615c8fa79e4afb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/action.js\":\"b39c3d821304da43\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/index.js\":\"ebb185c6be8d7eab\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/localRunMessage.js\":\"ee757032875f5ebc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/plugin.js\":\"a43fcc847c09406d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/progressReport.js\":\"6f23cdf7738eca8c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/properties-migration/sweepProgress.js\":\"9b76570bf74b9e29\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/FieldRowRenderer.js\":\"b61ca5aef551ecd5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/ValueRowRenderer.js\":\"bdd76a9ba72b29c4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/actions.js\":\"30b21c5a7aa0a4de\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/autocomplete.js\":\"c2ce0ec1dcfed3f1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/fieldRow.js\":\"80f7a0fde7baf203\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/index.js\":\"a07f2c5631fabb7c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/referenceWarning.js\":\"4f86646956580c5e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/valueAutocomplete.js\":\"3232c6855f989586\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/property-rows/valueSchema.js\":\"7e21473391f7f024\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/HeaderItem.js\":\"b52153b231870ab9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/QuickFind.js\":\"42f5f5c7b220c477\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/index.js\":\"7c05415aa9d993f7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/recents.js\":\"788390f0c93d3e7a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/resultItems.js\":\"7bed78e3302385fb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/selection.js\":\"f111bda22f5da54c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/quick-find/toggleStore.js\":\"5c4cac7711cb33ab\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/HeaderItem.js\":\"876fd4aff35458b9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/RecentsPageBlockRenderer.js\":\"21dbb33ecafc58c4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/grouping.js\":\"f9d3e8afa8af07f1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/index.js\":\"34aa1f8483590cdf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/recents/target.js\":\"d592c68e8c191346\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/codeMirrorExtensions.js\":\"abdeba6df3e037eb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/contentPrefill.js\":\"35730c92cca744e5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/dataExtension.js\":\"52c4559144a8cbe4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/index.js\":\"af2d9e57fa48a765\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b12475964c50ebcf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/invalidation.js\":\"8719fdf6cfbbd26f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/localSchema.js\":\"107c81eed6d6bd2c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/blockrefs/index.js\":\"c77f4fa7bb75ba10\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"a44fd7e9410023c7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/index.js\":\"6a62495ae196db10\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/referenceNode.js\":\"817ce34d932656fd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/remark-reference-occurrences.js\":\"4de68c3bf236e16d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"768da447cb29c64f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/wikilinks/index.js\":\"1c3c0069558134a4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"1ed663b91124a987\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7e07bf05e8552336\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/mergeRetargetProcessor.js\":\"db75ac011cf0f346\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/parseFence.js\":\"f19db4aa4120fe68\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/referenceParser.js\":\"9e23477a81b43bda\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/referenceProjection.js\":\"e51acc34ae493256\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/referencesProcessor.js\":\"613bd37fa656c4d7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/renameProcessor.js\":\"8de8bb46752ee35f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/references/spanReplacement.js\":\"40e683704f6e51c8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/rich-paste/htmlToOutline.js\":\"905952d197aea363\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/rich-paste/index.js\":\"85ad71c8806a9196\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5fb56bdb0f5b228f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/rich-paste/pasteDecision.js\":\"0cb37ee870b758ad\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/action.js\":\"2aefedef715cf929\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/blockIds.js\":\"864cb00c215fd24a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/content.js\":\"b10bfc7d44018410\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/effect.js\":\"0a770ec7254b393e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/ids.js\":\"7e59c4ae2c9552cd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/import.js\":\"03611f0d968646ef\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/index.js\":\"a855cb7c66f00c07\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/plan.js\":\"d261cc4ffe37ac8d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/plugin.js\":\"e34b3c245bda1eba\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/promotion.js\":\"46f4c28fadd2f4da\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/properties.js\":\"6bc2792d2346a8a5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/references.js\":\"8fe02a4216a91450\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/report.js\":\"2c8249daead12226\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/roamMemo.js\":\"6ebbf857222702e2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/runtime.js\":\"64ff54398a30d6e6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/schemaReconciliation.js\":\"a592c83e36a40f7d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/srsMarkers.js\":\"fef45170b7e3d248\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/todo.js\":\"a00708e1eacdc937\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/typeCandidates.js\":\"39df0c9ac55b7ec7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/roam-import/types.js\":\"2dc442d0f66f869c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/search-health/index.js\":\"0a732f63a960f407\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/search-health/store.js\":\"9e80ddc6c9333eff\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/HeaderItem.js\":\"fc7fcaad583e65b5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"8697acea725aeda5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/index.js\":\"0886975fd5c6cda0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/model.js\":\"17da241f958b3ba5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/toggleStore.js\":\"b928ec020ab2507b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/shortcut-help/useKeyInspector.js\":\"3c89e64e103aec98\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"62cf705106d45d48\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/ShellDecorator.js\":\"5d912307da4fe139\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/actions.js\":\"bad848d611f310d8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f4b8e0bf4cf8f7b7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/index.js\":\"45b5f064ee7c3d7e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/shell.js\":\"07c35fefda1aea1b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/surface.js\":\"5f5ce64dc3c856b8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/spatial-navigation/walker.js\":\"31a5bf980809bc46\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f843702f4cafeecc\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/dataExtension.js\":\"a1fe558ec44312ab\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/index.js\":\"d1f85d8863672d68\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/indicator.js\":\"be3418e916c64b57\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/moveSrsState.js\":\"7452931f05cb8878\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"5371d935741861b4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/scheduler.js\":\"b6ec87555b27d9b0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/schema.js\":\"a9e90004fca09a70\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3f168320bfe2a5e9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/srsClipboard.js\":\"5c7e26f2294301db\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"240c146fa46c548e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1940acf4947db40b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/DeckPicker.js\":\"3995cdc70c1d6e42\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/ReviewControls.js\":\"87da5d1b12bd7f19\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3df9d258a73ca11a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/ReviewSession.js\":\"7db7a1c0bd4963ec\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/actions.js\":\"338ad3d7d52a096d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/archive.js\":\"91ebf8989f555c84\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/dataExtension.js\":\"2b1af6250b7670c5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/deck.js\":\"8e6105c536db66f8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/dueQuery.js\":\"c09cc3d3b3d9bf3c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/gradeDecision.js\":\"9178b6872a5402c1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/index.js\":\"26207b11c1181c4a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/keyHints.js\":\"d9b71d34a36fbea8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/reviewCardLayout.js\":\"3523dd8e9c82c719\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/reviewProgress.js\":\"11b215b42cb8a8f5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/schema.js\":\"f712831ba147a3e7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/srs-review/useDueCards.js\":\"1a9de2f8232162c1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/startup-metrics/index.js\":\"642d32adafb974d7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/startup-metrics/record.js\":\"82afb1ddeee90d18\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/storage-persistence/index.js\":\"05c2c0a0606ced59\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/storage-persistence/persistenceStatus.js\":\"0177f7266d2af78e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/storage-persistence/requestAction.js\":\"8776e10468e5c483\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/supertags/TypeChipsDecorator.js\":\"1b6465203a6e6a78\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/supertags/codeMirrorExtensions.js\":\"2ed8eb00203f4355\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/supertags/index.js\":\"6e086c0b8d70122b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/supertags/typeAutocomplete.js\":\"d246afe988d02162\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"571204731d95f825\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/actions.js\":\"715f8dc5d34da6b3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/anchor.js\":\"7f849c25978e9c63\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/events.js\":\"70aef681fa1dab4b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/gestureActions.js\":\"62985918958c670f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/index.js\":\"da0c9325b13455e9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"eea7e0bc958459a5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/sync-metrics/collect.js\":\"a6fc592dcb951c13\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/sync-metrics/index.js\":\"0fc93eca5a1976f0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/sync-metrics/record.js\":\"64e0824df1889e9d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/RejectionDialog.js\":\"ed68fa2defd73ae2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c48191026ef591bd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/index.js\":\"f2753b34adef7ef0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/model.js\":\"25d8ee74457322bd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/queueCounts.js\":\"dca778bf825c52a7\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/rejectedHelpers.js\":\"9ee94c5ac420316b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/rematerializeAction.js\":\"e34c742d21b1c12f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/system-status/useHysteresis.js\":\"3a9b10467c1e613e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/ColumnHeaders.js\":\"0b30670b1fa3c687\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/QueryUi.js\":\"1180dfb469f36e85\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/TableLayout.js\":\"4ca575985c17c590\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/actions.js\":\"8619b2058639dbb9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/cellEdits.js\":\"97a82884e245c643\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/childrenViews.js\":\"a21a31313c3b9aca\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/columns.js\":\"10830447e5b23a45\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/controller.js\":\"8a9f008e80662708\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/convert.js\":\"29ed911fdc9f28d4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/dataExtension.js\":\"24f2cd7ebe1158e6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/index.js\":\"07eee821cf541b9d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/keys.js\":\"9351518380ed14a0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/model.js\":\"73f2b795233ab725\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/QueryText.js\":\"becdf6d29a279f2a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/backfill.js\":\"005ebf4e95a4a18f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/completion.js\":\"e51c4bad521801c1\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/format.js\":\"687c001122b5aad5\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/parse.js\":\"0fba42f6bb9e10cf\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/queryValue.js\":\"95893f8195524ef3\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/registrations.js\":\"3463d8dcfb35c012\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/query/source.js\":\"7a9b866e774b0575\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/registry.js\":\"adf6a51e4052a433\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/rowGutter.js\":\"1879082959e21280\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/rowVerbs.js\":\"89714ac831c6eee4\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/schema.js\":\"abdf3279d374f105\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/tables/sort.js\":\"c2233702828e7622\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/theme-toggle/effect.js\":\"fa596156c7d4cbae\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/theme-toggle/index.js\":\"63d02a3a8077fed0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/theme-toggle/theme.js\":\"08ecc33cfa1ef9fb\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/todo/actions.js\":\"170280f62581b22c\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/todo/dataExtension.js\":\"4293456052227831\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/todo/index.js\":\"c8a5a25cf010dd2b\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/todo/schema.js\":\"a2f86139b119ecb9\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/TouchSelectionLayer.js\":\"05c6d8bead8aa60a\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/actions.js\":\"39c98be4a427fe4e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/defaultItems.js\":\"5adb357f95fafe3e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/facet.js\":\"8ce1e9506dbbc217\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/holdRecognizer.js\":\"4e8fa491c77011ff\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/touch-selection/index.js\":\"6c323346b4846229\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/update-indicator/UpdateIndicator.js\":\"e876b070105d7d68\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/update-indicator/index.js\":\"effcfda42465f61d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/update-indicator/loadTimes.js\":\"e719fef33c064fe6\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/VideoNotesRenderer.js\":\"f8006ec7da09f444\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/VideoPlayerRenderer.js\":\"e6d8056cbeaf71c8\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/VideoTimeStamp.js\":\"c31de09760c7a0d0\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/actions.js\":\"69c278444bd5407d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/index.js\":\"12378fcedf818757\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/markdown.js\":\"dae4b3d6bb732b6f\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/notes.js\":\"c07a24246be34d82\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/registry.js\":\"9b40026da2ac5193\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/remark-timestamps.js\":\"95cbe5136e851686\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/video-player/view.js\":\"7aeb9cade8d00194\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-link-hints/LinkHints.js\":\"76738d2206e01b83\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-link-hints/index.js\":\"4272b967f394770e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-link-hints/model.js\":\"91912650b18017d2\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-link-hints/settings.js\":\"54615d70a4d24160\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-normal-mode/actions.js\":\"1a3b305a16a050fd\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-normal-mode/index.js\":\"a81fbeb5c605ec9d\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/vim-normal-mode/interactions.js\":\"fa39bdeebb3a082e\",\"/knowledge-medium/pr-preview/pr-1890/src/plugins/workspace-header/index.js\":\"f88cd273bb84ba4e\",\"/knowledge-medium/pr-preview/pr-1890/src/registerServiceWorker.js\":\"0d94ea4a7bd38188\",\"/knowledge-medium/pr-preview/pr-1890/src/requestPersistentStorage.js\":\"e7f27101b3ffb7e7\",\"/knowledge-medium/pr-preview/pr-1890/src/services/authRequestDeadline.js\":\"d6424e5da448af8a\",\"/knowledge-medium/pr-preview/pr-1890/src/services/authStorage.js\":\"72985e4607332b16\",\"/knowledge-medium/pr-preview/pr-1890/src/services/powersync.js\":\"d8909790325b5f9b\",\"/knowledge-medium/pr-preview/pr-1890/src/services/supabase.js\":\"4a0187d9400bf78a\",\"/knowledge-medium/pr-preview/pr-1890/src/services/uploadErrorClassifier.js\":\"9997762d27ab1a2b\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/ActiveContexts.js\":\"f25fc3722991bbb4\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/HotkeyReconciler.js\":\"514ea7fc839cadff\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/WipeLocalDataDialog.js\":\"87c3fb0fa2d91e29\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/actionDispatch.js\":\"b00f07acef72144d\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/actionRefItems.js\":\"44fdf1bb6d12f7c5\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/applyKeybindingOverrides.js\":\"7c340cdd0a9b6100\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/blockActions.js\":\"70a2df043cc79a8d\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/blockMergeGesture.js\":\"77d2ddf18203ec59\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/canonicalizeChord.js\":\"265c448e9225c265\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/defaultContexts.js\":\"801854d5221d72e8\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/defaultShortcuts.js\":\"f0b360031a614dd0\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/effectiveActions.js\":\"0fab8e77985e439f\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/gestureAction.js\":\"9a856dbe2c574ff5\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/gestureBinding.js\":\"d4810b5c7f001ced\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/holdRegistry.js\":\"a3b1fc96032009e9\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/keybindingConflicts.js\":\"b34ea666672c5b0f\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/keybindingOverrides.js\":\"d48212d3aa588b73\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/pointerAction.js\":\"f0f55cfc180f30ab\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/resolve.js\":\"12f0e32e8271dbf3\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/runAction.js\":\"4b4f7c2abb70c6c8\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/sequenceMatcher.js\":\"6808a25ee8ad55c7\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/types.js\":\"07d7a58bd8669cb7\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/useActionContext.js\":\"1f344c17ea069475\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/useActionDiscovery.js\":\"fd2d0842b05f351d\",\"/knowledge-medium/pr-preview/pr-1890/src/shortcuts/utils.js\":\"89ac4a72354a2e6c\",\"/knowledge-medium/pr-preview/pr-1890/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1890/src/sw/bootStore.js\":\"29419c2be576dd38\",\"/knowledge-medium/pr-preview/pr-1890/src/sw/previewDatabases.js\":\"59f31f966dd97e95\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/byteTransform.js\":\"4c50fd9679d27084\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/attachmentCleaner.js\":\"78b2373204d81bfc\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/attachmentParts.js\":\"023e8abe7ef2082a\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/bundleParts.js\":\"6cd0c80e61402a13\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/bundleRecord.js\":\"14e8124df4e25fe3\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/manifest.js\":\"bd08c15cdda50a06\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/takeBundle.js\":\"f4b29eede0b352a6\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/bundle/verifyBundle.js\":\"c00105a84e9c8067\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/cleaningStage.js\":\"50a10d23a3ed7d73\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/conversionKey.js\":\"9724a1b6df3898aa\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/conversionServer.js\":\"361cbb26e3e9ee1d\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/flip.js\":\"a8b6f7d9b604b717\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/flipAttempts.js\":\"6591616ebbab6970\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/pages.js\":\"92695567e018bde9\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/preflight.js\":\"04a3fde5321518f5\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/reseal.js\":\"c9e87a0fbba216fd\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/runConversion.js\":\"601e9392f6a714c1\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/runLock.js\":\"ef52c657f07aceed\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/sealing.js\":\"fa2cfd8e780f3ee8\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/sealingStage.js\":\"6d19b90c38c39dd4\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/stage.js\":\"f0b34aa80e70c21d\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/conversion/verifyReseal.js\":\"225be4c99c7bca27\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/aad.js\":\"123ba758024502fb\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/aead.js\":\"e517640d4a3cc729\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/base32.js\":\"cbfec15cf4b71daf\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/base64url.js\":\"1bf4fbb72a4e3fe4\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/binaryEnvelope.js\":\"6f7e538e4ec6cab5\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/byteAead.js\":\"213e1782428923d7\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/canary.js\":\"d3494748a1d222e6\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/contentHash.js\":\"de9037cdf47025ae\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/contentKey.js\":\"f4b6fa73939be835\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/derivedIdNamespace.js\":\"f7d716ba4008d228\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/envelope.js\":\"e5acccbacd0f6b86\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/hex.js\":\"5b7b98357f3b331a\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/sha256Hex.js\":\"7da4518affa00ad5\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/crypto/workspaceKey.js\":\"3ea29421a300a8a6\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/conversionState.js\":\"a5ecf2b771bc660d\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6a38fd3c0ab5434c\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/flows/pastedKey.js\":\"9508a8c738dbbfb6\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"4400a403509f3c4c\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b93731626c93bc18\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/keyStore.js\":\"532eff9a9ca03221\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/mintWorkspaceKey.js\":\"02283748cbde4e78\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/modePin.js\":\"8a5d50a1cf24c921\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/openWorkspaceKeys.js\":\"9aa71a432f2c1000\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/resolveWorkspaceEntry.js\":\"4869627476271366\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/resolver.js\":\"3c25bcfb39e3ffd4\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/keys/workspaceAccess.js\":\"a95d1f50290efeea\",\"/knowledge-medium/pr-preview/pr-1890/src/sync/transform.js\":\"0c1e709677df5231\",\"/knowledge-medium/pr-preview/pr-1890/src/themeBootDefaults.js\":\"4aa37bda8fb185a4\",\"/knowledge-medium/pr-preview/pr-1890/src/types.js\":\"6ab7b0e8fbc53ab1\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/ClientLocalSettings.js\":\"8131585c4bf1883a\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/abortableSleep.js\":\"c105e2f395e617e8\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/array.js\":\"61e3d52ee79fed11\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/backlinkAutocomplete.js\":\"0859d155c73a5218\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/blockCrumbs.js\":\"5f8aadb4afd460f5\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/blockrefAutocomplete.js\":\"52a932134cdb651e\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/cadencedIdleJob.js\":\"9a736910bea22908\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/callbackSet.js\":\"bc6c11d767733b81\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/clientId.js\":\"c3c93c28bf802742\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/codemirror.js\":\"9184143d79b16be7\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/codemirrorCompletion.js\":\"aaf06707239a9dc1\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/copy.js\":\"b453d6b7205eaee9\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dailyPage.js\":\"27fd1a5666cd7765\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dbForensics.js\":\"81a28e08af961817\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dbForensicsHooks.js\":\"0c03e75844a57f16\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/deleteBlockThroughUi.js\":\"d1485fddca08d68d\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dialogs.js\":\"a426f96e0849ac48\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/dom.js\":\"4df63e6e3a4ba093\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/downloadBlob.js\":\"b71871b3e56d49d6\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/drawnWalk.js\":\"f471761efd1c12ab\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/exportSqliteDb.js\":\"5522d083d9e9ea49\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/fileSystemAccess.js\":\"d2d49a23e5d9bf32\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/flipSlide.js\":\"e44278cb8ef01c81\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/fnv1a.js\":\"f3763ea6e469609b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/formatBytes.js\":\"79bf9af6f1f2e30d\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/fuzzyRank.js\":\"8ebbfb4700642e4a\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/idbKeyedStore.js\":\"44a4c73b3c01f9e5\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/idleCallbackPolyfill.js\":\"3ecfb58a6546dadc\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/keyboardAwareScroll.js\":\"403d7bd006b80a9a\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/keyboardViewport.js\":\"ac02a3c1d978c1af\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/lastWorkspace.js\":\"50b758daccf99d9f\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/layoutColumns.js\":\"f2b108e250318547\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/layoutSessionDom.js\":\"70e3b0fc146b0205\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/layoutSessionId.js\":\"5ac25b83d514f3d4\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/linkClickGestures.js\":\"afbd264e165088da\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/linkTargetAutocomplete.js\":\"b94bf6d16baeeecb\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/localDbCorruption.js\":\"991afda4afedd679\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/localDbRecovery.js\":\"eb281478c47b323c\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/markdownParser.js\":\"9fe5a253c23a68e6\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/memoize.js\":\"dae7a8dbb729d981\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/nameFieldCommit.js\":\"11fc626ea641167f\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/nameList.js\":\"53fe57d5b38dc07d\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/navigation.js\":\"ce73ecb20ccc591f\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/omnilinerNamespace.js\":\"84663e69add8dbf0\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/opfsPageScan.js\":\"66b6c8e0f98a61e9\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelClearance.js\":\"67cf3acefd000f8f\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelHistory.js\":\"3dd4593f86ec6982\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelLanes.js\":\"daddef73dbacaeec\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelLayoutProjection.js\":\"187f23d67e62bd49\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelScrollAnchor.js\":\"83c15372ad4c997e\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/panelUrlFlags.js\":\"9c06289a34f15272\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/platform.js\":\"bdce42c4ca5cf165\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/pluralize.js\":\"7bd5c3f0dd28e2ac\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/propertyCreation.js\":\"efd36e59e1ac0a31\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/propertyNavigation.js\":\"c388dfd8191023e2\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/propertyValueContext.js\":\"4b49cd556a5e9eec\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/react.js\":\"addd7678083904dc\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/relativeDate.js\":\"25bd5f92bfb13d23\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/relativeTime.js\":\"c0b8ce1e1729839e\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/renderScope.js\":\"1387acc9e87d332b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/resolvedThenable.js\":\"8ee865ef806b850b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/routing.js\":\"3092ba65ef589afb\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/safeMode.js\":\"9d4ded2b817acca4\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/scheduleIdle.js\":\"e650558223949e6a\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/screenWakeLock.js\":\"941f233aba1683ac\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/selection.js\":\"b8a9cc6d4022ce36\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/softKeyboardGrab.js\":\"ed2fdd71ac6d8f2e\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/startupTimeline.js\":\"a1c2379f991703b4\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/state.js\":\"49b7d8087e674ae0\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/string.js\":\"a2dbd0685164845e\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/surfaceZoom.js\":\"0e1b76c49c50aa4f\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/time.js\":\"21e776898971f657\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/toast.js\":\"f213dc96ec7e8f9b\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/toggleStore.js\":\"2fdbcbb614975cce\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/untilStopped.js\":\"b40d3dad3adc302d\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/userActivity.js\":\"f70e90bb9cc37a08\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/viewTransition.js\":\"273ba897e55f9557\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/viewport.js\":\"457b27bd11adad38\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/webLock.js\":\"8d3575072b1c0ed9\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/workspaceRecovery.js\":\"e5343365fb25ac19\",\"/knowledge-medium/pr-preview/pr-1890/src/utils/workspaceSnapshotStore.js\":\"28bffd88df53f162\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-compiler-runtime.js\":\"8ff834bcd1385ead\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-client.js\":\"eb7262718e4feda8\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-server-edge.js\":\"994d244363b32bfc\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-server.js\":\"971e5bba831c66e6\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-static-edge.js\":\"1713effc235337b7\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-static.js\":\"e4335d2bc9e92c5f\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom-test-utils.js\":\"10d82e15e9781a84\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-dom.js\":\"4237d590850d4516\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react-jsx-runtime.js\":\"da8084012c557bc0\",\"/knowledge-medium/pr-preview/pr-1890/src/vendor/react.js\":\"06d1395a781d22a9\",\"/knowledge-medium/pr-preview/pr-1890/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1890/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1890/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
