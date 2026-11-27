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
		buildId: "31495a1611d7-eeddc0dc",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/\":\"89eb6bcc50feb2da\",\"/knowledge-medium/pr-preview/pr-1899/index.html\":\"89eb6bcc50feb2da\",\"/knowledge-medium/pr-preview/pr-1899/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1899/assets/FacadeVFS-B9jLqfab.js\":\"763eb4093bd8fee9\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSCoopSyncVFS-DtwLKy83.js\":\"f73515a3f3333054\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSWriteAheadVFS-BONy0fP0.js\":\"887ab736a6c34c93\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-DLFUAwdX.js\":\"a0e59f29cbc87ea2\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-BshiGTRj.js\":\"4e27ce816562316b\",\"/knowledge-medium/pr-preview/pr-1899/assets/worker-Bk7aBePL.js\":\"d82d7b0a70bac9ec\",\"/knowledge-medium/pr-preview/pr-1899/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1899/chunks/app-DG7BiGcK.js\":\"5db9a32e03ef7b5a\",\"/knowledge-medium/pr-preview/pr-1899/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1899/index.js\":\"e5fba137c8fc9698\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1899/assets/AccessHandlePoolVFS-CyBIsY5o.js\":\"0af4b2b63384cece\",\"/knowledge-medium/pr-preview/pr-1899/assets/IDBBatchAtomicVFS-qTpzDvaH.js\":\"d09c029ddd907795\",\"/knowledge-medium/pr-preview/pr-1899/assets/MemoryVFS-Cbqj_-X1.js\":\"db2fee2b41dfcb76\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cof1KQIi.js\":\"e3aa4671dc972e48\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-C6Nt3FpC.js\":\"ad2ce872698709cb\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1899/chunks/AccessHandlePoolVFS-1Dgemb8S.js\":\"22500b44ea9ff19e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/FacadeVFS-2q5Bq0CA.js\":\"2678a7d55e4cc177\",\"/knowledge-medium/pr-preview/pr-1899/chunks/IDBBatchAtomicVFS-CGAUw-yQ.js\":\"ab1817ab44cba219\",\"/knowledge-medium/pr-preview/pr-1899/chunks/MemoryVFS-swCd8xMj.js\":\"bf17df5e6e1472bf\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSCoopSyncVFS-C81uUH72.js\":\"62232c91994d30b2\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSWriteAheadVFS-BP4aJhSa.js\":\"0b34b4cc62c435ee\",\"/knowledge-medium/pr-preview/pr-1899/chunks/Preview-BxozD1Mk.js\":\"55fe5662b0f6e37d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/card-BTmRt5v0.js\":\"ae6141b493634247\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-QyJsHv4c.js\":\"0198780a8d0fd7fd\",\"/knowledge-medium/pr-preview/pr-1899/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-KOTd-Jz-.js\":\"830f130835e933c7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-async-DXpyFyuH.js\":\"07d730191d5534b9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-Bd7WprNJ.js\":\"678a9f323e2b3c13\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-CFnWVBXQ.js\":\"93e27223912f0a93\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-CheLeo4G.js\":\"f4d728f790bd595a\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DLvIRrz5.js\":\"8a0929fa86367eeb\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-JttXJfJw.js\":\"a61b666ae80803af\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server-legacy.browser.production-KF_y7geJ.js\":\"f078ec3ccd828795\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.browser.production-BtAPopnB.js\":\"a72f65d23a2c38f5\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.edge.production-DNi4nlDa.js\":\"da9fb50bd815b776\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-fXVn046S.js\":\"e0052566241ed521\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-iFubEv3L.js\":\"e6cadc934df5b673\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-o-0uTCSU.js\":\"714a0212ff4e3f8e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/server.browser-9VpL02Mt.js\":\"7717665d600f5294\",\"/knowledge-medium/pr-preview/pr-1899/chunks/textarea-CFG-Xvz_.js\":\"3cb13b46fa4ae0c6\",\"/knowledge-medium/pr-preview/pr-1899/chunks/ui-5M53Micl.js\":\"c5cf613e02a490b5\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-async-KolfQSRg.js\":\"1536c52324bb822c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-jj9ouo2A.js\":\"026bb57fad7ed299\",\"/knowledge-medium/pr-preview/pr-1899/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1899/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/src/App.js\":\"9d5f9f1d0249a11b\",\"/knowledge-medium/pr-preview/pr-1899/src/appUpdate.js\":\"77e6b9e928747444\",\"/knowledge-medium/pr-preview/pr-1899/src/appVersion.js\":\"ca792235479f8103\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/initialLayout.js\":\"707f4d600cf1975e\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/openWorkspaceData.js\":\"e3663cdb48e6b31b\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/resolveWorkspace.js\":\"0c9291dc3c359abd\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/workspaceBootstrap.js\":\"0952f3600f183e9d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockComponent.js\":\"941b934715819308\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockCrumbs.js\":\"27eff8f0ab556696\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockEditor.js\":\"1419de33be6cc2aa\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockLoadingPlaceholder.js\":\"03eea2f429bb274f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockProperties.js\":\"3e64204fa3324a36\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockSearchPicker.js\":\"0e9d247d66cbc75b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ConfirmBulkDeleteDialog.js\":\"531e122a3141fb2e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DividerHandle.js\":\"01b6891c029a98ce\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DraftEditor.js\":\"f89bdd45829ed405\",\"/knowledge-medium/pr-preview/pr-1899/src/components/GutterPill.js\":\"16b1128990890759\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Header.js\":\"cf34f3ac3e3466fc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/LazyBlockComponent.js\":\"07f40f5ea2df09fe\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Login.js\":\"64bc8ab41da3ae8a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ZoomableSurface.js\":\"0940d7d17d592125\",\"/knowledge-medium/pr-preview/pr-1899/src/components/editModeKeepalive.js\":\"e1888fea3183ff8c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyDisplay/PropertyDisplayScope.js\":\"fb9756c76e208d32\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"d798dfaa3143b989\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefPropertyEditor.js\":\"991d88a6887f0263\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefTargetTypePicker.js\":\"09306c2c4ddf7bf0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/SelectPropertyEditor.js\":\"31b79c03e9e7fec0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/TypesPropertyEditor.js\":\"e94104e308e6594c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/defaults.js\":\"1fd09a30f10c370f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/kernelValuePresets.js\":\"870a238578e86be1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/selectablePresets.js\":\"1d60276ddf77b2b9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/typesPropertyUi.js\":\"eefea87ff5108a25\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/AddPropertyForm.js\":\"bf86ece3dcf7ab41\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyPicker.js\":\"21eae3aa2ae581fa\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyRow.js\":\"685ecce69aedadfc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/Rows.js\":\"89211520f94f3246\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/actions.js\":\"1046f40dfd5125ae\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/declarationOnly.js\":\"810f0482e42296d8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/layout.js\":\"a5ea4c938c66f2f4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/model.js\":\"c1d80eaf3d051aa2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapeUi.js\":\"116de1ead19d34ce\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapes.js\":\"e69c816f0f0a7837\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/usePropertyEditingActivation.js\":\"48e73e49af0c05dc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/visibility.js\":\"3f0a3deb08c851d8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanelSections.js\":\"fc84381b675cf24d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockEmbed.js\":\"9cc64a76cbaa88da\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockLink.js\":\"23c6b918c978d37a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockRef.js\":\"99da580b0fc4a6ce\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/CompactReferenceLink.js\":\"4d8d1d0ae4f8b66b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/ReferenceLink.js\":\"08e5f989e9181f5b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuard.js\":\"d517184d8174435a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuardContext.js\":\"8bbb9ae1f4d7c527\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/linkInteraction.js\":\"ed69b44c73587ba9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/referenceLayout.js\":\"555d706db39f05d5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/useBlockRefAncestors.js\":\"683c8f7de16b4db8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockGutter.js\":\"d6633f6d6a9a29a6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockInfoDialog.js\":\"9029ca3672b253e2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockReadText.js\":\"57df0faff2af807d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockTypeBlockRenderer.js\":\"71f1650f3fb91118\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BulletHoverCard.js\":\"bb88fbde30753e16\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorContentRenderer.js\":\"3a73e42cb44926d8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8dd681f4022aed6f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ColumnResizeHandles.js\":\"e06fb97de783d09b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c7dd766637356b0a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/DefaultBlockRenderer.js\":\"496efab207e53bf9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/LayoutRenderer.js\":\"8c308d83c9967d78\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MarkdownContentRenderer.js\":\"be61a895628b1b0e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MissingDataRenderer.js\":\"8c09b70f2c9f3a7b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PanelRenderer.js\":\"199517fd6a53e3bd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0638548ed42f27a1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/TopLevelRenderer.js\":\"4c809d632c7e8032\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockGutterMode.js\":\"c13ab9b187070bfa\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockTitleText.js\":\"c75aa5bc1c081794\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/fieldCreationKeydown.js\":\"d15cdeac3d7562b4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/layoutRootContext.js\":\"03c17920a9af1913\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/TypeChip.js\":\"974144b4a6135e6c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/chipStyle.js\":\"343f6a75c20e8e14\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/anchored-floating.js\":\"e0f2b1bb2ad27d37\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/button.js\":\"4270f830fc821e4d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/card.js\":\"ac3161211bc3f274\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/checkbox.js\":\"df67d49e9821bffe\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/collapsible.js\":\"a99d666fa8cf9472\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/command.js\":\"dd987f439897ccb1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/context-menu.js\":\"1455489bd3fb5563\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dialog.js\":\"778f1305933d455a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dropdown-menu.js\":\"9cefc71f3bc78a47\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/floating-listbox.js\":\"e275c9716a3e26c3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/index.js\":\"9ea3e11dd60ade74\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/input.js\":\"9807a928fa4f1a54\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/kbd.js\":\"56fe621bf0c5b441\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/label.js\":\"3c412ec5dd74eaf6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/textarea.js\":\"cd358910fe0e0061\",\"/knowledge-medium/pr-preview/pr-1899/src/components/useEditModeYieldKeepalive.js\":\"e0a278e6009a30c1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/BootFallback.js\":\"1c8bdd23685415af\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/FocusedRowLazyMount.js\":\"15d22df327128171\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LazyViewportMount.js\":\"20d058227c7d2006\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LocalDbCorruptionFallback.js\":\"a3f2bab5352a1914\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/error.js\":\"bf66ddf68d2c3564\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/lazyMountRegistry.js\":\"a17be68ac33533ca\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/suspense.js\":\"7c142797474c7af6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/CreateWorkspaceDialog.js\":\"527309d9d475107c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/PendingInvitations.js\":\"0f8a5add7d9b85fa\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/SyncProgress.js\":\"d5cfc2577867242b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/UnlockProgress.js\":\"52a9413a410ee0dd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceKeyGate.js\":\"a884137a6fd943f7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSettingsDialog.js\":\"b4ec09f1fbf31464\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSwitcher.js\":\"961857d54ccfe41c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSyncGate.js\":\"242eef8ff9ab0872\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlow.js\":\"75499af666f1cd4e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlowHost.js\":\"51e05ed975f1e1a8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/EncryptionSection.js\":\"7c36886527bee7bd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/attachmentPrompts.js\":\"aba350adc26135c0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/bundleFolderPrompts.js\":\"24bf6bab02166efd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowDeps.js\":\"689b626e983c5412\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowStore.js\":\"0ec0498e08f57e2a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/flowUi.js\":\"f1e438f21aa84716\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/useConversionRun.js\":\"3f11eda5c87b9722\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/keyUi.js\":\"d3b31a585102648d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnKeyLoss.js\":\"885ebcb7521520c7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnServerE2ee.js\":\"8af1765043c72ccf\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/workspaceUnlocked.js\":\"51bae4680d54a404\",\"/knowledge-medium/pr-preview/pr-1899/src/context/backgroundSubtree.js\":\"ba67d1825cece45b\",\"/knowledge-medium/pr-preview/pr-1899/src/context/block.js\":\"d69eeceb1f46b09d\",\"/knowledge-medium/pr-preview/pr-1899/src/context/layoutWsContext.js\":\"d5a664239b2d3087\",\"/knowledge-medium/pr-preview/pr-1899/src/context/propertyDisplay.js\":\"d9ffe6d8cdadacda\",\"/knowledge-medium/pr-preview/pr-1899/src/context/repo.js\":\"a6a06037565ebceb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasClaim.js\":\"d7a28c43c0edef87\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasSeatNamespace.js\":\"e786ce3f83d74dc0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockData.js\":\"7e0e64ae16b37a85\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockType.js\":\"90f43b474e8594f2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/changeScope.js\":\"47f3f86eb87170d0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/codecs.js\":\"54f767f5dd59cd40\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/derivedData.js\":\"0693b9783ed00c90\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/errors.js\":\"9f125dc15dd12158\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/events.js\":\"c49017bb6fe8c9cd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/handle.js\":\"1457fc3a57903954\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/index.js\":\"926be0283865e099\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/mutator.js\":\"e3d0645509a21032\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/processor.js\":\"1c399fe88b3ed056\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/propertySchema.js\":\"720feab36542ee47\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/query.js\":\"52f26c4d41a26496\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/sameTxProcessor.js\":\"f8810110a47727d6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/schema.js\":\"1457fc3a57903954\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/tx.js\":\"1457fc3a57903954\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/typedBlockQuery.js\":\"3f8b6847a39accbf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/user.js\":\"664af5cce77b1ea8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresetCore.js\":\"69d896c22d022d38\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresets.js\":\"e65b9666aeef331a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/attachmentCleanerIOVerb.js\":\"67a93c5a0079b9e4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/block.js\":\"3439abd0202dbeee\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockCache.js\":\"23d3e5de804cd875\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockId.js\":\"2197c8b6d55d9b7e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockLiveness.js\":\"6ade4d7cfa84b8fd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockMerge.js\":\"aee87305396c5780\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockSchema.js\":\"259ea2b06db5bfff\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypeLookup.js\":\"9c0ec71e07a1c71b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypes.js\":\"1bb905c46d361613\",\"/knowledge-medium/pr-preview/pr-1899/src/data/childrenView.js\":\"734278881842910a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/clientContext.js\":\"039be70863f62cf7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/dbFileSiblings.js\":\"6da3dc36b5f7b712\",\"/knowledge-medium/pr-preview/pr-1899/src/data/definitionSeeds.js\":\"4a807d369cbc90b1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/derivedIds.js\":\"6c7bfc52b2c88a26\",\"/knowledge-medium/pr-preview/pr-1899/src/data/drawnSubtree.js\":\"833622b73649fc7f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facetBridge.js\":\"dd7b68d17d25936c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facets.js\":\"9db706a44510cbf6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/globalState.js\":\"e0d24a3e89838824\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/aliasClaimRederiveProcessor.js\":\"f534523701dddf8c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/ancestorBatch.js\":\"7af82b665d471654\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/blockTypeTypeifyProcessor.js\":\"5b278091e2bacee8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/clientSchema.js\":\"9efd1de8e3a42167\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/commitPipeline.js\":\"c46aaaab9da72c7c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/devAssertions.js\":\"3939dd00c2947ab6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/firstSync.js\":\"68dfd4993c032886\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/freshInitialLoad.js\":\"5fdf7ebc5e580c1a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/graphBackfillClaim.js\":\"baf511d61dd2ac48\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/handleStore.js\":\"85e17276468b6c03\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/idleMarkerJobs.js\":\"64d0be1682f5c6bc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initialDownload.js\":\"59b073f90141af5e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initializeClientDatabase.js\":\"3e40257e4572af7a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/jsonCanonical.js\":\"bf7e4e18274edbe2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelInvalidation.js\":\"3b6941c9e9ece8f6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelProcessors.js\":\"4a54463b89823842\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelQueries.js\":\"9936e86ff6e121be\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/mergeTypeMembershipProcessor.js\":\"664d3ae75b2a70fc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/normalizeReferencesProcessor.js\":\"96fb111459213f57\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/poolInstrumentation.js\":\"9ad2213aa635bca5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/processorRunner.js\":\"da2de6b4fa9572c4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyCellBackfill.js\":\"e17b04b0b855c08e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildMint.js\":\"511c7d70f931d279\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildrenProcessor.js\":\"08ab8e306b2344f9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4f8b3f9af6d859ab\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionSynthesis.js\":\"186327968e474ee1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyKeyScan.js\":\"535eda0a852fb8bb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertySchemaResolution.js\":\"5d88d5296cd669e2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyValueEdits.js\":\"605d07a1daffda7d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/raiseProtocol.js\":\"e25cd4b0e2dbd45b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/readBatch.js\":\"7f4f03d5b7e42767\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/refProjection.js\":\"965b4df4a13dac21\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetLookups.js\":\"4212af6dbbe77a71\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetProcessor.js\":\"d4cf808652467e1a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/replayMerge.js\":\"1cc0341999bee626\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/sqlBinds.js\":\"8ab381a45cd9747a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"534c712d83bf1349\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/arrivalProcessors.js\":\"81bbc33170f837f8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/invalidate.js\":\"6c2378a32d7d13f9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/materialize.js\":\"7f6014838462b5ae\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/observer.js\":\"1cf3dd821f27cdd8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/reconcile.js\":\"a2e9de1077921fb7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/timingMetrics.js\":\"37003f27612208b0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/treeQueries.js\":\"1f65ec0cdbd84a59\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txEngine.js\":\"a70bc58de6a719a8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txSnapshots.js\":\"ba7b47087c9a4cad\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/typedBlockQuery.js\":\"cd0f9d5513fb6f08\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/undoManager.js\":\"c84ab74fc47e4e2b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/invalidation.js\":\"fb8e8a1e7f8ac76e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelDataExtension.js\":\"8a6e0f128a6927ab\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelPage.js\":\"101fa15ed2346a9b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelValuePresetCores.js\":\"8a5a9b4873736be1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbCorruptionSignal.js\":\"871b8234510cb8b9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbStorage.js\":\"1d2e21050f6871db\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbVfs.js\":\"0d4214657ee3c524\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localSchema.js\":\"58e5242058d976fb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/maintenance.js\":\"ee16efee051be861\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mergeProperties.js\":\"30e9b122ccb88309\",\"/knowledge-medium/pr-preview/pr-1899/src/data/metricsConsoleHook.js\":\"13850247023bdcde\",\"/knowledge-medium/pr-preview/pr-1899/src/data/migrationsPage.js\":\"770442139c673cb9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mutators.js\":\"a2895179f784cbcb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKey.js\":\"e5f9003ff731e751\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKeyPlacement.js\":\"3ae7f2e1dc8e0d72\",\"/knowledge-medium/pr-preview/pr-1899/src/data/outlineSurface.js\":\"907096e59ad19d04\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingEditorContent.js\":\"ff0fd35d702aff95\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingUploadsSql.js\":\"dc64f851e37539db\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pluginStateExtensions.js\":\"88ec49f6eff61766\",\"/knowledge-medium/pr-preview/pr-1899/src/data/powerSyncLogger.js\":\"cc69db0b44414168\",\"/knowledge-medium/pr-preview/pr-1899/src/data/projectorRuntime.js\":\"e707c7fd4bf2a0d9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/properties.js\":\"efbc16e4b8528f63\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertiesPage.js\":\"7061084d4a3f6f7b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyChildren.js\":\"386a33679a82f033\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionFanout.js\":\"b13d43d90a5a9459\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionMetadata.js\":\"8ec41b518ced5355\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionRegistry.js\":\"19bd27ec2203a24a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDisplayMode.js\":\"1cea0c21d7518fcc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyRowCreation.js\":\"f6385e499541c154\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySchemaCreation.js\":\"4389cd6d2cc66bb2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySeeds.js\":\"b75c7e3742f2fb18\",\"/knowledge-medium/pr-preview/pr-1899/src/data/recentsPage.js\":\"db81ec8144e8d075\",\"/knowledge-medium/pr-preview/pr-1899/src/data/refTargetComparableProperty.js\":\"2bd21cdbfc9681ba\",\"/knowledge-medium/pr-preview/pr-1899/src/data/referenceBlock.js\":\"77c4e026e679b739\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rejectedUploads.js\":\"7dce14d40484147a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/releasePowerSyncConnection.js\":\"c8e5611218f0a5cb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repo.js\":\"4629d081d9826d0d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repoProvider.js\":\"65da6c7127e5d636\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rowProperty.js\":\"ff6fa3fbec358fed\",\"/knowledge-medium/pr-preview/pr-1899/src/data/searchFilter.js\":\"d6e9e98726c7c915\",\"/knowledge-medium/pr-preview/pr-1899/src/data/seedIdentityLedger.js\":\"abac7f0e26898c4f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/stateBlocks.js\":\"4846a10411c45d15\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralEditPolicy.js\":\"67f5b1ba2f487d9e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralInsert.js\":\"25b9ac0887e1c7ee\",\"/knowledge-medium/pr-preview/pr-1899/src/data/subtreeDelete.js\":\"d0b6e27d8d85a115\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncStreamLock.js\":\"46dc4d06dd0c2663\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableSqlRecognizer.js\":\"1639301c878d91be\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableWriteGuard.js\":\"3202aaf1726920ff\",\"/knowledge-medium/pr-preview/pr-1899/src/data/targets.js\":\"8a14c6630392c1d6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeColors.js\":\"65585c4028a2f00e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionMetadata.js\":\"635ef20e6d568610\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionRegistry.js\":\"bb6d26819fa83e4b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeExtraction.js\":\"1ce23b2156f65650\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeInitialValues.js\":\"29c091ff786ce6db\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typePropertyGroups.js\":\"b617f629c729f563\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeSeeds.js\":\"551ed293bfc2bbff\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeTagger.js\":\"3ad0a6d0b1e06061\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typedRecords.js\":\"9247265019b1705d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typesPage.js\":\"f98b852d09cc76ef\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userPrefs.js\":\"a9d0efa6bb1a2c4d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userSchemasService.js\":\"99cda18aa6dc980a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userTypesService.js\":\"281b0c4ff2cc666b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/valuePresetRegistry.js\":\"d03758a686665c6f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/visibleChildren.js\":\"e44ead8c1d8346fc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceConversion.js\":\"68e882dcbb6a3aed\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceFirstSync.js\":\"2014344da5b7f365\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceIdNamespace.js\":\"f7590ec70826fe22\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceSchema.js\":\"ce27c8fb144c0706\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaces.js\":\"0a197bd86053286a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadLog.js\":\"4f96317a2f4746cc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/BlockPasteShellDecorator.js\":\"fad516ccc82e2ece\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/atTrigger.js\":\"9d7a0c42f616ba71\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/autocomplete.js\":\"37bb3bb6dcebdba6\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/codeMirrorExtensions.js\":\"0816c01224325f7d\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/contentFlush.js\":\"89de051f57d729bb\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/defaultInteractions.js\":\"c97739baeb4da5ca\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/editSettleSignal.js\":\"ce907a02bbdc749b\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/insertImage.js\":\"cb57936d25b318f9\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceCompletionRange.js\":\"57ced6254fe701d7\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceTargetTypes.js\":\"115129d7769643ac\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/syntaxContext.js\":\"7ce0ab5f97026fb3\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/triggerMatch.js\":\"4ffcc7610fdb35d7\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/AppRuntimeProvider.js\":\"d72613be694fff1c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/BlockFocusShellDecorator.js\":\"9e60efc1ca29ecdc\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/ExtensionRenderBoundary.js\":\"c86e1c5f5ce76b23\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/PanelContentRecovery.js\":\"cfc6b47fa52667db\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/apiCatalog.js\":\"8e55bb97c377080e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/approveExtensionHere.js\":\"8391bab7eb66c8d4\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/armedCutAppMount.js\":\"217cc39fee8545df\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/batchableKeyedStore.js\":\"f4db2d8d0f901500\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockInteraction.js\":\"0190325290e949b2\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockSelectionAction.js\":\"337405aa553781d2\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compileExtensionModule.js\":\"570ce9018834b7dc\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compiledModuleCache.js\":\"6839610be53746e9\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/continuousGestures.js\":\"1cd2602f40e693de\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/core.js\":\"2c802e4941e165cf\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/defaultRenderers.js\":\"ed6d2a39665ca233\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/definitionFanoutAppMount.js\":\"7aff5e3d5b75e73d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dialogAppMount.js\":\"71a4a7f04252af85\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensionSeeds.js\":\"8441f1ed0370bf92\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensions.js\":\"5a508e76df1d66cd\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/exampleExtensions.js\":\"5580a02b44a807db\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionApprovalStatus.js\":\"613f47eb83782747\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrorToast.js\":\"62314426c8e5aa26\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrors.js\":\"804d4d0c86b9d9d1\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLookup.js\":\"8001509f20f1e734\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionToggles.js\":\"0d85b31f0edadd97\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionUtilitiesCss.js\":\"ceeceea6e3ce1881\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/kernelPageDeletionGuard.js\":\"3cbcf6a7567a9cbb\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/liveRuntime.js\":\"24d24109ffec13db\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/openExtensionsSettings.js\":\"a4856a5d3ba70a86\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/overridesCache.js\":\"e9c6745f71b26786\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/pluginIds.js\":\"0b029c20f6b3b908\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/processorRejectionToast.js\":\"a44a988f575d276a\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeActions.js\":\"2fb12d13f86b6ff6\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeContext.js\":\"feb7e2554a809255\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticAppExtensions.js\":\"f3cdc78d02a05536\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticDataExtensions.js\":\"8f1c07ee2975295c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/toastAppMount.js\":\"2cebc87698c11e2f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useOverrides.js\":\"a1a52a566553b9ec\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useShortcutSurfaceActivations.js\":\"cd17418db3ff5489\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/discoverToggleTree.js\":\"0f5e9079643a587b\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/facet.js\":\"d83242f469489cff\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/resolveAppRuntime.js\":\"e642772f2d2f18b3\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/runtimeEvents.js\":\"2583d66e462cfeb2\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/togglable.js\":\"1eca03adf8863ac9\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/variantFacet.js\":\"b299db3824a9a679\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/verbFacet.js\":\"9c822310acd35642\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/block.js\":\"3579aefbbdab229f\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/focusedChild.js\":\"51614098094ae0f6\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/propertySchemas.js\":\"fd3522fb5a8d21e6\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/typeRegistry.js\":\"f93757a5c2a1dcbf\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAncestorCrumbs.js\":\"e44a78341a28c659\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAutocompleteListbox.js\":\"422ec343e68a9b6d\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedSearch.js\":\"2abe0a87597c15ff\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedValue.js\":\"925cf5d836fe9540\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useFacetValue.js\":\"e08c71c86039a1e9\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsFocalRender.js\":\"4d331494b62fce1d\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsReadOnly.js\":\"3fe3959466ce39e8\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMaterializeBacklog.js\":\"fdd5807d57bb83f9\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMinuteClock.js\":\"23cc9ecdbe847262\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePanelLayoutProjection.js\":\"d85101ec734bb24b\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePendingInvitations.js\":\"c4320f4c9f02a4d2\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRendererRegistry.js\":\"cb21f5e2f0e849c2\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRetainedFieldRows.js\":\"ee1340a796c7d616\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useWorkspaces.js\":\"3b6883b1618da420\",\"/knowledge-medium/pr-preview/pr-1899/src/lib/utils.js\":\"88f489e60f23c9f5\",\"/knowledge-medium/pr-preview/pr-1899/src/main.js\":\"3a20705d203950fd\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/MarkdownImage.js\":\"a2601e4855a566d2\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/blockSeparators.js\":\"d2bb9cc91bd00f94\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/context.js\":\"3f227595ed288e41\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/defaultMarkdownExtension.js\":\"cbaeda2489407e90\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/extensions.js\":\"2e305faebfa1490d\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/renderMarkdownHtml.js\":\"0c8590e9af017823\",\"/knowledge-medium/pr-preview/pr-1899/src/minimal-editor.js\":\"af84800d2fe636a2\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/armedCut.js\":\"936ccbbadee30c9d\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/captureMediaVerb.js\":\"d188c9a577abb946\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/clipboard.js\":\"1584d8ab3f18b324\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/decision.js\":\"aef09cb770fa8bb4\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/operations.js\":\"6d9937a3da578594\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/AccountHeaderItem.js\":\"ed0328d9dd124bc6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/index.js\":\"f2104d20aacf54c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"d8a8882b06b4a77d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askAgent.js\":\"741a24ee65822ad5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askedStore.js\":\"836b9afd06c4ffdd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5b28b5bbbd3f3e5e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/chipState.js\":\"a20f1d783e264ff7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/dataExtension.js\":\"16ee894aaae957fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/index.js\":\"d68c18ae028d5203\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"816037365b17c7f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/schema.js\":\"ea1f17be18e73630\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/AgentTokensDialog.js\":\"370bb348ab905fa2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/BridgePairingDialog.js\":\"9d601d9a85fa14bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/addMedia.js\":\"bda00135bc231ea4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/backlinks.js\":\"98f55c23b612c4f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/block.js\":\"d4f6be2afe0ca6f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/context.js\":\"be9c197170d3e787\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/displayIds.js\":\"17894094bce8199c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/index.js\":\"f049692845ad6405\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/outline.js\":\"413444ea17a09d24\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/properties.js\":\"2dc3945cadbffbcd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/refs.js\":\"b51c6fd02f745116\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"a602348bae1ef867\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/search.js\":\"898ddb266ba7f69d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/shared.js\":\"5b227211c226f85c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"0bf9cdf81bcc4119\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/text.js\":\"b7f84243be992f3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentWrites.js\":\"c640e46d6eabbc9e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/authoringCatalog.js\":\"c06d5862b479804e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/blockRefTargets.js\":\"e7481f8523f5af64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridge.js\":\"504e2d3cb5a00188\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridgeLoop.js\":\"36cfaa7488785f9d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/changeHistory.js\":\"8c1e94c6d25d4775\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commands.js\":\"70d23caa05150f0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commentsCommands.js\":\"7c1f45f0896cea79\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataExtension.js\":\"57833d0668c33f40\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataModelGuide.js\":\"5ef1acdb3d38d1ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dayPropertyInputs.js\":\"ee59f2b676646093\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/describeRuntime.js\":\"ef58d89211188bc0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/extensionLint.js\":\"5fd94cc5f0eb27e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/grainAudit.js\":\"5ea17a379b54cae9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/healthCommand.js\":\"5c08373c1250c58f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/index.js\":\"1dbd328766e5ec7a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/presetIdentity.js\":\"e8cb7f87f0a591db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2368ea434919fc41\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/readMedia.js\":\"532ac2b721a6b18c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/schema.js\":\"75f16b0ffce95297\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/serialization.js\":\"6cfc7e32773cd03c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/targets.js\":\"a66e7b8e6c77f6d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/tokens.js\":\"d35e811e9b61cdf8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/watchEvents.js\":\"309a55591a6128e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/workspaceGuard.js\":\"b4f1150c5dcac985\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/writeCommands.js\":\"da703ddec1da746c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/AliasCollisionToast.js\":\"be4fce5989f74441\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/DuplicateNameBanner.js\":\"74cf02f7b5fdd652\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/collisionMerge.js\":\"235c7bbfdfe5891e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/dataExtension.js\":\"5ee455d17b38a1d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/index.js\":\"8c2f68fe8e712c41\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/mergeCollisionAction.js\":\"647a2e3377297dfd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/pageStyling.js\":\"a2805e11fa4e8db1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/rejectionToast.js\":\"088354bfc6fdd4ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/syncProcessor.js\":\"93c1eb6e25c3a34a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/actions.js\":\"8d84ae47d81122d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/addComment.js\":\"73c814e43dc6a24f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchor.js\":\"c544dfec7d101025\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchorState.js\":\"dcb2942be5dd9802\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/commentLinks.js\":\"c8b733380b973238\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/confirmThreadDeletion.js\":\"c5e85878698c44bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/container.js\":\"dfa46ffe13fba5f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/dataExtension.js\":\"12c1d9b360fa3727\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/deleteComment.js\":\"5baa0688d1a0e76e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/highlights.js\":\"5b9af7c37f774cb9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/index.js\":\"3a57731976e3186e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/linkedCommentsPill.js\":\"6ed6d583d7231710\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/margin.js\":\"186815592f62ad8d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginAnchorLinks.js\":\"4163e58861cab516\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginSchema.js\":\"f0f8f8f4ab31f00f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/newComment.js\":\"786af887cc2e78ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ownThreadPicker.js\":\"bbbe3d58aa4c7ac1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/placement.js\":\"37035dc29b056fb3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/queries.js\":\"97c89416559a8d30\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotePosition.js\":\"75d87f454525306a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedIn.js\":\"bac48ac76847d117\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedRange.js\":\"4b3c1e749aa36b96\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/rangeRefs.js\":\"5b50f57e35ac76e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readHighlights.js\":\"514c748499c6bfb6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelection.js\":\"9b62f4d08ec21631\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelectionUi.js\":\"aedeb8315e80b6d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/reanchor.js\":\"4a6e8aa5900ba083\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/schema.js\":\"8868dc61cfa0a613\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scope.js\":\"4eec7b1009ef5e36\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scopeThreads.js\":\"f2e93ab6acb74295\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/splitRetarget.js\":\"0ba3b4a7f327d093\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestionCard.js\":\"9a4e0cd7254ee292\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestions.js\":\"99feae60f2dd25da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaries.js\":\"9b298e149332c159\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaryBatch.js\":\"71c2892d88756920\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/surface.js\":\"e1f5defc0c4cc303\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threadNavigation.js\":\"464cb6f91855c85a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threads.js\":\"5cbf0bef19d054b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ui.js\":\"a8cf209653383fa0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/uiStore.js\":\"b94371d6bffc849b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/appIntents.js\":\"ece203212773408d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/index.js\":\"e110bdbd21a33922\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/index.js\":\"56c9925022bdeda9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/status.js\":\"a53a5adf5ed19484\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"601ccff83e2ff964\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaBlockRenderer.js\":\"cebf900541fc346f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaDownLaneReplicator.js\":\"61c9e1a6ee304f2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaUploadReconciler.js\":\"d3518d9a7ac559af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetDownLane.js\":\"393f9fa5b5cbd676\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetResolver.js\":\"2e4e121fe8745c63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetUpload.js\":\"68d9bef239854163\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/attachmentCleanerIO.js\":\"8f7ba4320f7df600\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/supabaseAuditIO.js\":\"1290875dd7e04118\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/blobStore.js\":\"7d417494220933bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/browserMedia.js\":\"ccf6c889a4661a0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/byteStore.js\":\"c05deb9c1027685a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanerIO.js\":\"eb42b6fa95e3b495\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanupAttachments.js\":\"0c2b8f6b3be9d2a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/dataExtension.js\":\"ce1593eeca38b8fb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/downLane.js\":\"60a88b609cc1b9d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/index.js\":\"000a3f87b9ab2a0c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/insertImageContribution.js\":\"d036f4d30a160c56\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneArming.js\":\"c2fc096ca4340f0c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneLock.js\":\"c0d13b5f39b9dec6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaBlock.js\":\"ced008d338adc07e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaCapture.js\":\"c651a0b0dc6a1355\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaLanes.js\":\"4426ddf9424f5349\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewers.js\":\"467be2f972685ebe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewersFacet.js\":\"dd0bf19d426aea32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/pasteCapture.js\":\"c70114c5e025dc85\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/resolver.js\":\"915ceda288a0a979\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/retryUploadsAction.js\":\"346d15c2487000be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/storagePaths.js\":\"e7b90fbf203fcb87\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadDrain.js\":\"867eaf32d543b572\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadLaneStatus.js\":\"a7dae8ac4bc4b324\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadReconcile.js\":\"44b4c771077bf3d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadRecovery.js\":\"a637269d65c005ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadStore.js\":\"7fdb97763e1ad15d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/useAssetObjectUrl.js\":\"4e044282ccfe1178\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ba66cc8ce28cd923\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksViewSection.js\":\"1d4378c647c3412e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/facet.js\":\"fd39d907e20b4bac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/index.js\":\"965333b055bdf9c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/prop.js\":\"dc1b52c184baece1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinkFilters.js\":\"2507a9aeb0a41eac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e08f58335553f052\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BlockEntry.js\":\"c0386aa4920a6a44\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/LinkedReferences.js\":\"22e8ed0421c92246\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"528035d7e7c618cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dailyNoteDefaults.js\":\"95dd228b4d47b95b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dataExtension.js\":\"83184c8930999ff6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/edgeExclusions.js\":\"8c4f229193b0a31a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/filterProperty.js\":\"b8725956c7f6ab30\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/index.js\":\"d0d9b58468a3023a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"afc7cd5a8e6e6f03\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/applies.js\":\"2f4c710c004f516a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/countQuery.js\":\"9a42f9d79edb21a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/expansionStore.js\":\"6bef18b8963e13ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/index.js\":\"e0563f3045783d6c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"4ff321215d352ee2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/presentationInvalidation.js\":\"92a68c5f8bef583e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyEditorOverride.js\":\"860a7c75ce9ae989\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyFilter.js\":\"9b851dbc25565d4a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/query.js\":\"03586e3b28b8d816\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/resolveFilter.js\":\"1dc74e79941a1c42\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sourceBatch.js\":\"228c8a4dbfce7102\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sources.js\":\"a782cef905e9e882\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useBacklinks.js\":\"ef7929ecbdaeec51\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"9119c785e08cebb7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayCelebration.js\":\"82af9bd63cf799f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayOverlay.js\":\"89bac3bc8ceaa415\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/gate.js\":\"98caa184ac20ba0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/index.js\":\"e6e21768f5059942\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/wolfTheme.js\":\"606c5512e8134efc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/BlockDragLayer.js\":\"9355e00f2e2f2194\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dragController.js\":\"9476e3b7c18ec533\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dropTarget.js\":\"2de8adbec60f9501\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/index.js\":\"cc1fe15fe4c90eeb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/projection.js\":\"19534698a128dbdd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/BlockMetaCard.js\":\"a7025a33b1ec7d98\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/index.js\":\"ad65f9ed17b63d78\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/AddTagDialog.js\":\"a79ba66a369ff877\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6fd9428b374f1012\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/TagNameIssueHint.js\":\"a8803c4a5bab372d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/addTagAction.js\":\"13f2b0d8a1ab469e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/appendTag.js\":\"211ba7a4c308778f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/config.js\":\"e029c2af22bc6005\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/dataExtension.js\":\"f265962502205bf8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/index.js\":\"9bc7a813ee042eab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/propertyEditorOverride.js\":\"78b459d03c3a7a2c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbList.js\":\"cf959eb06d7ad0cd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"fde2a785aaf76d1a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/Breadcrumbs.js\":\"4792596cd87db338\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"466f29684bbb0e1a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"fc3d58c6b020ec57\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/index.js\":\"00f5ba76c95f3a57\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"429dd91a11d1396a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/CharacterCountItem.js\":\"9a850c9ddede5971\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/ProfilePropertyEditor.js\":\"6296b8ae8cf08b3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/actions.js\":\"ff3ef698dba81272\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/blockType.js\":\"b1e8519cea6f92e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/charCount.js\":\"9f91ca7af1472c4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/dataExtension.js\":\"da3e5dc0e6aff7fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/index.js\":\"cef0cb7d1d7dbf94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/profiles.js\":\"df308df7a1767bea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/properties.js\":\"0d59d9969855120d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/subtree.js\":\"f2a44c539b5b5e49\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/textCounts.js\":\"c8ba0c86c363ae38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/colemak-keybindings/index.js\":\"3b1c55940fab5987\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/CommandPalette.js\":\"abe0884586476f64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/HeaderItem.js\":\"c1ff9cba9f1dbafb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/context.js\":\"acb14fac2cb95340\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/index.js\":\"666530ace27a3c87\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/selection.js\":\"7907b6a184118e2e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/toggleStore.js\":\"c3bcd3caa186a3d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/useCommandPaletteActions.js\":\"9e7495f323abf964\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ContributorBadges.js\":\"e359659b520ca317\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ProfilePicture.js\":\"e72b2acdc8a41913\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/author.js\":\"3e8f503ee6bb8fc0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/codeMirrorExtensions.js\":\"0ad6691189c6a5f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/dataExtension.js\":\"5a5ae066d1580a5a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/index.js\":\"f11b437a28e3b214\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/mentionAutocomplete.js\":\"30ce0061a424b5fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/processor.js\":\"e24d50a5454cd773\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/profiles.js\":\"a2fb4405e4b19e65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/queries.js\":\"6718d01290167b13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/schema.js\":\"1e06b7c312aea248\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/useCommentAuthor.js\":\"5e101e93ba9194d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"f021ac7fcf605805\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f88c3ac7acf8c457\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/index.js\":\"aabb34a38d8d94f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"7663002bd5236c74\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b99fffc8a0771a87\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/CalendarGrid.js\":\"4c69c2fbe87cdcdb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DailyNotePicker.js\":\"d0abcfd2721de2f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"122aaf30f6e39191\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateNavDecorator.js\":\"94e5a3d71d6a35df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateScrubOverlay.js\":\"9cc0f85e47282c78\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayPropertyControl.js\":\"a7147031e0c6e780\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayValueReferenceControl.js\":\"d100ea5bb7709d82\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/HeaderItem.js\":\"437d300ec98ea7c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/ReschedulePicker.js\":\"315b7c0bc3963943\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/SpreadDatesDialog.js\":\"ae4c69c737fb2d12\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/actions.js\":\"adc684cb6346f43a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/blockDateAdapter.js\":\"cd24a3f3188e8da7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/calendar.js\":\"e3e52958daecc968\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dailyNotes.js\":\"2f712282964ec98f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dataExtension.js\":\"f3c058eb6da0999f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubActions.js\":\"75e221ec353e167b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGesture.js\":\"e726c292553a1623\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGestureActions.js\":\"bc0494d9fc83f1c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubRecognizer.js\":\"734c6d453341236e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayProperty.js\":\"d4f399b34c3baebe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"f361abe063c0344c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/deletionGuard.js\":\"b85068f26cd27612\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dueQuery.js\":\"a0cc20274f50e3ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/index.js\":\"7f047569aa701b0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/landing.js\":\"6da2b8628c476a2b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/localSchema.js\":\"d11202d3d060b3a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/referenceDateAdapter.js\":\"0bcb6aa0f8f45d1c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/rescheduleAction.js\":\"e5dc45b6989ca5bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/schema.js\":\"28ba6a45b18eb798\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadBlockDates.js\":\"f5eb12d098c7cbf0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadDatesAction.js\":\"93537eabd7419f68\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/today.js\":\"ef25d186aa158fdf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"5997d30d3b4f713f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7737c8c115be9e9f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/audit.js\":\"7ce37c1dec2dd6b2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditAction.js\":\"64c1abc8f1d3c641\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditRanges.js\":\"83306bdb21763f8c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/diagnosticsSource.js\":\"8be365a0a9fe49e0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/divergenceScan.js\":\"cca6c7d460a2f674\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/index.js\":\"efd3816dd31dd3f1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/propertyChildrenChecks.js\":\"f8b23a2157ee17a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/referencesMirror.js\":\"840b1ebed4f22a36\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/rowJson.js\":\"5b289961cc94db48\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/schedule.js\":\"adfa0af8b9099632\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/store.js\":\"290f4ff237a603f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/action.js\":\"e9c6afa566b79dc3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/index.js\":\"03a1b021f41573b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/plugin.js\":\"07151cc4599ba66a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"a1a752527ff6166d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/actions.js\":\"f5510fdff53f62b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/changeMarker.js\":\"fc6db4bbb670caea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/diagnostics.js\":\"222721f8d3cd8ee3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/fileSystemAccess.js\":\"f5247cde85a7c217\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/filenames.js\":\"326f5fa04511ae88\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/index.js\":\"0f6511c7b7682880\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/mirror.js\":\"3cfdb9151320ceb7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runLock.js\":\"5a17078be1cecb0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runtimeHealth.js\":\"f627f09b147468ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/schedule.js\":\"1e12e1816b456f39\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/store.js\":\"bc3426c2bce6f1d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/index.js\":\"06d3c4fed75d3b3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/themes.js\":\"fc74ccfe44274851\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/facet.js\":\"709dcbfc607ea90b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/useDiagnostics.js\":\"7ad7051f7483917e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/dismissals.js\":\"174f7c8041f9257e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/index.js\":\"d4fd776fa3acdc54\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/status.js\":\"d942d217b0ef8a18\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/store.js\":\"739c9b6a3a6abe4e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"8706b872d079e91b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsSettings.js\":\"9cfe61b9fab11134\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/actions.js\":\"d6181e03619560cd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/config.js\":\"27446123a684a248\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/dataExtension.js\":\"da51f36ce5b51721\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/effect.js\":\"a46aa4146cc7d6e0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/index.js\":\"68d4022ae21a3b84\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/propertyEditorOverride.js\":\"3b4f4170db6c113a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/useToggleTree.js\":\"cd00b52fbc008253\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/ExtractTypeDialog.js\":\"be376a7d77c8c0c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"339389dccac67864\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/PropertyShapePicker.js\":\"a4560b8904e9f880\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/action.js\":\"757e75c215929d2a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/index.js\":\"53835ce68e0aed15\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/FindReplaceDialog.js\":\"d312b52324078ca9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/HeaderItem.js\":\"e8eb67b4b83c0c0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/dataExtension.js\":\"7e06409dc0d4e3e8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/index.js\":\"987c19ef572f5d22\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/search.js\":\"dbf9e41ba61ffa05\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/toggleStore.js\":\"79d9fd4143ed3027\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/LocationPropertyEditor.js\":\"23b2806d302c2413\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/MapView.js\":\"fad6e7ed788d6e8f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/blockTypes.js\":\"7231d33ede604cb4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/codeMirrorExtensions.js\":\"8c5dd888b4e2cb72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/createOrFindPlace.js\":\"a79bbe1fda5ee25f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/currentLocation.js\":\"190c2867d56114d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/dataExtension.js\":\"893f9c83e530b4b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/geoContentDecorator.js\":\"090851a0e10a881a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/googlePlacesClient.js\":\"e9aa34f2733b9969\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/index.js\":\"85eaef20c47c15d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/locationsPage.js\":\"5c8eac59ae6ea15a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/mapViewport.js\":\"c6955c95d2b37df9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/pickCurrentLocation.js\":\"d9a6408c44cbd5bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeAutocomplete.js\":\"f36b80c6f6641ec0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeNameCollision.js\":\"479d9e9d9695ae58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/properties.js\":\"10a10f21accb1e3f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/propertyEditorOverrides.js\":\"7ca1022f112d9e2b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/query.js\":\"e1548096ed492ac0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/usePlaceSearch.js\":\"358f72a4beb1dfe5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"38fd5f091b17fbe2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7e08cd70375ac087\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"52cf1040080bf8f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/config.js\":\"f9d81ba5b7a933bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/dataExtension.js\":\"dd80721f622f6068\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/facet.js\":\"9ce830e97cc106b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/grouping.js\":\"c833f0b13d515fcc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/index.js\":\"4ddd8ce53e7d57f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"e05999058145134e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/query.js\":\"b6ffddd816e7c829\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/resolveConfig.js\":\"eac44f6db1d0957a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"0d68e209d22dcfcd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"46bf4a3e4b4b4c51\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlDocumentContent.js\":\"2f904a7a7ed16ca4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlFrame.js\":\"0a0418907094c24e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/actions.js\":\"183070d565d59309\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/blockType.js\":\"01afd2a22d2cebd0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/confirmRunScripts.js\":\"dfc7b137b619e446\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/dataExtension.js\":\"fe151e3affe125cd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameAnnotations.js\":\"b1b726439bd48a2b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameDocument.js\":\"78d37e88f37a192c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameTheme.js\":\"7c0651beec3926ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/index.js\":\"4e27f292642e4181\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/scriptConsent.js\":\"9aaf4aafdadecf5b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/sourceMap.js\":\"0fa178f24022a402\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/useDocumentScripts.js\":\"efaac2e7379a392c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/index.js\":\"52faaeb7c98e6d10\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/record.js\":\"604b34cfb92f670d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/recordStore.js\":\"6406af7235babc00\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/responsiveness.js\":\"519bfb8660b7243b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/schedule.js\":\"81c5f2eade5ddca5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/sessionContext.js\":\"82b61334fb1a0799\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"66865a28c0796096\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ea63ef41a485d315\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/actions.js\":\"a677ee8abd96b7d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/config.js\":\"a1a5418a93fbe5e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/dataExtension.js\":\"e5cba07b3b18aba9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/effect.js\":\"aad8a9165d85e7a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/index.js\":\"917ed9d43a045ed8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/keyCapture.js\":\"483952f7f1b0d3fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/overrideStore.js\":\"0fb305fcbc043d4c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"a3e88c5401507171\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/HeaderItem.js\":\"97cc3eb86ae6c770\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/LeftSidebar.js\":\"73e8592adb5a7b8d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/actions.js\":\"0cc692c4a6d038cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/facet.js\":\"856cfbd66543b195\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/index.js\":\"5ac4a9da90ae8e1c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/shortcuts.js\":\"5f7344f28e027b2a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/toggleStore.js\":\"2effa5c3df86405b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/MergePicker.js\":\"d934626cef2dd0fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/index.js\":\"dc41b6e70e6b9a39\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/mergeAction.js\":\"363d623c6ccc651a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/strategy.js\":\"bf10741404689260\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/Button.js\":\"4d035ce67403d749\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"520177b27ab5c83a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/defaultItems.js\":\"97835d26261919b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/facet.js\":\"e53c83bfec29ed31\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/index.js\":\"62c7f94709e8c34f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d3c2491ad48bad2c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/actions.js\":\"98269099fb708d79\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"66624abc62caa3b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/facet.js\":\"682857b1b9a72d9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/index.js\":\"28963ca704b71788\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/MoveDestinationPicker.js\":\"028f54947d15af7f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/blockSubtreeMembership.js\":\"077616f3efb72f0b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/contextMenuItem.js\":\"139ae57ec2ce0b94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/index.js\":\"2cfb25b12a15bc17\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveAction.js\":\"2748c51e3d6ef62b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveBlocks.js\":\"86490ae45d6c7bca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/selectionAfterMove.js\":\"ec2d2ec0295b8df3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/TutorialBanner.js\":\"6498c5f2c8083164\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/action.js\":\"14f6175325e76028\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/bannerDismissal.js\":\"c367c0a94cb6ce5b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/documents/cheatSheet.js\":\"55a98ed2479a9bec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/index.js\":\"75f16a610afa1404\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/keys.js\":\"95fecb0641dbeca9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/landing.js\":\"b06c916295dfd525\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/outline.js\":\"3d93a46e1450dbd5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/seed.js\":\"940469664ba6df52\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/PerfTrendDialog.js\":\"696d918f5ee0aca9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/analyze.js\":\"d022f862e60011b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/diagnosticsSource.js\":\"397e27a9f6a25154\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/index.js\":\"7e368ae47e625f48\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/load.js\":\"720201685840f557\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/monitorRun.js\":\"fbcfd92de7974eff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/schedule.js\":\"cb109a6e4dfa8bba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/series.js\":\"975553e6ddcf1d8a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/store.js\":\"1f2eba9ac3a17dd9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/trendAction.js\":\"c6c0035163f76ae5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/verdict.js\":\"a95bc23b83e1a361\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/clickToEditAction.js\":\"5abd13880db5f6c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/index.js\":\"63b0b4fdaf780e29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/interactions.js\":\"69e601821af08f8c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c79b810c9a4586f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGate.js\":\"f197a4c20a2beacf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGateDialog.js\":\"595a8ee0d80c1b33\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/action.js\":\"038f830bdcfaca52\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/index.js\":\"3d62b371e1fe6a2f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/localRunMessage.js\":\"777be7db9c98138f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/plugin.js\":\"e481003f2d5ea8e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/progressReport.js\":\"fd0c4dbdf6c171ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/sweepProgress.js\":\"310a3c5f4a425e82\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/FieldRowRenderer.js\":\"f722f636a45df8cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/ValueRowRenderer.js\":\"59ad7838d0a6f2de\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/actions.js\":\"5ededb8e4fb2847b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/autocomplete.js\":\"b5473fc799a2aed1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/fieldRow.js\":\"8c4cb948a648b54f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/index.js\":\"b6e970899eb2434b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/referenceWarning.js\":\"bc193172c5a0d48d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueAutocomplete.js\":\"6c3e92a1bfe1ef61\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueSchema.js\":\"07cf17250e68c505\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/HeaderItem.js\":\"53fc40ecb2108456\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/QuickFind.js\":\"9b2c60c5c4ea7bda\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/index.js\":\"878e369990964b30\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/recents.js\":\"2b48ca128fd65974\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/resultItems.js\":\"86fbba9c32769e3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/selection.js\":\"7fe2125defe7bf2e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/toggleStore.js\":\"72d536c9d73549d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/HeaderItem.js\":\"7905f943a25c08ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/RecentsPageBlockRenderer.js\":\"139edab545827c03\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/grouping.js\":\"1dd57b6d186fe4dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/index.js\":\"b4802cb8ff08e35c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/target.js\":\"8a6797ced475f8a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/codeMirrorExtensions.js\":\"8919a9ded48131ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/contentPrefill.js\":\"96828ad7eb833eee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/dataExtension.js\":\"45b59dd03896ef3f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/index.js\":\"9d6710829fe4ee6a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"98f5ac2a46ec5ab1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/invalidation.js\":\"2ad002433a95c39e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/localSchema.js\":\"ccb8661ff62466aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/index.js\":\"f20b5d74a5c78ce3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d427fe70151f92db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/index.js\":\"5c46b09732bdd480\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/referenceNode.js\":\"72817142a795df86\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ba5b0e094672b36c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"76177f0047e8c1b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/index.js\":\"15cbaf1a2c1f4300\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"e2ccde5a9a27cc32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7922ad141e0a7e59\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/mergeRetargetProcessor.js\":\"0a39210c8a25107f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/parseFence.js\":\"62a596674136251e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceParser.js\":\"1edceb8385bcadf8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceProjection.js\":\"f01c1f2ce121c249\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referencesProcessor.js\":\"5d835481fd960b95\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/renameProcessor.js\":\"641be14f47e38a2c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/spanReplacement.js\":\"672a91c6acc29e88\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/htmlToOutline.js\":\"cbab135790c22e00\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/index.js\":\"70efc17181c5ef89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/normalizeClipboardDom.js\":\"c14a4133ad6f2062\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/pasteDecision.js\":\"38259a14382f009b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/action.js\":\"ac6032b0993b3410\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/blockIds.js\":\"7a147216fe5ee2bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/content.js\":\"5ecf25f7653ed69a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/effect.js\":\"cb1e294e76ebb940\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/ids.js\":\"e1bb8b98c85f0138\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/import.js\":\"220949d199856089\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/index.js\":\"add045e9fe5abefe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plan.js\":\"a7ca1038397fd3b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plugin.js\":\"d3d2c50910ad4ed7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/promotion.js\":\"c4725e6eed9338ad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/properties.js\":\"72d0c49870c720b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/references.js\":\"82a1cc42c1a9d279\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/report.js\":\"4d24dc136cc15ed0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/roamMemo.js\":\"374704b3b8a542aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/runtime.js\":\"dd5ba9b91fbfd5f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/schemaReconciliation.js\":\"c28d93abf6293723\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/srsMarkers.js\":\"20a1dd644b033b2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/todo.js\":\"c2b7fba71860f6ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/typeCandidates.js\":\"d7689bd2e078d22b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/types.js\":\"0d345497798f3948\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/index.js\":\"05fc22b5f45ba7bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/store.js\":\"81a8efe6302f6e46\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/HeaderItem.js\":\"7c08a5aaa37e6a27\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e3587416e54b940a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/index.js\":\"492661cf1ae47173\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/model.js\":\"ccbea971eeda73b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/toggleStore.js\":\"3a75bd21ea37b758\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/useKeyInspector.js\":\"5ac7c6cd93107765\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c4ce36fc23813178\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/ShellDecorator.js\":\"fa9e2479cf1e2c9a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/actions.js\":\"7d6f5b766d2a4f5b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/exclusionsFacet.js\":\"bc8dd43721a5acbf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/index.js\":\"2c2ee2ae884741cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/shell.js\":\"eb7bb5812a70a262\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/surface.js\":\"b51edce35752dc33\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/walker.js\":\"0a9fe23bf5be5909\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/RescheduleToast.js\":\"6d395431527d3036\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/dataExtension.js\":\"7fbcb9970ad22759\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/index.js\":\"10c670460b8a65ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/indicator.js\":\"5269770b9d2b5d9f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/moveSrsState.js\":\"c3595af337b81827\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8ccf3ad7524ef941\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/scheduler.js\":\"f0162ec61b998cc8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/schema.js\":\"d96ceecbf31ee8b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"c3d3428f1cde439a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsClipboard.js\":\"dd94e018cde8f090\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"fadbfa656437f8f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1f826b8c91e7b5bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DeckPicker.js\":\"3298e3ffb4322cb7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewControls.js\":\"d4aa7cde4391dbd0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewDeckRenderer.js\":\"d4988ba6ac2d79cd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewSession.js\":\"5b0172e2be9153ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/actions.js\":\"fc7741e9a9e49e14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/archive.js\":\"3cd3f9169a0c2ca8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dataExtension.js\":\"553150e8cef5f21a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/deck.js\":\"c8fe71aeb024c1cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dueQuery.js\":\"55a2a57702460ce8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/gradeDecision.js\":\"10248d3d2c5fa23d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/index.js\":\"c2da308f719f12d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/keyHints.js\":\"415035f1fca16b12\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewCardLayout.js\":\"00a3a59247066522\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewProgress.js\":\"3a8b70c1e6ebbb3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/schema.js\":\"3549dfb99554ccfe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/useDueCards.js\":\"b6fbc1f57f1840b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/index.js\":\"e019d8d80d0e94e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/record.js\":\"662ce69fc62b80b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/index.js\":\"001ffee8bbd0e772\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/persistenceStatus.js\":\"d9a756b72e8dca1f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/requestAction.js\":\"a60e2a96c0d78120\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/TypeChipsDecorator.js\":\"e842e62faba13bc0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/codeMirrorExtensions.js\":\"ca81a24b438dadbd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/index.js\":\"3afbbee5c4477b1f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/typeAutocomplete.js\":\"7002d9250032d543\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"4cbebfdc38fb91e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/actions.js\":\"392bc6ab301de3d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/anchor.js\":\"4988a99db588cbc0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/events.js\":\"c8ac3905bc7492cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/gestureActions.js\":\"30332e52c8a14092\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/index.js\":\"d8d5949e2c31e301\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9009d80eb0f0acee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/collect.js\":\"1a53222205c4b0c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/index.js\":\"1172f7122631a6df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/record.js\":\"0e40e66aff8341c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/RejectionDialog.js\":\"56b19d4b8861916b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/SystemStatusHeaderItem.js\":\"6fe055b8e926ba33\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/index.js\":\"9c1b35f49f2bad2b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/model.js\":\"b8e825aca541a8ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/queueCounts.js\":\"d2072e8ac9fbc35a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rejectedHelpers.js\":\"6c6f2d1afde49633\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rematerializeAction.js\":\"5ae57cadb39fb01e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/useHysteresis.js\":\"7d1114b16e21ea68\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/ColumnHeaders.js\":\"8de9c48f08e4622e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/QueryUi.js\":\"e504e6aaf9d48a43\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/TableLayout.js\":\"66d85f8c0797887c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/actions.js\":\"572c9691aeab22c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/cellEdits.js\":\"49788019f8c41b8a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/childrenViews.js\":\"c9d6ae3c2635c89f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/columns.js\":\"faeff0652284720e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/controller.js\":\"bf3af83d1c305238\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/convert.js\":\"c33d35f2e776819b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/dataExtension.js\":\"7d66d60749e12568\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/index.js\":\"af5174635fa963bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/keys.js\":\"921084c73e350139\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/model.js\":\"0ee714748873a97a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/QueryText.js\":\"0e0ad9e5f2d44e80\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/backfill.js\":\"87f5f326e196a323\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/completion.js\":\"d23f881c45626f3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/format.js\":\"a43cfa38eb6de318\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/parse.js\":\"fce141f80a1a809c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/queryValue.js\":\"4ad2e2e4de9e0ece\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/registrations.js\":\"0a56e81e7a9357e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/source.js\":\"f953ec32603a545b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/registry.js\":\"03ecfe0a1aa7fe1c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowGutter.js\":\"03323c08ce01eb9d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowVerbs.js\":\"0d97e83923d932cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/schema.js\":\"c5ab9aaded61a447\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/sort.js\":\"b1fd5b3c73362eec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/effect.js\":\"e308240a022c17c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/index.js\":\"bf9df7a354b06779\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/theme.js\":\"c088a541167f64f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/actions.js\":\"a57b622d27891979\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/dataExtension.js\":\"9781453b4ca11519\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/index.js\":\"1cf2271985953ff6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/schema.js\":\"0051fe18260a6636\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/TouchSelectionLayer.js\":\"663a625967bcac0e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/actions.js\":\"16ebacd6b221e037\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/defaultItems.js\":\"b321644da1621f5d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/facet.js\":\"6007e8ff8f5ac2d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/holdRecognizer.js\":\"6a7b971343965eab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/index.js\":\"54630ff6819391e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/UpdateIndicator.js\":\"5e62a69a71a64e14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/index.js\":\"db709157906c53fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/loadTimes.js\":\"20fd8427e708fe2e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoNotesRenderer.js\":\"9ce3d5cb95e7b49b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoPlayerRenderer.js\":\"f7f080453b49c3cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoTimeStamp.js\":\"aa2209d32c49913e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/actions.js\":\"482dc07f11e6c144\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/index.js\":\"40f093187b02e375\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/markdown.js\":\"b4f96b70b4d174e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/notes.js\":\"814ea36daf90a09b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/registry.js\":\"58b453dca2b5a691\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/remark-timestamps.js\":\"a1ef3a3d9cc2d3c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/view.js\":\"19b06bc7716ee90e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/LinkHints.js\":\"caf4693fb7fd403e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/index.js\":\"3bf8c5462a75c195\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/model.js\":\"a5d1b73c57b3457b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/settings.js\":\"78a792636a7c0501\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/actions.js\":\"023171c93cbbc4bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/index.js\":\"9468b88c7a23ef32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/interactions.js\":\"ffe40c4c9fd1c63f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/workspace-header/index.js\":\"783a4a0403598ee3\",\"/knowledge-medium/pr-preview/pr-1899/src/registerServiceWorker.js\":\"df9d0da0410aa91c\",\"/knowledge-medium/pr-preview/pr-1899/src/requestPersistentStorage.js\":\"d44645e160e1e4b4\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authRequestDeadline.js\":\"b8f8c1a096a8f1f1\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authStorage.js\":\"2005622d4622014e\",\"/knowledge-medium/pr-preview/pr-1899/src/services/powersync.js\":\"d430a5a657636fc2\",\"/knowledge-medium/pr-preview/pr-1899/src/services/supabase.js\":\"63b7b58d2bc6ab6a\",\"/knowledge-medium/pr-preview/pr-1899/src/services/uploadErrorClassifier.js\":\"f450d82cb13e9558\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/ActiveContexts.js\":\"1702edcb01df6c1d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/HotkeyReconciler.js\":\"7ed660dedeaaa92d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/WipeLocalDataDialog.js\":\"e9f7397b4a2d3677\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionDispatch.js\":\"f4a6ec3c3d028785\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionRefItems.js\":\"84bb14090f026146\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/applyKeybindingOverrides.js\":\"91573b4674cf900b\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockActions.js\":\"915bc17c2f3acd36\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockMergeGesture.js\":\"277df65ab9fb8f0c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/canonicalizeChord.js\":\"1a0c8b24fe2edf4c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultContexts.js\":\"7c330a7a10884b38\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultShortcuts.js\":\"a642ec98c3f061c0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/effectiveActions.js\":\"127b458bc0caf1d9\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureAction.js\":\"b419874a01b123e4\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureBinding.js\":\"9feea44031b65da8\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/holdRegistry.js\":\"e446f111c7288d88\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingConflicts.js\":\"c93946cb5f5e561e\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingOverrides.js\":\"4eec2aa13d558def\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/pointerAction.js\":\"665cd7c5ddd5b9cd\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/resolve.js\":\"9a9508d4eaebac4f\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/runAction.js\":\"84feecba4def211c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/sequenceMatcher.js\":\"a1d1faba3b62b253\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/types.js\":\"1f14b9a249a9bfab\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionContext.js\":\"153d99d053358199\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionDiscovery.js\":\"b11c7d99cc260c39\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/utils.js\":\"d66b233c5d0ed33e\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/bootStore.js\":\"4aa8372c144ceae9\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/previewDatabases.js\":\"dddee076fe685a3d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/byteTransform.js\":\"1d5b8e90043d02fe\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/attachmentCleaner.js\":\"54a832fdef0add18\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/attachmentParts.js\":\"208dcc8ebe04f1f6\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleParts.js\":\"43805cefaba7c7c7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleRecord.js\":\"247437ca6b83b28b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/manifest.js\":\"cbfeabaf69c3b300\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/takeBundle.js\":\"5b28f35e674fa5b5\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/verifyBundle.js\":\"d274d61144a8476c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/cleaningStage.js\":\"04da7de405f00744\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionKey.js\":\"7385fe9ee55ba064\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionServer.js\":\"dd56170242048aa4\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flip.js\":\"82903ad15dbf9b60\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flipAttempts.js\":\"4fceaa8a46423fa1\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/pages.js\":\"c7c5b5b2dad5fd6f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/preflight.js\":\"a2c1228f8d0ced7c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/reseal.js\":\"373eb30f724a974b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runConversion.js\":\"51f05051975494b2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runLock.js\":\"151f1e59f8b0b9ff\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealing.js\":\"43416e3cd55645ed\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealingStage.js\":\"1cf8dccfc9a00a24\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/stage.js\":\"beb984092ce1d25e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/verifyReseal.js\":\"a2a472729799c320\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aad.js\":\"db329617095920c7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aead.js\":\"9c501a0931f42214\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base32.js\":\"da88aefd613e56d4\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base64url.js\":\"16465eba02c6e87c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/binaryEnvelope.js\":\"d0bfface69651729\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/byteAead.js\":\"882aca9351684098\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/canary.js\":\"b157b289125a0d42\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentHash.js\":\"ed6c09fde5db933a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentKey.js\":\"acb058952215f45e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/derivedIdNamespace.js\":\"87f02d4f49c26da6\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/envelope.js\":\"1521057484c0941a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/hex.js\":\"121b27dff046487c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/sha256Hex.js\":\"8ce667ac60f2c3f2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/workspaceKey.js\":\"e42e0b3462033405\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/conversionState.js\":\"dc81b5cc9b15e73c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0153505d94b7a1d6\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/pastedKey.js\":\"db3900609aac8875\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a3f269ae1e2e0737\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b9c262b446445e2b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/keyStore.js\":\"bfb0b797084beaa2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/mintWorkspaceKey.js\":\"2992d731d8e9922b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/modePin.js\":\"bd4d91ecd00b83db\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/openWorkspaceKeys.js\":\"e9f4e834af226f91\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolveWorkspaceEntry.js\":\"58125afa6892dc5a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolver.js\":\"f9e41298d9fb450c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/workspaceAccess.js\":\"f830a5caa522780e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/transform.js\":\"3b0f21b0138ea865\",\"/knowledge-medium/pr-preview/pr-1899/src/themeBootDefaults.js\":\"a003287b97183c67\",\"/knowledge-medium/pr-preview/pr-1899/src/types.js\":\"bf591dcf70ae834f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/ClientLocalSettings.js\":\"a135fd160ae74ef4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/abortableSleep.js\":\"0e5ea3f3f577c798\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/array.js\":\"3bb2fe0f7f852dd6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/backlinkAutocomplete.js\":\"8914f629997d8edc\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockCrumbs.js\":\"c9ea5ae66bceb825\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockrefAutocomplete.js\":\"64e71d5146c2b6cc\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/cadencedIdleJob.js\":\"b918db0378f8fef9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/callbackSet.js\":\"24cbfc0f2f4091aa\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/clientId.js\":\"bdbbea955de9dbb2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirror.js\":\"17717ec66b34b483\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirrorCompletion.js\":\"071586976e11fb59\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/copy.js\":\"9f99aafda323bbc9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dailyPage.js\":\"566b31a2dc9c173f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensics.js\":\"a1b9c441f0176ff6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensicsHooks.js\":\"3b09daeca4f7f10d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/deleteBlockThroughUi.js\":\"31f58b461b9bc1d7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dialogs.js\":\"694098c1605e4c53\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dom.js\":\"f64e0266167aa865\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/downloadBlob.js\":\"55adbe373887dbc8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/drawnWalk.js\":\"66aef49bc3231965\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/exportSqliteDb.js\":\"09a9d5691ba6ccd2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fileSystemAccess.js\":\"38386449de39bcb3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/flipSlide.js\":\"f161947fa2d11b7b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fnv1a.js\":\"1835de64f6813463\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/formatBytes.js\":\"b25b10cfc80cc49f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fuzzyRank.js\":\"b2fe7a3c1914f3cb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idbKeyedStore.js\":\"8781689b4af91be1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idleCallbackPolyfill.js\":\"bc7d8a595dae3435\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardAwareScroll.js\":\"81a215e83ed1ab15\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardViewport.js\":\"adcae7e893a473f4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/lastWorkspace.js\":\"5d03fa2661898e6d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutColumns.js\":\"85ee562f755aa67e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionDom.js\":\"d904311281621bd6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionId.js\":\"aee0e34326a00a4f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkClickGestures.js\":\"6146e30e7a7f7051\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkTargetAutocomplete.js\":\"bfa345f6e00f3f0e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbCorruption.js\":\"454f8ae081abbcc5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbRecovery.js\":\"e51330547a104661\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/markdownParser.js\":\"5f5b8ea8b4b7f6aa\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/memoize.js\":\"02341c5173051b72\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameFieldCommit.js\":\"71eac4b990e36566\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameList.js\":\"0a8080986b842e51\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/navigation.js\":\"6402f23096ebb996\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/omnilinerNamespace.js\":\"13249b38edba5419\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/opfsPageScan.js\":\"8edab9d990ce5de5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelClearance.js\":\"bfc97bb2f0431958\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelHistory.js\":\"ab19a9b0bd3f8b67\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLanes.js\":\"20a61cdcb48b1ac6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLayoutProjection.js\":\"a2e1636ac415bcab\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelScrollAnchor.js\":\"0412f069282ec703\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelUrlFlags.js\":\"02d55a4e61643236\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/platform.js\":\"c0d55687a630f5e0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/pluralize.js\":\"93fa174dd96dae34\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyCreation.js\":\"413a804e2fe90ed8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyNavigation.js\":\"9fdf3c683d61af3f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyValueContext.js\":\"56b1795c7d2aca0d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/react.js\":\"8470b7904f4f6612\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeDate.js\":\"6be1fd3ab4faba2f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeTime.js\":\"1f0fb1ada41170ad\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/renderScope.js\":\"505a6b39493b43e1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/resolvedThenable.js\":\"0597b52ae601a886\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/routing.js\":\"baa891047f146b98\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/safeMode.js\":\"bcecd8503b68b2eb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/scheduleIdle.js\":\"f23afe9ac6de85e7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/screenWakeLock.js\":\"649eb4096ef03b5c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/selection.js\":\"0984bdfa509fb93a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/softKeyboardGrab.js\":\"a3dd4803f8d3023a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/startupTimeline.js\":\"8293340d266f67e4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/state.js\":\"b110de583443555e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/string.js\":\"a6bc2eab355e0505\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/surfaceZoom.js\":\"f703ca65ac07d9b1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/time.js\":\"6f94be0c8d94734b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toast.js\":\"4a57e2ed13a8d118\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toggleStore.js\":\"b20c1a4772eeb649\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/untilStopped.js\":\"de7451337079313c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/userActivity.js\":\"7b49f3f8c3494426\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewTransition.js\":\"73f9ec45ffb2014e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewport.js\":\"e86108b3eb0c6b7b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/webLock.js\":\"ad031c36abe9bb0b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceRecovery.js\":\"4c1de85bda8576c8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceSnapshotStore.js\":\"e33b83bf8e299c03\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-compiler-runtime.js\":\"62a2daf1c09404bd\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-client.js\":\"3e9ed2dcff908d9c\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server-edge.js\":\"7cedacae789a7c6f\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server.js\":\"844b0213046d589c\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static-edge.js\":\"61a33fee6b235ec2\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static.js\":\"1982ee46dff5157c\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-test-utils.js\":\"dbab367fe7b5e154\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom.js\":\"73c1746f2d9ccae1\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-runtime.js\":\"0410738f03975824\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react.js\":\"8911a77204cd2566\",\"/knowledge-medium/pr-preview/pr-1899/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
