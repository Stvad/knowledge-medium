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
		buildId: "5a036b973909-35047745",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/\":\"8062266e1a224cf0\",\"/knowledge-medium/pr-preview/pr-1899/index.html\":\"8062266e1a224cf0\",\"/knowledge-medium/pr-preview/pr-1899/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1899/assets/FacadeVFS-B9jLqfab.js\":\"763eb4093bd8fee9\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSCoopSyncVFS-DtwLKy83.js\":\"f73515a3f3333054\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSWriteAheadVFS-BONy0fP0.js\":\"887ab736a6c34c93\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-DLFUAwdX.js\":\"a0e59f29cbc87ea2\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-BshiGTRj.js\":\"4e27ce816562316b\",\"/knowledge-medium/pr-preview/pr-1899/assets/worker-Bk7aBePL.js\":\"d82d7b0a70bac9ec\",\"/knowledge-medium/pr-preview/pr-1899/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1899/chunks/app-CXpCqTt-.js\":\"b3bbdc9980dbe8b4\",\"/knowledge-medium/pr-preview/pr-1899/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1899/index.js\":\"45db35813a563967\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1899/assets/AccessHandlePoolVFS-CyBIsY5o.js\":\"0af4b2b63384cece\",\"/knowledge-medium/pr-preview/pr-1899/assets/IDBBatchAtomicVFS-qTpzDvaH.js\":\"d09c029ddd907795\",\"/knowledge-medium/pr-preview/pr-1899/assets/MemoryVFS-Cbqj_-X1.js\":\"db2fee2b41dfcb76\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cof1KQIi.js\":\"e3aa4671dc972e48\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-C6Nt3FpC.js\":\"ad2ce872698709cb\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1899/chunks/AccessHandlePoolVFS-BOml_WaL.js\":\"e6806fd2b755fb64\",\"/knowledge-medium/pr-preview/pr-1899/chunks/FacadeVFS-CcDa_8xG.js\":\"9cc19c698f1fb9b1\",\"/knowledge-medium/pr-preview/pr-1899/chunks/IDBBatchAtomicVFS-DZdNk5Lt.js\":\"b988dd119352744b\",\"/knowledge-medium/pr-preview/pr-1899/chunks/MemoryVFS-KQlevNG3.js\":\"f425e461958328af\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSCoopSyncVFS-OtNpfBMx.js\":\"44536a3d105e057b\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSWriteAheadVFS-7lUFo5r3.js\":\"07f71aabc567265a\",\"/knowledge-medium/pr-preview/pr-1899/chunks/Preview-DB8kdRhr.js\":\"23552fa093d6db58\",\"/knowledge-medium/pr-preview/pr-1899/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/card-BPra4gV3.js\":\"e45abc769fc491f1\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-Co3MPPXN.js\":\"3f07cfcb43430481\",\"/knowledge-medium/pr-preview/pr-1899/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-KOTd-Jz-.js\":\"830f130835e933c7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-async-DXpyFyuH.js\":\"07d730191d5534b9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DNyAMwQY.js\":\"6a179f170d204eb6\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-Mgu6RZe3.js\":\"57ff1363631477a8\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-MpSUVJOe.js\":\"7196557009bb64bc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server-legacy.browser.production-dM1paaM6.js\":\"1c0020f8857ce35b\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.browser.production-kCwKETN_.js\":\"1302f8db6d3f906e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.edge.production-4Nw2W86Y.js\":\"413ca507a91b4ad9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-fDmp8Qxz.js\":\"2523f7ba17c26bbe\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-oIK1sPvv.js\":\"3ba4bfdaa43e6167\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-s5S-MaHX.js\":\"d49e94b12dc88246\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-ubS-1GZs.js\":\"cde151184ea3268a\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-vEkF5cvd.js\":\"cc8e5adee5c73f99\",\"/knowledge-medium/pr-preview/pr-1899/chunks/server.browser-BE21C7R9.js\":\"bf194f04553c4910\",\"/knowledge-medium/pr-preview/pr-1899/chunks/textarea-uvE-OWwr.js\":\"bb97a585b528e2e0\",\"/knowledge-medium/pr-preview/pr-1899/chunks/ui-C6IUx_eZ.js\":\"31468c5f162a3410\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-async-KolfQSRg.js\":\"1536c52324bb822c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-jj9ouo2A.js\":\"026bb57fad7ed299\",\"/knowledge-medium/pr-preview/pr-1899/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1899/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/src/App.js\":\"631e22af6c82920d\",\"/knowledge-medium/pr-preview/pr-1899/src/appUpdate.js\":\"dd6dfd7a1e80a8a4\",\"/knowledge-medium/pr-preview/pr-1899/src/appVersion.js\":\"5d06aefc3784c314\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/initialLayout.js\":\"5e8d2ce468030f98\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/openWorkspaceData.js\":\"6b70fc1c0fa2b4ef\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/resolveWorkspace.js\":\"2ec73d92bfa89430\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/workspaceBootstrap.js\":\"3b81694062c73c83\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockComponent.js\":\"5b50e7eb5c0656dc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockCrumbs.js\":\"b9df824e7b3042cd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockEditor.js\":\"81fe435a49952024\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockLoadingPlaceholder.js\":\"e941d8c1cbb20744\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockProperties.js\":\"b5165822639a0e63\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockSearchPicker.js\":\"e7342133b7dacb99\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ConfirmBulkDeleteDialog.js\":\"4f3794bd6c02d967\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DividerHandle.js\":\"fdbdc70a46be69ff\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DraftEditor.js\":\"b94d7fe497c31302\",\"/knowledge-medium/pr-preview/pr-1899/src/components/GutterPill.js\":\"a412199812d5e65c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Header.js\":\"34c338e62b5789c1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/LazyBlockComponent.js\":\"e2e6000197dd521f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Login.js\":\"e7487e3cd5cb6044\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ZoomableSurface.js\":\"240c883715ab5dae\",\"/knowledge-medium/pr-preview/pr-1899/src/components/editModeKeepalive.js\":\"3714dc808e453ca7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyDisplay/PropertyDisplayScope.js\":\"03238443057aa532\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"2fa7d8785b0a860b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefPropertyEditor.js\":\"e4c4c2d52eb3e983\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefTargetTypePicker.js\":\"a114b9bdff6b71f7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/SelectPropertyEditor.js\":\"e08abfe2196d8082\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/TypesPropertyEditor.js\":\"3ef857d268d15012\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/defaults.js\":\"e8b7c8208192d09d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/kernelValuePresets.js\":\"7c68ba7cf5397107\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/selectablePresets.js\":\"8d73610d35e433c6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/typesPropertyUi.js\":\"2b99686d92c03786\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/AddPropertyForm.js\":\"1fe3e52679ecfbe5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyPicker.js\":\"66f24f2467a16c01\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyRow.js\":\"170996b43dcc43ac\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/Rows.js\":\"977ab1cd6ab1e9de\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/actions.js\":\"55e495fa3f6313ee\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/declarationOnly.js\":\"6fba6f43e30c417a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/layout.js\":\"9691cbacdc3eff9c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/model.js\":\"6cfaee47d615172e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapeUi.js\":\"f878783190505467\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapes.js\":\"221765dac83003f5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/usePropertyEditingActivation.js\":\"47c193e65808b8a7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/visibility.js\":\"2873533976adf6be\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanelSections.js\":\"cc308259cdfa149d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockEmbed.js\":\"652b4fd371d9b829\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockLink.js\":\"13efc85d4cf238d9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockRef.js\":\"72139b2455f4fa82\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/CompactReferenceLink.js\":\"ccc26cbd99a2c850\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/ReferenceLink.js\":\"4c4106699155b2ca\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuard.js\":\"87273fd0e8233e5d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuardContext.js\":\"85c3065253c876b7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/linkInteraction.js\":\"26826f7b07b44753\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/referenceLayout.js\":\"8d501664c728df33\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/useBlockRefAncestors.js\":\"d75f799aa7c83949\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockGutter.js\":\"bb5994b67af00c10\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockInfoDialog.js\":\"cf2c8587b71699ac\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockReadText.js\":\"0c62808862f0bc9f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockTypeBlockRenderer.js\":\"8357475f3c95680c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BulletHoverCard.js\":\"59a1af43c1b5c92b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorContentRenderer.js\":\"4756d78647308441\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"73c3346c9c9f6735\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ColumnResizeHandles.js\":\"02a51a579cb0e66a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"6dd730f0f631a96a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/DefaultBlockRenderer.js\":\"0517b953eca4ce26\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/LayoutRenderer.js\":\"e467f4349ca822b7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MarkdownContentRenderer.js\":\"3c95ec3cfbd5a27d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MissingDataRenderer.js\":\"cbb605c39859ff5a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PanelRenderer.js\":\"821f7129bd81bc33\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PropertySchemaBlockRenderer.js\":\"2873314a2342f4a2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/TopLevelRenderer.js\":\"9a57597ffc11e3f5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockGutterMode.js\":\"0a2f4deb597a7990\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockTitleText.js\":\"b606af0221ef69cd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/fieldCreationKeydown.js\":\"c0245a4a08cf562d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/layoutRootContext.js\":\"32c1c154d60c53c2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/TypeChip.js\":\"ace78c8e893530a2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/chipStyle.js\":\"83a5129b0fd626ea\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/anchored-floating.js\":\"ba0ed737dc5d7dd5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/button.js\":\"203bb65a91ef8e00\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/card.js\":\"411f13550643982c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/checkbox.js\":\"e1a09488479d5c05\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/collapsible.js\":\"64734815ed22f146\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/command.js\":\"cea2cb2b523f5cf5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/context-menu.js\":\"1103adeecd0be250\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dialog.js\":\"7da09c2a82dabb56\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dropdown-menu.js\":\"4553657050eb1d55\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/floating-listbox.js\":\"1787831ae28c0905\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/index.js\":\"cf0df8d9d8e8e44f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/input.js\":\"d92d126dcdded01a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/kbd.js\":\"4f3983bd80d9b025\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/label.js\":\"2351350e6b2c372e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/textarea.js\":\"fc368af946e46b31\",\"/knowledge-medium/pr-preview/pr-1899/src/components/useEditModeYieldKeepalive.js\":\"b37a31618c79456d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/BootFallback.js\":\"6a19a591102cfa21\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/FocusedRowLazyMount.js\":\"b2110bd89c05723f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LazyViewportMount.js\":\"d8c9bc1df1f5c860\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LocalDbCorruptionFallback.js\":\"ba3ef8ca5edabfc2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/error.js\":\"43358b306420a82c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/lazyMountRegistry.js\":\"c409bd384d39108a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/suspense.js\":\"3cb7acd0a00c3754\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/CreateWorkspaceDialog.js\":\"8f95a488db653783\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/PendingInvitations.js\":\"f7fbfe387ca1ed4b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/SyncProgress.js\":\"247eee5165392f1e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/UnlockProgress.js\":\"4726396cab994caf\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceKeyGate.js\":\"8a402f7ccbe5b07a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSettingsDialog.js\":\"a44c3caea75dea89\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSwitcher.js\":\"090a8fbecc2d140e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSyncGate.js\":\"f106b377d458f60e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlow.js\":\"4c46c899fd13039a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlowHost.js\":\"dedd7da1b99292d6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/EncryptionSection.js\":\"0ee85aac0ca6ab70\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/attachmentPrompts.js\":\"04f4f69e19c87aa2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ada8aa4948c966af\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowDeps.js\":\"5ac06bcbeb62a5e0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowStore.js\":\"c1db052cc88f3d53\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/flowUi.js\":\"2cd4df3bbd297cfb\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/useConversionRun.js\":\"e25de83fca1717a2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/keyUi.js\":\"d29fb7c40b075dc7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnKeyLoss.js\":\"d5d04fdc0182544d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnServerE2ee.js\":\"9a343dd76e6e9a20\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/workspaceUnlocked.js\":\"402d73395d943e3a\",\"/knowledge-medium/pr-preview/pr-1899/src/context/backgroundSubtree.js\":\"c878db466014a685\",\"/knowledge-medium/pr-preview/pr-1899/src/context/block.js\":\"6cc9dc24667d26fd\",\"/knowledge-medium/pr-preview/pr-1899/src/context/layoutWsContext.js\":\"4c79cec2169be3b2\",\"/knowledge-medium/pr-preview/pr-1899/src/context/propertyDisplay.js\":\"27ef5d0599515439\",\"/knowledge-medium/pr-preview/pr-1899/src/context/repo.js\":\"c283568108a332ac\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasClaim.js\":\"03eefd1b706359f3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasSeatNamespace.js\":\"61bb52df3a656ae2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockData.js\":\"d309f4390e06b741\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockType.js\":\"8ec20e8f119a3cdc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/changeScope.js\":\"c38fc1ba5e08df1d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/codecs.js\":\"82c0cdcc30a27765\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/derivedData.js\":\"01477781ff5f64e6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/errors.js\":\"0f703bde25a01e57\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/events.js\":\"948201d700eba45d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/handle.js\":\"cca00410306af88d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/index.js\":\"3d55109b19c85e98\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/mutator.js\":\"6a1a49abfd80532b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/processor.js\":\"bb9db6cea577fd1a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/propertySchema.js\":\"278815127d551ec7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/query.js\":\"37c6d58a25341a33\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/sameTxProcessor.js\":\"3242c57091e33315\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/schema.js\":\"cca00410306af88d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/tx.js\":\"cca00410306af88d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/typedBlockQuery.js\":\"7a4465687038a4c7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/user.js\":\"5cd7b9057c9506a6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresetCore.js\":\"ff4c9cf21a2326e9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresets.js\":\"59d7f124a4fcf1fb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/attachmentCleanerIOVerb.js\":\"0211d8cca0eea346\",\"/knowledge-medium/pr-preview/pr-1899/src/data/block.js\":\"9c00b9e719f08e4e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockCache.js\":\"3868a84c57dd898f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockId.js\":\"3e71e748d40b5c56\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockLiveness.js\":\"1e6387311a1f9eaa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockMerge.js\":\"6d2618a58f3c6afa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockSchema.js\":\"3c86cc775027eaaa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypeLookup.js\":\"5f0010cd58899532\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypes.js\":\"dd8de4810c38fd85\",\"/knowledge-medium/pr-preview/pr-1899/src/data/childrenView.js\":\"d3266dc1ad4b3efe\",\"/knowledge-medium/pr-preview/pr-1899/src/data/clientContext.js\":\"80443c1fd786e8fd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/dbFileSiblings.js\":\"80895b4f1d0dc90c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/definitionSeeds.js\":\"b2fc9850e254aa59\",\"/knowledge-medium/pr-preview/pr-1899/src/data/derivedIds.js\":\"c46ad69db53b79cd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/drawnSubtree.js\":\"de963d93ed6880da\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facetBridge.js\":\"1c64f67f9b6fd777\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facets.js\":\"f593254d5cc6cdc0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/globalState.js\":\"7d8ff362b3c435b8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/aliasClaimRederiveProcessor.js\":\"15540558298dd90e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/ancestorBatch.js\":\"07a0e20ecab378c1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/blockTypeTypeifyProcessor.js\":\"00f4cf53daf6774c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/clientSchema.js\":\"407f47b9e7078ecf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/commitPipeline.js\":\"64023cdc4f0d40bf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/devAssertions.js\":\"da67e834471229ac\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/firstSync.js\":\"b1858eef2f673e70\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/freshInitialLoad.js\":\"1f2eee67889f686f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/graphBackfillClaim.js\":\"d351fd3b2be78a29\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/handleStore.js\":\"210edc108541e9c2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/idleMarkerJobs.js\":\"a022216b4f9ac6ff\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initialDownload.js\":\"47007b5a481906bd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initializeClientDatabase.js\":\"733540055de6eef7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/jsonCanonical.js\":\"189b8a16043468bb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelInvalidation.js\":\"0cfb99f848bc701c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelProcessors.js\":\"419b9633a7eb45da\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelQueries.js\":\"0a2fe5b41672fac2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/mergeTypeMembershipProcessor.js\":\"e34f9686702c255d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/normalizeReferencesProcessor.js\":\"8890bb27e7ed2e5f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/poolInstrumentation.js\":\"97d49ef00c14d60b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/processorRunner.js\":\"0457a33e56db3cba\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyCellBackfill.js\":\"dc0aaaf8060c09ca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildMint.js\":\"068874bc55c65ba0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildrenProcessor.js\":\"44e5eda786682384\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4d2d0d760a49e6a3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionSynthesis.js\":\"097a6dde6b0344a7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyKeyScan.js\":\"9a79faf5bb611bd9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertySchemaResolution.js\":\"a7b6b142d3b77b2f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyValueEdits.js\":\"cca5fa0b9c7c39ba\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/raiseProtocol.js\":\"0535523183672eb0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/readBatch.js\":\"e4885bb4a3eb6704\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/refProjection.js\":\"71e4df9c26e1a2b7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetLookups.js\":\"0fbcef67018f3991\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetProcessor.js\":\"e15201a9e07121ac\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/replayMerge.js\":\"4f95cd7b27303d8b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/sqlBinds.js\":\"8d3c9c2622f7e035\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"d16e50ff74dff6b4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/arrivalProcessors.js\":\"a8c73c2ec646a617\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/invalidate.js\":\"8da8a2664c6a6e25\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/materialize.js\":\"afa012d2cc5ab687\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/observer.js\":\"7d64a2113e47adf4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/reconcile.js\":\"b5b3b7fe8c1d9806\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/timingMetrics.js\":\"caa2f4073ca6ebb0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/treeQueries.js\":\"0f2736eafeebdd92\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txEngine.js\":\"4010087a43a52bd3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txSnapshots.js\":\"4bb5e3b415a6f75a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/typedBlockQuery.js\":\"694f3b2f7d5e6b66\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/undoManager.js\":\"c2b5d5944d20b737\",\"/knowledge-medium/pr-preview/pr-1899/src/data/invalidation.js\":\"4528deaa609aebba\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelDataExtension.js\":\"88b86ac31db165a9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelPage.js\":\"36b4c95573208b1d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelValuePresetCores.js\":\"dab82a29d4029393\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbCorruptionSignal.js\":\"f43e3ff38512ea36\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbStorage.js\":\"57276e0746d1b062\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbVfs.js\":\"47edbb8bcbad6d36\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localSchema.js\":\"309156d3c67a23c4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/maintenance.js\":\"6ec161bd878fe692\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mergeProperties.js\":\"efae7b97ae2553f0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/metricsConsoleHook.js\":\"679a6c969f4ceb2a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/migrationsPage.js\":\"b60f19bf6c70bdc4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mutators.js\":\"9ddb35254488733b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKey.js\":\"47591961b4e640ef\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKeyPlacement.js\":\"b32e68e3a37625c9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/outlineSurface.js\":\"8490e65252c49fe9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingEditorContent.js\":\"c6eae0026c129430\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingUploadsSql.js\":\"d716ca09d07caaeb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pluginStateExtensions.js\":\"dbc4061fd1a69bac\",\"/knowledge-medium/pr-preview/pr-1899/src/data/powerSyncLogger.js\":\"b4968705a22a3e82\",\"/knowledge-medium/pr-preview/pr-1899/src/data/projectorRuntime.js\":\"199fc478da6eb9b0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/properties.js\":\"36e76d1c17d86a19\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertiesPage.js\":\"e4b80bfda281fff7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyChildren.js\":\"acb61c5876844ad9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionFanout.js\":\"7988f422c7dc65da\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionMetadata.js\":\"641003317b639b42\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionRegistry.js\":\"55a6675db5e921b6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDisplayMode.js\":\"e337990d1ccbcf9e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyRowCreation.js\":\"293d2d74372c59d7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySchemaCreation.js\":\"77ca9ef664aec57f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySeeds.js\":\"8434d44a32724f6f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/recentsPage.js\":\"d064858a118f0ec3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/refTargetComparableProperty.js\":\"53122d1f0741c40e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/referenceBlock.js\":\"4072ebe0c55bb33a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rejectedUploads.js\":\"54f1b80307bfd290\",\"/knowledge-medium/pr-preview/pr-1899/src/data/releasePowerSyncConnection.js\":\"88952bfb45d47548\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repo.js\":\"a04172504f0e05a8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repoProvider.js\":\"164e8109b77f6ee9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rowProperty.js\":\"e226bc3d19c70f38\",\"/knowledge-medium/pr-preview/pr-1899/src/data/searchFilter.js\":\"0485b4ed537e49eb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/seedIdentityLedger.js\":\"094271280164e960\",\"/knowledge-medium/pr-preview/pr-1899/src/data/stateBlocks.js\":\"1e88c134a1544411\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralEditPolicy.js\":\"22807cc4751e0cd9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralInsert.js\":\"d2417d5104331940\",\"/knowledge-medium/pr-preview/pr-1899/src/data/subtreeDelete.js\":\"d3688f532a70af0b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncStreamLock.js\":\"17d0b33bceb835ca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableSqlRecognizer.js\":\"5f81fb193b02dc73\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableWriteGuard.js\":\"290b3f8f00d23461\",\"/knowledge-medium/pr-preview/pr-1899/src/data/targets.js\":\"b32ac1cf6f916c59\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeColors.js\":\"f83546c8e819cf0e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionMetadata.js\":\"4ebf311d8452342d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionRegistry.js\":\"5286e0e0f1fbabf9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeExtraction.js\":\"e48fe88046c8293c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeInitialValues.js\":\"0de573dc09006891\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typePropertyGroups.js\":\"50df0d8213343e1d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeSeeds.js\":\"2364664525fafe21\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeTagger.js\":\"58246aa8c8bf750f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typedRecords.js\":\"f9aaba40cbfe8d94\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typesPage.js\":\"aad2206b2fd15e9d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userPrefs.js\":\"8595bb3048e9180b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userSchemasService.js\":\"4fd4d942bf3c65bc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userTypesService.js\":\"8581129aa36014f6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/valuePresetRegistry.js\":\"267a6e3b01acacad\",\"/knowledge-medium/pr-preview/pr-1899/src/data/visibleChildren.js\":\"ac0a5d90a3d81b66\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceConversion.js\":\"dd9fbb3652de012a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceFirstSync.js\":\"5b16a37eaec902fd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceIdNamespace.js\":\"c34985e54b4b3063\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceSchema.js\":\"11813b622390d6cb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaces.js\":\"ed990fa0eeab9880\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadLog.js\":\"c899884214677c77\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/BlockPasteShellDecorator.js\":\"48afea74ee8adfc6\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/atTrigger.js\":\"b10f4bb69bdb91f1\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/autocomplete.js\":\"778adf97ae44cfea\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/codeMirrorExtensions.js\":\"7db2acd790b9b3f4\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/contentFlush.js\":\"6068b45fd9ceaf20\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/defaultInteractions.js\":\"ce06046f679a19e4\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/editSettleSignal.js\":\"8c66186068e03248\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/insertImage.js\":\"06dfff7e0fe1068b\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceCompletionRange.js\":\"a569cc8868d2518f\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceTargetTypes.js\":\"2a2ac28e3134230c\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/syntaxContext.js\":\"3e37e6145f38c8d8\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/triggerMatch.js\":\"14a58f1f3bf990d9\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/AppRuntimeProvider.js\":\"c7b7dd7dc5c49f06\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/BlockFocusShellDecorator.js\":\"144b110db5a3cffd\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/ExtensionRenderBoundary.js\":\"7d9c0a0899b6534a\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/PanelContentRecovery.js\":\"3fa5ee1faa14d11b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/apiCatalog.js\":\"5323a99e7653248d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/approveExtensionHere.js\":\"3ee35c77448e9c41\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/armedCutAppMount.js\":\"3c381b976d624874\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/batchableKeyedStore.js\":\"64a70f7ba27f980f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockInteraction.js\":\"cf7117769ac7109d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockSelectionAction.js\":\"80732d242149e881\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compileExtensionModule.js\":\"488255915421973f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compiledModuleCache.js\":\"3f8becedf35db5da\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/continuousGestures.js\":\"c65fde3d2f68accf\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/core.js\":\"9dd73519ca4d1b84\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/defaultRenderers.js\":\"45c78a2bd215f7d3\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/definitionFanoutAppMount.js\":\"63577b20a32732dc\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dialogAppMount.js\":\"d5d454d125a63965\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensionSeeds.js\":\"ab38a45dfbc5fdba\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensions.js\":\"7cb68a46239442d4\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/exampleExtensions.js\":\"14df675c8e90b46c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionApprovalStatus.js\":\"cff3dd39718166b6\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrorToast.js\":\"e501efdec2995574\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrors.js\":\"bdc99f7e68877221\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLookup.js\":\"78dadad9c4c17452\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionToggles.js\":\"5f5666a2f5199c3b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionUtilitiesCss.js\":\"b5ba8f5d785156ee\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/kernelPageDeletionGuard.js\":\"ed7dcd5edcd67227\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/liveRuntime.js\":\"4ef82e8a10167e18\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/openExtensionsSettings.js\":\"be0847a5db1d3990\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/overridesCache.js\":\"37fa16ab7c2eede9\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/pluginIds.js\":\"5401c6e8e25b2fbd\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/processorRejectionToast.js\":\"9cd432e7048e15ad\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeActions.js\":\"6c624eaef3f79340\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeContext.js\":\"2ea83eae54193c7f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticAppExtensions.js\":\"641687e4b0e561d7\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticDataExtensions.js\":\"46258d8d32b24a67\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/toastAppMount.js\":\"84e9a8cfcba3da6f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useOverrides.js\":\"dc6cdf0771477889\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useShortcutSurfaceActivations.js\":\"56461e6fd252bdb1\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/discoverToggleTree.js\":\"bd949c2f04ea65cd\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/facet.js\":\"b82f9c19f7247057\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/resolveAppRuntime.js\":\"635a22d68ae9dc7c\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/runtimeEvents.js\":\"8a9ccf2f3616b666\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/togglable.js\":\"e6cc58a3e6fa56df\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/variantFacet.js\":\"6873478ce568d158\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/verbFacet.js\":\"84c8126f82a187df\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/block.js\":\"599b47a24834082e\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/focusedChild.js\":\"fcf4d5696381ecb3\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/propertySchemas.js\":\"4c58b1706d8942d9\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/typeRegistry.js\":\"08007d4e1601b8df\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAncestorCrumbs.js\":\"e4e2891c35660734\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAutocompleteListbox.js\":\"dbfc5849d7b9ce9b\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedSearch.js\":\"7c754adef749bb61\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedValue.js\":\"499f4240b5501cda\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useFacetValue.js\":\"9aaba1966e134ccd\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsFocalRender.js\":\"146ff969d980ca9a\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsReadOnly.js\":\"22b449a87740d37c\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMaterializeBacklog.js\":\"578efd1a56510c51\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMinuteClock.js\":\"c338538b129148f3\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePanelLayoutProjection.js\":\"349c05fc5fc1a7cb\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePendingInvitations.js\":\"81be37599f0772c1\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRendererRegistry.js\":\"53cc144c4409f99d\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRetainedFieldRows.js\":\"f345b101a028fe15\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useWorkspaces.js\":\"a022f5f31daf1b59\",\"/knowledge-medium/pr-preview/pr-1899/src/lib/utils.js\":\"f18d52f7c087dcfb\",\"/knowledge-medium/pr-preview/pr-1899/src/main.js\":\"c80e76896fc0f2d6\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/MarkdownImage.js\":\"878a7933186bbbcd\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/blockSeparators.js\":\"4f387570dd31aff8\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/context.js\":\"9a259d185c2609c4\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/defaultMarkdownExtension.js\":\"75f1247f22d2815a\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/extensions.js\":\"949944fdc07d5e5f\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/renderMarkdownHtml.js\":\"2db7ec68c4a99c2b\",\"/knowledge-medium/pr-preview/pr-1899/src/minimal-editor.js\":\"89046030ac3e97ce\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/armedCut.js\":\"91b5a96ba83f534a\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/captureMediaVerb.js\":\"1b6027e91fdb9c7a\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/clipboard.js\":\"77eb888179f21f6d\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/decision.js\":\"d67f56dacc524ae4\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/operations.js\":\"77ecc7af42876489\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/AccountHeaderItem.js\":\"433bec46315c78e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/index.js\":\"7f57e376af545fc6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"c05b47a35d3b32a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askAgent.js\":\"5f454a50d529ad46\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askedStore.js\":\"0f88389834be6836\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"c148d7183a189d45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/chipState.js\":\"3e7c9051ff0d776d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/dataExtension.js\":\"d4296d62ae9ad3f0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/index.js\":\"093c4282f8ce6953\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d3e6334da5235934\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/schema.js\":\"76f614f5a043ded6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/AgentTokensDialog.js\":\"fa394cfef7fdc1ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c7e84522851faef5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/addMedia.js\":\"0520ece5a3743944\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/backlinks.js\":\"db7d7f63c44ad51f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/block.js\":\"ea06a46aa3093ee7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/context.js\":\"e9f33eb9ffbf37a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/displayIds.js\":\"908cfe08257e23a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/index.js\":\"bf62e5f74b6d9c15\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/outline.js\":\"2e94e7c681889d49\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/properties.js\":\"211cf217be954348\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/refs.js\":\"55579dae2b8f2ece\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"96cd0251b7167c79\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/search.js\":\"f5713bec6263f271\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/shared.js\":\"8bea26277c2f725d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"b53733757f44cb38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/text.js\":\"80ba5f332ecd99ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentWrites.js\":\"c9dc1edfac298139\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/authoringCatalog.js\":\"76d7af553e5f4e0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/blockRefTargets.js\":\"64cd9f8de81e3cf5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridge.js\":\"84b196e143e1bf4e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridgeLoop.js\":\"2cb502e7373a993b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/changeHistory.js\":\"bc9d3235a2e34c7f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commands.js\":\"7e7ba3cfc5e801ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commentsCommands.js\":\"ab2a2513e9f12540\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataExtension.js\":\"5d7f65eb104d84ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataModelGuide.js\":\"1456308374eeb100\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dayPropertyInputs.js\":\"440e23eab48fa11c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/describeRuntime.js\":\"1eb4225506843ea0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/extensionLint.js\":\"ea7a23e6ab31905f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/grainAudit.js\":\"80f250f7187ee259\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/healthCommand.js\":\"961961149ca908d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/index.js\":\"1c103974419f75f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/presetIdentity.js\":\"3b4950ebcf011c00\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"203a34bb9283b995\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/readMedia.js\":\"e149c03436e85986\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/schema.js\":\"d76fd149810b58b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/serialization.js\":\"b7a41766eb843810\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/targets.js\":\"183f0245b256e595\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/tokens.js\":\"c0661e843b2f8e0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/watchEvents.js\":\"bb56799428885487\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/workspaceGuard.js\":\"6028aee3289b69f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/writeCommands.js\":\"f206ff09c5ae1f95\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/AliasCollisionToast.js\":\"ef58a6c3c87f051a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/DuplicateNameBanner.js\":\"1037c07c0be299ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/collisionMerge.js\":\"265ca83365f340c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/dataExtension.js\":\"d055e381b7868227\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/index.js\":\"cfb0218d58acfe8c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/mergeCollisionAction.js\":\"49b1deeb48eef1f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/pageStyling.js\":\"05791a4e06606675\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/rejectionToast.js\":\"993a70c4989345e8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/syncProcessor.js\":\"91dbb32ecfe96152\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/actions.js\":\"9e3e0ef3ad91f8cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/addComment.js\":\"bc7b68cfb8ee1e29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchor.js\":\"f33cdc5c0b84680d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchorState.js\":\"c4c14bc8b8a2f6cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/commentLinks.js\":\"8480655d803c4045\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/confirmThreadDeletion.js\":\"08e2b69779892e97\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/container.js\":\"b7ffa0cb9a389816\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/dataExtension.js\":\"a95e3a8c6ccbdef3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/deleteComment.js\":\"1af50c215b2d342c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/highlights.js\":\"7f137f83576bea7e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/index.js\":\"9bb06c37d7147232\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/linkedCommentsPill.js\":\"272ad62925db327e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/margin.js\":\"8cad086e1bb824a3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginAnchorLinks.js\":\"c16f9fa1d42856d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginSchema.js\":\"9072342271a864b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/newComment.js\":\"af01037ae75fb9e3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ownThreadPicker.js\":\"67717c89a56138e8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/placement.js\":\"6d4388c7d0dce87b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/queries.js\":\"9a8f1e274b3fe330\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotePosition.js\":\"f971da5258b96585\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedIn.js\":\"773861ad01fa90ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedRange.js\":\"8cfd12645b339d01\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/rangeRefs.js\":\"cb4d7e82ca83fa43\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readHighlights.js\":\"aaf7b1f050c42a10\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelection.js\":\"438c35c48374e041\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelectionUi.js\":\"2387fe2a4337ed47\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/reanchor.js\":\"6245e0d8b49b7101\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/schema.js\":\"950fcd884acef8fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scope.js\":\"b268a0e6f1d8dbb9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scopeThreads.js\":\"d31b2c2edf9e74da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/splitRetarget.js\":\"39a6bb722a318f2e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestionCard.js\":\"d3012bc4ba00ade8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestions.js\":\"0e5970517203588e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaries.js\":\"2182948feb9b9b90\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaryBatch.js\":\"3e63d06757ddc167\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/surface.js\":\"c06a4a00a9e15bf1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threadNavigation.js\":\"60ca51c679af6edf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threads.js\":\"ab6b084878a4acff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ui.js\":\"7ab9a2a0b1bf5937\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/uiStore.js\":\"30b3ccdbd58d52bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/appIntents.js\":\"40fc6b36a4799590\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/index.js\":\"8ececf43303cbd11\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/index.js\":\"9b5f6204f833c001\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/status.js\":\"63beeb9f0a6cbea4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"ae21927aa32aea38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaBlockRenderer.js\":\"9ce687359c204c31\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1eb4a227f6ffbfb9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaUploadReconciler.js\":\"55ad20535382129c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetDownLane.js\":\"343bd8393cfd6c6f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetResolver.js\":\"deac53a3cfb28bb3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetUpload.js\":\"2800c515ad606917\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/attachmentCleanerIO.js\":\"45614f9700669931\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b50af1c36bd7f8ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/blobStore.js\":\"868381da2bcda8b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/browserMedia.js\":\"6fe02dac6d3b1987\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/byteStore.js\":\"178117a484996927\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanerIO.js\":\"cad677935dcc042b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanupAttachments.js\":\"bd73aa592c63d437\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/dataExtension.js\":\"dc64325347bbc31d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/downLane.js\":\"03d93173abf60530\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/index.js\":\"d2ea70070d5b7cfe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/insertImageContribution.js\":\"a7291a58f0f1dbf2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneArming.js\":\"95dd0ef28d9439bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneLock.js\":\"0248d27b4e2ef4da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaBlock.js\":\"74591388639878f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaCapture.js\":\"efba6611c3f4130b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaLanes.js\":\"40accacca60c702a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewers.js\":\"d414ff1703be3cbc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewersFacet.js\":\"0e3b5035f568f15e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/pasteCapture.js\":\"985e6ba597c4c4e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/resolver.js\":\"c0b598db19f9234f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/retryUploadsAction.js\":\"576405e1248bf0f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/storagePaths.js\":\"df2f3cc9d5521e7c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadDrain.js\":\"cc50fc5f8f569fcd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadLaneStatus.js\":\"9a3fe8b4e1243d32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadReconcile.js\":\"8d9279c223b8d346\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadRecovery.js\":\"858f2dcfcd057cc4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadStore.js\":\"2c3a07dc1cb64c6b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/useAssetObjectUrl.js\":\"dd7fec07cf4ec42f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0d3e82f15ca75a53\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksViewSection.js\":\"df39c9cbaa8e2cd3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/facet.js\":\"1a30371e7de398f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/index.js\":\"701709f2f5e951fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/prop.js\":\"8dc144e830b031c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinkFilters.js\":\"67f3d4f58744bf07\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d728ae30312bcd88\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BlockEntry.js\":\"077db8328fe1e39d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/LinkedReferences.js\":\"c069e14f56e4fbb4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"3e2548f2b6eb73ce\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dailyNoteDefaults.js\":\"97fbd86f1c8c2ccc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dataExtension.js\":\"18d36413cb0e8352\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/edgeExclusions.js\":\"e286d71d098d0265\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/filterProperty.js\":\"b85d8981478b363f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/index.js\":\"16b0b788b57c41f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"53bc7928f26f4451\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/applies.js\":\"257411f43d00dab9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/countQuery.js\":\"54b394492c4c1d92\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/expansionStore.js\":\"0f825a616af8b97f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/index.js\":\"b0c642b83f2d62a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f5269a43a03db3b2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/presentationInvalidation.js\":\"a24d71a7a18d95a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyEditorOverride.js\":\"95ecf1695d64c0e8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyFilter.js\":\"a250a7f378cca09f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/query.js\":\"225d15d4863cedfe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/resolveFilter.js\":\"7dea7dfe81c2c766\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sourceBatch.js\":\"2db965188e0a8c94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sources.js\":\"49c231dbf4e8262a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useBacklinks.js\":\"7b1e804e7f984fc8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"fe835c6d299d8201\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayCelebration.js\":\"530f2963a322713f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayOverlay.js\":\"d4ea14d8fdcdd127\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/gate.js\":\"08a96df4119a70f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/index.js\":\"118706eb6c9a216d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/wolfTheme.js\":\"c9611c283118031b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/BlockDragLayer.js\":\"dc529fd2c45e5971\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dragController.js\":\"afc36c7dd9d698ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dropTarget.js\":\"94402afb7c8dcda9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/index.js\":\"284e89675fae4ebe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/projection.js\":\"3fa21f278b7c7dfa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/BlockMetaCard.js\":\"df3727814f036e92\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/index.js\":\"6ce679f5743bcc14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/AddTagDialog.js\":\"31060d41f8752fd4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4af451a27fc71d8e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/TagNameIssueHint.js\":\"515b66058d5a45a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/addTagAction.js\":\"1193dc641df286c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/appendTag.js\":\"76a6a48e2c91955d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/config.js\":\"141b04d19f4d7dba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/dataExtension.js\":\"0fb507ab79bc7eb9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/index.js\":\"101cbd3ebe924e5d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/propertyEditorOverride.js\":\"600a3b3239fa3262\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbList.js\":\"715ff39c5844f27c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"5505b7c6d8eafa25\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e5c6aba5c19b4e46\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"345374e5dad36305\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"3d8cacbdaf0943c7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/index.js\":\"1c0ccf21d6a62bf6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"cd921d79ab7bd897\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/CharacterCountItem.js\":\"c6237fcc77c402eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/ProfilePropertyEditor.js\":\"35544e1f89b15870\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/actions.js\":\"1abe062f0a5bd040\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/blockType.js\":\"c9a16f340fb8395c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/charCount.js\":\"2901bf7730039e1f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/dataExtension.js\":\"e7416918bc2ddc08\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/index.js\":\"fd9e6563436a2d6b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/profiles.js\":\"4c0a71686824d9e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/properties.js\":\"f780d4386924933d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/subtree.js\":\"2d13243981040d06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/textCounts.js\":\"a10227e695b62837\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/colemak-keybindings/index.js\":\"a182452b738f9e03\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/CommandPalette.js\":\"5373f69eb1fac77d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/HeaderItem.js\":\"e5a50a668e18c0b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/context.js\":\"c66855a60a7841f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/index.js\":\"dd7dd0125365727b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/selection.js\":\"37f9b3cc541f64ad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/toggleStore.js\":\"dde88d40da3a4a38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/useCommandPaletteActions.js\":\"f4b03d7de1a004c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ContributorBadges.js\":\"484195324863e4e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ProfilePicture.js\":\"ae7f5c27169cfaf7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/author.js\":\"fc21dd8d0f7fdd51\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/codeMirrorExtensions.js\":\"fdaf9212f3fe9f71\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/dataExtension.js\":\"d5e6ae9d62b4182f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/index.js\":\"2d7f0a057f24329e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/mentionAutocomplete.js\":\"29c2a7ea50b39b24\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/processor.js\":\"9bcc57305fb610d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/profiles.js\":\"7391850b38582b85\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/queries.js\":\"a100088a64aeab88\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/schema.js\":\"266c5e18b9a08b13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/useCommentAuthor.js\":\"b2ab992736493e7d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"501b0eac8d6f35fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/followOrigin.js\":\"11396b22ec36dc73\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/index.js\":\"1bcd969e6781add7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"67782dd8b6745b4d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"514cd1e48b4555af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/CalendarGrid.js\":\"8462110a401ee33f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DailyNotePicker.js\":\"bfae96ba86de07f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"923bc6010bf0b4c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateNavDecorator.js\":\"a0f03ba2fbc69e30\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateScrubOverlay.js\":\"232ca8431715864d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayPropertyControl.js\":\"f54fccb30640db1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayValueReferenceControl.js\":\"3cb6e98b49351e09\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/HeaderItem.js\":\"4479852f3aaa1c06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/ReschedulePicker.js\":\"6db32574d16891b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/SpreadDatesDialog.js\":\"fcbe5337532d50e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/actions.js\":\"b47d17fd0486a1d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/blockDateAdapter.js\":\"7c6840cf4749a47d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/calendar.js\":\"e9f7369306240520\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dailyNotes.js\":\"88bee8acff2ae6bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dataExtension.js\":\"8b14764813bcc204\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubActions.js\":\"99ff2574460aa522\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGesture.js\":\"4c2845beda40d9de\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c56c096251808147\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b7a97bfa6589f8db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayProperty.js\":\"d6408aed45c18e5d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"657c0bb35e1bb7e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/deletionGuard.js\":\"6d1215fab463c0cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dueQuery.js\":\"a5913cfe37bb437d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/index.js\":\"018bae793c32a1ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/landing.js\":\"8c8dbe62145ded86\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/localSchema.js\":\"36dc2b811215bba7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/referenceDateAdapter.js\":\"b076b79ddedb531c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/rescheduleAction.js\":\"3ae09cd72366a243\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/schema.js\":\"57ca83beac295aa2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadBlockDates.js\":\"92691a45b9dddba6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadDatesAction.js\":\"e21fb67c493231f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/today.js\":\"976d06ddd310f35a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"054ab26fe856a97b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e30b47b001196ff9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/audit.js\":\"92c426845a660efa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditAction.js\":\"5bbd155f8beb674b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditRanges.js\":\"119c09e3ac518520\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/diagnosticsSource.js\":\"f68f03a9275a1326\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/divergenceScan.js\":\"be91a2bf6bc615a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/index.js\":\"7b0a0957a93d48c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/propertyChildrenChecks.js\":\"93b34853d287fcc0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/referencesMirror.js\":\"dbe63225b2a9a1db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/rowJson.js\":\"7b436be543f61a3d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/schedule.js\":\"cc27c7163863871f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/store.js\":\"aab3a80f25eb76be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/action.js\":\"74aa9dc7f70b56ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/index.js\":\"62d996e909b5c004\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/plugin.js\":\"87d898d8a345d8b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f3f81b06f802b328\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/actions.js\":\"6c7dc4a80f7a65ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/changeMarker.js\":\"ba8ebbc2a4612f9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/diagnostics.js\":\"0f632d950128cda3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/fileSystemAccess.js\":\"7b26aaab67c7f698\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/filenames.js\":\"e2072b37f79bf8f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/index.js\":\"afb1fbaae1b370a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/mirror.js\":\"e778ff5f7dfab771\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runLock.js\":\"2117314c64cdc9cd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runtimeHealth.js\":\"2ef40a76314e4999\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/schedule.js\":\"034a861babceb295\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/store.js\":\"da4ae6e3fe3dabbe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/index.js\":\"a2ce64359cbbaeb3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/themes.js\":\"a66e0989a066672a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/facet.js\":\"9493f977f2f8f250\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/useDiagnostics.js\":\"4c85423039c5c2c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/dismissals.js\":\"05434adcf99fc5f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/index.js\":\"54ff74d60151760c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/status.js\":\"f552ffdd5dd7e060\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/store.js\":\"2767208c470cda3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"00a172369f1401e3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c208d1db1b68fbc1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/actions.js\":\"5b47386a6eccfa35\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/config.js\":\"8250fa5e614e1319\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/dataExtension.js\":\"bf2d82c9adc48f10\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/effect.js\":\"88c441105a498e0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/index.js\":\"f27f66eb5b56e335\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/propertyEditorOverride.js\":\"12eb9826365f71fb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/useToggleTree.js\":\"481386961dd9b095\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/ExtractTypeDialog.js\":\"892871fbc1b83ee7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"6a2ce1ac37616753\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/PropertyShapePicker.js\":\"aa2f9d4049aba6fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/action.js\":\"45e307fe38737087\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/index.js\":\"c72a69c5de861436\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/FindReplaceDialog.js\":\"88f903839078dd5c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/HeaderItem.js\":\"3db87b0e1da00892\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/dataExtension.js\":\"41944f6091b27907\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/index.js\":\"a8c1fb5e9983fccf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/search.js\":\"f3c2320784c9c7b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/toggleStore.js\":\"c38fd01ca08f1125\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/LocationPropertyEditor.js\":\"b49d1ed66bab9731\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/MapView.js\":\"ac22cabeeb87e1c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/blockTypes.js\":\"eb6142d409059d4e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/codeMirrorExtensions.js\":\"608aa890f26227f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/createOrFindPlace.js\":\"2db1da2a9f2c67d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/currentLocation.js\":\"b1e7550b5d7204fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/dataExtension.js\":\"d66ddb4ce428fa0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/geoContentDecorator.js\":\"3fb15364851bfb2c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/googlePlacesClient.js\":\"0a07ff119e67d220\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/index.js\":\"dccc74c45f0d2702\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/locationsPage.js\":\"a0a7da63aedfa81e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/mapViewport.js\":\"4c6738d88d059772\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/pickCurrentLocation.js\":\"a01ac5861e32d831\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeAutocomplete.js\":\"25e7ed9818ade7a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeNameCollision.js\":\"47e2bd0056023f99\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/properties.js\":\"9230f3727f83e04e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/propertyEditorOverrides.js\":\"f655acefba138d0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/query.js\":\"5240947aac37642a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/usePlaceSearch.js\":\"c29a310c7ca5bd02\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a845e9a45d97c652\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"fa878d2af88784ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a1bd45bec6bb33f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/config.js\":\"27439b3a14f02e4f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/dataExtension.js\":\"7831eab54eb0a95d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/facet.js\":\"15cb0b618fd9b96f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/grouping.js\":\"61e003f595f3cb18\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/index.js\":\"4e58864d5b2906d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b36f0f993a0d5d8b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/query.js\":\"5d6f0f551924666d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/resolveConfig.js\":\"517ef8db56bf8650\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"791a9022d8b7640c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c41c9d0d735217ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlDocumentContent.js\":\"e8e0e6edcda85fe5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlFrame.js\":\"74c50db365c8624c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/actions.js\":\"450ba544838e30eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/blockType.js\":\"193f79263169e2ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/confirmRunScripts.js\":\"d9776a05eb11b59e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/dataExtension.js\":\"6024065e5ca38be3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameAnnotations.js\":\"8f9c932b5262485b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameDocument.js\":\"3f84dddb1c0f1ed6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameTheme.js\":\"e924d4ae36d9e6ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/index.js\":\"cbecdf74bce5fbb9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/scriptConsent.js\":\"730418916c4d1fa8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/sourceMap.js\":\"3975af9b47c9940d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/useDocumentScripts.js\":\"c9429cb7edad7122\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/index.js\":\"145c08aa57c1dc05\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/record.js\":\"5d68a7ba8cad3189\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/recordStore.js\":\"a9a358d6dadf86d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/responsiveness.js\":\"835033412f41581a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/schedule.js\":\"2f0a0fcb60000cb9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/sessionContext.js\":\"c60cb49db0aa5fd9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"221a2cd8bd9edadb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"1123a2467332b50e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/actions.js\":\"84b068c703472577\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/config.js\":\"cf7175d2fcbfa90a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/dataExtension.js\":\"207e04f4dbf975ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/effect.js\":\"f98480df6725a0a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/index.js\":\"6cf32b2b23e642bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/keyCapture.js\":\"17ca41f7b487123f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/overrideStore.js\":\"c58545fa50798eb0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"24412d7ea04ed927\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/HeaderItem.js\":\"379f8531a036da69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/LeftSidebar.js\":\"cefe51758395e91b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/actions.js\":\"f65be3e825c9b0e4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/facet.js\":\"1e1d9f5b299921db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/index.js\":\"bce55a68524e563e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/shortcuts.js\":\"5225863d0187794d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/toggleStore.js\":\"e58ccdf196b2b7ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/MergePicker.js\":\"e7f2253b1735f661\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/index.js\":\"a04a7619a6516d9e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/mergeAction.js\":\"0253c5c119c42bf5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/strategy.js\":\"bb745688ed58714f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/Button.js\":\"7cf01a1b4ae6f979\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b35f7c361a767399\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/defaultItems.js\":\"322a5e51a2c77ad7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/facet.js\":\"a2fb73c2d90255a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/index.js\":\"8a95bdf6442beb75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"7910b84bec4acb41\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/actions.js\":\"dc5f3ebcba96e97e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5f0b8452e44099a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b3df7535c2c9e565\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/index.js\":\"0e201d5b526c7c2a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9c6e53de0b4fc5f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/blockSubtreeMembership.js\":\"f5fb687076170cdc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/contextMenuItem.js\":\"8890ed017ccad8e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/index.js\":\"6e66a501e8ad8466\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveAction.js\":\"cae45368a819eebc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveBlocks.js\":\"20438fefa2db17f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/selectionAfterMove.js\":\"efffb4967c5d0914\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/TutorialBanner.js\":\"dd12093e470ffeed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/action.js\":\"af7e66abcc65b3df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/bannerDismissal.js\":\"5fb71bb322ea8ceb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/documents/cheatSheet.js\":\"dd47f5e682e858a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/index.js\":\"692c6bc70d8b6dc4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/keys.js\":\"443031a95450bc19\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/landing.js\":\"30f8ec64480981f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/outline.js\":\"5ebb59db48bf3961\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/seed.js\":\"97db442645cf759a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ae1d49455dd49abb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/analyze.js\":\"db3b4cd5da586041\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/diagnosticsSource.js\":\"f47162a79e559533\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/index.js\":\"d7af384c220416cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/load.js\":\"bddd6dad8f8d7fbb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/monitorRun.js\":\"2cbf6b6c369bc8b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/schedule.js\":\"6bf57cc8f780e7e0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/series.js\":\"92ea1f96d57d1b2c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/store.js\":\"666e4c891d0b4fba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/trendAction.js\":\"e29b3482a2740661\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/verdict.js\":\"9d7d52394195eae7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/clickToEditAction.js\":\"d94c925e13d430c0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/index.js\":\"6f24547dbfdc801b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/interactions.js\":\"82b1ee8fb8e253bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"93bc50580de370bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGate.js\":\"6e458012ea976063\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGateDialog.js\":\"626770ea5b4c8b24\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/action.js\":\"b5161fb2b6bb4e8b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/index.js\":\"d0e559d62dd6043c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/localRunMessage.js\":\"0e77d02bb6a260d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/plugin.js\":\"3bcf49d1e443ca41\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/progressReport.js\":\"8e7a4eee23dea2f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/sweepProgress.js\":\"76c2d1b5ea18e146\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/FieldRowRenderer.js\":\"039fca994a10b020\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/ValueRowRenderer.js\":\"ef58579a92b28b2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/actions.js\":\"be278822943d9a47\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/autocomplete.js\":\"8305843ce3b647ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/fieldRow.js\":\"56f42cf8dc020636\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/index.js\":\"4c1d7f766bdca508\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/referenceWarning.js\":\"97925de58ad195b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueAutocomplete.js\":\"5ae062c1ae7998e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueSchema.js\":\"d930cc8e4d5dbe84\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/HeaderItem.js\":\"014923e7023c1edb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/QuickFind.js\":\"a9dad21103a33424\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/index.js\":\"fbd871d821b69544\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/recents.js\":\"2a9b435159da88b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/resultItems.js\":\"6937d57525ee628d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/selection.js\":\"b42345ecfc33af1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/toggleStore.js\":\"d92d610062b507fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/HeaderItem.js\":\"d0492a7529767f98\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/RecentsPageBlockRenderer.js\":\"8b41ce8c0fcd49d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/grouping.js\":\"3de1b669f91d65f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/index.js\":\"918914a472f7d9fb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/target.js\":\"df9a6c7883edb96d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/codeMirrorExtensions.js\":\"2200ae435032a718\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/contentPrefill.js\":\"479202cd6274d5ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/dataExtension.js\":\"f66f2da2641f7d2e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/index.js\":\"8d61e8d67948b37a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"edd7cb100d9c9f5a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/invalidation.js\":\"b0a7c8192baded76\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/localSchema.js\":\"908e6c02cb7cbe54\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/index.js\":\"873849e5826269f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"6689f8fe00ab943a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/index.js\":\"d9fc67cfac007ecc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/referenceNode.js\":\"af38f19eec258130\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e09c9e4294e61765\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"99ef7b38a3c1a088\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/index.js\":\"4f3e1da93cb5c7c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"62b10c149d41e823\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"46943fd046e7ccac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/mergeRetargetProcessor.js\":\"894534ff53e83c7e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/parseFence.js\":\"abbe7c5a15739c1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceParser.js\":\"b4126635d36563f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceProjection.js\":\"ef92bc30b526fc2e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referencesProcessor.js\":\"a54987b8e5f57964\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/renameProcessor.js\":\"84e40c33e05ff068\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/spanReplacement.js\":\"8203f3ff7d35a10a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/htmlToOutline.js\":\"db5222bb432af858\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/index.js\":\"a39cd29d18b08e27\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/normalizeClipboardDom.js\":\"55b0a1bc30b5a2f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/pasteDecision.js\":\"7034041e76dc234f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/action.js\":\"212f135941935958\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/blockIds.js\":\"d5e0acfab3442e8d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/content.js\":\"28548b62c707e658\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/effect.js\":\"cc7c42ddcf25bcb6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/ids.js\":\"4031fdd064f38eb0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/import.js\":\"4003e1c8c39200d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/index.js\":\"e0e1e1daa0597581\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plan.js\":\"553a2714ef278193\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plugin.js\":\"f89b785e7c80328a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/promotion.js\":\"a7cfc441e32fa57e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/properties.js\":\"2820414025eca3f1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/references.js\":\"ef0a1cb836441b5e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/report.js\":\"6856a885861ffa44\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/roamMemo.js\":\"07af959349187772\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/runtime.js\":\"4932f1f6dead8324\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/schemaReconciliation.js\":\"637e4c30cb525a4f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/srsMarkers.js\":\"2c5c46337cd340c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/todo.js\":\"57c16ff9d8fc81d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/typeCandidates.js\":\"50fd64b52d9d1ea2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/types.js\":\"936636939db35d4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/index.js\":\"6da0d289ce7e3ac6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/store.js\":\"330c187e20ead81f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/HeaderItem.js\":\"bd6e4fa3861f2705\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"c1fe76f695a506af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/index.js\":\"a084b3b5ca0097b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/model.js\":\"648eff5a8d171589\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/toggleStore.js\":\"9779ed38a5fa9bfb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/useKeyInspector.js\":\"21eff604ed275448\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"1c34614a59602f50\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/ShellDecorator.js\":\"d3937f7de4b19827\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/actions.js\":\"a8ebfa89a025b86a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e8ac7b8adb33c00c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/index.js\":\"6fdb3c06ce62e6ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/shell.js\":\"023e5a0f49beb525\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/surface.js\":\"f8c75c185bca091d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/walker.js\":\"5021a536540889e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/RescheduleToast.js\":\"9518b896b0f93547\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/dataExtension.js\":\"0f6e39af2b355791\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/index.js\":\"0fbcc2be636803f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/indicator.js\":\"b853d5d6ff8f2073\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/moveSrsState.js\":\"3ee7591538c9f157\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"56f53be4bae0885b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/scheduler.js\":\"030c29cb242a2c99\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/schema.js\":\"899c01c9db074986\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"4e10ec82af602b29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsClipboard.js\":\"09da18607ac3de75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a4a1cbcc5ca2a9d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DailyNoteReviewHint.js\":\"44018d444733918f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DeckPicker.js\":\"68e66e6b53ed7436\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewControls.js\":\"f1beb8a0647d9641\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewDeckRenderer.js\":\"22955a52d40b4d66\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewSession.js\":\"958d60d9436c5e9b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/actions.js\":\"9de305c9c55e0b02\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/archive.js\":\"d3804bff2ba3ebbe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dataExtension.js\":\"04e6db2ed19966c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/deck.js\":\"a21792009edcb78d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dueQuery.js\":\"055751d86fc8a96e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/gradeDecision.js\":\"72044b40b18dcbb2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/index.js\":\"1602e16ba9a23a86\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/keyHints.js\":\"5e7e8534c1e5a724\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewCardLayout.js\":\"65cb4be4a8404524\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewProgress.js\":\"daa588fb84a4c493\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/schema.js\":\"ad76f8c60def51e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/useDueCards.js\":\"a3c7328aaea78c4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/index.js\":\"e97cf8d7130c9124\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/record.js\":\"a983b7dd7ff5098e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/index.js\":\"607a7f3e83e5d8eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/persistenceStatus.js\":\"7b9fcc99bc31ad57\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/requestAction.js\":\"87cc5649359b5f72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/TypeChipsDecorator.js\":\"1875dca05a0be004\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/codeMirrorExtensions.js\":\"55e1e922402c5934\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/index.js\":\"90ed498256257297\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/typeAutocomplete.js\":\"23611e1802ca788a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"70e0898ec479ad8e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/actions.js\":\"f3855085cba9edc3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/anchor.js\":\"2956b92ba061483b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/events.js\":\"0c92c0a8efa0baa3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/gestureActions.js\":\"8df9760bbe21c245\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/index.js\":\"13e40338e4e4d7bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"74891c90e8ef9c46\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/collect.js\":\"4897150157b68102\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/index.js\":\"009e4afbf07ecbd9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/record.js\":\"e5dd0499840592d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/RejectionDialog.js\":\"b1747b0ac8618b21\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/SystemStatusHeaderItem.js\":\"e85cc40c5786b479\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/index.js\":\"cf7c03da6e4a0dce\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/model.js\":\"000a708d2d84dfc5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/queueCounts.js\":\"c16adaf8c0184a95\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rejectedHelpers.js\":\"e0e92eeca514054a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rematerializeAction.js\":\"aebf4afbcdb15454\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/useHysteresis.js\":\"2f5d56c2782e0ed8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/ColumnHeaders.js\":\"8f58931616c1e8cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/QueryUi.js\":\"e627abb54adaff96\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/TableLayout.js\":\"f17c90ecd21f0c9e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/actions.js\":\"bb92324502821ef3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/cellEdits.js\":\"d9bc2a1260447bab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/childrenViews.js\":\"860f5815e09831ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/columns.js\":\"ecdf3b9c846b602e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/controller.js\":\"50ed72fb536cd17d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/convert.js\":\"8f3f6cc91cc9d3bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/dataExtension.js\":\"39db25d071cb2c57\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/index.js\":\"87dca6ccf6a5b0bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/keys.js\":\"85d8fecc570e687d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/model.js\":\"779b4ac4486fb1e0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/QueryText.js\":\"b1c6b88a7a74459b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/backfill.js\":\"426c98783e23e86e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/completion.js\":\"c2e3e23b58ff430b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/format.js\":\"2b42ce93ebbaa754\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/parse.js\":\"204fe16956846830\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/queryValue.js\":\"7f3c908b3ab2051e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/registrations.js\":\"b3426449ae788781\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/source.js\":\"8ee2e4bf920903bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/registry.js\":\"96f63eb6ce7da82f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowGutter.js\":\"4d0b8e71e96f2f58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowVerbs.js\":\"3a4a56231ed5e930\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/schema.js\":\"2a1e1deaf914ca3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/sort.js\":\"0e9d6bc5363f2dbf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/effect.js\":\"e1318fac45130c3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/index.js\":\"1c8c033d2acb0363\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/theme.js\":\"af774deacdad3b34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/actions.js\":\"0e6f3527cfaf0b51\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/dataExtension.js\":\"747e757d74390bf8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/index.js\":\"662807c0d5255ebe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/schema.js\":\"5e7f34ae43816df6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4f2997f1f1eb85c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/actions.js\":\"f2872b948bca5e21\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/defaultItems.js\":\"1ee6813176aee3d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/facet.js\":\"39436bfcd4515ce3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/holdRecognizer.js\":\"d60ba035020048bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/index.js\":\"241e1b72e533c235\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/UpdateIndicator.js\":\"64c9e5286f7104a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/index.js\":\"415aa3f2b2d037f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/loadTimes.js\":\"28f172452858250d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoNotesRenderer.js\":\"856fa46819d9326c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoPlayerRenderer.js\":\"0725c2bcc2e9464d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoTimeStamp.js\":\"e3a40f4e09ba1fad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/actions.js\":\"21b07e5f2bae36dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/index.js\":\"2fc4e3396c9e9faf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/markdown.js\":\"76f9699c77e9f97d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/notes.js\":\"4f1705408494f8ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/registry.js\":\"fdd5469f22e82da1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/remark-timestamps.js\":\"a7a828b4c6b3dda6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/view.js\":\"3ea5303ff09f15fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/LinkHints.js\":\"ccf7c4504d832a07\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/index.js\":\"986b618fdc4521c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/model.js\":\"9b3edb2b19a1a4bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/settings.js\":\"72c58a77a0fc5767\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/actions.js\":\"1d5adf1360d67a24\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/index.js\":\"74a2b719ca9d4452\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/interactions.js\":\"ff67e694b6d2e388\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/workspace-header/index.js\":\"7394358bf82895e9\",\"/knowledge-medium/pr-preview/pr-1899/src/registerServiceWorker.js\":\"f36100ef70317550\",\"/knowledge-medium/pr-preview/pr-1899/src/requestPersistentStorage.js\":\"a515c2047d4d6297\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authRequestDeadline.js\":\"10101129ac791c3b\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authStorage.js\":\"7f442b4256bb9694\",\"/knowledge-medium/pr-preview/pr-1899/src/services/powersync.js\":\"0fe722a5e7c6a640\",\"/knowledge-medium/pr-preview/pr-1899/src/services/supabase.js\":\"5641b2bafb6eae46\",\"/knowledge-medium/pr-preview/pr-1899/src/services/uploadErrorClassifier.js\":\"924f09bedef4a76a\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/ActiveContexts.js\":\"8c4f4398401f7bfb\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/HotkeyReconciler.js\":\"cd53cca16d2bdf62\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/WipeLocalDataDialog.js\":\"dd1f85375e952630\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionDispatch.js\":\"fd353835d63f2604\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionRefItems.js\":\"770cd009e790ec5a\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/applyKeybindingOverrides.js\":\"3f9f1b5e6197cdb0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockActions.js\":\"93fa840d2fa761c0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockMergeGesture.js\":\"1916d4dc5f826fe0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/canonicalizeChord.js\":\"28cc48f0b7046d65\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultContexts.js\":\"e4a0c1dba9608afd\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultShortcuts.js\":\"eb34edbf7321f8ab\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/effectiveActions.js\":\"ed94c7c8d60e8160\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureAction.js\":\"716ac20dc420d62d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureBinding.js\":\"83943e2837e66368\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/holdRegistry.js\":\"2869d2a47a086ebb\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingConflicts.js\":\"3483e3f96dc7a190\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingOverrides.js\":\"a80ea3a87dad8dd6\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/pointerAction.js\":\"af87f8b86a2db14a\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/resolve.js\":\"a1505aaaa5831f71\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/runAction.js\":\"341a451644645a3a\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/sequenceMatcher.js\":\"91048e0758278ea3\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/types.js\":\"7d166f76eae6ba61\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionContext.js\":\"aa206c7c834aaa05\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionDiscovery.js\":\"6e9fb5460a7a73b2\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/utils.js\":\"103646fa21067d4c\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/bootStore.js\":\"68529a7b7e8177e3\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/previewDatabases.js\":\"82316dccd68a4ad4\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/byteTransform.js\":\"1274f627ada40069\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/attachmentCleaner.js\":\"90b96bffecba65d2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/attachmentParts.js\":\"af84a30a5cf18bbe\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleParts.js\":\"8fcd77ad9bbf74ca\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleRecord.js\":\"98c7de36050ff103\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/manifest.js\":\"81dcf724efaf1797\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/takeBundle.js\":\"bc72d1b059f19134\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/verifyBundle.js\":\"3a4c49942e446091\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/cleaningStage.js\":\"c43b95ec8d0ca30d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionKey.js\":\"36ea3ea9feaf5176\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionServer.js\":\"b6968c94d2ec049c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flip.js\":\"6975eafbcfdf3a80\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flipAttempts.js\":\"7177ef6e7876881e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/pages.js\":\"9abaab860f462d6e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/preflight.js\":\"b37e0fc0aa39bd48\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/reseal.js\":\"2508d53de0d91273\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runConversion.js\":\"d858c48c49efd86f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runLock.js\":\"aa0c2f0945d3c8ee\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealing.js\":\"c1847d54cacc6f37\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealingStage.js\":\"f998151408fae56c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/stage.js\":\"f564aaf713a4be13\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/verifyReseal.js\":\"a4720a38f6686555\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aad.js\":\"7d804dc2ab5805aa\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aead.js\":\"7fead07327d3969c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base32.js\":\"44b949614418a077\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base64url.js\":\"fb74a271bdc4df8c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/binaryEnvelope.js\":\"3f9f2d5130d855c2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/byteAead.js\":\"7077f1cf3b6fa4c3\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/canary.js\":\"b2b029dafd595623\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentHash.js\":\"9c1d57b5571ab9a7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentKey.js\":\"dea27d13218702b0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/derivedIdNamespace.js\":\"190725f8d6f246f0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/envelope.js\":\"36aeaa3e75b40216\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/hex.js\":\"d188c12b4d1a002c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/sha256Hex.js\":\"22409d57eeddbed5\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/workspaceKey.js\":\"36133787508d7b43\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/conversionState.js\":\"70e9f6e39743889b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4232b80c7ee446e6\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/pastedKey.js\":\"d28aa38b58183491\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"63f1df1be4715848\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/upgradeWorkspacePin.js\":\"86dc101f28ffca5b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/keyStore.js\":\"948979c4274fc273\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/mintWorkspaceKey.js\":\"03a7981aefbbedd9\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/modePin.js\":\"2d0c473987d92d40\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/openWorkspaceKeys.js\":\"c9875e1a5a82be30\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolveWorkspaceEntry.js\":\"e0b880d3ae0f5999\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolver.js\":\"899cec3e43850870\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/workspaceAccess.js\":\"433926196e8d8b01\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/transform.js\":\"5e398daee77d43c6\",\"/knowledge-medium/pr-preview/pr-1899/src/themeBootDefaults.js\":\"ce7bb38149fa1a3e\",\"/knowledge-medium/pr-preview/pr-1899/src/types.js\":\"cfd98fcba7641732\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/ClientLocalSettings.js\":\"cbfd668b7dbbfa12\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/abortableSleep.js\":\"3be84ea37d135afe\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/array.js\":\"57a861082a6393a3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/backlinkAutocomplete.js\":\"6e176b8e030a3349\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockCrumbs.js\":\"350f1345b98edb7c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockrefAutocomplete.js\":\"2b09a39c3c80bfbf\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/cadencedIdleJob.js\":\"4661e7b40841598b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/callbackSet.js\":\"7b414b0d57b3821f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/clientId.js\":\"b29da6dd3e77ccf8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirror.js\":\"baced309c357b0b0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirrorCompletion.js\":\"0c1efd6083887d8d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/copy.js\":\"070aba635f4bfb89\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dailyPage.js\":\"1b3485cf3a55e0f2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensics.js\":\"ce4fc76eaf383d3b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensicsHooks.js\":\"46e27f6ba44ffb53\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/deleteBlockThroughUi.js\":\"0d49f0ef253f8e70\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dialogs.js\":\"c7ff38bf762b196f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dom.js\":\"d67488f771f5c848\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/downloadBlob.js\":\"56f2065694af71fb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/drawnWalk.js\":\"623e503a4bceacf9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/exportSqliteDb.js\":\"5ebade0931214055\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fileSystemAccess.js\":\"fcac90ba1b1df4b7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/flipSlide.js\":\"0ffa8a461268db67\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fnv1a.js\":\"cca179356fb440b3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/formatBytes.js\":\"6d6b5b2a88ab6cd0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fuzzyRank.js\":\"ed2b31f3d9aa0e54\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idbKeyedStore.js\":\"48891fa302826e9f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idleCallbackPolyfill.js\":\"a7c693f0992aa3be\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardAwareScroll.js\":\"f4a6345a3b879f42\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardViewport.js\":\"8f1d172d196805c6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/lastWorkspace.js\":\"1adb5fd3ff695242\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutColumns.js\":\"4222561275c206a1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionDom.js\":\"1e514c46d06b887d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionId.js\":\"a64d903211080b0b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkClickGestures.js\":\"8afdd46ec7f21da5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkTargetAutocomplete.js\":\"6a20925e906b469f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbCorruption.js\":\"83f20c9d866de854\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbRecovery.js\":\"8c83539b9226a33f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/markdownParser.js\":\"c4fd00077c7a830f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/memoize.js\":\"c07a370e086fbc10\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameFieldCommit.js\":\"92d9dc448970162c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameList.js\":\"825bb24891cb121a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/navigation.js\":\"003ecdd82a2fa4bb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/omnilinerNamespace.js\":\"2973e8bac54aa7be\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/opfsPageScan.js\":\"b5945ae0a0790e58\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelClearance.js\":\"db2e7097a1c706a9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelHistory.js\":\"056a48ae983133cb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLanes.js\":\"cd205c57cba780cb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLayoutProjection.js\":\"f70cd7c0f6153bcd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelScrollAnchor.js\":\"1fd8178831f3660f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelUrlFlags.js\":\"ca64948760341972\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/platform.js\":\"4f34ade992f30d7c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/pluralize.js\":\"3722837c0bc292d1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyCreation.js\":\"4eea68b8af2cfa3d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyNavigation.js\":\"14d7e4ef151c45c8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyValueContext.js\":\"efcd75a67ad02ff4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/react.js\":\"c55715eb3e281b3b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeDate.js\":\"60fe0271aa63f0b5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeTime.js\":\"0d5e791b20c94d76\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/renderScope.js\":\"e993d286254f6c49\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/resolvedThenable.js\":\"a65a0d6ee756cefb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/routing.js\":\"262b44246ca2116b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/safeMode.js\":\"1d0097dc1ca7aa87\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/scheduleIdle.js\":\"610f313f30817e17\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/screenWakeLock.js\":\"267a0a9427816f70\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/selection.js\":\"759a51727d701010\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/softKeyboardGrab.js\":\"a74c89b3c2df2249\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/startupTimeline.js\":\"a0717be5877514f8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/state.js\":\"341d8a55d6d7cb2c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/string.js\":\"59c46918f3e839df\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/surfaceZoom.js\":\"efae1936a24da293\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/time.js\":\"fe5207e14bc0251e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toast.js\":\"f19f43c0223d5f74\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toggleStore.js\":\"853d270dd62fd56c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/untilStopped.js\":\"44fcc6ac376fe48f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/userActivity.js\":\"ea64c69b3c0f9530\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewTransition.js\":\"f5012a96cb6391b4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewport.js\":\"3d0322464ce1b713\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/webLock.js\":\"0e3eb0348260a63e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceRecovery.js\":\"9924cb2a9c2170b2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceSnapshotStore.js\":\"651e4055c95475b8\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-compiler-runtime.js\":\"84e9731bb2d63f6d\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-client.js\":\"cecc541eb255cae2\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server-edge.js\":\"b1cf2c386530cd03\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server.js\":\"3c5cad27133a7c15\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static-edge.js\":\"7fd683b41cac9c8f\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static.js\":\"6870f79b44c67e8f\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-test-utils.js\":\"1ddcb4f5ee9aa67c\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom.js\":\"7689d299d97e7fca\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-runtime.js\":\"c2816e21ff9e4747\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react.js\":\"a7b5c4f7b4f421ca\",\"/knowledge-medium/pr-preview/pr-1899/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
