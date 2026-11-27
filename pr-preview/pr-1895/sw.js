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
		buildId: "09f03a519fea-852df06c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1895/\":\"de1094d3bbf95e3c\",\"/knowledge-medium/pr-preview/pr-1895/index.html\":\"de1094d3bbf95e3c\",\"/knowledge-medium/pr-preview/pr-1895/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1895/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1895/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1895/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1895/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1895/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1895/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1895/assets/FacadeVFS-CkDErkpm.js\":\"920c752217ca9df9\",\"/knowledge-medium/pr-preview/pr-1895/assets/OPFSCoopSyncVFS-BYEadKzh.js\":\"eaae844181b8e6d7\",\"/knowledge-medium/pr-preview/pr-1895/assets/OPFSWriteAheadVFS-Bx1LYtjR.js\":\"1745bae5bf8491bf\",\"/knowledge-medium/pr-preview/pr-1895/assets/wa-sqlite-41hQ4G9v.js\":\"2cf2e428b7582773\",\"/knowledge-medium/pr-preview/pr-1895/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1895/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1895/assets/wa-sqlite-async-Dik5pMSh.js\":\"b8cd21429f7435bf\",\"/knowledge-medium/pr-preview/pr-1895/assets/worker-C21P2oTa.js\":\"262480cd05a6ccf2\",\"/knowledge-medium/pr-preview/pr-1895/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1895/chunks/app-CbHQZzD4.js\":\"41fa4634df1c221e\",\"/knowledge-medium/pr-preview/pr-1895/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1895/index.js\":\"7ed6a3d25aa25c03\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1895/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1895/assets/AccessHandlePoolVFS-B-3WBZuf.js\":\"ac73994915f6d564\",\"/knowledge-medium/pr-preview/pr-1895/assets/IDBBatchAtomicVFS-Cy7JMYVL.js\":\"1322173988c179ea\",\"/knowledge-medium/pr-preview/pr-1895/assets/MemoryVFS-CFhtKAno.js\":\"7b239c525171bcd3\",\"/knowledge-medium/pr-preview/pr-1895/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1895/assets/mc-wa-sqlite-CvYFI0Rk.js\":\"7d322952460f354b\",\"/knowledge-medium/pr-preview/pr-1895/assets/mc-wa-sqlite-async-C0DwHNtk.js\":\"933c7e234578531f\",\"/knowledge-medium/pr-preview/pr-1895/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1895/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1895/chunks/AccessHandlePoolVFS-BSioMBfd.js\":\"24112e33d0404934\",\"/knowledge-medium/pr-preview/pr-1895/chunks/FacadeVFS-CaBhrluf.js\":\"a6d1052ee00d8e50\",\"/knowledge-medium/pr-preview/pr-1895/chunks/IDBBatchAtomicVFS-DN-YGnTY.js\":\"6d6593326e66eb53\",\"/knowledge-medium/pr-preview/pr-1895/chunks/MemoryVFS-tmxLlBpk.js\":\"aa3d6026055b57a3\",\"/knowledge-medium/pr-preview/pr-1895/chunks/OPFSCoopSyncVFS-BP7MWlS2.js\":\"4e2747207ae71b0c\",\"/knowledge-medium/pr-preview/pr-1895/chunks/OPFSWriteAheadVFS-BGfVMEsv.js\":\"39be7dacf40cbeb2\",\"/knowledge-medium/pr-preview/pr-1895/chunks/Preview-BEoe_PZT.js\":\"f0113c20a9630036\",\"/knowledge-medium/pr-preview/pr-1895/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1895/chunks/card-C7juSh_9.js\":\"707beb2ea482dd6e\",\"/knowledge-medium/pr-preview/pr-1895/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1895/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1895/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1895/chunks/dist-D4AT-p-L.js\":\"b6ac27caf72f5abd\",\"/knowledge-medium/pr-preview/pr-1895/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1895/chunks/mc-wa-sqlite-DJt4TTo3.js\":\"a68dd2476ff66194\",\"/knowledge-medium/pr-preview/pr-1895/chunks/mc-wa-sqlite-async-KbLThc4N.js\":\"7ab52ac2dcf84be5\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-7SMRz_Dd.js\":\"1fa7b1498148f0c9\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-B5cVoNqq.js\":\"e8417ab11b21cf72\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-B7cbi1J5.js\":\"85e3d8d2eb22ef42\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-BLprtQMX.js\":\"55e22a3c4445a9f1\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-CAX0HvqI.js\":\"d4396e7826f54483\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-CzmGZVyR.js\":\"e65a7b2e358dbece\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-DW1JBMF5.js\":\"1d17b4ca56c7625a\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-DddWOpWa.js\":\"6b3be711ef70974c\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-dom-server-legacy.browser.production-Bpb-FTDu.js\":\"7b6625f233db784d\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-dom-server.browser.production-CfxguWur.js\":\"1c6cee0faef3f600\",\"/knowledge-medium/pr-preview/pr-1895/chunks/react-dom-server.edge.production-Damduzq-.js\":\"5d854e01f5d05dec\",\"/knowledge-medium/pr-preview/pr-1895/chunks/server.browser-EkasJcYB.js\":\"c36a8e086d8724d7\",\"/knowledge-medium/pr-preview/pr-1895/chunks/textarea-Di7Icv8t.js\":\"a4129971adfc821d\",\"/knowledge-medium/pr-preview/pr-1895/chunks/ui-BzwVGumM.js\":\"f270b7bb0c7fe6b7\",\"/knowledge-medium/pr-preview/pr-1895/chunks/wa-sqlite-BKjl2QAH.js\":\"06381542d78b0247\",\"/knowledge-medium/pr-preview/pr-1895/chunks/wa-sqlite-async-Dv8h8kGv.js\":\"a4ef8057d0fc74b5\",\"/knowledge-medium/pr-preview/pr-1895/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1895/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1895/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1895/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1895/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1895/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1895/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1895/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1895/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1895/src/App.js\":\"9d38ebf4e8b477b2\",\"/knowledge-medium/pr-preview/pr-1895/src/appUpdate.js\":\"74731947d1711c69\",\"/knowledge-medium/pr-preview/pr-1895/src/appVersion.js\":\"d6e22ef704fa3e4b\",\"/knowledge-medium/pr-preview/pr-1895/src/bootstrap/initialLayout.js\":\"048a30ee2f64d1a1\",\"/knowledge-medium/pr-preview/pr-1895/src/bootstrap/openWorkspaceData.js\":\"ce34ce4281416612\",\"/knowledge-medium/pr-preview/pr-1895/src/bootstrap/resolveWorkspace.js\":\"3aeea267a7c29a23\",\"/knowledge-medium/pr-preview/pr-1895/src/bootstrap/workspaceBootstrap.js\":\"bf52824e498e7c27\",\"/knowledge-medium/pr-preview/pr-1895/src/components/BlockComponent.js\":\"59ab687fa0c0f7fb\",\"/knowledge-medium/pr-preview/pr-1895/src/components/BlockCrumbs.js\":\"2299b7299091c9c2\",\"/knowledge-medium/pr-preview/pr-1895/src/components/BlockEditor.js\":\"da8e6f213ae220e1\",\"/knowledge-medium/pr-preview/pr-1895/src/components/BlockLoadingPlaceholder.js\":\"161bca05102f2338\",\"/knowledge-medium/pr-preview/pr-1895/src/components/BlockProperties.js\":\"87aabf81c3a36875\",\"/knowledge-medium/pr-preview/pr-1895/src/components/BlockSearchPicker.js\":\"7a331ebed114174d\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ConfirmBulkDeleteDialog.js\":\"866d8f7e7d562468\",\"/knowledge-medium/pr-preview/pr-1895/src/components/DividerHandle.js\":\"76db50e251b60a06\",\"/knowledge-medium/pr-preview/pr-1895/src/components/DraftEditor.js\":\"8757b83ce34cf194\",\"/knowledge-medium/pr-preview/pr-1895/src/components/GutterPill.js\":\"4de02b20fdc3c631\",\"/knowledge-medium/pr-preview/pr-1895/src/components/Header.js\":\"c8800f094d79a0c3\",\"/knowledge-medium/pr-preview/pr-1895/src/components/LazyBlockComponent.js\":\"b9bc6c957e4bc19e\",\"/knowledge-medium/pr-preview/pr-1895/src/components/Login.js\":\"9f8b932aaa09a4d9\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ZoomableSurface.js\":\"987df7fda8aae8c6\",\"/knowledge-medium/pr-preview/pr-1895/src/components/editModeKeepalive.js\":\"45d3509878cb6050\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyDisplay/PropertyDisplayScope.js\":\"28cdf8302722736f\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"1a39f83732d8e4c1\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/RefPropertyEditor.js\":\"989b49ca1a568d88\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/RefTargetTypePicker.js\":\"a7ea03ef4fe96cfd\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/SelectPropertyEditor.js\":\"ae84d3d482988621\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/TypesPropertyEditor.js\":\"6f422826135059b7\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/defaults.js\":\"1df5061048293b13\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/kernelValuePresets.js\":\"6a6e00f1243dc879\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/selectablePresets.js\":\"0a06cc9c1bfb5d4a\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyEditors/typesPropertyUi.js\":\"9c0d8adc0d0e07e0\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/AddPropertyForm.js\":\"5cc9e1557d62aff2\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/PropertyPicker.js\":\"f9aaf7c17d346fdd\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/PropertyRow.js\":\"b8f3016cc39e4fbf\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/Rows.js\":\"c13a5b40c118bee8\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/actions.js\":\"80a67405fbf2e072\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/declarationOnly.js\":\"fa02cc982c637676\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/layout.js\":\"2f582d7744a32f27\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/model.js\":\"35f42161aeb5b278\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/shapeUi.js\":\"cba4ee0653327e02\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/shapes.js\":\"f2bfd87989af6f49\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/usePropertyEditingActivation.js\":\"327c04c26f5198be\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanel/visibility.js\":\"ed35ec1d558f178e\",\"/knowledge-medium/pr-preview/pr-1895/src/components/propertyPanelSections.js\":\"1773e2d3940b93b5\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/BlockEmbed.js\":\"257a591eddf315bf\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/BlockLink.js\":\"3910f5f595ebc049\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/BlockRef.js\":\"9a4abc1c6b4e3e02\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/CompactReferenceLink.js\":\"bf581fc15c8c4e5f\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/ReferenceLink.js\":\"50d8d096fa7064a9\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/cycleGuard.js\":\"9a24d625eff45607\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/cycleGuardContext.js\":\"05cef8f55e1568cf\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/linkInteraction.js\":\"f4d5feca45d060a2\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/referenceLayout.js\":\"9869b2d0e5098baf\",\"/knowledge-medium/pr-preview/pr-1895/src/components/references/useBlockRefAncestors.js\":\"0823e6beab39ed7d\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/BlockGutter.js\":\"090c25a50fa3de97\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/BlockInfoDialog.js\":\"8916e35c661a4640\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/BlockReadText.js\":\"4023cf2b4a2c1d4e\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/BlockTypeBlockRenderer.js\":\"17c17e620c34cb2d\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/BulletHoverCard.js\":\"55369f1084e26ff4\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/CodeMirrorContentRenderer.js\":\"692f8b40579589e9\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"96fa7d652f0d8d82\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/ColumnResizeHandles.js\":\"059dd506dcd21a4f\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"969685dc59f9a7d5\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/DefaultBlockRenderer.js\":\"8224a7c302617a7e\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/LayoutRenderer.js\":\"e2467041664fc885\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/MarkdownContentRenderer.js\":\"821e7755f0468ccd\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/MissingDataRenderer.js\":\"11318a89caaaf962\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/PanelRenderer.js\":\"87ddee840b7b97fc\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/PropertySchemaBlockRenderer.js\":\"95d65e20782f796f\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/TopLevelRenderer.js\":\"aac9ab27c81321a5\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/blockGutterMode.js\":\"2917d50c44686a42\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/blockTitleText.js\":\"5dcffb119407d294\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/fieldCreationKeydown.js\":\"f8f4cabbddad309e\",\"/knowledge-medium/pr-preview/pr-1895/src/components/renderer/layoutRootContext.js\":\"58f7335da5869230\",\"/knowledge-medium/pr-preview/pr-1895/src/components/typeChip/TypeChip.js\":\"010301b4b12d23f4\",\"/knowledge-medium/pr-preview/pr-1895/src/components/typeChip/chipStyle.js\":\"0f4cbae17744295b\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/anchored-floating.js\":\"bc8354759f5c887d\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/button.js\":\"e6bd4c5bd13a7d61\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/card.js\":\"0fc88853c555da1b\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/checkbox.js\":\"815b780415375d8d\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/collapsible.js\":\"50319a90680f8d96\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/command.js\":\"d215584714117b1d\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/context-menu.js\":\"f13091400db33398\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/dialog.js\":\"a287c7b9e95e53ef\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/dropdown-menu.js\":\"0e0b68c8417a9496\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/floating-listbox.js\":\"84a863f8179bd2dd\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/index.js\":\"6f748ba5c230f284\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/input.js\":\"10b3cfbb3f36f51a\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/kbd.js\":\"ca287032e0b4249f\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/label.js\":\"1a6f5b4fa1fba722\",\"/knowledge-medium/pr-preview/pr-1895/src/components/ui/textarea.js\":\"24e4439b460f6707\",\"/knowledge-medium/pr-preview/pr-1895/src/components/useEditModeYieldKeepalive.js\":\"a28789a842520f5d\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/BootFallback.js\":\"9c9e07f59bf153ad\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/FocusedRowLazyMount.js\":\"920e50fce91100f9\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/LazyViewportMount.js\":\"f2a8b21c78ae42e6\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/LocalDbCorruptionFallback.js\":\"c43d7daba392fbe0\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/error.js\":\"d1f5ab339ed71821\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/lazyMountRegistry.js\":\"36ff385e86aff62d\",\"/knowledge-medium/pr-preview/pr-1895/src/components/util/suspense.js\":\"b8e23bcaf89d6f1b\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/CreateWorkspaceDialog.js\":\"ad6e26a59fcf74e7\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/PendingInvitations.js\":\"92a00b20d9652bd5\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/SyncProgress.js\":\"a2f8166cf554b6cd\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/UnlockProgress.js\":\"38c79bfeca9b1987\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/WorkspaceKeyGate.js\":\"8d8b476037450bf1\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/WorkspaceSettingsDialog.js\":\"57b99c9ea70de34b\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/WorkspaceSwitcher.js\":\"ad07fdc8b648a32c\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/WorkspaceSyncGate.js\":\"10455b4cc29c522b\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/ConversionFlow.js\":\"2fb4d687c6003a61\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/ConversionFlowHost.js\":\"0b2fc36ef65a87ee\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/EncryptionSection.js\":\"d9e7afc037033c20\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/attachmentPrompts.js\":\"dd40d20040d5ea5a\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9e687ec94072d397\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/conversionFlowDeps.js\":\"ea8da903d5d6e3bc\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/conversionFlowStore.js\":\"3bb503716b3acfc5\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/flowUi.js\":\"b171d25e4cc22cbc\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/conversion/useConversionRun.js\":\"20a7bc5649b73d19\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/keyUi.js\":\"e294763936a467e6\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/useCloseOnKeyLoss.js\":\"6fcb750144fc8151\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/useCloseOnServerE2ee.js\":\"50adea12edf75b18\",\"/knowledge-medium/pr-preview/pr-1895/src/components/workspace/workspaceUnlocked.js\":\"1f4386b62d3d19e4\",\"/knowledge-medium/pr-preview/pr-1895/src/context/backgroundSubtree.js\":\"14e9ec97e620e0b3\",\"/knowledge-medium/pr-preview/pr-1895/src/context/block.js\":\"43d1143575a52da9\",\"/knowledge-medium/pr-preview/pr-1895/src/context/layoutWsContext.js\":\"426eec236d976262\",\"/knowledge-medium/pr-preview/pr-1895/src/context/propertyDisplay.js\":\"8e21ebd461f576e5\",\"/knowledge-medium/pr-preview/pr-1895/src/context/repo.js\":\"f15af652ac881a7a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/aliasClaim.js\":\"c6939cb90b28ba2f\",\"/knowledge-medium/pr-preview/pr-1895/src/data/aliasSeatNamespace.js\":\"d3d6a4b51cdcc844\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/blockData.js\":\"c83d25fb0b0f2236\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/blockType.js\":\"83220836d44b7a9a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/changeScope.js\":\"16ad006d4ee251d2\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/codecs.js\":\"0c1b07ae846e1334\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/derivedData.js\":\"02922cc1a5bae899\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/errors.js\":\"39c9d3945a057476\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/events.js\":\"354e8f699a476139\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/handle.js\":\"de1263102e691e81\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/index.js\":\"ca5b3672ed1a2da2\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/mutator.js\":\"7a63e8f986d5bf95\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/processor.js\":\"078b05bf176c1ca7\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/propertySchema.js\":\"a7a7adaba8c84084\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/query.js\":\"adde6b3d4f934a43\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/sameTxProcessor.js\":\"d034286fea365c54\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/schema.js\":\"de1263102e691e81\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/tx.js\":\"de1263102e691e81\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/typedBlockQuery.js\":\"a306b0476c25cca3\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/user.js\":\"d17651e23f6dbb6c\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/valuePresetCore.js\":\"8811d040b01a7533\",\"/knowledge-medium/pr-preview/pr-1895/src/data/api/valuePresets.js\":\"83473036316f9086\",\"/knowledge-medium/pr-preview/pr-1895/src/data/attachmentCleanerIOVerb.js\":\"2dbc58e6d5e3e1e8\",\"/knowledge-medium/pr-preview/pr-1895/src/data/block.js\":\"32d5b6a40c9cbe14\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockCache.js\":\"cfb1fe7a8e663c7f\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockId.js\":\"0ee7076ad358ed06\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockLiveness.js\":\"0052415a6eb47640\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockMerge.js\":\"63828faae9d58386\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockSchema.js\":\"9901ada4537c48c9\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockTypeLookup.js\":\"9020625ba55ce576\",\"/knowledge-medium/pr-preview/pr-1895/src/data/blockTypes.js\":\"d9918641dd355471\",\"/knowledge-medium/pr-preview/pr-1895/src/data/childrenView.js\":\"0e86f643eeb195e2\",\"/knowledge-medium/pr-preview/pr-1895/src/data/clientContext.js\":\"9a22430c13b77bc1\",\"/knowledge-medium/pr-preview/pr-1895/src/data/dbFileSiblings.js\":\"34a45efd7730193a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/definitionSeeds.js\":\"53439a1a550d54bc\",\"/knowledge-medium/pr-preview/pr-1895/src/data/derivedIds.js\":\"972f3092d6d60be0\",\"/knowledge-medium/pr-preview/pr-1895/src/data/drawnSubtree.js\":\"94bdd2a6ea05603f\",\"/knowledge-medium/pr-preview/pr-1895/src/data/facetBridge.js\":\"7e6db7035488f80f\",\"/knowledge-medium/pr-preview/pr-1895/src/data/facets.js\":\"87916e80c86bd72c\",\"/knowledge-medium/pr-preview/pr-1895/src/data/globalState.js\":\"8675c45d5f679ec6\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/aliasClaimRederiveProcessor.js\":\"151fb408a985fabf\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/ancestorBatch.js\":\"0cb112b9623e4e28\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/blockTypeTypeifyProcessor.js\":\"831a5b89c232886b\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/clientSchema.js\":\"afdcfb832c9285a8\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/commitPipeline.js\":\"81c443fd10800b8c\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/devAssertions.js\":\"60ebcae0efb9a12e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/firstSync.js\":\"1d6561c667a446af\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/freshInitialLoad.js\":\"3462dc07555245a6\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/graphBackfillClaim.js\":\"8388a65a72b9be4f\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/handleStore.js\":\"ac869ed8bd40e0db\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/idleMarkerJobs.js\":\"3665c86a668c3adf\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/initialDownload.js\":\"b010cce707582dcc\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/initializeClientDatabase.js\":\"85ea1e321a4ba853\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/jsonCanonical.js\":\"0ff661f3f10874c6\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/kernelInvalidation.js\":\"25737c79e339830b\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/kernelProcessors.js\":\"f99e4d5fb050fc7e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/kernelQueries.js\":\"3691c7bec452cc6c\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/mergeTypeMembershipProcessor.js\":\"e258fbb55ba0aa59\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/normalizeReferencesProcessor.js\":\"6d2d4fc88e479d72\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/poolInstrumentation.js\":\"d72e9702b2747aa2\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/processorRunner.js\":\"7df252f355ff13ef\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyCellBackfill.js\":\"87417faff31867eb\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyChildMint.js\":\"3b89c0e8fd9b3eb8\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyChildrenProcessor.js\":\"217eb362416f8727\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyDefinitionChangeProcessor.js\":\"632ebc90aea588a3\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyDefinitionSynthesis.js\":\"34cbbf751944350e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyKeyScan.js\":\"8a6b1971691f6440\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertySchemaResolution.js\":\"9f2b356c505c467a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/propertyValueEdits.js\":\"5bbb963404ce86c5\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/raiseProtocol.js\":\"d6d317678b393787\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/readBatch.js\":\"7d6abe4137d1bdc1\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/refProjection.js\":\"31944e28c3ab467d\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/referenceTargetLookups.js\":\"e74a78c1e9a8b315\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/referenceTargetProcessor.js\":\"937807a3cfda48fd\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/replayMerge.js\":\"0bb6bf83df9ebf0b\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/sqlBinds.js\":\"2b425645a1e2b64f\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0602831d597d7fd5\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/syncObserver/arrivalProcessors.js\":\"7b5c9eef3fd9bc07\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/syncObserver/invalidate.js\":\"d45377a4be63e0f9\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/syncObserver/materialize.js\":\"3bc40d8b7acd7a36\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/syncObserver/observer.js\":\"4c3aa32b6c011b6a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/syncObserver/reconcile.js\":\"de4b278d581e20e4\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/timingMetrics.js\":\"dd3f0bbdd436c2a8\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/treeQueries.js\":\"a244683b90fd71ab\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/txEngine.js\":\"230a76ac8ba5f6fd\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/txSnapshots.js\":\"3c9175e6fc5f1496\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/typedBlockQuery.js\":\"f203dd20c5288ee3\",\"/knowledge-medium/pr-preview/pr-1895/src/data/internals/undoManager.js\":\"0d509c47c3ede249\",\"/knowledge-medium/pr-preview/pr-1895/src/data/invalidation.js\":\"a6ffb91146d746c9\",\"/knowledge-medium/pr-preview/pr-1895/src/data/kernelDataExtension.js\":\"59792a7b1bf9cc9e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/kernelPage.js\":\"faa9073a22b4f9da\",\"/knowledge-medium/pr-preview/pr-1895/src/data/kernelValuePresetCores.js\":\"9f5e7761a511fcb6\",\"/knowledge-medium/pr-preview/pr-1895/src/data/localDbCorruptionSignal.js\":\"c5e5ef707ac8f778\",\"/knowledge-medium/pr-preview/pr-1895/src/data/localDbStorage.js\":\"9300629e701522a3\",\"/knowledge-medium/pr-preview/pr-1895/src/data/localDbVfs.js\":\"820f8410da92f785\",\"/knowledge-medium/pr-preview/pr-1895/src/data/localSchema.js\":\"9673efb5e418579e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/maintenance.js\":\"6a7c1fe2f873e893\",\"/knowledge-medium/pr-preview/pr-1895/src/data/mergeProperties.js\":\"c751d170daf13107\",\"/knowledge-medium/pr-preview/pr-1895/src/data/metricsConsoleHook.js\":\"577b57e704d29e02\",\"/knowledge-medium/pr-preview/pr-1895/src/data/migrationsPage.js\":\"833acb6f140a8312\",\"/knowledge-medium/pr-preview/pr-1895/src/data/mutators.js\":\"6c794eb16fe11974\",\"/knowledge-medium/pr-preview/pr-1895/src/data/orderKey.js\":\"a17231a93cb8f638\",\"/knowledge-medium/pr-preview/pr-1895/src/data/orderKeyPlacement.js\":\"121f663cb7884983\",\"/knowledge-medium/pr-preview/pr-1895/src/data/outlineSurface.js\":\"555a9c9dbd28f484\",\"/knowledge-medium/pr-preview/pr-1895/src/data/pendingEditorContent.js\":\"f76960f9fa36c410\",\"/knowledge-medium/pr-preview/pr-1895/src/data/pendingUploadsSql.js\":\"20b43be454ace9a2\",\"/knowledge-medium/pr-preview/pr-1895/src/data/pluginStateExtensions.js\":\"06d0b9b5b55621fa\",\"/knowledge-medium/pr-preview/pr-1895/src/data/powerSyncLogger.js\":\"3726260209a9aef4\",\"/knowledge-medium/pr-preview/pr-1895/src/data/projectorRuntime.js\":\"4780445b9eaec658\",\"/knowledge-medium/pr-preview/pr-1895/src/data/properties.js\":\"dbc20beed5ef7c2b\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertiesPage.js\":\"78f551cf2728d05b\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertyChildren.js\":\"359601904e40698c\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertyDefinitionFanout.js\":\"20f612b6d9e83f95\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertyDefinitionMetadata.js\":\"c5755fec843a455b\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertyDefinitionRegistry.js\":\"88687709b160be32\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertyDisplayMode.js\":\"513d9af8ad874c66\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertyRowCreation.js\":\"d2c99f6a7871376e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertySchemaCreation.js\":\"1cb0983640b8069e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/propertySeeds.js\":\"8f16e3041172a15e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/recentsPage.js\":\"6d66c27c989ed9e3\",\"/knowledge-medium/pr-preview/pr-1895/src/data/refTargetComparableProperty.js\":\"424cbce06fd52616\",\"/knowledge-medium/pr-preview/pr-1895/src/data/referenceBlock.js\":\"9cb0a0ebdc653a6c\",\"/knowledge-medium/pr-preview/pr-1895/src/data/rejectedUploads.js\":\"024bcd4603764ede\",\"/knowledge-medium/pr-preview/pr-1895/src/data/releasePowerSyncConnection.js\":\"1066f67b09e0c2e9\",\"/knowledge-medium/pr-preview/pr-1895/src/data/repo.js\":\"4f210dc582699f70\",\"/knowledge-medium/pr-preview/pr-1895/src/data/repoProvider.js\":\"d43ca6f48af99e0f\",\"/knowledge-medium/pr-preview/pr-1895/src/data/rowProperty.js\":\"5bdb04d628e17ba6\",\"/knowledge-medium/pr-preview/pr-1895/src/data/searchFilter.js\":\"3e370be942620993\",\"/knowledge-medium/pr-preview/pr-1895/src/data/seedIdentityLedger.js\":\"0c55a67485172904\",\"/knowledge-medium/pr-preview/pr-1895/src/data/stateBlocks.js\":\"d60b44faac4f32ef\",\"/knowledge-medium/pr-preview/pr-1895/src/data/structuralEditPolicy.js\":\"b78aaffff7fa4eea\",\"/knowledge-medium/pr-preview/pr-1895/src/data/structuralInsert.js\":\"588ba3748aa993ef\",\"/knowledge-medium/pr-preview/pr-1895/src/data/subtreeDelete.js\":\"9d8341adf9c90711\",\"/knowledge-medium/pr-preview/pr-1895/src/data/syncStreamLock.js\":\"ba4b077d2e8501af\",\"/knowledge-medium/pr-preview/pr-1895/src/data/syncedTableSqlRecognizer.js\":\"776c1b7ce2a0caa1\",\"/knowledge-medium/pr-preview/pr-1895/src/data/syncedTableWriteGuard.js\":\"87332bcb0c9fe9dc\",\"/knowledge-medium/pr-preview/pr-1895/src/data/targets.js\":\"d013733deb6087e4\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeColors.js\":\"3dc301259e2abb9d\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeDefinitionMetadata.js\":\"dd39fe2fa986779e\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeDefinitionRegistry.js\":\"aa837c97ab3f46c6\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeExtraction.js\":\"b68df3391ad2903d\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeInitialValues.js\":\"fc51d773eb54b8a5\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typePropertyGroups.js\":\"b8b078c663951e1d\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeSeeds.js\":\"bedb5ff661e5a91f\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typeTagger.js\":\"f955ac54ac7bef44\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typedRecords.js\":\"f9ad36dac9d7c6f4\",\"/knowledge-medium/pr-preview/pr-1895/src/data/typesPage.js\":\"0e0599e9b440f80b\",\"/knowledge-medium/pr-preview/pr-1895/src/data/userPrefs.js\":\"481b69fb5ede84c1\",\"/knowledge-medium/pr-preview/pr-1895/src/data/userSchemasService.js\":\"dfe73bc783c3673f\",\"/knowledge-medium/pr-preview/pr-1895/src/data/userTypesService.js\":\"e7039c14e3c4a4ad\",\"/knowledge-medium/pr-preview/pr-1895/src/data/valuePresetRegistry.js\":\"b112123d07fe5579\",\"/knowledge-medium/pr-preview/pr-1895/src/data/visibleChildren.js\":\"ca5235b9a91962b5\",\"/knowledge-medium/pr-preview/pr-1895/src/data/workspaceConversion.js\":\"098659a0b97f38f1\",\"/knowledge-medium/pr-preview/pr-1895/src/data/workspaceFirstSync.js\":\"b2dee6a4f923fe1d\",\"/knowledge-medium/pr-preview/pr-1895/src/data/workspaceIdNamespace.js\":\"db012d7f14e5ac9d\",\"/knowledge-medium/pr-preview/pr-1895/src/data/workspaceSchema.js\":\"002d294d8e82f51a\",\"/knowledge-medium/pr-preview/pr-1895/src/data/workspaces.js\":\"487358acf758c575\",\"/knowledge-medium/pr-preview/pr-1895/src/data/writeAheadLog.js\":\"eda5aa2aacfb7372\",\"/knowledge-medium/pr-preview/pr-1895/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/BlockPasteShellDecorator.js\":\"f48ca73f32a25d76\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/atTrigger.js\":\"9679213f3aad4e08\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/autocomplete.js\":\"aec9941508e188a8\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/codeMirrorExtensions.js\":\"71bd9f3bd9dca000\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/contentFlush.js\":\"dded3a3672b7adcc\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/defaultInteractions.js\":\"668010fcf0b613ae\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/editSettleSignal.js\":\"c2606d273b60bfaa\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/insertImage.js\":\"212c79fbd8a3a23a\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/referenceCompletionRange.js\":\"844785521cbb75c9\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/referenceTargetTypes.js\":\"998c2a749aeae1a7\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/syntaxContext.js\":\"768c52ffe6552de7\",\"/knowledge-medium/pr-preview/pr-1895/src/editor/triggerMatch.js\":\"4be7654638b7a6d1\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/AppRuntimeProvider.js\":\"3519d7210a81c6bb\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/BlockFocusShellDecorator.js\":\"ad1beac70c37058f\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/ExtensionRenderBoundary.js\":\"98d92d3aa13c83d1\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/PanelContentRecovery.js\":\"71c15b23eee34852\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/apiCatalog.js\":\"24e351061566aed0\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/approveExtensionHere.js\":\"74f8f7ea568b88e0\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/armedCutAppMount.js\":\"bacd89e6fdbf7f55\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/batchableKeyedStore.js\":\"96c47262d8d7c97f\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/blockInteraction.js\":\"fcfcccb2c2ddcbda\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/blockSelectionAction.js\":\"d5fc3f8546f21a18\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/compileExtensionModule.js\":\"f12f913c991c8107\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/compiledModuleCache.js\":\"3b5eb8ae88e54e69\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/continuousGestures.js\":\"581aaae57dcc1038\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/core.js\":\"d5b99388e7560508\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/defaultRenderers.js\":\"c1d38855f040f6eb\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/definitionFanoutAppMount.js\":\"057c8ce17ba1c7d7\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/dialogAppMount.js\":\"86287402dcff6839\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/dynamicExtensionSeeds.js\":\"db2583b5a7df6490\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/dynamicExtensions.js\":\"94d2a472ff83d009\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/exampleExtensions.js\":\"7db595aabd853ad3\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/extensionApprovalStatus.js\":\"1cb758936569813f\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/extensionLoadErrorToast.js\":\"abf0c7a66383b8a5\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/extensionLoadErrors.js\":\"ab06e551cbb9aa48\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/extensionLookup.js\":\"649d430d5a5d68f8\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/extensionToggles.js\":\"97f52a7a7d0060a4\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/extensionUtilitiesCss.js\":\"05e51119003aa8f0\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/kernelPageDeletionGuard.js\":\"0c38b196bcc87d1b\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/liveRuntime.js\":\"eea02a1917e1da3c\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/openExtensionsSettings.js\":\"2a6314296d4443a7\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/overridesCache.js\":\"c1619e022896a23c\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/pluginIds.js\":\"ef3657e7958d48e5\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/processorRejectionToast.js\":\"928cc9e7dbdc1cd4\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/runtimeActions.js\":\"36acf8aadfebcde5\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/runtimeContext.js\":\"35c0b5aa3c0ef26c\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/staticAppExtensions.js\":\"27919b334c8a5fe5\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/staticDataExtensions.js\":\"63e928ebcac492a1\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/toastAppMount.js\":\"4c9136d92119e3fb\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/useOverrides.js\":\"075e0a97cc59bfd4\",\"/knowledge-medium/pr-preview/pr-1895/src/extensions/useShortcutSurfaceActivations.js\":\"044a5275e8793d8a\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/discoverToggleTree.js\":\"005822d2ef32dcfc\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/facet.js\":\"f284dc22e9ac3c09\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/resolveAppRuntime.js\":\"a848ceb6fa80c742\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/runtimeEvents.js\":\"adb76aa6443b2861\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/togglable.js\":\"ba72e66e12370e46\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/variantFacet.js\":\"494b18025cfbe974\",\"/knowledge-medium/pr-preview/pr-1895/src/facets/verbFacet.js\":\"9dbbe672f732631e\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/block.js\":\"544e67dd9607d6e2\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/focusedChild.js\":\"e7e6d6e1786c01bb\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/propertySchemas.js\":\"8d4dc84069ac268b\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/typeRegistry.js\":\"db707fc46c0964c5\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useAncestorCrumbs.js\":\"78f2e98ce72a2a18\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useAutocompleteListbox.js\":\"371e3b562d90dc38\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useDebouncedSearch.js\":\"ecff07b8524857b4\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useDebouncedValue.js\":\"8134206b9a0d2cf7\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useFacetValue.js\":\"7dbb52655a8d221f\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useIsFocalRender.js\":\"18708b41416bb91b\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useIsReadOnly.js\":\"dec0dd154d611dd3\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useMaterializeBacklog.js\":\"c194a3e8bdddd3a9\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useMinuteClock.js\":\"551354f9ca4773be\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/usePanelLayoutProjection.js\":\"1fcb6a18e665cb74\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/usePendingInvitations.js\":\"b13598de0b297d25\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useRendererRegistry.js\":\"b8e6a5521843aec1\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useRetainedFieldRows.js\":\"d913bd182cb097e3\",\"/knowledge-medium/pr-preview/pr-1895/src/hooks/useWorkspaces.js\":\"106aac63debe57e1\",\"/knowledge-medium/pr-preview/pr-1895/src/lib/utils.js\":\"6b2df4f4cfea2654\",\"/knowledge-medium/pr-preview/pr-1895/src/main.js\":\"c53c73fdbd2ce7a3\",\"/knowledge-medium/pr-preview/pr-1895/src/markdown/MarkdownImage.js\":\"b3fb69053c054712\",\"/knowledge-medium/pr-preview/pr-1895/src/markdown/blockSeparators.js\":\"f98f15998bd30879\",\"/knowledge-medium/pr-preview/pr-1895/src/markdown/context.js\":\"0f6d22026bba037b\",\"/knowledge-medium/pr-preview/pr-1895/src/markdown/defaultMarkdownExtension.js\":\"20a65c38484055e7\",\"/knowledge-medium/pr-preview/pr-1895/src/markdown/extensions.js\":\"0f97cbe882e963d2\",\"/knowledge-medium/pr-preview/pr-1895/src/markdown/renderMarkdownHtml.js\":\"015cecf74c013643\",\"/knowledge-medium/pr-preview/pr-1895/src/minimal-editor.js\":\"6a53fdb19105c457\",\"/knowledge-medium/pr-preview/pr-1895/src/paste/armedCut.js\":\"8b38f6ab6dc998b6\",\"/knowledge-medium/pr-preview/pr-1895/src/paste/captureMediaVerb.js\":\"49de238d27312d5d\",\"/knowledge-medium/pr-preview/pr-1895/src/paste/clipboard.js\":\"031f8c792bf73c43\",\"/knowledge-medium/pr-preview/pr-1895/src/paste/decision.js\":\"7a35da6afe704b8d\",\"/knowledge-medium/pr-preview/pr-1895/src/paste/operations.js\":\"af42ba1bb28bd92e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/account-header/AccountHeaderItem.js\":\"4d1d4c1dd564a2a6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/account-header/index.js\":\"3e7d779c2b3f6559\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7a8b6c62e57afeb8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/askAgent.js\":\"0fe51e3eb915cfe8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/askedStore.js\":\"60008c2290d089f0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"65fb1049492ae1de\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/chipState.js\":\"4027f051a5384e8b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4d8cf0d632b9851a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/index.js\":\"c84ea4cd5e18f0bf\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"7e80c77e7a303dac\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-dispatch-companion/schema.js\":\"25b0315d847dc928\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/AgentTokensDialog.js\":\"2c8e61c31e475c41\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/BridgePairingDialog.js\":\"1b5ab7385b79f5eb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/addMedia.js\":\"2e55c91a513f0f92\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/backlinks.js\":\"bbb182b3fa039118\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/block.js\":\"6fe5f9b62360c91f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/context.js\":\"c8d604d22eb55277\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/displayIds.js\":\"67163192708d8cdf\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/index.js\":\"5dc6ed78d3b00e4d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/outline.js\":\"7ac273ad45863e63\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/properties.js\":\"270c2cd8130faaa6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/refs.js\":\"bbfa590c3476b4c4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"8297929de086cf9f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/search.js\":\"64c8412368c93084\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/shared.js\":\"bb87ce8849d0c73c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ce0aef342a7a2142\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentViews/text.js\":\"9a72ef62852956a6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/agentWrites.js\":\"5b3e3284c13ba6b0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/authoringCatalog.js\":\"badea2fad64a1b9c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/blockRefTargets.js\":\"a89470cbfcf04968\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/bridge.js\":\"d488099ef2729da0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/bridgeLoop.js\":\"0384f20697936aea\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/changeHistory.js\":\"6ab8d496544bb86c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/commands.js\":\"a3ec9b87827bf849\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/commentsCommands.js\":\"2f01b3a01cd8a415\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/dataExtension.js\":\"65e1d81f71548ee8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/dataModelGuide.js\":\"47faeaaf8fedd459\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/dayPropertyInputs.js\":\"9c4b1bd37174b3d4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/describeRuntime.js\":\"448fba216a33577f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/extensionLint.js\":\"89f0c8339fd34749\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/grainAudit.js\":\"f5adfd267a726d35\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/healthCommand.js\":\"ce849c26c254542c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/index.js\":\"8cc3eb24ce80a05a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/presetIdentity.js\":\"76ce8111545c42d9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"15cf30a56b6c0c25\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/readMedia.js\":\"86df58eaad72ce68\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/schema.js\":\"e23270f0a8825876\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/serialization.js\":\"535e44ee0a7b8532\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/targets.js\":\"a024a68c0aaa71b9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/tokens.js\":\"2760bfe6a4b2c1c2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/watchEvents.js\":\"24cfd735d708aa55\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/workspaceGuard.js\":\"329606309d8e6dc1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/agent-runtime/writeCommands.js\":\"a5e0b7bd42dd74b8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/AliasCollisionToast.js\":\"28bc445086686574\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/DuplicateNameBanner.js\":\"001647890c7fa1b8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/collisionMerge.js\":\"b380ee0cca4ef41d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/dataExtension.js\":\"35571c4a7b0c3e86\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/index.js\":\"606759e393df86c7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/mergeCollisionAction.js\":\"0132132fdb7ce436\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/pageStyling.js\":\"9044d8581bbaaf15\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/rejectionToast.js\":\"592d7dee3557325e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/alias/syncProcessor.js\":\"ef377e5549d6983d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/actions.js\":\"37f9647a6587d0be\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/addComment.js\":\"02be8751e0dd9ff3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/anchor.js\":\"e8e7dd1a9d5b3efa\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/anchorState.js\":\"875454951011065e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/commentLinks.js\":\"e828aac88769f2ec\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/confirmThreadDeletion.js\":\"28703a84bdd3b10d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/container.js\":\"5108a4c1eeeed5d9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/dataExtension.js\":\"6769c840ddc7c086\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/deleteComment.js\":\"215e5ad565cb586c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/highlights.js\":\"ba8a91182d02518d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/index.js\":\"a347eb1c25b48ef8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/linkedCommentsPill.js\":\"7b7993f71c35f84a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/margin.js\":\"e68f5fc7d1bfff0f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/marginAnchorLinks.js\":\"3186c1a61ce54741\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/marginSchema.js\":\"81d2cafaafa38805\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/newComment.js\":\"04106d61a627f49d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/ownThreadPicker.js\":\"054e1e73cf234c45\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/placement.js\":\"708dcad9921956ea\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/queries.js\":\"108f4c15565603de\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/quotePosition.js\":\"497bedf6cd887030\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/quotedIn.js\":\"152f36570c65ea1b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/quotedRange.js\":\"f9497a7f605d3266\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/rangeRefs.js\":\"c50e8ddb52055053\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/readHighlights.js\":\"98c95daca92d6ffd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/readSelection.js\":\"8b901105a2cf35f0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/readSelectionUi.js\":\"d3fa3fe30fd668d0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/reanchor.js\":\"46273046997895cf\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/schema.js\":\"6c96fd694bb69b30\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/scope.js\":\"2130ad4fe3738dd0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/scopeThreads.js\":\"20b5184113df3896\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/splitRetarget.js\":\"d9302c9a7279d66d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/suggestionCard.js\":\"e029a5c77ce1905b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/suggestions.js\":\"eb7e83054bda6070\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/summaries.js\":\"5ca9af40bb96e0e3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/summaryBatch.js\":\"fbc56853217c0b83\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/surface.js\":\"d787e083ab64e2f2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/threadNavigation.js\":\"a801cdd9e1b36de6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/threads.js\":\"0c4f5cffab7b486c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/ui.js\":\"a7ebc97cdac9ab79\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/annotations/uiStore.js\":\"0dd1abd73875ec58\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/app-intents/appIntents.js\":\"902d6f677e09b87f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/app-intents/index.js\":\"9b1a4dc780cfb2b4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/app-update-prompt/index.js\":\"7780b18d65e4e451\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/app-update-prompt/status.js\":\"df1022d62c01bebc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"12019bc1d6203d91\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/MediaBlockRenderer.js\":\"fa915cf8e7bb5dfe\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0a2e6862f2f43fcb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/MediaUploadReconciler.js\":\"56d98a4576234ddb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/assetDownLane.js\":\"30a76bea557f6c57\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/assetResolver.js\":\"2e4991d4360196b5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/assetUpload.js\":\"afa573ed7d6726cd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/attachmentCleanerIO.js\":\"6519fe8ea0a1597c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/audit/supabaseAuditIO.js\":\"0544bad2f4a8b25b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/blobStore.js\":\"a783fa0d1301d1b6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/browserMedia.js\":\"317fb0fcd5c5f5bd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/byteStore.js\":\"8af8d4390d7ae358\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/cleanerIO.js\":\"4938d8c62f1d9c67\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/cleanupAttachments.js\":\"955ba18a96bf792d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/dataExtension.js\":\"50130f8d66df7b59\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/downLane.js\":\"9471e295d490eb31\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/index.js\":\"521cdf9feb115cdd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/insertImageContribution.js\":\"63513cf240d66712\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/laneArming.js\":\"269d9cec157b78f5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/laneLock.js\":\"e82bf23f366d0b9d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/mediaBlock.js\":\"dbef7005049e96bd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/mediaCapture.js\":\"dfb6caad4e6281a1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/mediaLanes.js\":\"3d4c10d19606fc02\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/mediaViewers.js\":\"eed909a503941638\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/mediaViewersFacet.js\":\"90a1b62d19abdb0e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/pasteCapture.js\":\"681b67f074a15258\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/resolver.js\":\"5aefb450f2c96c4d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/retryUploadsAction.js\":\"53ccfbc73282a6eb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/storagePaths.js\":\"e6eccdb5c3cee59b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/uploadDrain.js\":\"aaa1b1fe35f266ce\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/uploadLaneStatus.js\":\"599155b932c3b57e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/uploadReconcile.js\":\"12d0ac500a0fcc0f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/uploadRecovery.js\":\"12f68a320fbdad38\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/uploadStore.js\":\"bee1dcc55ec90bfd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/attachments/useAssetObjectUrl.js\":\"002ad08ad3b9b5eb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c6a446227b74b4ce\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a57fceb0893ba8b2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks-view/facet.js\":\"f711b60eee4b89ae\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks-view/index.js\":\"70e76ec26d724b99\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks-view/prop.js\":\"007f5a7f47f1c6a3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/BacklinkFilters.js\":\"2af3561bd5658d9a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4d07befb9ee46c49\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/BlockEntry.js\":\"6fe96e3f9300db0c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/LinkedReferences.js\":\"d8fc3d3645710977\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e96d961925d38a35\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/dailyNoteDefaults.js\":\"358c2cd71a7bb3cf\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/dataExtension.js\":\"9bf627bacc0b3453\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/edgeExclusions.js\":\"5c0fd82d11c4bc9f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/filterProperty.js\":\"bab1b63a078dc4af\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/index.js\":\"0d915c3b57ae780c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e4eea0a8a8754e36\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/inline-counts/applies.js\":\"2606568793815aaf\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/inline-counts/countQuery.js\":\"646ec303e0d02dd3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/inline-counts/expansionStore.js\":\"35e6452493d87697\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/inline-counts/index.js\":\"a60cc70581ae25a6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3f47f513c74c1150\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/presentationInvalidation.js\":\"974c181dfb3a8297\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/propertyEditorOverride.js\":\"2ffd8f6a851dea7f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/propertyFilter.js\":\"1a5ee435b8f1022f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/query.js\":\"6f2077b824a1428b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/resolveFilter.js\":\"670b6b7a84662c28\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/sourceBatch.js\":\"a8be2324fa18c6ea\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/sources.js\":\"4970381f41d5d308\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/useBacklinks.js\":\"09c2ff8b40136948\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d61f794238e9f971\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/birthday/BirthdayCelebration.js\":\"d4e866c6d0a0b189\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/birthday/BirthdayOverlay.js\":\"aff141f84e29ea0d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/birthday/gate.js\":\"d640ce4a18ffb072\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/birthday/index.js\":\"39ac5c71891725ea\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/birthday/wolfTheme.js\":\"73a52b05b94e5e61\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-drag/BlockDragLayer.js\":\"93ec72e13624ffe7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-drag/dragController.js\":\"fbada9d2102d98d7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-drag/dropTarget.js\":\"c6377997daae4e46\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-drag/index.js\":\"454520570eca9d28\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-drag/projection.js\":\"a027530e4ac254f2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-info/BlockMetaCard.js\":\"5f11d733752e8abe\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-info/index.js\":\"2b8fff3dd7f2f468\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/AddTagDialog.js\":\"be715d3c6cfbb3c6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"22f3cc358f2ff9e6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/TagNameIssueHint.js\":\"3f401c603df36d0f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/addTagAction.js\":\"c89424e6ca55896d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/appendTag.js\":\"e042cbb855f6ba9c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/config.js\":\"d9a1dbc234020920\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/dataExtension.js\":\"f7f733cd0e26f35a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/index.js\":\"c10c782d96873ee8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/block-tagging/propertyEditorOverride.js\":\"5b9245a64dfff03e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c7a9ff0f7223629c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"63324d6c6b1c1e8b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/Breadcrumbs.js\":\"df5e044ef94e1355\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2d6fdb2589ccf977\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a829da1b43131298\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/index.js\":\"2c6c8ed1cba3220a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9ada4b82977c16bd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/CharacterCountItem.js\":\"c9ab182aeca15fdd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/ProfilePropertyEditor.js\":\"7d5cca510b35e468\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/actions.js\":\"9fa1a806120437d0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/blockType.js\":\"f654c511f5d9021f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/charCount.js\":\"65c148c772b9dd3e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/dataExtension.js\":\"e171d16878265c8a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/index.js\":\"e2cb151087c70152\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/profiles.js\":\"ad96fa110c022ff0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/properties.js\":\"74daab484a7d432e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/subtree.js\":\"35d1583828b8769e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/character-counter/textCounts.js\":\"27282a2f22c6eee9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/colemak-keybindings/index.js\":\"d21591a8857cc083\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/CommandPalette.js\":\"80a01cf86bd09929\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/HeaderItem.js\":\"96193c187a48b8c8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/context.js\":\"d7deb57836290754\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/index.js\":\"339943990360d999\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/selection.js\":\"e7f347e5817b48eb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/toggleStore.js\":\"d8a3284c818d4988\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/command-palette/useCommandPaletteActions.js\":\"d99d73796e5e8089\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/ContributorBadges.js\":\"28a9f2c177357210\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/ProfilePicture.js\":\"8257f784f8f6db17\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/author.js\":\"083beb4c7b81e466\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/codeMirrorExtensions.js\":\"953351a5705b06ba\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/dataExtension.js\":\"b512dcf7096a2679\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/index.js\":\"19576185efe1bbb0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/mentionAutocomplete.js\":\"2d89dd9e092bec48\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/processor.js\":\"b2ab30f08a69cac3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/profiles.js\":\"fdd5048e2d2d4080\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/queries.js\":\"099949556cd714c5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/schema.js\":\"2673f1c1ad253413\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/contributors/useCommentAuthor.js\":\"511cac3de7b41250\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8100aad7e26fe6d0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/cursor-follows-scroll/followOrigin.js\":\"9ca08a39efe03dfe\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/cursor-follows-scroll/index.js\":\"deeba9347ad0b92b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d83bf037a741193d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"1c0fde02c7564b8a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/CalendarGrid.js\":\"37de94dc216304be\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/DailyNotePicker.js\":\"914fdaf2a259a926\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"d8d7f1fa85fecf04\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/DateNavDecorator.js\":\"7e835e4a10e315fd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/DateScrubOverlay.js\":\"ca625c6049e07876\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/DayPropertyControl.js\":\"b68f1a6d1c04a767\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/DayValueReferenceControl.js\":\"eee3fc91b8eea718\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/HeaderItem.js\":\"3bfdee61c0d13d4f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/ReschedulePicker.js\":\"0e00e61c64cc6460\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/SpreadDatesDialog.js\":\"391aebafa46bb306\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/actions.js\":\"df5d2524ff2b1ef2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/blockDateAdapter.js\":\"9f475df8af2dc931\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/calendar.js\":\"c12ba1a96a5cb288\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dailyNotes.js\":\"e3cffa9248c0569e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dataExtension.js\":\"10025e927850d8b5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dateScrubActions.js\":\"483f0c2bb7e041fb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dateScrubGesture.js\":\"8937e0cbe6906a62\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e082b15fb05adad4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d187b3c25e71060c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dayProperty.js\":\"cd54db999f5add77\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"e2e1ad98bf7dfb68\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/deletionGuard.js\":\"ac284c286a45d79d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/dueQuery.js\":\"0cf7b8404d9aeba4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/index.js\":\"3682aa8681f9390b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/landing.js\":\"0deb4caf565679db\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/localSchema.js\":\"10b5523fa17c5ae8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/referenceDateAdapter.js\":\"cab95b9afccc9862\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/rescheduleAction.js\":\"754e8e3eb8b9f76d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/schema.js\":\"fa40ab69391e16df\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/spreadBlockDates.js\":\"b7686d69cc31f9bc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/spreadDatesAction.js\":\"e4c59a546415cadf\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/today.js\":\"14c6d14bfea72700\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"bec28cbef435d5eb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c8821a0bb8cd75de\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/audit.js\":\"3881b836d9c41e2a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/auditAction.js\":\"797a15f31a682618\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/auditRanges.js\":\"955a723543166fbc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/diagnosticsSource.js\":\"e85d36bd2fa18ccb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/divergenceScan.js\":\"5ed16d2818defd6a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/index.js\":\"db01f7ebe11494b4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d45923abd3ed6257\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/referencesMirror.js\":\"23ccf35a2a663c05\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/rowJson.js\":\"a655db0404c7aeed\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/schedule.js\":\"e0d76df512c59b1a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/data-integrity/store.js\":\"9a10c22617406344\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-maintenance/action.js\":\"d120b74d6d18e64d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-maintenance/index.js\":\"78556b305556ec68\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-maintenance/plugin.js\":\"bda50a01bfb0c20d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d083b55e3f5af8a5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/actions.js\":\"9d02eafced392148\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/changeMarker.js\":\"8b82ba6366802101\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/diagnostics.js\":\"88ee31dea8f8db85\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/fileSystemAccess.js\":\"90d5a69e744d8b6e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/filenames.js\":\"191d8600351869b5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/index.js\":\"e36cc81d744df370\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/mirror.js\":\"a8f77494f141ba63\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/runLock.js\":\"b601c29b1769b512\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/runtimeHealth.js\":\"1e373975e8badcad\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/schedule.js\":\"915af12c97b85e4c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/db-mirror/store.js\":\"c8153291e6faa7e2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/default-themes/index.js\":\"1d2ebf83ae65d893\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/default-themes/themes.js\":\"9b0b7a0181ee8702\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/diagnostics/facet.js\":\"cdbe4a038cab7492\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/diagnostics/useDiagnostics.js\":\"31230264a73f4b84\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extension-prompts/dismissals.js\":\"a1c1d1a5a82a9fc1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extension-prompts/index.js\":\"223eccbf0f3f52c2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extension-prompts/status.js\":\"058f408c3a3d3406\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extension-prompts/store.js\":\"e246f5fa28fa495e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"8a4792aca4a6cbfe\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/ExtensionsSettings.js\":\"099ff01c2fdc5de7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/actions.js\":\"8b35e5dcf69ddd72\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/config.js\":\"8f08625a4038529a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/dataExtension.js\":\"d64e43efc11dd7d2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/effect.js\":\"f1a06c2ded46eea6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/index.js\":\"fe3bbff3b1fd8c4c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/propertyEditorOverride.js\":\"246f6d9d5141cbd8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extensions-settings/useToggleTree.js\":\"347785204f366cb1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extract-type/ExtractTypeDialog.js\":\"15e8e647547e4292\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"350b448181b02747\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extract-type/PropertyShapePicker.js\":\"8bc7dd5520933677\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extract-type/action.js\":\"36ef486f2ad3572f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/extract-type/index.js\":\"9f3018e1305b3f64\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/FindReplaceDialog.js\":\"9f8b902c7b3de63b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/HeaderItem.js\":\"8a98acd6264492aa\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/dataExtension.js\":\"923aecb1ee314541\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/index.js\":\"8cb9c9f7c9ec6699\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/search.js\":\"ec813a3c9830c042\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/toggleStore.js\":\"f95e700ffe8bd77c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/LocationPropertyEditor.js\":\"f049482cb30dd369\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/MapView.js\":\"8def1f3953a4dbb9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/blockTypes.js\":\"d13b3fa464ccf939\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/codeMirrorExtensions.js\":\"7d15e2fcd46bdaf1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/createOrFindPlace.js\":\"fe9ae430968878cc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/currentLocation.js\":\"45a14e07c3028cdd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/dataExtension.js\":\"01f020627a397576\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/geoContentDecorator.js\":\"6d7243c6d33c2f4d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/googlePlacesClient.js\":\"39a11315e92ecf7a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/index.js\":\"1c6798c75bd17ee7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/locationsPage.js\":\"ebf87c3f4dfc567f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/mapViewport.js\":\"40de0c704bef8135\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/pickCurrentLocation.js\":\"e1137333e67f7058\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/placeAutocomplete.js\":\"3a5d5e8d236c5880\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/placeNameCollision.js\":\"0d3f6053417ce7a1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/properties.js\":\"1cc6947e4773b472\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/propertyEditorOverrides.js\":\"6ab4ee92268fee28\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/query.js\":\"801975006574ddb1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/geo/usePlaceSearch.js\":\"bce5f69c944713dd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b7c22ef9a21df59a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"71281e3efe53dbb6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"f67cd3c8e63c06cc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/config.js\":\"81ace80a1a210dda\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/dataExtension.js\":\"52362a3095553167\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/facet.js\":\"f8d8b9da78d57c84\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/grouping.js\":\"57352a1c4bf5dff7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/index.js\":\"1a102841e922faa1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f95982ba4670db02\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/query.js\":\"e7bc17f06d42bcab\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/resolveConfig.js\":\"c9b7e60537bcc026\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"231d2897bb4a7dee\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"4912d41a2cd86720\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/HtmlDocumentContent.js\":\"4a15e17e16c0a886\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/HtmlFrame.js\":\"18f6fc5be667c81a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/actions.js\":\"470138ede6e51a4c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/blockType.js\":\"c27b18f2a17db623\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/confirmRunScripts.js\":\"10ff35d3244e6433\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/dataExtension.js\":\"5020cbc78a962efb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/frameAnnotations.js\":\"fc09c1eed60b0ce7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/frameDocument.js\":\"51feb63764450737\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/frameTheme.js\":\"b71b5fec7c68b50e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/index.js\":\"bc2d95acd4095187\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/scriptConsent.js\":\"386b680fd8018758\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/sourceMap.js\":\"77dc65014b98e7c7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/html-document/useDocumentScripts.js\":\"46559c09d989fd88\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/interaction-metrics/index.js\":\"18309fdcc0fd0b4a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/interaction-metrics/record.js\":\"62162f7498f47b25\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/interaction-metrics/recordStore.js\":\"1fa9d60e40203ef0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/interaction-metrics/responsiveness.js\":\"d6745ff533484c15\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/interaction-metrics/schedule.js\":\"9cb2a52fc9f8c8fe\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/interaction-metrics/sessionContext.js\":\"e36ba66e2ac27e06\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"80f741b134f96bb5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c30fe2a1e9a57075\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/actions.js\":\"0a446c090059fc08\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/config.js\":\"e9607c6c4b0d4e99\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/dataExtension.js\":\"3be85e7893e123bd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/effect.js\":\"8c5cb8c2c7adfd00\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/index.js\":\"417e5f5e0cce7fb6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/keyCapture.js\":\"af13e82d29c2ead2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/overrideStore.js\":\"1fdf81b05101da0a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"0b238daf1d2d7789\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/HeaderItem.js\":\"a78216b437d25a03\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/LeftSidebar.js\":\"644f2500e771e1b7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/actions.js\":\"42dbf937a176aef5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/facet.js\":\"bbaa6041c11ae781\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/index.js\":\"c9cbe732c1dfec57\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/shortcuts.js\":\"57502ccb687c9264\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/left-sidebar/toggleStore.js\":\"b207842ae271f6d9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/merge-blocks/MergePicker.js\":\"19a547443ca6f71f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/merge-blocks/index.js\":\"d1b90555ff7bd248\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/merge-blocks/mergeAction.js\":\"ba9c3f2aecbda2a2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/merge-blocks/strategy.js\":\"22c2cdbfcd5c3d8b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-bottom-nav/Button.js\":\"6a5b32fbb58cf93c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6d3b38c9b1ee1d45\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-bottom-nav/defaultItems.js\":\"6fd62604a58a2573\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-bottom-nav/facet.js\":\"0b882cfebe74a3f9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-bottom-nav/index.js\":\"11915c6feafeddfe\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"84234554d9c0b435\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-keyboard-toolbar/actions.js\":\"348bc5b62debe87f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"cb92f9101eb8b617\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9c7c9059dc2b4e89\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/mobile-keyboard-toolbar/index.js\":\"23047769c09796e7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e6db4508e1152eeb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/blockSubtreeMembership.js\":\"3a84ffde478813ce\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/contextMenuItem.js\":\"ae2a56cf8c383cc2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/index.js\":\"3b5aa96a72ce0036\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/moveAction.js\":\"f7606e03e95a970d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/moveBlocks.js\":\"5982d25141691fda\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/move-blocks/selectionAfterMove.js\":\"b19594939e72a4e3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/TutorialBanner.js\":\"3b22db6defa37c09\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/action.js\":\"a8a5dda27192e9bc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/bannerDismissal.js\":\"6123115609a25156\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/documents/cheatSheet.js\":\"13994f4631966dd1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/index.js\":\"69ddb6b42a45e7da\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/keys.js\":\"531c811d69c5833d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/landing.js\":\"a5c7f4816ef47e1b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/outline.js\":\"cbd2963df6ba3b51\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/onboarding/seed.js\":\"6c1c81a38f2d2fdc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/PerfTrendDialog.js\":\"3f5366999c3ca04b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/analyze.js\":\"0c78b7510263a5bc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/diagnosticsSource.js\":\"9a4bebc37fb6cf44\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/index.js\":\"75e004fa52a225d6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/load.js\":\"f0eecabe952a1d19\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/monitorRun.js\":\"4d258cefbfd3207a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/schedule.js\":\"3f839a0e8d5b8864\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/series.js\":\"3d33ce3bcfa12fc4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/store.js\":\"e52b58c5d24a382c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/trendAction.js\":\"1f83879e131e2179\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/perf-monitor/verdict.js\":\"f6647c5dda2fd0e6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/plain-outliner/clickToEditAction.js\":\"f985377ec489cfd5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/plain-outliner/index.js\":\"7db1e7ebcd9d514b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/plain-outliner/interactions.js\":\"6df6d8aaf461aeb3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f77dfec1254e0960\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/MigrationGate.js\":\"bcfb913f9bac8171\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/MigrationGateDialog.js\":\"e288ddf400d15525\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/action.js\":\"2b50008a36c8adbd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/index.js\":\"7f057f9e299cec15\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/localRunMessage.js\":\"4701d9c7d7225c41\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/plugin.js\":\"52c04e525061e0f1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/progressReport.js\":\"e1e40b5b1ce8d149\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/properties-migration/sweepProgress.js\":\"1765a2696f247a58\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/FieldRowRenderer.js\":\"78e37044720a400d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/ValueRowRenderer.js\":\"b655a27b2411bc61\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/actions.js\":\"45eeb5f560e77cb8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/autocomplete.js\":\"33931cecd10b74c0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/fieldRow.js\":\"ad718345ecb7cc89\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/index.js\":\"a003af925e86533a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/referenceWarning.js\":\"44b642c88c83a296\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/valueAutocomplete.js\":\"c446a75400b462b4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/property-rows/valueSchema.js\":\"7c948281004173ab\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/HeaderItem.js\":\"69bdfc60e2db7ae5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/QuickFind.js\":\"93ef3dd486292c47\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/index.js\":\"ec9decafb215f8fd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/recents.js\":\"19a92e28b3e8fc2a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/resultItems.js\":\"d26ce9a394707fa5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/selection.js\":\"36cd3181b9d5931c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/quick-find/toggleStore.js\":\"db0c1e61e1a2ef61\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/recents/HeaderItem.js\":\"bb18cdeb717ee425\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/recents/RecentsPageBlockRenderer.js\":\"121a0e62a5b1d2b3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/recents/grouping.js\":\"8a89ace33b5c2a14\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/recents/index.js\":\"af0f682c6b9346db\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/recents/target.js\":\"25ef729446075fa9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/codeMirrorExtensions.js\":\"3b15821425a2e4e8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/contentPrefill.js\":\"09901ea1eb6e3569\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/dataExtension.js\":\"3547d13ba826b234\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/index.js\":\"21ef8bf790076025\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"2d94ea722108393a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/invalidation.js\":\"f9b89a967b71ecc5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/localSchema.js\":\"99d0017ce240cc55\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/blockrefs/index.js\":\"c59e5c6141de1eba\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"fa1cea3599aa0434\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/index.js\":\"315502c72c83f6b5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/referenceNode.js\":\"efc964a0cdb0f95d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/remark-reference-occurrences.js\":\"9c98a30b2ddc7072\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"064e0c4d83a3e7a4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/wikilinks/index.js\":\"919711ef7b8067a2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"fb9686e39369baa8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"f2926fd6834d2b93\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/mergeRetargetProcessor.js\":\"ecd622151a6d82d5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/parseFence.js\":\"024d92f0aae94132\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/referenceParser.js\":\"0ccc8330225b7165\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/referenceProjection.js\":\"59f9812fd543da30\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/referencesProcessor.js\":\"e55fac9d9e17bef9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/renameProcessor.js\":\"7ce05194bc671f0b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/references/spanReplacement.js\":\"ff595f7920cbbae2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/rich-paste/htmlToOutline.js\":\"857b071b63eea02b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/rich-paste/index.js\":\"4625861d9de935a9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a5c2738d5fd0de00\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/rich-paste/pasteDecision.js\":\"ad4476c95cb44e1d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/action.js\":\"ba07a22b84a69f0a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/blockIds.js\":\"8edecca0f619abe0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/content.js\":\"000866be97feff61\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/effect.js\":\"e8d5dc647ffee937\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/ids.js\":\"567031b59e9557d9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/import.js\":\"2edfba8fb170fd23\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/index.js\":\"6ffa1ce9ed8b02dc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/plan.js\":\"e8be733d640751e5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/plugin.js\":\"2a439a631c84c7b9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/promotion.js\":\"b32fac61ada18fda\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/properties.js\":\"33981de66b053838\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/references.js\":\"b72ff628e1c12f4f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/report.js\":\"52e497d22a5a927d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/roamMemo.js\":\"52230a92fa0a395b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/runtime.js\":\"d8e363facf6ea8e5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/schemaReconciliation.js\":\"2c01a4b76b22e49b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/srsMarkers.js\":\"f858e929acb33d41\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/todo.js\":\"6ad5fd3af87a9a1b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/typeCandidates.js\":\"0075fbbe7e6cdc56\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/roam-import/types.js\":\"7f9bdd6e4f5c4a60\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/search-health/index.js\":\"403b0fb892001645\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/search-health/store.js\":\"c331897b0f784928\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/shortcut-help/HeaderItem.js\":\"f1c841f810214d79\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ee512cb1fb43e562\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/shortcut-help/index.js\":\"f499ccb093bc81c9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/shortcut-help/model.js\":\"d567e134887ec0b0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/shortcut-help/toggleStore.js\":\"1b973c309614a8aa\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/shortcut-help/useKeyInspector.js\":\"4f40bb1e08fa25b0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"46fd07536a050db1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/ShellDecorator.js\":\"c174f8bc13d1690d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/actions.js\":\"29336a6ce5c25b55\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/exclusionsFacet.js\":\"2cf4487ff71cf8f7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/index.js\":\"4ee20da158814238\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/shell.js\":\"3cb6efefae9a0b9b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/surface.js\":\"e15c7ad8d3d12570\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/spatial-navigation/walker.js\":\"51c86ece052614d5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/RescheduleToast.js\":\"aa5187eedf812b8c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/dataExtension.js\":\"c69e97f7d10d16aa\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/index.js\":\"9a4170a190a07a1e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/indicator.js\":\"a80c9727f127f7b5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/moveSrsState.js\":\"56dedd2adf023a1e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d22e1306a47326a5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/scheduler.js\":\"c03731f0327a9050\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/schema.js\":\"4b908e4aab095a44\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3528cad4310ac7b0\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/srsClipboard.js\":\"c84d95c0bfcbe227\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"05ded30301d7bbd3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7c36b5cdf2adb4d7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/DeckPicker.js\":\"0e2a4d58ac2fed49\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/ReviewControls.js\":\"301a1435a5d31bcb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/ReviewDeckRenderer.js\":\"64564919b3e3c7cd\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/ReviewSession.js\":\"78e90912a3cba091\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/actions.js\":\"a034443edddca50e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/archive.js\":\"a26e6f1fcd95ca3c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/dataExtension.js\":\"4952fa6faebc5cd6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/deck.js\":\"aa0b07079d6217da\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/dueQuery.js\":\"d121ea9d0019be26\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/gradeDecision.js\":\"f9990c7a8be0c677\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/index.js\":\"976ed540e82ce574\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/keyHints.js\":\"f1556f35f997790f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/reviewCardLayout.js\":\"8c19c07b085c7e09\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/reviewProgress.js\":\"da23bd42ee1164ef\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/schema.js\":\"834258aecfadde85\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/srs-review/useDueCards.js\":\"22d697d897eaaafc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/startup-metrics/index.js\":\"b9f4d2a56cee0541\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/startup-metrics/record.js\":\"49e1fb6e6ad7513c\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/storage-persistence/index.js\":\"1b768f583860e2e4\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/storage-persistence/persistenceStatus.js\":\"225b06be3ced432f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/storage-persistence/requestAction.js\":\"3e81663bf8812d13\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/supertags/TypeChipsDecorator.js\":\"cb0761ebd854b783\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/supertags/codeMirrorExtensions.js\":\"d24a401b4a7db947\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/supertags/index.js\":\"23ede60ddcee6709\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/supertags/typeAutocomplete.js\":\"2ad6bffa8d241d86\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"64a740a6218978e2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/actions.js\":\"22bb2589f9b8dcf1\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/anchor.js\":\"789bfac2a8583fc9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/events.js\":\"689c6c326874f3fa\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/gestureActions.js\":\"409abda93d8b7e52\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/index.js\":\"514493ce1e7457d8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"2a5d6d767c0986d9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/sync-metrics/collect.js\":\"5a8e1d5901b5b852\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/sync-metrics/index.js\":\"25174261b231b516\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/sync-metrics/record.js\":\"6cdbea523346dbee\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/RejectionDialog.js\":\"41622a305f926744\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/SystemStatusHeaderItem.js\":\"3cba9a12b2f60e05\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/index.js\":\"4416db4714019bfb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/model.js\":\"57cf015714d3bf1a\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/queueCounts.js\":\"543ea3250494668e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/rejectedHelpers.js\":\"4b25d2458d026945\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/rematerializeAction.js\":\"c436f8b4a377b5c9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/system-status/useHysteresis.js\":\"97c59fb8953c5e02\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/ColumnHeaders.js\":\"4bb5d8f5344860fa\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/QueryUi.js\":\"3e6a866be162263f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/TableLayout.js\":\"0d2cb8157a5de3c6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/actions.js\":\"5512f98e8009fd81\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/cellEdits.js\":\"a40c7f8ca4eed66b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/childrenViews.js\":\"e4ab44e5eb344d5b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/columns.js\":\"eaed01c84ad0a7f2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/controller.js\":\"bd2cd18ba338890f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/convert.js\":\"192c991dfaddbd83\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/dataExtension.js\":\"b4c200df787d0b0e\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/index.js\":\"fb0952bc0d3c2e26\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/keys.js\":\"291213f71835c113\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/model.js\":\"16ea70e5c6695787\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/QueryText.js\":\"434057b44717c7a7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/backfill.js\":\"6d6dc86b42019e95\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/completion.js\":\"8690c2b25a5f1b60\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/format.js\":\"e4246b6a176cdfe2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/parse.js\":\"d4a19ceb6078e405\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/queryValue.js\":\"bba61a2f5e29a058\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/registrations.js\":\"8848144fc6d54173\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/query/source.js\":\"236469948f978684\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/registry.js\":\"ba9ec12b367598f7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/rowGutter.js\":\"e7d944ba0de50bba\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/rowVerbs.js\":\"427ee6d64251de44\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/schema.js\":\"73ed1b085d279d16\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/tables/sort.js\":\"7d9bac450eb75620\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/theme-toggle/effect.js\":\"0fda44132ef6ffd5\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/theme-toggle/index.js\":\"2322ff121d3da3b8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/theme-toggle/theme.js\":\"3e760e5d770f28bc\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/todo/actions.js\":\"6b05e0a06e20d930\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/todo/dataExtension.js\":\"ff8fa63e6c073ee9\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/todo/index.js\":\"a8e7fdee4d88dcc6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/todo/schema.js\":\"8eeba351960bb82b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e31091b3a3a533ae\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/touch-selection/actions.js\":\"b1fb09442cfe2698\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/touch-selection/defaultItems.js\":\"51f2f4de323d5080\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/touch-selection/facet.js\":\"163c7f376772889d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/touch-selection/holdRecognizer.js\":\"2451b992548474e7\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/touch-selection/index.js\":\"146094517a59c1e6\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/update-indicator/UpdateIndicator.js\":\"e3e140fc2ac09558\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/update-indicator/index.js\":\"902fb48bbf46b921\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/update-indicator/loadTimes.js\":\"91546c0303d8ed4f\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/VideoNotesRenderer.js\":\"e5c10bbd49cff28b\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/VideoPlayerRenderer.js\":\"b3d882afd0ead217\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/VideoTimeStamp.js\":\"3bc1d4cfaa74601d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/actions.js\":\"edb47f2fb6991796\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/index.js\":\"7cd94bc5001adf75\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/markdown.js\":\"c07c7392786edb2d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/notes.js\":\"6c53baca4ceb7cc8\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/registry.js\":\"009f63daf190b390\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/remark-timestamps.js\":\"9443b56f63d081c2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/video-player/view.js\":\"b6fa3b0882b11a94\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-link-hints/LinkHints.js\":\"37d40878d112f7a3\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-link-hints/index.js\":\"bf88c115bef34c61\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-link-hints/model.js\":\"26e24f1c90faf364\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-link-hints/settings.js\":\"89cc40be37b2e49d\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-normal-mode/actions.js\":\"2fdec484e28ec654\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-normal-mode/index.js\":\"01a027805c0913e2\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/vim-normal-mode/interactions.js\":\"3585fe7d2c8022fb\",\"/knowledge-medium/pr-preview/pr-1895/src/plugins/workspace-header/index.js\":\"63ca9c5d45d8f0ba\",\"/knowledge-medium/pr-preview/pr-1895/src/registerServiceWorker.js\":\"74c6c9399175764e\",\"/knowledge-medium/pr-preview/pr-1895/src/requestPersistentStorage.js\":\"681e425f87b9f9b5\",\"/knowledge-medium/pr-preview/pr-1895/src/services/authRequestDeadline.js\":\"cb12e2f362bf7db8\",\"/knowledge-medium/pr-preview/pr-1895/src/services/authStorage.js\":\"063fecd9ec48533b\",\"/knowledge-medium/pr-preview/pr-1895/src/services/powersync.js\":\"148e37890810e010\",\"/knowledge-medium/pr-preview/pr-1895/src/services/supabase.js\":\"b4ccfa1bc612e9c1\",\"/knowledge-medium/pr-preview/pr-1895/src/services/uploadErrorClassifier.js\":\"63ee4b8193c08ec6\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/ActiveContexts.js\":\"03e2f37aaa901092\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/HotkeyReconciler.js\":\"b872029ff3863be8\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/WipeLocalDataDialog.js\":\"f2d5b4a9222d2592\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/actionDispatch.js\":\"4644de3228e6d95b\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/actionRefItems.js\":\"d209218367bf12d7\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/applyKeybindingOverrides.js\":\"581303e90238cc1c\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/blockActions.js\":\"0e9eb64efc6db04a\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/blockMergeGesture.js\":\"fe28023258d766b1\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/canonicalizeChord.js\":\"64f5f5305b605421\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/defaultContexts.js\":\"18346ef9981373a8\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/defaultShortcuts.js\":\"ddc1bc7fa06f8451\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/effectiveActions.js\":\"c5659c6995ebf4ad\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/gestureAction.js\":\"7751e38c2bd688a1\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/gestureBinding.js\":\"cc5f6b520c211998\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/holdRegistry.js\":\"8eb1bd1c30fbeede\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/keybindingConflicts.js\":\"5c127ff237ae6417\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/keybindingOverrides.js\":\"d747a71e34efe48d\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/pointerAction.js\":\"e16c8b5345ea46e1\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/resolve.js\":\"af6029b7d247cb50\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/runAction.js\":\"421a3cad9eddee23\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/sequenceMatcher.js\":\"710318b60d6fe52f\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/types.js\":\"81c0ca7ff5ad902c\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/useActionContext.js\":\"c40e51a9e4b9a2ea\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/useActionDiscovery.js\":\"a3718168383cbbcc\",\"/knowledge-medium/pr-preview/pr-1895/src/shortcuts/utils.js\":\"f2eb9c48fe099dfc\",\"/knowledge-medium/pr-preview/pr-1895/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1895/src/sw/bootStore.js\":\"3d1f87d7807957ae\",\"/knowledge-medium/pr-preview/pr-1895/src/sw/previewDatabases.js\":\"2b78ba1edb451027\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/byteTransform.js\":\"7eb7e18e08a25cd7\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/attachmentCleaner.js\":\"969b01229b6ab916\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/bundle/attachmentParts.js\":\"c1c2dca08aabfd39\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/bundle/bundleParts.js\":\"5d45de285c5e3175\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/bundle/bundleRecord.js\":\"2265189387dc4e64\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/bundle/manifest.js\":\"176d0ff3a5ffd363\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/bundle/takeBundle.js\":\"4dbb3f1b4a6fb5c9\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/bundle/verifyBundle.js\":\"bc507861b9536e8a\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/cleaningStage.js\":\"f4d7d48b9caf1743\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/conversionKey.js\":\"e0b7adf2b6fae4df\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/conversionServer.js\":\"7b1f7eccd0f2ecef\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/flip.js\":\"985a7df5e534d552\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/flipAttempts.js\":\"a25c1336a8536e2a\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/pages.js\":\"de97e656af5b91ee\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/preflight.js\":\"6a01034e65119822\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/reseal.js\":\"3f7dc9115acdda9c\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/runConversion.js\":\"b065f1a77213e4e4\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/runLock.js\":\"e2ffae1c16e9b8ca\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/sealing.js\":\"ca405738185e2434\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/sealingStage.js\":\"d82ba9ac07c6435f\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/stage.js\":\"410c3021e42cf39b\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/conversion/verifyReseal.js\":\"d862cba090af3358\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/aad.js\":\"6c1ff8d412c74985\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/aead.js\":\"96344b9a94d3f51e\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/base32.js\":\"b1dbb5fabe17b766\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/base64url.js\":\"1e6772b10e56ee8c\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/binaryEnvelope.js\":\"58be0a708886b932\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/byteAead.js\":\"20533d02936a1673\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/canary.js\":\"8fb5e34c4bf1b612\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/contentHash.js\":\"c060374c8fd3aac0\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/contentKey.js\":\"731f9983606b9651\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/derivedIdNamespace.js\":\"8a7335cc29e6c070\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/envelope.js\":\"eae0d4c5a2bdc941\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/hex.js\":\"d125943766c5b87a\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/sha256Hex.js\":\"5b60296e1437a74d\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/crypto/workspaceKey.js\":\"cabe1576af6497c7\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/conversionState.js\":\"dd884e5122adc3f9\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/flows/createEncryptedWorkspace.js\":\"900dd207f9fdf33d\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/flows/pastedKey.js\":\"a431fd8adb47cc2a\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c16a723539c9e62a\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8298db6e34559646\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/keyStore.js\":\"bdca39180852f37a\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/mintWorkspaceKey.js\":\"4f2153d84c3a7982\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/modePin.js\":\"b242bab9e2d0f506\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/openWorkspaceKeys.js\":\"857826dd9571f91d\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/resolveWorkspaceEntry.js\":\"6fad98d1520f3ba6\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/resolver.js\":\"b24bec93cf371c23\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/keys/workspaceAccess.js\":\"fd52f20f1e0bd8d6\",\"/knowledge-medium/pr-preview/pr-1895/src/sync/transform.js\":\"4ddb2a9d2e60219c\",\"/knowledge-medium/pr-preview/pr-1895/src/themeBootDefaults.js\":\"c638613fa5715d62\",\"/knowledge-medium/pr-preview/pr-1895/src/types.js\":\"e6e35f99ec354e06\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/ClientLocalSettings.js\":\"2a7315b4016d907c\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/abortableSleep.js\":\"d1ab524498cc5401\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/array.js\":\"b89162c011682c4d\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/backlinkAutocomplete.js\":\"77275d2f6a381256\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/blockCrumbs.js\":\"f28b39177c0d98e1\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/blockrefAutocomplete.js\":\"6f5feda4a8013faf\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/cadencedIdleJob.js\":\"76f03b4c8a8ac3d0\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/callbackSet.js\":\"1934b8a29df42f0c\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/clientId.js\":\"ce1a0940f7806b1d\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/codemirror.js\":\"ee46ea7a3042736b\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/codemirrorCompletion.js\":\"b0eaebe716ad6a62\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/copy.js\":\"82ecedea2807149d\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/dailyPage.js\":\"b0e95144b06e1a63\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/dbForensics.js\":\"f37810cdd457569e\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/dbForensicsHooks.js\":\"c242e7510c957460\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/deleteBlockThroughUi.js\":\"2b3dc797ec2a068f\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/dialogs.js\":\"aa75ae4e015974c7\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/dom.js\":\"1f4bfac59be0775f\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/downloadBlob.js\":\"9cb8c1577da3b39a\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/drawnWalk.js\":\"2c4216673de75574\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/exportSqliteDb.js\":\"57dfb221fdb1fd38\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/fileSystemAccess.js\":\"dd5ebed47023365f\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/flipSlide.js\":\"2f4ac1c264129a09\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/fnv1a.js\":\"3f0cad19d87b24ba\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/formatBytes.js\":\"82815d5e6d279c4e\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/fuzzyRank.js\":\"4dfdb7e249b19fe7\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/idbKeyedStore.js\":\"f247b645e13ef532\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/idleCallbackPolyfill.js\":\"e93663dcbc267870\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/keyboardAwareScroll.js\":\"144d81ef65dc80ed\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/keyboardViewport.js\":\"36ad788a55f07fc8\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/lastWorkspace.js\":\"036c8129441ad734\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/layoutColumns.js\":\"57fa206012369ce5\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/layoutSessionDom.js\":\"42df55aa8d06436f\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/layoutSessionId.js\":\"55ecbec65acc3287\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/linkClickGestures.js\":\"e788eff7576fc14b\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/linkTargetAutocomplete.js\":\"7ccd3c6efdcf4700\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/localDbCorruption.js\":\"6fa9d422ca82f2ff\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/localDbRecovery.js\":\"3875abc2af9557ba\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/markdownParser.js\":\"d858cc055c2ec601\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/memoize.js\":\"21c924498471176f\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/nameFieldCommit.js\":\"684faf6b151eccf6\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/nameList.js\":\"04229ea4841324d4\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/navigation.js\":\"bdbdeebc22bac675\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/omnilinerNamespace.js\":\"812f684318983654\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/opfsPageScan.js\":\"de73aa9026af6e66\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/panelClearance.js\":\"ee1c7668f9e272c5\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/panelHistory.js\":\"5a436606e85111da\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/panelLanes.js\":\"3764d9faea6543fe\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/panelLayoutProjection.js\":\"8ad94684e3116f2c\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/panelScrollAnchor.js\":\"620e10d244200fb0\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/panelUrlFlags.js\":\"1da8c4d36a0e1097\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/platform.js\":\"f71969aabd313de2\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/pluralize.js\":\"e97a13b3edddda3d\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/propertyCreation.js\":\"c37fb20b01a43449\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/propertyNavigation.js\":\"9c87794c39d6a727\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/propertyValueContext.js\":\"e01d30cbd1d38e80\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/react.js\":\"0f77804bb6b79637\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/relativeDate.js\":\"9ec5a16101435079\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/relativeTime.js\":\"cca2a792858e1f55\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/renderScope.js\":\"019d0f7a3f86d83d\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/resolvedThenable.js\":\"3da5fbcc9e0d825b\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/routing.js\":\"888fc2798c136e3b\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/safeMode.js\":\"7a4af0b4979766bd\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/scheduleIdle.js\":\"e0434ed4f7ceeeed\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/screenWakeLock.js\":\"8c820696fa6aba44\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/selection.js\":\"64c5a22a4af8ba55\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/softKeyboardGrab.js\":\"2402647338033082\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/startupTimeline.js\":\"6406e8d37c875cb3\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/state.js\":\"18fc72e65588f20b\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/string.js\":\"1cef75108ea41c1e\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/surfaceZoom.js\":\"779520158effb3a4\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/time.js\":\"6f60d6bd7680e0da\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/toast.js\":\"a71feef42155945a\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/toggleStore.js\":\"9a8734658fbcfaae\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/untilStopped.js\":\"95ad2ca5f33ba993\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/userActivity.js\":\"55879e4624d95ff7\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/viewTransition.js\":\"af963d1a61891470\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/viewport.js\":\"76df4b64e89a6482\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/webLock.js\":\"588f96995322514d\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/workspaceRecovery.js\":\"5e227276a7181718\",\"/knowledge-medium/pr-preview/pr-1895/src/utils/workspaceSnapshotStore.js\":\"73549d2840f83b39\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-compiler-runtime.js\":\"d0fc8f7bea97a5e6\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom-client.js\":\"988c9193b055d5e5\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom-server-edge.js\":\"88e4eabba3771a7f\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom-server.js\":\"2fb16b888171ef96\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom-static-edge.js\":\"6111c5310cf932d2\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom-static.js\":\"860d4eff2ec2c141\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom-test-utils.js\":\"b41ec3c48ba542ab\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-dom.js\":\"eb71c0cdcc5c9886\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react-jsx-runtime.js\":\"71b4168f7a2296f4\",\"/knowledge-medium/pr-preview/pr-1895/src/vendor/react.js\":\"9b51ce2e83bbaecc\",\"/knowledge-medium/pr-preview/pr-1895/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1895/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1895/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
