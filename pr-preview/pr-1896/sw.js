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
		buildId: "14aa4c579560-2854b6c3",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1896/\":\"f9a2c2d0e6ff09d8\",\"/knowledge-medium/pr-preview/pr-1896/index.html\":\"f9a2c2d0e6ff09d8\",\"/knowledge-medium/pr-preview/pr-1896/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1896/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1896/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1896/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1896/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1896/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1896/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1896/assets/FacadeVFS-zkC5HO9l.js\":\"d7693e1d7c2cffa8\",\"/knowledge-medium/pr-preview/pr-1896/assets/OPFSCoopSyncVFS-BnDmlqNQ.js\":\"1727509f6e95affe\",\"/knowledge-medium/pr-preview/pr-1896/assets/OPFSWriteAheadVFS-CfQoei-D.js\":\"c64b831738505dc2\",\"/knowledge-medium/pr-preview/pr-1896/assets/wa-sqlite-1LAESPCG.js\":\"c107c6f8787e4882\",\"/knowledge-medium/pr-preview/pr-1896/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1896/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1896/assets/wa-sqlite-async-DDWXICC0.js\":\"f969ceb2e6fbfdf4\",\"/knowledge-medium/pr-preview/pr-1896/assets/worker-BqmlBjmR.js\":\"bc0ab6ae35ebfade\",\"/knowledge-medium/pr-preview/pr-1896/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1896/chunks/app-D0yP_31M.js\":\"4348b28121b4bdb9\",\"/knowledge-medium/pr-preview/pr-1896/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1896/index.js\":\"b72daa41837ff937\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1896/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1896/assets/AccessHandlePoolVFS-rsX2FWy0.js\":\"1f21a3e60fdaffa6\",\"/knowledge-medium/pr-preview/pr-1896/assets/IDBBatchAtomicVFS-nvnnpTtV.js\":\"3bdfee779853e1af\",\"/knowledge-medium/pr-preview/pr-1896/assets/MemoryVFS-BIs2Tduv.js\":\"3ae8d12ee625c2d7\",\"/knowledge-medium/pr-preview/pr-1896/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1896/assets/mc-wa-sqlite-SbPTVW3e.js\":\"8e8f2318bf30b968\",\"/knowledge-medium/pr-preview/pr-1896/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1896/assets/mc-wa-sqlite-async-tWRe-e2g.js\":\"620ce6f7160545dd\",\"/knowledge-medium/pr-preview/pr-1896/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1896/chunks/AccessHandlePoolVFS-z45NYEcL.js\":\"5532caee19c3418e\",\"/knowledge-medium/pr-preview/pr-1896/chunks/FacadeVFS-BuckOHy-.js\":\"432df20a7c7285ee\",\"/knowledge-medium/pr-preview/pr-1896/chunks/IDBBatchAtomicVFS-DZrUc7Bf.js\":\"fcfe36a404ae07fa\",\"/knowledge-medium/pr-preview/pr-1896/chunks/MemoryVFS-TzyJpF4X.js\":\"ad76f029b80b5bab\",\"/knowledge-medium/pr-preview/pr-1896/chunks/OPFSCoopSyncVFS-Bsof-ueT.js\":\"b8ea7dc0b52bb64e\",\"/knowledge-medium/pr-preview/pr-1896/chunks/OPFSWriteAheadVFS-CgdY5O5m.js\":\"5b008fba8983a541\",\"/knowledge-medium/pr-preview/pr-1896/chunks/Preview-CYvOIzn8.js\":\"8d1d754dcbe045e9\",\"/knowledge-medium/pr-preview/pr-1896/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1896/chunks/card-CEiGAkeH.js\":\"4d16fc618f3a3f51\",\"/knowledge-medium/pr-preview/pr-1896/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1896/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1896/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1896/chunks/dist-DvDu5lrT.js\":\"57b82c498ab6b5f7\",\"/knowledge-medium/pr-preview/pr-1896/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1896/chunks/mc-wa-sqlite-DF3wqSpr.js\":\"f60822f8fb1d6669\",\"/knowledge-medium/pr-preview/pr-1896/chunks/mc-wa-sqlite-async-MY7btb_m.js\":\"adbc127c3743074f\",\"/knowledge-medium/pr-preview/pr-1896/chunks/react-B7IIid5a.js\":\"ec5403c07de2ee57\",\"/knowledge-medium/pr-preview/pr-1896/chunks/react-BFD9cKN2.js\":\"5d211c44efb410c0\",\"/knowledge-medium/pr-preview/pr-1896/chunks/react-BIdtIz03.js\":\"2441bdae96bc65f5\",\"/knowledge-medium/pr-preview/pr-1896/chunks/react-C5lc184T.js\":\"5bddac123e2f4800\",\"/knowledge-medium/pr-preview/pr-1896/chunks/react-Cgnp6Fau.js\":\"967a679af0c891dd\",\"/knowledge-medium/pr-preview/pr-1896/chunks/react-Dl55egTz.js\":\"4ed707048d834184\",\"/knowledge-medium/pr-preview/pr-1896/chunks/react-K_Pyw3iL.js\":\"f3e1997351b3c78e\",\"/knowledge-medium/pr-preview/pr-1896/chunks/react-Tjns2GPK.js\":\"efa8fd606c49553c\",\"/knowledge-medium/pr-preview/pr-1896/chunks/react-dom-server-legacy.browser.production-DomU7vYx.js\":\"7ce3c5203ae03642\",\"/knowledge-medium/pr-preview/pr-1896/chunks/react-dom-server.browser.production-DG9F9axr.js\":\"c0a64b2a24d8a47c\",\"/knowledge-medium/pr-preview/pr-1896/chunks/react-dom-server.edge.production-Ckrn3M8p.js\":\"3e1cf6312655e417\",\"/knowledge-medium/pr-preview/pr-1896/chunks/server.browser-Cc9RcPpl.js\":\"664d267cf5282bd4\",\"/knowledge-medium/pr-preview/pr-1896/chunks/textarea-BYS7wHjV.js\":\"830f81d27c18447d\",\"/knowledge-medium/pr-preview/pr-1896/chunks/ui-Ca9jOnzo.js\":\"515f4a6b40485bc3\",\"/knowledge-medium/pr-preview/pr-1896/chunks/wa-sqlite-XZEgWpSy.js\":\"dabbdbb4e30fad1f\",\"/knowledge-medium/pr-preview/pr-1896/chunks/wa-sqlite-async-DWjbslWY.js\":\"15df2d1ac1aeedf9\",\"/knowledge-medium/pr-preview/pr-1896/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1896/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1896/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1896/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1896/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1896/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1896/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1896/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1896/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1896/src/App.js\":\"1e39866adffb7f7f\",\"/knowledge-medium/pr-preview/pr-1896/src/appUpdate.js\":\"b635ec5781c8a55f\",\"/knowledge-medium/pr-preview/pr-1896/src/appVersion.js\":\"6c5c7ab9a1efc7a7\",\"/knowledge-medium/pr-preview/pr-1896/src/bootstrap/initialLayout.js\":\"7cd06ded609152a1\",\"/knowledge-medium/pr-preview/pr-1896/src/bootstrap/openWorkspaceData.js\":\"c9e343b8b12057b2\",\"/knowledge-medium/pr-preview/pr-1896/src/bootstrap/resolveWorkspace.js\":\"99a923fcdc4111c9\",\"/knowledge-medium/pr-preview/pr-1896/src/bootstrap/workspaceBootstrap.js\":\"4c0170289e4f0466\",\"/knowledge-medium/pr-preview/pr-1896/src/components/BlockComponent.js\":\"07b3f0ad73e56ceb\",\"/knowledge-medium/pr-preview/pr-1896/src/components/BlockCrumbs.js\":\"a622eeaf59b6ebeb\",\"/knowledge-medium/pr-preview/pr-1896/src/components/BlockEditor.js\":\"964eed014ee74beb\",\"/knowledge-medium/pr-preview/pr-1896/src/components/BlockLoadingPlaceholder.js\":\"eb7fb8f29ab3c9ff\",\"/knowledge-medium/pr-preview/pr-1896/src/components/BlockProperties.js\":\"7378e8d638066a17\",\"/knowledge-medium/pr-preview/pr-1896/src/components/BlockSearchPicker.js\":\"0c23da13b1831648\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ConfirmBulkDeleteDialog.js\":\"3501d16fe2fb70ee\",\"/knowledge-medium/pr-preview/pr-1896/src/components/DividerHandle.js\":\"2c1a059ec4fb7657\",\"/knowledge-medium/pr-preview/pr-1896/src/components/DraftEditor.js\":\"cbfd64faac9e9769\",\"/knowledge-medium/pr-preview/pr-1896/src/components/GutterPill.js\":\"753048414c885984\",\"/knowledge-medium/pr-preview/pr-1896/src/components/Header.js\":\"0b4ad7c3c1ede7cc\",\"/knowledge-medium/pr-preview/pr-1896/src/components/LazyBlockComponent.js\":\"79d0dc9955da6b9a\",\"/knowledge-medium/pr-preview/pr-1896/src/components/Login.js\":\"844a834aaf6a26bf\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ZoomableSurface.js\":\"e34f4875f3a892d1\",\"/knowledge-medium/pr-preview/pr-1896/src/components/editModeKeepalive.js\":\"3914c4d2de3118fc\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyDisplay/PropertyDisplayScope.js\":\"cfaf5f172fe398d3\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"88b3045c1bb456f1\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyEditors/RefPropertyEditor.js\":\"d800c298a39772e3\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyEditors/RefTargetTypePicker.js\":\"e5add9d2e3d978a0\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyEditors/SelectPropertyEditor.js\":\"66ddaee7cf5a9171\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyEditors/TypesPropertyEditor.js\":\"b901639c2e7479d5\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyEditors/defaults.js\":\"0c1baaa174ef386b\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyEditors/kernelValuePresets.js\":\"f1714e9cc3023dc1\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyEditors/selectablePresets.js\":\"03545945f0b1ecdc\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyEditors/typesPropertyUi.js\":\"bf6d7ca51452cfe8\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyPanel/AddPropertyForm.js\":\"55483b7d1a76a43c\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyPanel/PropertyPicker.js\":\"022f3118b84c4af6\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyPanel/PropertyRow.js\":\"0c7e20fdbdb3ca60\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyPanel/Rows.js\":\"60cbae10ea46678d\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyPanel/actions.js\":\"eba6dd300f897be4\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyPanel/declarationOnly.js\":\"11ba108cdf254869\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyPanel/layout.js\":\"947e267c6021104e\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyPanel/model.js\":\"3255eeaa5b23fc2c\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyPanel/shapeUi.js\":\"39179a63e5f27cf6\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyPanel/shapes.js\":\"423091f3812fa529\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b5d50cae4da6cec4\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyPanel/visibility.js\":\"67725c5703fa1de2\",\"/knowledge-medium/pr-preview/pr-1896/src/components/propertyPanelSections.js\":\"e46abf2e9b7b7a69\",\"/knowledge-medium/pr-preview/pr-1896/src/components/references/BlockEmbed.js\":\"5bc30f33d1153829\",\"/knowledge-medium/pr-preview/pr-1896/src/components/references/BlockLink.js\":\"df48b6651524747d\",\"/knowledge-medium/pr-preview/pr-1896/src/components/references/BlockRef.js\":\"4032508533466441\",\"/knowledge-medium/pr-preview/pr-1896/src/components/references/CompactReferenceLink.js\":\"eeb25847de69e076\",\"/knowledge-medium/pr-preview/pr-1896/src/components/references/ReferenceLink.js\":\"098122c94bf4a7c3\",\"/knowledge-medium/pr-preview/pr-1896/src/components/references/cycleGuard.js\":\"a9060d5de63d304f\",\"/knowledge-medium/pr-preview/pr-1896/src/components/references/cycleGuardContext.js\":\"44a7814d3fd71cf0\",\"/knowledge-medium/pr-preview/pr-1896/src/components/references/linkInteraction.js\":\"086fd255ed32bac3\",\"/knowledge-medium/pr-preview/pr-1896/src/components/references/referenceLayout.js\":\"96421156536e9fc6\",\"/knowledge-medium/pr-preview/pr-1896/src/components/references/useBlockRefAncestors.js\":\"a2456b269baba756\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/BlockGutter.js\":\"15a7aa19d68f199a\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/BlockInfoDialog.js\":\"db027a83e4cadfd7\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/BlockReadText.js\":\"b08372dec1441b0a\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/BlockTypeBlockRenderer.js\":\"35005b35cad9b155\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/BulletHoverCard.js\":\"dce13ce96ebdb3ba\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/CodeMirrorContentRenderer.js\":\"2b4ce5059f6ffcf9\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"e25e568052b9b406\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/ColumnResizeHandles.js\":\"8589f7b7760dd855\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f4e347597786cfa5\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/DefaultBlockRenderer.js\":\"7061eae24f5a20a4\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/LayoutRenderer.js\":\"dbe257485a4df496\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/MarkdownContentRenderer.js\":\"fb55f787f4a662ce\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/MissingDataRenderer.js\":\"47172cebd072b801\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/PanelRenderer.js\":\"c02c987d5e412e46\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/PropertySchemaBlockRenderer.js\":\"3a56f8c9273ff413\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/TopLevelRenderer.js\":\"ec23088fd76139ec\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/blockGutterMode.js\":\"14c4e480998685e6\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/blockTitleText.js\":\"940091e0d4226d2d\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/fieldCreationKeydown.js\":\"cb0ef18e9163c3bc\",\"/knowledge-medium/pr-preview/pr-1896/src/components/renderer/layoutRootContext.js\":\"743be7240c5b4f13\",\"/knowledge-medium/pr-preview/pr-1896/src/components/typeChip/TypeChip.js\":\"4b3276a6fb8911a0\",\"/knowledge-medium/pr-preview/pr-1896/src/components/typeChip/chipStyle.js\":\"379dbed908891e1a\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/anchored-floating.js\":\"97f9107f19f28f21\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/button.js\":\"45e5979c84f32a0a\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/card.js\":\"32173bcab72899ed\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/checkbox.js\":\"554d49a08b92906a\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/collapsible.js\":\"d097b74753862edb\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/command.js\":\"e335a75ec2b650a0\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/context-menu.js\":\"3dbaeb034a16d51b\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/dialog.js\":\"e7e6b5e6fbfbe6c0\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/dropdown-menu.js\":\"62825fa1772f0143\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/floating-listbox.js\":\"9ae0b2052af569f8\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/index.js\":\"406118892ab93057\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/input.js\":\"9513f5eb85429f54\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/kbd.js\":\"86f2e8e0f8c270f5\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/label.js\":\"293437b0b25828f5\",\"/knowledge-medium/pr-preview/pr-1896/src/components/ui/textarea.js\":\"d7bb3400daa2337c\",\"/knowledge-medium/pr-preview/pr-1896/src/components/useEditModeYieldKeepalive.js\":\"590704f295958662\",\"/knowledge-medium/pr-preview/pr-1896/src/components/util/BootFallback.js\":\"78c9fd0df28e1839\",\"/knowledge-medium/pr-preview/pr-1896/src/components/util/FocusedRowLazyMount.js\":\"45dfc350ed2e47ae\",\"/knowledge-medium/pr-preview/pr-1896/src/components/util/LazyViewportMount.js\":\"2f5922a0e33daab0\",\"/knowledge-medium/pr-preview/pr-1896/src/components/util/LocalDbCorruptionFallback.js\":\"50e5db95def963d0\",\"/knowledge-medium/pr-preview/pr-1896/src/components/util/error.js\":\"09fdcfaeb2a32d8e\",\"/knowledge-medium/pr-preview/pr-1896/src/components/util/lazyMountRegistry.js\":\"354e630106d9142a\",\"/knowledge-medium/pr-preview/pr-1896/src/components/util/suspense.js\":\"ed7ebb6e3a1d7e48\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/CreateWorkspaceDialog.js\":\"0ad7fd04d320d584\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/PendingInvitations.js\":\"06e9cee379080865\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/SyncProgress.js\":\"aa2216ad3ae11257\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/UnlockProgress.js\":\"3ab29417281cf983\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/WorkspaceKeyGate.js\":\"b63cc84449655ecb\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/WorkspaceSettingsDialog.js\":\"e5b836c54aa86397\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/WorkspaceSwitcher.js\":\"5139207cf3515cdd\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/WorkspaceSyncGate.js\":\"e9e31bb3a5abce3b\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/conversion/ConversionFlow.js\":\"9506c54a531deca0\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/conversion/ConversionFlowHost.js\":\"16ffb6d92a36977b\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/conversion/EncryptionSection.js\":\"e55397a23cf64f7c\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/conversion/attachmentPrompts.js\":\"8aed93431df5adeb\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/conversion/bundleFolderPrompts.js\":\"448a527e3b9530c0\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/conversion/conversionFlowDeps.js\":\"515352c00cb575d3\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/conversion/conversionFlowStore.js\":\"75c5a66c823c714d\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/conversion/flowUi.js\":\"de1cf0391d7d5663\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/conversion/useConversionRun.js\":\"bf032c44baef2e23\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/keyUi.js\":\"3cf7fd39f6997957\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/useCloseOnKeyLoss.js\":\"1f30776a47c7ec22\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/useCloseOnServerE2ee.js\":\"6bfbcbf95add64fc\",\"/knowledge-medium/pr-preview/pr-1896/src/components/workspace/workspaceUnlocked.js\":\"7dd1ee7dc0c5fc42\",\"/knowledge-medium/pr-preview/pr-1896/src/context/backgroundSubtree.js\":\"98550cb096127fdc\",\"/knowledge-medium/pr-preview/pr-1896/src/context/block.js\":\"ee7754eac7fe32dd\",\"/knowledge-medium/pr-preview/pr-1896/src/context/layoutWsContext.js\":\"e72eefa93b461f8d\",\"/knowledge-medium/pr-preview/pr-1896/src/context/propertyDisplay.js\":\"7a420a1d22de2747\",\"/knowledge-medium/pr-preview/pr-1896/src/context/repo.js\":\"4201789eeed7a6c3\",\"/knowledge-medium/pr-preview/pr-1896/src/data/aliasClaim.js\":\"04216cef4c64cfa1\",\"/knowledge-medium/pr-preview/pr-1896/src/data/aliasSeatNamespace.js\":\"8b08ce7459e45411\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/blockData.js\":\"839264c854a4d046\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/blockType.js\":\"9f308bb023e53d35\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/changeScope.js\":\"faec73c1a1f088a3\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/codecs.js\":\"7d75ba516bf547ee\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/derivedData.js\":\"157994845793a43f\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/errors.js\":\"dd5393ce394f5763\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/events.js\":\"f67a20524e22110c\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/handle.js\":\"9b28c47eab61ea6d\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/index.js\":\"3554db0c9fd2280c\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/mutator.js\":\"062259c9315665ef\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/processor.js\":\"2fc237e57095f790\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/propertySchema.js\":\"4a5bb548a9ea935a\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/query.js\":\"5d0bf80632d37b07\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/sameTxProcessor.js\":\"15ff0743dc11d342\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/schema.js\":\"9b28c47eab61ea6d\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/tx.js\":\"9b28c47eab61ea6d\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/typedBlockQuery.js\":\"41efc9a4c09ddedf\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/user.js\":\"7d712abc8a419165\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/valuePresetCore.js\":\"edabe522f3d3902d\",\"/knowledge-medium/pr-preview/pr-1896/src/data/api/valuePresets.js\":\"dcfe9e1e6ce55b64\",\"/knowledge-medium/pr-preview/pr-1896/src/data/attachmentCleanerIOVerb.js\":\"7d8d5485adfa2036\",\"/knowledge-medium/pr-preview/pr-1896/src/data/block.js\":\"b515d2ba83e83f63\",\"/knowledge-medium/pr-preview/pr-1896/src/data/blockCache.js\":\"9b071da718576070\",\"/knowledge-medium/pr-preview/pr-1896/src/data/blockId.js\":\"f47f18f465fc4cf8\",\"/knowledge-medium/pr-preview/pr-1896/src/data/blockLiveness.js\":\"680f1ad0ac94d624\",\"/knowledge-medium/pr-preview/pr-1896/src/data/blockMerge.js\":\"06527dab703ac2d7\",\"/knowledge-medium/pr-preview/pr-1896/src/data/blockSchema.js\":\"e75708e288c0e40f\",\"/knowledge-medium/pr-preview/pr-1896/src/data/blockTypeLookup.js\":\"521e3836c9ea4cab\",\"/knowledge-medium/pr-preview/pr-1896/src/data/blockTypes.js\":\"7c3bcbc4d0d7c8f1\",\"/knowledge-medium/pr-preview/pr-1896/src/data/childrenView.js\":\"fde6510ec4ac7ebb\",\"/knowledge-medium/pr-preview/pr-1896/src/data/clientContext.js\":\"84691083b8347af4\",\"/knowledge-medium/pr-preview/pr-1896/src/data/dbFileSiblings.js\":\"e7d473764effa46e\",\"/knowledge-medium/pr-preview/pr-1896/src/data/definitionSeeds.js\":\"314c87cc67673fa6\",\"/knowledge-medium/pr-preview/pr-1896/src/data/derivedIds.js\":\"87caea6384c9257f\",\"/knowledge-medium/pr-preview/pr-1896/src/data/drawnSubtree.js\":\"cf7951df18209d89\",\"/knowledge-medium/pr-preview/pr-1896/src/data/facetBridge.js\":\"2f24a87f3642f9fa\",\"/knowledge-medium/pr-preview/pr-1896/src/data/facets.js\":\"7ee841deb864f00b\",\"/knowledge-medium/pr-preview/pr-1896/src/data/globalState.js\":\"1538a0a2e1e0afe3\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/aliasClaimRederiveProcessor.js\":\"a929845c474a38c3\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/ancestorBatch.js\":\"7390c5fa690b95be\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/blockTypeTypeifyProcessor.js\":\"02bd943493038703\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/clientSchema.js\":\"789e6ff66328b5ec\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/commitPipeline.js\":\"3b7139f7daa59201\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/devAssertions.js\":\"eaab0c210cb1db34\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/firstSync.js\":\"203ffb808085fed2\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/freshInitialLoad.js\":\"0016435538bfa820\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/graphBackfillClaim.js\":\"50aa21a775d108f7\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/handleStore.js\":\"4efc4278db0ee03b\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/idleMarkerJobs.js\":\"6e7241d2d61ea84c\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/initialDownload.js\":\"693bc983b9590c9f\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/initializeClientDatabase.js\":\"e63106f347530817\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/jsonCanonical.js\":\"9bbc4b3b590fcc76\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/kernelInvalidation.js\":\"79f9456f5bcf36ec\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/kernelProcessors.js\":\"4d23cdab4e87c328\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/kernelQueries.js\":\"e7e40c44d1d4b7e1\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/mergeTypeMembershipProcessor.js\":\"5e9cd1501ae55202\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/normalizeReferencesProcessor.js\":\"26c64588dd334c54\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/poolInstrumentation.js\":\"b4bd1de791718029\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/processorRunner.js\":\"0e2c7c53a5a4b1b8\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/propertyCellBackfill.js\":\"6c7c1bcc3d01f8a9\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/propertyChildMint.js\":\"83baa2343aaf8d41\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/propertyChildrenProcessor.js\":\"a513beba51dac22a\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2edd9be862077f17\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/propertyDefinitionSynthesis.js\":\"23b3e1f04b2ecf58\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/propertyKeyScan.js\":\"64787fcc142f7fa7\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/propertySchemaResolution.js\":\"f7a2af526bf9299b\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/propertyValueEdits.js\":\"1713b097712e5d34\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/raiseProtocol.js\":\"84d5008cf3d8e0b1\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/readBatch.js\":\"a69371a4748eebde\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/refProjection.js\":\"3509f8c645a550d1\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/referenceTargetLookups.js\":\"70163539ad941225\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/referenceTargetProcessor.js\":\"6a6401a0cc3477f7\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/replayMerge.js\":\"c1bad40abeb59fde\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/sqlBinds.js\":\"ab4ff5e8ae6d56ac\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"2de9dc2f4de08c77\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/syncObserver/arrivalProcessors.js\":\"8649bb017300a4dc\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/syncObserver/invalidate.js\":\"683de5ad97610ee1\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/syncObserver/materialize.js\":\"e744cc743e674701\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/syncObserver/observer.js\":\"5dd4a147df6f100b\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/syncObserver/reconcile.js\":\"a446c7b39620ff8e\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/timingMetrics.js\":\"e85ef4e0d3ceca81\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/treeQueries.js\":\"b6d7221ea8f83fb1\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/txEngine.js\":\"46560aa94d6b78ff\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/txSnapshots.js\":\"d1eb3a02c0828bfb\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/typedBlockQuery.js\":\"ab2720df414f4142\",\"/knowledge-medium/pr-preview/pr-1896/src/data/internals/undoManager.js\":\"9ff96b6277d2f9bb\",\"/knowledge-medium/pr-preview/pr-1896/src/data/invalidation.js\":\"912d9015ec310133\",\"/knowledge-medium/pr-preview/pr-1896/src/data/kernelDataExtension.js\":\"f4f420d61d7e014e\",\"/knowledge-medium/pr-preview/pr-1896/src/data/kernelPage.js\":\"1cc9e2d3dbc1a104\",\"/knowledge-medium/pr-preview/pr-1896/src/data/kernelValuePresetCores.js\":\"b0f42c1bf788a570\",\"/knowledge-medium/pr-preview/pr-1896/src/data/localDbCorruptionSignal.js\":\"5ab96fbc87ae37fa\",\"/knowledge-medium/pr-preview/pr-1896/src/data/localDbStorage.js\":\"8f0c10240b3c4c9e\",\"/knowledge-medium/pr-preview/pr-1896/src/data/localDbVfs.js\":\"9ca2ff361244d331\",\"/knowledge-medium/pr-preview/pr-1896/src/data/localSchema.js\":\"a71dd0a53b764b5b\",\"/knowledge-medium/pr-preview/pr-1896/src/data/maintenance.js\":\"4730c3fee25057cb\",\"/knowledge-medium/pr-preview/pr-1896/src/data/mergeProperties.js\":\"403c46678e8f6272\",\"/knowledge-medium/pr-preview/pr-1896/src/data/metricsConsoleHook.js\":\"fbbdb47472257de9\",\"/knowledge-medium/pr-preview/pr-1896/src/data/migrationsPage.js\":\"440fd8259f1bd8c0\",\"/knowledge-medium/pr-preview/pr-1896/src/data/mutators.js\":\"a833d3283ada612e\",\"/knowledge-medium/pr-preview/pr-1896/src/data/orderKey.js\":\"da5111610e3ad0f1\",\"/knowledge-medium/pr-preview/pr-1896/src/data/orderKeyPlacement.js\":\"c9530f6f31ba9764\",\"/knowledge-medium/pr-preview/pr-1896/src/data/outlineSurface.js\":\"34693a426fd64c81\",\"/knowledge-medium/pr-preview/pr-1896/src/data/pendingEditorContent.js\":\"9a1603567761134a\",\"/knowledge-medium/pr-preview/pr-1896/src/data/pendingUploadsSql.js\":\"6c4d05878ec1b8f9\",\"/knowledge-medium/pr-preview/pr-1896/src/data/pluginStateExtensions.js\":\"fc524be41947b759\",\"/knowledge-medium/pr-preview/pr-1896/src/data/powerSyncLogger.js\":\"ba5cb120dbe1779a\",\"/knowledge-medium/pr-preview/pr-1896/src/data/projectorRuntime.js\":\"74d70b891951fde5\",\"/knowledge-medium/pr-preview/pr-1896/src/data/properties.js\":\"84ac28fb1673679c\",\"/knowledge-medium/pr-preview/pr-1896/src/data/propertiesPage.js\":\"2f03fc0cfe5b8610\",\"/knowledge-medium/pr-preview/pr-1896/src/data/propertyChildren.js\":\"10c9c88344f0eb65\",\"/knowledge-medium/pr-preview/pr-1896/src/data/propertyDefinitionFanout.js\":\"3075f5f099f4bb89\",\"/knowledge-medium/pr-preview/pr-1896/src/data/propertyDefinitionMetadata.js\":\"2ecf097326a7356f\",\"/knowledge-medium/pr-preview/pr-1896/src/data/propertyDefinitionRegistry.js\":\"3baffc77adbc28b9\",\"/knowledge-medium/pr-preview/pr-1896/src/data/propertyDisplayMode.js\":\"2982dad216f390d7\",\"/knowledge-medium/pr-preview/pr-1896/src/data/propertyRowCreation.js\":\"7f441284b4862c4c\",\"/knowledge-medium/pr-preview/pr-1896/src/data/propertySchemaCreation.js\":\"0b0b8ae176058f41\",\"/knowledge-medium/pr-preview/pr-1896/src/data/propertySeeds.js\":\"bbcc425f93a140c4\",\"/knowledge-medium/pr-preview/pr-1896/src/data/recentsPage.js\":\"9361a30478318a98\",\"/knowledge-medium/pr-preview/pr-1896/src/data/refTargetComparableProperty.js\":\"4e03055441f30a4c\",\"/knowledge-medium/pr-preview/pr-1896/src/data/referenceBlock.js\":\"9509d85776661a51\",\"/knowledge-medium/pr-preview/pr-1896/src/data/rejectedUploads.js\":\"1e74e8c8f30d332d\",\"/knowledge-medium/pr-preview/pr-1896/src/data/releasePowerSyncConnection.js\":\"99cb1465c535677e\",\"/knowledge-medium/pr-preview/pr-1896/src/data/repo.js\":\"920f51ce762313a6\",\"/knowledge-medium/pr-preview/pr-1896/src/data/repoProvider.js\":\"399c5b7920603bf9\",\"/knowledge-medium/pr-preview/pr-1896/src/data/rowProperty.js\":\"75e15726d53d9c7d\",\"/knowledge-medium/pr-preview/pr-1896/src/data/searchFilter.js\":\"bf608126b933c774\",\"/knowledge-medium/pr-preview/pr-1896/src/data/seedIdentityLedger.js\":\"56f03c133ce1803c\",\"/knowledge-medium/pr-preview/pr-1896/src/data/stateBlocks.js\":\"d648c9af50ca63d1\",\"/knowledge-medium/pr-preview/pr-1896/src/data/structuralEditPolicy.js\":\"b8c5619a0a93c28c\",\"/knowledge-medium/pr-preview/pr-1896/src/data/structuralInsert.js\":\"5f3efd40d7b65ad3\",\"/knowledge-medium/pr-preview/pr-1896/src/data/subtreeDelete.js\":\"2f26d6812896f175\",\"/knowledge-medium/pr-preview/pr-1896/src/data/syncStreamLock.js\":\"ca4dcff3dc90b19e\",\"/knowledge-medium/pr-preview/pr-1896/src/data/syncedTableSqlRecognizer.js\":\"4b28619849dfef19\",\"/knowledge-medium/pr-preview/pr-1896/src/data/syncedTableWriteGuard.js\":\"bd190757d3c5919e\",\"/knowledge-medium/pr-preview/pr-1896/src/data/targets.js\":\"98e90a5e484bd93c\",\"/knowledge-medium/pr-preview/pr-1896/src/data/typeColors.js\":\"23e29a43055aa57d\",\"/knowledge-medium/pr-preview/pr-1896/src/data/typeDefinitionMetadata.js\":\"7aa1d08e937d4740\",\"/knowledge-medium/pr-preview/pr-1896/src/data/typeDefinitionRegistry.js\":\"a2b9515c3b3ac950\",\"/knowledge-medium/pr-preview/pr-1896/src/data/typeExtraction.js\":\"fc74de9b798da3f1\",\"/knowledge-medium/pr-preview/pr-1896/src/data/typeInitialValues.js\":\"4438df66dd8ea86e\",\"/knowledge-medium/pr-preview/pr-1896/src/data/typePropertyGroups.js\":\"761974b1ff3c7a43\",\"/knowledge-medium/pr-preview/pr-1896/src/data/typeSeeds.js\":\"e9b7a39f6deb0e05\",\"/knowledge-medium/pr-preview/pr-1896/src/data/typeTagger.js\":\"8ae4ae87558fd672\",\"/knowledge-medium/pr-preview/pr-1896/src/data/typedRecords.js\":\"a49ca7488e4b037c\",\"/knowledge-medium/pr-preview/pr-1896/src/data/typesPage.js\":\"5c5fa10cc75ca3b0\",\"/knowledge-medium/pr-preview/pr-1896/src/data/userPrefs.js\":\"c984e0ba0caec045\",\"/knowledge-medium/pr-preview/pr-1896/src/data/userSchemasService.js\":\"069b20155552a7db\",\"/knowledge-medium/pr-preview/pr-1896/src/data/userTypesService.js\":\"922497d0a976c6b0\",\"/knowledge-medium/pr-preview/pr-1896/src/data/valuePresetRegistry.js\":\"954565554458208c\",\"/knowledge-medium/pr-preview/pr-1896/src/data/visibleChildren.js\":\"9b040d892112e7bf\",\"/knowledge-medium/pr-preview/pr-1896/src/data/workspaceConversion.js\":\"f4b40829ce858c41\",\"/knowledge-medium/pr-preview/pr-1896/src/data/workspaceFirstSync.js\":\"34a3ae2e438f5320\",\"/knowledge-medium/pr-preview/pr-1896/src/data/workspaceIdNamespace.js\":\"a19bb872746e7feb\",\"/knowledge-medium/pr-preview/pr-1896/src/data/workspaceSchema.js\":\"3e05a8d58d5e36ab\",\"/knowledge-medium/pr-preview/pr-1896/src/data/workspaces.js\":\"3999e1edd9b74926\",\"/knowledge-medium/pr-preview/pr-1896/src/data/writeAheadLog.js\":\"cb992f90d09cfe92\",\"/knowledge-medium/pr-preview/pr-1896/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1896/src/editor/BlockPasteShellDecorator.js\":\"6f2449bb8be8e170\",\"/knowledge-medium/pr-preview/pr-1896/src/editor/atTrigger.js\":\"c18a611d19ddfcb4\",\"/knowledge-medium/pr-preview/pr-1896/src/editor/autocomplete.js\":\"84f1e3d539237677\",\"/knowledge-medium/pr-preview/pr-1896/src/editor/codeMirrorExtensions.js\":\"f590df0c53a57566\",\"/knowledge-medium/pr-preview/pr-1896/src/editor/contentFlush.js\":\"1904d2ba72fbf3f5\",\"/knowledge-medium/pr-preview/pr-1896/src/editor/defaultInteractions.js\":\"3aa706b202cef3e0\",\"/knowledge-medium/pr-preview/pr-1896/src/editor/editSettleSignal.js\":\"35c639498935af78\",\"/knowledge-medium/pr-preview/pr-1896/src/editor/insertImage.js\":\"25a1859975cb5161\",\"/knowledge-medium/pr-preview/pr-1896/src/editor/referenceCompletionRange.js\":\"89879c425c14288a\",\"/knowledge-medium/pr-preview/pr-1896/src/editor/referenceTargetTypes.js\":\"491fd73fcc089227\",\"/knowledge-medium/pr-preview/pr-1896/src/editor/syntaxContext.js\":\"23e36ea5ffdc6171\",\"/knowledge-medium/pr-preview/pr-1896/src/editor/triggerMatch.js\":\"226536cddd2325ad\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/AppRuntimeProvider.js\":\"ef309d7d8639cc86\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/BlockFocusShellDecorator.js\":\"363b459c0c8209eb\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/ExtensionRenderBoundary.js\":\"bb1bc52c6bee9ac6\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/PanelContentRecovery.js\":\"6fbf3939e318d8d8\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/apiCatalog.js\":\"e77b646bdebb75c3\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/approveExtensionHere.js\":\"445b2d4b5302debc\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/armedCutAppMount.js\":\"68de6d54a1052061\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/batchableKeyedStore.js\":\"412aa26160190660\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/blockInteraction.js\":\"6621b7e19519233d\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/blockSelectionAction.js\":\"0cbfe653c1576ae7\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/compileExtensionModule.js\":\"2c471baa7c92f7c2\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/compiledModuleCache.js\":\"2381332325ea74df\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/continuousGestures.js\":\"c94a23f7c0a0199f\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/core.js\":\"9ead820b74e0b1b3\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/defaultRenderers.js\":\"f8b03fdc60fdfd13\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/definitionFanoutAppMount.js\":\"809ac6a49fb781ec\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/dialogAppMount.js\":\"1d2c6da7e25788b1\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/dynamicExtensionSeeds.js\":\"c7917bf96a67991e\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/dynamicExtensions.js\":\"f917640698063f94\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/exampleExtensions.js\":\"d89d41eb5156e429\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/extensionApprovalStatus.js\":\"8ea161bfe26309eb\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/extensionLoadErrorToast.js\":\"8007ea2b9c20c037\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/extensionLoadErrors.js\":\"fa4eaa072d70612d\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/extensionLookup.js\":\"f7c6a42ae1b4f90f\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/extensionToggles.js\":\"01fae0a541779248\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/extensionUtilitiesCss.js\":\"186d4dc8baef5c28\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/kernelPageDeletionGuard.js\":\"27b42fd794247b12\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/liveRuntime.js\":\"dffb8f2b44cefef2\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/openExtensionsSettings.js\":\"27c27d852ababe55\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/overridesCache.js\":\"e1e85f3751797843\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/pluginIds.js\":\"8d531a247469c8d4\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/processorRejectionToast.js\":\"f87cadb5fe7d9592\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/runtimeActions.js\":\"ed4febcf12a4bee1\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/runtimeContext.js\":\"727e110ec6780d8b\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/staticAppExtensions.js\":\"ebbeb6f131840f12\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/staticDataExtensions.js\":\"0fc292c042a29034\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/toastAppMount.js\":\"084ef93b297a272d\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/useOverrides.js\":\"29ac3e45f6621e38\",\"/knowledge-medium/pr-preview/pr-1896/src/extensions/useShortcutSurfaceActivations.js\":\"f9548a1075976130\",\"/knowledge-medium/pr-preview/pr-1896/src/facets/discoverToggleTree.js\":\"e48663ac82f81c7b\",\"/knowledge-medium/pr-preview/pr-1896/src/facets/facet.js\":\"3917cf02c4601f00\",\"/knowledge-medium/pr-preview/pr-1896/src/facets/resolveAppRuntime.js\":\"6bb182c51080ef10\",\"/knowledge-medium/pr-preview/pr-1896/src/facets/runtimeEvents.js\":\"6f2d08ee727da9b6\",\"/knowledge-medium/pr-preview/pr-1896/src/facets/togglable.js\":\"b9d9cb3259ddd110\",\"/knowledge-medium/pr-preview/pr-1896/src/facets/variantFacet.js\":\"a1fbae1daafbb11f\",\"/knowledge-medium/pr-preview/pr-1896/src/facets/verbFacet.js\":\"972540d163e76cd7\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/block.js\":\"1bfd5cce6c0b9815\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/focusedChild.js\":\"a99fce6d6dbc8968\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/propertySchemas.js\":\"add11ba516ab7a36\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/typeRegistry.js\":\"ecedf285f0ce980c\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/useAncestorCrumbs.js\":\"39c5a26ea9ad89ff\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/useAutocompleteListbox.js\":\"45fb97af1ea83ca6\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/useDebouncedSearch.js\":\"a8f509ae47ee3bf2\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/useDebouncedValue.js\":\"20ae242782d270be\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/useFacetValue.js\":\"65220e871ffe1a16\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/useIsFocalRender.js\":\"466fbd1189419743\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/useIsReadOnly.js\":\"29359dad9d92a7ff\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/useMaterializeBacklog.js\":\"a4c0bc91eac050bb\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/useMinuteClock.js\":\"eec5db8c74774f2d\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/usePanelLayoutProjection.js\":\"17de50aaa3b1ffb4\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/usePendingInvitations.js\":\"d64809d8dc308c34\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/useRendererRegistry.js\":\"b36e804ef327c439\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/useRetainedFieldRows.js\":\"afa7fca89364ec64\",\"/knowledge-medium/pr-preview/pr-1896/src/hooks/useWorkspaces.js\":\"5fc26dd05bb7b97a\",\"/knowledge-medium/pr-preview/pr-1896/src/lib/utils.js\":\"a9563af822c6299a\",\"/knowledge-medium/pr-preview/pr-1896/src/main.js\":\"044c9439d7314f33\",\"/knowledge-medium/pr-preview/pr-1896/src/markdown/MarkdownImage.js\":\"2735fbe079be72b4\",\"/knowledge-medium/pr-preview/pr-1896/src/markdown/blockSeparators.js\":\"cb75204e70e2cbd3\",\"/knowledge-medium/pr-preview/pr-1896/src/markdown/context.js\":\"fe7da9a3e21ec339\",\"/knowledge-medium/pr-preview/pr-1896/src/markdown/defaultMarkdownExtension.js\":\"df8fd8f882182606\",\"/knowledge-medium/pr-preview/pr-1896/src/markdown/extensions.js\":\"42dd13d26c3b1760\",\"/knowledge-medium/pr-preview/pr-1896/src/markdown/renderMarkdownHtml.js\":\"b75509f425f44037\",\"/knowledge-medium/pr-preview/pr-1896/src/minimal-editor.js\":\"51a702f311dae9c4\",\"/knowledge-medium/pr-preview/pr-1896/src/paste/armedCut.js\":\"22d7ce78362eda1a\",\"/knowledge-medium/pr-preview/pr-1896/src/paste/captureMediaVerb.js\":\"48341e051c559ce3\",\"/knowledge-medium/pr-preview/pr-1896/src/paste/clipboard.js\":\"f8163de12f792eb2\",\"/knowledge-medium/pr-preview/pr-1896/src/paste/decision.js\":\"2c33afc9b9500b61\",\"/knowledge-medium/pr-preview/pr-1896/src/paste/operations.js\":\"0e386551d8a93a17\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/account-header/AccountHeaderItem.js\":\"1f9d10c81748b393\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/account-header/index.js\":\"362eddb202c93408\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b86d09c1e45bf97d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-dispatch-companion/askAgent.js\":\"3c079c115b71aa76\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-dispatch-companion/askedStore.js\":\"e0d080c0ce8ac556\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"c199f669eac0a521\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-dispatch-companion/chipState.js\":\"723fcd4d5a2e27f2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-dispatch-companion/dataExtension.js\":\"20cf867593e48864\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-dispatch-companion/index.js\":\"c296e31aa6e6a685\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"39435bcb545f85a9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-dispatch-companion/schema.js\":\"2e1ff82c4d1a0713\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8b7ec4a29f676207\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/BridgePairingDialog.js\":\"737fbc1827492473\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/addMedia.js\":\"79ebce93519895c0\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a4c8bed9602ba285\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentViews/block.js\":\"4d9f338d16e9c23e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentViews/context.js\":\"f36086324724a45a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentViews/displayIds.js\":\"6236ef43f3d215b9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentViews/index.js\":\"29bfefa9a17769c9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentViews/outline.js\":\"01dae88d7fb65806\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentViews/properties.js\":\"a75bb5100f414534\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentViews/refs.js\":\"4fe3c5e12c38e0c4\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b8edf572426dc887\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentViews/search.js\":\"03f9941712ec9623\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentViews/shared.js\":\"f0cc145c82b4c333\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"b4cebd8c4067dcb8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentViews/text.js\":\"1d0acfce498d8a19\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/agentWrites.js\":\"06c4c9780eba7354\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/authoringCatalog.js\":\"1baab93a0ebd7cd2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/blockRefTargets.js\":\"578a89ad8bd12280\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/bridge.js\":\"6bbe3c8755386296\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/bridgeLoop.js\":\"4ae4032b6cceab23\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/changeHistory.js\":\"c58bdddf65aef6ab\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/commands.js\":\"f47d64007684a73f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/commentsCommands.js\":\"bb92bb2166375979\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/dataExtension.js\":\"f441c48ad272284c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/dataModelGuide.js\":\"02b1cb64e36ae003\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/dayPropertyInputs.js\":\"14ab345e79ad662e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/describeRuntime.js\":\"3251bae190eed46e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/extensionLint.js\":\"e89c34269a3ca636\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/grainAudit.js\":\"addbd03e54fa44b7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/healthCommand.js\":\"1584c12ba9b649c4\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/index.js\":\"9a941d899575e38b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/presetIdentity.js\":\"9e38374b4bf26656\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5737dd1c950e8ae8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/readMedia.js\":\"e2fac91f13372083\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/schema.js\":\"1e1f0d8688af1e8a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/serialization.js\":\"d134b6dc67bfd48c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/targets.js\":\"4422817d3585a8dd\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/tokens.js\":\"1292c9d69abc736d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/watchEvents.js\":\"a00569ec6884d36a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/workspaceGuard.js\":\"1942780e4ba7ad37\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/agent-runtime/writeCommands.js\":\"7866b26532d3fadf\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/alias/AliasCollisionToast.js\":\"327ee0d7d9504a15\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/alias/DuplicateNameBanner.js\":\"787136bd2e43910d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/alias/collisionMerge.js\":\"855a8f0595b78aec\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/alias/dataExtension.js\":\"c3db6f8789de82d6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/alias/index.js\":\"541a8c4afe578e23\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/alias/mergeCollisionAction.js\":\"2a50a22fe5f89cf8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/alias/pageStyling.js\":\"cdbed40b661ee4a7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/alias/rejectionToast.js\":\"bc17082065e51f70\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/alias/syncProcessor.js\":\"64742c0fbf4cf897\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/actions.js\":\"3f8def4f0a7ad812\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/addComment.js\":\"6b8eef6ee918c421\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/anchor.js\":\"26a69f75937363a6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/anchorState.js\":\"a77b0ad878fccb92\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/commentLinks.js\":\"c4485ae8853f006d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/confirmThreadDeletion.js\":\"dac0116a9af833da\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/container.js\":\"e2dcc6a355375846\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/dataExtension.js\":\"eafdcf14f7aac6d2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/deleteComment.js\":\"43af1f08a47c472c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/highlights.js\":\"e15671a900146281\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/index.js\":\"e0d8079d5d7729c7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/linkedCommentsPill.js\":\"eddd668d3e211469\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/margin.js\":\"e1272a537b05cdf8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/marginAnchorLinks.js\":\"3d4dda69eb06cdff\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/marginSchema.js\":\"952e7f2e25d0de52\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/newComment.js\":\"b4cdc60f1db8e49b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/ownThreadPicker.js\":\"d5d87d38b1b12382\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/placement.js\":\"7efce06f1fbcb769\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/queries.js\":\"f320a90323ae85a6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/quotePosition.js\":\"25c48cf642a765e7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/quotedIn.js\":\"19bf25001f4e1e7b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/quotedRange.js\":\"fd149ad25e576d1f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/rangeRefs.js\":\"18989c3c8f8f497b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/readHighlights.js\":\"d0af76e385a3385c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/readSelection.js\":\"1616c788555691c0\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/readSelectionUi.js\":\"f7801891ae8a8ae0\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/reanchor.js\":\"7f522dab9a50ea8a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/schema.js\":\"42ee9e32dae9b75a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/scope.js\":\"a6eaabd475a4e93a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/scopeThreads.js\":\"700622e4c50d3302\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/splitRetarget.js\":\"826f1986c6126edd\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/suggestionCard.js\":\"86e88f4ef156fb07\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/suggestions.js\":\"83727fdd73e62991\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/summaries.js\":\"0ff7823679990cda\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/summaryBatch.js\":\"fcf357c990301473\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/surface.js\":\"b7c26e49c3fb7378\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/threadNavigation.js\":\"8769cbd063fcb024\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/threads.js\":\"7495211443a723ae\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/ui.js\":\"f73d3b4c91edfa23\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/annotations/uiStore.js\":\"78d64d119e56669a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/app-intents/appIntents.js\":\"306eab4be21f9612\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/app-intents/index.js\":\"6bf93f22ddb62e84\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/app-update-prompt/index.js\":\"7c6d9a940827da34\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/app-update-prompt/status.js\":\"f38b04165095fe93\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f4dc60fd9dba960d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/MediaBlockRenderer.js\":\"248b44dcdc2f5f01\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/MediaDownLaneReplicator.js\":\"06f056bd48eb1255\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/MediaUploadReconciler.js\":\"08b87b7702115e76\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/assetDownLane.js\":\"c04ad9b89ad2899a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/assetResolver.js\":\"30114521a014f1c2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/assetUpload.js\":\"b744c22911f139b8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/attachmentCleanerIO.js\":\"1d8f22ac03aad6d1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/audit/supabaseAuditIO.js\":\"0c69a235812cd770\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/blobStore.js\":\"1e2a9f1c52ebf919\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/browserMedia.js\":\"23ecdc181c8a8681\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/byteStore.js\":\"94eadaf84ff4561d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/cleanerIO.js\":\"f1bc3616abbf9a77\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/cleanupAttachments.js\":\"39d32f6ed27fdd69\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/dataExtension.js\":\"d2bdc9dc294741aa\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/downLane.js\":\"604984dbd3182f45\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/index.js\":\"b0304f1dc278ba37\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/insertImageContribution.js\":\"f0fae59ada210211\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/laneArming.js\":\"366e74734653f55c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/laneLock.js\":\"0d54e72345fe29a0\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/mediaBlock.js\":\"79a3c37c4846e10b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/mediaCapture.js\":\"c855d7d1b2cf5b0f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/mediaLanes.js\":\"ade70877817a2821\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/mediaViewers.js\":\"6d14ce038748accb\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/mediaViewersFacet.js\":\"a7af41620822bcac\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/pasteCapture.js\":\"b3711fab0ca3179c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/resolver.js\":\"a7fe011d8c8390db\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/retryUploadsAction.js\":\"d88388c2fa834ef2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/storagePaths.js\":\"3b23ef47b294b909\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/uploadDrain.js\":\"fd910058e1ae2bee\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/uploadLaneStatus.js\":\"e49b8d7b225ca55f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/uploadReconcile.js\":\"88e2262e1c73f486\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/uploadRecovery.js\":\"9b5475abda4e52ec\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/uploadStore.js\":\"fb9d1a217415dd69\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/attachments/useAssetObjectUrl.js\":\"1c3218c45b0f5a40\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d6e955d7e905f1cb\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks-view/BacklinksViewSection.js\":\"55e4b697c21c33ff\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks-view/facet.js\":\"85aca7b76350ba05\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks-view/index.js\":\"8614ca4a37ee0204\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks-view/prop.js\":\"203088309896249f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/BacklinkFilters.js\":\"f99a4e3e4cf91c8e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"34ac28fc7c4a55f3\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/BlockEntry.js\":\"3bda0b766db0d91e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/LinkedReferences.js\":\"54bc20d65b62f28a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"15768176bea6b6d6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/dailyNoteDefaults.js\":\"2976d80c890010d9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/dataExtension.js\":\"5628851226879133\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/edgeExclusions.js\":\"10c9c7cf2c578a57\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/filterProperty.js\":\"27f8249b4a25a490\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/index.js\":\"203dc4c37a9d3117\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"73eb1ec594b741f2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/inline-counts/applies.js\":\"34243c5fd37503e8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/inline-counts/countQuery.js\":\"5b2972b642c243e8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/inline-counts/expansionStore.js\":\"571bb728bb5200ad\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/inline-counts/index.js\":\"68dada8fb0d556fe\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e425d0e088115b3e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/presentationInvalidation.js\":\"540e5dc0e1c0a81f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/propertyEditorOverride.js\":\"da78aac2215a7aa9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/propertyFilter.js\":\"eaaaff250e32378b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/query.js\":\"21ee9944c8843465\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/resolveFilter.js\":\"77e1f971343a32be\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/sourceBatch.js\":\"771ff0081441a58e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/sources.js\":\"362de840e7981c4f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/useBacklinks.js\":\"db6e4fbef62317c3\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"0578be35b5f7f37c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/birthday/BirthdayCelebration.js\":\"df2f0e2e149d66ad\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/birthday/BirthdayOverlay.js\":\"1da39d7af83dc93d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/birthday/gate.js\":\"e3cfa7566b19327f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/birthday/index.js\":\"5cb3f94432c9c1c1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/birthday/wolfTheme.js\":\"4393f035c14e1ed0\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-drag/BlockDragLayer.js\":\"b5cdeb69e263c316\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-drag/dragController.js\":\"67b305963e0b2c51\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-drag/dropTarget.js\":\"982ca798a8a1ac1c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-drag/index.js\":\"3a6d539ac674836c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-drag/projection.js\":\"f304ba228f60eea2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-info/BlockMetaCard.js\":\"3f4ac4e26a2bef31\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-info/index.js\":\"6b4637e5b9cea429\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-tagging/AddTagDialog.js\":\"cec4b830b8e3f998\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c2a0a38c2ead7c4b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-tagging/TagNameIssueHint.js\":\"c82bcbc94a7625c0\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-tagging/addTagAction.js\":\"dbad67ded8792d44\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-tagging/appendTag.js\":\"c39c37be993569a9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-tagging/config.js\":\"52a47d5cae8e333e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-tagging/dataExtension.js\":\"b0ac5583ff58d7a9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-tagging/index.js\":\"d60ae09625c1c955\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/block-tagging/propertyEditorOverride.js\":\"290203ffb8a60e7c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c3ba602c4f737f9d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"61313984bc3b3295\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5626124b140ed130\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b11dc7dd4aeff777\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"6d5e6d9ccc57743b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/breadcrumbs/index.js\":\"2b014672bea08ac1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"935482011c3c1c68\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/character-counter/CharacterCountItem.js\":\"104a3d5bae78273b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/character-counter/ProfilePropertyEditor.js\":\"505b7abae5c246a3\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/character-counter/actions.js\":\"2a363550dc9d4887\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/character-counter/blockType.js\":\"de465bc93a123a10\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/character-counter/charCount.js\":\"d15ec0c4b291e87b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/character-counter/dataExtension.js\":\"408250a9f3c0057e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/character-counter/index.js\":\"a4ac722b2de3c0d5\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/character-counter/profiles.js\":\"2d810dba83ff32f6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/character-counter/properties.js\":\"7c00fdde7a27385b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/character-counter/subtree.js\":\"e3408cc305083232\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/character-counter/textCounts.js\":\"aa12cb43dfb7c879\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/colemak-keybindings/index.js\":\"fdb595d569c89e1a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/command-palette/CommandPalette.js\":\"e2666183b7d66938\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/command-palette/HeaderItem.js\":\"10972050c0c5cb3a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/command-palette/context.js\":\"816b03a3ee15eaa6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/command-palette/index.js\":\"91963d9d7e4cd0e4\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/command-palette/selection.js\":\"4aed02681e812f7e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/command-palette/toggleStore.js\":\"85409ec926a8f8ca\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/command-palette/useCommandPaletteActions.js\":\"43a2598fa752f2a7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/contributors/ContributorBadges.js\":\"dabb36a41ddb105d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/contributors/ProfilePicture.js\":\"837dd53948658aef\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/contributors/author.js\":\"83256c8fdd27c5f5\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/contributors/codeMirrorExtensions.js\":\"7bbc95669cd60e4f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/contributors/dataExtension.js\":\"df76b8edc8bbf161\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/contributors/index.js\":\"8eb50f5c5d9b9fe7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/contributors/mentionAutocomplete.js\":\"01d731d99ec84771\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/contributors/processor.js\":\"03cdcde0a72610ac\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/contributors/profiles.js\":\"b1638aa957290029\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/contributors/queries.js\":\"87fc253b0bbedc84\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/contributors/schema.js\":\"d3b4e594a4dd69b4\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/contributors/useCommentAuthor.js\":\"b2a24ae26837de2c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"96ebe96948471837\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/cursor-follows-scroll/followOrigin.js\":\"57e34a0dec6ecadb\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/cursor-follows-scroll/index.js\":\"dac32994748d6420\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1bf0fe60c837dd42\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"bd3c7ec10492d482\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/CalendarGrid.js\":\"25c944e7b9fe6a86\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/DailyNotePicker.js\":\"90e7fbe8bf017fc1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"2b6e45409f01ca8c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/DateNavDecorator.js\":\"8c3cae6f57a1892d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/DateScrubOverlay.js\":\"2321a4262d0ef868\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/DayPropertyControl.js\":\"e282a88e981ab1b6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/DayValueReferenceControl.js\":\"27867ea827598326\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/HeaderItem.js\":\"78ea4f5e5949367d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/ReschedulePicker.js\":\"e2771153cee56bc1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8ee7ce8acae9ef6f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/actions.js\":\"d8f0abfafe05aecd\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/blockDateAdapter.js\":\"c34b9f7e95e31c5a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/calendar.js\":\"0bbb22eebfc1cbb3\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/dailyNotes.js\":\"0bd178319af8957c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/dataExtension.js\":\"5b717fd9c03b08c3\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/dateScrubActions.js\":\"b149cb9ecdf15420\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/dateScrubGesture.js\":\"a45644eb01a63683\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/dateScrubGestureActions.js\":\"12dedfe0c8da6157\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9e8c2caf48ffd5da\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/dayProperty.js\":\"4119e831358410e6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"136474352a9fa792\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/deletionGuard.js\":\"d84b3ffa9a0e563a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/dueQuery.js\":\"a1e571f453e1a881\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/index.js\":\"36d90a35360f8f72\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/landing.js\":\"9ef2f4ee511ab7a6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/localSchema.js\":\"1970ebf44de732c3\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/referenceDateAdapter.js\":\"8a6de1be55ecd13b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/rescheduleAction.js\":\"45d8d22e8110fca7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/schema.js\":\"f423aa34e4951938\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/spreadBlockDates.js\":\"e940c472f273f832\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/spreadDatesAction.js\":\"0ed0121df3e26acb\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/today.js\":\"fc70045a71191c32\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"47610bfd9daf8518\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"4357d6c4d022ed97\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/data-integrity/audit.js\":\"4bc0fbdd2ab3a752\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/data-integrity/auditAction.js\":\"f339fb9dcdfecb1c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/data-integrity/auditRanges.js\":\"6b34acd56c0c4822\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/data-integrity/diagnosticsSource.js\":\"1b4dfa879e00891f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/data-integrity/divergenceScan.js\":\"6d2eee0b0f5e416c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/data-integrity/index.js\":\"1512f3be3f0d8707\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/data-integrity/propertyChildrenChecks.js\":\"89c15dfd648ff440\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/data-integrity/referencesMirror.js\":\"c5e4846f0901eeca\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/data-integrity/rowJson.js\":\"2e1f6a0bea499e16\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/data-integrity/schedule.js\":\"f520db67532e4146\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/data-integrity/store.js\":\"eb0d83af386ea9b6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-maintenance/action.js\":\"a3bb0f89f8f20b45\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-maintenance/index.js\":\"52e4730207380182\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-maintenance/plugin.js\":\"2744ae9a4244086f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d3afa1d68059879b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-mirror/actions.js\":\"9c99bb6ec741d7f1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-mirror/changeMarker.js\":\"3aa0ee668b7ed957\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-mirror/diagnostics.js\":\"6e6cf925a6ac4402\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-mirror/fileSystemAccess.js\":\"cf3605b754246613\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-mirror/filenames.js\":\"4aa1f2ed21225628\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-mirror/index.js\":\"f13c567ac169479e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-mirror/mirror.js\":\"fc6a478d255c7af6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-mirror/runLock.js\":\"69bca504225f1edd\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-mirror/runtimeHealth.js\":\"3386b9023387000a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-mirror/schedule.js\":\"91e9f2d9ca614029\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/db-mirror/store.js\":\"1ec38c3f4232c643\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/default-themes/index.js\":\"94fded92ffba86ab\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/default-themes/themes.js\":\"c98ef6d96c2b5fb1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/diagnostics/facet.js\":\"67302c61fb463ead\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/diagnostics/useDiagnostics.js\":\"552c79bcdcb30387\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extension-prompts/dismissals.js\":\"5b05874b6f711128\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extension-prompts/index.js\":\"bb19452b1b3e84db\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extension-prompts/status.js\":\"02c920b5846d14ee\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extension-prompts/store.js\":\"68e78b71c639a057\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"5bbc14c42833dede\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f56bde43a734a630\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extensions-settings/actions.js\":\"c386f56fe5ce7573\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extensions-settings/config.js\":\"9fc0817dc56ecfde\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extensions-settings/dataExtension.js\":\"ffc0882ec6166e3b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extensions-settings/effect.js\":\"a58e4e69b6c69e8f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extensions-settings/index.js\":\"396d35b49db95f79\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extensions-settings/propertyEditorOverride.js\":\"cafc8a64f0764dde\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extensions-settings/useToggleTree.js\":\"8c8ca0e8c93b044f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extract-type/ExtractTypeDialog.js\":\"f75ab1f33202888c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"7c993a1ca40c6952\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extract-type/PropertyShapePicker.js\":\"2070283bf669e4b8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extract-type/action.js\":\"24b99dab0a83e5fe\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/extract-type/index.js\":\"6cb3484c246be787\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/find-replace/FindReplaceDialog.js\":\"e77737790ac83fb5\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/find-replace/HeaderItem.js\":\"9fa0b1a0533addf9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/find-replace/dataExtension.js\":\"5494f73b62a55bed\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/find-replace/index.js\":\"24fa2530fa90e60f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/find-replace/search.js\":\"9fdf7f7a2f00522d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/find-replace/toggleStore.js\":\"27076b83c6b0a0b6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/LocationPropertyEditor.js\":\"74a6a848f557a21d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/MapView.js\":\"124bfaeb8a6418a9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/blockTypes.js\":\"6323f2077b8491a3\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/codeMirrorExtensions.js\":\"36852a413a56b8c5\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/createOrFindPlace.js\":\"5baac3131534826b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/currentLocation.js\":\"301a0b7afe61032c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/dataExtension.js\":\"17dbd3b5bf003559\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/geoContentDecorator.js\":\"e689bd852c2dcfd4\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/googlePlacesClient.js\":\"c2e8e338ecfe50a5\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/index.js\":\"a655e85945b94ef1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/locationsPage.js\":\"c19021a4faf670b1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/mapViewport.js\":\"c1fd6c6fc5b62fda\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/pickCurrentLocation.js\":\"010b0f7770b85818\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/placeAutocomplete.js\":\"a1aa8af1c92e8018\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/placeNameCollision.js\":\"b05a84041ae04442\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/properties.js\":\"ccd8141e027439d2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/propertyEditorOverrides.js\":\"8b5547a03f5d0d54\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/query.js\":\"c081beff501cdbf5\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/geo/usePlaceSearch.js\":\"86ca6f9cb8c0061f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a95143d2aa91011a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d714f73ad81dd2a3\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"113072bd7371573b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/grouped-backlinks/config.js\":\"c38fefbe1af692f8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/grouped-backlinks/dataExtension.js\":\"f65189a40f071b45\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/grouped-backlinks/facet.js\":\"1ba62b41c7ffc590\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/grouped-backlinks/grouping.js\":\"e14199b75e5a4428\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/grouped-backlinks/index.js\":\"63e0019952c9feaf\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"38c8a9d958409cd5\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/grouped-backlinks/query.js\":\"ac4d8dff91a9542c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/grouped-backlinks/resolveConfig.js\":\"42fca4a506d1d7cd\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"84a2ff26447ae1cf\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6efd7523cdfbeff0\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/html-document/HtmlDocumentContent.js\":\"338887d19a4d41b0\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/html-document/HtmlFrame.js\":\"c7cc857391627c5c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/html-document/actions.js\":\"49c838aac54c7fbc\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/html-document/blockType.js\":\"c79fdbeef76a61ba\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/html-document/confirmRunScripts.js\":\"92da8a25eb888ffd\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/html-document/dataExtension.js\":\"7530ea629ee72047\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/html-document/frameAnnotations.js\":\"ac4b2efb594616ee\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/html-document/frameDocument.js\":\"ce3496c9c34f0b66\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/html-document/frameTheme.js\":\"0e73cdca7227ecf3\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/html-document/index.js\":\"8da19749c6ff843a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/html-document/scriptConsent.js\":\"ab4512b1f2d13e2d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/html-document/sourceMap.js\":\"4dd17fdddaa3b0a6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/html-document/useDocumentScripts.js\":\"5c30af95d04c474c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/interaction-metrics/index.js\":\"691cb5c7d37df4bf\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/interaction-metrics/record.js\":\"1aa19decd6898981\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/interaction-metrics/recordStore.js\":\"f10f8f14791bb3fa\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/interaction-metrics/responsiveness.js\":\"076d195560b9ac75\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/interaction-metrics/schedule.js\":\"b49ca06171db207e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/interaction-metrics/sessionContext.js\":\"a41e372468ccd0a6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"7c34f04ece090cac\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"48e600c2a4cd4b13\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/keybindings-settings/actions.js\":\"acb654245b0294b1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/keybindings-settings/config.js\":\"40bc2554d5fa9b66\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/keybindings-settings/dataExtension.js\":\"f43a73b2418ae5b2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/keybindings-settings/effect.js\":\"e518f6039dea6095\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/keybindings-settings/index.js\":\"55641b665a750951\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/keybindings-settings/keyCapture.js\":\"2ff332beaf95b427\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/keybindings-settings/overrideStore.js\":\"1553f89073e3e962\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"a9c078d97059feab\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/left-sidebar/HeaderItem.js\":\"de364df9c11ffda0\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/left-sidebar/LeftSidebar.js\":\"d8c087a07195fbc0\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/left-sidebar/actions.js\":\"35c5c79682b9eb7a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/left-sidebar/facet.js\":\"3b9ce582976e63ee\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/left-sidebar/index.js\":\"ac57c3c96ba21656\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/left-sidebar/shortcuts.js\":\"d2b11c9d628bcaea\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/left-sidebar/toggleStore.js\":\"afd342b9ef3e8189\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/merge-blocks/MergePicker.js\":\"2919d142a03a98f9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/merge-blocks/index.js\":\"5dd36b01e377b408\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/merge-blocks/mergeAction.js\":\"919dbb0b60660d91\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/merge-blocks/strategy.js\":\"2e8601a58d1e4714\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/mobile-bottom-nav/Button.js\":\"b53cd9b756abe858\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"efefa76395c789c2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5a8d0f77ecfc707f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/mobile-bottom-nav/facet.js\":\"6468dd73faa5e32f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/mobile-bottom-nav/index.js\":\"a4bc0e2d201a3fc0\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"cf43c2988d67c04d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/mobile-keyboard-toolbar/actions.js\":\"66ac16f90da8a1c4\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"25082d449296a2df\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/mobile-keyboard-toolbar/facet.js\":\"61295fbfcc77ab94\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/mobile-keyboard-toolbar/index.js\":\"eb3be3840aac64fb\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/move-blocks/MoveDestinationPicker.js\":\"7067aed7efc6f52b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/move-blocks/blockSubtreeMembership.js\":\"2e5e3a247874d4db\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/move-blocks/contextMenuItem.js\":\"1f053a2c357215ef\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/move-blocks/index.js\":\"c8b28edd97bb6558\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/move-blocks/moveAction.js\":\"9dfe01744bbd86cd\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/move-blocks/moveBlocks.js\":\"6e7d4f849b7a32f8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/move-blocks/selectionAfterMove.js\":\"0a644b86deb33fda\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/onboarding/TutorialBanner.js\":\"038f25d0bd6f44bb\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/onboarding/action.js\":\"6afc07af1948a14b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/onboarding/bannerDismissal.js\":\"94572b89a997264d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/onboarding/documents/cheatSheet.js\":\"a5d098c479ffd8b0\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/onboarding/index.js\":\"c539e70a1ba4deba\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/onboarding/keys.js\":\"ef86bca54555b32e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/onboarding/landing.js\":\"ad5f5dee21115b61\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/onboarding/outline.js\":\"28d8d5b509651516\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/onboarding/seed.js\":\"ecb12402ab72f006\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/perf-monitor/PerfTrendDialog.js\":\"6ca2ac526f896bd2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/perf-monitor/analyze.js\":\"478e7e66942e5e51\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/perf-monitor/diagnosticsSource.js\":\"36708f92f41497b8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/perf-monitor/index.js\":\"c2cb5327c7ba2e1a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/perf-monitor/load.js\":\"7fff6093be0145bc\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/perf-monitor/monitorRun.js\":\"a5264216b7dec7b2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/perf-monitor/schedule.js\":\"659dadbf90c93a51\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/perf-monitor/series.js\":\"9cc7a7506c431172\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/perf-monitor/store.js\":\"7658ec23339737da\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/perf-monitor/trendAction.js\":\"be773b60a5128259\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/perf-monitor/verdict.js\":\"38fb701b97a9d983\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/plain-outliner/clickToEditAction.js\":\"10b0a827033d8d7e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/plain-outliner/index.js\":\"1b48e15ca17238e6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/plain-outliner/interactions.js\":\"9d0abb1660a453c7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"afaccd56483e83ef\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/properties-migration/MigrationGate.js\":\"5a79a5690dd2959e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/properties-migration/MigrationGateDialog.js\":\"ba5ea412438a637b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/properties-migration/action.js\":\"1732648e156c0cc9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/properties-migration/index.js\":\"09c81acd51dd2ac6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/properties-migration/localRunMessage.js\":\"6f2d16bdda4f2c02\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/properties-migration/plugin.js\":\"07e28bdd915787cc\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/properties-migration/progressReport.js\":\"aa2eeb7c8c688b19\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/properties-migration/sweepProgress.js\":\"621166ecdef34f8e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/property-rows/FieldRowRenderer.js\":\"aae18c1c39403ce5\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/property-rows/ValueRowRenderer.js\":\"c0a1a955c4079143\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/property-rows/actions.js\":\"4eee9dab912d3cac\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/property-rows/autocomplete.js\":\"4fcf28ead28ac631\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/property-rows/fieldRow.js\":\"f5da9029e9d269b6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/property-rows/index.js\":\"7b25f59d703b482b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/property-rows/referenceWarning.js\":\"5f66d93af0e7d5b2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/property-rows/valueAutocomplete.js\":\"eb295ff582cb1ad9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/property-rows/valueSchema.js\":\"c1627e6ae253c2b7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/quick-find/HeaderItem.js\":\"6c7242fea32060e0\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/quick-find/QuickFind.js\":\"6c3bec311916803d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/quick-find/index.js\":\"ac8addaec530639c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/quick-find/recents.js\":\"53c96a1e4920de36\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/quick-find/resultItems.js\":\"a3ce2d559c4bc332\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/quick-find/selection.js\":\"0a7f5b62052c53ed\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/quick-find/toggleStore.js\":\"e05098f220aa410f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/recents/HeaderItem.js\":\"fa03dbdc003d8952\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/recents/RecentsPageBlockRenderer.js\":\"3f7e3535bfe6b091\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/recents/grouping.js\":\"86d641af65e7e985\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/recents/index.js\":\"11f312e51efccfa7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/recents/target.js\":\"90c78e4a90b58f90\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/codeMirrorExtensions.js\":\"6b6dcf3df21209d8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/contentPrefill.js\":\"b2ecfb8c2dae52d2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/dataExtension.js\":\"c6380303f7f70dd6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/index.js\":\"23f90841f7aff756\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b08e2b73535d18bc\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/invalidation.js\":\"e5ebad0bb53a38fe\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/localSchema.js\":\"dc351de2fb757433\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/markdown/blockrefs/index.js\":\"4767998281366981\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"1428c14c0ccebd40\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/markdown/index.js\":\"cfd33c14d401c544\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/markdown/referenceNode.js\":\"026180a1ce40d515\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/markdown/remark-reference-occurrences.js\":\"3ac383c1ebd8eb97\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"1e19446ee6f36e4b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/markdown/wikilinks/index.js\":\"e912eb82d3a3ad11\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2b49b4d28dcf196d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"dfd0f1a25cb05bbc\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/mergeRetargetProcessor.js\":\"60fed20cdcc0dcda\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/parseFence.js\":\"3eab7d3e0f0dd204\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/referenceParser.js\":\"be0600e295e14c92\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/referenceProjection.js\":\"f12e624d45d0c018\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/referencesProcessor.js\":\"05946d73ef4fa0c3\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/renameProcessor.js\":\"f44980784fc2d5e4\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/references/spanReplacement.js\":\"fd317acc50f512cd\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/rich-paste/htmlToOutline.js\":\"44397237d1eeb464\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/rich-paste/index.js\":\"2ab419fa3b2ca5b6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ed173cd1ec0fc678\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/rich-paste/pasteDecision.js\":\"9c77643c159160e9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/action.js\":\"bfd5e7c6d4ddbda7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/blockIds.js\":\"22b377ab0e857c20\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/content.js\":\"f81de00c554c6c25\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/effect.js\":\"5218d4c59f280a62\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/ids.js\":\"f6f19e78af22f86d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/import.js\":\"cb1c393f9284c228\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/index.js\":\"93efdffe20e5f5cd\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/plan.js\":\"f0f4772b9e38e37a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/plugin.js\":\"f0bab81d345f207b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/promotion.js\":\"5724549346696b2e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/properties.js\":\"2c9a6bd5cfa1d77f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/references.js\":\"30be9a099343aeeb\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/report.js\":\"11c3587fd38d59d1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/roamMemo.js\":\"a50b94e33f96dd9c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/runtime.js\":\"4928f4cad26bf3cf\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/schemaReconciliation.js\":\"6d5e663a0d2a41b1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/srsMarkers.js\":\"5367f6624fa9c33c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/todo.js\":\"b5ec4883c6fa2849\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/typeCandidates.js\":\"6f3bb8ff843adb02\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/roam-import/types.js\":\"65997bf333dba500\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/search-health/index.js\":\"cd1673d7964a7e10\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/search-health/store.js\":\"cdc03db0662c763a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/shortcut-help/HeaderItem.js\":\"80c0c03af36dd1da\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"91fe3f5bb012cafd\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/shortcut-help/index.js\":\"2f8d00c71c33fafd\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/shortcut-help/model.js\":\"ac81231013eb1146\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/shortcut-help/toggleStore.js\":\"0c64fc9170a5703c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/shortcut-help/useKeyInspector.js\":\"6bf3805039d80bc8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8eddaf9584a04840\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/spatial-navigation/ShellDecorator.js\":\"140bd55c373b1315\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/spatial-navigation/actions.js\":\"43619d4e0003d0ac\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/spatial-navigation/exclusionsFacet.js\":\"cc5836f2a80a0a24\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/spatial-navigation/index.js\":\"057d07f2b786e8e9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/spatial-navigation/shell.js\":\"49a421b3fd9642ff\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/spatial-navigation/surface.js\":\"46a2f6e6f7d63b57\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/spatial-navigation/walker.js\":\"a65d618254adcb9e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-rescheduling/RescheduleToast.js\":\"83443fa63e24c1fc\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-rescheduling/dataExtension.js\":\"a155fa03806d8803\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-rescheduling/index.js\":\"fa586c8e276d6417\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-rescheduling/indicator.js\":\"facd9a423e84b3e7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-rescheduling/moveSrsState.js\":\"bd13914f9f517b95\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"14b7ea03b929d6db\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-rescheduling/scheduler.js\":\"cfc1e2a92e73c095\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-rescheduling/schema.js\":\"89f6a1be26afa807\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"21c503aa7c398bea\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-rescheduling/srsClipboard.js\":\"17e054b3d61a21ff\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a6f1e6350c955ed5\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/DailyNoteReviewHint.js\":\"85b3cea3618673bc\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/DeckPicker.js\":\"80f120a6073dfaa6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/ReviewControls.js\":\"eb2f00be837f1958\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/ReviewDeckRenderer.js\":\"16563a7190fe2d7c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/ReviewSession.js\":\"87e1be595aaea94a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/actions.js\":\"5231f09432fe1258\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/archive.js\":\"82700703e2efc671\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/dataExtension.js\":\"cba583b0ada43842\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/deck.js\":\"60836de1b3d838b7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/dueQuery.js\":\"3b4da2a6bc447a35\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/gradeDecision.js\":\"45a0fece6576883f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/index.js\":\"7d8ad00f7f082046\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/keyHints.js\":\"2f79aeb94fb1e2d9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/reviewCardLayout.js\":\"3dfffb73c24ae40e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/reviewProgress.js\":\"ac8057f9820d3bb1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/schema.js\":\"f0324f3b5ae64f58\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/srs-review/useDueCards.js\":\"ce052657d89bd361\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/startup-metrics/index.js\":\"60500092617c515c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/startup-metrics/record.js\":\"741205a812057211\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/storage-persistence/index.js\":\"2316289528761804\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/storage-persistence/persistenceStatus.js\":\"132c6d4d0cc87310\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/storage-persistence/requestAction.js\":\"584abc53c2d9e58c\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/supertags/TypeChipsDecorator.js\":\"d85d93bdbd659c1d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/supertags/codeMirrorExtensions.js\":\"81484cbdd92f47cd\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/supertags/index.js\":\"897fea53bb771351\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/supertags/typeAutocomplete.js\":\"740a732f76c362bc\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"3e746584f1b11c28\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/swipe-quick-actions/actions.js\":\"162c2dd45314d5a6\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/swipe-quick-actions/anchor.js\":\"7ec704d48cc45eea\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/swipe-quick-actions/events.js\":\"bf77737c384a5aab\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/swipe-quick-actions/gestureActions.js\":\"b03f42265e0c17a2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/swipe-quick-actions/index.js\":\"0c59dcba74ec0624\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"2b54e2058a26600f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/sync-metrics/collect.js\":\"b147a3b151dfd100\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/sync-metrics/index.js\":\"1b8d970778fd73e8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/sync-metrics/record.js\":\"8595a4ad87301d23\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/system-status/RejectionDialog.js\":\"762024429790535f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/system-status/SystemStatusHeaderItem.js\":\"fc5819054380b530\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/system-status/index.js\":\"500c31d1f88b962b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/system-status/model.js\":\"2ea076ba1fe59e85\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/system-status/queueCounts.js\":\"a56ea8e6ba5090a9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/system-status/rejectedHelpers.js\":\"d1df61c708955308\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/system-status/rematerializeAction.js\":\"ca8176d0825f5a33\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/system-status/useHysteresis.js\":\"9aa90ff267333958\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/ColumnHeaders.js\":\"63b043b68e7e0cc2\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/QueryUi.js\":\"5663f363aeda5203\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/TableLayout.js\":\"1cc69a24f90ec9ee\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/actions.js\":\"9e29b2499d3ce8e1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/cellEdits.js\":\"fee0895db2626cfc\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/childrenViews.js\":\"ba446117b7a3b3c1\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/columns.js\":\"218c872125404fc5\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/controller.js\":\"661558e6b790118e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/convert.js\":\"09f8764abc5b4157\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/dataExtension.js\":\"f26f3376d6f32de4\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/index.js\":\"766c89c3979c7214\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/keys.js\":\"7a876de3e31ce0f9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/model.js\":\"69bd3bb07939de42\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/query/QueryText.js\":\"0fa53af34e3f79eb\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/query/backfill.js\":\"bd9f0804eea5f765\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/query/completion.js\":\"a80b7b6e44bb8e46\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/query/format.js\":\"e98caaaded0fd2ee\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/query/parse.js\":\"e1c7cadc1f98b3fc\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/query/queryValue.js\":\"27751b94bee12e5a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/query/registrations.js\":\"baf77e943ab6ca8a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/query/source.js\":\"7be718227c2fb4dc\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/registry.js\":\"27f07786b7c2a458\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/rowGutter.js\":\"1d31f015f7a4569f\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/rowVerbs.js\":\"72ee6a150feb2ae3\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/schema.js\":\"ca166e0bce42ef6b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/tables/sort.js\":\"6d1e4a15ae2baf24\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/theme-toggle/effect.js\":\"4dfed0c3f587a771\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/theme-toggle/index.js\":\"43bf727af2a43b85\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/theme-toggle/theme.js\":\"8b1c9743eda8a2a8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/todo/actions.js\":\"60f050bf4255e35d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/todo/dataExtension.js\":\"eab07f655b4c480a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/todo/index.js\":\"9917fdf931d80f23\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/todo/schema.js\":\"38cb0e9a07e1bfe8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/touch-selection/TouchSelectionLayer.js\":\"3ec7224d0df9076a\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/touch-selection/actions.js\":\"72795635772656c7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/touch-selection/defaultItems.js\":\"19a3b2343f6344a9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/touch-selection/facet.js\":\"7137060c9c667324\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/touch-selection/holdRecognizer.js\":\"26481f4afff6fef9\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/touch-selection/index.js\":\"33a02f06c34be5a7\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/update-indicator/UpdateIndicator.js\":\"169d2dfafc60ee8d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/update-indicator/index.js\":\"9f9d626df8f6da52\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/update-indicator/loadTimes.js\":\"542ce348ea7039d8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/video-player/VideoNotesRenderer.js\":\"d8ddba2edd63262d\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/video-player/VideoPlayerRenderer.js\":\"019a096805e35016\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/video-player/VideoTimeStamp.js\":\"9153d714c915cc67\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/video-player/actions.js\":\"50a21dc584e8be92\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/video-player/index.js\":\"8d62e829f67000a4\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/video-player/markdown.js\":\"a8432845f9043edd\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/video-player/notes.js\":\"bc5387773838467e\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/video-player/registry.js\":\"3d52934a346c5f54\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/video-player/remark-timestamps.js\":\"bce79a876f0b0e28\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/video-player/view.js\":\"4b52d15ce7821cd8\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/vim-link-hints/LinkHints.js\":\"5ed76f4ea07f91db\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/vim-link-hints/index.js\":\"4a5c2dbb9dd20cfc\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/vim-link-hints/model.js\":\"8a878fa4af8570c4\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/vim-link-hints/settings.js\":\"3ec59af13cf28b51\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/vim-normal-mode/actions.js\":\"0469de7406bae187\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/vim-normal-mode/index.js\":\"4bf8cb2fea4bfb31\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/vim-normal-mode/interactions.js\":\"3b7394458d13859b\",\"/knowledge-medium/pr-preview/pr-1896/src/plugins/workspace-header/index.js\":\"36eb0aa2de64d080\",\"/knowledge-medium/pr-preview/pr-1896/src/registerServiceWorker.js\":\"a94dc2866042ab61\",\"/knowledge-medium/pr-preview/pr-1896/src/requestPersistentStorage.js\":\"eeeeec1294fe556d\",\"/knowledge-medium/pr-preview/pr-1896/src/services/authRequestDeadline.js\":\"9204ddf46c316b1e\",\"/knowledge-medium/pr-preview/pr-1896/src/services/authStorage.js\":\"6c6d6752945ebb43\",\"/knowledge-medium/pr-preview/pr-1896/src/services/powersync.js\":\"0b0dff2650a9283f\",\"/knowledge-medium/pr-preview/pr-1896/src/services/supabase.js\":\"2a6db727afa0db2b\",\"/knowledge-medium/pr-preview/pr-1896/src/services/uploadErrorClassifier.js\":\"cefb03426e48f1d2\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/ActiveContexts.js\":\"95dff2ced1b156f5\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/HotkeyReconciler.js\":\"926d288a28371c29\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/WipeLocalDataDialog.js\":\"df6e6d18591fe7b7\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/actionDispatch.js\":\"094306df78b9013e\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/actionRefItems.js\":\"87c95680cead7303\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/applyKeybindingOverrides.js\":\"e48414321dec12ce\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/blockActions.js\":\"509103d71e2e4e89\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/blockMergeGesture.js\":\"56d64577b96fa125\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/canonicalizeChord.js\":\"5a11bea8e14c429d\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/defaultContexts.js\":\"07dfc12a199dcfd1\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/defaultShortcuts.js\":\"63c37989068d9975\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/effectiveActions.js\":\"008a3bb312eebe63\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/gestureAction.js\":\"e14a09b4239a906a\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/gestureBinding.js\":\"9db0af70ac00a96d\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/holdRegistry.js\":\"d3c080aa944f5538\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/keybindingConflicts.js\":\"5498df85d2521883\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/keybindingOverrides.js\":\"b85c87b0d4febeac\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/pointerAction.js\":\"b9a366a10b7c4146\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/resolve.js\":\"14c5e64e6e633736\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/runAction.js\":\"a7f6c5df3ad7b283\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/sequenceMatcher.js\":\"c1882d458ae96a00\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/types.js\":\"a9c33d3b2d2233c7\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/useActionContext.js\":\"5266d1d3fcb12958\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/useActionDiscovery.js\":\"a236cdc57344c44e\",\"/knowledge-medium/pr-preview/pr-1896/src/shortcuts/utils.js\":\"a1442ea4c578061b\",\"/knowledge-medium/pr-preview/pr-1896/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1896/src/sw/bootStore.js\":\"26820636f4fc4b43\",\"/knowledge-medium/pr-preview/pr-1896/src/sw/previewDatabases.js\":\"5edbe4acda45bc14\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/byteTransform.js\":\"c1668a8fb0c92019\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/attachmentCleaner.js\":\"afcc0b6a288c100a\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/bundle/attachmentParts.js\":\"50511d422afc831a\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/bundle/bundleParts.js\":\"cf29c3c00a9f2bd3\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/bundle/bundleRecord.js\":\"575731d0dc24ce7e\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/bundle/manifest.js\":\"a7755f0084755371\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/bundle/takeBundle.js\":\"5d5319a9aa87bcc7\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/bundle/verifyBundle.js\":\"ef48b5f13d489c4f\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/cleaningStage.js\":\"1570070a4a60d672\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/conversionKey.js\":\"908f30aad7273bbd\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/conversionServer.js\":\"6640ddbf79f62c55\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/flip.js\":\"d23b8e61906c6931\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/flipAttempts.js\":\"ed40775de990baeb\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/pages.js\":\"d569cf0348ef9fa8\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/preflight.js\":\"3eddbbe829c2708e\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/reseal.js\":\"c68fefd6822e247d\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/runConversion.js\":\"586e107ae3210a91\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/runLock.js\":\"4ace1e35e62c7482\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/sealing.js\":\"4304d24c66a0f1c3\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/sealingStage.js\":\"927109492fb1c77c\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/stage.js\":\"5b365418c09411d3\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/conversion/verifyReseal.js\":\"65bcb958b1e61b97\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/aad.js\":\"ce9ab19ab65b0e47\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/aead.js\":\"25dc997ec9067347\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/base32.js\":\"d5ed2e6d4353aba1\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/base64url.js\":\"5c48d01a3f37ceb3\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/binaryEnvelope.js\":\"5adae5712376077a\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/byteAead.js\":\"4a27240f64fafee7\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/canary.js\":\"ddd8492547ce667e\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/contentHash.js\":\"1aa3cb9dfca7bd66\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/contentKey.js\":\"ed06f11d096db7ef\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/derivedIdNamespace.js\":\"3cbc36109016e929\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/envelope.js\":\"3b52213c3792e5fc\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/hex.js\":\"886aed070e2ffa8c\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/sha256Hex.js\":\"29ba237618e1dbb6\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/crypto/workspaceKey.js\":\"b70af039a6a27b5a\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/keys/conversionState.js\":\"7dd9ee3f04466b64\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a3cdcffb802098ff\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/keys/flows/pastedKey.js\":\"037ba1b9733fb3ff\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b5ee14ec562e742d\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/keys/flows/upgradeWorkspacePin.js\":\"93d039096bb574b6\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/keys/keyStore.js\":\"3845148dd4e830af\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/keys/mintWorkspaceKey.js\":\"3fd75173f13d6df7\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/keys/modePin.js\":\"736a2f7412af42c6\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/keys/openWorkspaceKeys.js\":\"47762569b4cbfcef\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/keys/resolveWorkspaceEntry.js\":\"c4a7beea31adc509\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/keys/resolver.js\":\"155e133fc96a9842\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/keys/workspaceAccess.js\":\"5227a9dbe048fd05\",\"/knowledge-medium/pr-preview/pr-1896/src/sync/transform.js\":\"468d55da495da673\",\"/knowledge-medium/pr-preview/pr-1896/src/themeBootDefaults.js\":\"f8bdf9bfb902d331\",\"/knowledge-medium/pr-preview/pr-1896/src/types.js\":\"799768414b0e2627\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/ClientLocalSettings.js\":\"f95fc044e52aa174\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/abortableSleep.js\":\"a9e397361973ca64\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/array.js\":\"1846b7f5fca05012\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/backlinkAutocomplete.js\":\"30b2e6c870b713d3\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/blockCrumbs.js\":\"6d3f54da24d31bad\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/blockrefAutocomplete.js\":\"17bd8c0a3ca4cb60\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/cadencedIdleJob.js\":\"14d9fbc3ec705983\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/callbackSet.js\":\"19a8efcb1ffea25a\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/clientId.js\":\"eeb607bb83be4893\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/codemirror.js\":\"ff6a0d9f24ad45bc\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/codemirrorCompletion.js\":\"42d26cb06c892165\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/copy.js\":\"b0bc26da90b4d50e\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/dailyPage.js\":\"055b2c4a77a8bf71\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/dbForensics.js\":\"d20cf6f46581f705\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/dbForensicsHooks.js\":\"e509e3cce9d7b9d6\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/deleteBlockThroughUi.js\":\"851092739ea61754\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/dialogs.js\":\"722f48a49e187912\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/dom.js\":\"cc792c4c574ff378\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/downloadBlob.js\":\"5a60a1ff30862422\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/drawnWalk.js\":\"c7db04b23c4575ea\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/exportSqliteDb.js\":\"5e5c78d2bc839d97\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/fileSystemAccess.js\":\"bf17d671689c49d9\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/flipSlide.js\":\"41c25da0712b2886\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/fnv1a.js\":\"722a4f896512b345\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/formatBytes.js\":\"6e677ebe16059433\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/fuzzyRank.js\":\"f3d44a0cd34c9b8d\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/idbKeyedStore.js\":\"8c0528b45a097473\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/idleCallbackPolyfill.js\":\"129dd170b83ff5dd\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/keyboardAwareScroll.js\":\"c48314742347d12c\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/keyboardViewport.js\":\"4d0a2c875f8498d3\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/lastWorkspace.js\":\"492b9d2fe028ccfd\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/layoutColumns.js\":\"3c102d1e5432990f\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/layoutSessionDom.js\":\"23575df65ca987ac\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/layoutSessionId.js\":\"461c59ef27deb68a\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/linkClickGestures.js\":\"6c73999623120e96\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/linkTargetAutocomplete.js\":\"214c124896fe5c4a\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/localDbCorruption.js\":\"a9433c0be8d58025\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/localDbRecovery.js\":\"f0ea83cfd059ec47\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/markdownParser.js\":\"b3b3a10c161d9d5a\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/memoize.js\":\"bc73d4ff7ce01323\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/nameFieldCommit.js\":\"0414245267be40d5\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/nameList.js\":\"99f845233ef21633\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/navigation.js\":\"8936f4e90c72e283\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/omnilinerNamespace.js\":\"ebe1518287ddd766\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/opfsPageScan.js\":\"c326516efbe5c90a\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/panelClearance.js\":\"483f425660bdd97f\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/panelHistory.js\":\"7821838cbba29413\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/panelLanes.js\":\"77f9cde0c8189b8a\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/panelLayoutProjection.js\":\"310aec93339ef4b2\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/panelScrollAnchor.js\":\"00a85bc875dc84f5\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/panelUrlFlags.js\":\"5bb3c5e6137bab32\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/platform.js\":\"585cb2e76f30a617\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/pluralize.js\":\"25f4152c0b538394\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/propertyCreation.js\":\"13925030d07f4f86\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/propertyNavigation.js\":\"3e2bdca5040d43ff\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/propertyValueContext.js\":\"d8ca386fa938796a\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/react.js\":\"8b945b076f67fe27\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/relativeDate.js\":\"9bdf05cf57c8838a\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/relativeTime.js\":\"a8b2b4b74a0ccec0\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/renderScope.js\":\"dd1424b1048a8226\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/resolvedThenable.js\":\"55fde524251b50ba\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/routing.js\":\"92f8eafb5f6d0a5a\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/safeMode.js\":\"cd2a2534ccee9c23\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/scheduleIdle.js\":\"13d66c3fe1dc7426\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/screenWakeLock.js\":\"94a8e39b44ebb995\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/selection.js\":\"661b5f212a752ae9\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/softKeyboardGrab.js\":\"e27fbb6c1935c1e2\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/startupTimeline.js\":\"6bb114a1a49445be\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/state.js\":\"c85d09d6d6edd596\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/string.js\":\"31405abd54df9cfd\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/surfaceZoom.js\":\"89d42d135fc25b81\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/time.js\":\"e86057951c66dfa2\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/toast.js\":\"b1ff32396ba33e1c\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/toggleStore.js\":\"e4e60b44e8d3283d\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/untilStopped.js\":\"cf262ffde6c81fcb\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/userActivity.js\":\"dfda1472bb65f0d8\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/viewTransition.js\":\"794527c95b59cf8b\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/viewport.js\":\"8d4fa3b4538ebc44\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/webLock.js\":\"17ee06b575c7e079\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/workspaceRecovery.js\":\"c32e07e309ca3aac\",\"/knowledge-medium/pr-preview/pr-1896/src/utils/workspaceSnapshotStore.js\":\"88f6f0f2313076f7\",\"/knowledge-medium/pr-preview/pr-1896/src/vendor/react-compiler-runtime.js\":\"29cbd1aff0f46fbe\",\"/knowledge-medium/pr-preview/pr-1896/src/vendor/react-dom-client.js\":\"d57b7f9a7787148d\",\"/knowledge-medium/pr-preview/pr-1896/src/vendor/react-dom-server-edge.js\":\"f459403203a4aa4b\",\"/knowledge-medium/pr-preview/pr-1896/src/vendor/react-dom-server.js\":\"51f8d4d1c118e981\",\"/knowledge-medium/pr-preview/pr-1896/src/vendor/react-dom-static-edge.js\":\"bc4bbf9f9353fc49\",\"/knowledge-medium/pr-preview/pr-1896/src/vendor/react-dom-static.js\":\"d0c50b2d3d09edb7\",\"/knowledge-medium/pr-preview/pr-1896/src/vendor/react-dom-test-utils.js\":\"9d816da7e4461aee\",\"/knowledge-medium/pr-preview/pr-1896/src/vendor/react-dom.js\":\"a12cc951fc65155f\",\"/knowledge-medium/pr-preview/pr-1896/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1896/src/vendor/react-jsx-runtime.js\":\"ab49e25daf4386a9\",\"/knowledge-medium/pr-preview/pr-1896/src/vendor/react.js\":\"d666629047c60ca0\",\"/knowledge-medium/pr-preview/pr-1896/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1896/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1896/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
