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
		buildId: "51757fdefc5e-f6e04cc5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1895/\":\"7c4c6dbd0ccce384\",\"/knowledge-medium/pr-preview/pr-1895/index.html\":\"7c4c6dbd0ccce384\",\"/knowledge-medium/pr-preview/pr-1895/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1895/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1895/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1895/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1895/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1895/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1895/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1895/assets/FacadeVFS-CkDErkpm.js\":\"920c752217ca9df9\",\"/knowledge-medium/pr-preview/pr-1895/assets/OPFSCoopSyncVFS-BYEadKzh.js\":\"eaae844181b8e6d7\",\"/knowledge-medium/pr-preview/pr-1895/assets/OPFSWriteAheadVFS-Bx1LYtjR.js\":\"1745bae5bf8491bf\",\"/knowledge-medium/pr-preview/pr-1895/assets/wa-sqlite-41hQ4G9v.js\":\"2cf2e428b7582773\",\"/knowledge-medium/pr-preview/pr-1895/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1895/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1895/assets/wa-sqlite-async-Dik5pMSh.js\":\"b8cd21429f7435bf\",\"/knowledge-medium/pr-preview/pr-1895/assets/worker-C21P2oTa.js\":\"262480cd05a6ccf2\",\"/knowledge-medium/pr-preview/pr-1895/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1895/chunks/app-B-keTxst.js\":\"73fe1855eef90611\",\"/knowledge-medium/pr-preview/pr-1895/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1895/index.js\":\"57db04535a5f7b12\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1895/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1895/assets/AccessHandlePoolVFS-B-3WBZuf.js\":\"ac73994915f6d564\",\"/knowledge-medium/pr-preview/pr-1895/assets/IDBBatchAtomicVFS-Cy7JMYVL.js\":\"1322173988c179ea\",\"/knowledge-medium/pr-preview/pr-1895/assets/MemoryVFS-CFhtKAno.js\":\"7b239c525171bcd3\",\"/knowledge-medium/pr-preview/pr-1895/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1895/assets/mc-wa-sqlite-CvYFI0Rk.js\":\"7d322952460f354b\",\"/knowledge-medium/pr-preview/pr-1895/assets/mc-wa-sqlite-async-C0DwHNtk.js\":\"933c7e234578531f\",\"/knowledge-medium/pr-preview/pr-1895/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1895/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1895/chunks/AccessHandlePoolVFS-3X6TNymB.js\":\"cbf9566f0b474198\",\"/knowledge-medium/pr-preview/pr-1895/chunks/FacadeVFS-C1l7J-d6.js\":\"0e19dfec6f212c59\",\"/knowledge-medium/pr-preview/pr-1895/chunks/IDBBatchAtomicVFS-Cjl9H20R.js\":\"7514b55beddabf83\",\"/knowledge-medium/pr-preview/pr-1895/chunks/MemoryVFS-BpK_fxHQ.js\":\"a5ee3283bb0a55c4\",\"/knowledge-medium/pr-preview/pr-1895/chunks/OPFSCoopSyncVFS-D3j9oDyT.js\":\"2a65fd22afc3d8d9\",\"/knowledge-medium/pr-preview/pr-1895/chunks/OPFSWriteAheadVFS-BbGdczLk.js\":\"c02acafdf69e014e\",\"/knowledge-medium/pr-preview/pr-1895/chunks/Preview-DeVUnNJM.js\":\"fb8e85a52b2494cb\",\"/knowledge-medium/pr-preview/pr-1895/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1895/chunks/card-sFwkUEdo.js\":\"2e67b46bc25d38c8\",\"/knowledge-medium/pr-preview/pr-1895/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1895/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1895/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1895/chunks/dist-D30mwtlq.js\":\"6a309317db9c2cb7\",\"/knowledge-medium/pr-preview/pr-1895/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1895/chunks/mc-wa-sqlite-DJt4TTo3.js\":\"a68dd2476ff66194\",\"/knowledge-medium/pr-preview/pr-1895/chunks/mc-wa-sqlite-async-KbLThc4N.js\":\"7ab52ac2dcf84be5\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-7q0w7fdZ.js\":\"6dad6a45d36c0002\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-BEBtnqM3.js\":\"9e3c2ab904219a21\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-C1uCChP0.js\":\"2776b13ed9f18334\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-CLLoYlBS.js\":\"afa904618f7204d9\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-CelfK3yT.js\":\"f0e60e15201ed8cd\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-D4psiFLF.js\":\"c3fe904a8464a664\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-DDVRf29a.js\":\"345bea1ac29ebe29\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-Dm-t09x-.js\":\"b86f55c3e8488ebc\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-dom-server-legacy.browser.production-DULS-aEN.js\":\"37ce33a1159ccd73\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-dom-server.browser.production-DgsRUsE_.js\":\"456a0e92b1c3067a\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-dom-server.edge.production-sGep5KDt.js\":\"43f0135d6b1c2504\",\"/knowledge-medium/pr-preview/pr-1895/chunks/server.browser-Dhz51cmN.js\":\"ef0d6370aafdc86b\",\"/knowledge-medium/pr-preview/pr-1895/chunks/textarea-G5tlpbt0.js\":\"4f975cfadb88f5d5\",\"/knowledge-medium/pr-preview/pr-1895/chunks/ui--_a8nhgl.js\":\"a047190de7653bfd\",\"/knowledge-medium/pr-preview/pr-1895/chunks/wa-sqlite-BKjl2QAH.js\":\"06381542d78b0247\",\"/knowledge-medium/pr-preview/pr-1895/chunks/wa-sqlite-async-Dv8h8kGv.js\":\"a4ef8057d0fc74b5\",\"/knowledge-medium/pr-preview/pr-1895/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1895/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1895/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1895/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1895/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1895/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1895/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1895/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1895/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1895/src/App.js\":\"db57f9b0e68365d3\",\"/knowledge-medium/pr-preview/pr-1895/src/appUpdate.js\":\"ee7a62e312289ad4\",\"/knowledge-medium/pr-preview/pr-1895/src/appVersion.js\":\"3d7379d74caacabe\",\"/knowledge-medium/pr-preview/pr-1895/src/bootstrap/initialLayout.js\":\"3fd2a12fab1e4a46\",\"/knowledge-medium/pr-preview/pr-1895/src/bootstrap/openWorkspaceData.js\":\"867c41c4a40f28f9\",\"/knowledge-medium/pr-preview/pr-1895/src/bootstrap/resolveWorkspace.js\":\"40d96d3fdf98d866\",\"/knowledge-medium/pr-preview/pr-1895/src/bootstrap/workspaceBootstrap.js\":\"bd6c059bb45d05e6\",\"/knowledge-medium/pr-preview/pr-1895/src/components/BlockComponent.js\":\"c592622463a722b5\",\"/knowledge-medium/pr-preview/pr-1895/src/components/BlockCrumbs.js\":\"5fd2c14208e71a4b\",\"/knowledge-medium/pr-preview/pr-1895/src/components/BlockEditor.js\":\"6e4608fabb088208\",\"/knowledge-medium/pr-preview/pr-1895/src/components/BlockLoadingPlaceholder.js\":\"391d44116f0b98da\",\"/knowledge-medium/pr-preview/pr-1895/src/components/BlockProperties.js\":\"be9127968312f41a\",\"/knowledge-medium/pr-preview/pr-1895/src/components/BlockSearchPicker.js\":\"2b20b92265e143cd\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ConfirmBulkDeleteDialog.js\":\"9f3f9e7fb36f4099\",\"/knowledge-medium/pr-preview/pr-1895/src/components/DividerHandle.js\":\"7bf2a03802deb016\",\"/knowledge-medium/pr-preview/pr-1895/src/components/DraftEditor.js\":\"ccb38a9c3fc49978\",\"/knowledge-medium/pr-preview/pr-1895/src/components/GutterPill.js\":\"a376e125d769313c\",\"/knowledge-medium/pr-preview/pr-1895/src/components/Header.js\":\"f2a7996f1cde83ec\",\"/knowledge-medium/pr-preview/pr-1895/src/components/LazyBlockComponent.js\":\"82968fe5fd17742f\",\"/knowledge-medium/pr-preview/pr-1895/src/components/Login.js\":\"6f3ae114a41d3c2e\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ZoomableSurface.js\":\"1d921f3415bb598d\",\"/knowledge-medium/pr-preview/pr-1895/src/components/editModeKeepalive.js\":\"f2cd8199fe58621b\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyDisplay/PropertyDisplayScope.js\":\"53b46d325857a6fb\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"80f2f135402fa230\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/RefPropertyEditor.js\":\"fe75e87908483f2b\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/RefTargetTypePicker.js\":\"69a5e864cdfcf535\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/SelectPropertyEditor.js\":\"d0bc7bfd488545f1\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/TypesPropertyEditor.js\":\"f89a375ee5d3e2b6\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/defaults.js\":\"c5e5bd673a22ac9f\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/kernelValuePresets.js\":\"4d65165dfd827f8a\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/selectablePresets.js\":\"dbf2487840a1c0f3\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/typesPropertyUi.js\":\"e7c18f7d769b92eb\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/AddPropertyForm.js\":\"e461c8ddec4ccabd\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/PropertyPicker.js\":\"4dad38f702ceea71\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/PropertyRow.js\":\"50ea1b10ddff7f75\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/Rows.js\":\"a17c51b44505ab00\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/actions.js\":\"90a41c06b11e61bb\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/declarationOnly.js\":\"e773c0f6cc48635c\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/layout.js\":\"55335c21baa90cfd\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/model.js\":\"31bb107e9beded17\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/shapeUi.js\":\"8dacaa90ca76a573\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/shapes.js\":\"6f458135776b43a0\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/usePropertyEditingActivation.js\":\"df0fbf756b32843f\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/visibility.js\":\"27c672e11f5cd524\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanelSections.js\":\"19bf1ecafff105f4\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/BlockEmbed.js\":\"dd7d15b2f38e83af\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/BlockLink.js\":\"4d71bf3fe0bc2396\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/BlockRef.js\":\"1a1fec226396a597\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/CompactReferenceLink.js\":\"bc4f9e422d26d585\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/ReferenceLink.js\":\"1c5abab190acbe69\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/cycleGuard.js\":\"ddafdf73bcf77e43\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/cycleGuardContext.js\":\"32d06885084bb376\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/linkInteraction.js\":\"39ae1973ecc5beac\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/referenceLayout.js\":\"53b07e1481b2e510\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/useBlockRefAncestors.js\":\"a0cd913b11a6732b\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/BlockGutter.js\":\"e189d02a03e15684\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/BlockInfoDialog.js\":\"664cf068f1118567\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/BlockReadText.js\":\"4ba1f3de0c5c1899\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/BlockTypeBlockRenderer.js\":\"7f7af1d6040a745f\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/BulletHoverCard.js\":\"7f8d680df0ae729f\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/CodeMirrorContentRenderer.js\":\"72e71efaea7a4b33\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9b0831e080edb467\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/ColumnResizeHandles.js\":\"1f0f590959532139\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0b728591b7a7befd\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/DefaultBlockRenderer.js\":\"10579bd6da06a6f3\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/LayoutRenderer.js\":\"5a0664d22bf94d95\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/MarkdownContentRenderer.js\":\"be278dfeee427a9e\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/MissingDataRenderer.js\":\"18f60ce873e477ae\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/PanelRenderer.js\":\"92bb053d03d7a0ea\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/PropertySchemaBlockRenderer.js\":\"5ba07202a02e7391\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/TopLevelRenderer.js\":\"097a72e5bf4c56b7\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/blockGutterMode.js\":\"f35dde0329f0a547\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/blockTitleText.js\":\"999e0ffa251abff1\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/fieldCreationKeydown.js\":\"3cce658b17e8d79d\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/layoutRootContext.js\":\"bcd36dcae5dc2642\",\"/knowledge-medium/pr-preview/pr-1895/src/components/typeChip/TypeChip.js\":\"6b30f36af0c8fa15\",\"/knowledge-medium/pr-preview/pr-1895/src/components/typeChip/chipStyle.js\":\"ada37734106a5127\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/anchored-floating.js\":\"11e0060e5bfacb00\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/button.js\":\"ad9f4daf002d1478\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/card.js\":\"3c1e0d737120e2a4\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/checkbox.js\":\"4958c3594e432afd\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/collapsible.js\":\"23487b78a39456af\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/command.js\":\"205b0a60700c9818\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/context-menu.js\":\"bce6badc7a182c3b\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/dialog.js\":\"2c7b8c1b5a2af15c\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/dropdown-menu.js\":\"cadedef77e5fa6ea\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/floating-listbox.js\":\"83be149d7dc32f4b\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/index.js\":\"f516a8948f8d9941\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/input.js\":\"0a079f054814bd0c\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/kbd.js\":\"e8b8c30bf67a0451\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/label.js\":\"256b10123ae58b14\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/textarea.js\":\"f8b2131bab531c0c\",\"/knowledge-medium/pr-preview/pr-1895/src/components/useEditModeYieldKeepalive.js\":\"a80e82d9f645b8d4\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/BootFallback.js\":\"c091aeb8f599917b\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/FocusedRowLazyMount.js\":\"a9999be53be64f77\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/LazyViewportMount.js\":\"46436bd45dee4cc6\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/LocalDbCorruptionFallback.js\":\"dbe175bc39434764\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/error.js\":\"db0da0ee6db5c425\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/lazyMountRegistry.js\":\"6475ad83c2c07c29\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/suspense.js\":\"63d5183704cd91f3\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/CreateWorkspaceDialog.js\":\"b3db258d6d53e595\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/PendingInvitations.js\":\"91b8fc0e8c2be5c4\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/SyncProgress.js\":\"2cc8078d87ccd126\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/UnlockProgress.js\":\"500af613a46adbce\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/WorkspaceKeyGate.js\":\"94d5a573105d7aef\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/WorkspaceSettingsDialog.js\":\"0d5f40c14cff989c\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/WorkspaceSwitcher.js\":\"ca80b839156caf2a\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/WorkspaceSyncGate.js\":\"6644554122b2babb\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/ConversionFlow.js\":\"83bc210d22f0ec2c\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/ConversionFlowHost.js\":\"2975696b475a3b4c\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/EncryptionSection.js\":\"5ef15361f04714bf\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/attachmentPrompts.js\":\"e6e9070ceb4b7a04\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/bundleFolderPrompts.js\":\"92a19f1b079ecd03\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/conversionFlowDeps.js\":\"82e1d55d8c70bfbc\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/conversionFlowStore.js\":\"011a8b5a60e5f273\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/flowUi.js\":\"618c6d2466751753\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/useConversionRun.js\":\"6a9b0907d9621b82\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/keyUi.js\":\"c1294c37c36eb53f\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/useCloseOnKeyLoss.js\":\"1186b169e2e809d1\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/useCloseOnServerE2ee.js\":\"b3c11550dd5beab3\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/workspaceUnlocked.js\":\"df6b74bba5024e9d\",\"/knowledge-medium/pr-preview/pr-1895/src/context/backgroundSubtree.js\":\"c38b5701d5c2a5a8\",\"/knowledge-medium/pr-preview/pr-1895/src/context/block.js\":\"cc193728d5edcfe4\",\"/knowledge-medium/pr-preview/pr-1895/src/context/layoutWsContext.js\":\"6eb997252577d9fc\",\"/knowledge-medium/pr-preview/pr-1895/src/context/propertyDisplay.js\":\"65a892bf8c17625d\",\"/knowledge-medium/pr-preview/pr-1895/src/context/repo.js\":\"fe63fc0ff3ae3743\",\"/knowledge-medium/pr-preview/pr-1895/src/data/aliasClaim.js\":\"17c1f400f1698e9a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/aliasSeatNamespace.js\":\"fb968912fb79bff4\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/blockData.js\":\"275ad3962632f105\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/blockType.js\":\"08a2d22f8572e028\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/changeScope.js\":\"2b8139476607609b\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/codecs.js\":\"2d57cb111247e746\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/derivedData.js\":\"0e2d3d64c00e12ff\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/errors.js\":\"17e4d254b28b445c\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/events.js\":\"9cd2e86e5cc85258\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/handle.js\":\"a787baab07559fb6\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/index.js\":\"eaec8c7d43a34756\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/mutator.js\":\"0ee92c8978dbdee4\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/processor.js\":\"2671e34640f49733\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/propertySchema.js\":\"6f94cdbc06aeee4a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/query.js\":\"5f011ac7e89e1d4c\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/sameTxProcessor.js\":\"454ad3296eb764cf\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/schema.js\":\"a787baab07559fb6\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/tx.js\":\"a787baab07559fb6\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/typedBlockQuery.js\":\"9624499c29f32318\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/user.js\":\"f75b1382f6722c6d\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/valuePresetCore.js\":\"8894f856dc26dcc7\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/valuePresets.js\":\"e0ecb65cff4f04a1\",\"/knowledge-medium/pr-preview/pr-1895/src/data/attachmentCleanerIOVerb.js\":\"ca56e28702ef9e70\",\"/knowledge-medium/pr-preview/pr-1895/src/data/block.js\":\"4045741de76f5fc1\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockCache.js\":\"526159cc358eb935\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockId.js\":\"f075b8ed9fdcd82d\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockLiveness.js\":\"50d504eecbcf2b43\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockMerge.js\":\"a272114d6aafc098\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockSchema.js\":\"a7572eb544bd55a7\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockTypeLookup.js\":\"ad2c2f92b4a9fe9a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockTypes.js\":\"25cc4e49b7d81068\",\"/knowledge-medium/pr-preview/pr-1895/src/data/childrenView.js\":\"04a3c7f16632e8c4\",\"/knowledge-medium/pr-preview/pr-1895/src/data/clientContext.js\":\"ce97f120ef88e406\",\"/knowledge-medium/pr-preview/pr-1895/src/data/dbFileSiblings.js\":\"cdaacb246345a364\",\"/knowledge-medium/pr-preview/pr-1895/src/data/definitionSeeds.js\":\"24096705923e2389\",\"/knowledge-medium/pr-preview/pr-1895/src/data/derivedIds.js\":\"327ee875c23d575e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/drawnSubtree.js\":\"fab934d9534fdbed\",\"/knowledge-medium/pr-preview/pr-1895/src/data/facetBridge.js\":\"cefb37c2d415c614\",\"/knowledge-medium/pr-preview/pr-1895/src/data/facets.js\":\"968c1aa851690b75\",\"/knowledge-medium/pr-preview/pr-1895/src/data/globalState.js\":\"1344e5873ff7fde1\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/aliasClaimRederiveProcessor.js\":\"14277da0189f6527\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/ancestorBatch.js\":\"321453a75574da6a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/blockTypeTypeifyProcessor.js\":\"aebf59e4af1db778\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/clientSchema.js\":\"a5987d14b73c488f\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/commitPipeline.js\":\"f0735f09a3fc1fcd\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/devAssertions.js\":\"9f6748bf00d2753e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/firstSync.js\":\"cbc6c4da6ee1ef64\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/freshInitialLoad.js\":\"577ff7784b140672\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/graphBackfillClaim.js\":\"15dc0a5537faefd3\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/handleStore.js\":\"cd4bb8baa91e7473\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/idleMarkerJobs.js\":\"33b60de260cf9cfa\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/initialDownload.js\":\"d0264b3b356bb7c8\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/initializeClientDatabase.js\":\"6811af448ac84901\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/jsonCanonical.js\":\"7e3e8f20f35597ab\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/kernelInvalidation.js\":\"879176f1d849d2bf\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/kernelProcessors.js\":\"29da0f24ec4f0447\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/kernelQueries.js\":\"1023ba49aefbdf67\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/mergeTypeMembershipProcessor.js\":\"b6e3e384afd7a7ac\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/normalizeReferencesProcessor.js\":\"8e71f7eb61c2d28d\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/poolInstrumentation.js\":\"e6489e6e7173066e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/processorRunner.js\":\"6e7734afe91c2603\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyCellBackfill.js\":\"9a56ed44655278c0\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyChildMint.js\":\"58c2db01bb5398c4\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyChildrenProcessor.js\":\"5ba8b337a8e410a1\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8e9ce6243b84db6b\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyDefinitionSynthesis.js\":\"63673861a21197dd\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyKeyScan.js\":\"71ee4cbe8d794f4e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertySchemaResolution.js\":\"a98fd0403bf7df9c\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyValueEdits.js\":\"53e6947b2b3fba63\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/raiseProtocol.js\":\"80a1d6159a285cd8\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/readBatch.js\":\"e4a6a206f8a9d2c3\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/refProjection.js\":\"8db703ab2bb73d72\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/referenceTargetLookups.js\":\"ce92ae3fbd3df25d\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/referenceTargetProcessor.js\":\"4efe9aade4dbf98b\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/replayMerge.js\":\"42636ae3169a9726\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/sqlBinds.js\":\"3a08b2d95ca55e46\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0d7ca6639f07f3a8\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/syncObserver/arrivalProcessors.js\":\"b2cd1e374bf53960\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/syncObserver/invalidate.js\":\"aac8195a99ee1a6f\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/syncObserver/materialize.js\":\"a694ae0a2439ead6\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/syncObserver/observer.js\":\"d6606e68a44aec05\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/syncObserver/reconcile.js\":\"1852f288d92dd515\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/timingMetrics.js\":\"c10c359e2db1db20\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/treeQueries.js\":\"b16cb29b548285fe\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/txEngine.js\":\"fb65fb29655f161b\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/txSnapshots.js\":\"b1e2986e02627b0e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/typedBlockQuery.js\":\"188ca01d39b9aabd\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/undoManager.js\":\"06722637501ddce4\",\"/knowledge-medium/pr-preview/pr-1895/src/data/invalidation.js\":\"89dcc76bdc5de61a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/kernelDataExtension.js\":\"a22550fc0fb626dc\",\"/knowledge-medium/pr-preview/pr-1895/src/data/kernelPage.js\":\"4a475f24b991f133\",\"/knowledge-medium/pr-preview/pr-1895/src/data/kernelValuePresetCores.js\":\"4f3b01898be3d7e9\",\"/knowledge-medium/pr-preview/pr-1895/src/data/localDbCorruptionSignal.js\":\"e93b928f1e2597f5\",\"/knowledge-medium/pr-preview/pr-1895/src/data/localDbStorage.js\":\"ec500349d301c7da\",\"/knowledge-medium/pr-preview/pr-1895/src/data/localDbVfs.js\":\"cbfe967c6ac772db\",\"/knowledge-medium/pr-preview/pr-1895/src/data/localSchema.js\":\"759d0ab00daa1f3c\",\"/knowledge-medium/pr-preview/pr-1895/src/data/maintenance.js\":\"4a50b6ac885ade22\",\"/knowledge-medium/pr-preview/pr-1895/src/data/mergeProperties.js\":\"6f1b0bf958e25bda\",\"/knowledge-medium/pr-preview/pr-1895/src/data/metricsConsoleHook.js\":\"3ea8f2a8db3361d0\",\"/knowledge-medium/pr-preview/pr-1895/src/data/migrationsPage.js\":\"88c57c9f4b37a2d2\",\"/knowledge-medium/pr-preview/pr-1895/src/data/mutators.js\":\"b81a3695f6a0aef9\",\"/knowledge-medium/pr-preview/pr-1895/src/data/orderKey.js\":\"506515c1adf60f4a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/orderKeyPlacement.js\":\"e25a0c204957530c\",\"/knowledge-medium/pr-preview/pr-1895/src/data/outlineSurface.js\":\"ea9a7c8eb79c5a01\",\"/knowledge-medium/pr-preview/pr-1895/src/data/pendingEditorContent.js\":\"b6633265c12cc1a6\",\"/knowledge-medium/pr-preview/pr-1895/src/data/pendingUploadsSql.js\":\"240e6242ef67a75c\",\"/knowledge-medium/pr-preview/pr-1895/src/data/pluginStateExtensions.js\":\"ff0cfc65897bda1b\",\"/knowledge-medium/pr-preview/pr-1895/src/data/powerSyncLogger.js\":\"9b6bbc16aec8c063\",\"/knowledge-medium/pr-preview/pr-1895/src/data/projectorRuntime.js\":\"c7a959c6065b0dfb\",\"/knowledge-medium/pr-preview/pr-1895/src/data/properties.js\":\"3bfa8b4c5e9c7ee1\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertiesPage.js\":\"e6c1eebffeb46577\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertyChildren.js\":\"37ab307c7e14d791\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertyDefinitionFanout.js\":\"9fb3955d918de6b0\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertyDefinitionMetadata.js\":\"cdb5dfea3e87309f\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertyDefinitionRegistry.js\":\"c8ab08c5a50b06b8\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertyDisplayMode.js\":\"34d1750b985c6cf7\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertyRowCreation.js\":\"cddf940e15e61837\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertySchemaCreation.js\":\"403b963af0c13760\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertySeeds.js\":\"7191855090605bf8\",\"/knowledge-medium/pr-preview/pr-1895/src/data/recentsPage.js\":\"0e647df06058b11c\",\"/knowledge-medium/pr-preview/pr-1895/src/data/refTargetComparableProperty.js\":\"ef2e3c0393441029\",\"/knowledge-medium/pr-preview/pr-1895/src/data/referenceBlock.js\":\"5fcd8f48f1414e55\",\"/knowledge-medium/pr-preview/pr-1895/src/data/rejectedUploads.js\":\"bf9e624fb1cb1698\",\"/knowledge-medium/pr-preview/pr-1895/src/data/releasePowerSyncConnection.js\":\"45119296e4887bff\",\"/knowledge-medium/pr-preview/pr-1895/src/data/repo.js\":\"b9918ff1c635b743\",\"/knowledge-medium/pr-preview/pr-1895/src/data/repoProvider.js\":\"6fa2894f8ea2b501\",\"/knowledge-medium/pr-preview/pr-1895/src/data/rowProperty.js\":\"9f09899d40eab0fe\",\"/knowledge-medium/pr-preview/pr-1895/src/data/searchFilter.js\":\"9158e88de1de61c3\",\"/knowledge-medium/pr-preview/pr-1895/src/data/seedIdentityLedger.js\":\"14189ad7a1b30677\",\"/knowledge-medium/pr-preview/pr-1895/src/data/stateBlocks.js\":\"12ede9a0a3f41660\",\"/knowledge-medium/pr-preview/pr-1895/src/data/structuralEditPolicy.js\":\"84970bbed1d09541\",\"/knowledge-medium/pr-preview/pr-1895/src/data/structuralInsert.js\":\"8b5c0c9866b4dddc\",\"/knowledge-medium/pr-preview/pr-1895/src/data/subtreeDelete.js\":\"a728f93e8f0ce3f7\",\"/knowledge-medium/pr-preview/pr-1895/src/data/syncStreamLock.js\":\"e4e631504c2d44ec\",\"/knowledge-medium/pr-preview/pr-1895/src/data/syncedTableSqlRecognizer.js\":\"1a71a49b959f247d\",\"/knowledge-medium/pr-preview/pr-1895/src/data/syncedTableWriteGuard.js\":\"a1b4dd0247e73440\",\"/knowledge-medium/pr-preview/pr-1895/src/data/targets.js\":\"9091a4774c2a0e9f\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeColors.js\":\"044ef3578b561684\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeDefinitionMetadata.js\":\"2e2f703ebd53acbd\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeDefinitionRegistry.js\":\"6c239640792cf0b2\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeExtraction.js\":\"a761a34bbc81a260\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeInitialValues.js\":\"5571f13725f7a47d\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typePropertyGroups.js\":\"8720b4728dfed2c7\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeSeeds.js\":\"e622aafc0ca7101a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeTagger.js\":\"d3217e156828b4cf\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typedRecords.js\":\"8f423cae169c74fb\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typesPage.js\":\"3b1b745b38136d66\",\"/knowledge-medium/pr-preview/pr-1895/src/data/userPrefs.js\":\"06ecd22b8ac47a03\",\"/knowledge-medium/pr-preview/pr-1895/src/data/userSchemasService.js\":\"ac4c0ce931eefeea\",\"/knowledge-medium/pr-preview/pr-1895/src/data/userTypesService.js\":\"92f3f9d5add769d9\",\"/knowledge-medium/pr-preview/pr-1895/src/data/valuePresetRegistry.js\":\"76b9c1178c0c17ac\",\"/knowledge-medium/pr-preview/pr-1895/src/data/visibleChildren.js\":\"4f68b7054fde7c84\",\"/knowledge-medium/pr-preview/pr-1895/src/data/workspaceConversion.js\":\"05bf65020563f2d3\",\"/knowledge-medium/pr-preview/pr-1895/src/data/workspaceFirstSync.js\":\"3d9aae231dcc37eb\",\"/knowledge-medium/pr-preview/pr-1895/src/data/workspaceIdNamespace.js\":\"b8b1cf670e8cef88\",\"/knowledge-medium/pr-preview/pr-1895/src/data/workspaceSchema.js\":\"6e36ff39a7776e09\",\"/knowledge-medium/pr-preview/pr-1895/src/data/workspaces.js\":\"13688d9985e1090a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/writeAheadLog.js\":\"ae24ee6ca73f07e6\",\"/knowledge-medium/pr-preview/pr-1895/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/BlockPasteShellDecorator.js\":\"bc3c79e5783d8af1\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/atTrigger.js\":\"148f329c5b2cdba3\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/autocomplete.js\":\"3524cc03a464eacb\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/codeMirrorExtensions.js\":\"ba20f84de11f5272\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/contentFlush.js\":\"bbb29957948e7eda\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/defaultInteractions.js\":\"32565c74c53fa7dc\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/editSettleSignal.js\":\"c216c1b490dd62aa\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/insertImage.js\":\"c370a19405533700\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/referenceCompletionRange.js\":\"40504521ff457bfd\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/referenceTargetTypes.js\":\"60f7961a8906cbe2\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/syntaxContext.js\":\"c67bc9dd886730aa\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/triggerMatch.js\":\"7b575914f865a7b7\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/AppRuntimeProvider.js\":\"62de9a610329d3ab\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/BlockFocusShellDecorator.js\":\"8947477e752709b4\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/ExtensionRenderBoundary.js\":\"b76e0ad83dff24f9\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/PanelContentRecovery.js\":\"d12a5fa0546c2d01\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/apiCatalog.js\":\"57f4e82fd9245f90\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/approveExtensionHere.js\":\"279ddf106e00704b\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/armedCutAppMount.js\":\"7368e145cd454024\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/batchableKeyedStore.js\":\"9e50d0cfba8adfeb\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/blockInteraction.js\":\"7ce6689f358e2f86\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/blockSelectionAction.js\":\"c669e17ff33d7797\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/compileExtensionModule.js\":\"07d106c27eac0206\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/compiledModuleCache.js\":\"885b3e6c2ee6de1d\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/continuousGestures.js\":\"15232fb69d54a99c\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/core.js\":\"d4ec80c1bf510d95\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/defaultRenderers.js\":\"51f5e20e195c3d93\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/definitionFanoutAppMount.js\":\"9d0178fcd9b610b1\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/dialogAppMount.js\":\"aaae44b935fbb206\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/dynamicExtensionSeeds.js\":\"832e152ebca049bb\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/dynamicExtensions.js\":\"e1d6aef18d8fd778\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/exampleExtensions.js\":\"38e5a1c118a7d702\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/extensionApprovalStatus.js\":\"cd2ed2c5ec349811\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/extensionLoadErrorToast.js\":\"0e442e06f6691d47\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/extensionLoadErrors.js\":\"a1254ec01944208e\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/extensionLookup.js\":\"222ec7ad39a8a19e\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/extensionToggles.js\":\"82bd8a1b72a1d639\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/extensionUtilitiesCss.js\":\"2c399229fcc47663\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/kernelPageDeletionGuard.js\":\"c6c9ffeb66598d18\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/liveRuntime.js\":\"b17ba48467f9b634\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/openExtensionsSettings.js\":\"3375590f9112b914\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/overridesCache.js\":\"5b61294098c728db\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/pluginIds.js\":\"2a72a3a9cfd3a715\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/processorRejectionToast.js\":\"292ebc6765b5c8b1\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/runtimeActions.js\":\"c947b91cd163bc46\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/runtimeContext.js\":\"97f3d737624c3dac\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/staticAppExtensions.js\":\"0401768705aa9ff2\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/staticDataExtensions.js\":\"f59cbfcc03e44571\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/toastAppMount.js\":\"f4e7158e6dc1646e\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/useOverrides.js\":\"02f7cae16239a7c0\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/useShortcutSurfaceActivations.js\":\"1c478025d8a0fb2c\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/discoverToggleTree.js\":\"fef6d030e41329fe\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/facet.js\":\"45d1a10f5735639f\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/resolveAppRuntime.js\":\"9aa8bc3785065457\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/runtimeEvents.js\":\"549303ccc48c95ee\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/togglable.js\":\"c9d095328ecacc14\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/variantFacet.js\":\"910bd53b9ce0c848\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/verbFacet.js\":\"dd2561c2c5e8c10e\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/block.js\":\"a317d9b363f65881\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/focusedChild.js\":\"a57d98ad4f578855\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/propertySchemas.js\":\"bc2cb0783647b958\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/typeRegistry.js\":\"2cd12cf37a3b31f2\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useAncestorCrumbs.js\":\"db49547345bb0227\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useAutocompleteListbox.js\":\"7e11c4d2f2f111c0\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useDebouncedSearch.js\":\"368f05567d9bcd7f\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useDebouncedValue.js\":\"c907bbbccdd530b8\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useFacetValue.js\":\"87971eef1abf01ca\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useIsFocalRender.js\":\"359ca1af61a8e77b\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useIsReadOnly.js\":\"f5f68781dce543dd\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useMaterializeBacklog.js\":\"36c98515f00c2706\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useMinuteClock.js\":\"c9f36564e57ca81a\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/usePanelLayoutProjection.js\":\"9de634043adb0d65\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/usePendingInvitations.js\":\"c6f2b29ab96d0755\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useRendererRegistry.js\":\"79b51eb3e76c93b4\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useRetainedFieldRows.js\":\"eb0877a9098b8a31\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useWorkspaces.js\":\"a5258c56a1da781d\",\"/knowledge-medium/pr-preview/pr-1895/src/lib/utils.js\":\"3a8a37773cb33480\",\"/knowledge-medium/pr-preview/pr-1895/src/main.js\":\"3f9a15df506f87fd\",\"/knowledge-medium/pr-preview/pr-1895/src/markdown/MarkdownImage.js\":\"fd0de75e60798aea\",\"/knowledge-medium/pr-preview/pr-1895/src/markdown/blockSeparators.js\":\"9983b2a3bd482ee9\",\"/knowledge-medium/pr-preview/pr-1895/src/markdown/context.js\":\"2059fdfbc7bc24c8\",\"/knowledge-medium/pr-preview/pr-1895/src/markdown/defaultMarkdownExtension.js\":\"df6d38823136020f\",\"/knowledge-medium/pr-preview/pr-1895/src/markdown/extensions.js\":\"7d5939eb6a1c4cb7\",\"/knowledge-medium/pr-preview/pr-1895/src/markdown/renderMarkdownHtml.js\":\"65a91681841afceb\",\"/knowledge-medium/pr-preview/pr-1895/src/minimal-editor.js\":\"9966e061bf3158eb\",\"/knowledge-medium/pr-preview/pr-1895/src/paste/armedCut.js\":\"0221e9c367921691\",\"/knowledge-medium/pr-preview/pr-1895/src/paste/captureMediaVerb.js\":\"009fdaa0d7db630d\",\"/knowledge-medium/pr-preview/pr-1895/src/paste/clipboard.js\":\"63064980ad1c777b\",\"/knowledge-medium/pr-preview/pr-1895/src/paste/decision.js\":\"405920989261464e\",\"/knowledge-medium/pr-preview/pr-1895/src/paste/operations.js\":\"a7e22f40a2b6d8ad\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/account-header/AccountHeaderItem.js\":\"e4f92c8caabbb6e0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/account-header/index.js\":\"85ab56b9d715a971\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"d210c3c9030b18f0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/askAgent.js\":\"9091df0ac28f38f3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/askedStore.js\":\"f8f786769a415412\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0eb0f47c24cfed55\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/chipState.js\":\"865c0d59f445a07d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/dataExtension.js\":\"562f589ca0658236\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/index.js\":\"31b12b4c4413ba36\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7bea8deb138e066b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/schema.js\":\"fbb6b2285c4629f4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/AgentTokensDialog.js\":\"75e5b8df76024368\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/BridgePairingDialog.js\":\"f103d69749cbbaee\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/addMedia.js\":\"c8a67f52bebdc9b8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/backlinks.js\":\"ea61cd2fed46e05d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/block.js\":\"a152edf99100df7d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/context.js\":\"d282f615c1a45866\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/displayIds.js\":\"bd52214f86d60b1e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/index.js\":\"c13970bdadfa566a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/outline.js\":\"e69d8155c7d2152f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/properties.js\":\"47820c46d5de933f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/refs.js\":\"9f80604fc7417367\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2f8bbfa8b2f783b5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/search.js\":\"3428a21e87bb2791\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/shared.js\":\"2e967b2f3705a3b0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"556e4c5cef8fd654\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/text.js\":\"d70688d6a95a5857\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentWrites.js\":\"1f8015ff0d15c21e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/authoringCatalog.js\":\"7f8af54c93625582\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/blockRefTargets.js\":\"b083a3534d242b3d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/bridge.js\":\"0857470060981c95\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/bridgeLoop.js\":\"9219fe3813ed709a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/changeHistory.js\":\"ad384716cbc7fa4a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/commands.js\":\"fe9e698f2a3027cc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/commentsCommands.js\":\"f1b1c07099c154b8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/dataExtension.js\":\"68f91bbd228d0727\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/dataModelGuide.js\":\"1a867dedeb35eab1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/dayPropertyInputs.js\":\"a5ae56bd498709f2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/describeRuntime.js\":\"ef34ad807e1e294c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/extensionLint.js\":\"e27b3b980275db4a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/grainAudit.js\":\"5e2cbd664e60f62d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/healthCommand.js\":\"39a282de60df50d5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/index.js\":\"73c942cf5ea2f0b5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/presetIdentity.js\":\"40d8d94f78056a82\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b1c5eb3aa20fab1d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/readMedia.js\":\"fb1d08684fa362db\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/schema.js\":\"ab06453f2d3a7494\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/serialization.js\":\"640ba0d82e959326\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/targets.js\":\"2b79dbada2b3c13d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/tokens.js\":\"16a80fc538fd9960\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/watchEvents.js\":\"8dbf6ba677e74867\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/workspaceGuard.js\":\"055cc330b91d0777\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/writeCommands.js\":\"9e058542ffbf9472\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/AliasCollisionToast.js\":\"1d2b22d081e4ba1f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/DuplicateNameBanner.js\":\"3196f4b002b238cf\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/collisionMerge.js\":\"4bc00bcae4cf0eb3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/dataExtension.js\":\"a5efb1ba9afc4456\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/index.js\":\"60415f2d51dfa9b4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/mergeCollisionAction.js\":\"534af0673fca456b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/pageStyling.js\":\"82c8be517f2c76fb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/rejectionToast.js\":\"7f7b0fb6db87c6be\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/syncProcessor.js\":\"279ad192bb2667b7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/actions.js\":\"388aa6cf95a8c393\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/addComment.js\":\"db4bcb54afdd892e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/anchor.js\":\"2e3623b49e590436\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/anchorState.js\":\"02316929fed0b5d8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/commentLinks.js\":\"d4e7656dfb3a20a2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/confirmThreadDeletion.js\":\"56238090b00aca4a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/container.js\":\"b274b36e7fb589ec\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/dataExtension.js\":\"0a8da2794570f849\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/deleteComment.js\":\"28148589a6d4e16b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/highlights.js\":\"0f0a48cef9d9e90e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/index.js\":\"7b1309c33a449ec9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/linkedCommentsPill.js\":\"1a185a4a277dde71\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/margin.js\":\"1bcddbe7848191a5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/marginAnchorLinks.js\":\"52f5b72215a48c5c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/marginSchema.js\":\"375876b7029ac8aa\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/newComment.js\":\"c52de3d72543eef0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/ownThreadPicker.js\":\"1a316e0418e95cab\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/placement.js\":\"b7adcd0c32dae91f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/queries.js\":\"46fedcf69d256b1f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/quotePosition.js\":\"2dc6f53ef014c051\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/quotedIn.js\":\"171801b268ae0f6b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/quotedRange.js\":\"5a97380608db32b1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/rangeRefs.js\":\"3a34e5c9cb36efaa\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/readHighlights.js\":\"4032d90d570c3250\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/readSelection.js\":\"7fed7a0d3458806e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/readSelectionUi.js\":\"0cdff4fa8656b34e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/reanchor.js\":\"013b6cb8d6a9f090\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/schema.js\":\"0c452e6a0b808214\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/scope.js\":\"51ae1c018a2b712b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/scopeThreads.js\":\"59020eed2e1a2d49\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/splitRetarget.js\":\"e8124957c6c2f278\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/suggestionCard.js\":\"8921b3c4c4110dc6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/suggestions.js\":\"dafbea9bde68b4e5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/summaries.js\":\"4dd3c94bafab5880\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/summaryBatch.js\":\"0dd23437f1a9be42\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/surface.js\":\"168862c75db49ae6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/threadNavigation.js\":\"2cf357c9850a3d77\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/threads.js\":\"d8e631e36e24756b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/ui.js\":\"22429d845b10a3fd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/uiStore.js\":\"4016ea848f58409f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/app-intents/appIntents.js\":\"07062a3ceb8eac9c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/app-intents/index.js\":\"e643eea2634ddffc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/app-update-prompt/index.js\":\"e64d5a4af72d46ac\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/app-update-prompt/status.js\":\"bdc4a4ba2674fcfd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"4c6e4952f4f12eeb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/MediaBlockRenderer.js\":\"05cc9c0c04a1d850\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/MediaDownLaneReplicator.js\":\"25574ffd83534a7c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/MediaUploadReconciler.js\":\"23a867ace72a3cfd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/assetDownLane.js\":\"3913b9210a98f80f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/assetResolver.js\":\"6389530141d82a0c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/assetUpload.js\":\"b1a469daa3c286e0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/attachmentCleanerIO.js\":\"964cb23d20020e7a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/audit/supabaseAuditIO.js\":\"15a05cb2a0419b5c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/blobStore.js\":\"c5099e36cd702b62\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/browserMedia.js\":\"64fe5dc3e7da7034\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/byteStore.js\":\"ba53081bc7f42d56\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/cleanerIO.js\":\"210adccdb7840805\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/cleanupAttachments.js\":\"292bfae9a8e4ced4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/dataExtension.js\":\"72ac867f1ab3554e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/downLane.js\":\"73a926d87025bc1f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/index.js\":\"00b0ac59290df24f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/insertImageContribution.js\":\"aa07fd58b39f9c80\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/laneArming.js\":\"c65c35c3e4b74f77\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/laneLock.js\":\"4f0e17e4117982b8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/mediaBlock.js\":\"32d3d36e55f8491a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/mediaCapture.js\":\"9db0e5130af296d1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/mediaLanes.js\":\"cdc05590637bc73c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/mediaViewers.js\":\"88b2fc27310d0b34\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/mediaViewersFacet.js\":\"37571413400db91b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/pasteCapture.js\":\"466d6b25c6ac458c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/resolver.js\":\"b93abeab2666340b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/retryUploadsAction.js\":\"de1c7e08a0fa6568\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/storagePaths.js\":\"32cdd4003b1d9939\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/uploadDrain.js\":\"56f665583f7bf97b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/uploadLaneStatus.js\":\"67dfb096bfbb17cc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/uploadReconcile.js\":\"0b70e81e7bab1a85\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/uploadRecovery.js\":\"2f997185a85171c4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/uploadStore.js\":\"09d52b424c0080f3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/useAssetObjectUrl.js\":\"f3bba9844cfe7b4e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"3c710b5fcf815604\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks-view/BacklinksViewSection.js\":\"2648aa7d39c204a3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks-view/facet.js\":\"3ac62c2b666a04f2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks-view/index.js\":\"1e3a46c1379f4f6c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks-view/prop.js\":\"896c0ea1346dce64\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/BacklinkFilters.js\":\"7fac31064a58f9a2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"0a341a4b1826e871\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/BlockEntry.js\":\"be67e157f08a7eae\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/LinkedReferences.js\":\"49c9cd7be776c3d2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"4b6740cf9e674cc5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/dailyNoteDefaults.js\":\"870094f982301fe1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/dataExtension.js\":\"b62d31945c0f855c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/edgeExclusions.js\":\"72c24e95ba24ca55\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/filterProperty.js\":\"6e6da76e2d559d15\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/index.js\":\"19e1d87094a78b56\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"b0fac74c5860f233\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/inline-counts/applies.js\":\"07690d2938a4e80d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/inline-counts/countQuery.js\":\"f09631a68a1df8dd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7e51dc50b3c18ab9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/inline-counts/index.js\":\"c2b9e744224bed84\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9d2a42c2eaa84c94\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/presentationInvalidation.js\":\"ae8b5fc4d3a9278e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/propertyEditorOverride.js\":\"cc25402e1cf80e0d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/propertyFilter.js\":\"6e1aec0d9a7b9e75\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/query.js\":\"5ece567419040531\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/resolveFilter.js\":\"60ae713b83ab5e45\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/sourceBatch.js\":\"5257a3fcd626c1dc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/sources.js\":\"9c1fd314f35ad162\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/useBacklinks.js\":\"da7fc4e71aa17816\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"bc2a24d4ab7776b3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/birthday/BirthdayCelebration.js\":\"5a1ac911d8d69a70\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/birthday/BirthdayOverlay.js\":\"7a9f656ad55bf0b2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/birthday/gate.js\":\"d6d3619074a7de32\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/birthday/index.js\":\"7f9fe93fe1902548\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/birthday/wolfTheme.js\":\"1517965838fdbb64\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-drag/BlockDragLayer.js\":\"d87c18653521340d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-drag/dragController.js\":\"b085109cd4e30f5f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-drag/dropTarget.js\":\"37aac749e272926e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-drag/index.js\":\"44eb09b73e7de0b4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-drag/projection.js\":\"e646cb5ad47f63fb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-info/BlockMetaCard.js\":\"07aae4ea799e618d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-info/index.js\":\"fb4ff7696220149b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/AddTagDialog.js\":\"0ea0e4d265a16be5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"43b758930ab80e88\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/TagNameIssueHint.js\":\"864361825c5d87f6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/addTagAction.js\":\"117361a11da5ab8b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/appendTag.js\":\"f706af43a7ea940c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/config.js\":\"aa58a70af676ed13\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/dataExtension.js\":\"c62a2cf94ceff224\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/index.js\":\"289adf747f274bb5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/propertyEditorOverride.js\":\"2a7d427c1b626282\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5c2e4539e5a20251\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"f7b970efcc06d4d7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/Breadcrumbs.js\":\"aeef3522c85592b8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a81b1e1101acc5a3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"1592102e610f717c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/index.js\":\"aab955fd3ddb1369\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"02822246db757ad6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/CharacterCountItem.js\":\"d15da204fd0be37b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/ProfilePropertyEditor.js\":\"09d9204562c4950c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/actions.js\":\"f2c4d950b4ffba65\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/blockType.js\":\"c519910b41466ba9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/charCount.js\":\"487a42eed44ffd27\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/dataExtension.js\":\"c771357b7ebe8759\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/index.js\":\"d0abdadb4584d7ca\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/profiles.js\":\"614fec2d06fb66ac\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/properties.js\":\"e5c263a75a64ccb0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/subtree.js\":\"3ab7a0cebec7d010\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/textCounts.js\":\"bccd865022dea7e4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/colemak-keybindings/index.js\":\"84842754848ce7a7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/CommandPalette.js\":\"6e9a45623f356617\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/HeaderItem.js\":\"a9c8dd999c9f183d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/context.js\":\"50ac77d911446e6e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/index.js\":\"54af845b8a906bb9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/selection.js\":\"fa565105c31ea45a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/toggleStore.js\":\"4036182a4cd544e4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/useCommandPaletteActions.js\":\"03b0edefc5fe7f8f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/ContributorBadges.js\":\"ba1537629e0d68c3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/ProfilePicture.js\":\"20dd2c3f5bf99d4b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/author.js\":\"dda33b1dc887eaba\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/codeMirrorExtensions.js\":\"f54cad204ce82128\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/dataExtension.js\":\"6a40c40b654c9158\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/index.js\":\"fa8de0ea71b1429b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/mentionAutocomplete.js\":\"8194ce88cb61c51a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/processor.js\":\"9d3dfda9baf978ee\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/profiles.js\":\"a578c9e9c188e553\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/queries.js\":\"40b0a1669b609152\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/schema.js\":\"193ae2d1aa6a2bcb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/useCommentAuthor.js\":\"3c23d988d46a2433\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9717b28ab503da52\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ca8e458eb319de97\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/cursor-follows-scroll/index.js\":\"35d9b660bf579ea8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"059ada1d755c3c7b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"90925fcf0cf7c1dc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/CalendarGrid.js\":\"77c0f8861ca83992\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/DailyNotePicker.js\":\"dfcb5fa35a020b2f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"20cf48e79aa730fa\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/DateNavDecorator.js\":\"1219db553ade19d5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/DateScrubOverlay.js\":\"470b69fe315a090d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/DayPropertyControl.js\":\"4b8c9ba6ad4e7e6c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/DayValueReferenceControl.js\":\"61a954f93703ac24\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/HeaderItem.js\":\"ad15258de1222314\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/ReschedulePicker.js\":\"d8bfc27dd21f27d1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/SpreadDatesDialog.js\":\"3578ddf383aec65e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/actions.js\":\"5f8b87593b145ec6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/blockDateAdapter.js\":\"d8fe76e439c84714\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/calendar.js\":\"61c8db0a945d214d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dailyNotes.js\":\"ccf6017a2941800f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dataExtension.js\":\"6343ce4ba4f780f3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dateScrubActions.js\":\"9be2e29c8a63ab59\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dateScrubGesture.js\":\"ae968e1bd61b987a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dateScrubGestureActions.js\":\"5852b248f1370425\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dateScrubRecognizer.js\":\"717d2aca309a4a4b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dayProperty.js\":\"2ef85a916010a5d8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"57f647293021e705\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/deletionGuard.js\":\"3b859ec13d058967\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dueQuery.js\":\"3af4725404c8405a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/index.js\":\"13a68a3479ccd3dd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/landing.js\":\"4f18007f9ee0ac49\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/localSchema.js\":\"cd83daeaf0c8c105\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/referenceDateAdapter.js\":\"4d00c9b4e40c1b90\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/rescheduleAction.js\":\"b504bf9aa014270c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/schema.js\":\"d82d7909962b93d9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/spreadBlockDates.js\":\"bee9432bc4ff18de\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/spreadDatesAction.js\":\"74d6b6b1eec9cdd0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/today.js\":\"01d4970b3786b9c5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"4395ef6197ad0973\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7231167eab771dbb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/audit.js\":\"eaeb753424137bf2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/auditAction.js\":\"103b92a41b660934\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/auditRanges.js\":\"06615cd061d2dd3a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/diagnosticsSource.js\":\"71dd2962f7608c78\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/divergenceScan.js\":\"224f8bbcd2be8af8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/index.js\":\"23a7e07e5400b1f5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/propertyChildrenChecks.js\":\"79abe3b6d8a8f8e8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/referencesMirror.js\":\"4025d45f596edf41\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/rowJson.js\":\"f424ad183995b245\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/schedule.js\":\"e7a5e538d8f848c9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/store.js\":\"064c2f51127022f9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-maintenance/action.js\":\"d84332c3af8b74a8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-maintenance/index.js\":\"3dc1fb8056e437cd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-maintenance/plugin.js\":\"20fa4f39a9effbb1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"bc016dbb7a40ece3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/actions.js\":\"ab00f0fcd147a9be\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/changeMarker.js\":\"af74c9e2272bf396\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/diagnostics.js\":\"c55e27fca4127282\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/fileSystemAccess.js\":\"dd2c4508951f8612\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/filenames.js\":\"c9e59c2f2e4af664\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/index.js\":\"467911089add2ec0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/mirror.js\":\"77de2baeff6699fa\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/runLock.js\":\"2ba1899ce4f21cf2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/runtimeHealth.js\":\"00d8ccccac2c79df\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/schedule.js\":\"03a8dbd26bc0e376\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/store.js\":\"221b5100bcfd04af\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/default-themes/index.js\":\"cc93259c338ee9a4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/default-themes/themes.js\":\"3e15884de5235628\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/diagnostics/facet.js\":\"ce97f6413b4b2b4e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/diagnostics/useDiagnostics.js\":\"0a0f85d9814f61d1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extension-prompts/dismissals.js\":\"59e70aa6d6d36972\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extension-prompts/index.js\":\"cbf2e1736d76638d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extension-prompts/status.js\":\"bdcab914d1ed703e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extension-prompts/store.js\":\"753d30545ad57941\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b2d0a2ae1ba1b2c8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/ExtensionsSettings.js\":\"5c0b9066fb533c77\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/actions.js\":\"71627a6a933c961f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/config.js\":\"58229379123bd1b8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/dataExtension.js\":\"a55aa9d466617bb3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/effect.js\":\"3e9726c1dbb34158\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/index.js\":\"150d82ca1742e921\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/propertyEditorOverride.js\":\"5b7cc30877d97766\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/useToggleTree.js\":\"752521785f7030cf\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extract-type/ExtractTypeDialog.js\":\"aee7ce5fca365b79\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"558b57c4a561730a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extract-type/PropertyShapePicker.js\":\"e7c3032b88dc816f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extract-type/action.js\":\"05606e2b0ed63c66\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extract-type/index.js\":\"44f01562f1a44af7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/FindReplaceDialog.js\":\"01f35bcb48cec938\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/HeaderItem.js\":\"6ddef9068fa3604d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/dataExtension.js\":\"0e0c4e996f86f3f5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/index.js\":\"7776f70d43fea3b4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/search.js\":\"e5a34c16853003ba\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/toggleStore.js\":\"bd21b91d7bfbf53e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/LocationPropertyEditor.js\":\"c82cf5ca45d7cb20\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/MapView.js\":\"dbb599bd38351f81\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/blockTypes.js\":\"c4c53851a5b773ab\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/codeMirrorExtensions.js\":\"51be4cce9bd3bdef\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/createOrFindPlace.js\":\"2959b13266185629\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/currentLocation.js\":\"675377f89c404647\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/dataExtension.js\":\"8bfe66a0a375d7d4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/geoContentDecorator.js\":\"5d4e899830b89a9b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/googlePlacesClient.js\":\"d46c0ad8e2efc4df\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/index.js\":\"c956066eec4166ce\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/locationsPage.js\":\"88ee7b564f580b70\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/mapViewport.js\":\"8f91532703cb77e8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/pickCurrentLocation.js\":\"1f3f9e627332443e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/placeAutocomplete.js\":\"5477c09e33f5f319\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/placeNameCollision.js\":\"f3f534aa5742bc1f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/properties.js\":\"7466538250a5159f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/propertyEditorOverrides.js\":\"1c5fbca6fce405b5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/query.js\":\"c589880a881baa4b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/usePlaceSearch.js\":\"a1448895feb582dd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1a00fe9b048f7208\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"660fde2a721e9892\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7a00519541e9d577\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/config.js\":\"e9ebd505d8bcaed0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/dataExtension.js\":\"794ad2affc6ca99d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/facet.js\":\"28f3ecbc1099b17d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/grouping.js\":\"dd4f96e009660551\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/index.js\":\"d0660f2be24f1153\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"70ed588ce4b9fd70\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/query.js\":\"dacc18700a31c197\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/resolveConfig.js\":\"40b551d7c13c6351\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"928da75df1de44b1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3b7eabdf6c5b8e30\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/HtmlDocumentContent.js\":\"c7125002bb44bae5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/HtmlFrame.js\":\"530677df0c7a4803\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/actions.js\":\"fccb13361ee87cdc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/blockType.js\":\"247a0572c202a587\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/confirmRunScripts.js\":\"2a2724c099404ae9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/dataExtension.js\":\"1d61bae56d21d7f6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/frameAnnotations.js\":\"e3ed6cdfbd08788f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/frameDocument.js\":\"69a36e60523250cd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/frameTheme.js\":\"e6a783f144d54988\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/index.js\":\"8a297ab7a9e6b75f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/scriptConsent.js\":\"ada2974e8777a2ab\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/sourceMap.js\":\"80ba969a8130bfda\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/useDocumentScripts.js\":\"6bf118640972589c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/interaction-metrics/index.js\":\"93092437e632d5ff\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/interaction-metrics/record.js\":\"388e3ea279eded7f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/interaction-metrics/recordStore.js\":\"73552f26ed98890f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/interaction-metrics/responsiveness.js\":\"aca32bb4835abf9d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/interaction-metrics/schedule.js\":\"ff31acb92ae18149\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/interaction-metrics/sessionContext.js\":\"94b305e5e05bbdcb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"28e96d001e2c432a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"4415167901662665\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/actions.js\":\"393b8816727b4241\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/config.js\":\"90034d38726ad2bc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/dataExtension.js\":\"bd5b40c70f77478b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/effect.js\":\"95877cd85d8b127e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/index.js\":\"9d538324a32c8119\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/keyCapture.js\":\"7821b73693226a27\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/overrideStore.js\":\"7db85a53136d10f3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"dd0c12542314cf15\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/HeaderItem.js\":\"998a4a93e08b74b5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/LeftSidebar.js\":\"3000888d3c65925c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/actions.js\":\"a0eaee41393d6c82\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/facet.js\":\"4e7ff620aa0f38ad\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/index.js\":\"276ad9573252701d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/shortcuts.js\":\"c7e5b38171f6a80f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/toggleStore.js\":\"02872c1f40049554\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/merge-blocks/MergePicker.js\":\"3d64d79a988ceb00\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/merge-blocks/index.js\":\"c1b8d77913b2734b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/merge-blocks/mergeAction.js\":\"feb003ecef86f9be\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/merge-blocks/strategy.js\":\"47967fb59d0c578b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-bottom-nav/Button.js\":\"910413727b6b3a2d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"415ee0a721ec9ae2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-bottom-nav/defaultItems.js\":\"428e6228372095b0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-bottom-nav/facet.js\":\"3cfc981d896afef6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-bottom-nav/index.js\":\"575f0d4dc61ab2a2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"43427adc51eb7137\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a5e3e7496d1d004e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"a5b485fe007b31d0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-keyboard-toolbar/facet.js\":\"025b5b74181f0600\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-keyboard-toolbar/index.js\":\"c44061676edd2da8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/MoveDestinationPicker.js\":\"396ea8af467f80d1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/blockSubtreeMembership.js\":\"42ccbf3a5a58de14\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/contextMenuItem.js\":\"3cc7400dc227a39c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/index.js\":\"0c11033b8901c757\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/moveAction.js\":\"89adea0dbe2cd3ba\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/moveBlocks.js\":\"4304b564565cf509\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/selectionAfterMove.js\":\"7ae626ead9b3c081\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/TutorialBanner.js\":\"c0ae3e97e98fff8b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/action.js\":\"247639a23d07ceee\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/bannerDismissal.js\":\"d0ffc0a361fc106b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/documents/cheatSheet.js\":\"9aaf2798c25bfcdc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/index.js\":\"db3e60cdbceed105\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/keys.js\":\"68e7c29b0004f727\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/landing.js\":\"50eb02c5fd904dca\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/outline.js\":\"8eeb388b72b7b3f4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/seed.js\":\"13b478cdcd12ae81\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b308f56e4e6b59cc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/analyze.js\":\"8795e0dd8cf3a315\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/diagnosticsSource.js\":\"30e311e021778cbc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/index.js\":\"5c8434ed6456bb7d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/load.js\":\"aad05e11e14773d6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/monitorRun.js\":\"41c5354a3573748a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/schedule.js\":\"554b6315244f5791\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/series.js\":\"50cb87c4835f5fc2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/store.js\":\"1a1469bff6085b54\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/trendAction.js\":\"492c9cda09a57a30\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/verdict.js\":\"4ab981122c7085cb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/plain-outliner/clickToEditAction.js\":\"8b9874e27468fffe\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/plain-outliner/index.js\":\"74b41d571169cc5b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/plain-outliner/interactions.js\":\"1cb6286308f73886\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"38505813d0cee6ac\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/MigrationGate.js\":\"b2804aab1044e900\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/MigrationGateDialog.js\":\"ba49b7bfa991cada\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/action.js\":\"741e00164cb69984\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/index.js\":\"d0e58aaa14a7b2e5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/localRunMessage.js\":\"970e34f0ea4754a9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/plugin.js\":\"6985e638eb558f3f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/progressReport.js\":\"f727a9405e05fb52\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/sweepProgress.js\":\"ecd86550ab8dc177\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/FieldRowRenderer.js\":\"e9ec44e258d50e7b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/ValueRowRenderer.js\":\"00be1832a9b480fb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/actions.js\":\"f2d46edb5c156da0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/autocomplete.js\":\"91754e017cd3aae6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/fieldRow.js\":\"400f792656471443\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/index.js\":\"4ec30d143a3afdc2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/referenceWarning.js\":\"70a62710daefafb3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/valueAutocomplete.js\":\"b7177c6075cf391b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/valueSchema.js\":\"e5b1baccb6843a6b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/HeaderItem.js\":\"73e236be71e2c5ac\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/QuickFind.js\":\"e4a3bb0b2b5e6530\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/index.js\":\"9d920f34d93649c4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/recents.js\":\"cc7d4471e62e68f7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/resultItems.js\":\"5f9a4d6b73871137\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/selection.js\":\"6fd465ce5a9516bc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/toggleStore.js\":\"61a43fe32a71220f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/recents/HeaderItem.js\":\"4bb089c0fdf4ce71\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/recents/RecentsPageBlockRenderer.js\":\"785433d6ece78ed5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/recents/grouping.js\":\"f823588a3472ca79\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/recents/index.js\":\"ae4e5b514d15a468\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/recents/target.js\":\"e766649f58421f4e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/codeMirrorExtensions.js\":\"eeb67119aa4b7501\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/contentPrefill.js\":\"80e1857a1274d4c7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/dataExtension.js\":\"fb3a95c94ac3efec\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/index.js\":\"885cfa8373437913\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"62638ee87ac94df1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/invalidation.js\":\"49404d646a1ba7b3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/localSchema.js\":\"4f8a623bfe23cbc9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/blockrefs/index.js\":\"6613dcc5e230efc3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"8cf3cd8084f04a59\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/index.js\":\"88e7afbcb34a8c16\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/referenceNode.js\":\"4534e0795382c5c7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a6759306375c493d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"acd91f0871bb6ff9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/wikilinks/index.js\":\"7663b1d2da22ff3c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"04ca2032f87d7fb7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"6ab8cd3476fc7c76\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/mergeRetargetProcessor.js\":\"4686f3fb8db10f03\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/parseFence.js\":\"86a51fd8f465bcf1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/referenceParser.js\":\"50ac5b08200d50ae\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/referenceProjection.js\":\"0a9599aba5a2ac56\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/referencesProcessor.js\":\"7fca97b5eb9ddf75\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/renameProcessor.js\":\"5f0a5e8bb3a910fd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/spanReplacement.js\":\"ac4365cb47af41f8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/rich-paste/htmlToOutline.js\":\"396ad5759a9c3f55\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/rich-paste/index.js\":\"483f6219dce3edeb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ef6f40a376413de6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/rich-paste/pasteDecision.js\":\"d492239862d58da9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/action.js\":\"38c2be0491c762d6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/blockIds.js\":\"aefd9f41242e5590\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/content.js\":\"fdd75910aa520163\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/effect.js\":\"d42bfd7523575730\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/ids.js\":\"df9233d03cfcca1c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/import.js\":\"8c185f3fdc05b53e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/index.js\":\"002ed7ba64e4cb08\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/plan.js\":\"e98c14c6f8e4c183\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/plugin.js\":\"42274a0613b3ed52\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/promotion.js\":\"f4a9a4afaf51defb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/properties.js\":\"5ed31444b6a30188\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/references.js\":\"81405991d174c9e8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/report.js\":\"a6c258b883b63491\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/roamMemo.js\":\"26c57a40b3e6777f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/runtime.js\":\"6228a0608148ce35\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/schemaReconciliation.js\":\"eeb8f4bc9df613e2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/srsMarkers.js\":\"596f997bcb383240\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/todo.js\":\"0ae173215b92f23f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/typeCandidates.js\":\"2af4295ccb781853\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/types.js\":\"47e60a20964b9c9f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/search-health/index.js\":\"1faa69c3a18fe7e1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/search-health/store.js\":\"f5cb9e27ca057660\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/shortcut-help/HeaderItem.js\":\"83c8c4db1e18b51e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"abea61988d35c924\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/shortcut-help/index.js\":\"96f5658a6081d4e6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/shortcut-help/model.js\":\"78232ea6167132e2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/shortcut-help/toggleStore.js\":\"43f8c481dc614728\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/shortcut-help/useKeyInspector.js\":\"e980079c6c8aa7b5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f1ac22ab0123a04e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/ShellDecorator.js\":\"d4117cf171303c72\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/actions.js\":\"d46276b54e074d23\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/exclusionsFacet.js\":\"fe7e2f51204626d4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/index.js\":\"3faf3b46cbea61e0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/shell.js\":\"5f9c9d60c7f114cd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/surface.js\":\"64b72e9fd7c40aa6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/walker.js\":\"8590a669801c72ad\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c8a95b932513c357\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/dataExtension.js\":\"7577bd636301541c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/index.js\":\"4ecdd76340797d54\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/indicator.js\":\"8b0c62af5164d5d0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/moveSrsState.js\":\"ddecc319f7dd1af4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1ce7d318fca36d62\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/scheduler.js\":\"29c49108586e6da6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/schema.js\":\"0b1a8a06f8100000\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a08051500e43e830\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/srsClipboard.js\":\"0abbb8b8e2af5a18\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e9d1c076241cd705\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/DailyNoteReviewHint.js\":\"11fc95958b8d616c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/DeckPicker.js\":\"bc9ff5766d5f683a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/ReviewControls.js\":\"7cda5943dca0150c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/ReviewDeckRenderer.js\":\"b28e1881455ff6d6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/ReviewSession.js\":\"c92671b1596b8cfe\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/actions.js\":\"2ad8524affb80ce1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/archive.js\":\"d89c6380a55bc742\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/dataExtension.js\":\"8495d079f3f811ea\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/deck.js\":\"2db6569ae9169543\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/dueQuery.js\":\"896e08e1b98dd71d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/gradeDecision.js\":\"5df80a1270d629fd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/index.js\":\"5da7d4d5c0068dd2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/keyHints.js\":\"f378865b0d634e93\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/reviewCardLayout.js\":\"58d8b31a42b052a1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/reviewProgress.js\":\"97a87197f35fc94b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/schema.js\":\"ac7f6d3dd9033cf6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/useDueCards.js\":\"fe25ccd7c933d0ba\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/startup-metrics/index.js\":\"ffa61013541f3b49\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/startup-metrics/record.js\":\"97853ba626258c09\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/storage-persistence/index.js\":\"eeef9f45feba7829\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/storage-persistence/persistenceStatus.js\":\"42e6da6d0b4ef869\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/storage-persistence/requestAction.js\":\"d2518aadcd431a10\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/supertags/TypeChipsDecorator.js\":\"39ad9fab6c7b7c8d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/supertags/codeMirrorExtensions.js\":\"79137a8deaafbdf2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/supertags/index.js\":\"90f422aa8e8956ca\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/supertags/typeAutocomplete.js\":\"6a6989519ae5daff\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e17d3ae154fd9302\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/actions.js\":\"e6164819100b9e17\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/anchor.js\":\"8ac465df806f5b91\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/events.js\":\"5d1d57788f705eeb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/gestureActions.js\":\"c99cd0acdd2cdfc1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/index.js\":\"2779d3757d6dec71\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"2c63f08873addc8a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/sync-metrics/collect.js\":\"ead26d4b8edaee1f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/sync-metrics/index.js\":\"571a694acb38827c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/sync-metrics/record.js\":\"7297a5d2ae6c3df7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/RejectionDialog.js\":\"3021710609025bed\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ff73c155aa1a374e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/index.js\":\"fe944821bc88b93e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/model.js\":\"70d7953895237b21\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/queueCounts.js\":\"962def372e58df88\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/rejectedHelpers.js\":\"b9926044f1f5d13d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/rematerializeAction.js\":\"b21d68a485a366fd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/useHysteresis.js\":\"323ff5e2e21d4881\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/ColumnHeaders.js\":\"880f9f937c52122e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/QueryUi.js\":\"dd2bb7ccb2a81be3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/TableLayout.js\":\"7d31f7b072feedab\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/actions.js\":\"6b69efa75a7c7141\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/cellEdits.js\":\"eec0477b42445505\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/childrenViews.js\":\"441c1bf573b7da48\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/columns.js\":\"bf49172b0c0b89e3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/controller.js\":\"8400ca5bf509e9d2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/convert.js\":\"1c0dbaec5d6e0964\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/dataExtension.js\":\"d4ef3e667120e2d4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/index.js\":\"ee2f4da448993714\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/keys.js\":\"1521bc81540e70ec\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/model.js\":\"e342bbc27e30a45d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/QueryText.js\":\"a279485778d66372\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/backfill.js\":\"7c82f4e91ecf7beb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/completion.js\":\"f4cefc282a305b46\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/format.js\":\"8ab6a4adf186d42d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/parse.js\":\"ed39dc2a27ad515e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/queryValue.js\":\"ba3869253fa08eae\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/registrations.js\":\"03c72c74feed5ec1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/source.js\":\"731c43f64ae7576c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/registry.js\":\"2b7f8d1777405f2f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/rowGutter.js\":\"7d07f4519b6d4b48\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/rowVerbs.js\":\"5410fdc1c7fcf69d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/schema.js\":\"a2b8b135f3b397d3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/sort.js\":\"ae5059017c44970d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/theme-toggle/effect.js\":\"c6b86798a9adf52d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/theme-toggle/index.js\":\"ca7ebb309074ebfa\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/theme-toggle/theme.js\":\"d966afedf4f9262f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/todo/actions.js\":\"0d4b346d8905f427\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/todo/dataExtension.js\":\"b9bf4e905af599ee\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/todo/index.js\":\"d18735fe4ebc4b64\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/todo/schema.js\":\"0da862638166c373\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/touch-selection/TouchSelectionLayer.js\":\"781f37a84eb77548\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/touch-selection/actions.js\":\"4f9aa78f8246a654\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/touch-selection/defaultItems.js\":\"a52e759310043f0b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/touch-selection/facet.js\":\"d6890cdfa3a40ea4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/touch-selection/holdRecognizer.js\":\"5360e018333c4081\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/touch-selection/index.js\":\"52affb8407e6cc01\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/update-indicator/UpdateIndicator.js\":\"739a24a3938be228\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/update-indicator/index.js\":\"bee7171f2b23babd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/update-indicator/loadTimes.js\":\"d27dbed986e9ffc0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/VideoNotesRenderer.js\":\"9d24aa3e5f004230\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/VideoPlayerRenderer.js\":\"edaf4b82737b3022\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/VideoTimeStamp.js\":\"9a1b49fc3e0fd863\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/actions.js\":\"91ae63117b9fadac\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/index.js\":\"e58efdefb411e12a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/markdown.js\":\"477a1bf53f2f7189\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/notes.js\":\"3ff9eaed62f3df93\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/registry.js\":\"3e455e3e6fdc4c69\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/remark-timestamps.js\":\"cb4653fcc610270c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/view.js\":\"0838babf7e6e2754\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-link-hints/LinkHints.js\":\"43310fad4246ac29\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-link-hints/index.js\":\"c62729c1cc32a578\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-link-hints/model.js\":\"6fa8367ec3bc9b04\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-link-hints/settings.js\":\"a0b4d9148b9881c0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-normal-mode/actions.js\":\"a4a5ab3b388e519e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-normal-mode/index.js\":\"b1ffa1f230db1dce\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-normal-mode/interactions.js\":\"42d0e9cd72fbe3fb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/workspace-header/index.js\":\"a4f38de8848fdb18\",\"/knowledge-medium/pr-preview/pr-1895/src/registerServiceWorker.js\":\"799d10679ba0a96c\",\"/knowledge-medium/pr-preview/pr-1895/src/requestPersistentStorage.js\":\"ae7a8a723f2b41b5\",\"/knowledge-medium/pr-preview/pr-1895/src/services/authRequestDeadline.js\":\"df67e0a795cb34cc\",\"/knowledge-medium/pr-preview/pr-1895/src/services/authStorage.js\":\"49fd6363d0dc4b44\",\"/knowledge-medium/pr-preview/pr-1895/src/services/powersync.js\":\"43139390eca849e2\",\"/knowledge-medium/pr-preview/pr-1895/src/services/supabase.js\":\"60adb154a4f1ddb7\",\"/knowledge-medium/pr-preview/pr-1895/src/services/uploadErrorClassifier.js\":\"66bb7cfab93529d5\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/ActiveContexts.js\":\"553faff227fdbdb3\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/HotkeyReconciler.js\":\"212e24ecf449620e\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/WipeLocalDataDialog.js\":\"d12858a114a2a96a\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/actionDispatch.js\":\"5961be2274a55acb\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/actionRefItems.js\":\"f71d6099af6d4077\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/applyKeybindingOverrides.js\":\"9ffc3ffc2738a7e3\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/blockActions.js\":\"6cbda80cd6ac0b1a\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/blockMergeGesture.js\":\"8164a890a82439ba\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/canonicalizeChord.js\":\"b726811d6bf77031\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/defaultContexts.js\":\"d1699e66f3c576b9\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/defaultShortcuts.js\":\"87585f371d078243\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/effectiveActions.js\":\"d0771fc567cbcffa\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/gestureAction.js\":\"bca8e62e566aba3d\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/gestureBinding.js\":\"501787807a017734\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/holdRegistry.js\":\"427827d93a6a8f0d\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/keybindingConflicts.js\":\"536fb0ce505a1c31\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/keybindingOverrides.js\":\"dc8847eb1deb9418\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/pointerAction.js\":\"5cc1abca085dca41\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/resolve.js\":\"449a6347868cbbca\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/runAction.js\":\"f1b7e51bb38bc840\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/sequenceMatcher.js\":\"765b017c4da43201\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/types.js\":\"480b567b7a0568d8\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/useActionContext.js\":\"a23ce5557b41a72e\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/useActionDiscovery.js\":\"03f8dacc2be2bf2f\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/utils.js\":\"83b2543f50fbf394\",\"/knowledge-medium/pr-preview/pr-1895/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1895/src/sw/bootStore.js\":\"49ed8318a60845c6\",\"/knowledge-medium/pr-preview/pr-1895/src/sw/previewDatabases.js\":\"3a0282a6bafcb9ec\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/byteTransform.js\":\"2d11d6be34ae24b5\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/attachmentCleaner.js\":\"74302dc018e1b89b\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/bundle/attachmentParts.js\":\"3ec10bd48564eb6c\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/bundle/bundleParts.js\":\"49a346d508c55c84\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/bundle/bundleRecord.js\":\"7690cb599079712d\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/bundle/manifest.js\":\"9328f5e7a2a8a1d0\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/bundle/takeBundle.js\":\"d0a01a8dd7f2c540\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/bundle/verifyBundle.js\":\"a356a66f3220ca15\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/cleaningStage.js\":\"693b24950ec7e152\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/conversionKey.js\":\"1d672926c1584e9e\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/conversionServer.js\":\"3f8635e003fe6339\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/flip.js\":\"16a475fd1258e8d8\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/flipAttempts.js\":\"e9b3e6396084a37a\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/pages.js\":\"e697e9a24197439d\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/preflight.js\":\"71ea8269ef64697c\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/reseal.js\":\"0cb40accf56a9361\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/runConversion.js\":\"7c350460af5b081c\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/runLock.js\":\"1bc2fb19c3bccf9f\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/sealing.js\":\"43b5f1953a95a151\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/sealingStage.js\":\"24c23dc40c7a145c\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/stage.js\":\"1e14872258191152\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/verifyReseal.js\":\"fb7fe44bb220b87e\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/aad.js\":\"0dfa03a06ba90396\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/aead.js\":\"dc692cda01b74a84\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/base32.js\":\"0cd4744602bfa913\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/base64url.js\":\"34ba90e60ad2b6a7\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/binaryEnvelope.js\":\"cda38efe039977ab\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/byteAead.js\":\"b3bb3c15990676b1\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/canary.js\":\"fa04284bfe7191a0\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/contentHash.js\":\"a1795fce0c6ec274\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/contentKey.js\":\"0298aae11c6dea15\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/derivedIdNamespace.js\":\"1e9865f640ab1fa7\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/envelope.js\":\"a3b1c5bb7a2c8776\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/hex.js\":\"fd0e5eabb69291c8\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/sha256Hex.js\":\"7beb9574f21eaf82\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/workspaceKey.js\":\"de69c58b32ffcd55\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/conversionState.js\":\"f27c66e6cfa54e78\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a3cfc759d1fcffb4\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/flows/pastedKey.js\":\"d2463b4d09bd46cf\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"0d36249cbced09d3\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/flows/upgradeWorkspacePin.js\":\"6d9e2361af421353\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/keyStore.js\":\"8b5fc853048f97fc\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/mintWorkspaceKey.js\":\"e7e5410ac08789ee\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/modePin.js\":\"c9399b5602f74b3b\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/openWorkspaceKeys.js\":\"47dc4d2ce25a5be3\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/resolveWorkspaceEntry.js\":\"7d74b3b5a4f75969\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/resolver.js\":\"b11ed2daa6acee38\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/workspaceAccess.js\":\"0a06017be6411a48\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/transform.js\":\"caf17c767b1f5e4c\",\"/knowledge-medium/pr-preview/pr-1895/src/themeBootDefaults.js\":\"e90b89e2656bd920\",\"/knowledge-medium/pr-preview/pr-1895/src/types.js\":\"2d43c2ea0afb21a1\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/ClientLocalSettings.js\":\"b3f761cfd576ada2\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/abortableSleep.js\":\"8a57ea677cac8356\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/array.js\":\"0a866e8d4da11803\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/backlinkAutocomplete.js\":\"720c9b229e4754b3\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/blockCrumbs.js\":\"884082cdf6af06eb\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/blockrefAutocomplete.js\":\"91942d843a756d2d\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/cadencedIdleJob.js\":\"aa76846a81a261bd\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/callbackSet.js\":\"bdd798b5634416a4\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/clientId.js\":\"470a764e07406af8\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/codemirror.js\":\"87e5cdb56a5475c0\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/codemirrorCompletion.js\":\"3aabea4efc80627f\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/copy.js\":\"564cf92f5a7fedce\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/dailyPage.js\":\"b2103299c6a49548\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/dbForensics.js\":\"7ed340e326a7c2c4\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/dbForensicsHooks.js\":\"517e7af2a1c6f979\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/deleteBlockThroughUi.js\":\"8e39d23d631831e3\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/dialogs.js\":\"99b5582d1485d96a\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/dom.js\":\"4e508d498b635d87\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/downloadBlob.js\":\"8bf60c78ae2b7fcc\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/drawnWalk.js\":\"d1e1d16d3322b573\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/exportSqliteDb.js\":\"53b2c0181b3611fa\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/fileSystemAccess.js\":\"0d9c990a02d3154d\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/flipSlide.js\":\"a2558584488d3a9f\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/fnv1a.js\":\"6fe59a51e1ffd220\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/formatBytes.js\":\"e7786abb80372daf\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/fuzzyRank.js\":\"df77d395e9de9d3c\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/idbKeyedStore.js\":\"2965389f4110bd12\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/idleCallbackPolyfill.js\":\"071543d9383be54e\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/keyboardAwareScroll.js\":\"f61b498ac068dd13\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/keyboardViewport.js\":\"bdc8f898894fdb06\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/lastWorkspace.js\":\"f110428ce3b999eb\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/layoutColumns.js\":\"6253801c856249d6\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/layoutSessionDom.js\":\"586f925bd56c0a2b\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/layoutSessionId.js\":\"6363e0e8a0c53bf4\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/linkClickGestures.js\":\"9f6da9c8c39ba051\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/linkTargetAutocomplete.js\":\"1b7e1ff8243540b2\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/localDbCorruption.js\":\"efb66ae77c1b1e2a\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/localDbRecovery.js\":\"5599d994829bce98\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/markdownParser.js\":\"7ecfc939786e33bd\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/memoize.js\":\"443c36e18ac9cb8a\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/nameFieldCommit.js\":\"58feae13355aecb5\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/nameList.js\":\"6cff30e46a83a2db\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/navigation.js\":\"0a91cdcc0330eb42\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/omnilinerNamespace.js\":\"97c8a34c5930516f\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/opfsPageScan.js\":\"e544497305438b4c\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/panelClearance.js\":\"63a02c77d8d7dd1d\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/panelHistory.js\":\"5e35eaaab53d8487\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/panelLanes.js\":\"ef614aa6b7d01d43\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/panelLayoutProjection.js\":\"7a3df955c6d34539\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/panelScrollAnchor.js\":\"d79a6bc29ff66625\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/panelUrlFlags.js\":\"2003ab6cfdd06757\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/platform.js\":\"b480b4a11d636820\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/pluralize.js\":\"c49dbbc7e0fe1939\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/propertyCreation.js\":\"e18b2702cc627e79\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/propertyNavigation.js\":\"32075bfab97ca6e6\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/propertyValueContext.js\":\"029fa26a991fb488\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/react.js\":\"b6434f1be799e308\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/relativeDate.js\":\"ede900136c07e3dc\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/relativeTime.js\":\"d836b9bfeee9d3ac\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/renderScope.js\":\"8b021c9f3852841f\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/resolvedThenable.js\":\"7423bb36b58b3307\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/routing.js\":\"5a5d0f9fa49f1789\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/safeMode.js\":\"76e3406b91013427\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/scheduleIdle.js\":\"c11dd6895bd989ca\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/screenWakeLock.js\":\"4d5da5ad09b1bb8b\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/selection.js\":\"b4de175ca5703460\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/softKeyboardGrab.js\":\"5224bc581f1db2dc\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/startupTimeline.js\":\"de5f9e16c554bd18\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/state.js\":\"b093e348190b4689\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/string.js\":\"236349b0d3fab242\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/surfaceZoom.js\":\"0f2023f914da7529\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/time.js\":\"35de531c74cbc175\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/toast.js\":\"fea5e2042adeb6ca\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/toggleStore.js\":\"86c2265b711c416c\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/untilStopped.js\":\"2b10b079307916ea\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/userActivity.js\":\"43550649f1349fe3\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/viewTransition.js\":\"8561623d6e2ac5c4\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/viewport.js\":\"de523654c831c594\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/webLock.js\":\"dc1578e9bcf232a0\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/workspaceRecovery.js\":\"7903f145bda6a517\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/workspaceSnapshotStore.js\":\"f54ffb649a9a5594\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-compiler-runtime.js\":\"5869c2501d820aa4\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom-client.js\":\"e51bccf553ce9989\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom-server-edge.js\":\"777517c2445f5ab6\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom-server.js\":\"365333be81be9b67\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom-static-edge.js\":\"8f694f5ace593c55\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom-static.js\":\"c6e2c7fabc200667\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom-test-utils.js\":\"b534f9cba2390b5c\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom.js\":\"070eec40ed1c7ab8\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-jsx-runtime.js\":\"330950e06906c171\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react.js\":\"42ea779a4b9935e5\",\"/knowledge-medium/pr-preview/pr-1895/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1895/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1895/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
