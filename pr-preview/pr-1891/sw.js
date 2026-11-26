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
		buildId: "ac0becefc884-42bb040b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1891/\":\"299e0cd56a39b663\",\"/knowledge-medium/pr-preview/pr-1891/index.html\":\"299e0cd56a39b663\",\"/knowledge-medium/pr-preview/pr-1891/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1891/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1891/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1891/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1891/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1891/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1891/app.css\":\"d6b85c2ba5dde3ba\",\"/knowledge-medium/pr-preview/pr-1891/assets/FacadeVFS-DcUaUQLg.js\":\"c7bc738cac467a95\",\"/knowledge-medium/pr-preview/pr-1891/assets/OPFSCoopSyncVFS-VNqSic6r.js\":\"6a718acfba73d658\",\"/knowledge-medium/pr-preview/pr-1891/assets/OPFSWriteAheadVFS-BbK6rSBL.js\":\"9e8010d66b7b0839\",\"/knowledge-medium/pr-preview/pr-1891/assets/wa-sqlite-BNrzVM6x.js\":\"7e50e936532249d7\",\"/knowledge-medium/pr-preview/pr-1891/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1891/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1891/assets/wa-sqlite-async-Bxmd8_cO.js\":\"5f743a6600f0592a\",\"/knowledge-medium/pr-preview/pr-1891/assets/worker-CuTWiVzX.js\":\"c6ec249aabf9dba1\",\"/knowledge-medium/pr-preview/pr-1891/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1891/chunks/app-1xI9wpjz.js\":\"8fb6953960dd4108\",\"/knowledge-medium/pr-preview/pr-1891/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1891/index.js\":\"f636740701bdc7e5\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1891/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1891/assets/AccessHandlePoolVFS-BH1UzAC_.js\":\"48453df3c3b18911\",\"/knowledge-medium/pr-preview/pr-1891/assets/IDBBatchAtomicVFS-DfqoUX7s.js\":\"7cc2552b599116fe\",\"/knowledge-medium/pr-preview/pr-1891/assets/MemoryVFS-BfTkePHc.js\":\"f7bedbc8c2d2e4a1\",\"/knowledge-medium/pr-preview/pr-1891/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1891/assets/mc-wa-sqlite-V1SSCOZ8.js\":\"55a5927ed6396332\",\"/knowledge-medium/pr-preview/pr-1891/assets/mc-wa-sqlite-async-CSSsZ2Li.js\":\"f997e0f460dd367d\",\"/knowledge-medium/pr-preview/pr-1891/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1891/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1891/chunks/AccessHandlePoolVFS-uZGrU0UO.js\":\"121a0e8c1033ea80\",\"/knowledge-medium/pr-preview/pr-1891/chunks/FacadeVFS-C4erCEUo.js\":\"554f98e94f1ac794\",\"/knowledge-medium/pr-preview/pr-1891/chunks/IDBBatchAtomicVFS-ZKj9_153.js\":\"76fa14442cca7491\",\"/knowledge-medium/pr-preview/pr-1891/chunks/MemoryVFS-DTXn1evZ.js\":\"afdd1661cd58f3bf\",\"/knowledge-medium/pr-preview/pr-1891/chunks/OPFSCoopSyncVFS-D1xP7Bdc.js\":\"8b64c27a2e633fd8\",\"/knowledge-medium/pr-preview/pr-1891/chunks/OPFSWriteAheadVFS-Dc60znX5.js\":\"00e392b88f194c78\",\"/knowledge-medium/pr-preview/pr-1891/chunks/Preview-CXkt2xnU.js\":\"d220d5ca01a58d87\",\"/knowledge-medium/pr-preview/pr-1891/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1891/chunks/card-ChuaUYfm.js\":\"cd355313e0b1ae30\",\"/knowledge-medium/pr-preview/pr-1891/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1891/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1891/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1891/chunks/dist-DrW3t_AG.js\":\"e8442d8c78d878b8\",\"/knowledge-medium/pr-preview/pr-1891/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1891/chunks/mc-wa-sqlite-async-DKneXCOZ.js\":\"3dc1e4d2569509b0\",\"/knowledge-medium/pr-preview/pr-1891/chunks/mc-wa-sqlite-x9OIITyx.js\":\"c1a3162a3ce39b95\",\"/knowledge-medium/pr-preview/pr-1891/chunks/react-B3r_-5Mb.js\":\"b1c972b30ba75d9d\",\"/knowledge-medium/pr-preview/pr-1891/chunks/react-BKcgmwGs.js\":\"a2c09617fa022d0d\",\"/knowledge-medium/pr-preview/pr-1891/chunks/react-BxJCEw2c.js\":\"27a6b5d27d99cecc\",\"/knowledge-medium/pr-preview/pr-1891/chunks/react-CZk-s4wa.js\":\"df4bd85200e8474b\",\"/knowledge-medium/pr-preview/pr-1891/chunks/react-CrS1HXfs.js\":\"6a1fe1d8b91071da\",\"/knowledge-medium/pr-preview/pr-1891/chunks/react-D_MxvvfL.js\":\"703358414d81be29\",\"/knowledge-medium/pr-preview/pr-1891/chunks/react-Rv0yFuF8.js\":\"05f5dbeb90e4122f\",\"/knowledge-medium/pr-preview/pr-1891/chunks/react-TSaL8v90.js\":\"afed47bbbc5a1674\",\"/knowledge-medium/pr-preview/pr-1891/chunks/react-dom-server-legacy.browser.production-DpLmEZ78.js\":\"9095dcdaaf72b48e\",\"/knowledge-medium/pr-preview/pr-1891/chunks/react-dom-server.browser.production-Bv6stp9q.js\":\"c3844e9f35c278eb\",\"/knowledge-medium/pr-preview/pr-1891/chunks/react-dom-server.edge.production-QW4i2ND7.js\":\"a4c0d0f449abfb59\",\"/knowledge-medium/pr-preview/pr-1891/chunks/server.browser-DIpfpx45.js\":\"747dbc6f5fdce0ba\",\"/knowledge-medium/pr-preview/pr-1891/chunks/textarea-pAjK0I2I.js\":\"1264c8d748c2d2b3\",\"/knowledge-medium/pr-preview/pr-1891/chunks/ui-BvPtrAoU.js\":\"0f1c77a1cc5f8198\",\"/knowledge-medium/pr-preview/pr-1891/chunks/wa-sqlite-Bt8EYsdk.js\":\"12e9b75f9a80c839\",\"/knowledge-medium/pr-preview/pr-1891/chunks/wa-sqlite-async-SFtC7BEy.js\":\"ee50c7964ea7ac8b\",\"/knowledge-medium/pr-preview/pr-1891/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1891/extension-utilities.css\":\"888df5881ba9f759\",\"/knowledge-medium/pr-preview/pr-1891/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1891/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1891/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1891/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1891/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1891/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1891/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1891/src/App.js\":\"e0151e7761cda2da\",\"/knowledge-medium/pr-preview/pr-1891/src/appUpdate.js\":\"f6211c475b18b10f\",\"/knowledge-medium/pr-preview/pr-1891/src/appVersion.js\":\"0218ba97738a9e42\",\"/knowledge-medium/pr-preview/pr-1891/src/bootstrap/initialLayout.js\":\"f9ac723772c43392\",\"/knowledge-medium/pr-preview/pr-1891/src/bootstrap/openWorkspaceData.js\":\"c4add1d0bcb0c7e1\",\"/knowledge-medium/pr-preview/pr-1891/src/bootstrap/resolveWorkspace.js\":\"01902e9089e17952\",\"/knowledge-medium/pr-preview/pr-1891/src/bootstrap/workspaceBootstrap.js\":\"99c7f971964f49fe\",\"/knowledge-medium/pr-preview/pr-1891/src/components/BlockComponent.js\":\"1a792d846639c073\",\"/knowledge-medium/pr-preview/pr-1891/src/components/BlockCrumbs.js\":\"2f31158e21079caf\",\"/knowledge-medium/pr-preview/pr-1891/src/components/BlockEditor.js\":\"dfecf96cee82bde2\",\"/knowledge-medium/pr-preview/pr-1891/src/components/BlockLoadingPlaceholder.js\":\"67aec8c1b6b993d0\",\"/knowledge-medium/pr-preview/pr-1891/src/components/BlockProperties.js\":\"c0a4ac124c30801f\",\"/knowledge-medium/pr-preview/pr-1891/src/components/BlockSearchPicker.js\":\"65b7595c7802cac5\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ConfirmBulkDeleteDialog.js\":\"c96d56b14e2e5e61\",\"/knowledge-medium/pr-preview/pr-1891/src/components/DividerHandle.js\":\"618b971ba9e71065\",\"/knowledge-medium/pr-preview/pr-1891/src/components/DraftEditor.js\":\"6be67f6f7c7d6ed2\",\"/knowledge-medium/pr-preview/pr-1891/src/components/GutterPill.js\":\"1efb196ae670b9ee\",\"/knowledge-medium/pr-preview/pr-1891/src/components/Header.js\":\"67899fd283358ad3\",\"/knowledge-medium/pr-preview/pr-1891/src/components/LazyBlockComponent.js\":\"a9e460efe8a1b495\",\"/knowledge-medium/pr-preview/pr-1891/src/components/Login.js\":\"367b851f9c8347b9\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ZoomableSurface.js\":\"1710f1b4dd5d2421\",\"/knowledge-medium/pr-preview/pr-1891/src/components/editModeKeepalive.js\":\"9626487504d60d91\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyDisplay/PropertyDisplayScope.js\":\"83048ecee11ee168\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e6a75610194e3d22\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyEditors/RefPropertyEditor.js\":\"44a113a312dd4b60\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyEditors/RefTargetTypePicker.js\":\"6555a798bd7a49b2\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyEditors/SelectPropertyEditor.js\":\"54b59a35caf4f9ab\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyEditors/TypesPropertyEditor.js\":\"ba04d743ce0634bc\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyEditors/defaults.js\":\"edefab92a094bac2\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyEditors/kernelValuePresets.js\":\"c58d53aa27dd8139\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyEditors/selectablePresets.js\":\"96ac78867926fb26\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyEditors/typesPropertyUi.js\":\"f52e3120f44b28c8\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyPanel/AddPropertyForm.js\":\"37959031a33be644\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyPanel/PropertyPicker.js\":\"b5e4f18edb51b518\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyPanel/PropertyRow.js\":\"6d4db2ad3c23ebab\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyPanel/Rows.js\":\"f049e84467ed057c\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyPanel/actions.js\":\"4cfce60cb7300229\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyPanel/declarationOnly.js\":\"1eedf7ce348dc503\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyPanel/layout.js\":\"42c0d655ff6b01e1\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyPanel/model.js\":\"c0343fadd35ffc34\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyPanel/shapeUi.js\":\"5eb6d8af885c60c4\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyPanel/shapes.js\":\"7799ab1318e1c50f\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a795684af2b7740f\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyPanel/visibility.js\":\"1419fbd8bd1f276d\",\"/knowledge-medium/pr-preview/pr-1891/src/components/propertyPanelSections.js\":\"2fb9b245d51b33c9\",\"/knowledge-medium/pr-preview/pr-1891/src/components/references/BlockEmbed.js\":\"9e5de2d2896ae93c\",\"/knowledge-medium/pr-preview/pr-1891/src/components/references/BlockLink.js\":\"0f86b6386207d2db\",\"/knowledge-medium/pr-preview/pr-1891/src/components/references/BlockRef.js\":\"9749a598ac85348a\",\"/knowledge-medium/pr-preview/pr-1891/src/components/references/CompactReferenceLink.js\":\"b760f758a6810d5c\",\"/knowledge-medium/pr-preview/pr-1891/src/components/references/ReferenceLink.js\":\"f1ab4792b78cdb75\",\"/knowledge-medium/pr-preview/pr-1891/src/components/references/cycleGuard.js\":\"b18ea83dc70165c7\",\"/knowledge-medium/pr-preview/pr-1891/src/components/references/cycleGuardContext.js\":\"65541a832b07ac71\",\"/knowledge-medium/pr-preview/pr-1891/src/components/references/linkInteraction.js\":\"b2405886c38abadd\",\"/knowledge-medium/pr-preview/pr-1891/src/components/references/referenceLayout.js\":\"580c51425e673305\",\"/knowledge-medium/pr-preview/pr-1891/src/components/references/useBlockRefAncestors.js\":\"f81590d4289df4e4\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/BlockGutter.js\":\"c22534c524067e96\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/BlockInfoDialog.js\":\"15eb8da6a59d5632\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/BlockReadText.js\":\"858350f9d94f0cb1\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/BlockTypeBlockRenderer.js\":\"28960e5f3808b55a\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/BulletHoverCard.js\":\"b491776c0b117117\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/CodeMirrorContentRenderer.js\":\"e8d334e19dc025fd\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"949793ca088ad3c2\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/ColumnResizeHandles.js\":\"4d33ea0dbbf3bf37\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"9474a845dc2a409a\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/DefaultBlockRenderer.js\":\"abf0017fb0a527b4\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/LayoutRenderer.js\":\"f5c8c9055906775a\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/MarkdownContentRenderer.js\":\"9ac134309779cad8\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/MissingDataRenderer.js\":\"f93697ce237c4888\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/PanelRenderer.js\":\"14fbb2cf12d485cf\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/PropertySchemaBlockRenderer.js\":\"41430ba3f0d8ec25\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/TopLevelRenderer.js\":\"4f55dc3465c4e899\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/blockGutterMode.js\":\"af0071069c462cd3\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/blockTitleText.js\":\"4675b76124ddd894\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/fieldCreationKeydown.js\":\"4c3d89e46c3da972\",\"/knowledge-medium/pr-preview/pr-1891/src/components/renderer/layoutRootContext.js\":\"b0afaf4ea3d0b581\",\"/knowledge-medium/pr-preview/pr-1891/src/components/typeChip/TypeChip.js\":\"c8c216001fbfb05b\",\"/knowledge-medium/pr-preview/pr-1891/src/components/typeChip/chipStyle.js\":\"656e34c6f20f15c5\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/anchored-floating.js\":\"55e2d99d4a5699a5\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/button.js\":\"aefd1cc1a88f6f80\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/card.js\":\"18f9ce86382bbb34\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/checkbox.js\":\"b34d12a60bdf846b\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/collapsible.js\":\"1a8d406c08252ffe\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/command.js\":\"b0e8e18bbd0ac8bc\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/context-menu.js\":\"6f40958c90b8a142\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/dialog.js\":\"b13e5839a4d86493\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/dropdown-menu.js\":\"3c67f9e419d8305e\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/floating-listbox.js\":\"3b89bd9fdc3b27e0\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/index.js\":\"4f0c8d8f67dff208\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/input.js\":\"c6f0025fea238ef7\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/kbd.js\":\"7dff0790d9ab4120\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/label.js\":\"de609b59eb8bbb7d\",\"/knowledge-medium/pr-preview/pr-1891/src/components/ui/textarea.js\":\"2144ddaeb2976585\",\"/knowledge-medium/pr-preview/pr-1891/src/components/useEditModeYieldKeepalive.js\":\"22813c7fb9c8a3fc\",\"/knowledge-medium/pr-preview/pr-1891/src/components/util/BootFallback.js\":\"6207a0c7bbc47546\",\"/knowledge-medium/pr-preview/pr-1891/src/components/util/FocusedRowLazyMount.js\":\"380d1937ae1873f5\",\"/knowledge-medium/pr-preview/pr-1891/src/components/util/LazyViewportMount.js\":\"5c5f3d2e217a4a36\",\"/knowledge-medium/pr-preview/pr-1891/src/components/util/LocalDbCorruptionFallback.js\":\"08bb149816aa88b7\",\"/knowledge-medium/pr-preview/pr-1891/src/components/util/error.js\":\"17a24b4d8569c9e8\",\"/knowledge-medium/pr-preview/pr-1891/src/components/util/lazyMountRegistry.js\":\"4402008e0c4dfcb1\",\"/knowledge-medium/pr-preview/pr-1891/src/components/util/suspense.js\":\"4f122c78d0ebe059\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/CreateWorkspaceDialog.js\":\"ae76dccfa43d28b2\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/PendingInvitations.js\":\"6bce8d3dc2768f1a\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/SyncProgress.js\":\"25b5b30a2c2a252e\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/UnlockProgress.js\":\"ada63467e035f4bf\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/WorkspaceKeyGate.js\":\"538ab2ae63a24b3e\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/WorkspaceSettingsDialog.js\":\"f9a6c6119a0ed977\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/WorkspaceSwitcher.js\":\"eb91eba248ba9ccc\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/WorkspaceSyncGate.js\":\"3d0d9947a592a764\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/conversion/ConversionFlow.js\":\"1e4cf511f950bde6\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/conversion/ConversionFlowHost.js\":\"1fbcdeeb74e56019\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/conversion/EncryptionSection.js\":\"974a166070804b0a\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/conversion/attachmentPrompts.js\":\"74b797c2f66ab165\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/conversion/bundleFolderPrompts.js\":\"14777e96b03e5aa3\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/conversion/conversionFlowDeps.js\":\"94417a38af9c4735\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/conversion/conversionFlowStore.js\":\"3b05d33784d1840c\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/conversion/flowUi.js\":\"d27e57edb75efe7e\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/conversion/useConversionRun.js\":\"2e40f3dab103ba80\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/keyUi.js\":\"c1ec0410703329e8\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/useCloseOnKeyLoss.js\":\"e7071ac044da41c2\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/useCloseOnServerE2ee.js\":\"49957bf78493723f\",\"/knowledge-medium/pr-preview/pr-1891/src/components/workspace/workspaceUnlocked.js\":\"7fe87c9a3d2c9819\",\"/knowledge-medium/pr-preview/pr-1891/src/context/backgroundSubtree.js\":\"c7ab0da6b7736bed\",\"/knowledge-medium/pr-preview/pr-1891/src/context/block.js\":\"92e7f7335f5c576b\",\"/knowledge-medium/pr-preview/pr-1891/src/context/layoutWsContext.js\":\"1851a2d7ec1056c7\",\"/knowledge-medium/pr-preview/pr-1891/src/context/propertyDisplay.js\":\"93d0e99ac038dd3e\",\"/knowledge-medium/pr-preview/pr-1891/src/context/repo.js\":\"3f89e1bf9111e613\",\"/knowledge-medium/pr-preview/pr-1891/src/data/aliasClaim.js\":\"8a3eadd2537ea002\",\"/knowledge-medium/pr-preview/pr-1891/src/data/aliasSeatNamespace.js\":\"6c38479645100bb7\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/blockData.js\":\"d9e7b1e35bebc38b\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/blockType.js\":\"662de1789ce288c0\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/changeScope.js\":\"0028855c5eda426d\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/codecs.js\":\"4481fdd2a1427637\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/derivedData.js\":\"1be8ac4adf4b1670\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/errors.js\":\"73a8de29dedc36d7\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/events.js\":\"0b736976094aa6da\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/handle.js\":\"269dea6e0df773db\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/index.js\":\"dcfb8bf324656c14\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/mutator.js\":\"d5290d76fb3c095f\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/processor.js\":\"fa55eca4acbe7825\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/propertySchema.js\":\"764aa915865073f2\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/query.js\":\"b39eb59bf555841a\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/sameTxProcessor.js\":\"88b6dfe9f5a9b496\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/schema.js\":\"269dea6e0df773db\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/tx.js\":\"269dea6e0df773db\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/typedBlockQuery.js\":\"fea1a19ae71b7def\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/user.js\":\"1eaa13e684f8d5ce\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/valuePresetCore.js\":\"db6d1a2017bc4a5c\",\"/knowledge-medium/pr-preview/pr-1891/src/data/api/valuePresets.js\":\"33ceea10066f158c\",\"/knowledge-medium/pr-preview/pr-1891/src/data/attachmentCleanerIOVerb.js\":\"889f0f0174b10deb\",\"/knowledge-medium/pr-preview/pr-1891/src/data/block.js\":\"b509c1a5c21561a2\",\"/knowledge-medium/pr-preview/pr-1891/src/data/blockCache.js\":\"1be4b7f4f621073c\",\"/knowledge-medium/pr-preview/pr-1891/src/data/blockId.js\":\"f0a09c1f3c24ed18\",\"/knowledge-medium/pr-preview/pr-1891/src/data/blockLiveness.js\":\"8e48958a6f55b4af\",\"/knowledge-medium/pr-preview/pr-1891/src/data/blockMerge.js\":\"23e9b5588349712b\",\"/knowledge-medium/pr-preview/pr-1891/src/data/blockSchema.js\":\"a2eda501c42e9a28\",\"/knowledge-medium/pr-preview/pr-1891/src/data/blockTypeLookup.js\":\"fbbfe72821bd1dcf\",\"/knowledge-medium/pr-preview/pr-1891/src/data/blockTypes.js\":\"2ecdc8656ce2d47b\",\"/knowledge-medium/pr-preview/pr-1891/src/data/childrenView.js\":\"767bae6048ec3099\",\"/knowledge-medium/pr-preview/pr-1891/src/data/clientContext.js\":\"56c82df148433ab5\",\"/knowledge-medium/pr-preview/pr-1891/src/data/dbFileSiblings.js\":\"a15b0d71eb3677af\",\"/knowledge-medium/pr-preview/pr-1891/src/data/definitionSeeds.js\":\"78455a0e78ed2119\",\"/knowledge-medium/pr-preview/pr-1891/src/data/derivedIds.js\":\"0ac708ccace8588d\",\"/knowledge-medium/pr-preview/pr-1891/src/data/drawnSubtree.js\":\"08f0f51ab5577cc6\",\"/knowledge-medium/pr-preview/pr-1891/src/data/facetBridge.js\":\"614c22cb2e0f8609\",\"/knowledge-medium/pr-preview/pr-1891/src/data/facets.js\":\"79f37cdab15517da\",\"/knowledge-medium/pr-preview/pr-1891/src/data/globalState.js\":\"96e3b175b58a6f62\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/aliasClaimRederiveProcessor.js\":\"01c80cd26dc585c7\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/ancestorBatch.js\":\"53d5c697f0f9d5c5\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/blockTypeTypeifyProcessor.js\":\"3174b0a3993ef033\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/clientSchema.js\":\"94a6449b14b6e2cf\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/commitPipeline.js\":\"7afef689d07c8ae7\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/devAssertions.js\":\"8f6b3847dbadb159\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/firstSync.js\":\"835548ca01f31722\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/freshInitialLoad.js\":\"e28c1bbe3e1637db\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/graphBackfillClaim.js\":\"08d9e7faaf74a96f\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/handleStore.js\":\"0149b2e3ab0b38f1\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/idleMarkerJobs.js\":\"61514a1af75be3ac\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/initialDownload.js\":\"8cfc92da55a8638c\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/initializeClientDatabase.js\":\"5dfa951644466aae\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/jsonCanonical.js\":\"09b72831e717fde3\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/kernelInvalidation.js\":\"88f315620d9e527c\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/kernelProcessors.js\":\"423bcc8bdcba8f89\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/kernelQueries.js\":\"5af474333d04c89b\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/mergeTypeMembershipProcessor.js\":\"b7010dcc33623e98\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/normalizeReferencesProcessor.js\":\"9cd40f691e0d9e1f\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/poolInstrumentation.js\":\"6d895aa62b7d7d6c\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/processorRunner.js\":\"ee9ef838d9d5b6f0\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/propertyCellBackfill.js\":\"a6c71dea5ec43981\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/propertyChildMint.js\":\"20647186ce2b37b3\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/propertyChildrenProcessor.js\":\"2ad23f91031ceccb\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/propertyDefinitionChangeProcessor.js\":\"c030a74ac9a314ac\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/propertyDefinitionSynthesis.js\":\"757acd7b21776df0\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/propertyKeyScan.js\":\"ba69fc3386542a95\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/propertySchemaResolution.js\":\"f2517ffe6858d3b2\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/propertyValueEdits.js\":\"6154f211a4b64355\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/raiseProtocol.js\":\"e7b037b9e721d6b8\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/readBatch.js\":\"e13753c8b86ae369\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/refProjection.js\":\"15abad892401fbba\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/referenceTargetLookups.js\":\"0ad4601889b2c320\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/referenceTargetProcessor.js\":\"8e5ab5eb6e6d3727\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/replayMerge.js\":\"8cc97740a1cf3dfb\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/sqlBinds.js\":\"480fcf11f4d6d985\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"38395432f8e088c1\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/syncObserver/arrivalProcessors.js\":\"3878745d97401923\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/syncObserver/invalidate.js\":\"37786770fa366be0\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/syncObserver/materialize.js\":\"b044b0ac156947a1\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/syncObserver/observer.js\":\"6666d8099cdd8e26\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/syncObserver/reconcile.js\":\"3445e5dbc9bc88ab\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/timingMetrics.js\":\"3c6ddabc9ba65a24\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/treeQueries.js\":\"9bc47ee904f8e627\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/txEngine.js\":\"9c1072acd114ae2e\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/txSnapshots.js\":\"3640c008e63871ab\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/typedBlockQuery.js\":\"61e8597772810188\",\"/knowledge-medium/pr-preview/pr-1891/src/data/internals/undoManager.js\":\"63de8e8f91f2661c\",\"/knowledge-medium/pr-preview/pr-1891/src/data/invalidation.js\":\"003fde33e3202c1a\",\"/knowledge-medium/pr-preview/pr-1891/src/data/kernelDataExtension.js\":\"704c4307aaa44f4f\",\"/knowledge-medium/pr-preview/pr-1891/src/data/kernelPage.js\":\"648c64bff7114b84\",\"/knowledge-medium/pr-preview/pr-1891/src/data/kernelValuePresetCores.js\":\"8f8b20d833e8c88b\",\"/knowledge-medium/pr-preview/pr-1891/src/data/localDbCorruptionSignal.js\":\"2d71a187c8ead298\",\"/knowledge-medium/pr-preview/pr-1891/src/data/localDbStorage.js\":\"0f8a401494d9af21\",\"/knowledge-medium/pr-preview/pr-1891/src/data/localDbVfs.js\":\"ede6bd91a8cca98e\",\"/knowledge-medium/pr-preview/pr-1891/src/data/localSchema.js\":\"d97799be9a5a6cd7\",\"/knowledge-medium/pr-preview/pr-1891/src/data/maintenance.js\":\"3f2d945f43823d22\",\"/knowledge-medium/pr-preview/pr-1891/src/data/mergeProperties.js\":\"3bdca7e6d2e60380\",\"/knowledge-medium/pr-preview/pr-1891/src/data/metricsConsoleHook.js\":\"6877d75591f6ee3c\",\"/knowledge-medium/pr-preview/pr-1891/src/data/migrationsPage.js\":\"545a5aed00b684e7\",\"/knowledge-medium/pr-preview/pr-1891/src/data/mutators.js\":\"95db6a0832ae3257\",\"/knowledge-medium/pr-preview/pr-1891/src/data/orderKey.js\":\"36d85fab64a2ff14\",\"/knowledge-medium/pr-preview/pr-1891/src/data/orderKeyPlacement.js\":\"0322fc3bca851bd9\",\"/knowledge-medium/pr-preview/pr-1891/src/data/outlineSurface.js\":\"1c402c80867128eb\",\"/knowledge-medium/pr-preview/pr-1891/src/data/pendingEditorContent.js\":\"ce81fe5536a86881\",\"/knowledge-medium/pr-preview/pr-1891/src/data/pendingUploadsSql.js\":\"23f25111da3a967c\",\"/knowledge-medium/pr-preview/pr-1891/src/data/pluginStateExtensions.js\":\"a9703c8047f04b2f\",\"/knowledge-medium/pr-preview/pr-1891/src/data/powerSyncLogger.js\":\"e5cbdc0d9f3fab54\",\"/knowledge-medium/pr-preview/pr-1891/src/data/projectorRuntime.js\":\"b672e70f214e505f\",\"/knowledge-medium/pr-preview/pr-1891/src/data/properties.js\":\"641a3e49e0cc6f0f\",\"/knowledge-medium/pr-preview/pr-1891/src/data/propertiesPage.js\":\"7d2cfe98c6136d75\",\"/knowledge-medium/pr-preview/pr-1891/src/data/propertyChildren.js\":\"ce1809f1a6923877\",\"/knowledge-medium/pr-preview/pr-1891/src/data/propertyDefinitionFanout.js\":\"5de9c3e2d21bd444\",\"/knowledge-medium/pr-preview/pr-1891/src/data/propertyDefinitionMetadata.js\":\"f79d55011940d46b\",\"/knowledge-medium/pr-preview/pr-1891/src/data/propertyDefinitionRegistry.js\":\"8c084e5b3aae84f2\",\"/knowledge-medium/pr-preview/pr-1891/src/data/propertyDisplayMode.js\":\"47e74f2c75271e50\",\"/knowledge-medium/pr-preview/pr-1891/src/data/propertyRowCreation.js\":\"1b7a22b3ce815b81\",\"/knowledge-medium/pr-preview/pr-1891/src/data/propertySchemaCreation.js\":\"1ef91b07d4822301\",\"/knowledge-medium/pr-preview/pr-1891/src/data/propertySeeds.js\":\"31c4c34bde0eceb6\",\"/knowledge-medium/pr-preview/pr-1891/src/data/recentsPage.js\":\"a651b0cec084dc80\",\"/knowledge-medium/pr-preview/pr-1891/src/data/refTargetComparableProperty.js\":\"61d0405e4906f445\",\"/knowledge-medium/pr-preview/pr-1891/src/data/referenceBlock.js\":\"38c6ea2e2aee698f\",\"/knowledge-medium/pr-preview/pr-1891/src/data/rejectedUploads.js\":\"64278fb0440044f5\",\"/knowledge-medium/pr-preview/pr-1891/src/data/releasePowerSyncConnection.js\":\"325f0e8f66c4e496\",\"/knowledge-medium/pr-preview/pr-1891/src/data/repo.js\":\"a99d091fa89e7d5a\",\"/knowledge-medium/pr-preview/pr-1891/src/data/repoProvider.js\":\"b759affc556d110e\",\"/knowledge-medium/pr-preview/pr-1891/src/data/rowProperty.js\":\"061946cf8acec867\",\"/knowledge-medium/pr-preview/pr-1891/src/data/searchFilter.js\":\"8e8177289c5ab65d\",\"/knowledge-medium/pr-preview/pr-1891/src/data/seedIdentityLedger.js\":\"08094714d1de1fb8\",\"/knowledge-medium/pr-preview/pr-1891/src/data/stateBlocks.js\":\"33b9822a7714e49e\",\"/knowledge-medium/pr-preview/pr-1891/src/data/structuralEditPolicy.js\":\"45544aae253412d1\",\"/knowledge-medium/pr-preview/pr-1891/src/data/structuralInsert.js\":\"4e28c8face438c07\",\"/knowledge-medium/pr-preview/pr-1891/src/data/subtreeDelete.js\":\"fc6eb83e1ee0a10c\",\"/knowledge-medium/pr-preview/pr-1891/src/data/syncStreamLock.js\":\"76eaa0a1294db8b1\",\"/knowledge-medium/pr-preview/pr-1891/src/data/syncedTableSqlRecognizer.js\":\"871aa48cdee4d265\",\"/knowledge-medium/pr-preview/pr-1891/src/data/syncedTableWriteGuard.js\":\"9aaad062a2690491\",\"/knowledge-medium/pr-preview/pr-1891/src/data/targets.js\":\"d8fb6e76ff06589e\",\"/knowledge-medium/pr-preview/pr-1891/src/data/typeColors.js\":\"bdc34ff9544cf150\",\"/knowledge-medium/pr-preview/pr-1891/src/data/typeDefinitionMetadata.js\":\"e31839863dcc4c19\",\"/knowledge-medium/pr-preview/pr-1891/src/data/typeDefinitionRegistry.js\":\"34dad9f2853a0bee\",\"/knowledge-medium/pr-preview/pr-1891/src/data/typeExtraction.js\":\"e5e49a3e104fc875\",\"/knowledge-medium/pr-preview/pr-1891/src/data/typeInitialValues.js\":\"e197a77b31aab2b7\",\"/knowledge-medium/pr-preview/pr-1891/src/data/typePropertyGroups.js\":\"aeea232c254a3c4f\",\"/knowledge-medium/pr-preview/pr-1891/src/data/typeSeeds.js\":\"9ab2caf05b5bc72b\",\"/knowledge-medium/pr-preview/pr-1891/src/data/typeTagger.js\":\"3301e1475f1233d5\",\"/knowledge-medium/pr-preview/pr-1891/src/data/typedRecords.js\":\"9f998476ddb3f136\",\"/knowledge-medium/pr-preview/pr-1891/src/data/typesPage.js\":\"0d1b1c4dd0a4aa75\",\"/knowledge-medium/pr-preview/pr-1891/src/data/userPrefs.js\":\"018d2ec381dcd0de\",\"/knowledge-medium/pr-preview/pr-1891/src/data/userSchemasService.js\":\"3dd60d5f98d5366c\",\"/knowledge-medium/pr-preview/pr-1891/src/data/userTypesService.js\":\"f4feb8133be699b8\",\"/knowledge-medium/pr-preview/pr-1891/src/data/valuePresetRegistry.js\":\"8c01fdee78364035\",\"/knowledge-medium/pr-preview/pr-1891/src/data/visibleChildren.js\":\"63e9306faa1c5ff7\",\"/knowledge-medium/pr-preview/pr-1891/src/data/workspaceConversion.js\":\"df81a67e8a0ef8e7\",\"/knowledge-medium/pr-preview/pr-1891/src/data/workspaceFirstSync.js\":\"c114f41b676d032a\",\"/knowledge-medium/pr-preview/pr-1891/src/data/workspaceIdNamespace.js\":\"68e29560f64957aa\",\"/knowledge-medium/pr-preview/pr-1891/src/data/workspaceSchema.js\":\"22e7b432b6debb07\",\"/knowledge-medium/pr-preview/pr-1891/src/data/workspaces.js\":\"9ac3902e49df1722\",\"/knowledge-medium/pr-preview/pr-1891/src/data/writeAheadLog.js\":\"1b9fbcb2605dbe89\",\"/knowledge-medium/pr-preview/pr-1891/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1891/src/editor/BlockPasteShellDecorator.js\":\"083c4148bc545b5d\",\"/knowledge-medium/pr-preview/pr-1891/src/editor/atTrigger.js\":\"fd2f5ab74d4f1930\",\"/knowledge-medium/pr-preview/pr-1891/src/editor/autocomplete.js\":\"3b849133377594b6\",\"/knowledge-medium/pr-preview/pr-1891/src/editor/codeMirrorExtensions.js\":\"e502b64ef6c549cd\",\"/knowledge-medium/pr-preview/pr-1891/src/editor/contentFlush.js\":\"3ceb50aee13295da\",\"/knowledge-medium/pr-preview/pr-1891/src/editor/defaultInteractions.js\":\"02dff80664489ab1\",\"/knowledge-medium/pr-preview/pr-1891/src/editor/editSettleSignal.js\":\"4bb1330bd2f9939d\",\"/knowledge-medium/pr-preview/pr-1891/src/editor/insertImage.js\":\"b9b770dc640f1694\",\"/knowledge-medium/pr-preview/pr-1891/src/editor/referenceCompletionRange.js\":\"a990e3ee7d75a246\",\"/knowledge-medium/pr-preview/pr-1891/src/editor/referenceTargetTypes.js\":\"ad53e58d93e11bfb\",\"/knowledge-medium/pr-preview/pr-1891/src/editor/syntaxContext.js\":\"55c0cd43da56f6b2\",\"/knowledge-medium/pr-preview/pr-1891/src/editor/triggerMatch.js\":\"8f0f813aa173b136\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/AppRuntimeProvider.js\":\"5fa15f44313a78e4\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/BlockFocusShellDecorator.js\":\"1e3afcabfe331bac\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/ExtensionRenderBoundary.js\":\"262786b60cbce4c5\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/PanelContentRecovery.js\":\"5ec47d00c40730bd\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/apiCatalog.js\":\"467bfb48595e984a\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/approveExtensionHere.js\":\"c94f93989d95da86\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/armedCutAppMount.js\":\"c2c9e0d2d9814f00\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/batchableKeyedStore.js\":\"84512baf5b37621f\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/blockInteraction.js\":\"6d974f9c5b1ba54e\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/blockSelectionAction.js\":\"897ca775fb29f57d\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/compileExtensionModule.js\":\"537a9f8dc824d8fe\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/compiledModuleCache.js\":\"5511c6d32f7b3189\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/continuousGestures.js\":\"039b00f9c2fa577c\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/core.js\":\"f3d18365afe85d8d\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/defaultRenderers.js\":\"138f28eb55815ba0\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/definitionFanoutAppMount.js\":\"3e124d164c7ecde4\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/dialogAppMount.js\":\"bc8168b01f7a2c21\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/dynamicExtensionSeeds.js\":\"a51fa53865deb408\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/dynamicExtensions.js\":\"2aba29fcf4821772\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/exampleExtensions.js\":\"1a868a0d35194b44\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/extensionApprovalStatus.js\":\"c832c24fc73b97cc\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/extensionLoadErrorToast.js\":\"db13bccfced5af8e\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/extensionLoadErrors.js\":\"3eca374227a1501b\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/extensionLookup.js\":\"f9b1f9beb37250fd\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/extensionToggles.js\":\"193da3195d2ddcf3\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/extensionUtilitiesCss.js\":\"aa4f1ca99d494f18\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/kernelPageDeletionGuard.js\":\"77736e7c5424df04\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/liveRuntime.js\":\"23c258e28d410c63\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/openExtensionsSettings.js\":\"4dbb5c7191582d8c\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/overridesCache.js\":\"0fc1591da25b2c5e\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/pluginIds.js\":\"b2046c1266677cc1\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/processorRejectionToast.js\":\"213220a74312b764\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/runtimeActions.js\":\"287a155fe12fedad\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/runtimeContext.js\":\"581e5e0de2e80d72\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/staticAppExtensions.js\":\"513cfa228c86c905\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/staticDataExtensions.js\":\"f283f221decc2eb9\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/toastAppMount.js\":\"21a47018438acb88\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/useOverrides.js\":\"23d39e53d071ec7a\",\"/knowledge-medium/pr-preview/pr-1891/src/extensions/useShortcutSurfaceActivations.js\":\"77369cc701441b33\",\"/knowledge-medium/pr-preview/pr-1891/src/facets/discoverToggleTree.js\":\"aa1f5ed0084be001\",\"/knowledge-medium/pr-preview/pr-1891/src/facets/facet.js\":\"8970e1c0b70d94ee\",\"/knowledge-medium/pr-preview/pr-1891/src/facets/resolveAppRuntime.js\":\"4cc98361cb948140\",\"/knowledge-medium/pr-preview/pr-1891/src/facets/runtimeEvents.js\":\"3ab0ae2f74cb45d2\",\"/knowledge-medium/pr-preview/pr-1891/src/facets/togglable.js\":\"9ca4b5929e8b737a\",\"/knowledge-medium/pr-preview/pr-1891/src/facets/variantFacet.js\":\"5212091eec1a21fc\",\"/knowledge-medium/pr-preview/pr-1891/src/facets/verbFacet.js\":\"2ecc9a2a6d6d6b49\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/block.js\":\"2095cff33b1dff02\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/focusedChild.js\":\"3df25d383bb4510e\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/propertySchemas.js\":\"88ead27b53b00d32\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/typeRegistry.js\":\"e0dfe6da6d36d029\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/useAncestorCrumbs.js\":\"41f80be75dbd1e1c\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/useAutocompleteListbox.js\":\"7135a272c06a725f\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/useDebouncedSearch.js\":\"1280e3105856707f\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/useDebouncedValue.js\":\"77495a2750796c2d\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/useFacetValue.js\":\"78d826455ef235cf\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/useIsFocalRender.js\":\"8a03594597752180\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/useIsReadOnly.js\":\"85e0841e3f6398b0\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/useMaterializeBacklog.js\":\"624b3d8493b1a59d\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/useMinuteClock.js\":\"99bc5ff5a7b1a57f\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/usePanelLayoutProjection.js\":\"16d8ecc9fc51bf68\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/usePendingInvitations.js\":\"f20720c77cff6ff9\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/useRendererRegistry.js\":\"09ee0cac94acf64f\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/useRetainedFieldRows.js\":\"9702be3bbc6c650d\",\"/knowledge-medium/pr-preview/pr-1891/src/hooks/useWorkspaces.js\":\"0537bc777cd9ada9\",\"/knowledge-medium/pr-preview/pr-1891/src/lib/utils.js\":\"b13796252f646bb5\",\"/knowledge-medium/pr-preview/pr-1891/src/main.js\":\"eb5a1a24d353571d\",\"/knowledge-medium/pr-preview/pr-1891/src/markdown/MarkdownImage.js\":\"299bea5021bc8e0f\",\"/knowledge-medium/pr-preview/pr-1891/src/markdown/blockSeparators.js\":\"07336c4e379ea828\",\"/knowledge-medium/pr-preview/pr-1891/src/markdown/context.js\":\"fa21e75a3007dfc0\",\"/knowledge-medium/pr-preview/pr-1891/src/markdown/defaultMarkdownExtension.js\":\"d56b48ed26e2eba6\",\"/knowledge-medium/pr-preview/pr-1891/src/markdown/extensions.js\":\"cb8bc1280477916b\",\"/knowledge-medium/pr-preview/pr-1891/src/markdown/renderMarkdownHtml.js\":\"d0ccd9e7c6c43453\",\"/knowledge-medium/pr-preview/pr-1891/src/minimal-editor.js\":\"a78b7663fa7130c7\",\"/knowledge-medium/pr-preview/pr-1891/src/paste/armedCut.js\":\"19b712cdbc33f3d2\",\"/knowledge-medium/pr-preview/pr-1891/src/paste/captureMediaVerb.js\":\"a12173cb5997dea5\",\"/knowledge-medium/pr-preview/pr-1891/src/paste/clipboard.js\":\"9999911148192581\",\"/knowledge-medium/pr-preview/pr-1891/src/paste/decision.js\":\"299907a95c514258\",\"/knowledge-medium/pr-preview/pr-1891/src/paste/operations.js\":\"c0d8d20e38191bef\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/account-header/AccountHeaderItem.js\":\"a42ded74f6d193c3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/account-header/index.js\":\"8a25dde9372a0b6b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f21b7ddfff01c39b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-dispatch-companion/askAgent.js\":\"447c651b340e462f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-dispatch-companion/askedStore.js\":\"e68ea154d4fbf0c7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"762555b5e952ca30\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-dispatch-companion/chipState.js\":\"c771d10abbe221ee\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-dispatch-companion/dataExtension.js\":\"0e43494cf47a5169\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-dispatch-companion/index.js\":\"712d34010f5eede2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"5014e250173f24cc\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-dispatch-companion/schema.js\":\"ab6ac76807185f17\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/AgentTokensDialog.js\":\"6bc2ab1a88b3687f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/BridgePairingDialog.js\":\"f8c96b9acf0efce2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/addMedia.js\":\"973f583ce58ef53c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentViews/backlinks.js\":\"16f4c43f4b5f3cfc\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentViews/block.js\":\"ae317c7ec3a1d6bf\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentViews/context.js\":\"59d34900d99d5d16\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentViews/displayIds.js\":\"18ca9efc7966d8bd\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentViews/index.js\":\"d70e5154c64d53f8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentViews/outline.js\":\"ec89083296b636f3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentViews/properties.js\":\"c930917e677430ca\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentViews/refs.js\":\"02e36000800036a7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"3cc9ed7d2c30a9da\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentViews/search.js\":\"95a686ee23e0307e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentViews/shared.js\":\"dbab3aad7e214361\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c91d5bd47d312c9f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentViews/text.js\":\"9afe04b811f5145c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/agentWrites.js\":\"274ae031484e8d32\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/authoringCatalog.js\":\"fb0a428d22777f79\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/blockRefTargets.js\":\"2847eb28e59e3f7f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/bridge.js\":\"1e377ff91a9f360d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/bridgeLoop.js\":\"ad36b2067d5567c5\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/changeHistory.js\":\"41300c0439bff3f2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/commands.js\":\"70c856fb6390b1e6\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/commentsCommands.js\":\"98766c96198b4a28\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/dataExtension.js\":\"5936041065bb28b1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/dataModelGuide.js\":\"fcc9b4b09a2c3688\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/dayPropertyInputs.js\":\"38f5988353586cd9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/describeRuntime.js\":\"aa13d29bbbc4f5b8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/extensionLint.js\":\"a48b94a209b8cd9a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/grainAudit.js\":\"b0f8a1ae1cbab730\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/healthCommand.js\":\"7f9e79293065dafd\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/index.js\":\"09fb65754f0bcf79\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/presetIdentity.js\":\"07021b6aa08eb08b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"728d4bce5cc7343c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/readMedia.js\":\"1606744b8717755d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/schema.js\":\"68aa353c3440e20e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/serialization.js\":\"ff415bf27d7b1bc4\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/targets.js\":\"ba3f415d2090408b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/tokens.js\":\"5acb6ab5b5776946\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/watchEvents.js\":\"f71b9e32571bf514\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/workspaceGuard.js\":\"ec0062e22f24e729\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/agent-runtime/writeCommands.js\":\"e4266bf07856e8af\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/alias/AliasCollisionToast.js\":\"cc7f9291c9ce8e04\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/alias/DuplicateNameBanner.js\":\"74e5a4de1747864c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/alias/collisionMerge.js\":\"81bd33ef0b7c321d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/alias/dataExtension.js\":\"93c36fdb7d20574a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/alias/index.js\":\"209ab7ca63091b26\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/alias/mergeCollisionAction.js\":\"fc699259e076eae0\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/alias/pageStyling.js\":\"bb8ce3e89887a5f1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/alias/rejectionToast.js\":\"68448a996f026892\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/alias/syncProcessor.js\":\"351c34927684d402\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/actions.js\":\"4dfca003d091d312\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/addComment.js\":\"df663097566486eb\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/anchor.js\":\"4b6f41f0d037a058\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/anchorState.js\":\"49ff9f35ede72ff0\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/commentLinks.js\":\"9d4804a39342766c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/confirmThreadDeletion.js\":\"1729f737a08ae8b3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/container.js\":\"500f368bd845ce03\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/dataExtension.js\":\"dca542d20e4ac6ed\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/deleteComment.js\":\"f70ac7b236c08089\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/highlights.js\":\"50ad3415acbfa61c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/index.js\":\"607fc71258bc6471\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/linkedCommentsPill.js\":\"358e96230beb2c00\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/margin.js\":\"33cfd8f3e1c4eeec\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/marginAnchorLinks.js\":\"2a8b02d7b6f479cc\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/marginSchema.js\":\"30a8b5dfee287924\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/newComment.js\":\"5de591a531ecb879\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/ownThreadPicker.js\":\"a5c747a6b50f364f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/placement.js\":\"b97b2f288ab4e63d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/queries.js\":\"89b549930d2fc508\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/quotePosition.js\":\"26ea54cf561e9c44\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/quotedIn.js\":\"1ecf6860630cf91d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/quotedRange.js\":\"44b844b9c3298c67\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/rangeRefs.js\":\"b22c64848a50fa7e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/readHighlights.js\":\"5a4781404d6b8e84\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/readSelection.js\":\"fbe6714e9b478764\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/readSelectionUi.js\":\"79ca44f537acee05\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/reanchor.js\":\"03fcb142d33d5c4d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/schema.js\":\"3132204a6648dc7e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/scope.js\":\"7f849d09c0cf4eaa\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/scopeThreads.js\":\"7781851e395adbcb\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/splitRetarget.js\":\"41dedbcde7a796a7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/suggestionCard.js\":\"16cb2d46cb006083\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/suggestions.js\":\"580f4841bd3e8e11\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/summaries.js\":\"99034620efaa4b00\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/summaryBatch.js\":\"e4cb9a6433ac3b1d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/surface.js\":\"8bc57f22d25ff332\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/threadNavigation.js\":\"7268140e50973c7d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/threads.js\":\"07de9cad812ea759\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/ui.js\":\"4a5b05ae7f5028ea\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/annotations/uiStore.js\":\"3baec4840b7ecdf9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/app-intents/appIntents.js\":\"153edea88812f02e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/app-intents/index.js\":\"feb5be0d4d171b18\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/app-update-prompt/index.js\":\"da435dc198956748\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/app-update-prompt/status.js\":\"534f91bc117b3b57\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"852f2ca935a57900\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/MediaBlockRenderer.js\":\"ca19ea086a3b89e7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/MediaDownLaneReplicator.js\":\"bf8d8fa69928f531\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/MediaUploadReconciler.js\":\"2040448c3eb83a58\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/assetDownLane.js\":\"fdd4bd4a6b66a5c5\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/assetResolver.js\":\"37515c52e1577faf\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/assetUpload.js\":\"5f9416e4e63b3af8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/attachmentCleanerIO.js\":\"24a566f6d44d3158\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/audit/supabaseAuditIO.js\":\"8f13e88bcc6607d3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/blobStore.js\":\"8421317aa4da2c33\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/browserMedia.js\":\"f5740ac182da54a4\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/byteStore.js\":\"99d5df9bf5be4c07\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/cleanerIO.js\":\"9807f982d54f8667\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/cleanupAttachments.js\":\"550c07e88c4ea476\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/dataExtension.js\":\"9d1a1a0e0d0bbefc\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/downLane.js\":\"2c2e8070affb7113\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/index.js\":\"b13ea411015f8afa\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/insertImageContribution.js\":\"bc9438fb3c954d83\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/laneArming.js\":\"b02358fec3cb4f68\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/laneLock.js\":\"cee839b7a27bf00b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/mediaBlock.js\":\"6ec496a05df5ec82\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/mediaCapture.js\":\"17bf6d9c9940e1b7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/mediaLanes.js\":\"0471c1a2c2bb396e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/mediaViewers.js\":\"cfafe075ca8a82eb\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/mediaViewersFacet.js\":\"77f26155380f41c2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/pasteCapture.js\":\"024e849dee2a8860\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/resolver.js\":\"707d41dbaf3ed0c2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/retryUploadsAction.js\":\"e77f117991be5637\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/storagePaths.js\":\"29bdda9fa8cb2cbc\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/uploadDrain.js\":\"9ce073495975e1bd\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/uploadLaneStatus.js\":\"23670768501589eb\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/uploadReconcile.js\":\"9103b3322028039d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/uploadRecovery.js\":\"6e52b4dd9aa63e9e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/uploadStore.js\":\"4a0f84f36fe175ed\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/attachments/useAssetObjectUrl.js\":\"a3f7f26c1cb1fa14\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f0443f54c2708d71\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks-view/BacklinksViewSection.js\":\"2cf848c050d7bc6f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks-view/facet.js\":\"00c61e5567c7c030\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks-view/index.js\":\"de8c3f76d977efd7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks-view/prop.js\":\"c480fd8a59debe53\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/BacklinkFilters.js\":\"d03910ba42e49f42\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a059324a12dacaa9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/BlockEntry.js\":\"2dd6188afbf772be\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/LinkedReferences.js\":\"35ca7ffb17d9f182\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"82a235a2ff1a01ed\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/dailyNoteDefaults.js\":\"85709d9b345f9fef\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/dataExtension.js\":\"edf461568788b2e6\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/edgeExclusions.js\":\"f81a9e6b979c948e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/filterProperty.js\":\"63357e7dc019ea31\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/index.js\":\"8ecfc15b06d22b35\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7defff6d85c1f3ca\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/inline-counts/applies.js\":\"892ddbfb67e34169\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/inline-counts/countQuery.js\":\"db7461dfbc85049f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/inline-counts/expansionStore.js\":\"988235db4a5a2417\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/inline-counts/index.js\":\"92974d71fe63a899\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"6e48286ddfec1826\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/presentationInvalidation.js\":\"1dd9f84cacfedddd\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/propertyEditorOverride.js\":\"657663661dda450b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/propertyFilter.js\":\"57b84fc55f76b009\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/query.js\":\"c7bcd9e9e4761dcc\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/resolveFilter.js\":\"55b221f27c653b06\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/sourceBatch.js\":\"4978c745a86d4556\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/sources.js\":\"55668a34579ad338\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/useBacklinks.js\":\"422aaf7871b0bf4d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b94ae1783b40d2c2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/birthday/BirthdayCelebration.js\":\"ab0dd6dc9dad4ddf\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/birthday/BirthdayOverlay.js\":\"74fc8f6255da66f2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/birthday/gate.js\":\"9c1cd5d6386f96f3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/birthday/index.js\":\"d0256a9933f8b83b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/birthday/wolfTheme.js\":\"ad5563d02c1ffae7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-drag/BlockDragLayer.js\":\"71c94f05c30f0b9f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-drag/dragController.js\":\"9b8bfc0727f7d2f4\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-drag/dropTarget.js\":\"3505ea2e5639281a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-drag/index.js\":\"801b4d1b451e2e9a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-drag/projection.js\":\"064f1e76583f2363\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-info/BlockMetaCard.js\":\"44da6f1ddd71ea37\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-info/index.js\":\"bcd4056d50f6c521\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-tagging/AddTagDialog.js\":\"f1759aae48d5f183\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ccd231c46ec6db78\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-tagging/TagNameIssueHint.js\":\"7be5ca7a49a59d9c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-tagging/addTagAction.js\":\"8eb4494c7be0eada\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-tagging/appendTag.js\":\"62071ea5457ca339\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-tagging/config.js\":\"8addbe873a6bdbda\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-tagging/dataExtension.js\":\"0f34c5e1fa0d0c97\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-tagging/index.js\":\"98b28f434c7eb76a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/block-tagging/propertyEditorOverride.js\":\"f67737f678b69561\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/breadcrumbs/BreadcrumbList.js\":\"66ff7438613ee3b3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"bd3a2052cc4963f2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e8b622dd3dca9bba\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b99b7b8590b87bb6\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"047071679ac4259a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/breadcrumbs/index.js\":\"6f65b3f34cff14b9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1e3dc9ad6f47fad7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/character-counter/CharacterCountItem.js\":\"e84812ea45b84b7f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/character-counter/ProfilePropertyEditor.js\":\"84cc8b3aebad1ecf\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/character-counter/actions.js\":\"b7bcc4c648866b2a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/character-counter/blockType.js\":\"65955c2ad7b6ba08\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/character-counter/charCount.js\":\"758b2a9a884a27c8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/character-counter/dataExtension.js\":\"c4bbe96c9c741156\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/character-counter/index.js\":\"e43d906cd694a885\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/character-counter/profiles.js\":\"bfb6d7e6d4a704bf\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/character-counter/properties.js\":\"47221b123900ee76\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/character-counter/subtree.js\":\"ade3f23c26d9effa\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/character-counter/textCounts.js\":\"ffb7ace37173f4eb\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/colemak-keybindings/index.js\":\"08917a0e85f2fafd\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/command-palette/CommandPalette.js\":\"0eb8307f32151e65\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/command-palette/HeaderItem.js\":\"ff80197c431ecd96\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/command-palette/context.js\":\"d09980f95f058714\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/command-palette/index.js\":\"64fdc63e15b22687\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/command-palette/selection.js\":\"e7e03ead79a45409\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/command-palette/toggleStore.js\":\"5ca54eb8005180cd\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/command-palette/useCommandPaletteActions.js\":\"0df57b372dedc7ba\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/contributors/ContributorBadges.js\":\"f7360cf77493bd1b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/contributors/author.js\":\"cd77c50672edf277\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/contributors/codeMirrorExtensions.js\":\"d9300c3dd432a9f9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/contributors/dataExtension.js\":\"0fb37b0f8eaeae4d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/contributors/index.js\":\"d6cc594054f569c7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/contributors/mentionAutocomplete.js\":\"0bae2c98ebd69519\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/contributors/processor.js\":\"fb812fc0863a09ed\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/contributors/profiles.js\":\"e73a5e4bb5c0606a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/contributors/queries.js\":\"0727fce605985631\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/contributors/schema.js\":\"1ab7d92c61aaf97e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"51e0b04a56d690e4\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/cursor-follows-scroll/followOrigin.js\":\"375abecab8d2b085\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/cursor-follows-scroll/index.js\":\"634dcf2bfe936456\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0ef0f6db74298233\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"1df8187110a7a237\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/CalendarGrid.js\":\"ed2d9a5a5803c083\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/DailyNotePicker.js\":\"cde3c87f5c8ba055\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"5188d5f988685815\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/DateNavDecorator.js\":\"5e2e5c7cf771c24b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/DateScrubOverlay.js\":\"167875ba23e08177\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/DayPropertyControl.js\":\"f0ca9377e8ac5c94\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/DayValueReferenceControl.js\":\"f246e870dcb0e843\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/HeaderItem.js\":\"edc693f85e758b31\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/ReschedulePicker.js\":\"69dfa91e4296deef\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/SpreadDatesDialog.js\":\"666aee51db08368c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/actions.js\":\"3f1f7a16d549b02d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/blockDateAdapter.js\":\"c944541473f812f5\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/calendar.js\":\"585b3ce935ab86f9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/dailyNotes.js\":\"011eae3c7fee2e69\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/dataExtension.js\":\"637a1021c14a1c26\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/dateScrubActions.js\":\"64525fe202c8f557\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/dateScrubGesture.js\":\"eecadba034d1aaa7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/dateScrubGestureActions.js\":\"febfa4315fe1077a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/dateScrubRecognizer.js\":\"bc3b4e1cb2deb888\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/dayProperty.js\":\"8ac25ef091fb0a00\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"711c3db2fd816df5\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/deletionGuard.js\":\"c18e169bf98f7d8d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/dueQuery.js\":\"fdfb4a3ba848ee57\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/index.js\":\"15e33ec5ba8f6767\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/landing.js\":\"b530cbdaff224bd1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/localSchema.js\":\"785abae453b036fa\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/referenceDateAdapter.js\":\"f9fc8d9658e350ac\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/rescheduleAction.js\":\"64d28d805725323c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/schema.js\":\"cea18fde06f167cf\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/spreadBlockDates.js\":\"2e66cee278a5f3c7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/spreadDatesAction.js\":\"6f8b8906059d3335\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/today.js\":\"f78b72448e84ed36\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"d95dc1e4a37a90ef\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ebaed534d1ab7fb9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/data-integrity/audit.js\":\"ab02145ad38fe238\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/data-integrity/auditAction.js\":\"e68121c4b2627c9d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/data-integrity/auditRanges.js\":\"90500d58baaa1034\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/data-integrity/diagnosticsSource.js\":\"69a269a3c989a66c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/data-integrity/divergenceScan.js\":\"42f51e836da2f03a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/data-integrity/index.js\":\"b3df84b67a7c60fc\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/data-integrity/propertyChildrenChecks.js\":\"fbf0e1e2ee9f8ac5\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/data-integrity/referencesMirror.js\":\"d69912d7136cabab\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/data-integrity/rowJson.js\":\"8e366585ffa979c9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/data-integrity/schedule.js\":\"fe53f5aa78a1c5a3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/data-integrity/store.js\":\"4dffaacb9d3200bf\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-maintenance/action.js\":\"c83daefcfa600288\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-maintenance/index.js\":\"849dd8c4411372cc\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-maintenance/plugin.js\":\"e1826ddea29815a0\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"256687d749879a1e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-mirror/actions.js\":\"36612ef73234f2f2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-mirror/changeMarker.js\":\"f03353907a2a9881\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-mirror/diagnostics.js\":\"7164027b2cb2fd37\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-mirror/fileSystemAccess.js\":\"0103a769eb9a746b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-mirror/filenames.js\":\"3cc5f9ee4dcc3f6e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-mirror/index.js\":\"cc2634eecb249665\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-mirror/mirror.js\":\"e1b6882b9a7665bd\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-mirror/runLock.js\":\"c72611aee4eef382\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-mirror/runtimeHealth.js\":\"c887e66a970a9aed\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-mirror/schedule.js\":\"67c3e5a3c6066f41\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/db-mirror/store.js\":\"de078363f4ac5da1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/default-themes/index.js\":\"c5544bd4336abc80\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/default-themes/themes.js\":\"56b5451e7606bb64\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/diagnostics/facet.js\":\"d464b127d255b577\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/diagnostics/useDiagnostics.js\":\"ccb042582c5ef117\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extension-prompts/dismissals.js\":\"bc8ab3ee0d5d37e8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extension-prompts/index.js\":\"2662d735820c8ae7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extension-prompts/status.js\":\"b76298c60cc32a28\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extension-prompts/store.js\":\"afe0195e6d57c92d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"df250327cb69b8e3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extensions-settings/ExtensionsSettings.js\":\"877375ea9bcd425c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extensions-settings/actions.js\":\"0a7ce5d317c6009f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extensions-settings/config.js\":\"ac56f986d4ed1128\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extensions-settings/dataExtension.js\":\"2f535c604db63880\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extensions-settings/effect.js\":\"fffe5c927761ce7f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extensions-settings/index.js\":\"d73bfa4a47d66970\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f5afd0544388f490\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extensions-settings/useToggleTree.js\":\"fbd7775b27ee65e7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extract-type/ExtractTypeDialog.js\":\"7aa6dfb918ef212a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"91e45a35339bf5a3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extract-type/PropertyShapePicker.js\":\"b602f75e80a0d0f9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extract-type/action.js\":\"200d74d24baa3d6c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/extract-type/index.js\":\"3ea46c441b0d0788\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/find-replace/FindReplaceDialog.js\":\"ead9e0c39a8f3015\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/find-replace/HeaderItem.js\":\"bbef0c9d06661f7e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/find-replace/dataExtension.js\":\"754ef4d35858562c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/find-replace/index.js\":\"62c4893b9f973c27\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/find-replace/search.js\":\"f68947ff3cd095e5\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/find-replace/toggleStore.js\":\"6c42b8211f709a81\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/LocationPropertyEditor.js\":\"9858e0bb4be2a8b8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/MapView.js\":\"700fca70e0360854\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/blockTypes.js\":\"c2431d8f7db3c158\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/codeMirrorExtensions.js\":\"009e3478e9eda250\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/createOrFindPlace.js\":\"a6bb6659c3135278\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/currentLocation.js\":\"3c66652ebfc2ea3f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/dataExtension.js\":\"b9900dc874448e9d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/geoContentDecorator.js\":\"98f3d97193aedf3d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/googlePlacesClient.js\":\"d14028357e82ef59\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/index.js\":\"a12b36ef9b2198e5\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/locationsPage.js\":\"bd5b339ff8e3fe78\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/mapViewport.js\":\"8970ff426d07eb52\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/pickCurrentLocation.js\":\"aeff99128edeb388\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/placeAutocomplete.js\":\"3a99bbb5bc419121\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/placeNameCollision.js\":\"c4dd113c5c575c43\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/properties.js\":\"3d7f9008b8c106e2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/propertyEditorOverrides.js\":\"a43489c790d77eac\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/query.js\":\"edf5bc24195655e1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/geo/usePlaceSearch.js\":\"6b12ad28b58fbaf1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"8405f72d98183e2d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"56a7b0a60675bf4c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"229b446bc15d7d68\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/grouped-backlinks/config.js\":\"def99e18b91d2cb2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/grouped-backlinks/dataExtension.js\":\"3ee1050e3a1b5a92\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/grouped-backlinks/facet.js\":\"9ad027f17d6ccff9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/grouped-backlinks/grouping.js\":\"76d1356d240c55ff\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/grouped-backlinks/index.js\":\"5da65c9a25388e1d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"38ce5766ba657d6e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/grouped-backlinks/query.js\":\"e3577c89e42db138\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/grouped-backlinks/resolveConfig.js\":\"7fde8f6cc38fce8d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"61d45e42545d6871\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d791f6ff88f32f5b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/html-document/HtmlDocumentContent.js\":\"875b48859bf52caf\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/html-document/HtmlFrame.js\":\"67708fc12dd635af\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/html-document/actions.js\":\"27da8166593cb214\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/html-document/blockType.js\":\"1ba2300a711d8e87\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/html-document/confirmRunScripts.js\":\"ade6df342667d1b2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/html-document/dataExtension.js\":\"0360c4ae895d27e7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/html-document/frameAnnotations.js\":\"41e76d02e92efd18\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/html-document/frameDocument.js\":\"8dbae3935b93175e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/html-document/frameTheme.js\":\"08eb7c8ecf15b35e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/html-document/index.js\":\"d24b219cec3a7c61\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/html-document/scriptConsent.js\":\"8ef1a1189147374f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/html-document/sourceMap.js\":\"553e0aa7c4711c3c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/html-document/useDocumentScripts.js\":\"75dfa13dbcc19ec1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/interaction-metrics/index.js\":\"ae8e00d3451253c0\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/interaction-metrics/record.js\":\"f12958bff46733c1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/interaction-metrics/recordStore.js\":\"7d6ccbb4f46ba141\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/interaction-metrics/responsiveness.js\":\"d0581c83b720a5a8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/interaction-metrics/schedule.js\":\"fc80a07096581380\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/interaction-metrics/sessionContext.js\":\"c9c5e3703a7e1a83\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"1443bfeca3d69518\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"f45256bec7643a1b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/keybindings-settings/actions.js\":\"9b15ee760ab887e3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/keybindings-settings/config.js\":\"e7c651c70849e8bc\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/keybindings-settings/dataExtension.js\":\"8de198789244b118\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/keybindings-settings/effect.js\":\"ff2d4f4bbc34d00a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/keybindings-settings/index.js\":\"ce89bd103d9df61a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/keybindings-settings/keyCapture.js\":\"10f845038c406fa1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/keybindings-settings/overrideStore.js\":\"ea9700c765d67b58\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"39adeac8221d5a37\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/left-sidebar/HeaderItem.js\":\"ad764f491e1968da\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/left-sidebar/LeftSidebar.js\":\"2bf2dd2cb625fe3b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/left-sidebar/actions.js\":\"49f68f3a85b0aeb1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/left-sidebar/facet.js\":\"8de3bd7ea4a71132\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/left-sidebar/index.js\":\"f0f39d2951bc84c8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/left-sidebar/shortcuts.js\":\"c8893ae0a61679b5\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/left-sidebar/toggleStore.js\":\"b3b646f74de5bde9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/merge-blocks/MergePicker.js\":\"046297ad2df84a2f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/merge-blocks/index.js\":\"289ec30b460ac884\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/merge-blocks/mergeAction.js\":\"09ec66db6f3e7551\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/merge-blocks/strategy.js\":\"b24e599994ce9195\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/mobile-bottom-nav/Button.js\":\"1e8d37ee85f8cdcb\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"47b1497749fb6822\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/mobile-bottom-nav/defaultItems.js\":\"602c120e2f8bb31b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/mobile-bottom-nav/facet.js\":\"1473372b9cf262a4\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/mobile-bottom-nav/index.js\":\"41233797bee02d45\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1f5ddc347ef3eb26\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c119d38ad0897468\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"1ddebb1ef47946d4\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/mobile-keyboard-toolbar/facet.js\":\"79e8fd799ddc6913\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/mobile-keyboard-toolbar/index.js\":\"7d469f1c04d1d7de\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/move-blocks/MoveDestinationPicker.js\":\"29c6ca87bab1e7dc\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c09ab24056a30cef\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/move-blocks/contextMenuItem.js\":\"34d1675d7ca454ac\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/move-blocks/index.js\":\"d7724976a9e7adc9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/move-blocks/moveAction.js\":\"1fcace56427d3c80\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/move-blocks/moveBlocks.js\":\"5e9dcf4d7a28ae7b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/move-blocks/selectionAfterMove.js\":\"f59a30ce92ff347c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/onboarding/TutorialBanner.js\":\"782d250399f57ed2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/onboarding/action.js\":\"8647f8ad4a2cee96\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/onboarding/bannerDismissal.js\":\"b8885c1325da47aa\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/onboarding/documents/cheatSheet.js\":\"eeccb8fc4620e39d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/onboarding/index.js\":\"508e8c8d5b3899d3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/onboarding/keys.js\":\"deb20a39f7ed5b2f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/onboarding/landing.js\":\"1927c11b03faccc0\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/onboarding/outline.js\":\"cf46c7b446630276\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/onboarding/seed.js\":\"dd9b3f22628962c4\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/perf-monitor/PerfTrendDialog.js\":\"472ff9ef278e8174\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/perf-monitor/analyze.js\":\"80cdb16f8a35d658\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/perf-monitor/diagnosticsSource.js\":\"f8055f0c3a3cf72b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/perf-monitor/index.js\":\"6710218017005151\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/perf-monitor/load.js\":\"e9fa45dd48bb180a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/perf-monitor/monitorRun.js\":\"06dd18836cb45ff1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/perf-monitor/schedule.js\":\"0aee5efc064a6737\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/perf-monitor/series.js\":\"65b71b3e6a5c5afa\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/perf-monitor/store.js\":\"2a0730d859f6b059\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/perf-monitor/trendAction.js\":\"7f23cf169270e2ce\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/perf-monitor/verdict.js\":\"49ae24e6687b54af\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/plain-outliner/clickToEditAction.js\":\"bbf8db99c145a10d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/plain-outliner/index.js\":\"67bbf6185178c0f6\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/plain-outliner/interactions.js\":\"36f68cc386fa289a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b305105e1dba063d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/properties-migration/MigrationGate.js\":\"db5dd34aaf21f63c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/properties-migration/MigrationGateDialog.js\":\"61555a7dcfa188ea\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/properties-migration/action.js\":\"f15e9b620e4d4dbb\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/properties-migration/index.js\":\"844054a2d2c0a333\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/properties-migration/localRunMessage.js\":\"9c3e6dcddd38deee\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/properties-migration/plugin.js\":\"fb4c897de2823e81\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/properties-migration/progressReport.js\":\"20fe6753370a8169\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/properties-migration/sweepProgress.js\":\"ac4276e491c80f61\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/property-rows/FieldRowRenderer.js\":\"b73961226dd6dd9f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/property-rows/ValueRowRenderer.js\":\"66197f604921aa98\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/property-rows/actions.js\":\"16547cf7842257b9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/property-rows/autocomplete.js\":\"e9b62f377e56f5df\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/property-rows/fieldRow.js\":\"acc50d8cb04e7879\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/property-rows/index.js\":\"5a04b609e11a780e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/property-rows/referenceWarning.js\":\"aa379ee32a3f26f5\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/property-rows/valueAutocomplete.js\":\"68bc52408bd26c0d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/property-rows/valueSchema.js\":\"784ebc5778248f08\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/quick-find/HeaderItem.js\":\"ac76ce75773116a1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/quick-find/QuickFind.js\":\"d2cc257de3626812\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/quick-find/index.js\":\"a224d5e2c7a09a34\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/quick-find/recents.js\":\"4a6ea4a59a584366\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/quick-find/resultItems.js\":\"6dbd44006d00a1e6\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/quick-find/selection.js\":\"079e4284526a5470\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/quick-find/toggleStore.js\":\"3910c12f35f3815e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/recents/HeaderItem.js\":\"60fd1aa496728229\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f1600d2ff66548bb\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/recents/grouping.js\":\"86c160672f227884\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/recents/index.js\":\"0f0256ed88be8c0b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/recents/target.js\":\"d630c09fa62fb6a8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/codeMirrorExtensions.js\":\"000595edbfbcd5b7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/contentPrefill.js\":\"c530177f2f164c96\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/dataExtension.js\":\"3b82c2ffef96d163\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/index.js\":\"461f7b95236d823f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"f953a7dc7fbf6f7f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/invalidation.js\":\"a35e4c6c451d81f0\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/localSchema.js\":\"03fb545c531c9ab3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/markdown/blockrefs/index.js\":\"a36532b3bcefefa8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2543386ab4a3ccce\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/markdown/index.js\":\"884df3d7fa4c511a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/markdown/referenceNode.js\":\"75d9b42615f23e16\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/markdown/remark-reference-occurrences.js\":\"f97f95f83355cd88\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"fb9d057354cd453b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/markdown/wikilinks/index.js\":\"55be249346c43ca9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"cd8e49bcb43ea8f5\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"99640c5f4ebcee7a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/mergeRetargetProcessor.js\":\"2fc21e9399ac6d81\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/parseFence.js\":\"6da48e3602f39068\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/referenceParser.js\":\"f123d4de747ddacc\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/referenceProjection.js\":\"c5f414bb0a60061f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/referencesProcessor.js\":\"78504a333951688e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/renameProcessor.js\":\"736c016a161cae78\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/references/spanReplacement.js\":\"7e35ef8c13a80eac\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/rich-paste/htmlToOutline.js\":\"badb92a97252864c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/rich-paste/index.js\":\"b0289cc95523e028\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/rich-paste/normalizeClipboardDom.js\":\"dbafb10ca9f06037\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/rich-paste/pasteDecision.js\":\"9908ff0bc32c795c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/action.js\":\"4b4c2b4b8a9fd7b8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/blockIds.js\":\"43919ab9cb13cf5f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/content.js\":\"a6a104fafa4180d3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/effect.js\":\"8d0a793a74767acd\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/ids.js\":\"9822269cc5d847d5\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/import.js\":\"359e6f88d2d8aa8b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/index.js\":\"68f1747471c42468\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/plan.js\":\"c6b375a463a232e2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/plugin.js\":\"15f33261a1e683a8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/promotion.js\":\"3c41f2ed91d761a0\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/properties.js\":\"9bc957542378f194\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/references.js\":\"525033ae3a33e5dd\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/report.js\":\"fe36dba13142aa23\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/roamMemo.js\":\"d68687082741ec9b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/runtime.js\":\"eb8e02d71b6ab0f2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/schemaReconciliation.js\":\"00b2606832545af2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/srsMarkers.js\":\"f040a04067f36fa6\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/todo.js\":\"8c0a822a2cf63800\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/typeCandidates.js\":\"83670fa248afa917\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/roam-import/types.js\":\"72c50a1d88dd92dd\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/search-health/index.js\":\"63cbdb7ccc8aaf47\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/search-health/store.js\":\"e31f0b15af482d3c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/shortcut-help/HeaderItem.js\":\"b3476ec88d23f220\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"bf7b15d017181256\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/shortcut-help/index.js\":\"10e190f85068f32e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/shortcut-help/model.js\":\"f98423a71f2d91f0\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/shortcut-help/toggleStore.js\":\"a75b91090a180480\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/shortcut-help/useKeyInspector.js\":\"7642a7b4ad8437d6\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"fade35183bf4a7a3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/spatial-navigation/ShellDecorator.js\":\"0856002ad25c8ef6\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/spatial-navigation/actions.js\":\"f1cffcafb280e1e9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/spatial-navigation/exclusionsFacet.js\":\"bca51ae30244f553\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/spatial-navigation/index.js\":\"4e6b0b2038998a19\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/spatial-navigation/shell.js\":\"5d21d8b2eafb218f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/spatial-navigation/surface.js\":\"d160566ae428ea2b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/spatial-navigation/walker.js\":\"6ccef00398b6d679\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-rescheduling/RescheduleToast.js\":\"b798bab52a0c5078\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-rescheduling/dataExtension.js\":\"b50786e99f47cc64\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-rescheduling/index.js\":\"847fe99deaf99f47\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-rescheduling/indicator.js\":\"3ae7504f601e074f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-rescheduling/moveSrsState.js\":\"ec8c0bcc838e9521\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"148c4e730f6aec3c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-rescheduling/scheduler.js\":\"b0d7472e1b58d6ec\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-rescheduling/schema.js\":\"250c59e02f092a05\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"91b32371381c3721\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-rescheduling/srsClipboard.js\":\"93ee5b2816bf1ffd\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2b9ebc1fba562127\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/DailyNoteReviewHint.js\":\"6e1a2e7ab45a4554\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/DeckPicker.js\":\"51c3d8eab9720fc0\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/ReviewControls.js\":\"961c7e5ab28ba978\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/ReviewDeckRenderer.js\":\"e52a4e42de635ca1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/ReviewSession.js\":\"37f76aaef54af64f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/actions.js\":\"00f58916b7a02abe\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/archive.js\":\"0debbde45c78961f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/dataExtension.js\":\"c3d587f122d9f2fe\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/deck.js\":\"4ed7a5460ff04043\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/dueQuery.js\":\"2df311089518deaa\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/gradeDecision.js\":\"8bc13bb4d35122df\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/index.js\":\"49ebbe73456353a0\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/keyHints.js\":\"c40899d9e537e685\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/reviewCardLayout.js\":\"bda76bb6a7dd2d33\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/reviewProgress.js\":\"18007831fe3353f9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/schema.js\":\"b91bed5d3ad88e2a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/srs-review/useDueCards.js\":\"71a9c45352bdcbc9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/startup-metrics/index.js\":\"148c57906629650c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/startup-metrics/record.js\":\"525747e535964afb\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/storage-persistence/index.js\":\"b040f86191632b0b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/storage-persistence/persistenceStatus.js\":\"c2a69a56b9e85a4f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/storage-persistence/requestAction.js\":\"799bc3cae271dddf\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/supertags/TypeChipsDecorator.js\":\"285a3055bff28f53\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/supertags/codeMirrorExtensions.js\":\"7402dcd3d2bd4cad\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/supertags/index.js\":\"adc79bceb4ccde0c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/supertags/typeAutocomplete.js\":\"91605bb69b803d14\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"fb56ea0c6c8fce10\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/swipe-quick-actions/actions.js\":\"cfb46f28ee2f85c9\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/swipe-quick-actions/anchor.js\":\"6dcad65f2ba491cb\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/swipe-quick-actions/events.js\":\"1fcd549f2e2dd3f1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/swipe-quick-actions/gestureActions.js\":\"5b9b4ddc6b7783c3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/swipe-quick-actions/index.js\":\"2b4b05c400991557\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"deb2fa49d33e692e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/sync-metrics/collect.js\":\"b93247dca014b0cf\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/sync-metrics/index.js\":\"e880acb2088c607f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/sync-metrics/record.js\":\"85f100408ac61392\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/system-status/RejectionDialog.js\":\"17834c8acc0a3fbb\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9d2d999eeeb3c98e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/system-status/index.js\":\"a61c975b8d628c69\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/system-status/model.js\":\"9bf84f439af82c5c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/system-status/queueCounts.js\":\"d92c89a6998f7400\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/system-status/rejectedHelpers.js\":\"512a94fb8cb6aa13\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/system-status/rematerializeAction.js\":\"ac39f5feb928cbef\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/system-status/useHysteresis.js\":\"431c3960eb94864d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/ColumnHeaders.js\":\"91686f8b7ebab3c2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/QueryUi.js\":\"14eedea1b97c7a77\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/TableLayout.js\":\"5350c1b765e0df28\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/actions.js\":\"65c586ff5d1906ae\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/cellEdits.js\":\"3f7af878815f17e8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/childrenViews.js\":\"bb0bc61d40ccdc33\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/columns.js\":\"808b23aff4b044b1\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/controller.js\":\"4688be92eb9b0832\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/convert.js\":\"1eab2d2129766efc\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/dataExtension.js\":\"85372b5f23e0c138\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/index.js\":\"7f399d7e449b0c6c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/keys.js\":\"22d5a30a7a7c627c\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/model.js\":\"7b0477ca077d0f8a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/query/QueryText.js\":\"74bcbd82755a2c6b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/query/backfill.js\":\"aaa4102481501a2a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/query/completion.js\":\"2fb8d32fba53021e\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/query/format.js\":\"fc3feb468f05133a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/query/parse.js\":\"cbde8a32c9b135ed\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/query/queryValue.js\":\"f59c2e678b1edde3\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/query/registrations.js\":\"34687c1c3bc06e44\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/query/source.js\":\"2c111b32b38db409\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/registry.js\":\"2339bf36570fabe7\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/rowGutter.js\":\"9509573e199a65e8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/rowVerbs.js\":\"8e2f7ed21e00d0ec\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/schema.js\":\"fe2b582920064055\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/tables/sort.js\":\"c366ecc3199c898a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/theme-toggle/effect.js\":\"43eab22b940b3d34\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/theme-toggle/index.js\":\"d5f70c196943f51d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/theme-toggle/theme.js\":\"c60cbd1ba4802f3d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/todo/actions.js\":\"66e9f5de1dac47c4\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/todo/dataExtension.js\":\"03065bebf7763582\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/todo/index.js\":\"11bcb639e8523893\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/todo/schema.js\":\"1679addff791c629\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/touch-selection/TouchSelectionLayer.js\":\"48f817ceb469540b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/touch-selection/actions.js\":\"b7a8e0aeacdca725\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/touch-selection/defaultItems.js\":\"1c5182bd32f2688f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/touch-selection/facet.js\":\"4f6dde1a25d52525\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/touch-selection/holdRecognizer.js\":\"7a53bc9b5b018291\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/touch-selection/index.js\":\"9de3517d990830f4\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/update-indicator/UpdateIndicator.js\":\"0250a8ff69361cbd\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/update-indicator/index.js\":\"1eefd13d6d0b0611\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/update-indicator/loadTimes.js\":\"a1aa98f6b81061a2\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/video-player/VideoNotesRenderer.js\":\"188c1b6119f37e35\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/video-player/VideoPlayerRenderer.js\":\"0bf34dc88319fb44\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/video-player/VideoTimeStamp.js\":\"efa7c1778b5b4d12\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/video-player/actions.js\":\"6fb408a10d6da8ca\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/video-player/index.js\":\"9cf542314c8fb03f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/video-player/markdown.js\":\"843d382ecc17123b\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/video-player/notes.js\":\"5bfea56f2390e5bf\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/video-player/registry.js\":\"76dc41beb4c3f175\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/video-player/remark-timestamps.js\":\"51c6072279f561ad\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/video-player/view.js\":\"c759b7690274dbfe\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/vim-link-hints/LinkHints.js\":\"e420f0e4b545d027\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/vim-link-hints/index.js\":\"4cbbef9b135aa94d\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/vim-link-hints/model.js\":\"161732f475a77346\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/vim-link-hints/settings.js\":\"c45e52d32670df2f\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/vim-normal-mode/actions.js\":\"f45a78ca02fa748a\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/vim-normal-mode/index.js\":\"2e8cc12d9e2400a0\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/vim-normal-mode/interactions.js\":\"1ea908e9779f0ed8\",\"/knowledge-medium/pr-preview/pr-1891/src/plugins/workspace-header/index.js\":\"168cc386ed8786d9\",\"/knowledge-medium/pr-preview/pr-1891/src/registerServiceWorker.js\":\"4ba282c0996d66c1\",\"/knowledge-medium/pr-preview/pr-1891/src/requestPersistentStorage.js\":\"a2fbb9654e4870e6\",\"/knowledge-medium/pr-preview/pr-1891/src/services/authRequestDeadline.js\":\"c8e2abd41b725a55\",\"/knowledge-medium/pr-preview/pr-1891/src/services/authStorage.js\":\"669c35034526b321\",\"/knowledge-medium/pr-preview/pr-1891/src/services/powersync.js\":\"86852838c8629e03\",\"/knowledge-medium/pr-preview/pr-1891/src/services/supabase.js\":\"2792896f3e840fc5\",\"/knowledge-medium/pr-preview/pr-1891/src/services/uploadErrorClassifier.js\":\"edfa6b45d4aefe28\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/ActiveContexts.js\":\"3a6a3b91d92b5208\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/HotkeyReconciler.js\":\"780cb94bfd98d84f\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/WipeLocalDataDialog.js\":\"dba95d0feae093c2\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/actionDispatch.js\":\"90a1a73c96c5c917\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/actionRefItems.js\":\"159d274d0719acb3\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/applyKeybindingOverrides.js\":\"a85630b7aef65496\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/blockActions.js\":\"c670a8c2499cd096\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/blockMergeGesture.js\":\"bacf9b4250228575\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/canonicalizeChord.js\":\"566245bf7480129b\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/defaultContexts.js\":\"8500080f3c7045df\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/defaultShortcuts.js\":\"0146a516a7097391\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/effectiveActions.js\":\"7844a0c49ce34848\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/gestureAction.js\":\"45e426421cee1b23\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/gestureBinding.js\":\"8e0f3acaae0eedc4\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/holdRegistry.js\":\"040d576ef9971241\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/keybindingConflicts.js\":\"9686c9d73e28382a\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/keybindingOverrides.js\":\"a82e5cb83bbef171\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/pointerAction.js\":\"631152f57edc0d40\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/resolve.js\":\"01676b22a2f57499\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/runAction.js\":\"f5b0b549b4fae75d\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/sequenceMatcher.js\":\"4cf709e7477fa9e8\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/types.js\":\"9134b893f3a3d55e\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/useActionContext.js\":\"4429f840da609b2d\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/useActionDiscovery.js\":\"eaecce24fe985ec4\",\"/knowledge-medium/pr-preview/pr-1891/src/shortcuts/utils.js\":\"cad7dbd61b6d2446\",\"/knowledge-medium/pr-preview/pr-1891/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1891/src/sw/bootStore.js\":\"afff169e5792bdef\",\"/knowledge-medium/pr-preview/pr-1891/src/sw/previewDatabases.js\":\"a05d17a3677ce705\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/byteTransform.js\":\"928096924bd7c2bc\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/attachmentCleaner.js\":\"bf5978704676f5c9\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/bundle/attachmentParts.js\":\"8521abe7a02467ae\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/bundle/bundleParts.js\":\"4d91bb297acb0859\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/bundle/bundleRecord.js\":\"0195954a3d06291a\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/bundle/manifest.js\":\"5abe1fa6ef8d77e0\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/bundle/takeBundle.js\":\"263bbb1bb0abee08\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/bundle/verifyBundle.js\":\"333a203db0ac2eb0\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/cleaningStage.js\":\"0db70cd7ed8394ec\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/conversionKey.js\":\"bc50407e9ab93107\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/conversionServer.js\":\"696d2c7fd36d6312\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/flip.js\":\"bafb4f370dfcd03d\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/flipAttempts.js\":\"2af7e9d0c7555d98\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/pages.js\":\"990b2ad4fec4d121\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/preflight.js\":\"21bc1d238847208f\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/reseal.js\":\"22ec3b9b566a1df9\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/runConversion.js\":\"65193bc4368c8b66\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/runLock.js\":\"b26ffdb2702fe251\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/sealing.js\":\"693786001a1a8470\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/sealingStage.js\":\"0c0e0278a46aa7bc\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/stage.js\":\"4528c3d2fef4d211\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/conversion/verifyReseal.js\":\"58aee8689881689f\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/aad.js\":\"0eb6e1a3282a7f53\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/aead.js\":\"7b0b63a0741616de\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/base32.js\":\"9e3be049e1157718\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/base64url.js\":\"d544e6f9f29db1cd\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/binaryEnvelope.js\":\"bf22d97a1b6395fd\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/byteAead.js\":\"c7da0db8484f588b\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/canary.js\":\"3da93216067fe83f\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/contentHash.js\":\"3e57c392883d700e\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/contentKey.js\":\"b10b1310839ae125\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/derivedIdNamespace.js\":\"2f883b505f8b6dc5\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/envelope.js\":\"f8865234a8a0755e\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/hex.js\":\"9044e91032f3a599\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/sha256Hex.js\":\"aedd3e519da0d120\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/crypto/workspaceKey.js\":\"1acbe5a6227d2c73\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/keys/conversionState.js\":\"2b4bcd54376db813\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/keys/flows/createEncryptedWorkspace.js\":\"5777c7a96d7fb13b\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/keys/flows/pastedKey.js\":\"f6c8b489be93b6f6\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"97fdcb80426030e7\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ee971d7c3a1e0ca9\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/keys/keyStore.js\":\"7d6e5264a19227af\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/keys/mintWorkspaceKey.js\":\"38c03d4d87a1cd04\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/keys/modePin.js\":\"b46b9d5df4b2ca99\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/keys/openWorkspaceKeys.js\":\"3fd33cf1cfbabfdf\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/keys/resolveWorkspaceEntry.js\":\"c6388d5c7e0ca49d\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/keys/resolver.js\":\"a8f6c13a08e11042\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/keys/workspaceAccess.js\":\"5a861dcafcedda52\",\"/knowledge-medium/pr-preview/pr-1891/src/sync/transform.js\":\"a78f99e896c797ca\",\"/knowledge-medium/pr-preview/pr-1891/src/themeBootDefaults.js\":\"5c48ab3cf9274457\",\"/knowledge-medium/pr-preview/pr-1891/src/types.js\":\"c7df947d9cb67ded\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/ClientLocalSettings.js\":\"d55544a82d916961\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/abortableSleep.js\":\"421f1678b41b5dab\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/array.js\":\"bbe7f721648872d1\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/backlinkAutocomplete.js\":\"f8420d841f48ca48\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/blockCrumbs.js\":\"6cb6c6f903c924d1\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/blockrefAutocomplete.js\":\"876321a70aec91c8\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/cadencedIdleJob.js\":\"4ff8237a6946037a\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/callbackSet.js\":\"ae000412811df2f1\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/clientId.js\":\"c5926abd37fe2679\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/codemirror.js\":\"e2a504de84c518d2\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/codemirrorCompletion.js\":\"cc270db08fd7afbc\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/copy.js\":\"00c2f249b9c4086a\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/dailyPage.js\":\"8f9bbee3abdb0ea8\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/dbForensics.js\":\"4f4e73c26c10d234\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/dbForensicsHooks.js\":\"7448c7ef12dd0047\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/deleteBlockThroughUi.js\":\"6b4b4de4a2058289\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/dialogs.js\":\"384592fab0699525\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/dom.js\":\"81753bda898b6ae5\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/downloadBlob.js\":\"e3f4ac7d6d0055b7\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/drawnWalk.js\":\"e50e5b20704a1669\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/exportSqliteDb.js\":\"988400888806e671\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/fileSystemAccess.js\":\"eb65ccec55c8f63f\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/flipSlide.js\":\"e2c101ac4406c63d\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/fnv1a.js\":\"a0a288db28914b5e\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/formatBytes.js\":\"2e069b645f5b6058\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/fuzzyRank.js\":\"047d310565c7438d\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/idbKeyedStore.js\":\"8beb187a5c185d31\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/idleCallbackPolyfill.js\":\"a48fdfaf3325ffc7\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/keyboardAwareScroll.js\":\"d9d01dc08be368a1\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/keyboardViewport.js\":\"4fdd1d8ec04e0be2\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/lastWorkspace.js\":\"e4cd2ff7a944227c\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/layoutColumns.js\":\"3cc871245a1fc045\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/layoutSessionDom.js\":\"9beca263f1ecc607\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/layoutSessionId.js\":\"896c290c3248cf38\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/linkClickGestures.js\":\"f8550e5eb12808f0\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/linkTargetAutocomplete.js\":\"4e03a9cc920704e8\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/localDbCorruption.js\":\"44416af239b1b95b\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/localDbRecovery.js\":\"4d7bbd014ec72a3c\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/markdownParser.js\":\"d37b0a2e7f88897a\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/memoize.js\":\"33e6a830c1b3077a\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/nameFieldCommit.js\":\"824ca4a8a39a0170\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/nameList.js\":\"d665036a8801f021\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/navigation.js\":\"5851eab866ee3276\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/omnilinerNamespace.js\":\"90a2fe8806d323fa\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/opfsPageScan.js\":\"b366f5581c9ae47b\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/panelClearance.js\":\"b1b74e841b20dfac\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/panelHistory.js\":\"0c88cfd3f9b3b8cc\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/panelLanes.js\":\"8ac019c7febeaefa\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/panelLayoutProjection.js\":\"e27cedf323484889\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/panelScrollAnchor.js\":\"a78da2740de6e19d\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/panelUrlFlags.js\":\"fd3e433272332304\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/platform.js\":\"fbb20b0a7bab48ab\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/pluralize.js\":\"a7e172cf50e614fa\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/propertyCreation.js\":\"56555d36baf5353f\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/propertyNavigation.js\":\"48af5802fe31eb60\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/propertyValueContext.js\":\"f26e455504d3eb1f\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/react.js\":\"e8e52ec37aee2d7d\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/relativeDate.js\":\"7fc12de4d565bc4a\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/relativeTime.js\":\"648faf3836756266\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/renderScope.js\":\"ba572d36814be434\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/resolvedThenable.js\":\"4d5b397f517b1208\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/routing.js\":\"20c56e205b143160\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/safeMode.js\":\"0ada513ed86197f1\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/scheduleIdle.js\":\"faf8116e603e1094\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/screenWakeLock.js\":\"65622ce62119500d\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/selection.js\":\"f30903cc9a49ec72\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/softKeyboardGrab.js\":\"6fa3f8401d8c5bc5\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/startupTimeline.js\":\"0a6fd379fa20d8f7\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/state.js\":\"ae8ffec41df23c01\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/string.js\":\"c7797ed3c50f2e80\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/surfaceZoom.js\":\"f95271d40afa8060\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/time.js\":\"b8632c83bfc765f5\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/toast.js\":\"3fde8f7f6777aefc\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/toggleStore.js\":\"5a7354db162f665c\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/untilStopped.js\":\"55e3793d5abe07f4\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/userActivity.js\":\"b22209223135e92c\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/viewTransition.js\":\"844c4f2270bb0fa7\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/viewport.js\":\"17438c82089e00ad\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/webLock.js\":\"a5eb6c1060447ffc\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/workspaceRecovery.js\":\"d925e3fa02c735f0\",\"/knowledge-medium/pr-preview/pr-1891/src/utils/workspaceSnapshotStore.js\":\"924a2351b50e608d\",\"/knowledge-medium/pr-preview/pr-1891/src/vendor/react-compiler-runtime.js\":\"ea4ad3a6b1012e44\",\"/knowledge-medium/pr-preview/pr-1891/src/vendor/react-dom-client.js\":\"9cfa9b52a7eb766c\",\"/knowledge-medium/pr-preview/pr-1891/src/vendor/react-dom-server-edge.js\":\"5688cf46f953bacf\",\"/knowledge-medium/pr-preview/pr-1891/src/vendor/react-dom-server.js\":\"398326aaffba7ae0\",\"/knowledge-medium/pr-preview/pr-1891/src/vendor/react-dom-static-edge.js\":\"c2c7ffe789dd1ebf\",\"/knowledge-medium/pr-preview/pr-1891/src/vendor/react-dom-static.js\":\"12316afec832f304\",\"/knowledge-medium/pr-preview/pr-1891/src/vendor/react-dom-test-utils.js\":\"df8a7340da89ee5f\",\"/knowledge-medium/pr-preview/pr-1891/src/vendor/react-dom.js\":\"497802846a5da9c5\",\"/knowledge-medium/pr-preview/pr-1891/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1891/src/vendor/react-jsx-runtime.js\":\"a40f03bfa2f755f2\",\"/knowledge-medium/pr-preview/pr-1891/src/vendor/react.js\":\"ac7ff0b43d376374\",\"/knowledge-medium/pr-preview/pr-1891/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1891/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1891/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
