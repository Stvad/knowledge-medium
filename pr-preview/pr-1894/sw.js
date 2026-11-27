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
		buildId: "7768df3a5803-379a705c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1894/\":\"86d2b26cc228c210\",\"/knowledge-medium/pr-preview/pr-1894/index.html\":\"86d2b26cc228c210\",\"/knowledge-medium/pr-preview/pr-1894/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1894/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1894/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1894/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1894/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1894/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1894/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1894/assets/FacadeVFS-C7CtloBW.js\":\"54cebcf7cb4f6108\",\"/knowledge-medium/pr-preview/pr-1894/assets/OPFSCoopSyncVFS-BRKsqzvn.js\":\"8065277fb5075a77\",\"/knowledge-medium/pr-preview/pr-1894/assets/OPFSWriteAheadVFS-DsZeIX8z.js\":\"642332b9b7e8a1c8\",\"/knowledge-medium/pr-preview/pr-1894/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1894/assets/wa-sqlite-RLbm0Fgv.js\":\"127a6e95433d132b\",\"/knowledge-medium/pr-preview/pr-1894/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1894/assets/wa-sqlite-async-N50p1_Uv.js\":\"e26c6d0f0aab2114\",\"/knowledge-medium/pr-preview/pr-1894/assets/worker-DwNzFEYV.js\":\"48d8520033c85a8c\",\"/knowledge-medium/pr-preview/pr-1894/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1894/chunks/app-Dfzfvh6n.js\":\"9ba6a69b4f862240\",\"/knowledge-medium/pr-preview/pr-1894/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1894/index.js\":\"617f160e7ecc406a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1894/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1894/assets/AccessHandlePoolVFS-BMSP4Wx9.js\":\"8d09f5a853036e41\",\"/knowledge-medium/pr-preview/pr-1894/assets/IDBBatchAtomicVFS-BLcwhjKv.js\":\"1526e87a0bb465c9\",\"/knowledge-medium/pr-preview/pr-1894/assets/MemoryVFS-D3AHCZbk.js\":\"9f96d941370fc7bc\",\"/knowledge-medium/pr-preview/pr-1894/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1894/assets/mc-wa-sqlite-D4x3mGSp.js\":\"de50d099a2ceef6f\",\"/knowledge-medium/pr-preview/pr-1894/assets/mc-wa-sqlite-async-BB6ILCJA.js\":\"c47c0fcea29208dc\",\"/knowledge-medium/pr-preview/pr-1894/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1894/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1894/chunks/AccessHandlePoolVFS-DtpCJBEc.js\":\"2df2221fa176e73d\",\"/knowledge-medium/pr-preview/pr-1894/chunks/FacadeVFS-DvFWbQO7.js\":\"8b08ddaf0c185704\",\"/knowledge-medium/pr-preview/pr-1894/chunks/IDBBatchAtomicVFS-BIhsxdtS.js\":\"d578f7478917da30\",\"/knowledge-medium/pr-preview/pr-1894/chunks/MemoryVFS-WBpg7p3g.js\":\"f92d64f5e4703368\",\"/knowledge-medium/pr-preview/pr-1894/chunks/OPFSCoopSyncVFS-BSfE0Ruk.js\":\"d869a9078bc16090\",\"/knowledge-medium/pr-preview/pr-1894/chunks/OPFSWriteAheadVFS-DJE1Zh7q.js\":\"09a87e5c0d4baea1\",\"/knowledge-medium/pr-preview/pr-1894/chunks/Preview-Dtd4VEvD.js\":\"533257dadd001a1b\",\"/knowledge-medium/pr-preview/pr-1894/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1894/chunks/card-BCr7jGJQ.js\":\"d809647ef9fb1885\",\"/knowledge-medium/pr-preview/pr-1894/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1894/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1894/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1894/chunks/dist-rNoFYODt.js\":\"b5881caa3d70426f\",\"/knowledge-medium/pr-preview/pr-1894/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1894/chunks/mc-wa-sqlite-DDpKKCLj.js\":\"1ba33d7c13ea5b53\",\"/knowledge-medium/pr-preview/pr-1894/chunks/mc-wa-sqlite-async-C7kM_nPf.js\":\"8ace5e36c043efd9\",\"/knowledge-medium/pr-preview/pr-1894/chunks/react-B-_6R_kE.js\":\"89e5b5896fd93899\",\"/knowledge-medium/pr-preview/pr-1894/chunks/react-B0pNa7c4.js\":\"132f2c56cd300420\",\"/knowledge-medium/pr-preview/pr-1894/chunks/react-B7EbVit-.js\":\"73d03c3880720729\",\"/knowledge-medium/pr-preview/pr-1894/chunks/react-BCH5XdUh.js\":\"214e50b89a470a9d\",\"/knowledge-medium/pr-preview/pr-1894/chunks/react-BfLW_eho.js\":\"a9abd432cccf855b\",\"/knowledge-medium/pr-preview/pr-1894/chunks/react-JaVrqnUU.js\":\"eac6e4e06a690431\",\"/knowledge-medium/pr-preview/pr-1894/chunks/react-dom-server-legacy.browser.production-CaEkEd4Y.js\":\"48ea334305a75e2e\",\"/knowledge-medium/pr-preview/pr-1894/chunks/react-dom-server.browser.production-BIzb6UG0.js\":\"b3374961254c3def\",\"/knowledge-medium/pr-preview/pr-1894/chunks/react-dom-server.edge.production-C54rSM7h.js\":\"709a33967e2c20e8\",\"/knowledge-medium/pr-preview/pr-1894/chunks/react-gl1URnnx.js\":\"fcbdcb2da7c427b1\",\"/knowledge-medium/pr-preview/pr-1894/chunks/react-kRyC_NB1.js\":\"a796bcbd51681276\",\"/knowledge-medium/pr-preview/pr-1894/chunks/server.browser-D6FlvkCr.js\":\"5b7aa0c65bc75843\",\"/knowledge-medium/pr-preview/pr-1894/chunks/textarea-C-vFj4eh.js\":\"10cc167d6e3376eb\",\"/knowledge-medium/pr-preview/pr-1894/chunks/ui-Dbmfum0D.js\":\"0a76cf9f98e69523\",\"/knowledge-medium/pr-preview/pr-1894/chunks/wa-sqlite-C1RDWQOf.js\":\"e77a35affdc0b48a\",\"/knowledge-medium/pr-preview/pr-1894/chunks/wa-sqlite-async-hA5MULzM.js\":\"7fbe50aa8d3c8b2d\",\"/knowledge-medium/pr-preview/pr-1894/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1894/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1894/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1894/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1894/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1894/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1894/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1894/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1894/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1894/src/App.js\":\"920ace4d39dd8234\",\"/knowledge-medium/pr-preview/pr-1894/src/appUpdate.js\":\"1dc2a069747990f9\",\"/knowledge-medium/pr-preview/pr-1894/src/appVersion.js\":\"033bab903a651d2c\",\"/knowledge-medium/pr-preview/pr-1894/src/bootstrap/initialLayout.js\":\"606692c04d5ee494\",\"/knowledge-medium/pr-preview/pr-1894/src/bootstrap/openWorkspaceData.js\":\"018a78cd4dc551ea\",\"/knowledge-medium/pr-preview/pr-1894/src/bootstrap/resolveWorkspace.js\":\"e05ee1e075042bce\",\"/knowledge-medium/pr-preview/pr-1894/src/bootstrap/workspaceBootstrap.js\":\"f8179a42d30e14cb\",\"/knowledge-medium/pr-preview/pr-1894/src/components/BlockComponent.js\":\"fa506a72e27687f0\",\"/knowledge-medium/pr-preview/pr-1894/src/components/BlockCrumbs.js\":\"919831f50474379c\",\"/knowledge-medium/pr-preview/pr-1894/src/components/BlockEditor.js\":\"a356660464ec658e\",\"/knowledge-medium/pr-preview/pr-1894/src/components/BlockLoadingPlaceholder.js\":\"0fd0d7b4479e94ba\",\"/knowledge-medium/pr-preview/pr-1894/src/components/BlockProperties.js\":\"aeb90672d2cb2283\",\"/knowledge-medium/pr-preview/pr-1894/src/components/BlockSearchPicker.js\":\"b346d157776b316a\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ConfirmBulkDeleteDialog.js\":\"c58e4728c5208d1e\",\"/knowledge-medium/pr-preview/pr-1894/src/components/DividerHandle.js\":\"d8cfe7c2dd2e7a7e\",\"/knowledge-medium/pr-preview/pr-1894/src/components/DraftEditor.js\":\"82b41240a0b5b0cb\",\"/knowledge-medium/pr-preview/pr-1894/src/components/GutterPill.js\":\"c137dd06690fef35\",\"/knowledge-medium/pr-preview/pr-1894/src/components/Header.js\":\"277bb1ca8c0bc3e2\",\"/knowledge-medium/pr-preview/pr-1894/src/components/LazyBlockComponent.js\":\"de081b96032ea0a4\",\"/knowledge-medium/pr-preview/pr-1894/src/components/Login.js\":\"7fb91ea54096af64\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ZoomableSurface.js\":\"3cf81347c136e430\",\"/knowledge-medium/pr-preview/pr-1894/src/components/editModeKeepalive.js\":\"4bc5dab4ed787978\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyDisplay/PropertyDisplayScope.js\":\"f487ecc65b534d01\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"fae07d3d7274f95a\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyEditors/RefPropertyEditor.js\":\"118de04401018b7f\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyEditors/RefTargetTypePicker.js\":\"31193309431458f3\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyEditors/SelectPropertyEditor.js\":\"bca57498e4fb9e6d\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyEditors/TypesPropertyEditor.js\":\"872a32294c21d5d3\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyEditors/defaults.js\":\"452b5ce1a8101762\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyEditors/kernelValuePresets.js\":\"b1f1e288afe8a40f\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyEditors/selectablePresets.js\":\"1e89eb4b465e1d97\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyEditors/typesPropertyUi.js\":\"b52494c8e6c6a718\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyPanel/AddPropertyForm.js\":\"dc545206ebed0ac4\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyPanel/PropertyPicker.js\":\"b4bcd3410d37e8a0\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyPanel/PropertyRow.js\":\"c39227e93b8c54a2\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyPanel/Rows.js\":\"537a43abd1a9ed6e\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyPanel/actions.js\":\"21aa9af24a21d15e\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyPanel/declarationOnly.js\":\"aa19c60d8b76e142\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyPanel/layout.js\":\"d5cf1f34a7d1a6ab\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyPanel/model.js\":\"d15a5da421b1c16a\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyPanel/shapeUi.js\":\"f0d01e5673ce86e7\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyPanel/shapes.js\":\"506879dd701ecfdd\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e4e3636d5ce92552\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyPanel/visibility.js\":\"d1cf7ef0f127986f\",\"/knowledge-medium/pr-preview/pr-1894/src/components/propertyPanelSections.js\":\"73c6f19f5a85423c\",\"/knowledge-medium/pr-preview/pr-1894/src/components/references/BlockEmbed.js\":\"99fd07ecac291b44\",\"/knowledge-medium/pr-preview/pr-1894/src/components/references/BlockLink.js\":\"f23c8ec91871e10f\",\"/knowledge-medium/pr-preview/pr-1894/src/components/references/BlockRef.js\":\"e29e46a6aa3782d6\",\"/knowledge-medium/pr-preview/pr-1894/src/components/references/CompactReferenceLink.js\":\"ac2109c1b817041c\",\"/knowledge-medium/pr-preview/pr-1894/src/components/references/ReferenceLink.js\":\"f1d419571d753607\",\"/knowledge-medium/pr-preview/pr-1894/src/components/references/cycleGuard.js\":\"6a1f68fdd001283d\",\"/knowledge-medium/pr-preview/pr-1894/src/components/references/cycleGuardContext.js\":\"428f554d4fbf3869\",\"/knowledge-medium/pr-preview/pr-1894/src/components/references/linkInteraction.js\":\"22fc46941a5e2480\",\"/knowledge-medium/pr-preview/pr-1894/src/components/references/referenceLayout.js\":\"399febc86e84502e\",\"/knowledge-medium/pr-preview/pr-1894/src/components/references/useBlockRefAncestors.js\":\"1b413fef5f774067\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/BlockGutter.js\":\"9f851c8836172e47\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/BlockInfoDialog.js\":\"0c724b6a45fd655e\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/BlockReadText.js\":\"b21200295906dbee\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/BlockTypeBlockRenderer.js\":\"05df95fa3c48dff1\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/BulletHoverCard.js\":\"9919e10c6896336d\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/CodeMirrorContentRenderer.js\":\"8935ec2138b9baad\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"a807d97e52c05757\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/ColumnResizeHandles.js\":\"87e0d7daa5d0719b\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d39953c9dd61051d\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/DefaultBlockRenderer.js\":\"63772bed5624151d\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/LayoutRenderer.js\":\"5ac34a204732c3f9\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/MarkdownContentRenderer.js\":\"601945a242538505\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/MissingDataRenderer.js\":\"8b062ac3129d707d\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/PanelRenderer.js\":\"ee8f48d42501201e\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/PropertySchemaBlockRenderer.js\":\"6054cf0c20cef4fe\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/TopLevelRenderer.js\":\"346699dc238d941c\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/blockGutterMode.js\":\"20b16d420196289f\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/blockTitleText.js\":\"e36ff170d3353f6f\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/fieldCreationKeydown.js\":\"32634228a41f2304\",\"/knowledge-medium/pr-preview/pr-1894/src/components/renderer/layoutRootContext.js\":\"d03f1bcc91ca446e\",\"/knowledge-medium/pr-preview/pr-1894/src/components/typeChip/TypeChip.js\":\"2cc247cbce9dc6d9\",\"/knowledge-medium/pr-preview/pr-1894/src/components/typeChip/chipStyle.js\":\"fd70b84161327f4c\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/anchored-floating.js\":\"fe187a4b1b3fc900\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/button.js\":\"dd0dd89c630bed94\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/card.js\":\"15c13d279f7d0d10\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/checkbox.js\":\"707bbac67999b98b\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/collapsible.js\":\"84041f1a6bba4e1a\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/command.js\":\"2293e5855aec677b\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/context-menu.js\":\"195f44110ce83ae4\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/dialog.js\":\"4da3ce796f7aed49\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/dropdown-menu.js\":\"4e302ab886c94b04\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/floating-listbox.js\":\"cf7b7fb22970a9bf\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/index.js\":\"2931b7d80652326f\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/input.js\":\"605e063281b0256a\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/kbd.js\":\"3d165051d9db5a8d\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/label.js\":\"252999d1e74953d7\",\"/knowledge-medium/pr-preview/pr-1894/src/components/ui/textarea.js\":\"40f86aabbac748a3\",\"/knowledge-medium/pr-preview/pr-1894/src/components/useEditModeYieldKeepalive.js\":\"8aae4d1aff56377a\",\"/knowledge-medium/pr-preview/pr-1894/src/components/util/BootFallback.js\":\"fbdda6c745a94e3f\",\"/knowledge-medium/pr-preview/pr-1894/src/components/util/FocusedRowLazyMount.js\":\"d9f0afab6c774f11\",\"/knowledge-medium/pr-preview/pr-1894/src/components/util/LazyViewportMount.js\":\"e950b52a17a88faa\",\"/knowledge-medium/pr-preview/pr-1894/src/components/util/LocalDbCorruptionFallback.js\":\"fb91a88df4a1b445\",\"/knowledge-medium/pr-preview/pr-1894/src/components/util/error.js\":\"d5f1b851a4909aed\",\"/knowledge-medium/pr-preview/pr-1894/src/components/util/lazyMountRegistry.js\":\"f92b0a16cd65fad4\",\"/knowledge-medium/pr-preview/pr-1894/src/components/util/suspense.js\":\"080809e2cd99ce52\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/CreateWorkspaceDialog.js\":\"f2aa6618e2c90854\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/PendingInvitations.js\":\"a009af1ecc57be0d\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/SyncProgress.js\":\"c41d7a1e00167e7d\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/UnlockProgress.js\":\"2d39abc9583877c2\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/WorkspaceKeyGate.js\":\"4219a8fc13319c61\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/WorkspaceSettingsDialog.js\":\"4bc9021f845a3a6d\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/WorkspaceSwitcher.js\":\"8021522ed9345285\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/WorkspaceSyncGate.js\":\"9ffcc90791d30a2f\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/conversion/ConversionFlow.js\":\"eb4adc9187559e47\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/conversion/ConversionFlowHost.js\":\"364a7cbb035d527c\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/conversion/EncryptionSection.js\":\"bedd60b6f8205b5a\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/conversion/attachmentPrompts.js\":\"3a85e21c55882ae1\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b828813c14979f88\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/conversion/conversionFlowDeps.js\":\"d4e2f71b5778eb8b\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/conversion/conversionFlowStore.js\":\"841c3bf29fe6834f\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/conversion/flowUi.js\":\"a8097bfe4b4ddc76\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/conversion/useConversionRun.js\":\"3269b2fdf15aad14\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/keyUi.js\":\"690290f8f228b824\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/useCloseOnKeyLoss.js\":\"ecd4892f37233114\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/useCloseOnServerE2ee.js\":\"b10853a7b162ae16\",\"/knowledge-medium/pr-preview/pr-1894/src/components/workspace/workspaceUnlocked.js\":\"742df9200fa113af\",\"/knowledge-medium/pr-preview/pr-1894/src/context/backgroundSubtree.js\":\"00592cba8374e07e\",\"/knowledge-medium/pr-preview/pr-1894/src/context/block.js\":\"07c09c616c9af3b1\",\"/knowledge-medium/pr-preview/pr-1894/src/context/layoutWsContext.js\":\"36b47c545f1c7097\",\"/knowledge-medium/pr-preview/pr-1894/src/context/propertyDisplay.js\":\"b610faa9c8558997\",\"/knowledge-medium/pr-preview/pr-1894/src/context/repo.js\":\"df0d0575958178ef\",\"/knowledge-medium/pr-preview/pr-1894/src/data/aliasClaim.js\":\"cd928ee4417b5dea\",\"/knowledge-medium/pr-preview/pr-1894/src/data/aliasSeatNamespace.js\":\"22ef21f2f55ac9c5\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/blockData.js\":\"6f8ac6c730261c42\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/blockType.js\":\"a2d4517e20d76675\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/changeScope.js\":\"5785f9f9b32894e7\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/codecs.js\":\"93d2186cfee80f03\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/derivedData.js\":\"1bc087a8693f2989\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/errors.js\":\"ead2a4907032e944\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/events.js\":\"b40c0e920bedd9ba\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/handle.js\":\"9fa904bbd5ea3b20\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/index.js\":\"576e620f2e718af5\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/mutator.js\":\"369518a810f11951\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/processor.js\":\"71b195726c819635\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/propertySchema.js\":\"0ea5666860d8330f\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/query.js\":\"a7765b8f553710c5\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/sameTxProcessor.js\":\"e975ba0a544e765e\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/schema.js\":\"9fa904bbd5ea3b20\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/tx.js\":\"9fa904bbd5ea3b20\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/typedBlockQuery.js\":\"4bb3ae39643e3096\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/user.js\":\"b80fd930c0f9e340\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/valuePresetCore.js\":\"1d3d575024a2d196\",\"/knowledge-medium/pr-preview/pr-1894/src/data/api/valuePresets.js\":\"897bd9fa8aaa1384\",\"/knowledge-medium/pr-preview/pr-1894/src/data/attachmentCleanerIOVerb.js\":\"bbc2e83f543481dd\",\"/knowledge-medium/pr-preview/pr-1894/src/data/block.js\":\"bceae1d0b3acddcc\",\"/knowledge-medium/pr-preview/pr-1894/src/data/blockCache.js\":\"14f2c6d4ab9b5f93\",\"/knowledge-medium/pr-preview/pr-1894/src/data/blockId.js\":\"ff01219cfda46faa\",\"/knowledge-medium/pr-preview/pr-1894/src/data/blockLiveness.js\":\"82a1ae993cec152b\",\"/knowledge-medium/pr-preview/pr-1894/src/data/blockMerge.js\":\"3e915944c23b03ed\",\"/knowledge-medium/pr-preview/pr-1894/src/data/blockSchema.js\":\"163a1577fd18816f\",\"/knowledge-medium/pr-preview/pr-1894/src/data/blockTypeLookup.js\":\"e0fa088ee2e004e5\",\"/knowledge-medium/pr-preview/pr-1894/src/data/blockTypes.js\":\"4040005eaa70549d\",\"/knowledge-medium/pr-preview/pr-1894/src/data/childrenView.js\":\"adbf36f291e10b15\",\"/knowledge-medium/pr-preview/pr-1894/src/data/clientContext.js\":\"0746bb95aa8c720e\",\"/knowledge-medium/pr-preview/pr-1894/src/data/dbFileSiblings.js\":\"aef5284c95584d11\",\"/knowledge-medium/pr-preview/pr-1894/src/data/definitionSeeds.js\":\"06c09b0c66c5b6a8\",\"/knowledge-medium/pr-preview/pr-1894/src/data/derivedIds.js\":\"077ddc37dfcc1d40\",\"/knowledge-medium/pr-preview/pr-1894/src/data/drawnSubtree.js\":\"a6c2727e82977995\",\"/knowledge-medium/pr-preview/pr-1894/src/data/facetBridge.js\":\"d21c4c41c4571800\",\"/knowledge-medium/pr-preview/pr-1894/src/data/facets.js\":\"6d774d25d6b4db8f\",\"/knowledge-medium/pr-preview/pr-1894/src/data/globalState.js\":\"1925e0c861321222\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/aliasClaimRederiveProcessor.js\":\"56b7bb36f3acb2e8\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/ancestorBatch.js\":\"b0156363b215418d\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/blockTypeTypeifyProcessor.js\":\"ab35a6f6d29ce698\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/clientSchema.js\":\"672dbcec77e0c531\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/commitPipeline.js\":\"11ddf99c6684975a\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/devAssertions.js\":\"212449e5d87ca029\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/firstSync.js\":\"d7aa77f1b91871ad\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/freshInitialLoad.js\":\"adcc40123483c444\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/graphBackfillClaim.js\":\"4ed5ce29ac4b8f89\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/handleStore.js\":\"01561d53db58be9c\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/idleMarkerJobs.js\":\"106e4bdb06209e6e\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/initialDownload.js\":\"58b9590d149d1635\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/initializeClientDatabase.js\":\"d68605349945dc9c\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/jsonCanonical.js\":\"37ec47ae445b66e7\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/kernelInvalidation.js\":\"9683cc656f76fcc7\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/kernelProcessors.js\":\"8b253ac673217970\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/kernelQueries.js\":\"27c8d64603cd4ab0\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/mergeTypeMembershipProcessor.js\":\"4b077ba02d4ac5ee\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/normalizeReferencesProcessor.js\":\"a445da6b4895451d\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/poolInstrumentation.js\":\"abe5363581cba97e\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/processorRunner.js\":\"ccded737443640aa\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/propertyCellBackfill.js\":\"6071389e791f5874\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/propertyChildMint.js\":\"ed35caed3d7ab502\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/propertyChildrenProcessor.js\":\"27dde7d2ae185952\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9f3567874d6d7b50\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/propertyDefinitionSynthesis.js\":\"aca40c78d2fce75e\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/propertyKeyScan.js\":\"d910c0a26fbe0365\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/propertySchemaResolution.js\":\"ca879147d5965b98\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/propertyValueEdits.js\":\"4f8649dc2610fafa\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/raiseProtocol.js\":\"450e375db68c10e1\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/readBatch.js\":\"921cefcf6376ec68\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/refProjection.js\":\"e04b9c03bd7a90b6\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/referenceTargetLookups.js\":\"6d28d05f3e909673\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/referenceTargetProcessor.js\":\"87d9be80d896d972\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/replayMerge.js\":\"dab507dd698a48f1\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/sqlBinds.js\":\"74165dcd2421cf7e\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"73d03572a9e1cf1e\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/syncObserver/arrivalProcessors.js\":\"31a94e3ddfa73358\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/syncObserver/invalidate.js\":\"dfbf9953ad95e6ed\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/syncObserver/materialize.js\":\"f86a790b894454de\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/syncObserver/observer.js\":\"1b555e0686b7984a\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/syncObserver/reconcile.js\":\"02cf82f2f6508e59\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/timingMetrics.js\":\"25a49e2212426963\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/treeQueries.js\":\"1c5a3d6357878d99\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/txEngine.js\":\"1e47dfd161e9412e\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/txSnapshots.js\":\"34da4a92a4ddc177\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/typedBlockQuery.js\":\"3f2f1c7c049d9c58\",\"/knowledge-medium/pr-preview/pr-1894/src/data/internals/undoManager.js\":\"8e88116e791797fc\",\"/knowledge-medium/pr-preview/pr-1894/src/data/invalidation.js\":\"c366a1ce161983db\",\"/knowledge-medium/pr-preview/pr-1894/src/data/kernelDataExtension.js\":\"9162b41cc0d69ab7\",\"/knowledge-medium/pr-preview/pr-1894/src/data/kernelPage.js\":\"9887d44cc762cdd7\",\"/knowledge-medium/pr-preview/pr-1894/src/data/kernelValuePresetCores.js\":\"f918dd6d50d6196f\",\"/knowledge-medium/pr-preview/pr-1894/src/data/localDbCorruptionSignal.js\":\"45a74bfce1fcb223\",\"/knowledge-medium/pr-preview/pr-1894/src/data/localDbStorage.js\":\"902dbeb7560219c4\",\"/knowledge-medium/pr-preview/pr-1894/src/data/localDbVfs.js\":\"980beb434c484b22\",\"/knowledge-medium/pr-preview/pr-1894/src/data/localSchema.js\":\"ef8e742edf5f958e\",\"/knowledge-medium/pr-preview/pr-1894/src/data/maintenance.js\":\"cf02056c3d99f9bf\",\"/knowledge-medium/pr-preview/pr-1894/src/data/mergeProperties.js\":\"69a73b23a7baa8c6\",\"/knowledge-medium/pr-preview/pr-1894/src/data/metricsConsoleHook.js\":\"b7f293d1c96dd28b\",\"/knowledge-medium/pr-preview/pr-1894/src/data/migrationsPage.js\":\"2beba93efde34f59\",\"/knowledge-medium/pr-preview/pr-1894/src/data/mutators.js\":\"4c3ed3e939f128b3\",\"/knowledge-medium/pr-preview/pr-1894/src/data/orderKey.js\":\"e5ce93b2d2dad225\",\"/knowledge-medium/pr-preview/pr-1894/src/data/orderKeyPlacement.js\":\"f9fc6c7c1b4844f6\",\"/knowledge-medium/pr-preview/pr-1894/src/data/outlineSurface.js\":\"5c85c991bf0cb21e\",\"/knowledge-medium/pr-preview/pr-1894/src/data/pendingEditorContent.js\":\"682e65333696c576\",\"/knowledge-medium/pr-preview/pr-1894/src/data/pendingUploadsSql.js\":\"76dc2014833cfeca\",\"/knowledge-medium/pr-preview/pr-1894/src/data/pluginStateExtensions.js\":\"0aa7240386f5226a\",\"/knowledge-medium/pr-preview/pr-1894/src/data/powerSyncLogger.js\":\"f8308bbe1439f8a9\",\"/knowledge-medium/pr-preview/pr-1894/src/data/projectorRuntime.js\":\"43020dd5eca56f26\",\"/knowledge-medium/pr-preview/pr-1894/src/data/properties.js\":\"943be586af5d87b0\",\"/knowledge-medium/pr-preview/pr-1894/src/data/propertiesPage.js\":\"e534931e9e860e06\",\"/knowledge-medium/pr-preview/pr-1894/src/data/propertyChildren.js\":\"a838233da215e2ba\",\"/knowledge-medium/pr-preview/pr-1894/src/data/propertyDefinitionFanout.js\":\"1dc77c8df2d38361\",\"/knowledge-medium/pr-preview/pr-1894/src/data/propertyDefinitionMetadata.js\":\"6f6ea1f52e54a455\",\"/knowledge-medium/pr-preview/pr-1894/src/data/propertyDefinitionRegistry.js\":\"8c67660b0769cbaa\",\"/knowledge-medium/pr-preview/pr-1894/src/data/propertyDisplayMode.js\":\"db69d93e71cce07c\",\"/knowledge-medium/pr-preview/pr-1894/src/data/propertyRowCreation.js\":\"df3a4f3f3322a5d3\",\"/knowledge-medium/pr-preview/pr-1894/src/data/propertySchemaCreation.js\":\"630c38145ddc0d4e\",\"/knowledge-medium/pr-preview/pr-1894/src/data/propertySeeds.js\":\"85484220e18d5c0d\",\"/knowledge-medium/pr-preview/pr-1894/src/data/recentsPage.js\":\"9a36515248779a78\",\"/knowledge-medium/pr-preview/pr-1894/src/data/refTargetComparableProperty.js\":\"cd2512cad86b96c7\",\"/knowledge-medium/pr-preview/pr-1894/src/data/referenceBlock.js\":\"e119eed57f6a9b30\",\"/knowledge-medium/pr-preview/pr-1894/src/data/rejectedUploads.js\":\"33ca815adfaad1ce\",\"/knowledge-medium/pr-preview/pr-1894/src/data/releasePowerSyncConnection.js\":\"b7096b3a29c91671\",\"/knowledge-medium/pr-preview/pr-1894/src/data/repo.js\":\"3439f5e042ef9dd4\",\"/knowledge-medium/pr-preview/pr-1894/src/data/repoProvider.js\":\"79e0e137d0fa45f3\",\"/knowledge-medium/pr-preview/pr-1894/src/data/rowProperty.js\":\"1746ee5a6b8d131c\",\"/knowledge-medium/pr-preview/pr-1894/src/data/searchFilter.js\":\"23294cd4c8923a8b\",\"/knowledge-medium/pr-preview/pr-1894/src/data/seedIdentityLedger.js\":\"08c3c4e5052f2aaa\",\"/knowledge-medium/pr-preview/pr-1894/src/data/stateBlocks.js\":\"2288e70e6b604b5f\",\"/knowledge-medium/pr-preview/pr-1894/src/data/structuralEditPolicy.js\":\"2914f45afbeea92f\",\"/knowledge-medium/pr-preview/pr-1894/src/data/structuralInsert.js\":\"d26c248eb1cc4aab\",\"/knowledge-medium/pr-preview/pr-1894/src/data/subtreeDelete.js\":\"2e1f0e44752a31ba\",\"/knowledge-medium/pr-preview/pr-1894/src/data/syncStreamLock.js\":\"e7092b481cff4316\",\"/knowledge-medium/pr-preview/pr-1894/src/data/syncedTableSqlRecognizer.js\":\"127da6559cf4b415\",\"/knowledge-medium/pr-preview/pr-1894/src/data/syncedTableWriteGuard.js\":\"a03dcf48d5f8d29d\",\"/knowledge-medium/pr-preview/pr-1894/src/data/targets.js\":\"510a1cfa9bbc2c4f\",\"/knowledge-medium/pr-preview/pr-1894/src/data/typeColors.js\":\"68afc97861da4901\",\"/knowledge-medium/pr-preview/pr-1894/src/data/typeDefinitionMetadata.js\":\"dff2b63ed50b72ca\",\"/knowledge-medium/pr-preview/pr-1894/src/data/typeDefinitionRegistry.js\":\"83adb85ea22d10db\",\"/knowledge-medium/pr-preview/pr-1894/src/data/typeExtraction.js\":\"3b8c44b5fc89d910\",\"/knowledge-medium/pr-preview/pr-1894/src/data/typeInitialValues.js\":\"ced9c4a892741727\",\"/knowledge-medium/pr-preview/pr-1894/src/data/typePropertyGroups.js\":\"2f887a4385de568f\",\"/knowledge-medium/pr-preview/pr-1894/src/data/typeSeeds.js\":\"53ee84872d871b24\",\"/knowledge-medium/pr-preview/pr-1894/src/data/typeTagger.js\":\"ff8c253b5864d9f6\",\"/knowledge-medium/pr-preview/pr-1894/src/data/typedRecords.js\":\"815fc1feffe20916\",\"/knowledge-medium/pr-preview/pr-1894/src/data/typesPage.js\":\"205abe5342d24311\",\"/knowledge-medium/pr-preview/pr-1894/src/data/userPrefs.js\":\"4956a2dcbb2eafeb\",\"/knowledge-medium/pr-preview/pr-1894/src/data/userSchemasService.js\":\"1a0510e138f958e2\",\"/knowledge-medium/pr-preview/pr-1894/src/data/userTypesService.js\":\"9af197387b796e72\",\"/knowledge-medium/pr-preview/pr-1894/src/data/valuePresetRegistry.js\":\"e0ac76a2d20201b5\",\"/knowledge-medium/pr-preview/pr-1894/src/data/visibleChildren.js\":\"390109bd61169e3f\",\"/knowledge-medium/pr-preview/pr-1894/src/data/workspaceConversion.js\":\"33adc70f732e1b26\",\"/knowledge-medium/pr-preview/pr-1894/src/data/workspaceFirstSync.js\":\"e16e55b282c53c46\",\"/knowledge-medium/pr-preview/pr-1894/src/data/workspaceIdNamespace.js\":\"54c165f9d77225d4\",\"/knowledge-medium/pr-preview/pr-1894/src/data/workspaceSchema.js\":\"69c53ebf3b094a79\",\"/knowledge-medium/pr-preview/pr-1894/src/data/workspaces.js\":\"238430c8f70187ee\",\"/knowledge-medium/pr-preview/pr-1894/src/data/writeAheadLog.js\":\"596b6d744b5bc763\",\"/knowledge-medium/pr-preview/pr-1894/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1894/src/editor/BlockPasteShellDecorator.js\":\"e8ddb2a117af874f\",\"/knowledge-medium/pr-preview/pr-1894/src/editor/atTrigger.js\":\"80760c052ab57d5b\",\"/knowledge-medium/pr-preview/pr-1894/src/editor/autocomplete.js\":\"a66961273f36b241\",\"/knowledge-medium/pr-preview/pr-1894/src/editor/codeMirrorExtensions.js\":\"ca3c72cabfe55e26\",\"/knowledge-medium/pr-preview/pr-1894/src/editor/contentFlush.js\":\"7f56a7d4c0a20884\",\"/knowledge-medium/pr-preview/pr-1894/src/editor/defaultInteractions.js\":\"9c4c067c8aece0f4\",\"/knowledge-medium/pr-preview/pr-1894/src/editor/editSettleSignal.js\":\"669383d23584b39c\",\"/knowledge-medium/pr-preview/pr-1894/src/editor/insertImage.js\":\"efa74caea6203495\",\"/knowledge-medium/pr-preview/pr-1894/src/editor/referenceCompletionRange.js\":\"ced88db23b6c80c7\",\"/knowledge-medium/pr-preview/pr-1894/src/editor/referenceTargetTypes.js\":\"78215e592de295ed\",\"/knowledge-medium/pr-preview/pr-1894/src/editor/syntaxContext.js\":\"faf97fe1c7cec2ef\",\"/knowledge-medium/pr-preview/pr-1894/src/editor/triggerMatch.js\":\"e32f51afdae7f0aa\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/AppRuntimeProvider.js\":\"f1ff3c76bc0e3ec0\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/BlockFocusShellDecorator.js\":\"17829fceb778bbc1\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/ExtensionRenderBoundary.js\":\"64daec2fa7653ac8\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/PanelContentRecovery.js\":\"00bb1fcaacf6e4ce\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/apiCatalog.js\":\"0d9599a7e2678a04\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/approveExtensionHere.js\":\"c9ac08f4c8c084df\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/armedCutAppMount.js\":\"a522ef0013876758\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/batchableKeyedStore.js\":\"6e84fdd62ad9e843\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/blockInteraction.js\":\"f1745b1ab2ded822\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/blockSelectionAction.js\":\"80c533aa6604a597\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/compileExtensionModule.js\":\"5c811a0e5076cbd7\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/compiledModuleCache.js\":\"df3bc5c94521b8a6\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/continuousGestures.js\":\"b2915feee4f8239f\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/core.js\":\"6c4fda4695b9a769\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/defaultRenderers.js\":\"0fc82ce2deeda6a8\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/definitionFanoutAppMount.js\":\"ddc82fac9c665595\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/dialogAppMount.js\":\"378dac49da6fc2bb\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/dynamicExtensionSeeds.js\":\"cd1c9d605f9c0e5d\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/dynamicExtensions.js\":\"a1f1b32f67380592\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/exampleExtensions.js\":\"382309236c1f18de\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/extensionApprovalStatus.js\":\"23c2d0eb11d219dd\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/extensionLoadErrorToast.js\":\"aa23e288a4415d6c\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/extensionLoadErrors.js\":\"cd4e65aed6603c22\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/extensionLookup.js\":\"7f37c7e41070f169\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/extensionToggles.js\":\"13d4b4af2da512f1\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/extensionUtilitiesCss.js\":\"82e4e114335ba3bb\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/kernelPageDeletionGuard.js\":\"817f5865fd28883c\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/liveRuntime.js\":\"9575a106ad425611\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/openExtensionsSettings.js\":\"e458c2734a3e1bf6\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/overridesCache.js\":\"e68f44e0c1711324\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/pluginIds.js\":\"aa1c13748b9ff567\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/processorRejectionToast.js\":\"befd10315cd52413\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/runtimeActions.js\":\"d77f9616de4df342\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/runtimeContext.js\":\"fd38b51814116e8c\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/staticAppExtensions.js\":\"d5fc1a552168c75a\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/staticDataExtensions.js\":\"cd75eb27880a01df\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/toastAppMount.js\":\"2f92ec312162d818\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/useOverrides.js\":\"154d9aa964327169\",\"/knowledge-medium/pr-preview/pr-1894/src/extensions/useShortcutSurfaceActivations.js\":\"dcd1525e2f74dfe6\",\"/knowledge-medium/pr-preview/pr-1894/src/facets/discoverToggleTree.js\":\"ce805bd2fe0f30b9\",\"/knowledge-medium/pr-preview/pr-1894/src/facets/facet.js\":\"7365626730941bae\",\"/knowledge-medium/pr-preview/pr-1894/src/facets/resolveAppRuntime.js\":\"637cedfb5f341564\",\"/knowledge-medium/pr-preview/pr-1894/src/facets/runtimeEvents.js\":\"206014772bddd9ca\",\"/knowledge-medium/pr-preview/pr-1894/src/facets/togglable.js\":\"562f58fe095262ea\",\"/knowledge-medium/pr-preview/pr-1894/src/facets/variantFacet.js\":\"8cbb5ee66fddcbcf\",\"/knowledge-medium/pr-preview/pr-1894/src/facets/verbFacet.js\":\"198cc10fc8c39fca\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/block.js\":\"2645f2e6663bb107\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/focusedChild.js\":\"274683f819383c82\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/propertySchemas.js\":\"b37dd5bbb8a0031d\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/typeRegistry.js\":\"501dd04c1af8e982\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/useAncestorCrumbs.js\":\"d3090c8f1baf537b\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/useAutocompleteListbox.js\":\"a8ab76d79141f823\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/useDebouncedSearch.js\":\"9095932c0adcfff1\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/useDebouncedValue.js\":\"4b6c83073b46f905\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/useFacetValue.js\":\"a0b691850197b6a3\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/useIsFocalRender.js\":\"bcc705fc8c76d342\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/useIsReadOnly.js\":\"35e6206b0257f844\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/useMaterializeBacklog.js\":\"6ea9a47600d3585d\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/useMinuteClock.js\":\"470790d3f705a5c5\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/usePanelLayoutProjection.js\":\"322bc53630c6978d\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/usePendingInvitations.js\":\"97aa1a91268f037c\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/useRendererRegistry.js\":\"cb168bc7d8632184\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/useRetainedFieldRows.js\":\"a86c5205bd6e2ff3\",\"/knowledge-medium/pr-preview/pr-1894/src/hooks/useWorkspaces.js\":\"0c7fff19188e7e0b\",\"/knowledge-medium/pr-preview/pr-1894/src/lib/utils.js\":\"8135e3b9fbc7df07\",\"/knowledge-medium/pr-preview/pr-1894/src/main.js\":\"28688917689f8349\",\"/knowledge-medium/pr-preview/pr-1894/src/markdown/MarkdownImage.js\":\"9ba6076b2efbad9c\",\"/knowledge-medium/pr-preview/pr-1894/src/markdown/blockSeparators.js\":\"00df4a05702a62fa\",\"/knowledge-medium/pr-preview/pr-1894/src/markdown/context.js\":\"068bbd61f61520dd\",\"/knowledge-medium/pr-preview/pr-1894/src/markdown/defaultMarkdownExtension.js\":\"7123cef4b3bbad0e\",\"/knowledge-medium/pr-preview/pr-1894/src/markdown/extensions.js\":\"e9013723eb954b92\",\"/knowledge-medium/pr-preview/pr-1894/src/markdown/renderMarkdownHtml.js\":\"5476af29802e1fae\",\"/knowledge-medium/pr-preview/pr-1894/src/minimal-editor.js\":\"cc85821ecdeaaa0e\",\"/knowledge-medium/pr-preview/pr-1894/src/paste/armedCut.js\":\"73dc573f191923af\",\"/knowledge-medium/pr-preview/pr-1894/src/paste/captureMediaVerb.js\":\"b1b3b5a43658046e\",\"/knowledge-medium/pr-preview/pr-1894/src/paste/clipboard.js\":\"6ba8b5571ea0bf30\",\"/knowledge-medium/pr-preview/pr-1894/src/paste/decision.js\":\"638a8097c3fc6582\",\"/knowledge-medium/pr-preview/pr-1894/src/paste/operations.js\":\"1b0f135af6387e58\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/account-header/AccountHeaderItem.js\":\"b2ca420deb798f5d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/account-header/index.js\":\"90d37fc45fdcb541\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e807e41cdd33d060\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-dispatch-companion/askAgent.js\":\"98761facd374e052\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-dispatch-companion/askedStore.js\":\"c6baa961376eec83\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"cd27b1361601a4bd\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-dispatch-companion/chipState.js\":\"0921e30990e541b2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-dispatch-companion/dataExtension.js\":\"6b4c5d66a7f12327\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-dispatch-companion/index.js\":\"994807697227d6e3\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d981607e2fa70163\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-dispatch-companion/schema.js\":\"7d53abd269570052\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/AgentTokensDialog.js\":\"3834e56ac73dfbdc\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c02ac3cba75efa3d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/addMedia.js\":\"755e8268536f325d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7297eda78906fb49\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentViews/block.js\":\"cce93a3ec90d96ee\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentViews/context.js\":\"ec4b920af737cf4a\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e5a12df48ce6cf73\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentViews/index.js\":\"0e31c26c336b4c4c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentViews/outline.js\":\"5b496353337dee29\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentViews/properties.js\":\"03bb6ae528cbd31d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentViews/refs.js\":\"5b08cd53520283c4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"743d5d83466a792d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentViews/search.js\":\"c0fe338f09d0ebb4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentViews/shared.js\":\"de5f4d63199bb7aa\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6434176d76abe024\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentViews/text.js\":\"5a131e29cd9ff390\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/agentWrites.js\":\"33adcedc1657f158\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/authoringCatalog.js\":\"809e92d10c86ab1e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/blockRefTargets.js\":\"26a057d946a69976\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/bridge.js\":\"220b6c6ef8c95086\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/bridgeLoop.js\":\"075f25f5be6ef202\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/changeHistory.js\":\"4fb67d83ed5b1a6f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/commands.js\":\"3b5d784ecf6940bf\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/commentsCommands.js\":\"3d22cdb22b598db7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/dataExtension.js\":\"168663d3b8534e52\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/dataModelGuide.js\":\"fdf92d89d70ac334\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/dayPropertyInputs.js\":\"241d2925150cb71b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/describeRuntime.js\":\"a5145dabbe8a7b40\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/extensionLint.js\":\"7ea6c48899409412\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/grainAudit.js\":\"27de5e261f082e9b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/healthCommand.js\":\"a9a070497b1110c8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/index.js\":\"3cdf3731fdb06963\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/presetIdentity.js\":\"5a5a4ab3631aad0c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"0c7323cf58b14d1e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/readMedia.js\":\"1ab610bb0af83fc5\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/schema.js\":\"7925ab7eb798effa\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/serialization.js\":\"c2670d25decf9130\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/targets.js\":\"62539a6b21b1efaf\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/tokens.js\":\"ba10a2744b1f8fd8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/watchEvents.js\":\"9b267a33a9b52f18\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/workspaceGuard.js\":\"99d1683532ae6510\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/agent-runtime/writeCommands.js\":\"3740a4dd95d94ba6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/alias/AliasCollisionToast.js\":\"64a865eb50cb1130\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/alias/DuplicateNameBanner.js\":\"41948520989400ff\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/alias/collisionMerge.js\":\"095a101c336300a4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/alias/dataExtension.js\":\"ac19d866a4aa5777\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/alias/index.js\":\"a418b84a3003b359\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/alias/mergeCollisionAction.js\":\"c84e32365f5a7b94\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/alias/pageStyling.js\":\"b33244fdf1fe462e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/alias/rejectionToast.js\":\"ed0d8ed24d017a3c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/alias/syncProcessor.js\":\"a9395985b2a2ca72\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/actions.js\":\"4a547a197f845835\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/addComment.js\":\"554d81e9a8098204\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/anchor.js\":\"bd9fa45afd586936\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/anchorState.js\":\"5ede79745b9c383f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/commentLinks.js\":\"ff7261583943fded\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/confirmThreadDeletion.js\":\"f14de77596367c7c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/container.js\":\"d9885393fb89a063\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/dataExtension.js\":\"45328f89f9fc5081\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/deleteComment.js\":\"3db684fcca413bf8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/highlights.js\":\"445f7fa948ad8d65\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/index.js\":\"f0d54d3927b57604\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/linkedCommentsPill.js\":\"eb09af0221b5b558\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/margin.js\":\"744ae91ad7508284\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/marginAnchorLinks.js\":\"60f698a4d62eb166\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/marginSchema.js\":\"bb54f05fc56a3f04\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/newComment.js\":\"8c81775329efb37b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/ownThreadPicker.js\":\"e8118977f1102fbe\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/placement.js\":\"0ed6ec97eb539aab\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/queries.js\":\"873619cc96100d94\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/quotePosition.js\":\"692411ac24a03cad\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/quotedIn.js\":\"47728e16aa4c9ed2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/quotedRange.js\":\"972111158d7c4652\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/rangeRefs.js\":\"877c222f4912f913\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/readHighlights.js\":\"2a7c47b188765100\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/readSelection.js\":\"8ee3ad6debab494c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/readSelectionUi.js\":\"cfaaf9b2106e8aac\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/reanchor.js\":\"260d2371026bed34\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/schema.js\":\"3759b001464b6125\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/scope.js\":\"2ebc9c0d07b9fe8b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/scopeThreads.js\":\"3e2db307dca60c12\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/splitRetarget.js\":\"090626e170ac6039\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/suggestionCard.js\":\"d5632f2efeeb0a44\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/suggestions.js\":\"3b969f4bb9256b5d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/summaries.js\":\"4fd86fb006861829\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/summaryBatch.js\":\"a1e5579047174124\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/surface.js\":\"03f332cde19a71f9\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/threadNavigation.js\":\"d5455afe5b47b760\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/threads.js\":\"66cf226ddddeb4a6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/ui.js\":\"9f0fac95c4ce7a97\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/annotations/uiStore.js\":\"c486679317e7040c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/app-intents/appIntents.js\":\"ed283f95947ff52b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/app-intents/index.js\":\"3f91704de0c534ef\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/app-update-prompt/index.js\":\"6026bf6891f494a8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/app-update-prompt/status.js\":\"62db06ce259ada87\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"5e871780345d82d2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/MediaBlockRenderer.js\":\"73c3a1cf63023ebf\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/MediaDownLaneReplicator.js\":\"73b6006fbc828d51\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/MediaUploadReconciler.js\":\"32b1e5c34bfb818c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/assetDownLane.js\":\"ade57cc5e4ec77e9\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/assetResolver.js\":\"ecab45dbcb08f248\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/assetUpload.js\":\"72a89dc5b4dcafc1\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/attachmentCleanerIO.js\":\"225142d26b259397\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/audit/supabaseAuditIO.js\":\"1a40282a10b9d5c9\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/blobStore.js\":\"c62e2d975f58cede\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/browserMedia.js\":\"600dcd1b2529a60f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/byteStore.js\":\"e65da22d9e000895\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/cleanerIO.js\":\"e92a621e599237a3\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/cleanupAttachments.js\":\"4388fd5a933832e7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/dataExtension.js\":\"57c818d3dc3acec4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/downLane.js\":\"675bae6bc2b5d56d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/index.js\":\"7b662952e8a25ea6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/insertImageContribution.js\":\"20e437500e37bb62\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/laneArming.js\":\"b04112581a7e850f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/laneLock.js\":\"d59f46d9d810e3c8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/mediaBlock.js\":\"04ecd6fad2447844\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/mediaCapture.js\":\"012b0623e66512de\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/mediaLanes.js\":\"54426b671b006911\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/mediaViewers.js\":\"ea1d6bf12023704f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/mediaViewersFacet.js\":\"6a85a133f6593540\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/pasteCapture.js\":\"c3e090c919f05b1d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/resolver.js\":\"2b7edba8fd2590fc\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/retryUploadsAction.js\":\"6ff83bd589d5d9bd\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/storagePaths.js\":\"61bea0b88865a30e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/uploadDrain.js\":\"909d689d9102c5d1\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/uploadLaneStatus.js\":\"551fcac68073cda0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/uploadReconcile.js\":\"90aac366e07fad64\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/uploadRecovery.js\":\"0a86c28e752f0fb4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/uploadStore.js\":\"16e9091d4e86300f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/attachments/useAssetObjectUrl.js\":\"9a2349f426055398\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"b2dc6137361fd4ed\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c864901a91b30388\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks-view/facet.js\":\"87175dd92c40df0d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks-view/index.js\":\"aa537ee9c6f59e1d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks-view/prop.js\":\"e1c48f006cc503f0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/BacklinkFilters.js\":\"33d029191f597eed\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"fe0c1de2dc0904d2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/BlockEntry.js\":\"d873f7a104eb3e96\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/LinkedReferences.js\":\"a498637ef22207bb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"6596c6fd61407cbd\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/dailyNoteDefaults.js\":\"4eb98b86bc236251\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/dataExtension.js\":\"ae2b403a357fe4ec\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/edgeExclusions.js\":\"95b1243436f412d2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/filterProperty.js\":\"eae68bc97a9a3011\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/index.js\":\"6c76238e7da654f6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ee935a1b2387828d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/inline-counts/applies.js\":\"31bd42153314b1c0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/inline-counts/countQuery.js\":\"0d3cc1d57e4b14f7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/inline-counts/expansionStore.js\":\"caf0727597d72c83\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/inline-counts/index.js\":\"3458744402bc15c9\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9fe7ec5ffce76e1c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/presentationInvalidation.js\":\"41c8ceb7e6437ccb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/propertyEditorOverride.js\":\"deb201752d32a81c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/propertyFilter.js\":\"109896c5adae4388\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/query.js\":\"8166192e9183ca4a\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/resolveFilter.js\":\"224ecd31cf5ed17e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/sourceBatch.js\":\"3aca326160e7c9c6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/sources.js\":\"da9d190e5b350866\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/useBacklinks.js\":\"096372cd258994fa\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"252961e83e00c25f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/birthday/BirthdayCelebration.js\":\"8c4f6228e69835b5\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/birthday/BirthdayOverlay.js\":\"f8018e8a90e0d5a3\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/birthday/gate.js\":\"c2fee73410d27244\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/birthday/index.js\":\"87d17b139649a780\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/birthday/wolfTheme.js\":\"9a895f320b85d33f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-drag/BlockDragLayer.js\":\"b95be17fd94bd74e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-drag/dragController.js\":\"3049b6dfe8818413\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-drag/dropTarget.js\":\"0af950a59f1145e8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-drag/index.js\":\"8475c2eb808eaa8d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-drag/projection.js\":\"715369ec055d2683\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-info/BlockMetaCard.js\":\"2016694429704e05\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-info/index.js\":\"f6e05aca927aeb91\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-tagging/AddTagDialog.js\":\"dca865df0986bf28\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"708eee445bbe7d08\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-tagging/TagNameIssueHint.js\":\"3228b64876a21929\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-tagging/addTagAction.js\":\"ab0bcdd64e151269\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-tagging/appendTag.js\":\"60a7624ed5be4599\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-tagging/config.js\":\"54d4fd22f685372a\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-tagging/dataExtension.js\":\"1937ce45541a2356\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-tagging/index.js\":\"ac5677430f0c5c5d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/block-tagging/propertyEditorOverride.js\":\"d204caed8bfd24d7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/breadcrumbs/BreadcrumbList.js\":\"d052bc1b4524d787\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"8c53830d032a470f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/breadcrumbs/Breadcrumbs.js\":\"08bbe28ce79a289e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"f4a52fef7d440b9e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ad68b8d0f2893978\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/breadcrumbs/index.js\":\"4e78325510ef4e55\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"eb91ca4be714554a\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/character-counter/CharacterCountItem.js\":\"ace30e0a8f4f40d8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/character-counter/ProfilePropertyEditor.js\":\"48448386226de0db\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/character-counter/actions.js\":\"3c704714ff8ca95b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/character-counter/blockType.js\":\"fdf5bfdfce9665ad\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/character-counter/charCount.js\":\"9144453dc30125e4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/character-counter/dataExtension.js\":\"eb74b43869fbc667\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/character-counter/index.js\":\"652046c68956ddb5\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/character-counter/profiles.js\":\"10998d2f82edfdaa\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/character-counter/properties.js\":\"21cda2731864460d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/character-counter/subtree.js\":\"a8598ca669fe84ae\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/character-counter/textCounts.js\":\"58fb6b08cd3953f0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/colemak-keybindings/index.js\":\"59819744958029a2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/command-palette/CommandPalette.js\":\"bde211243ed3a053\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/command-palette/HeaderItem.js\":\"729bd8107466f4c6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/command-palette/context.js\":\"455b03b320102471\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/command-palette/index.js\":\"834de023e428dc54\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/command-palette/selection.js\":\"65d3ad97d356ec33\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/command-palette/toggleStore.js\":\"ac36eb0203ec6175\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/command-palette/useCommandPaletteActions.js\":\"0d5c9a60ff2facf4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/contributors/ContributorBadges.js\":\"b5b636d29765b655\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/contributors/ProfilePicture.js\":\"b76b4aeaa4af66bb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/contributors/author.js\":\"28f7594fc38a98c7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/contributors/codeMirrorExtensions.js\":\"f26faeed8b3e16a3\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/contributors/dataExtension.js\":\"9d762a6a805d2de4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/contributors/index.js\":\"dfb97e647a3dd3f7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/contributors/mentionAutocomplete.js\":\"f4e3a7318e9738e7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/contributors/processor.js\":\"11adca556d3be7cf\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/contributors/profiles.js\":\"db20ea89f4dbf0fa\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/contributors/queries.js\":\"fdb92da5c4103221\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/contributors/schema.js\":\"abd407456643e289\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/contributors/useCommentAuthor.js\":\"38d7f473d71f00ca\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"67e0f58a493937c7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a16a9e8b8360c809\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/cursor-follows-scroll/index.js\":\"e1b7d7f8df72036f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b8cefa4fb27905a0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0a6fd561fb4add51\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/CalendarGrid.js\":\"5f1658fbb8b4a0bb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/DailyNotePicker.js\":\"0c612880e7a9e912\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"575de46a8ca88613\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/DateNavDecorator.js\":\"f833a413484d45b5\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/DateScrubOverlay.js\":\"55289673d0faa0f3\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/DayPropertyControl.js\":\"fabaf126ef90c45f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/DayValueReferenceControl.js\":\"0667b99d14149ca9\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/HeaderItem.js\":\"44394f69ffc40729\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/ReschedulePicker.js\":\"99d4b01b5f93a861\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d578f6bda3a58de4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/actions.js\":\"cd3dca1f76d8a34c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/blockDateAdapter.js\":\"2818d078219a21ed\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/calendar.js\":\"8e7036a64ec4b041\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/dailyNotes.js\":\"3f785a4c199a8661\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/dataExtension.js\":\"8ed5e068bd891d00\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/dateScrubActions.js\":\"382e3bad0cebc2c5\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/dateScrubGesture.js\":\"b9d59628ec703529\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/dateScrubGestureActions.js\":\"24994400a54e9572\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f1e4e50b092b5d9e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/dayProperty.js\":\"15b1f5e26c9b7340\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"94ffa56cf6d258e8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/deletionGuard.js\":\"c45b4fe25817f2c8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/dueQuery.js\":\"38c762c09aaf1a88\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/index.js\":\"189b13a6c783c094\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/landing.js\":\"3d2f8a6f09d6f32d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/localSchema.js\":\"861f5ca25fbd39cd\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/referenceDateAdapter.js\":\"715527d8ef515455\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/rescheduleAction.js\":\"00de878da7cec385\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/schema.js\":\"8f38c3e9a2941a6d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/spreadBlockDates.js\":\"7f16b60a08f0b768\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/spreadDatesAction.js\":\"e14759522a1d5c8e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/today.js\":\"93f2d8b2ad283ef0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"feb7d3e30f123768\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b0c08d4fc53844a8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/data-integrity/audit.js\":\"35e5d04c0fbe0f37\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/data-integrity/auditAction.js\":\"433bee48273f9abe\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/data-integrity/auditRanges.js\":\"57913a7128435e71\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/data-integrity/diagnosticsSource.js\":\"bd88b69ff2fbc7f7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/data-integrity/divergenceScan.js\":\"c515ffdec8116a2d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/data-integrity/index.js\":\"493770fd7d8300f4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/data-integrity/propertyChildrenChecks.js\":\"6677abb6633e803c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/data-integrity/referencesMirror.js\":\"5719d46f85267644\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/data-integrity/rowJson.js\":\"3405a8eacabfb621\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/data-integrity/schedule.js\":\"abe173a2e38adfbe\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/data-integrity/store.js\":\"1f68874291ebe5d4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-maintenance/action.js\":\"0d010eb96478d3c2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-maintenance/index.js\":\"02c4ef99060cc324\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-maintenance/plugin.js\":\"7f3e331ff33957b6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b05295e34697c751\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-mirror/actions.js\":\"443b845da2906f04\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-mirror/changeMarker.js\":\"e16b4b677ca92ba6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-mirror/diagnostics.js\":\"4ce488fcdd0506a6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-mirror/fileSystemAccess.js\":\"c30a0da8222c40af\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-mirror/filenames.js\":\"ca37d46f96637d5f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-mirror/index.js\":\"d87c85ffcf878cb7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-mirror/mirror.js\":\"6c6edb7079ec6d4f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-mirror/runLock.js\":\"af4b3aa2a56dd63b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-mirror/runtimeHealth.js\":\"945b8961cbd28614\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-mirror/schedule.js\":\"5a94be8b6db661a2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/db-mirror/store.js\":\"116f56e3ae1d83dd\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/default-themes/index.js\":\"dd610616a8a1c7ce\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/default-themes/themes.js\":\"3713d339af57fd21\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/diagnostics/facet.js\":\"a6076d553bf72963\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/diagnostics/useDiagnostics.js\":\"eacb32f48c59d613\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extension-prompts/dismissals.js\":\"f1dd2a46bb90b3ef\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extension-prompts/index.js\":\"f9cbb995a5469d8f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extension-prompts/status.js\":\"af17ff83901b012c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extension-prompts/store.js\":\"d9ade1f0acd373d7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"0ad5d332b2f1bf76\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extensions-settings/ExtensionsSettings.js\":\"0d8312c4a81284a2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extensions-settings/actions.js\":\"2aea081751b913f5\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extensions-settings/config.js\":\"1095926dde9cdbaa\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extensions-settings/dataExtension.js\":\"1400d746f3f69df3\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extensions-settings/effect.js\":\"80a6d8fe1b96fb09\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extensions-settings/index.js\":\"74c129a8d49605f4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extensions-settings/propertyEditorOverride.js\":\"57333ba1d0a65b0b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extensions-settings/useToggleTree.js\":\"eab5a6fd37f901f8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extract-type/ExtractTypeDialog.js\":\"a839b6663ca8de01\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"06c17c4171ce67bc\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extract-type/PropertyShapePicker.js\":\"70935a2f4ceb58a9\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extract-type/action.js\":\"fb3af042b1279fac\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/extract-type/index.js\":\"28a0ced5f33b6fb5\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/find-replace/FindReplaceDialog.js\":\"d832f1a58d6d98da\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/find-replace/HeaderItem.js\":\"80bb93c0a2de6c9f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/find-replace/dataExtension.js\":\"a8e78176e2a6cb0a\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/find-replace/index.js\":\"9ae87f0efdb019af\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/find-replace/search.js\":\"19f0b6fa785140d9\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/find-replace/toggleStore.js\":\"b639f57fc29625e1\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/LocationPropertyEditor.js\":\"4d900ab6e95bd222\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/MapView.js\":\"e0c0694e4cb08f92\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/blockTypes.js\":\"7c439304aa2b81c9\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/codeMirrorExtensions.js\":\"5832492f76573860\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/createOrFindPlace.js\":\"441c45eb8cae0742\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/currentLocation.js\":\"769848fa97ad1083\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/dataExtension.js\":\"f1a2f037419ea734\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/geoContentDecorator.js\":\"7b56c924e355f664\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/googlePlacesClient.js\":\"1df425003aad07c7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/index.js\":\"1ce4975e1f646144\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/locationsPage.js\":\"3dc01598dc863c21\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/mapViewport.js\":\"768bea4d92a22c36\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/pickCurrentLocation.js\":\"1feb1694e8b49a06\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/placeAutocomplete.js\":\"2bee704a737aec44\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/placeNameCollision.js\":\"cb95e77438fe1348\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/properties.js\":\"6d7dd9f313b8f6de\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/propertyEditorOverrides.js\":\"7f925aa1b6e9ca6d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/query.js\":\"8ec79331db2593b3\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/geo/usePlaceSearch.js\":\"9eb3c9f0dee075da\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"cfde343d21f041f0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"0c893e2fc62d34f7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"0cc53e132aa1b6ba\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/grouped-backlinks/config.js\":\"23a819ae0b4c5f24\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/grouped-backlinks/dataExtension.js\":\"974665bda6c6bd33\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/grouped-backlinks/facet.js\":\"f0ff6d71019ab320\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/grouped-backlinks/grouping.js\":\"7f476dcc3451b5c4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/grouped-backlinks/index.js\":\"39278547c1250229\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"8c37a921aef6994d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/grouped-backlinks/query.js\":\"342b93510ef979ac\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/grouped-backlinks/resolveConfig.js\":\"0d26f0d81f47d235\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"1d70add19b49fa14\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f8fea9cc40be42a7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/html-document/HtmlDocumentContent.js\":\"53a26b1322798cd9\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/html-document/HtmlFrame.js\":\"22ae2048feed9ef6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/html-document/actions.js\":\"606cce31c8ca45d6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/html-document/blockType.js\":\"acac01bb3cef7783\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/html-document/confirmRunScripts.js\":\"303b4bdfdedb358b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/html-document/dataExtension.js\":\"663898ea1986a2b0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/html-document/frameAnnotations.js\":\"ead2e5b0ab447c76\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/html-document/frameDocument.js\":\"ace36230e1de9268\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/html-document/frameTheme.js\":\"caef28f85e654389\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/html-document/index.js\":\"a1a46adb7496d898\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/html-document/scriptConsent.js\":\"a3081ffe115a5ef2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/html-document/sourceMap.js\":\"56775e5cb366f3a0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/html-document/useDocumentScripts.js\":\"b234ab200ed384a5\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/interaction-metrics/index.js\":\"15509fa522f6cf45\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/interaction-metrics/record.js\":\"27174aa81f488459\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/interaction-metrics/recordStore.js\":\"86c12ab9e9da4785\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/interaction-metrics/responsiveness.js\":\"93ba61f89f5703de\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/interaction-metrics/schedule.js\":\"65781c634d316d44\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/interaction-metrics/sessionContext.js\":\"4056c83d944b8959\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"4ae11b7f5542f01d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"162d0112febbf5cb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/keybindings-settings/actions.js\":\"dc19df4ccdbc6985\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/keybindings-settings/config.js\":\"5373739c78cb84eb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/keybindings-settings/dataExtension.js\":\"835c6031da2c4dbb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/keybindings-settings/effect.js\":\"8817e1acdf49c5ee\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/keybindings-settings/index.js\":\"d8e10a03024c2519\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/keybindings-settings/keyCapture.js\":\"f2a29a46ee3d4b1c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/keybindings-settings/overrideStore.js\":\"4a2edabffadbf34e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"aa0f049eb76d5b8f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/left-sidebar/HeaderItem.js\":\"f0966338cd41a6ff\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/left-sidebar/LeftSidebar.js\":\"fec98c5040c45326\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/left-sidebar/actions.js\":\"2ee07f10ed9eef64\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/left-sidebar/facet.js\":\"69054827111a2586\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/left-sidebar/index.js\":\"e7d4b072c16e99cc\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/left-sidebar/shortcuts.js\":\"dfbffc2a53bab2b2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/left-sidebar/toggleStore.js\":\"79dc4d065a6ca383\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/merge-blocks/MergePicker.js\":\"0fea0e8df4896fdc\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/merge-blocks/index.js\":\"251a85da0a624d7b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/merge-blocks/mergeAction.js\":\"e587f3e358640e94\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/merge-blocks/strategy.js\":\"dc814b100cb6b4d9\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/mobile-bottom-nav/Button.js\":\"86fdfe88c67a9a0d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"dbdb3412f822ae81\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/mobile-bottom-nav/defaultItems.js\":\"8861a3a3d5764e63\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/mobile-bottom-nav/facet.js\":\"5ddf825230746e97\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/mobile-bottom-nav/index.js\":\"9eb7a19bbf8751e1\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0d14880dc701d986\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/mobile-keyboard-toolbar/actions.js\":\"18c89e0864e3cbfe\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"8ee771a571a1282c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/mobile-keyboard-toolbar/facet.js\":\"3cfd6d62255eeb30\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/mobile-keyboard-toolbar/index.js\":\"895e06b2955da656\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2360f6bbecb0ef26\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/move-blocks/blockSubtreeMembership.js\":\"a0e77a8bb2cea27a\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/move-blocks/contextMenuItem.js\":\"1aeaf6397169f584\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/move-blocks/index.js\":\"0ac101f539b929bf\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/move-blocks/moveAction.js\":\"769875d41da07139\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/move-blocks/moveBlocks.js\":\"0ca717651eaf0499\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/move-blocks/selectionAfterMove.js\":\"3323b925634c71a5\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/onboarding/TutorialBanner.js\":\"bfe4fda9b6cc413d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/onboarding/action.js\":\"6dfa7f849dfacd1d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/onboarding/bannerDismissal.js\":\"54b442b03f161376\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/onboarding/documents/cheatSheet.js\":\"fc23c803683243fe\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/onboarding/index.js\":\"90bfad4bdc5931e7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/onboarding/keys.js\":\"f517a9a80da6ed56\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/onboarding/landing.js\":\"63e3a1568426de93\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/onboarding/outline.js\":\"c765fb8efc8d1857\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/onboarding/seed.js\":\"81aa7a30624f0690\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/perf-monitor/PerfTrendDialog.js\":\"2abf53e347f9264b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/perf-monitor/analyze.js\":\"f48c6dfbc07157b4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/perf-monitor/diagnosticsSource.js\":\"f0b1f4bf588d09fb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/perf-monitor/index.js\":\"03d42b9f554e67ac\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/perf-monitor/load.js\":\"99ee5324a52caad3\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/perf-monitor/monitorRun.js\":\"6d8d6c5250ee79bb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/perf-monitor/schedule.js\":\"dbfd46b470786996\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/perf-monitor/series.js\":\"e04f234755ae39a4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/perf-monitor/store.js\":\"f566b78ead8be9d6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/perf-monitor/trendAction.js\":\"fb1226e803dfd707\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/perf-monitor/verdict.js\":\"5dc27dbaebb3cdc5\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/plain-outliner/clickToEditAction.js\":\"b9d5b1208c6971ef\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/plain-outliner/index.js\":\"271397fa26c03376\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/plain-outliner/interactions.js\":\"d808d8b42e86cd61\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5dc376e1c494ded0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/properties-migration/MigrationGate.js\":\"d199bec119215ee6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/properties-migration/MigrationGateDialog.js\":\"c1059d0210d8ea83\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/properties-migration/action.js\":\"ff6c7fafc90a21ba\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/properties-migration/index.js\":\"87961093c4b9034c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/properties-migration/localRunMessage.js\":\"ac8e13d394fb28fe\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/properties-migration/plugin.js\":\"c48bfdb6064883c1\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/properties-migration/progressReport.js\":\"164ea6b6019bea65\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/properties-migration/sweepProgress.js\":\"21e76ac3a3d97739\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/property-rows/FieldRowRenderer.js\":\"e1bcc5988032eb19\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/property-rows/ValueRowRenderer.js\":\"89a5b4976e85eb83\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/property-rows/actions.js\":\"9188e1c21293c244\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/property-rows/autocomplete.js\":\"79fd957e5c4bb02f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/property-rows/fieldRow.js\":\"0ac67927330c6f5c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/property-rows/index.js\":\"c18941ec0b1cf2c4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/property-rows/referenceWarning.js\":\"3995ad3d98536803\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/property-rows/valueAutocomplete.js\":\"d0f84bf1afa2429c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/property-rows/valueSchema.js\":\"1d3d25e4874a81f2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/quick-find/HeaderItem.js\":\"9c772df419632dbb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/quick-find/QuickFind.js\":\"005b5813045bfbe4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/quick-find/index.js\":\"8493dfdb0e7eddf7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/quick-find/recents.js\":\"eac2886d69271617\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/quick-find/resultItems.js\":\"a0a7984cc570def7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/quick-find/selection.js\":\"442ffe19576bec18\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/quick-find/toggleStore.js\":\"50e3a19ae6ea9f5f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/recents/HeaderItem.js\":\"c6b9146917410ddb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/recents/RecentsPageBlockRenderer.js\":\"161fc901f8340acd\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/recents/grouping.js\":\"ba2d7fab27494ffe\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/recents/index.js\":\"eec87c587726186f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/recents/target.js\":\"119e514ccd1fe398\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/codeMirrorExtensions.js\":\"fa75d0f7d53bdd16\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/contentPrefill.js\":\"0190452cda5b5f99\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/dataExtension.js\":\"cde4c1e39d5605fe\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/index.js\":\"6994d3a8863e6b50\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"cb2b12d31a049284\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/invalidation.js\":\"5db1a64f309fc33b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/localSchema.js\":\"f3230513f1595f83\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/markdown/blockrefs/index.js\":\"ada74e548d52a998\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"03888e873e673440\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/markdown/index.js\":\"b555b4b28d7ce2f6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/markdown/referenceNode.js\":\"7cd231cfdcf26ab6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/markdown/remark-reference-occurrences.js\":\"76485827d332bfda\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"737c0fae980fe5be\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/markdown/wikilinks/index.js\":\"fc02daaaaea97a50\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e4ca7d8689e7d485\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1effb83fd8f22419\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/mergeRetargetProcessor.js\":\"576958661a5f8d87\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/parseFence.js\":\"043b146e9f8eafc5\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/referenceParser.js\":\"176eda8fcfed0eb8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/referenceProjection.js\":\"1ef7c29a6e870874\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/referencesProcessor.js\":\"45a7cd27ac77cff9\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/renameProcessor.js\":\"dccd426763ab4bf1\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/references/spanReplacement.js\":\"b9aeac888275c0c7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/rich-paste/htmlToOutline.js\":\"e3d7453476c80dd8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/rich-paste/index.js\":\"1edf83351a22b020\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f1ed2ccfe1d6e3b0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/rich-paste/pasteDecision.js\":\"7f673d1293b15c78\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/action.js\":\"a3cb95168e7bf536\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/blockIds.js\":\"cdf78d66e9d9624b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/content.js\":\"b23ad238c6dd30c6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/effect.js\":\"d539879607cff951\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/ids.js\":\"7e106562ca37459e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/import.js\":\"87cb2f0a042419e7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/index.js\":\"a10de75017b329e3\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/plan.js\":\"1a4f044e203edbd2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/plugin.js\":\"c2f034242cd42375\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/promotion.js\":\"aae8a3f4c7fa3f00\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/properties.js\":\"05623ccc2adcaaeb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/references.js\":\"94747e67daa5c6e3\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/report.js\":\"a0ffd6bc3192c3e8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/roamMemo.js\":\"c56feacd00639efc\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/runtime.js\":\"a77d6d961de23608\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/schemaReconciliation.js\":\"91bd3f39864bc835\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/srsMarkers.js\":\"a210057bd36f42df\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/todo.js\":\"666aa36e01315a71\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/typeCandidates.js\":\"7824dd74f1e721ac\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/roam-import/types.js\":\"96bace3a6a83c25a\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/search-health/index.js\":\"0175c7ba983250e1\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/search-health/store.js\":\"93a79c31362b08e3\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/shortcut-help/HeaderItem.js\":\"6c39075923da8885\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"d0dee8b5dc853966\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/shortcut-help/index.js\":\"9719bcc9be8b7660\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/shortcut-help/model.js\":\"864cac5f25828984\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/shortcut-help/toggleStore.js\":\"912c6b501b1d3c23\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/shortcut-help/useKeyInspector.js\":\"a08c444da15013b5\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"33bfa9e9c13d7a4e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/spatial-navigation/ShellDecorator.js\":\"67462dc03ad1c777\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/spatial-navigation/actions.js\":\"31327a8c3ace1768\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f40f5190ec5c4e45\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/spatial-navigation/index.js\":\"6aa924db4e21a183\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/spatial-navigation/shell.js\":\"0dd6613b113fb39f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/spatial-navigation/surface.js\":\"eaa0ff1113dfd4c0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/spatial-navigation/walker.js\":\"300af961a8747c0f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-rescheduling/RescheduleToast.js\":\"4674be3c3f3f950d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-rescheduling/dataExtension.js\":\"d8db4348dd11a320\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-rescheduling/index.js\":\"cf362468b04c4080\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-rescheduling/indicator.js\":\"fc943df5d6734c0f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-rescheduling/moveSrsState.js\":\"8668d442f7fe636d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"77a234b4f63f4e3a\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-rescheduling/scheduler.js\":\"3b9da4068a57cad2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-rescheduling/schema.js\":\"8450ceb4eda3b342\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"723ce3d7b0334a9f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-rescheduling/srsClipboard.js\":\"9450455d0613f4c3\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"9632b376d6f2ea07\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/DailyNoteReviewHint.js\":\"89cbf29b9cdde628\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/DeckPicker.js\":\"815d24bf9fe8d540\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/ReviewControls.js\":\"4d7087f5952e45da\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3910a7a62ec607cd\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/ReviewSession.js\":\"f2846156b965711a\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/actions.js\":\"dea84ff46a03ab77\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/archive.js\":\"b6aa73091fdbe33a\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/dataExtension.js\":\"a95ed130aa50e5db\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/deck.js\":\"00eb8ffa839b0c8b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/dueQuery.js\":\"1a6659f27a0bc806\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/gradeDecision.js\":\"23ebcb58584e8d04\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/index.js\":\"b6b4a92919c1333a\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/keyHints.js\":\"e7a06d7c8061eff4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/reviewCardLayout.js\":\"0ce1619d8cb5bcb8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/reviewProgress.js\":\"f8edbe1d627d87bb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/schema.js\":\"aa17eed2c50453e6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/srs-review/useDueCards.js\":\"ae94d36b0490d7bb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/startup-metrics/index.js\":\"0ddfff7c29fdfdde\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/startup-metrics/record.js\":\"798b288230a1e579\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/storage-persistence/index.js\":\"0e9aca8a211e6b30\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/storage-persistence/persistenceStatus.js\":\"93ec752977d0ebe3\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/storage-persistence/requestAction.js\":\"fd3023061f4326c6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/supertags/TypeChipsDecorator.js\":\"3bc0be3bc3ec8eb9\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/supertags/codeMirrorExtensions.js\":\"e473e979ae9501b1\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/supertags/index.js\":\"6f64709ef706f714\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/supertags/typeAutocomplete.js\":\"1f16d7ecf65fb2a4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8be4852c902da45a\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/swipe-quick-actions/actions.js\":\"9d80dce60519c470\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/swipe-quick-actions/anchor.js\":\"0f96ebae31f5ca02\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/swipe-quick-actions/events.js\":\"227e3e13a2c7f1f5\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/swipe-quick-actions/gestureActions.js\":\"871646f879eea6dd\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/swipe-quick-actions/index.js\":\"3559cec23924f07e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f3a60da4d6a1bdd4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/sync-metrics/collect.js\":\"c5362e4d18a2b616\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/sync-metrics/index.js\":\"bc88dd5a68681b55\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/sync-metrics/record.js\":\"fb74805675d20c80\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/system-status/RejectionDialog.js\":\"6c45d8c11eaeaef6\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/system-status/SystemStatusHeaderItem.js\":\"354c8e7e501e5a49\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/system-status/index.js\":\"e0847aad01dc2745\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/system-status/model.js\":\"782ca3083a7a52e1\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/system-status/queueCounts.js\":\"948063e0ec6ddcb2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/system-status/rejectedHelpers.js\":\"adc2772ea64e3ed9\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/system-status/rematerializeAction.js\":\"f5bb99968dbb6e65\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/system-status/useHysteresis.js\":\"be6db4ffa8228337\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/ColumnHeaders.js\":\"9f427e32b3170126\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/QueryUi.js\":\"b1ea24cef894f679\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/TableLayout.js\":\"591b5e5fc22b3e85\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/actions.js\":\"eb6ce5532fd166f0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/cellEdits.js\":\"fa99d3d24eb28340\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/childrenViews.js\":\"13a96046a52ce1a0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/columns.js\":\"333ff3175ce33368\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/controller.js\":\"5c6624485c4e96c7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/convert.js\":\"6300819ab0f730ba\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/dataExtension.js\":\"6f3a3f9bc0b7bbe7\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/index.js\":\"3eebadae7230225f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/keys.js\":\"af5309061c7a71d0\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/model.js\":\"04680a9bba77d917\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/query/QueryText.js\":\"f1710e2c56079658\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/query/backfill.js\":\"54edcb00dfd1aadd\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/query/completion.js\":\"1e69dc26b2c77f62\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/query/format.js\":\"a7f76e4457e16a66\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/query/parse.js\":\"93e422b2abc3f7f1\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/query/queryValue.js\":\"aca5be9814cc1825\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/query/registrations.js\":\"5fd28fc1b391fcdf\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/query/source.js\":\"70cd5296e750c2b8\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/registry.js\":\"700930fd70b9d3fa\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/rowGutter.js\":\"5e239b0af011a48c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/rowVerbs.js\":\"4abd701ab4875917\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/schema.js\":\"6a03ef829f97228a\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/tables/sort.js\":\"bbd89a807a36f886\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/theme-toggle/effect.js\":\"69ad7f0f8f567d06\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/theme-toggle/index.js\":\"c0b0031001f2972f\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/theme-toggle/theme.js\":\"83fdcb1bf83e5845\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/todo/actions.js\":\"af022cf1ab1fc97b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/todo/dataExtension.js\":\"7ed347a21e77338e\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/todo/index.js\":\"fb41e54178df98be\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/todo/schema.js\":\"114693b2ad4d9288\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/touch-selection/TouchSelectionLayer.js\":\"3ac1d3b42db14e68\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/touch-selection/actions.js\":\"c225265831f7a6fb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/touch-selection/defaultItems.js\":\"56441b382dbaddbb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/touch-selection/facet.js\":\"308b9ed01c38259d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/touch-selection/holdRecognizer.js\":\"575dcb084c4719f1\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/touch-selection/index.js\":\"85b0d7b47c9b618c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/update-indicator/UpdateIndicator.js\":\"18bd402728714b9b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/update-indicator/index.js\":\"ab1b53b7d1d0e379\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/update-indicator/loadTimes.js\":\"34aa6d22c9792f82\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/video-player/VideoNotesRenderer.js\":\"5de7cf597dd0942d\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/video-player/VideoPlayerRenderer.js\":\"fa7ada689a0fe0cf\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/video-player/VideoTimeStamp.js\":\"ddc6981244e052cb\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/video-player/actions.js\":\"1cf7deeb8c44bfef\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/video-player/index.js\":\"496fb1d49c4c78ef\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/video-player/markdown.js\":\"8f7ecba10337c261\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/video-player/notes.js\":\"392617631126f81b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/video-player/registry.js\":\"aa0f3561cd568fc4\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/video-player/remark-timestamps.js\":\"65b6b890c7eaa22c\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/video-player/view.js\":\"9ae5c5bffe438671\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/vim-link-hints/LinkHints.js\":\"36d44aa3f641ede2\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/vim-link-hints/index.js\":\"d52ab7afaa9fbd14\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/vim-link-hints/model.js\":\"c06dcd555c4103da\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/vim-link-hints/settings.js\":\"ac3bbcb2252038dd\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/vim-normal-mode/actions.js\":\"3b4e0274331f8f1b\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/vim-normal-mode/index.js\":\"9dc6cb9f9f937a18\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/vim-normal-mode/interactions.js\":\"852cb1ae01005907\",\"/knowledge-medium/pr-preview/pr-1894/src/plugins/workspace-header/index.js\":\"4c59b2739c82a305\",\"/knowledge-medium/pr-preview/pr-1894/src/registerServiceWorker.js\":\"0bbfd50a611dee55\",\"/knowledge-medium/pr-preview/pr-1894/src/requestPersistentStorage.js\":\"b8493f8cf1591886\",\"/knowledge-medium/pr-preview/pr-1894/src/services/authRequestDeadline.js\":\"3b08e2e24bc8bfa2\",\"/knowledge-medium/pr-preview/pr-1894/src/services/authStorage.js\":\"43cea32b0e8fada3\",\"/knowledge-medium/pr-preview/pr-1894/src/services/powersync.js\":\"f178a731263ce95a\",\"/knowledge-medium/pr-preview/pr-1894/src/services/supabase.js\":\"949143548d915d71\",\"/knowledge-medium/pr-preview/pr-1894/src/services/uploadErrorClassifier.js\":\"df50c1022507cd8d\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/ActiveContexts.js\":\"8a6a208404a59e24\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/HotkeyReconciler.js\":\"119c6e2e43881657\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/WipeLocalDataDialog.js\":\"6dbb66cdbf4dfcd8\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/actionDispatch.js\":\"7a4098313328f4a4\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/actionRefItems.js\":\"5f3e6e689f46037c\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/applyKeybindingOverrides.js\":\"4f3d71adda2bd2b6\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/blockActions.js\":\"4fc16bc706b87daf\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/blockMergeGesture.js\":\"e98bc9e758ee16e6\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/canonicalizeChord.js\":\"3798b7d6bdc154b8\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/defaultContexts.js\":\"b5d826095df407af\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/defaultShortcuts.js\":\"f7db2cbd5da9e8ce\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/effectiveActions.js\":\"7316c54e5c0e5bab\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/gestureAction.js\":\"5074511a8eabc5b4\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/gestureBinding.js\":\"32478cf939ba9f26\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/holdRegistry.js\":\"bcd2dc9974eb8033\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/keybindingConflicts.js\":\"0faf9cca1e8178c1\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/keybindingOverrides.js\":\"10b32a2f15c62d8e\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/pointerAction.js\":\"7f99ef7e2486dd4d\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/resolve.js\":\"7495ce8884168ae8\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/runAction.js\":\"f5976cf735c81f95\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/sequenceMatcher.js\":\"fc4b746956e43c07\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/types.js\":\"7174e926649b8d8d\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/useActionContext.js\":\"184a9ac138127ce8\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/useActionDiscovery.js\":\"fc9d8eb2e5bbba72\",\"/knowledge-medium/pr-preview/pr-1894/src/shortcuts/utils.js\":\"e81f072da220650a\",\"/knowledge-medium/pr-preview/pr-1894/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1894/src/sw/bootStore.js\":\"ce742beb8e8a1257\",\"/knowledge-medium/pr-preview/pr-1894/src/sw/previewDatabases.js\":\"0aea86b3b90c65d3\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/byteTransform.js\":\"23fb1113955f43f1\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/attachmentCleaner.js\":\"2101d4e958a17ea7\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/bundle/attachmentParts.js\":\"de58b66497ddc807\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/bundle/bundleParts.js\":\"f1278c9721e2d3e1\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/bundle/bundleRecord.js\":\"8304b5d888534c2c\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/bundle/manifest.js\":\"c9d04a42a9e065e8\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/bundle/takeBundle.js\":\"21970120ab413f5d\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/bundle/verifyBundle.js\":\"71400dd2bf15b426\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/cleaningStage.js\":\"5048f30502dbf213\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/conversionKey.js\":\"7a5271454331a383\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/conversionServer.js\":\"7e8f11ec76759221\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/flip.js\":\"3519f2d1cd49a4bf\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/flipAttempts.js\":\"47247e16aa8fbf8b\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/pages.js\":\"ea17d0d20f175f8e\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/preflight.js\":\"5ea3c8c4f1caaee9\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/reseal.js\":\"02ef0fb824a48878\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/runConversion.js\":\"0bc630bdd1b9f769\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/runLock.js\":\"0ae86a08d5e63f94\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/sealing.js\":\"3949fea8069be297\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/sealingStage.js\":\"d68296ae80685fb0\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/stage.js\":\"97382ac138f1631b\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/conversion/verifyReseal.js\":\"aab1d9978a1c97f9\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/aad.js\":\"573b720f3e62facd\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/aead.js\":\"9be2be5b570c5ece\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/base32.js\":\"7f1a4cc7596c6cd6\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/base64url.js\":\"a23168944917230e\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/binaryEnvelope.js\":\"b054402523954630\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/byteAead.js\":\"07cca24c151e55d9\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/canary.js\":\"e770c5e6f314dd8a\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/contentHash.js\":\"28d9382b3b3dcf57\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/contentKey.js\":\"276bb49a341f701f\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/derivedIdNamespace.js\":\"29e542f104a880bc\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/envelope.js\":\"4a9baaf1b61404ee\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/hex.js\":\"9b48f9e5689ba097\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/sha256Hex.js\":\"bb657dc12bc2572e\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/crypto/workspaceKey.js\":\"1819d6c39ba1ba8d\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/keys/conversionState.js\":\"e3f90655af815f8e\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/keys/flows/createEncryptedWorkspace.js\":\"84463bb4c25652a5\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/keys/flows/pastedKey.js\":\"50330f1ff4611516\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"4c84d500865d4252\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b37d55f4a3e9e230\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/keys/keyStore.js\":\"cd4db376b9880c4e\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/keys/mintWorkspaceKey.js\":\"8eaae5146a58e8a0\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/keys/modePin.js\":\"d902beee9a75b92e\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/keys/openWorkspaceKeys.js\":\"ea9f2346c9731f89\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/keys/resolveWorkspaceEntry.js\":\"26394ccacca5d896\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/keys/resolver.js\":\"dd6095f3f8d32110\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/keys/workspaceAccess.js\":\"455d94723e017a40\",\"/knowledge-medium/pr-preview/pr-1894/src/sync/transform.js\":\"0a49e9ffb0cc491d\",\"/knowledge-medium/pr-preview/pr-1894/src/themeBootDefaults.js\":\"280ac8be5a872761\",\"/knowledge-medium/pr-preview/pr-1894/src/types.js\":\"132d357185b89e8b\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/ClientLocalSettings.js\":\"1c1253051e2213c0\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/abortableSleep.js\":\"0057c758c016172b\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/array.js\":\"4f92efa6cca5a457\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/backlinkAutocomplete.js\":\"6fba499555aff954\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/blockCrumbs.js\":\"575961ffe5207cba\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/blockrefAutocomplete.js\":\"8a933b4159ae91cd\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/cadencedIdleJob.js\":\"01359387b1d29938\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/callbackSet.js\":\"6ddd0974f83647f2\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/clientId.js\":\"7874b1ee54d6d416\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/codemirror.js\":\"1b852cd11b09cf1a\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/codemirrorCompletion.js\":\"c8595317880b03be\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/copy.js\":\"f2376bb5251c56ba\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/dailyPage.js\":\"a68d7a2a5e227388\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/dbForensics.js\":\"1ffc323705e4af72\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/dbForensicsHooks.js\":\"25694bbd201fcdb8\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/deleteBlockThroughUi.js\":\"bb5eb8a3b5b00520\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/dialogs.js\":\"5667e9c3b59edd77\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/dom.js\":\"f7e2802788c559d0\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/downloadBlob.js\":\"0f519bd6ff03315f\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/drawnWalk.js\":\"4f550592f1a886df\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/exportSqliteDb.js\":\"502fea56bf64fe0b\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/fileSystemAccess.js\":\"afc17e313bac9796\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/flipSlide.js\":\"35119c15fc6a8e05\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/fnv1a.js\":\"46be356945673a42\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/formatBytes.js\":\"3c400dfdff5aa53e\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/fuzzyRank.js\":\"600fec77f4ebaed7\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/idbKeyedStore.js\":\"cf1fb195452c8ba2\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/idleCallbackPolyfill.js\":\"b5bfbb302fe65d47\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/keyboardAwareScroll.js\":\"37fabc6698db6b12\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/keyboardViewport.js\":\"4be7dab5a17c7f2d\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/lastWorkspace.js\":\"81afd306b782a660\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/layoutColumns.js\":\"532bbdd44ccd3dd6\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/layoutSessionDom.js\":\"c8805770e3e246fc\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/layoutSessionId.js\":\"89b639ad19d5f477\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/linkClickGestures.js\":\"f4016b812f120a65\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/linkTargetAutocomplete.js\":\"fd1a99daa9b08a42\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/localDbCorruption.js\":\"35bed59206b3b464\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/localDbRecovery.js\":\"f5897af4c257abb3\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/markdownParser.js\":\"4f88d81a4ed842bf\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/memoize.js\":\"e2637880cd35b433\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/nameFieldCommit.js\":\"0c020eabb0fe29e1\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/nameList.js\":\"89f82a5a0b2d0334\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/navigation.js\":\"ff56375d5a405e88\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/omnilinerNamespace.js\":\"d7a846b3edb40216\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/opfsPageScan.js\":\"87ca062623c349e9\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/panelClearance.js\":\"ad5db841fc1ab07f\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/panelHistory.js\":\"f327681f1971f519\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/panelLanes.js\":\"825788158a82bdb8\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/panelLayoutProjection.js\":\"f3927e83763d8ec3\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/panelScrollAnchor.js\":\"93c8a3326ec8b844\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/panelUrlFlags.js\":\"14e60e422b21815a\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/platform.js\":\"7a33931807fddabf\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/pluralize.js\":\"4d6f2f05bcf7d086\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/propertyCreation.js\":\"3a337360e9883c9b\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/propertyNavigation.js\":\"23dc4f0473120e39\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/propertyValueContext.js\":\"9228f12c46b21918\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/react.js\":\"3ecf23c70cc6dc11\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/relativeDate.js\":\"82bb5b3c925bf2d9\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/relativeTime.js\":\"259249be018e13c4\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/renderScope.js\":\"ba15166a89de48ea\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/resolvedThenable.js\":\"ff2e182fecefe609\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/routing.js\":\"1b6453f61edbba81\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/safeMode.js\":\"9e657d9a5101d389\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/scheduleIdle.js\":\"6f6ece07c43e7196\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/screenWakeLock.js\":\"b417e92714f4b6f5\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/selection.js\":\"7dd2a2a675f1abe1\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/softKeyboardGrab.js\":\"2fc01e1f397588a0\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/startupTimeline.js\":\"8883cc8ce9a9558e\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/state.js\":\"ba6b9f6f2b6e054b\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/string.js\":\"1ffee5a9122a74cd\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/surfaceZoom.js\":\"b7e52cd2f553f5ae\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/time.js\":\"69d72a8a192adf55\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/toast.js\":\"c9c24037287a11ea\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/toggleStore.js\":\"de4b151cf9f2a3a2\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/untilStopped.js\":\"f0607afb7c8e01f5\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/userActivity.js\":\"0aadca5953c25527\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/viewTransition.js\":\"79c435b18fcb31af\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/viewport.js\":\"1345544753fee7e6\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/webLock.js\":\"7fc25042317390e4\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/workspaceRecovery.js\":\"f45f801f63c9092a\",\"/knowledge-medium/pr-preview/pr-1894/src/utils/workspaceSnapshotStore.js\":\"266b0fa3e4a2b270\",\"/knowledge-medium/pr-preview/pr-1894/src/vendor/react-compiler-runtime.js\":\"83127593af3bcf6f\",\"/knowledge-medium/pr-preview/pr-1894/src/vendor/react-dom-client.js\":\"1f1b98b0385e17ec\",\"/knowledge-medium/pr-preview/pr-1894/src/vendor/react-dom-server-edge.js\":\"30480ab34244c66c\",\"/knowledge-medium/pr-preview/pr-1894/src/vendor/react-dom-server.js\":\"4018215b1f5d7118\",\"/knowledge-medium/pr-preview/pr-1894/src/vendor/react-dom-static-edge.js\":\"d2bd27270d6f651b\",\"/knowledge-medium/pr-preview/pr-1894/src/vendor/react-dom-static.js\":\"3ca62b991c8a24aa\",\"/knowledge-medium/pr-preview/pr-1894/src/vendor/react-dom-test-utils.js\":\"586839278ff484c0\",\"/knowledge-medium/pr-preview/pr-1894/src/vendor/react-dom.js\":\"eae456c4899eb80c\",\"/knowledge-medium/pr-preview/pr-1894/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1894/src/vendor/react-jsx-runtime.js\":\"9acaad962333f69f\",\"/knowledge-medium/pr-preview/pr-1894/src/vendor/react.js\":\"958cf165112decda\",\"/knowledge-medium/pr-preview/pr-1894/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1894/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1894/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
