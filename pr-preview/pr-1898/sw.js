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
		buildId: "684f4e2095a4-43c561ff",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1898/\":\"aea4416c8d9e1d3b\",\"/knowledge-medium/pr-preview/pr-1898/index.html\":\"aea4416c8d9e1d3b\",\"/knowledge-medium/pr-preview/pr-1898/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1898/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1898/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1898/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1898/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1898/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1898/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1898/assets/FacadeVFS-BPTirKzs.js\":\"86d89a6c70d0f81c\",\"/knowledge-medium/pr-preview/pr-1898/assets/OPFSCoopSyncVFS-1q8OW0VH.js\":\"7261e5377b3f4aaf\",\"/knowledge-medium/pr-preview/pr-1898/assets/OPFSWriteAheadVFS-BGdq2nPd.js\":\"14f6265d0ce7c79d\",\"/knowledge-medium/pr-preview/pr-1898/assets/wa-sqlite-C8m68_PP.js\":\"e2ddbd50d38680ab\",\"/knowledge-medium/pr-preview/pr-1898/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1898/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1898/assets/wa-sqlite-async-CInRy-IC.js\":\"c2cd5317d4bee137\",\"/knowledge-medium/pr-preview/pr-1898/assets/worker-nsAd4d-U.js\":\"af01bc0c55160d87\",\"/knowledge-medium/pr-preview/pr-1898/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1898/chunks/app-B2sKsV1Y.js\":\"d8131aa786befcf3\",\"/knowledge-medium/pr-preview/pr-1898/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1898/index.js\":\"a4eae2c47ea117dd\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1898/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1898/assets/AccessHandlePoolVFS-DV_8XrST.js\":\"8c636697bea78b9a\",\"/knowledge-medium/pr-preview/pr-1898/assets/IDBBatchAtomicVFS-R5rQ7myg.js\":\"c7181b997947cd12\",\"/knowledge-medium/pr-preview/pr-1898/assets/MemoryVFS-CzQ7j6GZ.js\":\"079f08168dabda7b\",\"/knowledge-medium/pr-preview/pr-1898/assets/mc-wa-sqlite-CdRI64mL.js\":\"2c50e190e6a29bb1\",\"/knowledge-medium/pr-preview/pr-1898/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1898/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1898/assets/mc-wa-sqlite-async-em9Gireg.js\":\"33851467fc0398e2\",\"/knowledge-medium/pr-preview/pr-1898/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1898/chunks/AccessHandlePoolVFS-BT5WMiUD.js\":\"0edc6be0854c8b37\",\"/knowledge-medium/pr-preview/pr-1898/chunks/FacadeVFS-p-lDp1ro.js\":\"cc1d46be4bf3cc4b\",\"/knowledge-medium/pr-preview/pr-1898/chunks/IDBBatchAtomicVFS-Cx7wS_9U.js\":\"9bce8685635d7b7a\",\"/knowledge-medium/pr-preview/pr-1898/chunks/MemoryVFS-Bp6oKlcD.js\":\"151ab43ece71fd07\",\"/knowledge-medium/pr-preview/pr-1898/chunks/OPFSCoopSyncVFS-CPyLPx3T.js\":\"2e95cc9303345307\",\"/knowledge-medium/pr-preview/pr-1898/chunks/OPFSWriteAheadVFS-BoraJBAN.js\":\"3b0bff8d0b5b653f\",\"/knowledge-medium/pr-preview/pr-1898/chunks/Preview-CYYLQu8-.js\":\"93c2d7d444b3fc59\",\"/knowledge-medium/pr-preview/pr-1898/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1898/chunks/card-XaUCvX5G.js\":\"72b2fa068556fa04\",\"/knowledge-medium/pr-preview/pr-1898/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1898/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1898/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1898/chunks/dist-CNgR3P9V.js\":\"1e291b6c4721b38e\",\"/knowledge-medium/pr-preview/pr-1898/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1898/chunks/mc-wa-sqlite-CG1KTgZP.js\":\"5d68b69ce1314df6\",\"/knowledge-medium/pr-preview/pr-1898/chunks/mc-wa-sqlite-async-BI4tTqE_.js\":\"748c739e96a5a6e8\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-BMb-JOdh.js\":\"82dca30fd836177c\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-BWcl6hKO.js\":\"388ba4848be9eac4\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-BaSw7mrr.js\":\"41645a7b724820ba\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-C4JEiUYl.js\":\"38967608bb6bb806\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-CCk9FrLG.js\":\"9c11e138a36a4f2c\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-CcZxHCoj.js\":\"2c349d272e1bae83\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-D48bab1k.js\":\"460902c07433dec4\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-Dz4yxzel.js\":\"8011ad847bd27927\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-dom-server-legacy.browser.production-BBQrVm9c.js\":\"37abd258393b687d\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-dom-server.browser.production-CSAtYTeR.js\":\"fd705ee33e95f605\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-dom-server.edge.production-XmTzNHkh.js\":\"899a73b10e8151bf\",\"/knowledge-medium/pr-preview/pr-1898/chunks/server.browser-OCzDy5nZ.js\":\"bab0e0cbbb5cf51b\",\"/knowledge-medium/pr-preview/pr-1898/chunks/textarea-CxEsDzBG.js\":\"f8dd5d470130fb57\",\"/knowledge-medium/pr-preview/pr-1898/chunks/ui-BdlekXNc.js\":\"763d2acb11881075\",\"/knowledge-medium/pr-preview/pr-1898/chunks/wa-sqlite-BNjsk0bU.js\":\"c798d27014799813\",\"/knowledge-medium/pr-preview/pr-1898/chunks/wa-sqlite-async-YxMm9AbZ.js\":\"9efa03fd1b975b97\",\"/knowledge-medium/pr-preview/pr-1898/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1898/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1898/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1898/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1898/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1898/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1898/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1898/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1898/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1898/src/App.js\":\"8bca9d5dc8ec96da\",\"/knowledge-medium/pr-preview/pr-1898/src/appUpdate.js\":\"71013780e9b2d66a\",\"/knowledge-medium/pr-preview/pr-1898/src/appVersion.js\":\"69f6f65dc9787fdb\",\"/knowledge-medium/pr-preview/pr-1898/src/bootstrap/initialLayout.js\":\"6b4372c84adcd8df\",\"/knowledge-medium/pr-preview/pr-1898/src/bootstrap/openWorkspaceData.js\":\"c0ed990f8e5aa16c\",\"/knowledge-medium/pr-preview/pr-1898/src/bootstrap/resolveWorkspace.js\":\"57de5b3ef3fbc53b\",\"/knowledge-medium/pr-preview/pr-1898/src/bootstrap/workspaceBootstrap.js\":\"73674c235e3a84a7\",\"/knowledge-medium/pr-preview/pr-1898/src/components/BlockComponent.js\":\"bd7dff3b47b78146\",\"/knowledge-medium/pr-preview/pr-1898/src/components/BlockCrumbs.js\":\"b26621d12e9fc690\",\"/knowledge-medium/pr-preview/pr-1898/src/components/BlockEditor.js\":\"be4b53c9d4b29ac8\",\"/knowledge-medium/pr-preview/pr-1898/src/components/BlockLoadingPlaceholder.js\":\"493c0a9066c545db\",\"/knowledge-medium/pr-preview/pr-1898/src/components/BlockProperties.js\":\"1ab8b35623769cea\",\"/knowledge-medium/pr-preview/pr-1898/src/components/BlockSearchPicker.js\":\"45bee96a4381c1f9\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ConfirmBulkDeleteDialog.js\":\"c86d8914abf7603b\",\"/knowledge-medium/pr-preview/pr-1898/src/components/DividerHandle.js\":\"078af336e1b3a983\",\"/knowledge-medium/pr-preview/pr-1898/src/components/DraftEditor.js\":\"e0e69c4682a2b5a2\",\"/knowledge-medium/pr-preview/pr-1898/src/components/GutterPill.js\":\"1ea5338240d96461\",\"/knowledge-medium/pr-preview/pr-1898/src/components/Header.js\":\"ed94e58d0aa3608d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/LazyBlockComponent.js\":\"7efba2106eaf2321\",\"/knowledge-medium/pr-preview/pr-1898/src/components/Login.js\":\"905f3a7cfb8d5a75\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ZoomableSurface.js\":\"f1301629d7192427\",\"/knowledge-medium/pr-preview/pr-1898/src/components/editModeKeepalive.js\":\"2bad33e44462694b\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyDisplay/PropertyDisplayScope.js\":\"2b654e6a704743e1\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"efe99d08ee54d60d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/RefPropertyEditor.js\":\"03563ae987e18f88\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/RefTargetTypePicker.js\":\"e12d1038f37be825\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/SelectPropertyEditor.js\":\"fc9af0f625482753\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/TypesPropertyEditor.js\":\"01f03fedc41d0ed7\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/defaults.js\":\"e62d98e2d4c82b5d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/kernelValuePresets.js\":\"42971b9d36a9a24b\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/selectablePresets.js\":\"22c4ab09c370e285\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/typesPropertyUi.js\":\"9d406d10c3ddeb15\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/AddPropertyForm.js\":\"332db912e510f045\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/PropertyPicker.js\":\"afcc0b1a101506a0\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/PropertyRow.js\":\"d251e55ca5181740\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/Rows.js\":\"46d7e4c0d06305c7\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/actions.js\":\"3a71657788ae594b\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/declarationOnly.js\":\"66269026eeb6d8ba\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/layout.js\":\"6ba6c4bc035d6d41\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/model.js\":\"b5eee2446d3e6634\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/shapeUi.js\":\"68a2b8ab19de7dbd\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/shapes.js\":\"45549905e736da9d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/usePropertyEditingActivation.js\":\"57179674c8876c2e\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/visibility.js\":\"14e04609f210873c\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanelSections.js\":\"5e43d736c3d8fcdf\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/BlockEmbed.js\":\"9a93267e9a531b37\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/BlockLink.js\":\"90bf046fa47cdb22\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/BlockRef.js\":\"70f929010dd20722\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/CompactReferenceLink.js\":\"ecb239b8c2c187a4\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/ReferenceLink.js\":\"b28ce20c843b04fc\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/cycleGuard.js\":\"fa93b0827bbfb59c\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/cycleGuardContext.js\":\"05754d8d1b0efa8e\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/linkInteraction.js\":\"54467b1114547832\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/referenceLayout.js\":\"4b9a416e8bc0bbee\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/useBlockRefAncestors.js\":\"a29215fea35af853\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/BlockGutter.js\":\"97dcc256ba385f68\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/BlockInfoDialog.js\":\"acc211bd265fa82d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/BlockReadText.js\":\"bf77fd9a8f3e6e18\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/BlockTypeBlockRenderer.js\":\"2bf531ec0794f1e3\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/BulletHoverCard.js\":\"0dc1fbdd8fa212c0\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/CodeMirrorContentRenderer.js\":\"4b1996d1f6b99137\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"93a36a405834ec22\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/ColumnResizeHandles.js\":\"0ee3e9a72efc0e27\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"5ba1b0391c6787d5\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/DefaultBlockRenderer.js\":\"c38103b3489fb35c\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/LayoutRenderer.js\":\"2a23f5a6d63e2079\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/MarkdownContentRenderer.js\":\"1741cb5f6eaa699f\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/MissingDataRenderer.js\":\"efc9e0a4b8ee5e07\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/PanelRenderer.js\":\"3cf777a0d11c8022\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b67cf231cbe6408c\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/TopLevelRenderer.js\":\"0eec616a5d5e8d61\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/blockGutterMode.js\":\"d3382ad057a9ef69\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/blockTitleText.js\":\"2ad337a446f6a948\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/fieldCreationKeydown.js\":\"c577b96c98d99b06\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/layoutRootContext.js\":\"f75dc30308365a8d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/typeChip/TypeChip.js\":\"9d8bafb8b09b2b26\",\"/knowledge-medium/pr-preview/pr-1898/src/components/typeChip/chipStyle.js\":\"b8a11492db2e0dda\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/anchored-floating.js\":\"b0e7bc13fdd26ae2\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/button.js\":\"21752288080aaf71\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/card.js\":\"f1fdd5b94ee7119f\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/checkbox.js\":\"e7faa6ea4fa7b396\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/collapsible.js\":\"c00cd42c29795576\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/command.js\":\"095ea2ce0041fad9\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/context-menu.js\":\"756e2fd2bdf5a1b5\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/dialog.js\":\"c7c7c30546f9e816\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/dropdown-menu.js\":\"af03ccbbeb8d6052\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/floating-listbox.js\":\"2b42915953d64bfb\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/index.js\":\"f73e5667101fca89\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/input.js\":\"010f6c1d812a961e\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/kbd.js\":\"d74f68f1f3dbb82d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/label.js\":\"7c3932ef5ccb5445\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/textarea.js\":\"5a09dae3561c07d2\",\"/knowledge-medium/pr-preview/pr-1898/src/components/useEditModeYieldKeepalive.js\":\"feb3096ecfe166ef\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/BootFallback.js\":\"12a19d3153454595\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/FocusedRowLazyMount.js\":\"14bace586f032c4c\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/LazyViewportMount.js\":\"f5fd621cc6758bd4\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/LocalDbCorruptionFallback.js\":\"a2c05b1014461b22\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/error.js\":\"caeadc18c690ae35\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/lazyMountRegistry.js\":\"c5b8b14386e1c12f\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/suspense.js\":\"59964b202710c193\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/CreateWorkspaceDialog.js\":\"f5e16e6f9e480da9\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/PendingInvitations.js\":\"88d4ddb6a8581379\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/SyncProgress.js\":\"0d9b1835168f8de8\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/UnlockProgress.js\":\"4d1a0d6224967db1\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/WorkspaceKeyGate.js\":\"d936fd72f91c67dc\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/WorkspaceSettingsDialog.js\":\"7a260680e73b9599\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/WorkspaceSwitcher.js\":\"e20a2f77b9f809ac\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/WorkspaceSyncGate.js\":\"e02df9b9a198fa53\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/ConversionFlow.js\":\"fcf66d59f620fa87\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/ConversionFlowHost.js\":\"0b6f143cb7659197\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/EncryptionSection.js\":\"c78b5a6f5a38af68\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/attachmentPrompts.js\":\"283a832e0a3157eb\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/bundleFolderPrompts.js\":\"34f1f6f33fa5b880\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/conversionFlowDeps.js\":\"0596d988e2e2d340\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/conversionFlowStore.js\":\"a1b3c52064bdcfae\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/flowUi.js\":\"afaf777aec9ccdbe\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/useConversionRun.js\":\"6bcf706751f5b685\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/keyUi.js\":\"5c0caa0d894fa19d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/useCloseOnKeyLoss.js\":\"280d083681467d3b\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/useCloseOnServerE2ee.js\":\"e24d55f3106a6e61\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/workspaceUnlocked.js\":\"9c82ca73ad422024\",\"/knowledge-medium/pr-preview/pr-1898/src/context/backgroundSubtree.js\":\"c98a455869f32c3f\",\"/knowledge-medium/pr-preview/pr-1898/src/context/block.js\":\"7f477cc5f5aca3ca\",\"/knowledge-medium/pr-preview/pr-1898/src/context/layoutWsContext.js\":\"4e73e3584aca976b\",\"/knowledge-medium/pr-preview/pr-1898/src/context/propertyDisplay.js\":\"6313186c09af1420\",\"/knowledge-medium/pr-preview/pr-1898/src/context/repo.js\":\"cca6e31613d4e410\",\"/knowledge-medium/pr-preview/pr-1898/src/data/aliasClaim.js\":\"2807dd08ee5c7ebb\",\"/knowledge-medium/pr-preview/pr-1898/src/data/aliasSeatNamespace.js\":\"e736d6f1be719409\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/blockData.js\":\"2f5e06713c174b0c\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/blockType.js\":\"40dcfdbad0f363c4\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/changeScope.js\":\"d8a55ccafedcbeed\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/codecs.js\":\"7b8fb77e978e9511\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/derivedData.js\":\"1b99ca6548d8ada5\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/errors.js\":\"08c3bbcaadbc153b\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/events.js\":\"54f6b5fe5e085946\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/handle.js\":\"deadcc566787b496\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/index.js\":\"da79daf15bda5bab\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/mutator.js\":\"e011215092af893e\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/processor.js\":\"44eaf9ce6eb437f0\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/propertySchema.js\":\"aaa036142b52c866\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/query.js\":\"b824e778eb12a3c7\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/sameTxProcessor.js\":\"44d2db328cb4c5da\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/schema.js\":\"deadcc566787b496\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/tx.js\":\"deadcc566787b496\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/typedBlockQuery.js\":\"febe9a4e00f8fede\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/user.js\":\"86e57a9e029f9a7d\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/valuePresetCore.js\":\"a1d8f8d96cd639b0\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/valuePresets.js\":\"b41a73e9fa182aa9\",\"/knowledge-medium/pr-preview/pr-1898/src/data/attachmentCleanerIOVerb.js\":\"28e3c976385c7f42\",\"/knowledge-medium/pr-preview/pr-1898/src/data/block.js\":\"a154f53063aad15f\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockCache.js\":\"f720bf3da123ecdd\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockId.js\":\"c4f383a62347a1a5\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockLiveness.js\":\"85e9f142063eb174\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockMerge.js\":\"f7d40815de1d55ff\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockSchema.js\":\"02c26e4c018894f9\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockTypeLookup.js\":\"603c22d09a07769b\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockTypes.js\":\"f2c773ab9a05198c\",\"/knowledge-medium/pr-preview/pr-1898/src/data/childrenView.js\":\"18751775376223e3\",\"/knowledge-medium/pr-preview/pr-1898/src/data/clientContext.js\":\"6efbf83e03eab26a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/dbFileSiblings.js\":\"29cdc14a973cefc6\",\"/knowledge-medium/pr-preview/pr-1898/src/data/definitionSeeds.js\":\"e452edad0bafa876\",\"/knowledge-medium/pr-preview/pr-1898/src/data/derivedIds.js\":\"a18a069ca7d95fde\",\"/knowledge-medium/pr-preview/pr-1898/src/data/drawnSubtree.js\":\"affc467d7bb670dd\",\"/knowledge-medium/pr-preview/pr-1898/src/data/facetBridge.js\":\"4236da914ec38482\",\"/knowledge-medium/pr-preview/pr-1898/src/data/facets.js\":\"50eff4305a15b75f\",\"/knowledge-medium/pr-preview/pr-1898/src/data/globalState.js\":\"e780710c00ce6fc3\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/aliasClaimRederiveProcessor.js\":\"bc5d9319eb4f2d15\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/ancestorBatch.js\":\"40ae615bc29e59ca\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/blockTypeTypeifyProcessor.js\":\"b2af960a4de0d98d\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/clientSchema.js\":\"f18b902e9b49eaf6\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/commitPipeline.js\":\"85f911112018fd5a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/devAssertions.js\":\"e70c6be5eea07c87\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/firstSync.js\":\"8980ed0ea247b383\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/freshInitialLoad.js\":\"524c10feb9d4af19\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/graphBackfillClaim.js\":\"c1b408428ee27d70\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/handleStore.js\":\"e07cb59c81bd254e\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/idleMarkerJobs.js\":\"20773ad61a455d36\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/initialDownload.js\":\"e2402d757c09061c\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/initializeClientDatabase.js\":\"62a78702b3fbc94a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/jsonCanonical.js\":\"93c5d6f2654b42bf\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/kernelInvalidation.js\":\"f612f0b4718d7486\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/kernelProcessors.js\":\"88442ac05395c463\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/kernelQueries.js\":\"820647b4a914f2ad\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/mergeTypeMembershipProcessor.js\":\"4d827a156117a886\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/normalizeReferencesProcessor.js\":\"80b9dcce7985c304\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/poolInstrumentation.js\":\"5831aa4b9498b1b3\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/processorRunner.js\":\"c34a27b76041de10\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyCellBackfill.js\":\"ba2a19d3545c04eb\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyChildMint.js\":\"6a24445894226de4\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyChildrenProcessor.js\":\"09e2c581b0dae4b7\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyDefinitionChangeProcessor.js\":\"1ac33b97703f6719\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyDefinitionSynthesis.js\":\"dd3c3cd370a59911\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyKeyScan.js\":\"dd324c91b8957f07\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertySchemaResolution.js\":\"ee3b8a6bb4fe326b\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyValueEdits.js\":\"9e4d232622d7a51d\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/raiseProtocol.js\":\"8bdf72acd7de3c05\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/readBatch.js\":\"f6f981d52ea7876f\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/refProjection.js\":\"232d0bcae6bd8cce\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/referenceTargetLookups.js\":\"64f3c1486b685fdc\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/referenceTargetProcessor.js\":\"4a3923243d7f13bd\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/replayMerge.js\":\"e5b88e0b9c861bc4\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/sqlBinds.js\":\"083b89ffa0688be5\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c5b5c5219abff9c1\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/syncObserver/arrivalProcessors.js\":\"689c7107f347ef21\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/syncObserver/invalidate.js\":\"f1e79eb424d76f07\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/syncObserver/materialize.js\":\"cea5dcef525624e6\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/syncObserver/observer.js\":\"8dc72b5897b1e5d0\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/syncObserver/reconcile.js\":\"623a3c43a85b3291\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/timingMetrics.js\":\"dbb8451ed8cec4fe\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/treeQueries.js\":\"5d84e3af6427e66d\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/txEngine.js\":\"a5713c8a80577f70\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/txSnapshots.js\":\"5cf51d7fcfc2df36\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/typedBlockQuery.js\":\"e959f7272272a841\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/undoManager.js\":\"cd57b5df96eb075a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/invalidation.js\":\"b703683971949921\",\"/knowledge-medium/pr-preview/pr-1898/src/data/kernelDataExtension.js\":\"b4390443e7621238\",\"/knowledge-medium/pr-preview/pr-1898/src/data/kernelPage.js\":\"5551acad2d9cb440\",\"/knowledge-medium/pr-preview/pr-1898/src/data/kernelValuePresetCores.js\":\"5c700c49562517c0\",\"/knowledge-medium/pr-preview/pr-1898/src/data/localDbCorruptionSignal.js\":\"8ae75648ecb2b4b9\",\"/knowledge-medium/pr-preview/pr-1898/src/data/localDbStorage.js\":\"5852d7410011ce50\",\"/knowledge-medium/pr-preview/pr-1898/src/data/localDbVfs.js\":\"15bc13c1a0ddb473\",\"/knowledge-medium/pr-preview/pr-1898/src/data/localSchema.js\":\"6d918cd7adc56d37\",\"/knowledge-medium/pr-preview/pr-1898/src/data/maintenance.js\":\"82e44ebdd3f39594\",\"/knowledge-medium/pr-preview/pr-1898/src/data/mergeProperties.js\":\"b4e7268f0de84868\",\"/knowledge-medium/pr-preview/pr-1898/src/data/metricsConsoleHook.js\":\"73b0a413de155bad\",\"/knowledge-medium/pr-preview/pr-1898/src/data/migrationsPage.js\":\"433c4e852fdc1806\",\"/knowledge-medium/pr-preview/pr-1898/src/data/mutators.js\":\"a97e71c506f6aa81\",\"/knowledge-medium/pr-preview/pr-1898/src/data/orderKey.js\":\"1aa9ff1283a2401e\",\"/knowledge-medium/pr-preview/pr-1898/src/data/orderKeyPlacement.js\":\"33ccb06c84755e59\",\"/knowledge-medium/pr-preview/pr-1898/src/data/outlineSurface.js\":\"576c14db4ed85b5a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/pendingEditorContent.js\":\"575ec68db8366aa4\",\"/knowledge-medium/pr-preview/pr-1898/src/data/pendingUploadsSql.js\":\"0bc20ad12cf31f7f\",\"/knowledge-medium/pr-preview/pr-1898/src/data/pluginStateExtensions.js\":\"c081d4daeea39468\",\"/knowledge-medium/pr-preview/pr-1898/src/data/powerSyncLogger.js\":\"9964def35172abc1\",\"/knowledge-medium/pr-preview/pr-1898/src/data/projectorRuntime.js\":\"1ff7793fdc067cb2\",\"/knowledge-medium/pr-preview/pr-1898/src/data/properties.js\":\"3326a39d4d9cfd08\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertiesPage.js\":\"25a9dcca9885e0c0\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertyChildren.js\":\"64f7613af4b6bccb\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertyDefinitionFanout.js\":\"1cf811ba90e42461\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertyDefinitionMetadata.js\":\"e5ef88cb3aa9c7ff\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertyDefinitionRegistry.js\":\"41e622d93c5363da\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertyDisplayMode.js\":\"2c82facc61386cae\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertyRowCreation.js\":\"5212d23f3ba7065f\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertySchemaCreation.js\":\"dff421fcc270c656\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertySeeds.js\":\"837fff45c47ba61d\",\"/knowledge-medium/pr-preview/pr-1898/src/data/recentsPage.js\":\"739f2b2b4a53fdae\",\"/knowledge-medium/pr-preview/pr-1898/src/data/refTargetComparableProperty.js\":\"3635de585a5d8aca\",\"/knowledge-medium/pr-preview/pr-1898/src/data/referenceBlock.js\":\"d86209a079e0c4b7\",\"/knowledge-medium/pr-preview/pr-1898/src/data/rejectedUploads.js\":\"23770a5dc24229c5\",\"/knowledge-medium/pr-preview/pr-1898/src/data/releasePowerSyncConnection.js\":\"dfca3fad499a5443\",\"/knowledge-medium/pr-preview/pr-1898/src/data/repo.js\":\"b41b68f008fc24ef\",\"/knowledge-medium/pr-preview/pr-1898/src/data/repoProvider.js\":\"4e586ae0b3ced409\",\"/knowledge-medium/pr-preview/pr-1898/src/data/rowProperty.js\":\"ff95aca147b92b42\",\"/knowledge-medium/pr-preview/pr-1898/src/data/searchFilter.js\":\"e2079ab5ac02e1c9\",\"/knowledge-medium/pr-preview/pr-1898/src/data/seedIdentityLedger.js\":\"7fb3f33bba51c400\",\"/knowledge-medium/pr-preview/pr-1898/src/data/stateBlocks.js\":\"30dbbf5a9dd52ce9\",\"/knowledge-medium/pr-preview/pr-1898/src/data/structuralEditPolicy.js\":\"a3837d4231adee94\",\"/knowledge-medium/pr-preview/pr-1898/src/data/structuralInsert.js\":\"46db75d9cbedf8ab\",\"/knowledge-medium/pr-preview/pr-1898/src/data/subtreeDelete.js\":\"bb70ae3e43b16fc8\",\"/knowledge-medium/pr-preview/pr-1898/src/data/syncStreamLock.js\":\"cb7def0c1d94c276\",\"/knowledge-medium/pr-preview/pr-1898/src/data/syncedTableSqlRecognizer.js\":\"1e43f273c7a6661d\",\"/knowledge-medium/pr-preview/pr-1898/src/data/syncedTableWriteGuard.js\":\"c391aef444e637e0\",\"/knowledge-medium/pr-preview/pr-1898/src/data/targets.js\":\"42d2ce165f0bac27\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeColors.js\":\"0d3f87ab7e429e11\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeDefinitionMetadata.js\":\"65660995d6df4958\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeDefinitionRegistry.js\":\"f7be1e6fb9af8567\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeExtraction.js\":\"f1af98d3f5edc1b2\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeInitialValues.js\":\"f0a2e1968fa55008\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typePropertyGroups.js\":\"82e2528931735888\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeSeeds.js\":\"77a0b2f793431d98\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeTagger.js\":\"8d4206f38e49d8ac\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typedRecords.js\":\"6e499bc8d3a4ba68\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typesPage.js\":\"b5c670cef807b0e3\",\"/knowledge-medium/pr-preview/pr-1898/src/data/userPrefs.js\":\"7812a27a788a4e59\",\"/knowledge-medium/pr-preview/pr-1898/src/data/userSchemasService.js\":\"16196b8e20b061af\",\"/knowledge-medium/pr-preview/pr-1898/src/data/userTypesService.js\":\"254a13fe9ea769bc\",\"/knowledge-medium/pr-preview/pr-1898/src/data/valuePresetRegistry.js\":\"38635abbc5a29e8a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/visibleChildren.js\":\"bdf0958ca4822ec6\",\"/knowledge-medium/pr-preview/pr-1898/src/data/workspaceConversion.js\":\"2bc845663de008f3\",\"/knowledge-medium/pr-preview/pr-1898/src/data/workspaceFirstSync.js\":\"27098ab10af985f9\",\"/knowledge-medium/pr-preview/pr-1898/src/data/workspaceIdNamespace.js\":\"c5675d929cf68c98\",\"/knowledge-medium/pr-preview/pr-1898/src/data/workspaceSchema.js\":\"f804515e05850a68\",\"/knowledge-medium/pr-preview/pr-1898/src/data/workspaces.js\":\"2e74a56b36006f85\",\"/knowledge-medium/pr-preview/pr-1898/src/data/writeAheadLog.js\":\"0be203b5d81bcb26\",\"/knowledge-medium/pr-preview/pr-1898/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/BlockPasteShellDecorator.js\":\"b877761d0429b8d9\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/atTrigger.js\":\"a26cff1f97d74b7c\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/autocomplete.js\":\"9f62246eaf140051\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/codeMirrorExtensions.js\":\"8cd75ab393cdcaf2\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/contentFlush.js\":\"46fa7673c5754bef\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/defaultInteractions.js\":\"77ba195a9ee5d3c7\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/editSettleSignal.js\":\"8c6970d6791a47ff\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/insertImage.js\":\"b5b2020e21d1ce72\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/referenceCompletionRange.js\":\"f5c960d817ba11a7\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/referenceTargetTypes.js\":\"4455a4f6788897d4\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/syntaxContext.js\":\"68e8db8631884fca\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/triggerMatch.js\":\"0ea3eabc5298d018\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/AppRuntimeProvider.js\":\"d37a5ede224b15ae\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/BlockFocusShellDecorator.js\":\"43b2776b7b15584d\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/ExtensionRenderBoundary.js\":\"7457a1722acfc933\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/PanelContentRecovery.js\":\"d0d9f363102922dd\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/apiCatalog.js\":\"aa84b4442d14e95c\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/approveExtensionHere.js\":\"961303e18f3bfa99\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/armedCutAppMount.js\":\"a2cf07cd800dcf9b\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/batchableKeyedStore.js\":\"f3620697478de6a4\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/blockInteraction.js\":\"2e3049309752d536\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/blockSelectionAction.js\":\"0485b428e098cf2c\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/compileExtensionModule.js\":\"a87b826a97e940c5\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/compiledModuleCache.js\":\"8df5c5843f1365f7\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/continuousGestures.js\":\"9db1674005dda4f9\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/core.js\":\"f0813cda0f72c2fb\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/defaultRenderers.js\":\"6d2255f586271bad\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/definitionFanoutAppMount.js\":\"eb9e01e3fc98ab83\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/dialogAppMount.js\":\"7f4cad050101a10d\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/dynamicExtensionSeeds.js\":\"3888f33bf79567f5\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/dynamicExtensions.js\":\"d3665a81f3c1c0f3\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/exampleExtensions.js\":\"af5a7fcff1220353\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/extensionApprovalStatus.js\":\"350c2d88fda51b07\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/extensionLoadErrorToast.js\":\"bb16e2eed3072c1f\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/extensionLoadErrors.js\":\"fb45dc72945194b1\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/extensionLookup.js\":\"6f89356fd3c990fb\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/extensionToggles.js\":\"0a1b41f95228c969\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/extensionUtilitiesCss.js\":\"3f45f8b8779bfc7f\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/kernelPageDeletionGuard.js\":\"23129197eda9163a\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/liveRuntime.js\":\"26ec547565994131\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/openExtensionsSettings.js\":\"03c57f8028c95a73\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/overridesCache.js\":\"8d4a3ceec9871826\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/pluginIds.js\":\"fd3bded7623b2085\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/processorRejectionToast.js\":\"7a76e0d68a4b854d\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/runtimeActions.js\":\"836cc12e071c4cc7\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/runtimeContext.js\":\"835ac1f0fcfe16ec\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/staticAppExtensions.js\":\"e48727122f15ba78\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/staticDataExtensions.js\":\"2ed94ef2a99d0fc7\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/toastAppMount.js\":\"6ab4da4e6d788789\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/useOverrides.js\":\"2c0406a01bf5533c\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/useShortcutSurfaceActivations.js\":\"4be638deca63981a\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/discoverToggleTree.js\":\"86856e0414721ac7\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/facet.js\":\"4367ec56871644e1\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/resolveAppRuntime.js\":\"171edb5c42feed9e\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/runtimeEvents.js\":\"40f40ad939912fd5\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/togglable.js\":\"c8afd017916b5ebd\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/variantFacet.js\":\"61b3e5654df65ace\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/verbFacet.js\":\"25951572df14924a\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/block.js\":\"773fbdcf03bec0d0\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/focusedChild.js\":\"22fba4c276d23025\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/propertySchemas.js\":\"f8920a0f0c716b0d\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/typeRegistry.js\":\"a533ac15d070a8bb\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useAncestorCrumbs.js\":\"2716cf655423bdf3\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useAutocompleteListbox.js\":\"13aff8cf00fd714e\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useDebouncedSearch.js\":\"85c151913380d53a\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useDebouncedValue.js\":\"174224a42d425d51\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useFacetValue.js\":\"cf2dad754c04adb3\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useIsFocalRender.js\":\"6e38bad2c5791cef\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useIsReadOnly.js\":\"f717d0fa8bbbe70a\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useMaterializeBacklog.js\":\"abbce4febcb60540\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useMinuteClock.js\":\"8f96d90a2490693d\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/usePanelLayoutProjection.js\":\"acdd3e7f3b477914\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/usePendingInvitations.js\":\"6d2f05edd3000c67\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useRendererRegistry.js\":\"8c288a67a570510b\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useRetainedFieldRows.js\":\"c1333ad68dbb8140\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useWorkspaces.js\":\"030ee37da920e8cc\",\"/knowledge-medium/pr-preview/pr-1898/src/lib/utils.js\":\"da64ef81a1d69720\",\"/knowledge-medium/pr-preview/pr-1898/src/main.js\":\"c49d5c76b3d7fc13\",\"/knowledge-medium/pr-preview/pr-1898/src/markdown/MarkdownImage.js\":\"bb877c7ceb5b0e88\",\"/knowledge-medium/pr-preview/pr-1898/src/markdown/blockSeparators.js\":\"1571c82b70355966\",\"/knowledge-medium/pr-preview/pr-1898/src/markdown/context.js\":\"170dae26abc9a0e9\",\"/knowledge-medium/pr-preview/pr-1898/src/markdown/defaultMarkdownExtension.js\":\"a421db11d1dcfadd\",\"/knowledge-medium/pr-preview/pr-1898/src/markdown/extensions.js\":\"aa5400882f6da795\",\"/knowledge-medium/pr-preview/pr-1898/src/markdown/renderMarkdownHtml.js\":\"abff2f95b83ae018\",\"/knowledge-medium/pr-preview/pr-1898/src/minimal-editor.js\":\"5aa4f1627c748366\",\"/knowledge-medium/pr-preview/pr-1898/src/paste/armedCut.js\":\"8ac7c4c173d76c28\",\"/knowledge-medium/pr-preview/pr-1898/src/paste/captureMediaVerb.js\":\"4824c4e36d7492b1\",\"/knowledge-medium/pr-preview/pr-1898/src/paste/clipboard.js\":\"bc8f1f2ceb9fd9bd\",\"/knowledge-medium/pr-preview/pr-1898/src/paste/decision.js\":\"fc13bdf02e4ed2b9\",\"/knowledge-medium/pr-preview/pr-1898/src/paste/operations.js\":\"75ea6c7f2c446b1d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/account-header/AccountHeaderItem.js\":\"b6b7ad2914d300f7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/account-header/index.js\":\"edea2e533251b6c3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e33dcbce9309e388\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/askAgent.js\":\"2f1236f93e2a1e97\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/askedStore.js\":\"c8cec06469e97e40\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f336b95d09c9ef5c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/chipState.js\":\"ace37133b49e0fe5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/dataExtension.js\":\"01e172f79c09280f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/index.js\":\"bfdd3066b34344c1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8130ca8aeef577f7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/schema.js\":\"f1ec5e840b6e7ab8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/AgentTokensDialog.js\":\"028541418323af3b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/BridgePairingDialog.js\":\"d6da77a6e8fc9a41\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/addMedia.js\":\"7732044305f005a5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/backlinks.js\":\"cf6f7b38a25128bf\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/block.js\":\"46cf6bbdad077d7c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/context.js\":\"31b225c33861e7f3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/displayIds.js\":\"86bd7459e890bf5e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/index.js\":\"8ddbf7094889db7a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/outline.js\":\"799d3905f178727c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/properties.js\":\"68207a1145e5daa2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/refs.js\":\"1eb91a2562e18319\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"a19d346a5d77c761\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/search.js\":\"7e04b1e617f13cbb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/shared.js\":\"35e01ee1b149b6d6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"e90f97ae20be98cc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/text.js\":\"d93670b10efae74c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentWrites.js\":\"cb388e91eda90dd9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/authoringCatalog.js\":\"7212f02ccaf249d3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/blockRefTargets.js\":\"369b2f466581b196\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/bridge.js\":\"073bdd7bd92bd191\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/bridgeLoop.js\":\"2feeeefa16fa596a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/changeHistory.js\":\"70990f5dd3feb393\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/commands.js\":\"2cb6dfaa091a3427\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/commentsCommands.js\":\"13aa01fe9bda8d7c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/dataExtension.js\":\"66d6b48470292a1b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/dataModelGuide.js\":\"1a84d12d14b2f4a8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/dayPropertyInputs.js\":\"ba6cf4b631cf1367\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/describeRuntime.js\":\"13c3b1f4b5293824\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/extensionLint.js\":\"a63b55cfa9393c2f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/grainAudit.js\":\"363ea96e39b762ad\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/healthCommand.js\":\"8545419924b6cf2f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/index.js\":\"3f8aa32461be9cda\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/presetIdentity.js\":\"877a750f080d53de\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"3c253d2addf71900\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/readMedia.js\":\"0983ada9cb5f884d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/schema.js\":\"13bcd06a9750006b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/serialization.js\":\"ac024ea10e52bcf1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/targets.js\":\"bc844341e4701f9b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/tokens.js\":\"e6fc9783f709b967\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/watchEvents.js\":\"abf82cb57e43ea07\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/workspaceGuard.js\":\"4b00466ee481cb65\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/writeCommands.js\":\"ba4089b795491586\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/AliasCollisionToast.js\":\"03060080d662c472\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/DuplicateNameBanner.js\":\"370ee257adf8c34b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/collisionMerge.js\":\"7c0d5778178f3345\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/dataExtension.js\":\"65007d6b47643cb7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/index.js\":\"84151ebe92d2d9e1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/mergeCollisionAction.js\":\"de09e4a23320dbb1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/pageStyling.js\":\"ffd33d95e5ac8fc8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/rejectionToast.js\":\"40b848d3e17b340a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/syncProcessor.js\":\"7548ed30693de413\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/actions.js\":\"8af62ff39919aa47\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/addComment.js\":\"e29b5c0b5601b28c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/anchor.js\":\"6c242569c745fe0b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/anchorState.js\":\"a0257a6462736bbe\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/commentLinks.js\":\"95c89ad9e1a7113d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/confirmThreadDeletion.js\":\"0e4e96b2ee604240\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/container.js\":\"77932fbe0ac5d73f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/dataExtension.js\":\"6fab299d929b4823\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/deleteComment.js\":\"ddbe534c08fbdafd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/highlights.js\":\"f32930ddb038e851\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/index.js\":\"fe04b2e33cbc675c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/linkedCommentsPill.js\":\"245e2e5dbe5d2ef0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/margin.js\":\"234b341a94738c6c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/marginAnchorLinks.js\":\"1b9ce37c2b8cc84e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/marginSchema.js\":\"0ae096b4eaf073ba\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/newComment.js\":\"3d53973d50b34ad1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/ownThreadPicker.js\":\"4ff181a713947e94\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/placement.js\":\"055d2ddf60a192d4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/queries.js\":\"57098d8bdbe788f6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/quotePosition.js\":\"978d7978cbfb7a0e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/quotedIn.js\":\"e7d654ae76618677\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/quotedRange.js\":\"92851f4f7a8d8e86\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/rangeRefs.js\":\"67f770a7fc64a975\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/readHighlights.js\":\"739e40e794b76e22\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/readSelection.js\":\"5d0d4e797a45f89c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/readSelectionUi.js\":\"a0a64105f41867d9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/reanchor.js\":\"7877a3fe665c2974\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/schema.js\":\"abd9969bf2a9c23b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/scope.js\":\"f74e6d2da33081a7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/scopeThreads.js\":\"ab7b3f88ba56c9d2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/splitRetarget.js\":\"a4260a40a14bd31d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/suggestionCard.js\":\"ec03154973f1acea\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/suggestions.js\":\"aa24577109e32534\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/summaries.js\":\"5015bd5276b49a3a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/summaryBatch.js\":\"cb4c8f8edf0d56a9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/surface.js\":\"9dd828cbf0345a2f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/threadNavigation.js\":\"e6b8c8a9b48d854f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/threads.js\":\"ab97b2c51b50d2ee\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/ui.js\":\"84fc4ff11a589f3c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/uiStore.js\":\"40bafe3a144d1e7c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/app-intents/appIntents.js\":\"103eadccdf2d8d70\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/app-intents/index.js\":\"83dbc5d8a04ae821\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/app-update-prompt/index.js\":\"2bdc7bea10c8200a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/app-update-prompt/status.js\":\"195520c6484b32da\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7699e89b1cade6f8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/MediaBlockRenderer.js\":\"034a1be829085f22\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/MediaDownLaneReplicator.js\":\"8c02c6c8cef99e3f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/MediaUploadReconciler.js\":\"2b22a42db2d02c4a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/assetDownLane.js\":\"87a2f0fa511e9480\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/assetResolver.js\":\"983cf691fbaa86f3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/assetUpload.js\":\"e5b78db5aa05cc73\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/attachmentCleanerIO.js\":\"c09dbdb2a14ca836\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/audit/supabaseAuditIO.js\":\"be6fbbfc37de0ac4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/blobStore.js\":\"0784d24380503dde\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/browserMedia.js\":\"ca642a04bb191ed9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/byteStore.js\":\"0529b2b4241afc67\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/cleanerIO.js\":\"4f70ba13c9a1fcde\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/cleanupAttachments.js\":\"3aabeceae8ff7d7e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/dataExtension.js\":\"a01585cb8d8b9468\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/downLane.js\":\"590fd19abf0c6611\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/index.js\":\"243d1b0ec10a0d36\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/insertImageContribution.js\":\"dc46e682e2b7b533\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/laneArming.js\":\"99fea94f4a8dd19d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/laneLock.js\":\"52442e9fa8ff03e5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/mediaBlock.js\":\"3b06ba1cfbbca956\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/mediaCapture.js\":\"825d935f5d93921d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/mediaLanes.js\":\"b7e2f8d0d8a49add\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/mediaViewers.js\":\"18247c4968613e52\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/mediaViewersFacet.js\":\"91e4bfce556ed65f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/pasteCapture.js\":\"e3765edb6b90b563\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/resolver.js\":\"36542bf186bd5eb3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/retryUploadsAction.js\":\"e5cd3b7869bffd0d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/storagePaths.js\":\"c2053e0272498546\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/uploadDrain.js\":\"01824c8700709fd1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/uploadLaneStatus.js\":\"5098a9d86e258f9b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/uploadReconcile.js\":\"817177cf93256fe0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/uploadRecovery.js\":\"0e46ec0934954c78\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/uploadStore.js\":\"d13d961a1ee6535d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/useAssetObjectUrl.js\":\"bc639ea0cbefbb44\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"20693823a79f9c91\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks-view/BacklinksViewSection.js\":\"2b00fc2e35d6827f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks-view/facet.js\":\"9bbf946936420058\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks-view/index.js\":\"b849fa73b057339e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks-view/prop.js\":\"7813d778b2c95c38\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/BacklinkFilters.js\":\"847c6a63b03b0017\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"beee0a32f78900a4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/BlockEntry.js\":\"d089ce216a1c2b34\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/LinkedReferences.js\":\"59aafb997b4c0c71\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"ece0f9f64d8cd717\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/dailyNoteDefaults.js\":\"8e8a393ae0c4227b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/dataExtension.js\":\"7247bb8ea1af292f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/edgeExclusions.js\":\"9aa39e5ea145e8f6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/filterProperty.js\":\"f23dec96b4a349dc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/index.js\":\"aa8ea4dfb0c6c933\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"90684466f701b5df\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/inline-counts/applies.js\":\"3190df263f88b6fd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/inline-counts/countQuery.js\":\"df9a035c12ae4d3a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/inline-counts/expansionStore.js\":\"106aead21296e9dd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/inline-counts/index.js\":\"170a21458e5a81ce\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"219f1b3d794687eb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/presentationInvalidation.js\":\"516b4463d8d0fc4f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/propertyEditorOverride.js\":\"1725e0ae306da553\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/propertyFilter.js\":\"98666ee6b42ad6d1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/query.js\":\"9f70ae46f635ca97\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/resolveFilter.js\":\"feb4e8b0321430b4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/sourceBatch.js\":\"5355a2d0419d23bd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/sources.js\":\"a4d3c7ce633f570f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/useBacklinks.js\":\"cca5ee6d28c945fa\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"c56eac73adfdfc95\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/birthday/BirthdayCelebration.js\":\"07f3eee8089bd6f5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/birthday/BirthdayOverlay.js\":\"ad42ddffc29f0aed\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/birthday/gate.js\":\"10aee71582f9ca74\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/birthday/index.js\":\"d100e5c3c726d066\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/birthday/wolfTheme.js\":\"ef7dc53a7cb469b1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-drag/BlockDragLayer.js\":\"99956a810a0ded5f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-drag/dragController.js\":\"f9a24a736af2c24e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-drag/dropTarget.js\":\"2ac9abc106c3e87b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-drag/index.js\":\"5c76f616cc7c626b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-drag/projection.js\":\"989a736733c7dd12\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-info/BlockMetaCard.js\":\"94f2bc873d80bc63\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-info/index.js\":\"d49e36323a3d049b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/AddTagDialog.js\":\"518de3d0d195b729\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a2d3db1becfa622f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/TagNameIssueHint.js\":\"c84896c05ba827f2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/addTagAction.js\":\"3c7c2405cccb464b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/appendTag.js\":\"3afd4b2068d77ab2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/config.js\":\"9114ef5f8cf76626\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/dataExtension.js\":\"5f8890882d6459ba\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/index.js\":\"aed4d0d7eeb4dbba\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/propertyEditorOverride.js\":\"cc8b782504541e7c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/BreadcrumbList.js\":\"177381b9a64d865c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"da4e722c55695970\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c0fd37b0d815a9a7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1119d46d4e5f60e5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b2adf36490f090a5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/index.js\":\"af8a94a816a7cec1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"aaea07718f74e8ba\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/CharacterCountItem.js\":\"537aaebde1175ab8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/ProfilePropertyEditor.js\":\"9284a860f5104d00\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/actions.js\":\"3a39535e01e3c1ed\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/blockType.js\":\"92d1d2d1ef177423\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/charCount.js\":\"f67008210b333313\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/dataExtension.js\":\"1dc31435547a57b8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/index.js\":\"8a727ef1be9b5479\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/profiles.js\":\"ab50f6b15923b384\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/properties.js\":\"105f62dba80af8d2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/subtree.js\":\"e3009e6697fd392b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/textCounts.js\":\"16c1842598876231\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/colemak-keybindings/index.js\":\"1d3069763166c2d9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/CommandPalette.js\":\"4e73cf82b01751c6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/HeaderItem.js\":\"099d4be180e39647\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/context.js\":\"9b0e03ce9b51b3f6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/index.js\":\"5ce0613b8c1511ef\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/selection.js\":\"b6f0e40b7f97165c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/toggleStore.js\":\"865c43d57d7eaa03\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/useCommandPaletteActions.js\":\"6178646870cf2e69\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/ContributorBadges.js\":\"8f41e8d3bbff5d6e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/ProfilePicture.js\":\"2d5393fb9d01e040\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/author.js\":\"7f7bec49aa417000\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/codeMirrorExtensions.js\":\"2b1b074d6af97b1f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/dataExtension.js\":\"445a25fb3a76feca\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/index.js\":\"2f9dce8ab90aadc8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/mentionAutocomplete.js\":\"68414c1a9d486353\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/processor.js\":\"1f8565d3ce64c697\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/profiles.js\":\"3d56dffe38752125\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/queries.js\":\"565913876d36a3d5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/schema.js\":\"237141e4b1ceb380\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/useCommentAuthor.js\":\"b4752cd845475192\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9c0ca43d420b96f7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/cursor-follows-scroll/followOrigin.js\":\"993b615ed3dae143\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/cursor-follows-scroll/index.js\":\"2f2b5edb960faa57\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a7f1fb6d274c9480\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"fe77b878175ba180\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/CalendarGrid.js\":\"93e2cfddc5b0d8a7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/DailyNotePicker.js\":\"62254fae86f0358c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"2566d9007fe359b7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/DateNavDecorator.js\":\"757dda72c1b47509\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/DateScrubOverlay.js\":\"50dea72dbd106b34\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/DayPropertyControl.js\":\"07d2e4c5d7c0ec98\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/DayValueReferenceControl.js\":\"e7abff821acc7217\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/HeaderItem.js\":\"106dd44161eca8fa\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/ReschedulePicker.js\":\"16958b3cc5ce8889\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4064f4471b728345\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/actions.js\":\"36f698ade04ecc11\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/blockDateAdapter.js\":\"873633534414c47f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/calendar.js\":\"e81b481535dfb157\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dailyNotes.js\":\"1aef642cadaaccee\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dataExtension.js\":\"2c218cc99eec1653\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dateScrubActions.js\":\"f5833d307c157a0a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dateScrubGesture.js\":\"f5b399a56628ef93\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dateScrubGestureActions.js\":\"48f81a4856af9c8f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4cc84f86b152d882\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dayProperty.js\":\"97f4cf9152320bf1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"d60e7cb945e34cad\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/deletionGuard.js\":\"07574f1dd736a594\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dueQuery.js\":\"d52ab7971d1b6eac\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/index.js\":\"f5fb323b9e6a22ab\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/landing.js\":\"310e9610a7d3d4ae\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/localSchema.js\":\"81eca6bce5cc92ca\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/referenceDateAdapter.js\":\"5e8e7e04d7ea4d4d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/rescheduleAction.js\":\"4d1fb072dc672c9f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/schema.js\":\"5ff4558235933fe8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/spreadBlockDates.js\":\"e6c8bbd0add0d29e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/spreadDatesAction.js\":\"b8d79acf41c6521d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/today.js\":\"f61c4ba2d974754c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"37b3c00bc43e9229\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ab0b0f48efac3db2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/audit.js\":\"0a225077c8846ba2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/auditAction.js\":\"c7aecb456650f008\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/auditRanges.js\":\"0537b69664894edc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/diagnosticsSource.js\":\"af5bf06c816f4087\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/divergenceScan.js\":\"2be6ca5d8562027e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/index.js\":\"d660e7a177f5eb6c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/propertyChildrenChecks.js\":\"27c02b9bc4d3c1a3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/referencesMirror.js\":\"50aee2654afbdad3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/rowJson.js\":\"184726b9a5a912b7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/schedule.js\":\"6caaa5aa735b518f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/store.js\":\"8155e1abcde50dcd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-maintenance/action.js\":\"dda5adeabbb3756d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-maintenance/index.js\":\"03e5a95a3b48b313\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-maintenance/plugin.js\":\"a65f1dc74d7b68b3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e131e50389799ec1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/actions.js\":\"cc3e5831da69091d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/changeMarker.js\":\"1a244de5d91908d2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/diagnostics.js\":\"23b779b40a0ffaae\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/fileSystemAccess.js\":\"c9f7c7d7fdaf8784\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/filenames.js\":\"f0e035e92f2f9b65\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/index.js\":\"a98caba4a6f1aa59\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/mirror.js\":\"b82193d51d70e57c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/runLock.js\":\"ef35245fffccc8ba\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/runtimeHealth.js\":\"de7593c1cde0a851\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/schedule.js\":\"ec8586e3c9ba3cb5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/store.js\":\"779c25be1ed667e8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/default-themes/index.js\":\"1771eab5a1b14137\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/default-themes/themes.js\":\"30b81ae18af14a45\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/diagnostics/facet.js\":\"c8b0b34de8c17c92\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/diagnostics/useDiagnostics.js\":\"1fc39bdf52006720\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extension-prompts/dismissals.js\":\"c9550a209d1a9b35\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extension-prompts/index.js\":\"91b6ed8d2302071a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extension-prompts/status.js\":\"4707dedb73a574af\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extension-prompts/store.js\":\"fbaea48a4ec2d0ea\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"d6a3c6f84fe9d326\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/ExtensionsSettings.js\":\"0082fce77909095a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/actions.js\":\"ce33238329f8b4f5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/config.js\":\"2e4c57855080d04c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/dataExtension.js\":\"cee5988dde360ab7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/effect.js\":\"0f690a8ad8b6398f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/index.js\":\"188478fca03ece02\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a28c66dd8747d9bd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/useToggleTree.js\":\"30d9e2678ae7d41f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extract-type/ExtractTypeDialog.js\":\"71856cd5c0b4d8d5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ce3e0d6ce25696d8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extract-type/PropertyShapePicker.js\":\"1195e6f3d7210ee1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extract-type/action.js\":\"8cf3093a9d214b72\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extract-type/index.js\":\"655847542a8a5f7d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/FindReplaceDialog.js\":\"0560ba79bcc32892\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/HeaderItem.js\":\"5035e2f1ee2bef9b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/dataExtension.js\":\"cbb25bb2f3fddbbb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/index.js\":\"a02c5a66a0aeadfb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/search.js\":\"581323d1395795f6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/toggleStore.js\":\"b4b2d9ff01168d67\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/LocationPropertyEditor.js\":\"8e689d56974ed08c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/MapView.js\":\"c50f884a8add6971\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/blockTypes.js\":\"1a6d52797839e2c2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/codeMirrorExtensions.js\":\"3b13b7d7b3c16e19\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/createOrFindPlace.js\":\"91bdb355484bae3d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/currentLocation.js\":\"c9dbda477fac484d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/dataExtension.js\":\"c53d93d3a3ed8a39\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/geoContentDecorator.js\":\"77820c7dcf91d7e4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/googlePlacesClient.js\":\"43ea3581dca4d3c2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/index.js\":\"d9df935c964df6ef\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/locationsPage.js\":\"152a3ac71f0b9643\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/mapViewport.js\":\"8d93b5d7d55b22fb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/pickCurrentLocation.js\":\"b457f20453ad39fb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/placeAutocomplete.js\":\"f055a3eab708ac38\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/placeNameCollision.js\":\"471d3c7638a79370\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/properties.js\":\"0cc29df5357f0011\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/propertyEditorOverrides.js\":\"fac1426d729b13db\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/query.js\":\"a819bbf15caee59c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/usePlaceSearch.js\":\"96d18743a8425da4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"2e1cff1b6c94b25a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"4ea1304806d9bc41\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"48faa931ca0dbe9e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/config.js\":\"20fcd5d866e44300\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/dataExtension.js\":\"6aa782f72d0960db\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/facet.js\":\"16a1549281aebc60\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/grouping.js\":\"a24441263a7e301f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/index.js\":\"c85412d8b63a9c98\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"563a4e9d9603eee5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/query.js\":\"2d6313f43b6f6153\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/resolveConfig.js\":\"ef874a17f02c43e9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d8cf15f4b3cda95c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"ae8ca3e2c4a04523\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/HtmlDocumentContent.js\":\"71dd2edb43390165\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/HtmlFrame.js\":\"b8bfe99e403ea6a5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/actions.js\":\"b2a40b988ddabe7c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/blockType.js\":\"674338be584e8138\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/confirmRunScripts.js\":\"859485dcd517df9a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/dataExtension.js\":\"f16fe597982dfe3e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/frameAnnotations.js\":\"59e286394882a9ae\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/frameDocument.js\":\"e7c771349852196c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/frameTheme.js\":\"f3ce564358169fc5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/index.js\":\"cbfb91c5e98bce53\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/scriptConsent.js\":\"e94345005d3c8d3f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/sourceMap.js\":\"e2297bd885e1ddc2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/useDocumentScripts.js\":\"b16c39128c92d074\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/interaction-metrics/index.js\":\"c22785a793d2e34f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/interaction-metrics/record.js\":\"5e442d1fd917015c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/interaction-metrics/recordStore.js\":\"1a6b782c2e9d89c5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/interaction-metrics/responsiveness.js\":\"d65651dc517e7455\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/interaction-metrics/schedule.js\":\"183fbe9cd54407e8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/interaction-metrics/sessionContext.js\":\"18909436441bf73e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"efdf02e2955ef57b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3bbc73f0ebd25973\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/actions.js\":\"00d009ca0f96cebc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/config.js\":\"b8e1fc9244da7de9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/dataExtension.js\":\"cd2f6385a987d710\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/effect.js\":\"afef8d376daea1d8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/index.js\":\"2d1df8ca9957b76b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/keyCapture.js\":\"347ab8c26fc728b0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/overrideStore.js\":\"0b1dac1f7f128557\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f65e719e6eb6f63f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/HeaderItem.js\":\"80ce7bf8bcd8723c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/LeftSidebar.js\":\"889e24c26d72cc2e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/actions.js\":\"ad0a3ba093192ac6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/facet.js\":\"83d320e02c8799d7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/index.js\":\"da12180c95e283c4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/shortcuts.js\":\"483a5505af510d1e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/toggleStore.js\":\"72ac1647e0f45b16\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/merge-blocks/MergePicker.js\":\"c3d0c2f6718ff5e1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/merge-blocks/index.js\":\"b07d1b502086c11c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/merge-blocks/mergeAction.js\":\"9eba9de5ff5d12a7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/merge-blocks/strategy.js\":\"308131625baff011\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-bottom-nav/Button.js\":\"16de7ae112a8950f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"f5b1b4af7e5264ea\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-bottom-nav/defaultItems.js\":\"95b7a3bc7b46d31d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-bottom-nav/facet.js\":\"61ff6032f08f0742\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-bottom-nav/index.js\":\"b503fe07ce43afbd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0f3de166ca4a19b1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-keyboard-toolbar/actions.js\":\"3d7f02b787c827ec\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"d4a4cf046b4ec309\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6dbe0662b043eb37\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-keyboard-toolbar/index.js\":\"a4001a417420a3aa\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/MoveDestinationPicker.js\":\"4ed3bca2dd11e885\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/blockSubtreeMembership.js\":\"77b93a50f047f4a8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/contextMenuItem.js\":\"1b563fde52d7ffe5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/index.js\":\"5039aaad67fe1b43\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/moveAction.js\":\"3b5218c6962f92a7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/moveBlocks.js\":\"f7c176861198c3ae\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/selectionAfterMove.js\":\"b4a1a43f3ce84509\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/TutorialBanner.js\":\"817224c5fa1295ea\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/action.js\":\"e46141caf624946f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/bannerDismissal.js\":\"6af08bffedcfc133\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/documents/cheatSheet.js\":\"22bd5f03b4813228\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/index.js\":\"98ab0b1b8756b0f6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/keys.js\":\"834cb1a962bea21b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/landing.js\":\"6d6d0b40263121fe\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/outline.js\":\"784eec67dde5529b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/seed.js\":\"cdc357682cab274f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f08577409d4606d0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/analyze.js\":\"b0b942a6ba2ac656\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/diagnosticsSource.js\":\"84a66d1370dce71e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/index.js\":\"d2abf8fcfe4ebf48\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/load.js\":\"33a2870615456e9c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/monitorRun.js\":\"711ad71d95e93cd4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/schedule.js\":\"97f3109041fc1542\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/series.js\":\"e350425d19c5404e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/store.js\":\"87672d7899d4773f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/trendAction.js\":\"cbb721ce43087736\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/verdict.js\":\"ac7b99b6de5348c3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/plain-outliner/clickToEditAction.js\":\"e789abe8ded86164\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/plain-outliner/index.js\":\"1ec346389743ef2e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/plain-outliner/interactions.js\":\"f53e622ccf9f4521\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ac21c6adcd06b06e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/MigrationGate.js\":\"9adaf9e9f250091c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/MigrationGateDialog.js\":\"2f56180d9fa9c6bc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/action.js\":\"e933dc31e22878d7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/index.js\":\"438388e70d8b1d99\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/localRunMessage.js\":\"9eb6fdc10a74bdbf\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/plugin.js\":\"c9f0882c27a14dd3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/progressReport.js\":\"fc612ac9b1802dc3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/sweepProgress.js\":\"03e6f6710a399f93\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/FieldRowRenderer.js\":\"1cd5b1cf142d10a6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/ValueRowRenderer.js\":\"a8c3cdc6a207aaf3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/actions.js\":\"13192c6e5613d1e9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/autocomplete.js\":\"09a0b51acbfe13cb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/fieldRow.js\":\"e6b6e4ccea80b515\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/index.js\":\"80fd59809a01191d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/referenceWarning.js\":\"d6e5ae8e022dbbc9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/valueAutocomplete.js\":\"8aad8f0be6c376fb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/valueSchema.js\":\"53c5f7df017202b2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/HeaderItem.js\":\"287682dabacbda09\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/QuickFind.js\":\"654a85aee36ad370\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/index.js\":\"63d78e513520c59a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/recents.js\":\"bf13b129d2699a05\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/resultItems.js\":\"f26bddda25f4787c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/selection.js\":\"dc776fd46c21b37d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/toggleStore.js\":\"2907ed04aaf330cd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/recents/HeaderItem.js\":\"2d8511221b891cee\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/recents/RecentsPageBlockRenderer.js\":\"bbc5302bb66dc343\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/recents/grouping.js\":\"e02cca8409a1c3ad\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/recents/index.js\":\"625b6777a3bd6657\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/recents/target.js\":\"168055eac1c109a7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/codeMirrorExtensions.js\":\"b42febc97453d726\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/contentPrefill.js\":\"4fd99bf7b744d204\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/dataExtension.js\":\"637e6191ab76af03\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/index.js\":\"beeae55f9477f9cb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"f13d43263902bb87\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/invalidation.js\":\"8995dc3703858e36\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/localSchema.js\":\"d094c5527cf5f9db\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/blockrefs/index.js\":\"34cfaabc371de35c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"ea1e8f2e13d7d01d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/index.js\":\"8fb97a6014c51586\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/referenceNode.js\":\"4a4255493707d24e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/remark-reference-occurrences.js\":\"0e17872c4ef6a1e2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"61213d9f4d731113\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/wikilinks/index.js\":\"2d11022c48c0862b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ad5f5c977cd7f4af\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5fd1d9667011a339\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/mergeRetargetProcessor.js\":\"c8c6ec6b2b6e7169\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/parseFence.js\":\"ebe307d1a7ce7c62\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/referenceParser.js\":\"89fb641f669699ab\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/referenceProjection.js\":\"8674a872fef25402\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/referencesProcessor.js\":\"3bd7f7327d47b629\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/renameProcessor.js\":\"ddb14f426ac20b70\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/spanReplacement.js\":\"28fa74f617e450c9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/rich-paste/htmlToOutline.js\":\"e7cbcb7031c30228\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/rich-paste/index.js\":\"3e5d8698be9be7e2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ffeb96c14065edeb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/rich-paste/pasteDecision.js\":\"d913b6bcd2adb601\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/action.js\":\"a9aa07bf40c64be9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/blockIds.js\":\"f64e8fce2e9e4671\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/content.js\":\"9e70b9001d7fe4b1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/effect.js\":\"6afe22ecf1c25d89\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/ids.js\":\"71e8362ec5ef93bd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/import.js\":\"9dba1f5fc2bc4758\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/index.js\":\"4affef7be64d3a7f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/plan.js\":\"4cd8d35c19baae3b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/plugin.js\":\"b3ef4566731c0d45\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/promotion.js\":\"96a65b8b4b083bbe\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/properties.js\":\"a4e7b4e15fde617c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/references.js\":\"bac3ca1144df59dd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/report.js\":\"674e0e1064f2d20d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/roamMemo.js\":\"bb2dfa9ddad4ac79\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/runtime.js\":\"4136efb9d5ca5ba3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/schemaReconciliation.js\":\"117b7e756126ee49\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/srsMarkers.js\":\"92f08e992a69103c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/todo.js\":\"d3bb8a629f96b86a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/typeCandidates.js\":\"815b83bd5e6b571a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/types.js\":\"41a242ef4a493d76\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/search-health/index.js\":\"a1e18751c0e2a588\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/search-health/store.js\":\"bb0c8e3afcdb8b18\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/shortcut-help/HeaderItem.js\":\"aafcbf5769b59f42\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"8885931a21cfc243\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/shortcut-help/index.js\":\"4df3c3abab7006ed\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/shortcut-help/model.js\":\"d25fe5a46440267a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/shortcut-help/toggleStore.js\":\"1052fdddf209f283\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/shortcut-help/useKeyInspector.js\":\"210073ae08b32342\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"802882f7a8663b28\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/ShellDecorator.js\":\"79e97e5f94f7da21\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/actions.js\":\"e3652a8d7e8b34ed\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/exclusionsFacet.js\":\"442595e91ef282e3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/index.js\":\"596f27bab570249a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/shell.js\":\"4b44b4f85896776c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/surface.js\":\"ce9b0bd3ccc2767b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/walker.js\":\"d7e98011275c42d0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/RescheduleToast.js\":\"eeb2c37399e60cd0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/dataExtension.js\":\"2a2db1ca43fb418b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/index.js\":\"5856ac6733456db3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/indicator.js\":\"828a8583549ff130\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/moveSrsState.js\":\"2f048c135455ed5c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"08e9f2ea9e31f5aa\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/scheduler.js\":\"d5ae525e958d619f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/schema.js\":\"54821db999bc6fde\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9dfc438614c70b4b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/srsClipboard.js\":\"cf6bb4d4499679e3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"0495ea5ac167d520\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/DailyNoteReviewHint.js\":\"0d41070f740a9709\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/DeckPicker.js\":\"3dfaf5a82f9ddf3c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/ReviewControls.js\":\"a3fbeddb6b90ee11\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2fe721c1bc33c0e4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/ReviewSession.js\":\"aa6f24e84e7968dc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/actions.js\":\"d1dd8d7a2486b6d2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/archive.js\":\"498ef134ddac6faa\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/dataExtension.js\":\"c2bb8296672d42ae\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/deck.js\":\"714cfd3f8f8706e8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/dueQuery.js\":\"c9141687685c221d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/gradeDecision.js\":\"e94ed9dfdd76c40c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/index.js\":\"f1b7a9f2265897fa\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/keyHints.js\":\"2dfa8a339eb7df3b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/reviewCardLayout.js\":\"60d7bd484e38634b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/reviewProgress.js\":\"0e74e9c705708398\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/schema.js\":\"538ad1a339beab39\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/useDueCards.js\":\"af0b99a3763ed1cf\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/startup-metrics/index.js\":\"deeb6de9e4330214\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/startup-metrics/record.js\":\"99983407fe4ba9c1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/storage-persistence/index.js\":\"042c78c0001d9305\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/storage-persistence/persistenceStatus.js\":\"0d68bd072d59defd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/storage-persistence/requestAction.js\":\"8e0068365c47cbb8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/supertags/TypeChipsDecorator.js\":\"10a25bbee931591f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/supertags/codeMirrorExtensions.js\":\"e10fd3e0dd8e9dea\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/supertags/index.js\":\"8164225b5af2ac4b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/supertags/typeAutocomplete.js\":\"fcc706b283f62eac\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"48f2c3be8e9af732\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/actions.js\":\"7b66a13441c47267\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/anchor.js\":\"3ac7aa489aabcdd8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/events.js\":\"0540de9ecdc96d84\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/gestureActions.js\":\"e498f9b65eb18063\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/index.js\":\"122ff2197dd23597\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e8d28f3412efb267\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/sync-metrics/collect.js\":\"51fbddf503d6d4b7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/sync-metrics/index.js\":\"7e50e1a55705010c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/sync-metrics/record.js\":\"86b957ae76755c18\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/RejectionDialog.js\":\"2ecc98aad0b2e576\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a2e622e2da404c11\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/index.js\":\"ce160fe7e0e97d9c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/model.js\":\"cf06f1941a42d935\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/queueCounts.js\":\"3f62ff7578ac8371\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/rejectedHelpers.js\":\"e51793b995f5ba9a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/rematerializeAction.js\":\"18af3ef1ffe9c0db\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/useHysteresis.js\":\"465a83e8bcbc2991\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/ColumnHeaders.js\":\"5a237a11ad478250\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/QueryUi.js\":\"ffd34fa9faaf7ff7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/TableLayout.js\":\"cebbbce3591bdba6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/actions.js\":\"a72624810377178c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/cellEdits.js\":\"b50893d323824716\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/childrenViews.js\":\"d649715ae843679c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/columns.js\":\"5f334194af3f7795\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/controller.js\":\"01974acdbf37c877\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/convert.js\":\"2e5513f404f8212c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/dataExtension.js\":\"e4bdfad40fc54c61\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/index.js\":\"6788647ac4f81546\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/keys.js\":\"51d61bcf2f36f7cc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/model.js\":\"cde2fac9982961ec\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/QueryText.js\":\"1bdc992cd7ad7a27\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/backfill.js\":\"a8b36eeef2614103\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/completion.js\":\"70f88e8e831b7ef8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/format.js\":\"16334619419503ea\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/parse.js\":\"2a3ded8e99dbe9e9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/queryValue.js\":\"c0c83d778823058f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/registrations.js\":\"c9b32c9075ed9789\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/source.js\":\"06e178aef43c0ed6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/registry.js\":\"c7913c6e85e5e033\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/rowGutter.js\":\"b8f67bb1591d95e6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/rowVerbs.js\":\"1e861c1465f38e6c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/schema.js\":\"3bd9fef9de70bcc0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/sort.js\":\"8b0f946c01616916\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/theme-toggle/effect.js\":\"f96a596947449279\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/theme-toggle/index.js\":\"38a361ddc0526b79\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/theme-toggle/theme.js\":\"1f0ee69ffe42a994\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/todo/actions.js\":\"14f4bbba073c6d1b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/todo/dataExtension.js\":\"099529a113593a55\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/todo/index.js\":\"7bb559e29441de9a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/todo/schema.js\":\"0c1a9e3664eb903e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/touch-selection/TouchSelectionLayer.js\":\"53c28772a8012e88\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/touch-selection/actions.js\":\"73a34cc43b26e6fe\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/touch-selection/defaultItems.js\":\"deec38e0b056a952\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/touch-selection/facet.js\":\"fcc295e2f376ca93\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/touch-selection/holdRecognizer.js\":\"da3cd42e2574bfc2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/touch-selection/index.js\":\"8a4d72503f53512e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/update-indicator/UpdateIndicator.js\":\"50cc773cbafb6059\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/update-indicator/index.js\":\"80506e202152f8b0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/update-indicator/loadTimes.js\":\"c8c65b4022e53ff8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/VideoNotesRenderer.js\":\"5d859085dd8fbbd5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/VideoPlayerRenderer.js\":\"4d13393069a9c1af\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/VideoTimeStamp.js\":\"0945ae7f84ebf5c3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/actions.js\":\"a280ba30b383356a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/index.js\":\"5b29c9c0d622a734\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/markdown.js\":\"6cd577d2171acc36\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/notes.js\":\"a7088aa591c64050\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/registry.js\":\"dd7f7fdc5d11be82\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/remark-timestamps.js\":\"ff5bb8473979de82\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/view.js\":\"5ca913e6f16b7269\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-link-hints/LinkHints.js\":\"d00cd865191ec8d2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-link-hints/index.js\":\"b16adae5352c5358\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-link-hints/model.js\":\"98876c335f518b07\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-link-hints/settings.js\":\"ad1a27f7519cff4e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-normal-mode/actions.js\":\"86dcbf7c5fad7dc5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-normal-mode/index.js\":\"9c136f28f74fd3f1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-normal-mode/interactions.js\":\"818395080a9a9506\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/workspace-header/index.js\":\"5b0b24ff677109fc\",\"/knowledge-medium/pr-preview/pr-1898/src/registerServiceWorker.js\":\"4013959344ccc4bc\",\"/knowledge-medium/pr-preview/pr-1898/src/requestPersistentStorage.js\":\"6c9a25a54d364b4f\",\"/knowledge-medium/pr-preview/pr-1898/src/services/authRequestDeadline.js\":\"a50be8e195382b6c\",\"/knowledge-medium/pr-preview/pr-1898/src/services/authStorage.js\":\"c91ab1c6ed0dce16\",\"/knowledge-medium/pr-preview/pr-1898/src/services/powersync.js\":\"bd477ec3eb567497\",\"/knowledge-medium/pr-preview/pr-1898/src/services/supabase.js\":\"cf42a075f053f8d2\",\"/knowledge-medium/pr-preview/pr-1898/src/services/uploadErrorClassifier.js\":\"99124b5f45f41075\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/ActiveContexts.js\":\"d5fe62458f7305cb\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/HotkeyReconciler.js\":\"88e6a7b26555c039\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/WipeLocalDataDialog.js\":\"6f8eeeb092588a44\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/actionDispatch.js\":\"4350360069276677\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/actionRefItems.js\":\"cd9638fba93153af\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/applyKeybindingOverrides.js\":\"7766085b7b66a7bc\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/blockActions.js\":\"c5cd5c728014d932\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/blockMergeGesture.js\":\"b61d522f4c2c8bcd\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/canonicalizeChord.js\":\"77918cabeda9ba75\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/defaultContexts.js\":\"a4761077a3a75285\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/defaultShortcuts.js\":\"07ad60e05cddc6e0\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/effectiveActions.js\":\"9c2792108a280480\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/gestureAction.js\":\"8ff12a22c4dd1397\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/gestureBinding.js\":\"c118d53cab279185\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/holdRegistry.js\":\"682f42c376d59cfb\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/keybindingConflicts.js\":\"112ddceccc32c9b5\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/keybindingOverrides.js\":\"e98132c5abd08283\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/pointerAction.js\":\"45c1356e4c0bbf2c\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/resolve.js\":\"3835c4ed427e313c\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/runAction.js\":\"5e7d9f0987778d19\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/sequenceMatcher.js\":\"70f747c8c7bee257\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/types.js\":\"14f3da9ec66d7984\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/useActionContext.js\":\"681c0bdd585f0e1f\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/useActionDiscovery.js\":\"75980ba741767f26\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/utils.js\":\"8bf6285ebce3abf1\",\"/knowledge-medium/pr-preview/pr-1898/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1898/src/sw/bootStore.js\":\"375516b3fd800f5d\",\"/knowledge-medium/pr-preview/pr-1898/src/sw/previewDatabases.js\":\"c91c8da1c36c9444\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/byteTransform.js\":\"446dc9643f9ec3e0\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/attachmentCleaner.js\":\"01739d325c24da6d\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/bundle/attachmentParts.js\":\"0117383c7d0a1c86\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/bundle/bundleParts.js\":\"bb90b8a76299d494\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/bundle/bundleRecord.js\":\"a26f76b4b5ec3c59\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/bundle/manifest.js\":\"1036b017832ae4ce\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/bundle/takeBundle.js\":\"c9ee6c51eb1a9a0a\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/bundle/verifyBundle.js\":\"38a12d3deb189d3c\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/cleaningStage.js\":\"d0d5d4ab8ac21ac5\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/conversionKey.js\":\"ff129e9ef67abf15\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/conversionServer.js\":\"eee491ad3450c5f3\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/flip.js\":\"1af3381a615f73ab\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/flipAttempts.js\":\"d198b4307fc0fce2\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/pages.js\":\"45f21a1c9ad8a80b\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/preflight.js\":\"06671ea7d530d154\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/reseal.js\":\"d912fda78b87caa1\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/runConversion.js\":\"ca4cf592c93879a2\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/runLock.js\":\"0ad448d4f9683106\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/sealing.js\":\"167ebe7542fdcf5b\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/sealingStage.js\":\"4c7e43dfe54bd77e\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/stage.js\":\"4104979e1a755dcf\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/verifyReseal.js\":\"0c490410eebfd162\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/aad.js\":\"5ba94b2db5fa973b\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/aead.js\":\"5079d77e2e4d722d\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/base32.js\":\"39307be61b2ee037\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/base64url.js\":\"2b07d238c0d2a79d\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/binaryEnvelope.js\":\"83fdfd94bdcdf160\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/byteAead.js\":\"842b1966506425c7\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/canary.js\":\"ca92a1bdc24cf62e\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/contentHash.js\":\"74e8b12e2e67d7a9\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/contentKey.js\":\"fd309dd88634c144\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/derivedIdNamespace.js\":\"f82b976b8ec89459\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/envelope.js\":\"c1ea1c28ea1d4b35\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/hex.js\":\"97b322fe0cee6581\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/sha256Hex.js\":\"59ec77e5266146a7\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/workspaceKey.js\":\"2eca781f155fe86e\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/conversionState.js\":\"5ab287d2c6e37122\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/flows/createEncryptedWorkspace.js\":\"bd5bb658e6b58c05\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/flows/pastedKey.js\":\"1e81188d9d96a90d\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"404814f69990b9af\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/flows/upgradeWorkspacePin.js\":\"f76e7af82e0460d9\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/keyStore.js\":\"140a5a7a07cad15d\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/mintWorkspaceKey.js\":\"93d9ee2f99e0eda9\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/modePin.js\":\"a5b4064d0688245f\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/openWorkspaceKeys.js\":\"403b7a3f31ca9e74\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/resolveWorkspaceEntry.js\":\"e2afa9a2b809d609\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/resolver.js\":\"5fc7be7d8a6235df\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/workspaceAccess.js\":\"352f1208e881ffd3\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/transform.js\":\"08d0c3ad5e789af5\",\"/knowledge-medium/pr-preview/pr-1898/src/themeBootDefaults.js\":\"ecb5037d9f2039e3\",\"/knowledge-medium/pr-preview/pr-1898/src/types.js\":\"561a63b42a8bc27e\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/ClientLocalSettings.js\":\"2ebb6c0998d0a2e0\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/abortableSleep.js\":\"1590de065359d790\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/array.js\":\"c901c5648144ff43\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/backlinkAutocomplete.js\":\"852b2e079e1afc48\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/blockCrumbs.js\":\"b266aa720e1c9047\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/blockrefAutocomplete.js\":\"54c82909ad3fb8e1\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/cadencedIdleJob.js\":\"a1f9b733fcccd905\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/callbackSet.js\":\"7ecbf9ca49c8f03d\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/clientId.js\":\"025dd74eaaaa7821\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/codemirror.js\":\"c7b10879740f1697\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/codemirrorCompletion.js\":\"160e6dd98a02913d\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/copy.js\":\"d04753d3afa05312\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/dailyPage.js\":\"c4bf8a1bf6cf7d3a\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/dbForensics.js\":\"390a68829b10c022\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/dbForensicsHooks.js\":\"67f7824eee300d5b\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/deleteBlockThroughUi.js\":\"5ed2268f7f79555d\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/dialogs.js\":\"25ef4561217ae72b\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/dom.js\":\"ac20ed978e0980bd\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/downloadBlob.js\":\"72b2df9ed4594686\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/drawnWalk.js\":\"123f7b31857ba8bb\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/exportSqliteDb.js\":\"4ab17163d2c8262e\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/fileSystemAccess.js\":\"74fbfc81f2c0e89a\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/flipSlide.js\":\"f85309768cd2a53f\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/fnv1a.js\":\"ce0e67705dacb021\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/formatBytes.js\":\"63a496bbfbbdb42b\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/fuzzyRank.js\":\"86246d8568b8ad36\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/idbKeyedStore.js\":\"8c3a8578d66780f7\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/idleCallbackPolyfill.js\":\"b44efacce727100e\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/keyboardAwareScroll.js\":\"903281b910c86728\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/keyboardViewport.js\":\"a4cde7530e80ba7f\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/lastWorkspace.js\":\"14295ad2f11a6d1d\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/layoutColumns.js\":\"6b8afdea849d5962\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/layoutSessionDom.js\":\"5512f5c6805f73d8\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/layoutSessionId.js\":\"174804b58d513916\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/linkClickGestures.js\":\"5972dfe13d887797\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/linkTargetAutocomplete.js\":\"b445f99e64abc296\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/localDbCorruption.js\":\"657cadc09b09e147\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/localDbRecovery.js\":\"34e3d59640bc4fbf\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/markdownParser.js\":\"b55538fe2ccf339c\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/memoize.js\":\"1907fe0034050857\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/nameFieldCommit.js\":\"21a82974aebf56e6\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/nameList.js\":\"36d10bab7fc7abbc\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/navigation.js\":\"17db3306b820dd84\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/omnilinerNamespace.js\":\"14e35b155818e8f7\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/opfsPageScan.js\":\"72c9df7221784334\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/panelClearance.js\":\"e439e7632e271065\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/panelHistory.js\":\"f4ef06036a2d61df\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/panelLanes.js\":\"edd60a083c13593c\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/panelLayoutProjection.js\":\"6fb2fd0c99e9fca1\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/panelScrollAnchor.js\":\"2350a244f13fa639\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/panelUrlFlags.js\":\"58a5fca693902bf3\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/platform.js\":\"e7f7c4dc370e8a20\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/pluralize.js\":\"140421c8f643856a\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/propertyCreation.js\":\"39dbf2c198395c63\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/propertyNavigation.js\":\"12a52ac6c68e46e6\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/propertyValueContext.js\":\"f322b3abec4a711a\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/react.js\":\"59406a8868d90522\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/relativeDate.js\":\"ef60fb37314a9c09\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/relativeTime.js\":\"ea237aa13d7d3ce5\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/renderScope.js\":\"e3768afbe09627ea\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/resolvedThenable.js\":\"2c8b3c93d782ae0b\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/routing.js\":\"c486061ec78c39ea\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/safeMode.js\":\"cd953ac94c74dae7\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/scheduleIdle.js\":\"1cc3e6e22224b57a\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/screenWakeLock.js\":\"5033cd32e7932dae\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/selection.js\":\"0b5f4fef0ff118b7\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/softKeyboardGrab.js\":\"c2de16cb4abbe842\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/startupTimeline.js\":\"b597312c1721adbd\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/state.js\":\"f4e1b72ee489948a\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/string.js\":\"e38704d79f67f009\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/surfaceZoom.js\":\"90046fceb487046c\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/time.js\":\"785823bdf75fcc86\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/toast.js\":\"08eb5a0dcf9fed80\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/toggleStore.js\":\"a0feb98339cbfa49\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/untilStopped.js\":\"481006343dde8664\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/userActivity.js\":\"92ebf42c733f2ef4\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/viewTransition.js\":\"cf1c0d36b34c8703\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/viewport.js\":\"02d377c32e9ca6ff\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/webLock.js\":\"70ac6316a95d1a69\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/workspaceRecovery.js\":\"f0aa19eafdfd8087\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/workspaceSnapshotStore.js\":\"00734e64aa147926\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-compiler-runtime.js\":\"5136e3693d5f1dcd\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom-client.js\":\"2591150dabd26ec9\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom-server-edge.js\":\"6ba28e9747b5b54d\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom-server.js\":\"fe0bf0c7ee10c64a\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom-static-edge.js\":\"a0b6903171ea1ca7\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom-static.js\":\"9e47aac18483e755\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom-test-utils.js\":\"a89ba045e798ce2e\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom.js\":\"ce3de101be4b5e2d\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-jsx-runtime.js\":\"43e6de12e27cd295\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react.js\":\"6e4468d59d39260d\",\"/knowledge-medium/pr-preview/pr-1898/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1898/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1898/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
