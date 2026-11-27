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
		buildId: "8c96e95bb001-580837d9",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1898/\":\"d2109792b4615420\",\"/knowledge-medium/pr-preview/pr-1898/index.html\":\"d2109792b4615420\",\"/knowledge-medium/pr-preview/pr-1898/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1898/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1898/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1898/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1898/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1898/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1898/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1898/assets/FacadeVFS-BPTirKzs.js\":\"86d89a6c70d0f81c\",\"/knowledge-medium/pr-preview/pr-1898/assets/OPFSCoopSyncVFS-1q8OW0VH.js\":\"7261e5377b3f4aaf\",\"/knowledge-medium/pr-preview/pr-1898/assets/OPFSWriteAheadVFS-BGdq2nPd.js\":\"14f6265d0ce7c79d\",\"/knowledge-medium/pr-preview/pr-1898/assets/wa-sqlite-C8m68_PP.js\":\"e2ddbd50d38680ab\",\"/knowledge-medium/pr-preview/pr-1898/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1898/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1898/assets/wa-sqlite-async-CInRy-IC.js\":\"c2cd5317d4bee137\",\"/knowledge-medium/pr-preview/pr-1898/assets/worker-nsAd4d-U.js\":\"af01bc0c55160d87\",\"/knowledge-medium/pr-preview/pr-1898/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1898/chunks/app-Cl_R_xo6.js\":\"4005c66d38c8c85b\",\"/knowledge-medium/pr-preview/pr-1898/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1898/index.js\":\"88c90881437b73d6\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1898/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1898/assets/AccessHandlePoolVFS-DV_8XrST.js\":\"8c636697bea78b9a\",\"/knowledge-medium/pr-preview/pr-1898/assets/IDBBatchAtomicVFS-R5rQ7myg.js\":\"c7181b997947cd12\",\"/knowledge-medium/pr-preview/pr-1898/assets/MemoryVFS-CzQ7j6GZ.js\":\"079f08168dabda7b\",\"/knowledge-medium/pr-preview/pr-1898/assets/mc-wa-sqlite-CdRI64mL.js\":\"2c50e190e6a29bb1\",\"/knowledge-medium/pr-preview/pr-1898/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1898/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1898/assets/mc-wa-sqlite-async-em9Gireg.js\":\"33851467fc0398e2\",\"/knowledge-medium/pr-preview/pr-1898/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1898/chunks/AccessHandlePoolVFS-nYlbIIIZ.js\":\"97c6908a9cf73c12\",\"/knowledge-medium/pr-preview/pr-1898/chunks/FacadeVFS-DNLojDas.js\":\"f7a65aae6047b1ac\",\"/knowledge-medium/pr-preview/pr-1898/chunks/IDBBatchAtomicVFS-GC0sgMvh.js\":\"f70b37117a21ed4c\",\"/knowledge-medium/pr-preview/pr-1898/chunks/MemoryVFS-Bt28GtWv.js\":\"91f28a8652d57d2b\",\"/knowledge-medium/pr-preview/pr-1898/chunks/OPFSCoopSyncVFS-D2YVzkiS.js\":\"fff4056e9c8b59a9\",\"/knowledge-medium/pr-preview/pr-1898/chunks/OPFSWriteAheadVFS-BLX7P5iT.js\":\"71980fb0ac2dbb32\",\"/knowledge-medium/pr-preview/pr-1898/chunks/Preview-F6oPsMsc.js\":\"77b1c65f8e675be6\",\"/knowledge-medium/pr-preview/pr-1898/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1898/chunks/card-DvPvsepb.js\":\"f095d3d1e4eb199d\",\"/knowledge-medium/pr-preview/pr-1898/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1898/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1898/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1898/chunks/dist-CUwfNGXi.js\":\"4515799a0790c63a\",\"/knowledge-medium/pr-preview/pr-1898/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1898/chunks/mc-wa-sqlite-CG1KTgZP.js\":\"5d68b69ce1314df6\",\"/knowledge-medium/pr-preview/pr-1898/chunks/mc-wa-sqlite-async-BI4tTqE_.js\":\"748c739e96a5a6e8\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-0v45BjZd.js\":\"004682ae93a2c161\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-B8P6LtoI.js\":\"c65c192d9c8462d6\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-BFNTpMSr.js\":\"5a3b271b8936572a\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-BMmwO4tK.js\":\"c6c046d3f9839f87\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-BQuYDddz.js\":\"a919faae936fbc3f\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-DDBIzgWJ.js\":\"3066af4bed75e797\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-DuyEYJut.js\":\"8e368e2e711acf51\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-DyEUVyr7.js\":\"653cb75aaf2545e1\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-dom-server-legacy.browser.production-D1u_G-fB.js\":\"5ccb0937908077fe\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-dom-server.browser.production-m1VB7khZ.js\":\"70f422689b919a6b\",\"/knowledge-medium/pr-preview/pr-1898/chunks/react-dom-server.edge.production-C0qH1Pg1.js\":\"d61a28e43d713677\",\"/knowledge-medium/pr-preview/pr-1898/chunks/server.browser-CrKKFud_.js\":\"cb20799dc47a662c\",\"/knowledge-medium/pr-preview/pr-1898/chunks/textarea-B1qU96HH.js\":\"ee2dad09ab8015e5\",\"/knowledge-medium/pr-preview/pr-1898/chunks/ui-nZ60qtjo.js\":\"87f752332bee654a\",\"/knowledge-medium/pr-preview/pr-1898/chunks/wa-sqlite-BNjsk0bU.js\":\"c798d27014799813\",\"/knowledge-medium/pr-preview/pr-1898/chunks/wa-sqlite-async-YxMm9AbZ.js\":\"9efa03fd1b975b97\",\"/knowledge-medium/pr-preview/pr-1898/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1898/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1898/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1898/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1898/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1898/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1898/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1898/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1898/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1898/src/App.js\":\"c936e4823371ad7a\",\"/knowledge-medium/pr-preview/pr-1898/src/appUpdate.js\":\"a6572d0b726963c1\",\"/knowledge-medium/pr-preview/pr-1898/src/appVersion.js\":\"e7d9174aa8d797ee\",\"/knowledge-medium/pr-preview/pr-1898/src/bootstrap/initialLayout.js\":\"54bb5956ffc729ec\",\"/knowledge-medium/pr-preview/pr-1898/src/bootstrap/openWorkspaceData.js\":\"34fc2ca8063f3f79\",\"/knowledge-medium/pr-preview/pr-1898/src/bootstrap/resolveWorkspace.js\":\"2f5b84d2649d4a8e\",\"/knowledge-medium/pr-preview/pr-1898/src/bootstrap/workspaceBootstrap.js\":\"7497f84afa3f096d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/BlockComponent.js\":\"9c2f0c50ea04c908\",\"/knowledge-medium/pr-preview/pr-1898/src/components/BlockCrumbs.js\":\"0698572e79d45d22\",\"/knowledge-medium/pr-preview/pr-1898/src/components/BlockEditor.js\":\"559c1eab922de11e\",\"/knowledge-medium/pr-preview/pr-1898/src/components/BlockLoadingPlaceholder.js\":\"00cc2d1d71edf9ee\",\"/knowledge-medium/pr-preview/pr-1898/src/components/BlockProperties.js\":\"369e1232629a56c9\",\"/knowledge-medium/pr-preview/pr-1898/src/components/BlockSearchPicker.js\":\"f7c483c8a4683a57\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ConfirmBulkDeleteDialog.js\":\"76ffdf6cb927327c\",\"/knowledge-medium/pr-preview/pr-1898/src/components/DividerHandle.js\":\"49860b88760037f3\",\"/knowledge-medium/pr-preview/pr-1898/src/components/DraftEditor.js\":\"99213a4dfcef046e\",\"/knowledge-medium/pr-preview/pr-1898/src/components/GutterPill.js\":\"ab8537abc6489ea0\",\"/knowledge-medium/pr-preview/pr-1898/src/components/Header.js\":\"15b26fcb2ec9bc28\",\"/knowledge-medium/pr-preview/pr-1898/src/components/LazyBlockComponent.js\":\"c776072f24741140\",\"/knowledge-medium/pr-preview/pr-1898/src/components/Login.js\":\"27ca9d3ef85a6e8f\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ZoomableSurface.js\":\"cee65e1d5dfc360a\",\"/knowledge-medium/pr-preview/pr-1898/src/components/editModeKeepalive.js\":\"cca2e26f9001208b\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyDisplay/PropertyDisplayScope.js\":\"ab3588921fe035ba\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"197aa571938f6449\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/RefPropertyEditor.js\":\"94441099475f28e0\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/RefTargetTypePicker.js\":\"817eb96e4b9c2e66\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/SelectPropertyEditor.js\":\"44b004cc9f9ba600\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/TypesPropertyEditor.js\":\"7c3962af4309102d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/defaults.js\":\"5a5ab25e0f6ecc95\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/kernelValuePresets.js\":\"ca5204b8db09ccb8\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/selectablePresets.js\":\"55eac7e5e0cee9ce\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyEditors/typesPropertyUi.js\":\"149aaf8744d4f66a\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/AddPropertyForm.js\":\"f621ada482144989\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/PropertyPicker.js\":\"7e92960c71bb2cb4\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/PropertyRow.js\":\"a17f399ed45a7cfc\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/Rows.js\":\"a2eaaab50d31447d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/actions.js\":\"38820fbd86035f93\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/declarationOnly.js\":\"8a86011440b2663e\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/layout.js\":\"fec785130397f491\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/model.js\":\"737aeb92c4a54e7c\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/shapeUi.js\":\"61e181c6c994ad7c\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/shapes.js\":\"fed0e366bfd0c2f1\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/usePropertyEditingActivation.js\":\"8b31fc9eaf70c4ef\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanel/visibility.js\":\"edfe71e4c0d81a1e\",\"/knowledge-medium/pr-preview/pr-1898/src/components/propertyPanelSections.js\":\"4c254b0d9c1d38e0\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/BlockEmbed.js\":\"ddb4d02dc1933a62\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/BlockLink.js\":\"f98f3a7a2b7f95b4\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/BlockRef.js\":\"4b1649e374b9c4cc\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/CompactReferenceLink.js\":\"4b17f2edee67cde1\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/ReferenceLink.js\":\"f6febff83a932912\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/cycleGuard.js\":\"5a60ca8e7f0fcc84\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/cycleGuardContext.js\":\"75fffea1c14f0ff2\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/linkInteraction.js\":\"a442053b7730b0ef\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/referenceLayout.js\":\"1f6f674e0ac9d107\",\"/knowledge-medium/pr-preview/pr-1898/src/components/references/useBlockRefAncestors.js\":\"2ca9aff35a383503\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/BlockGutter.js\":\"67285378648759cf\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/BlockInfoDialog.js\":\"95b448cb7cab63be\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/BlockReadText.js\":\"0b35541786ef32a5\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/BlockTypeBlockRenderer.js\":\"d229091afe8f9ddf\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/BulletHoverCard.js\":\"9e616ed386835d34\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/CodeMirrorContentRenderer.js\":\"e5fd4e8fbb05e39d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"66599fecfe46da5d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/ColumnResizeHandles.js\":\"4b81eccd81a072cf\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b002828a7bed1621\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/DefaultBlockRenderer.js\":\"4032d66b04a182e7\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/LayoutRenderer.js\":\"8e7a529e8cfaab7a\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/MarkdownContentRenderer.js\":\"9e69875399212f30\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/MissingDataRenderer.js\":\"07a9c3c9f8f1aebe\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/PanelRenderer.js\":\"42713b9012efa30e\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/PropertySchemaBlockRenderer.js\":\"bbfab5a8d9c5ac2c\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/TopLevelRenderer.js\":\"3c116d8d22028e36\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/blockGutterMode.js\":\"7ccbf5c145772cd9\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/blockTitleText.js\":\"d391b61045d5de9b\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/fieldCreationKeydown.js\":\"89efba5395e8399b\",\"/knowledge-medium/pr-preview/pr-1898/src/components/renderer/layoutRootContext.js\":\"df7395c295d69ad0\",\"/knowledge-medium/pr-preview/pr-1898/src/components/typeChip/TypeChip.js\":\"07b9ec46b7036593\",\"/knowledge-medium/pr-preview/pr-1898/src/components/typeChip/chipStyle.js\":\"b4cb13a17c20e825\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/anchored-floating.js\":\"1ce59c1a205365c1\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/button.js\":\"33ccb245fb1f9d94\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/card.js\":\"0616b239ef1bd0c7\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/checkbox.js\":\"9ff6a8c60dfe97b5\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/collapsible.js\":\"f4f9dc89e0e60cb7\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/command.js\":\"1ad9011a259c61ba\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/context-menu.js\":\"b45c04e8e5f9f937\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/dialog.js\":\"83899be5ee5ec64c\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/dropdown-menu.js\":\"992edb956fe8ff85\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/floating-listbox.js\":\"d0dde73361088a05\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/index.js\":\"28407cf2bf124aa2\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/input.js\":\"aade7280ca556b41\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/kbd.js\":\"12854027bdb27071\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/label.js\":\"dc1df7f403efef1d\",\"/knowledge-medium/pr-preview/pr-1898/src/components/ui/textarea.js\":\"c0cd68308080637b\",\"/knowledge-medium/pr-preview/pr-1898/src/components/useEditModeYieldKeepalive.js\":\"6658f460da38a3cd\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/BootFallback.js\":\"6104804d15674372\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/FocusedRowLazyMount.js\":\"309750441943b9b3\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/LazyViewportMount.js\":\"860861c1791bc7b0\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/LocalDbCorruptionFallback.js\":\"59889cb0403e2045\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/error.js\":\"6a42936dc21f5463\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/lazyMountRegistry.js\":\"b8dc20731a0e03b9\",\"/knowledge-medium/pr-preview/pr-1898/src/components/util/suspense.js\":\"364d11b0962102a8\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/CreateWorkspaceDialog.js\":\"8ad5dc839414e038\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/PendingInvitations.js\":\"a81b2b0e8c9ce5c5\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/SyncProgress.js\":\"7c4d1e36bb969dc9\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/UnlockProgress.js\":\"e76aacb751693ffe\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/WorkspaceKeyGate.js\":\"a4da1ef535605680\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/WorkspaceSettingsDialog.js\":\"d352b173d58b5fea\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/WorkspaceSwitcher.js\":\"5c6618ba9bc4ddc5\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/WorkspaceSyncGate.js\":\"a62f404ba0d99696\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/ConversionFlow.js\":\"2689456dba755038\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/ConversionFlowHost.js\":\"67269b53c05f9ffd\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/EncryptionSection.js\":\"55986b42d200ddd9\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/attachmentPrompts.js\":\"6f676dd638ce7f98\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/bundleFolderPrompts.js\":\"4b5ad2d4773b69e5\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/conversionFlowDeps.js\":\"037211f5528ef093\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/conversionFlowStore.js\":\"1850f5ffd06877a8\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/flowUi.js\":\"e6db91c34d7884a4\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/conversion/useConversionRun.js\":\"152a5e07f4401a82\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/keyUi.js\":\"35488d9cbd5be763\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/useCloseOnKeyLoss.js\":\"00ca9c911f9c6a95\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/useCloseOnServerE2ee.js\":\"5e881df4e6cbe6be\",\"/knowledge-medium/pr-preview/pr-1898/src/components/workspace/workspaceUnlocked.js\":\"d558e5f4ac82139c\",\"/knowledge-medium/pr-preview/pr-1898/src/context/backgroundSubtree.js\":\"038c662386016cae\",\"/knowledge-medium/pr-preview/pr-1898/src/context/block.js\":\"18ac085c15248321\",\"/knowledge-medium/pr-preview/pr-1898/src/context/layoutWsContext.js\":\"f9fc7c39aa750719\",\"/knowledge-medium/pr-preview/pr-1898/src/context/propertyDisplay.js\":\"3c9367d4851d8550\",\"/knowledge-medium/pr-preview/pr-1898/src/context/repo.js\":\"d7d75d87df25393e\",\"/knowledge-medium/pr-preview/pr-1898/src/data/aliasClaim.js\":\"0fff1b64d8fe8ceb\",\"/knowledge-medium/pr-preview/pr-1898/src/data/aliasSeatNamespace.js\":\"1052a1f2ae7418f7\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/blockData.js\":\"87d7a460371d9136\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/blockType.js\":\"0d368ffa29199e6b\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/changeScope.js\":\"31fc50a08afe6b13\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/codecs.js\":\"1b175d257cdae512\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/derivedData.js\":\"33ed6d10f15fc444\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/errors.js\":\"348d1f832cf10058\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/events.js\":\"748ea7fec2309608\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/handle.js\":\"14f60cf569e2599a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/index.js\":\"1ef4309169cdfe4e\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/mutator.js\":\"a760bfdd947b764f\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/processor.js\":\"84cb26713db49b27\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/propertySchema.js\":\"68ca69844fde77b9\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/query.js\":\"a3745a8c25c72dc4\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/sameTxProcessor.js\":\"3098fb16fbacc1fb\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/schema.js\":\"14f60cf569e2599a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/tx.js\":\"14f60cf569e2599a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/typedBlockQuery.js\":\"e3b0ff1b26a809cd\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/user.js\":\"60cd9b1d55aca297\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/valuePresetCore.js\":\"a6e0bd908eb17c1d\",\"/knowledge-medium/pr-preview/pr-1898/src/data/api/valuePresets.js\":\"d64b910cff1d3799\",\"/knowledge-medium/pr-preview/pr-1898/src/data/attachmentCleanerIOVerb.js\":\"35924b0560107d4b\",\"/knowledge-medium/pr-preview/pr-1898/src/data/block.js\":\"2864bdd54f6ce29f\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockCache.js\":\"c9a7d01cafa75e8d\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockId.js\":\"fba5d22939ac3897\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockLiveness.js\":\"f06e71377692e172\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockMerge.js\":\"7844f0f0ea1502e5\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockSchema.js\":\"b8a1eaa5ab21606a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockTypeLookup.js\":\"875b53c551eb95e1\",\"/knowledge-medium/pr-preview/pr-1898/src/data/blockTypes.js\":\"b0988b6ffabed954\",\"/knowledge-medium/pr-preview/pr-1898/src/data/childrenView.js\":\"eb020bd95998f236\",\"/knowledge-medium/pr-preview/pr-1898/src/data/clientContext.js\":\"fa3529a2c377fcda\",\"/knowledge-medium/pr-preview/pr-1898/src/data/dbFileSiblings.js\":\"8e509abe57d803eb\",\"/knowledge-medium/pr-preview/pr-1898/src/data/definitionSeeds.js\":\"a36608254ee9e3c1\",\"/knowledge-medium/pr-preview/pr-1898/src/data/derivedIds.js\":\"8fab0a0d85084d8f\",\"/knowledge-medium/pr-preview/pr-1898/src/data/drawnSubtree.js\":\"ac1ba51b8922ed1f\",\"/knowledge-medium/pr-preview/pr-1898/src/data/facetBridge.js\":\"7634fa6e3e0e44ca\",\"/knowledge-medium/pr-preview/pr-1898/src/data/facets.js\":\"61bd8a320134a526\",\"/knowledge-medium/pr-preview/pr-1898/src/data/globalState.js\":\"95cc794a04452ba5\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/aliasClaimRederiveProcessor.js\":\"8d9ea8ac0d408dff\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/ancestorBatch.js\":\"a22fd22c708a3aef\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/blockTypeTypeifyProcessor.js\":\"41ae49cb18f04c49\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/clientSchema.js\":\"1256fe42b8894da9\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/commitPipeline.js\":\"7d7175037f1e8af6\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/devAssertions.js\":\"104ad99109a1fcb7\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/firstSync.js\":\"4879ce42a0d3de65\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/freshInitialLoad.js\":\"bdac5ea6cd0c5de5\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/graphBackfillClaim.js\":\"4bf9af0829df439a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/handleStore.js\":\"58b3f9482b9f52c3\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/idleMarkerJobs.js\":\"09d74c01afe6acb0\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/initialDownload.js\":\"d85433728796911a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/initializeClientDatabase.js\":\"3dce27d274095d76\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/jsonCanonical.js\":\"c2f09fa54fcf0581\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/kernelInvalidation.js\":\"67b7f8c93301cef2\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/kernelProcessors.js\":\"c791750c418c8623\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/kernelQueries.js\":\"64702ed15b6cbafd\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/mergeTypeMembershipProcessor.js\":\"cdd28bb4c4cdf8de\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/normalizeReferencesProcessor.js\":\"5d6ef3d596695646\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/poolInstrumentation.js\":\"0f908f7f4717281f\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/processorRunner.js\":\"0ef177b207fdaedd\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyCellBackfill.js\":\"081f6a02d6695a2b\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyChildMint.js\":\"b08675627f2c511b\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyChildrenProcessor.js\":\"4a33c4dc8111d44d\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyDefinitionChangeProcessor.js\":\"23970dd2b628f061\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyDefinitionSynthesis.js\":\"8e8d498ce3e226ae\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyKeyScan.js\":\"5ff2c7cb9cbbedcb\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertySchemaResolution.js\":\"520583cfa4674e43\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/propertyValueEdits.js\":\"0f2b85257c3ee79d\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/raiseProtocol.js\":\"87335c048c0f697b\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/readBatch.js\":\"080c79937e271b4c\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/refProjection.js\":\"478acd424fd17e11\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/referenceTargetLookups.js\":\"9a5254f3ef3c04ad\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/referenceTargetProcessor.js\":\"62d4d712917a0dc3\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/replayMerge.js\":\"21b71684b6b30ec4\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/sqlBinds.js\":\"11754d5196dc0820\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"b087e3919ab08751\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/syncObserver/arrivalProcessors.js\":\"fe68a848667b9e23\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/syncObserver/invalidate.js\":\"323579856a260213\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/syncObserver/materialize.js\":\"0f10806003acbcb5\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/syncObserver/observer.js\":\"e7eff03d76281f05\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/syncObserver/reconcile.js\":\"095a4045f1fc472a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/timingMetrics.js\":\"405e992ad759c8ee\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/treeQueries.js\":\"e5ad50b489a168e2\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/txEngine.js\":\"2150bd5996555e44\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/txSnapshots.js\":\"127f2c5c2dec9a01\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/typedBlockQuery.js\":\"7289ce99fa039d6c\",\"/knowledge-medium/pr-preview/pr-1898/src/data/internals/undoManager.js\":\"4e07eb7134b03246\",\"/knowledge-medium/pr-preview/pr-1898/src/data/invalidation.js\":\"3276dda716e4b31a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/kernelDataExtension.js\":\"900f50f0d8a09a3a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/kernelPage.js\":\"635e673af82b39f7\",\"/knowledge-medium/pr-preview/pr-1898/src/data/kernelValuePresetCores.js\":\"2a6603bc88baf3fa\",\"/knowledge-medium/pr-preview/pr-1898/src/data/localDbCorruptionSignal.js\":\"c5b4793320690bb9\",\"/knowledge-medium/pr-preview/pr-1898/src/data/localDbStorage.js\":\"240a8f5bad90d280\",\"/knowledge-medium/pr-preview/pr-1898/src/data/localDbVfs.js\":\"e2f56951efcd5d80\",\"/knowledge-medium/pr-preview/pr-1898/src/data/localSchema.js\":\"6d15b730d0ca8ecf\",\"/knowledge-medium/pr-preview/pr-1898/src/data/maintenance.js\":\"a597a691b2d62f24\",\"/knowledge-medium/pr-preview/pr-1898/src/data/mergeProperties.js\":\"6ebdd875a59ae134\",\"/knowledge-medium/pr-preview/pr-1898/src/data/metricsConsoleHook.js\":\"2db4d3ad6a12b304\",\"/knowledge-medium/pr-preview/pr-1898/src/data/migrationsPage.js\":\"db8bab0a116e4c5c\",\"/knowledge-medium/pr-preview/pr-1898/src/data/mutators.js\":\"4da08c419299eb35\",\"/knowledge-medium/pr-preview/pr-1898/src/data/orderKey.js\":\"9b5d7e57bccebd05\",\"/knowledge-medium/pr-preview/pr-1898/src/data/orderKeyPlacement.js\":\"77914fa7947fc0fa\",\"/knowledge-medium/pr-preview/pr-1898/src/data/outlineSurface.js\":\"184255fb3c4c3194\",\"/knowledge-medium/pr-preview/pr-1898/src/data/pendingEditorContent.js\":\"cbae40a7203fadab\",\"/knowledge-medium/pr-preview/pr-1898/src/data/pendingUploadsSql.js\":\"4b63fbf42357ffc8\",\"/knowledge-medium/pr-preview/pr-1898/src/data/pluginStateExtensions.js\":\"20320f720bb626d8\",\"/knowledge-medium/pr-preview/pr-1898/src/data/powerSyncLogger.js\":\"6ffc7d0acb80dabe\",\"/knowledge-medium/pr-preview/pr-1898/src/data/projectorRuntime.js\":\"9b2b3bc77e106e79\",\"/knowledge-medium/pr-preview/pr-1898/src/data/properties.js\":\"904149f55a59c0d9\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertiesPage.js\":\"0aa532f9d8d2ae4f\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertyChildren.js\":\"cd24f0ea5e7b3304\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertyDefinitionFanout.js\":\"61f8fe5d67630d32\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertyDefinitionMetadata.js\":\"6d88d084fd73e6e5\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertyDefinitionRegistry.js\":\"43d54ca9832c10d7\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertyDisplayMode.js\":\"9f360dbbe7273c04\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertyRowCreation.js\":\"865dbe2cfe275a04\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertySchemaCreation.js\":\"8c39770c682639ac\",\"/knowledge-medium/pr-preview/pr-1898/src/data/propertySeeds.js\":\"dd453926297ac205\",\"/knowledge-medium/pr-preview/pr-1898/src/data/recentsPage.js\":\"52cac625500f96e0\",\"/knowledge-medium/pr-preview/pr-1898/src/data/refTargetComparableProperty.js\":\"9bfc73c885df5d09\",\"/knowledge-medium/pr-preview/pr-1898/src/data/referenceBlock.js\":\"5f4373040d7b139a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/rejectedUploads.js\":\"f60b29e980836775\",\"/knowledge-medium/pr-preview/pr-1898/src/data/releasePowerSyncConnection.js\":\"f19860c54a200d94\",\"/knowledge-medium/pr-preview/pr-1898/src/data/repo.js\":\"4fcddd28f7817f15\",\"/knowledge-medium/pr-preview/pr-1898/src/data/repoProvider.js\":\"43355137fc906359\",\"/knowledge-medium/pr-preview/pr-1898/src/data/rowProperty.js\":\"73779ba5c573754d\",\"/knowledge-medium/pr-preview/pr-1898/src/data/searchFilter.js\":\"cd9462903eb3d0b2\",\"/knowledge-medium/pr-preview/pr-1898/src/data/seedIdentityLedger.js\":\"6a57589426ca3bb2\",\"/knowledge-medium/pr-preview/pr-1898/src/data/stateBlocks.js\":\"b3cac5a689da2e6a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/structuralEditPolicy.js\":\"431f101a2ac671b3\",\"/knowledge-medium/pr-preview/pr-1898/src/data/structuralInsert.js\":\"802e78911816f2d7\",\"/knowledge-medium/pr-preview/pr-1898/src/data/subtreeDelete.js\":\"a9980732d78a7a19\",\"/knowledge-medium/pr-preview/pr-1898/src/data/syncStreamLock.js\":\"4c39d55818f3a395\",\"/knowledge-medium/pr-preview/pr-1898/src/data/syncedTableSqlRecognizer.js\":\"3bcd59d4c507b856\",\"/knowledge-medium/pr-preview/pr-1898/src/data/syncedTableWriteGuard.js\":\"b96913a226776094\",\"/knowledge-medium/pr-preview/pr-1898/src/data/targets.js\":\"4fb60ee8301eee65\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeColors.js\":\"a7ca9983ecda4012\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeDefinitionMetadata.js\":\"a72e0735aae591fe\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeDefinitionRegistry.js\":\"ca7a61714f4f8be7\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeExtraction.js\":\"6358926469421024\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeInitialValues.js\":\"3ac81d24ad9f692d\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typePropertyGroups.js\":\"5b7b8da887db00c4\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeSeeds.js\":\"5fba0d67d81967cc\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typeTagger.js\":\"94e34263ffc2d888\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typedRecords.js\":\"f3bdbb91805418bf\",\"/knowledge-medium/pr-preview/pr-1898/src/data/typesPage.js\":\"2464cf2a5c5b021c\",\"/knowledge-medium/pr-preview/pr-1898/src/data/userPrefs.js\":\"3232f868b6119054\",\"/knowledge-medium/pr-preview/pr-1898/src/data/userSchemasService.js\":\"5e5ebf241bd3f166\",\"/knowledge-medium/pr-preview/pr-1898/src/data/userTypesService.js\":\"591c1ec01c14188a\",\"/knowledge-medium/pr-preview/pr-1898/src/data/valuePresetRegistry.js\":\"830b17e31332b3f1\",\"/knowledge-medium/pr-preview/pr-1898/src/data/visibleChildren.js\":\"2a6c02784946ee2c\",\"/knowledge-medium/pr-preview/pr-1898/src/data/workspaceConversion.js\":\"47c95f2e9cdc5b81\",\"/knowledge-medium/pr-preview/pr-1898/src/data/workspaceFirstSync.js\":\"80b6c42c86b44c49\",\"/knowledge-medium/pr-preview/pr-1898/src/data/workspaceIdNamespace.js\":\"9bee5c5ba4b8d573\",\"/knowledge-medium/pr-preview/pr-1898/src/data/workspaceSchema.js\":\"b727a7c44abdfe88\",\"/knowledge-medium/pr-preview/pr-1898/src/data/workspaces.js\":\"6bca5280760e21a4\",\"/knowledge-medium/pr-preview/pr-1898/src/data/writeAheadLog.js\":\"d94d485790b89829\",\"/knowledge-medium/pr-preview/pr-1898/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/BlockPasteShellDecorator.js\":\"c022ee2b50762586\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/atTrigger.js\":\"c79c8642ae694c9e\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/autocomplete.js\":\"856c3d4d475be0e7\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/codeMirrorExtensions.js\":\"ddcf7a2c43cdc080\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/contentFlush.js\":\"ab9693cc0fb7d44c\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/defaultInteractions.js\":\"f9efc27454cae83b\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/editSettleSignal.js\":\"7e90bc1d808f5b7f\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/insertImage.js\":\"cd836f86d5cd11bb\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/referenceCompletionRange.js\":\"bfa8fb07c5297f4a\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/referenceTargetTypes.js\":\"865c39e829c5763d\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/syntaxContext.js\":\"c1b48cc811349e4d\",\"/knowledge-medium/pr-preview/pr-1898/src/editor/triggerMatch.js\":\"fb069b721600eb3b\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/AppRuntimeProvider.js\":\"f0997949ae96a27d\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/BlockFocusShellDecorator.js\":\"6ec760cebdf4a943\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/ExtensionRenderBoundary.js\":\"85b3f54bab3f2383\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/PanelContentRecovery.js\":\"02ed0c084b20fe25\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/apiCatalog.js\":\"09616cf0f17be062\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/approveExtensionHere.js\":\"f0aaff74019d4ebb\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/armedCutAppMount.js\":\"774120255b5e65b7\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/batchableKeyedStore.js\":\"6211ea3e8cb50eb8\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/blockInteraction.js\":\"fba1e956d7f4c006\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/blockSelectionAction.js\":\"b78501099ffd2aa4\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/compileExtensionModule.js\":\"6c9fb8af48aa8258\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/compiledModuleCache.js\":\"5db365cf76c9cab6\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/continuousGestures.js\":\"c6a733ce3d658933\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/core.js\":\"c63b38a352af691a\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/defaultRenderers.js\":\"2fca50cc62ae97b3\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/definitionFanoutAppMount.js\":\"1041c49e141a65e9\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/dialogAppMount.js\":\"1ac8434bdefbf582\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/dynamicExtensionSeeds.js\":\"cd00c5a586d330fd\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/dynamicExtensions.js\":\"9b113697b3ce7151\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/exampleExtensions.js\":\"acd06ae2a9ba733a\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/extensionApprovalStatus.js\":\"0b82fbfc367f7439\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/extensionLoadErrorToast.js\":\"c891d3bf126f2373\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/extensionLoadErrors.js\":\"9caa481da39eea26\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/extensionLookup.js\":\"0720931b9bf61ae3\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/extensionToggles.js\":\"025ee58b99baad94\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/extensionUtilitiesCss.js\":\"7e770400a193241a\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/kernelPageDeletionGuard.js\":\"99786981e6b11bbd\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/liveRuntime.js\":\"d6112fa8abbeba6c\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/openExtensionsSettings.js\":\"b593004924ebfa1c\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/overridesCache.js\":\"bff64c0803f0c87d\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/pluginIds.js\":\"03a38e32de0d734d\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/processorRejectionToast.js\":\"660bdb9ef4ef73eb\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/runtimeActions.js\":\"65387035efc0a5d8\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/runtimeContext.js\":\"17f4e13c0250d7c8\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/staticAppExtensions.js\":\"9414815ef6050198\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/staticDataExtensions.js\":\"edb8147f7988daf3\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/toastAppMount.js\":\"4b1db752b515c668\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/useOverrides.js\":\"6295b431a9af117f\",\"/knowledge-medium/pr-preview/pr-1898/src/extensions/useShortcutSurfaceActivations.js\":\"afad988f3f4cec55\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/discoverToggleTree.js\":\"17828ee0a846d326\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/facet.js\":\"c135ef45173754dc\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/resolveAppRuntime.js\":\"c0072537b61cea30\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/runtimeEvents.js\":\"4dd93a88882cb341\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/togglable.js\":\"5c3cf928261572c7\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/variantFacet.js\":\"cbc1ef56e70a6393\",\"/knowledge-medium/pr-preview/pr-1898/src/facets/verbFacet.js\":\"28053bab03fd4b60\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/block.js\":\"69c96799efb708fd\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/focusedChild.js\":\"048cde1960800c21\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/propertySchemas.js\":\"e8d9cb25e037bfaa\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/typeRegistry.js\":\"5727ff302ea3e525\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useAncestorCrumbs.js\":\"1b2d08771b850d7d\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useAutocompleteListbox.js\":\"1d9a16ad95672b60\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useDebouncedSearch.js\":\"1d9acac3bc9eee11\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useDebouncedValue.js\":\"e88a82c590e9b481\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useFacetValue.js\":\"3db15392e3bd7267\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useIsFocalRender.js\":\"862172618ce4e3fb\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useIsReadOnly.js\":\"9bf230d3deb6fb86\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useMaterializeBacklog.js\":\"65339513ff40337e\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useMinuteClock.js\":\"33d8e431ac3c2ceb\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/usePanelLayoutProjection.js\":\"4afc0625b30e36fd\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/usePendingInvitations.js\":\"cbc8aa3f94176968\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useRendererRegistry.js\":\"de4953b0eb994dfa\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useRetainedFieldRows.js\":\"92c6374321becfd0\",\"/knowledge-medium/pr-preview/pr-1898/src/hooks/useWorkspaces.js\":\"26293aab74e79e65\",\"/knowledge-medium/pr-preview/pr-1898/src/lib/utils.js\":\"5661cfa0ccc7b59d\",\"/knowledge-medium/pr-preview/pr-1898/src/main.js\":\"1619bd0a0ed94a1e\",\"/knowledge-medium/pr-preview/pr-1898/src/markdown/MarkdownImage.js\":\"00d7b880f319ba00\",\"/knowledge-medium/pr-preview/pr-1898/src/markdown/blockSeparators.js\":\"b1cdf876a564eced\",\"/knowledge-medium/pr-preview/pr-1898/src/markdown/context.js\":\"5e1d3cbd16ac4b6f\",\"/knowledge-medium/pr-preview/pr-1898/src/markdown/defaultMarkdownExtension.js\":\"0429bb17c5e9e956\",\"/knowledge-medium/pr-preview/pr-1898/src/markdown/extensions.js\":\"c185d3187525820c\",\"/knowledge-medium/pr-preview/pr-1898/src/markdown/renderMarkdownHtml.js\":\"5efa8f9bfaf819a4\",\"/knowledge-medium/pr-preview/pr-1898/src/minimal-editor.js\":\"4a71b431e5a3b4f4\",\"/knowledge-medium/pr-preview/pr-1898/src/paste/armedCut.js\":\"c973438e1a8b49f3\",\"/knowledge-medium/pr-preview/pr-1898/src/paste/captureMediaVerb.js\":\"80877dcdc8e0f199\",\"/knowledge-medium/pr-preview/pr-1898/src/paste/clipboard.js\":\"9ef15019fb191133\",\"/knowledge-medium/pr-preview/pr-1898/src/paste/decision.js\":\"9b30804dcb8c626d\",\"/knowledge-medium/pr-preview/pr-1898/src/paste/operations.js\":\"8dbaf180a19ced43\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/account-header/AccountHeaderItem.js\":\"681807b08888d4f7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/account-header/index.js\":\"0e83e0eae3120a6e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"43b542cda22d4e1e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/askAgent.js\":\"869942593d45a318\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/askedStore.js\":\"f9b1f236f58f767f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"7a05570cd8b91895\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/chipState.js\":\"f18f815ede1b3266\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ad8b97ccb313b6d8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/index.js\":\"caa055a72c81649f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"4051387f204d5c5c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-dispatch-companion/schema.js\":\"0443c8770aa4628b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/AgentTokensDialog.js\":\"781db943f4036c16\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/BridgePairingDialog.js\":\"66ceb21f3b383902\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/addMedia.js\":\"512284dfb62d0880\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a2db62db0df46e5d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/block.js\":\"7b8afb4c24e4b957\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/context.js\":\"37a675d16145b5a7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a428fe5ce35c0960\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/index.js\":\"1e80505bf9ec8e71\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/outline.js\":\"88280c1c3555f66a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/properties.js\":\"df421087a46eb855\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/refs.js\":\"28d2c65e26b0b223\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b9c19a0843fb4a9a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/search.js\":\"29b6823305a1d5cb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/shared.js\":\"ebad4477cb21122b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"0f2b6894986ac807\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentViews/text.js\":\"f30139fbf4240583\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/agentWrites.js\":\"4c2027553eab231d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/authoringCatalog.js\":\"01f80c1bbb43b6a9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/blockRefTargets.js\":\"b54e9a62fb7a4107\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/bridge.js\":\"443dc4c7d7f292a4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/bridgeLoop.js\":\"651f1ddf7c0bf75c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/changeHistory.js\":\"5ab7986f7afad969\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/commands.js\":\"31f8f18a4b554c71\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/commentsCommands.js\":\"47916d50688850f1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/dataExtension.js\":\"b58982963ed3d6a7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/dataModelGuide.js\":\"816a52d94fbefd26\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/dayPropertyInputs.js\":\"dc943cc6b68626ee\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/describeRuntime.js\":\"4be05062097807cc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/extensionLint.js\":\"d77640d75b5880b7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/grainAudit.js\":\"ba8f9cf4df12469f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/healthCommand.js\":\"4f33d8f45d65fd99\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/index.js\":\"1d61bb8f8f254bd3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/presetIdentity.js\":\"2f25ea2fdcbd032a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"6aaa4a950c0a889a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/readMedia.js\":\"74f1c5f62a1fdb5b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/schema.js\":\"de7fd2baea91c6f1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/serialization.js\":\"3c42f208c0759e6e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/targets.js\":\"5fbd43f05f685417\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/tokens.js\":\"f5f98c145fb9cce0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/watchEvents.js\":\"4426589c988891d4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/workspaceGuard.js\":\"0c2e17c12480c964\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/agent-runtime/writeCommands.js\":\"b749e953140e9d8d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/AliasCollisionToast.js\":\"0339b404b8324648\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/DuplicateNameBanner.js\":\"4223a6eddcfafc30\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/collisionMerge.js\":\"7ba1d9afc4016ed2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/dataExtension.js\":\"4a5d063add38118e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/index.js\":\"358421a78a5f6689\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/mergeCollisionAction.js\":\"8a1b095a7f300ff4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/pageStyling.js\":\"54a731bdee268118\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/rejectionToast.js\":\"aebf8f4a19fd447f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/alias/syncProcessor.js\":\"9dcdf21ffa29ebe3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/actions.js\":\"db96245d41e128f6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/addComment.js\":\"7771a677cf7a4d83\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/anchor.js\":\"da9ad15e5ca08c03\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/anchorState.js\":\"bf2fb79f915ac262\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/commentLinks.js\":\"77a06eb7195aa6a0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/confirmThreadDeletion.js\":\"e5ca3da5d275bb28\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/container.js\":\"708e3552774ca700\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/dataExtension.js\":\"91f435185a467237\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/deleteComment.js\":\"55d8fee965565594\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/highlights.js\":\"1a13d5b565d5474d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/index.js\":\"6613edff7f7e009a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/linkedCommentsPill.js\":\"905be807d7531781\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/margin.js\":\"8afa73c23efb443a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/marginAnchorLinks.js\":\"a16f91f9996c1784\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/marginSchema.js\":\"d3d720a682399132\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/newComment.js\":\"5f640412a9f7be37\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/ownThreadPicker.js\":\"91071073e011366a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/placement.js\":\"2720d9111d546402\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/queries.js\":\"5724ae7633a8ec66\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/quotePosition.js\":\"976b5630c37961d1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/quotedIn.js\":\"e77e2d6f3e149a72\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/quotedRange.js\":\"205104dbbc91fb86\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/rangeRefs.js\":\"3cd95dcb78115fc9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/readHighlights.js\":\"308f52e27e17566c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/readSelection.js\":\"97f7539eb8b464f6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/readSelectionUi.js\":\"25d16a88787ab462\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/reanchor.js\":\"54f1ab2802151707\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/schema.js\":\"d9a28eb8548a5f09\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/scope.js\":\"0baa6dd4a6486e98\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/scopeThreads.js\":\"e61c8d352140fb8c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/splitRetarget.js\":\"0a510825d2232df7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/suggestionCard.js\":\"4d91e3157e1b6bff\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/suggestions.js\":\"f159a2dc90395f8b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/summaries.js\":\"442fb0e3de572d32\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/summaryBatch.js\":\"86d1e37adfe8511a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/surface.js\":\"8cf545b6574065d8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/threadNavigation.js\":\"616a14336c5d1bdc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/threads.js\":\"75f91f8e3a652139\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/ui.js\":\"73f632ac52c7bf68\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/annotations/uiStore.js\":\"7b8b5dd5af1e6e71\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/app-intents/appIntents.js\":\"8fc924e245765e81\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/app-intents/index.js\":\"a5f69c4aa0f988d2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/app-update-prompt/index.js\":\"b20bd1171137ed17\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/app-update-prompt/status.js\":\"a54f721e17ef766b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"d493b4b625584f90\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/MediaBlockRenderer.js\":\"664854c17e1bb26b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0939704b3955eb81\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/MediaUploadReconciler.js\":\"d124f3d53d9c0793\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/assetDownLane.js\":\"aed4432e5e1339cf\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/assetResolver.js\":\"7a93aaa3398ffb34\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/assetUpload.js\":\"db85308333e6cf7e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/attachmentCleanerIO.js\":\"f8a5a096e95e131c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/audit/supabaseAuditIO.js\":\"378e58fa5b68b591\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/blobStore.js\":\"0321f7db8207aca7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/browserMedia.js\":\"3a8a238835fe8c0e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/byteStore.js\":\"c49eab6f55595dda\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/cleanerIO.js\":\"1320b480c68c2df3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/cleanupAttachments.js\":\"3873b08d8853786a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/dataExtension.js\":\"93980a3408e184cf\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/downLane.js\":\"58fe56ee3b96a802\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/index.js\":\"6258c12e5d1c9ea1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/insertImageContribution.js\":\"ce227a3bfb8b5b27\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/laneArming.js\":\"ccfd589349e50f4f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/laneLock.js\":\"d40122a797da7405\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/mediaBlock.js\":\"1a702187a38a722b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/mediaCapture.js\":\"21fdaaa080dbc84c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/mediaLanes.js\":\"5e40a5e0ca547a07\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/mediaViewers.js\":\"1abfab5d5bc5f5ee\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/mediaViewersFacet.js\":\"2db21e2f819e4107\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/pasteCapture.js\":\"534ad29b7c16bdcd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/resolver.js\":\"ce0c76f68c360f5e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/retryUploadsAction.js\":\"dfdac2cea580618e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/storagePaths.js\":\"c10fadeeb5618eca\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/uploadDrain.js\":\"e4ce2227d688aca2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/uploadLaneStatus.js\":\"b94d8225efd96f9b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/uploadReconcile.js\":\"ee8ae85ca4072405\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/uploadRecovery.js\":\"66d62acea73c133b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/uploadStore.js\":\"d4d517ed130ddbe8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/attachments/useAssetObjectUrl.js\":\"c96581297f92b748\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c241eace84ac2a2f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks-view/BacklinksViewSection.js\":\"16971f6649661c4e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks-view/facet.js\":\"83e31599ba58039c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks-view/index.js\":\"5dbb57a209384733\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks-view/prop.js\":\"f0187b7ed7b37706\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/BacklinkFilters.js\":\"8ea19d9a8a2cc00e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ed32fce4cab0fd78\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/BlockEntry.js\":\"cc1d6c0ad225cd90\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/LinkedReferences.js\":\"d99ff55173e1ce4d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0f49ce07d69cd407\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/dailyNoteDefaults.js\":\"89efa6ec0366f044\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/dataExtension.js\":\"6bbf1663f9139f33\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/edgeExclusions.js\":\"191834e2a63f0740\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/filterProperty.js\":\"fc5c28fbcc6a88b6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/index.js\":\"1a9b61e2e0cea7fc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"254bdead0f9b46f1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/inline-counts/applies.js\":\"19f3121512e24d58\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/inline-counts/countQuery.js\":\"e503ade44e1b7ccd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/inline-counts/expansionStore.js\":\"dbdd75a42236a903\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/inline-counts/index.js\":\"661eaf770746213a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"c11853dd153e71a6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/presentationInvalidation.js\":\"ad96aa31e1179b64\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/propertyEditorOverride.js\":\"72b8745d1dbc7344\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/propertyFilter.js\":\"d9baa010a049769a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/query.js\":\"d6ac1be715bc9b29\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/resolveFilter.js\":\"a672ed767514683c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/sourceBatch.js\":\"103f386ec177c8e1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/sources.js\":\"75bcab8369d06186\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/useBacklinks.js\":\"fa1e412e1ae8f428\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"bddcaa507f401734\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/birthday/BirthdayCelebration.js\":\"ebc85f386e35e414\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/birthday/BirthdayOverlay.js\":\"34b6d80b68ad50aa\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/birthday/gate.js\":\"c360d3276b35e2cc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/birthday/index.js\":\"c70d8655d0c102a4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/birthday/wolfTheme.js\":\"235f9a5cd58acb32\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-drag/BlockDragLayer.js\":\"e3775cf6a559d5ff\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-drag/dragController.js\":\"8c0a93052095226b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-drag/dropTarget.js\":\"1d2049733e342751\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-drag/index.js\":\"ef57012e50830f33\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-drag/projection.js\":\"5a7958b0b8495b57\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-info/BlockMetaCard.js\":\"388648008e5d7b22\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-info/index.js\":\"a4560b132ac8432d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/AddTagDialog.js\":\"970029cc35a9ad79\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b18a07d130f814bc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/TagNameIssueHint.js\":\"16216d7feb913d7b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/addTagAction.js\":\"9b5b1680a6449012\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/appendTag.js\":\"e58b8b2edb627052\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/config.js\":\"fe30b765e732b5c0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/dataExtension.js\":\"5a818d577ebbbc8f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/index.js\":\"c95278e7fe4386cc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/block-tagging/propertyEditorOverride.js\":\"64d3bc85a1d4791c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6e36828a6d8875d1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"9985a5bdf8b82de9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f2c0a5461d9b4f68\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0135eac12c059179\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"224beb1bb962cc0e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/index.js\":\"24b371332d037108\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"dcd6595fa8103aab\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/CharacterCountItem.js\":\"7f60be0090aa033e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/ProfilePropertyEditor.js\":\"98d7ed88a162a8c5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/actions.js\":\"6b6f66a3612c3063\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/blockType.js\":\"99d8ea408dc4d30d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/charCount.js\":\"06b04b5bb50d0643\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/dataExtension.js\":\"47989497d97b4dc4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/index.js\":\"ec8f7619c81b7e5a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/profiles.js\":\"63cc9a238bbf55d5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/properties.js\":\"db36eeb230807b87\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/subtree.js\":\"61dabcc0a620c876\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/character-counter/textCounts.js\":\"45c158fefbc8a602\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/colemak-keybindings/index.js\":\"4d90821d8f14b6b3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/CommandPalette.js\":\"8e4ea347e0a26952\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/HeaderItem.js\":\"33129aeaf7580faa\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/context.js\":\"2d3e56ac44e5b0df\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/index.js\":\"6f175060b0cf06d5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/selection.js\":\"a2365f99cf538195\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/toggleStore.js\":\"eb541edee14d5b6c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/command-palette/useCommandPaletteActions.js\":\"33f95e8818b1ec11\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/ContributorBadges.js\":\"26985abd086b7cd7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/ProfilePicture.js\":\"bf5ac32fc25c8c5e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/author.js\":\"5660ae14e680261c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/codeMirrorExtensions.js\":\"fbabb9198f566d84\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/dataExtension.js\":\"801f4b6eb8725ca4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/index.js\":\"0c4e48fe768019ae\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/mentionAutocomplete.js\":\"afe481d25b3a8c39\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/processor.js\":\"d28fa30969167f80\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/profiles.js\":\"fc47b9fad080e807\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/queries.js\":\"450c4cf9600bd217\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/schema.js\":\"84a679c8477f311d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/contributors/useCommentAuthor.js\":\"55930de1fc5be94e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"89c5fe1ebb515679\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6db37f43df85ef31\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/cursor-follows-scroll/index.js\":\"4b8c77fc14f7e7b7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"fedaf261419dad59\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c85ee77fa3794908\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/CalendarGrid.js\":\"287bbdaf4daee845\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/DailyNotePicker.js\":\"50ac833442186b04\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7236f5e497a38a67\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/DateNavDecorator.js\":\"f0923a822ac7a9d0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/DateScrubOverlay.js\":\"ab3ce16443645a6c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/DayPropertyControl.js\":\"0f77b7ab289b983f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/DayValueReferenceControl.js\":\"9e8560f8a50f9d04\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/HeaderItem.js\":\"c9f13f546b0935fa\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/ReschedulePicker.js\":\"d79f4ab4ce969108\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/SpreadDatesDialog.js\":\"44b2991d1a59d6d6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/actions.js\":\"159a5596b551cc5a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/blockDateAdapter.js\":\"3e672bd71d96926c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/calendar.js\":\"a8ab43d6fd13e495\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dailyNotes.js\":\"87bcd0e6432434c4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dataExtension.js\":\"1e31db402f509953\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dateScrubActions.js\":\"d65224403d15e1de\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dateScrubGesture.js\":\"c79be56f4968c7a0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dateScrubGestureActions.js\":\"41ffb079dbfe60ae\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dateScrubRecognizer.js\":\"37bdb687f712ff4f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dayProperty.js\":\"e2376f06b41c8000\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"9cf6cd2372697dd2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/deletionGuard.js\":\"97817741b05a0195\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/dueQuery.js\":\"8caac66e90742ed3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/index.js\":\"e42385f50a5c6ff4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/landing.js\":\"f7da4c2a976b6c8d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/localSchema.js\":\"e9ab16b1cfdd3161\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/referenceDateAdapter.js\":\"2bf81f0a598c5ba0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/rescheduleAction.js\":\"1de8ef95255190f3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/schema.js\":\"1a1ea57243b6a623\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/spreadBlockDates.js\":\"a84742a6ba9dc392\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/spreadDatesAction.js\":\"ba8cb0530719ef71\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/today.js\":\"ec9df80b612aa10d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"2b554df86f062f8c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1c02a5aa8bf3b17e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/audit.js\":\"f46886327ed3f7df\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/auditAction.js\":\"0ee4c6b5d7e615e8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/auditRanges.js\":\"dbc6fe3a3180a001\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/diagnosticsSource.js\":\"95e3f2be3b61d58e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/divergenceScan.js\":\"1b98c884ee71d345\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/index.js\":\"4f36832fcd009dfb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/propertyChildrenChecks.js\":\"351da44c5d9ec39b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/referencesMirror.js\":\"0ed19d63ee491260\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/rowJson.js\":\"343678d5b000245f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/schedule.js\":\"193ef28365c43e13\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/data-integrity/store.js\":\"f0603a1990654c1a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-maintenance/action.js\":\"d2f49efd3c257ce0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-maintenance/index.js\":\"76c46f019a44dddf\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-maintenance/plugin.js\":\"ab822ed054ddf0e6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d7364b399877fd36\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/actions.js\":\"5017f0e43792e362\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/changeMarker.js\":\"c72f8d4750147c4a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/diagnostics.js\":\"f5593b7731f6b063\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/fileSystemAccess.js\":\"d1fd79417f7a1033\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/filenames.js\":\"5300a38fbe94a97c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/index.js\":\"cc355fe4a9d502fb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/mirror.js\":\"fce8d0e0cf98b80b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/runLock.js\":\"913be889a4c83ea1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/runtimeHealth.js\":\"a85e8819d0ed0285\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/schedule.js\":\"5f5a6f0cf2ded796\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/db-mirror/store.js\":\"1879a3a827cb5304\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/default-themes/index.js\":\"c93a2d4fb4f704ea\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/default-themes/themes.js\":\"a25c9268842e374a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/diagnostics/facet.js\":\"efc7231526127125\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/diagnostics/useDiagnostics.js\":\"e8205282ca0741f2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extension-prompts/dismissals.js\":\"35c1f5ea3701e4cf\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extension-prompts/index.js\":\"c2a7db5dbf036843\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extension-prompts/status.js\":\"441dbfea195477f5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extension-prompts/store.js\":\"6d45ee98bcbd345a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"25a238910c9a0dd8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/ExtensionsSettings.js\":\"83bc5ce023e442cb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/actions.js\":\"5db6b9fba825647c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/config.js\":\"9eb055e2c8124a74\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/dataExtension.js\":\"2d12407649c88d0c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/effect.js\":\"a8006e46b6a4a268\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/index.js\":\"8489c9e399de3be6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7fc78c7c3fcbf163\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extensions-settings/useToggleTree.js\":\"d58c27376495e802\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extract-type/ExtractTypeDialog.js\":\"2f866328c08f7ac2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"65d6b29cf6995dbc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extract-type/PropertyShapePicker.js\":\"0d99fd3b377f473d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extract-type/action.js\":\"672952ed3e0a04fe\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/extract-type/index.js\":\"e7b3a93c7bca809a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/FindReplaceDialog.js\":\"78426d889db17991\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/HeaderItem.js\":\"13ae09aa40ba1966\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/dataExtension.js\":\"01ea1d7f225b42fc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/index.js\":\"ebcf71e61e6b065d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/search.js\":\"18ee71c9355e9280\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/toggleStore.js\":\"cff0350e1e3a2f23\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/LocationPropertyEditor.js\":\"9b0e225c1f630bdc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/MapView.js\":\"700269400154c0d5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/blockTypes.js\":\"3659ee07b0c69379\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/codeMirrorExtensions.js\":\"b852c52a86017d89\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/createOrFindPlace.js\":\"6e59ec49a0862a5b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/currentLocation.js\":\"f082cca5058141b8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/dataExtension.js\":\"1e50982ee79e9a5f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/geoContentDecorator.js\":\"eb8c1659a59f0948\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/googlePlacesClient.js\":\"a55036cb21b0ee43\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/index.js\":\"fcc2f7f90387bc85\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/locationsPage.js\":\"ae4af81a65edd693\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/mapViewport.js\":\"8e90b299a9847c77\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/pickCurrentLocation.js\":\"74acfff16eb3a840\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/placeAutocomplete.js\":\"51509dc93ee34e9b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/placeNameCollision.js\":\"111634ce74448ae3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/properties.js\":\"dd35de7660b64056\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/propertyEditorOverrides.js\":\"7250f95ab5509a4e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/query.js\":\"e766b653f5fe5366\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/geo/usePlaceSearch.js\":\"49d65d9d341a14e7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"72a0e90b3d94e6ad\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"2f9653eb4e933575\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"72854ca589056a00\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/config.js\":\"d13f2491405a72c6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/dataExtension.js\":\"4004dcef52d36fd2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/facet.js\":\"2f0155f7152fb8e5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/grouping.js\":\"7cb27e0afe7e67e5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/index.js\":\"85f579bc2df0598e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7c7c7b41f25d1fe5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/query.js\":\"93bd23c3ae1955c6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/resolveConfig.js\":\"64ac934144098e13\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"203495c3a0af7768\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"2594bc56fa1043c6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/HtmlDocumentContent.js\":\"c9ef1da519a32f45\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/HtmlFrame.js\":\"b3fed71b400ec269\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/actions.js\":\"a94fdc145df17551\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/blockType.js\":\"6d2571526e61dd4d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/confirmRunScripts.js\":\"26d3b37f2976753e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/dataExtension.js\":\"a4e05a18ab21a131\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/frameAnnotations.js\":\"a671b48d3a3784e9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/frameDocument.js\":\"f205727255c26d17\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/frameTheme.js\":\"a386fe3bf2d7271a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/index.js\":\"1888d7efd8542d8a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/scriptConsent.js\":\"1acf14635dbb3b60\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/sourceMap.js\":\"7c1bb44295c6483b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/html-document/useDocumentScripts.js\":\"bb0a290bed8b0f20\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/interaction-metrics/index.js\":\"b505ca8b5415aa7a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/interaction-metrics/record.js\":\"9ab0b4ea50eb5652\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/interaction-metrics/recordStore.js\":\"8cddf8e98bd33f67\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/interaction-metrics/responsiveness.js\":\"685e76e56d297279\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/interaction-metrics/schedule.js\":\"199dbbc31e918c2b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/interaction-metrics/sessionContext.js\":\"33af9f7f702105ba\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"5d976008445ef517\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5be9d95e1afa5111\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/actions.js\":\"7c668ba607ab1f1b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/config.js\":\"e86c1b50e5fb1cc2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/dataExtension.js\":\"e4821595e4bfa39c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/effect.js\":\"f2cb82d1375ca021\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/index.js\":\"c935e98a3aca6a4f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/keyCapture.js\":\"9478052506624dae\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/overrideStore.js\":\"3484146bb218d493\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c32dfbe7d07fe66e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/HeaderItem.js\":\"3c22f34db654d946\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/LeftSidebar.js\":\"51be7d4a13818f49\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/actions.js\":\"7ea278fed1627f58\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/facet.js\":\"198138eebd9215be\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/index.js\":\"1df00a7af36ea07a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/shortcuts.js\":\"71883ea7c9ba72c9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/left-sidebar/toggleStore.js\":\"888614d27607c711\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/merge-blocks/MergePicker.js\":\"954ea5db73f3bf1b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/merge-blocks/index.js\":\"bf3f85ae17e1dec6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/merge-blocks/mergeAction.js\":\"39b60b3833020a8f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/merge-blocks/strategy.js\":\"e1baddf9df910617\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-bottom-nav/Button.js\":\"6dc5bba257de69f7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2fd72451fefde401\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-bottom-nav/defaultItems.js\":\"40ccba5063a92f42\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-bottom-nav/facet.js\":\"997bb23ec0fde365\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-bottom-nav/index.js\":\"6c220141ae55bb58\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"62a03c5e565e5939\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-keyboard-toolbar/actions.js\":\"8959693981131c24\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"28cafbca744e9323\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-keyboard-toolbar/facet.js\":\"4c433d40dad9f9d4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/mobile-keyboard-toolbar/index.js\":\"525073c68cf7d026\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/MoveDestinationPicker.js\":\"3047452c799f52e3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/blockSubtreeMembership.js\":\"53faa4117f97e8bc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/contextMenuItem.js\":\"685bd38470c1a472\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/index.js\":\"ca2d655c49d47e85\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/moveAction.js\":\"4fbe818b438b8661\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/moveBlocks.js\":\"2b492ef3d9f8c3d2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/move-blocks/selectionAfterMove.js\":\"d34e78daa406b42b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/TutorialBanner.js\":\"c94c25db96444198\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/action.js\":\"f0a13ad951ade604\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/bannerDismissal.js\":\"a2f4825b10ce7c7e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/documents/cheatSheet.js\":\"7d04a5f8439571fa\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/index.js\":\"61561109b242c853\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/keys.js\":\"3fa3cbfafb4e6b29\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/landing.js\":\"78eaad8b46f4e643\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/outline.js\":\"04207626ef8697f2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/onboarding/seed.js\":\"71cd0435c4e917cc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/PerfTrendDialog.js\":\"6f3063e860123178\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/analyze.js\":\"dd344128ad824314\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/diagnosticsSource.js\":\"b51b543e8dc833b8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/index.js\":\"2142c7da45da7f1b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/load.js\":\"6c470d8e6474bdfc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/monitorRun.js\":\"e71dc3e896e0cbcc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/schedule.js\":\"f99e1d4155d7bacb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/series.js\":\"c1d4b94f97540e4b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/store.js\":\"bfe0ab7ef82ca592\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/trendAction.js\":\"45819de5b06878fd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/perf-monitor/verdict.js\":\"b85662892358fc42\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/plain-outliner/clickToEditAction.js\":\"604b79bbdb5c93e8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/plain-outliner/index.js\":\"6f3c9108ac5c26f1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/plain-outliner/interactions.js\":\"f2ff514e0d0d022c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"fe15e787cc08b524\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/MigrationGate.js\":\"dd3ae8e2a2dd9b07\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/MigrationGateDialog.js\":\"5ebde1e59341eae9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/action.js\":\"0f3714ea444fbeea\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/index.js\":\"ca4c2a8b1536bfb1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/localRunMessage.js\":\"3e414171d882061c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/plugin.js\":\"3c89c681494134c8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/progressReport.js\":\"e40f2b826329d242\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/properties-migration/sweepProgress.js\":\"577735c2938629fe\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/FieldRowRenderer.js\":\"f5f073d734414752\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/ValueRowRenderer.js\":\"6c647cc689a792d9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/actions.js\":\"dbf9cb7a79081584\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/autocomplete.js\":\"26b3762216b29325\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/fieldRow.js\":\"a268e7630ca913b5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/index.js\":\"c1a560bc33278579\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/referenceWarning.js\":\"945f2d639e4d23f2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/valueAutocomplete.js\":\"bb6e88a5db93daf1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/property-rows/valueSchema.js\":\"6a65cea98d12926f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/HeaderItem.js\":\"902b353e35511218\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/QuickFind.js\":\"c2bc9ceef0a706b7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/index.js\":\"18b60d473481fb65\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/recents.js\":\"b4a75efdd78a3087\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/resultItems.js\":\"378d3181bfe16c9d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/selection.js\":\"47c3b11514c3e533\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/quick-find/toggleStore.js\":\"efa51559c05f7d6a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/recents/HeaderItem.js\":\"59545109a7e39dae\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/recents/RecentsPageBlockRenderer.js\":\"792d9963a61f1d4a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/recents/grouping.js\":\"87277544544efe9c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/recents/index.js\":\"d966fe9594440752\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/recents/target.js\":\"a0c3335e0a8d5651\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/codeMirrorExtensions.js\":\"90404372854775ad\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/contentPrefill.js\":\"b96b010ec061b01c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/dataExtension.js\":\"f366b84079d8d659\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/index.js\":\"1c8dcf4d84617054\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0123831d8fdeb89d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/invalidation.js\":\"f21c23541b6abd24\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/localSchema.js\":\"f51fdfb01867c6ab\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/blockrefs/index.js\":\"6841ab0883fcf6eb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"24d71ebb6ff711d3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/index.js\":\"c7bb198bbcacc535\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/referenceNode.js\":\"c67702feb7f4fd06\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/remark-reference-occurrences.js\":\"aee8a05e839948c7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5016e895421a8bee\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/wikilinks/index.js\":\"4cd34fffc171a6f4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"824c9ca685583648\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"358199116ef53682\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/mergeRetargetProcessor.js\":\"2c69053a5071ce4a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/parseFence.js\":\"0b215fa880ce0432\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/referenceParser.js\":\"6009ad6f200c9ce7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/referenceProjection.js\":\"eab1566b363017db\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/referencesProcessor.js\":\"5624776d8424d3bd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/renameProcessor.js\":\"9198390beb212801\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/references/spanReplacement.js\":\"1e31deedf4e2e67a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/rich-paste/htmlToOutline.js\":\"f8154ddfd8620652\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/rich-paste/index.js\":\"052ec254fdc47fb9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e83cbec7d437a40e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/rich-paste/pasteDecision.js\":\"bebeee13ea6d9c65\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/action.js\":\"8b9546e091851a6a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/blockIds.js\":\"d98394a809125418\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/content.js\":\"20e1c5cd9d075049\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/effect.js\":\"0d5a218b0ff68417\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/ids.js\":\"47843f7f313f91a0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/import.js\":\"6535502a41280ad3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/index.js\":\"ec655a140a8a9d57\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/plan.js\":\"3327a4f5408b576f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/plugin.js\":\"3d5cb46a11c203cd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/promotion.js\":\"cc2e92e96a42bd44\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/properties.js\":\"2dd0f9e1eabecf6a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/references.js\":\"e58cbfe8adbd1f34\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/report.js\":\"73b3bfced59f55a2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/roamMemo.js\":\"580e3a35427cea7f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/runtime.js\":\"e8fda574931e3ec3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/schemaReconciliation.js\":\"5f00c682f97e55fe\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/srsMarkers.js\":\"72570331e3c67957\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/todo.js\":\"4a7387fcb59da879\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/typeCandidates.js\":\"bf9b9443222eac32\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/roam-import/types.js\":\"c677990e57037e15\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/search-health/index.js\":\"a146ae37add34161\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/search-health/store.js\":\"59650e85668991ea\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/shortcut-help/HeaderItem.js\":\"3d45b04bff265e1e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"b123e51f890c6c1d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/shortcut-help/index.js\":\"5a64aa0b216e6042\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/shortcut-help/model.js\":\"794b5c3fb0b9b256\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/shortcut-help/toggleStore.js\":\"2374cb19035279a8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/shortcut-help/useKeyInspector.js\":\"07d6f4a8c793aba5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e1d0d0ce554aed20\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/ShellDecorator.js\":\"6fd1c1b5d3b8769b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/actions.js\":\"476727d5f5e41334\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ce98f2ab7fe4fdf2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/index.js\":\"8f34d53b03d620d3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/shell.js\":\"d15be0c76c2f79aa\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/surface.js\":\"5f48a853e57b6a6e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/spatial-navigation/walker.js\":\"6a5055ca092c35c1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/RescheduleToast.js\":\"37943f80e61fac68\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/dataExtension.js\":\"1833f24ead8cf474\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/index.js\":\"410d6d5ff04247c3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/indicator.js\":\"6c42d8b25b87cd34\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/moveSrsState.js\":\"be551875884dbfdd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"522a008b996c61f6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/scheduler.js\":\"6207da0dda037b95\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/schema.js\":\"963d0641e3cded2e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"b21a8c7622b80c7a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/srsClipboard.js\":\"b9d84ef1312251d5\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"0d5f04471a6403b3\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/DailyNoteReviewHint.js\":\"c09708cefe5a6d24\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/DeckPicker.js\":\"a1a2625926ff629f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/ReviewControls.js\":\"467324577a517ab4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/ReviewDeckRenderer.js\":\"72154f0a9d1e9f8c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/ReviewSession.js\":\"e74a822fada3bbea\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/actions.js\":\"75eafe92f1c25b5d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/archive.js\":\"ae04fb8a292e0fbc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/dataExtension.js\":\"c4edbbb4a4ababe1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/deck.js\":\"01040b9b559611fc\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/dueQuery.js\":\"51ca9b2d6a684584\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/gradeDecision.js\":\"cf17987ba00db038\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/index.js\":\"857a53ec068a4a49\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/keyHints.js\":\"9de940cd9c53ae74\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/reviewCardLayout.js\":\"c4c55e99714d412f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/reviewProgress.js\":\"7d2fd632763f553a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/schema.js\":\"44eca6c2ebf7aa43\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/srs-review/useDueCards.js\":\"5d7b684bc4bf6e2c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/startup-metrics/index.js\":\"2e77db32bb502d4b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/startup-metrics/record.js\":\"3ac4cf9d2bdfd94e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/storage-persistence/index.js\":\"2b9a23870fab04fb\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/storage-persistence/persistenceStatus.js\":\"e6826bbaf4a8b411\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/storage-persistence/requestAction.js\":\"3ea6ad46ca0b427b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/supertags/TypeChipsDecorator.js\":\"d1ea7b5fd4baed07\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/supertags/codeMirrorExtensions.js\":\"53e4663c76b80ce8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/supertags/index.js\":\"d1a8642acc389e4b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/supertags/typeAutocomplete.js\":\"8137d1ba368b4247\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ae5de34fb77c4141\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/actions.js\":\"7cf3393002f77d93\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/anchor.js\":\"5aa20043ba3d532f\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/events.js\":\"fd5a90ee5b67bdd6\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/gestureActions.js\":\"230e78fa325f5665\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/index.js\":\"62931e550c828db0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"a8bfc305d0f7ddc7\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/sync-metrics/collect.js\":\"ba1216b98134e913\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/sync-metrics/index.js\":\"4cfbc189e5c668fd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/sync-metrics/record.js\":\"6d6d244c26295559\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/RejectionDialog.js\":\"1442e31d6b72ee56\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/SystemStatusHeaderItem.js\":\"2390d4fc48f29bfe\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/index.js\":\"43ae07a62e02ac36\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/model.js\":\"430420f6424126c1\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/queueCounts.js\":\"7cd8fff4db3c9c69\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/rejectedHelpers.js\":\"ec63d586fa137a68\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/rematerializeAction.js\":\"5930c547ecf0c5dd\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/system-status/useHysteresis.js\":\"6dd1a88925212218\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/ColumnHeaders.js\":\"59ecce07c773cdfa\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/QueryUi.js\":\"907a32ca17f72593\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/TableLayout.js\":\"a3fb87afe362bc4a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/actions.js\":\"bd8c805219b9835a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/cellEdits.js\":\"f46be663030ec8a2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/childrenViews.js\":\"5cdc52ec62f1cc17\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/columns.js\":\"4daf953a2624a495\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/controller.js\":\"35bd3dea694c7f9e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/convert.js\":\"2fe27ca67fbacf5a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/dataExtension.js\":\"bd0b4749e47742a9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/index.js\":\"26fbeb24aad36c2e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/keys.js\":\"141ec46c117578a2\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/model.js\":\"4073f7bf63681439\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/QueryText.js\":\"3895d0a460c6ce75\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/backfill.js\":\"a54728d28ccf1234\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/completion.js\":\"d337f482c3f925aa\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/format.js\":\"1517926045642901\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/parse.js\":\"2d948573efcbee3c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/queryValue.js\":\"9b6da8fb77e98161\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/registrations.js\":\"1eb892fe2e36f72d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/query/source.js\":\"cf40624a024d7015\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/registry.js\":\"5e04e68fdd2326e0\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/rowGutter.js\":\"2dc8465d9ef17bc8\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/rowVerbs.js\":\"d845846cf65ae85b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/schema.js\":\"4bca26814e1ad999\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/tables/sort.js\":\"012b84102dab962d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/theme-toggle/effect.js\":\"066f1be6bbaf3630\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/theme-toggle/index.js\":\"a965079a20950583\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/theme-toggle/theme.js\":\"f0e64458d64c4492\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/todo/actions.js\":\"05804148a56c9319\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/todo/dataExtension.js\":\"a70511a067eb4fe4\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/todo/index.js\":\"375a4d18baf2f22d\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/todo/schema.js\":\"31461df96b531a28\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1c3cbc231a7ca963\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/touch-selection/actions.js\":\"917b11faa5921506\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/touch-selection/defaultItems.js\":\"844c8059e91a7e07\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/touch-selection/facet.js\":\"c2f63f97aeeb4d10\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/touch-selection/holdRecognizer.js\":\"8636c11209837e89\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/touch-selection/index.js\":\"f8c7832a5cf66087\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/update-indicator/UpdateIndicator.js\":\"6533155fdcc2584b\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/update-indicator/index.js\":\"d8265d50661def80\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/update-indicator/loadTimes.js\":\"4804a76700b53442\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/VideoNotesRenderer.js\":\"0601f1d7823c891a\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/VideoPlayerRenderer.js\":\"f6e29779d809dd59\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/VideoTimeStamp.js\":\"d45bb17eecd733b9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/actions.js\":\"f61ea05fa1552eaf\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/index.js\":\"6d2bac5edf6ae834\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/markdown.js\":\"c375135009275003\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/notes.js\":\"437a0b839d227429\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/registry.js\":\"a834e462906f09c9\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/remark-timestamps.js\":\"6f6246f75bc66a4c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/video-player/view.js\":\"a75134a15318525e\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-link-hints/LinkHints.js\":\"5858af2ae5b01a93\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-link-hints/index.js\":\"bbee33a450586049\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-link-hints/model.js\":\"841bf214233f6f91\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-link-hints/settings.js\":\"b7a7c56381d03122\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-normal-mode/actions.js\":\"11bee25c5ad81332\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-normal-mode/index.js\":\"d419b16d6fad3565\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/vim-normal-mode/interactions.js\":\"7d386d08bcac8c5c\",\"/knowledge-medium/pr-preview/pr-1898/src/plugins/workspace-header/index.js\":\"16f2c2045051f367\",\"/knowledge-medium/pr-preview/pr-1898/src/registerServiceWorker.js\":\"90684da984f38277\",\"/knowledge-medium/pr-preview/pr-1898/src/requestPersistentStorage.js\":\"ed465c99a3a1c808\",\"/knowledge-medium/pr-preview/pr-1898/src/services/authRequestDeadline.js\":\"fe3d2e130977d0dc\",\"/knowledge-medium/pr-preview/pr-1898/src/services/authStorage.js\":\"01058662272d075c\",\"/knowledge-medium/pr-preview/pr-1898/src/services/powersync.js\":\"225ba3b3e39d29ca\",\"/knowledge-medium/pr-preview/pr-1898/src/services/supabase.js\":\"1f3f7cd6864b0da0\",\"/knowledge-medium/pr-preview/pr-1898/src/services/uploadErrorClassifier.js\":\"9ebc0c299b873922\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/ActiveContexts.js\":\"d2f32116a04634d2\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/HotkeyReconciler.js\":\"ec7a7426be411689\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/WipeLocalDataDialog.js\":\"e30dbb38c23dafb7\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/actionDispatch.js\":\"5e2b867fbc6ffcb9\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/actionRefItems.js\":\"b5215d59101bb80a\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/applyKeybindingOverrides.js\":\"5d415591ada187a7\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/blockActions.js\":\"408e2ad71a071849\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/blockMergeGesture.js\":\"b4af68c0efb43cc0\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/canonicalizeChord.js\":\"437262c1d9d1c265\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/defaultContexts.js\":\"a64eb4f8b9587f3b\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/defaultShortcuts.js\":\"1eef7fedab0907ed\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/effectiveActions.js\":\"6a3b16a62747124f\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/gestureAction.js\":\"dd343450c53de7b8\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/gestureBinding.js\":\"64760063a824af29\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/holdRegistry.js\":\"ff80da1678b32016\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/keybindingConflicts.js\":\"74346ae933c24efe\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/keybindingOverrides.js\":\"7b48c4d37473cab8\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/pointerAction.js\":\"8fe5b6f418c440a5\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/resolve.js\":\"b59d926c1053701c\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/runAction.js\":\"6e202f8ceeae2941\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/sequenceMatcher.js\":\"edd39e2ff4b1d77d\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/types.js\":\"b085d73eefd38f39\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/useActionContext.js\":\"f6b0d8e6a36362e4\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/useActionDiscovery.js\":\"07a197eb3a6a7de3\",\"/knowledge-medium/pr-preview/pr-1898/src/shortcuts/utils.js\":\"b82ea9061095f932\",\"/knowledge-medium/pr-preview/pr-1898/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1898/src/sw/bootStore.js\":\"d287838a001d2f55\",\"/knowledge-medium/pr-preview/pr-1898/src/sw/previewDatabases.js\":\"ea201e5770133e1e\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/byteTransform.js\":\"84718e3c6264b33d\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/attachmentCleaner.js\":\"f66ba3794273e474\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/bundle/attachmentParts.js\":\"6addd7a06e2d619f\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/bundle/bundleParts.js\":\"046491e8880a60cc\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/bundle/bundleRecord.js\":\"85559bce0ced9153\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/bundle/manifest.js\":\"49d8d4e3511ce6d0\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/bundle/takeBundle.js\":\"fef99251c408dc91\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/bundle/verifyBundle.js\":\"af14680b8b6f4e94\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/cleaningStage.js\":\"5e94cc0207e0a0a5\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/conversionKey.js\":\"7a2fa12b297d5d5d\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/conversionServer.js\":\"2a93854fdbc6a5d3\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/flip.js\":\"b8b95678fbda57eb\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/flipAttempts.js\":\"e44d0091add0dc84\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/pages.js\":\"78ef9de8d2c325ab\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/preflight.js\":\"7cc740fa63d275cf\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/reseal.js\":\"70455ca590366d87\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/runConversion.js\":\"a1ff2ec1b1f4c69f\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/runLock.js\":\"82bca6ab93f9f9a3\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/sealing.js\":\"a6569f31e7ff9e52\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/sealingStage.js\":\"d44335593d5f942b\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/stage.js\":\"0868bda3a58a9994\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/conversion/verifyReseal.js\":\"11f4fdb1e712b88c\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/aad.js\":\"f9cbf984c329443e\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/aead.js\":\"16272479bbb51373\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/base32.js\":\"9e04f8e2a85ade1a\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/base64url.js\":\"4c2f46a5c0bb4749\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/binaryEnvelope.js\":\"8fd11e198f7f1380\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/byteAead.js\":\"6bd2c6dc818f0a70\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/canary.js\":\"493806f37adcc266\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/contentHash.js\":\"431e3f3afb3be153\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/contentKey.js\":\"af712b83e9eac66f\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/derivedIdNamespace.js\":\"2cbb32d1f470cf94\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/envelope.js\":\"113959c4533f6152\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/hex.js\":\"134d84eac8d95b8e\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/sha256Hex.js\":\"055e9dccf693d63e\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/crypto/workspaceKey.js\":\"8c80f38f8491b3ea\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/conversionState.js\":\"e1bad5690889ecad\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/flows/createEncryptedWorkspace.js\":\"c31ecf69a49798cb\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/flows/pastedKey.js\":\"212a6e71d408a200\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"42dc5fd86b4ccbbb\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/flows/upgradeWorkspacePin.js\":\"6be1e3c5f03cd70d\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/keyStore.js\":\"4bb2589fcdfe3207\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/mintWorkspaceKey.js\":\"272ca1688739583c\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/modePin.js\":\"53e0199a08a800e0\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/openWorkspaceKeys.js\":\"1794be78b047d01e\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/resolveWorkspaceEntry.js\":\"35ab035e08ce1b2a\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/resolver.js\":\"063dff81995500cb\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/keys/workspaceAccess.js\":\"1b8c3a1a0d4bb4d8\",\"/knowledge-medium/pr-preview/pr-1898/src/sync/transform.js\":\"6b3b2d4976c49df4\",\"/knowledge-medium/pr-preview/pr-1898/src/themeBootDefaults.js\":\"1fb3a2faa57bc37f\",\"/knowledge-medium/pr-preview/pr-1898/src/types.js\":\"b42599925d9bd3e8\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/ClientLocalSettings.js\":\"2ba5278b614bebfc\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/abortableSleep.js\":\"a35e223d2fd3b6fe\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/array.js\":\"ab1a356523ca8c75\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/backlinkAutocomplete.js\":\"dc2cb7389785ec04\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/blockCrumbs.js\":\"ff47a69fef5d90df\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/blockrefAutocomplete.js\":\"f67cd09439421866\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/cadencedIdleJob.js\":\"04aa705526e4ad9e\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/callbackSet.js\":\"cce44cfee4ea2333\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/clientId.js\":\"afb2548ea985c93e\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/codemirror.js\":\"4a632a4def12ed0b\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/codemirrorCompletion.js\":\"77a9da094306932e\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/copy.js\":\"e4ed79c4713be3ca\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/dailyPage.js\":\"1efaef8e2976828e\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/dbForensics.js\":\"379a4c8a0051975a\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/dbForensicsHooks.js\":\"23e8d4f744c103e1\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/deleteBlockThroughUi.js\":\"becc7507d1d2d626\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/dialogs.js\":\"fd3baed68697a01b\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/dom.js\":\"9be5fcbf558f0057\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/downloadBlob.js\":\"61ba45e5aa2a6a61\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/drawnWalk.js\":\"e2217ef8802e49d9\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/exportSqliteDb.js\":\"28b15d04b2e54fc5\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/fileSystemAccess.js\":\"70e37890a14b8c24\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/flipSlide.js\":\"e951bdfc5183887e\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/fnv1a.js\":\"1ec2b0d312865b09\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/formatBytes.js\":\"5f76cc86d398e40c\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/fuzzyRank.js\":\"9dc181918df58df8\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/idbKeyedStore.js\":\"8f7e7930e3eebfb6\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/idleCallbackPolyfill.js\":\"a6053f9f349d2af6\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/keyboardAwareScroll.js\":\"650486bcd4bd0bd0\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/keyboardViewport.js\":\"d5e62767450c0ec5\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/lastWorkspace.js\":\"b71886648cc8de7b\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/layoutColumns.js\":\"303a74f4289ae9c1\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/layoutSessionDom.js\":\"3f50d60dcfbab8d4\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/layoutSessionId.js\":\"baae099c88abc8d8\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/linkClickGestures.js\":\"ed1b01574fa4be1b\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/linkTargetAutocomplete.js\":\"31e28aa454a20a25\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/localDbCorruption.js\":\"b8b7adbe0e8fbe91\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/localDbRecovery.js\":\"f8d74418d61404cb\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/markdownParser.js\":\"47ae068e8b1a5336\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/memoize.js\":\"0c20ef50a6836ffb\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/nameFieldCommit.js\":\"bed4c2206e4ba919\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/nameList.js\":\"424eb9d224f5d32f\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/navigation.js\":\"10ecfc5f17d35d04\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/omnilinerNamespace.js\":\"6511dda86d0c952e\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/opfsPageScan.js\":\"81707d2ced92f13c\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/panelClearance.js\":\"a681ae7dcb91f51e\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/panelHistory.js\":\"4a5096a4fa5b246e\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/panelLanes.js\":\"fc36d7f1d0a1b57e\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/panelLayoutProjection.js\":\"7c46b0e890fede6b\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/panelScrollAnchor.js\":\"5783074808de49f9\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/panelUrlFlags.js\":\"e0e59feeab42b29d\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/platform.js\":\"9e32056635e4e78f\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/pluralize.js\":\"2a647f5eda016ff1\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/propertyCreation.js\":\"022e596aadcca576\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/propertyNavigation.js\":\"b781dee27744a933\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/propertyValueContext.js\":\"9f3b96c2a232eaeb\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/react.js\":\"94a0ee52d279831a\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/relativeDate.js\":\"7bd8c7f7c2edbe47\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/relativeTime.js\":\"cdee00565451f6b6\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/renderScope.js\":\"e781452cddfc8f74\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/resolvedThenable.js\":\"c60799412fd8a1a9\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/routing.js\":\"8424f68899e37a97\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/safeMode.js\":\"b236efa46dcde795\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/scheduleIdle.js\":\"481193b8cdf00787\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/screenWakeLock.js\":\"d0f6de9f39eec1b2\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/selection.js\":\"c729663db60f8eae\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/softKeyboardGrab.js\":\"9c676fbb9d70f7a6\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/startupTimeline.js\":\"fd4d41192f3d7ddc\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/state.js\":\"abac26c12d130958\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/string.js\":\"2d6e7136c3220b06\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/surfaceZoom.js\":\"03712ce37ed0af34\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/time.js\":\"ddbb359722062047\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/toast.js\":\"a1b778179412a63d\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/toggleStore.js\":\"d0fb29006ae1493b\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/untilStopped.js\":\"f49a540751e28fe4\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/userActivity.js\":\"48885c519761bded\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/viewTransition.js\":\"e29536d5e564ae73\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/viewport.js\":\"35c13f88cde845e6\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/webLock.js\":\"6ca0e1abee6fd29a\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/workspaceRecovery.js\":\"26af7fb440c65700\",\"/knowledge-medium/pr-preview/pr-1898/src/utils/workspaceSnapshotStore.js\":\"db530b859330a8ac\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-compiler-runtime.js\":\"7694bb9a6d8e67f7\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom-client.js\":\"999c9d46961037d6\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom-server-edge.js\":\"a0c9627340c5d5b6\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom-server.js\":\"5508adec706b6fc2\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom-static-edge.js\":\"afad35b1cc203540\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom-static.js\":\"ca597880d26600bb\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom-test-utils.js\":\"9f063bda4d072979\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-dom.js\":\"b1447eae4c50bb77\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react-jsx-runtime.js\":\"eae74918d877ad7b\",\"/knowledge-medium/pr-preview/pr-1898/src/vendor/react.js\":\"06f67b44ab57bf63\",\"/knowledge-medium/pr-preview/pr-1898/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1898/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1898/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
