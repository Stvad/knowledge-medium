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
		buildId: "bb5592764e63-661fde85",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/\":\"7229e2e2403c5f26\",\"/knowledge-medium/pr-preview/pr-1899/index.html\":\"7229e2e2403c5f26\",\"/knowledge-medium/pr-preview/pr-1899/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1899/assets/FacadeVFS-B9jLqfab.js\":\"763eb4093bd8fee9\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSCoopSyncVFS-DtwLKy83.js\":\"f73515a3f3333054\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSWriteAheadVFS-BONy0fP0.js\":\"887ab736a6c34c93\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-DLFUAwdX.js\":\"a0e59f29cbc87ea2\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-BshiGTRj.js\":\"4e27ce816562316b\",\"/knowledge-medium/pr-preview/pr-1899/assets/worker-Bk7aBePL.js\":\"d82d7b0a70bac9ec\",\"/knowledge-medium/pr-preview/pr-1899/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1899/chunks/app-7C27XE4I.js\":\"4890d6741e537e27\",\"/knowledge-medium/pr-preview/pr-1899/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1899/index.js\":\"4bc3cdf7abb12126\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1899/assets/AccessHandlePoolVFS-CyBIsY5o.js\":\"0af4b2b63384cece\",\"/knowledge-medium/pr-preview/pr-1899/assets/IDBBatchAtomicVFS-qTpzDvaH.js\":\"d09c029ddd907795\",\"/knowledge-medium/pr-preview/pr-1899/assets/MemoryVFS-Cbqj_-X1.js\":\"db2fee2b41dfcb76\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cof1KQIi.js\":\"e3aa4671dc972e48\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-C6Nt3FpC.js\":\"ad2ce872698709cb\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1899/chunks/AccessHandlePoolVFS-CeT1h_Il.js\":\"45a5fde44c05612a\",\"/knowledge-medium/pr-preview/pr-1899/chunks/FacadeVFS-lA0by-j5.js\":\"8cda9440442c79d9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/IDBBatchAtomicVFS-xs7cAGDO.js\":\"cac1f4930070e4cb\",\"/knowledge-medium/pr-preview/pr-1899/chunks/MemoryVFS-K66E4ZZM.js\":\"15a20d5772ca04f0\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSCoopSyncVFS-Bw-Nzfk2.js\":\"82cf2e03ec486b6f\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSWriteAheadVFS-v-NEhc4-.js\":\"3166603da629c093\",\"/knowledge-medium/pr-preview/pr-1899/chunks/Preview-BMm6FOTf.js\":\"6137849fcedc482d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/card-D5z5_DFs.js\":\"57a2a9775c77e91d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BknOHhI9.js\":\"9e813539b7e2609a\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-KOTd-Jz-.js\":\"830f130835e933c7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-async-DXpyFyuH.js\":\"07d730191d5534b9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-0i5Sc0U6.js\":\"51ab13a8bcfbd15e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-780lsTxd.js\":\"eb2a2ec81e707078\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-C5XVJL9Z.js\":\"1ae74dd3624a4719\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DMJGchEE.js\":\"ac57f8aa40b2b7ec\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-Dt_iS-Yz.js\":\"466e5e55e0a963bc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-QV7K3AVm.js\":\"3c13681f30828e89\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-_1u_LVsM.js\":\"8972fc42708612d5\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server-legacy.browser.production-B4DEfTco.js\":\"aadede7f0555fdf5\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.browser.production-DTX2ft7i.js\":\"97b0540fd0a11a1d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.edge.production-BIvPfFK2.js\":\"5c37244e3085e06f\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-v1HLXLf5.js\":\"a752261cdd18170d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/server.browser-DhqVXm3V.js\":\"1b41d641994e8c82\",\"/knowledge-medium/pr-preview/pr-1899/chunks/textarea-ClFkCuJm.js\":\"61c4a90e2965daea\",\"/knowledge-medium/pr-preview/pr-1899/chunks/ui-Cejj8Hl9.js\":\"aa003b7c2921ea0d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-async-KolfQSRg.js\":\"1536c52324bb822c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-jj9ouo2A.js\":\"026bb57fad7ed299\",\"/knowledge-medium/pr-preview/pr-1899/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1899/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/src/App.js\":\"dc1b4c4d16bda9a8\",\"/knowledge-medium/pr-preview/pr-1899/src/appUpdate.js\":\"e7dfb1ebcc8dacb5\",\"/knowledge-medium/pr-preview/pr-1899/src/appVersion.js\":\"b45074a1efa9c849\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/initialLayout.js\":\"712daa69afca21cc\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/openWorkspaceData.js\":\"1667b5371a9d8efb\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/resolveWorkspace.js\":\"d82d8deaa9eda757\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/workspaceBootstrap.js\":\"88feed8b7b517af8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockComponent.js\":\"0a2561b6fe7c5c60\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockCrumbs.js\":\"62e02e53862be4c6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockEditor.js\":\"bbc15113ed3498b4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockLoadingPlaceholder.js\":\"a5635485fc92b960\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockProperties.js\":\"8f6eb2f3925a2bde\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockSearchPicker.js\":\"0f9939c2f9aa481f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ConfirmBulkDeleteDialog.js\":\"4d03f07da168bb91\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DividerHandle.js\":\"9b777806a568bc91\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DraftEditor.js\":\"550e934a64ddc65e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/GutterPill.js\":\"69f9cd37a8c85a20\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Header.js\":\"657976c0d03150ba\",\"/knowledge-medium/pr-preview/pr-1899/src/components/LazyBlockComponent.js\":\"8b3b830966b74a5f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Login.js\":\"320644e3e67b234d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ZoomableSurface.js\":\"c278c3f18c83f770\",\"/knowledge-medium/pr-preview/pr-1899/src/components/editModeKeepalive.js\":\"0c534dc4ebc594d0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b83c0381054bea43\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3e6407d89af254be\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefPropertyEditor.js\":\"bb280df182a07d24\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefTargetTypePicker.js\":\"3562087f651b4f1a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/SelectPropertyEditor.js\":\"6497066b3b5dce7e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/TypesPropertyEditor.js\":\"5924b5d3fe2b9939\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/defaults.js\":\"1015a9860d6ff2bb\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/kernelValuePresets.js\":\"baa55fb4f7f392c7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/selectablePresets.js\":\"dc28cd059e8ac03e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/typesPropertyUi.js\":\"9f7520ba3a98a47d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/AddPropertyForm.js\":\"017b7978bbf840c8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyPicker.js\":\"ab3f163760ddfbd0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyRow.js\":\"e783883fed6a04f3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/Rows.js\":\"81b6b8a4d7f14ab2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/actions.js\":\"98e5381d34a57037\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/declarationOnly.js\":\"3e219d868ec6c2c6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/layout.js\":\"b81e0bc6eb473bb3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/model.js\":\"f0e7aa6f7c28c4d2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapeUi.js\":\"7876fdb0a19d623c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapes.js\":\"05cb750b0333db4a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/usePropertyEditingActivation.js\":\"53794c02fd40f94d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/visibility.js\":\"14206f461785b8c0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanelSections.js\":\"b704c422aaaba65e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockEmbed.js\":\"2f9f9b3ab97189a9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockLink.js\":\"6b905c50b2ff1ed6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockRef.js\":\"44ac5223570856e2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/CompactReferenceLink.js\":\"e8af312b586ee4c0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/ReferenceLink.js\":\"243b49f2328b1502\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuard.js\":\"f9053d39aeb0f6c2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuardContext.js\":\"2662f280a22cdf1c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/linkInteraction.js\":\"30d85d3aa7e3c18d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/referenceLayout.js\":\"d3b00c36963e78d5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/useBlockRefAncestors.js\":\"4d7bedc7edcd278b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockGutter.js\":\"a59dd9e7713572f0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockInfoDialog.js\":\"971dce867fb756fe\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockReadText.js\":\"3344d1b7ad1a9f33\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockTypeBlockRenderer.js\":\"02e9e1ee3baf0a8b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BulletHoverCard.js\":\"3bf5bbf10ce90ea5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorContentRenderer.js\":\"b0cecb87b6262212\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"aad3f93e6d1a7727\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ColumnResizeHandles.js\":\"bdfb433fcb3b1dd8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"370ec53040d50863\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/DefaultBlockRenderer.js\":\"4dcc1ef66b0bee95\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/LayoutRenderer.js\":\"5370937055389f7d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MarkdownContentRenderer.js\":\"5035b7f1edde85ed\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MissingDataRenderer.js\":\"8363cd96518e895c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PanelRenderer.js\":\"83c76d26bfa6bece\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PropertySchemaBlockRenderer.js\":\"decea29f1bec23e4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/TopLevelRenderer.js\":\"530a78d34cb63640\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockGutterMode.js\":\"274ced03e183ac66\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockTitleText.js\":\"6b505ee236f5fea9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/fieldCreationKeydown.js\":\"3f05496e2d01ebb3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/layoutRootContext.js\":\"e94efcaef90f414f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/TypeChip.js\":\"1b1ebd023b29f0fd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/chipStyle.js\":\"e136cd6839072f46\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/anchored-floating.js\":\"59dcb13efe1f82ee\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/button.js\":\"a98796fb1ab5f7fd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/card.js\":\"8e8a4b96443813b6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/checkbox.js\":\"4f542f64fb09e5c7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/collapsible.js\":\"bb86cc977f8aa3f0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/command.js\":\"8ee0f23b888a6881\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/context-menu.js\":\"8c6005c2adefe31e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dialog.js\":\"19e20b9d381fdee1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dropdown-menu.js\":\"604bdadcecebbe16\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/floating-listbox.js\":\"a074748ce8ddee1f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/index.js\":\"b0ddfd821e53a51f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/input.js\":\"c30312285ddfee54\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/kbd.js\":\"557736d03061cccc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/label.js\":\"4c1212d65479de9b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/textarea.js\":\"f97a4c5b5823c317\",\"/knowledge-medium/pr-preview/pr-1899/src/components/useEditModeYieldKeepalive.js\":\"ca4d18ea53f27175\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/BootFallback.js\":\"3432a10ec3f5ac4f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/FocusedRowLazyMount.js\":\"6c7cd8a6071b43bc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LazyViewportMount.js\":\"67cd3d11366d18d6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LocalDbCorruptionFallback.js\":\"05e210fbda77bd55\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/error.js\":\"cd62c0c32506584f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/lazyMountRegistry.js\":\"da2883e74c11c91e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/suspense.js\":\"a61a5175fbe710d7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/CreateWorkspaceDialog.js\":\"dede11c39a45689c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/PendingInvitations.js\":\"9791fee22260c7e0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/SyncProgress.js\":\"6c0a02fc5f602935\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/UnlockProgress.js\":\"fa17dc39a6e356c4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceKeyGate.js\":\"7be8534591e5b5c9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSettingsDialog.js\":\"43799e6d56400807\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSwitcher.js\":\"95757bdf436f4165\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSyncGate.js\":\"5cf58fb744bb82ca\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlow.js\":\"3d8823a8411df2b8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlowHost.js\":\"4dee6cd41caffd4a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/EncryptionSection.js\":\"95f7d93ddcabe37c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/attachmentPrompts.js\":\"a6f4ac4d55c7b14d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/bundleFolderPrompts.js\":\"741325fad624cc7a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowDeps.js\":\"87ac978b478cef0b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowStore.js\":\"4e1980ca53dec637\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/flowUi.js\":\"79a304248bed3bfe\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/useConversionRun.js\":\"143e85329793575b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/keyUi.js\":\"97b4e8ec46eedfb9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnKeyLoss.js\":\"ab17ee61f579c669\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnServerE2ee.js\":\"74593acd8ece064e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/workspaceUnlocked.js\":\"19ede095f19f20a1\",\"/knowledge-medium/pr-preview/pr-1899/src/context/backgroundSubtree.js\":\"297abce8d6d782f4\",\"/knowledge-medium/pr-preview/pr-1899/src/context/block.js\":\"d39ce79c520d068b\",\"/knowledge-medium/pr-preview/pr-1899/src/context/layoutWsContext.js\":\"fc9c2881ac1653ef\",\"/knowledge-medium/pr-preview/pr-1899/src/context/propertyDisplay.js\":\"5131d5445832e0db\",\"/knowledge-medium/pr-preview/pr-1899/src/context/repo.js\":\"960a892b156d987e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasClaim.js\":\"024175a85b2d7102\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasSeatNamespace.js\":\"fbf381173462f83a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockData.js\":\"0644fdf4711f5c03\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockType.js\":\"b308794b45feec44\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/changeScope.js\":\"2c367cea31280bf0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/codecs.js\":\"7902c37c0b1d956b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/derivedData.js\":\"43df3fd090fc6996\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/errors.js\":\"9e914e3240344ae3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/events.js\":\"d296313affebd4bb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/handle.js\":\"ce126398c3d053ce\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/index.js\":\"8ffa86f500ac432f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/mutator.js\":\"6569c0c564d91e3f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/processor.js\":\"a5edb075b584e960\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/propertySchema.js\":\"fe5cb5b9ff80c5ca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/query.js\":\"c7a7809a551f8f47\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/sameTxProcessor.js\":\"e73d19a709de3ccb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/schema.js\":\"ce126398c3d053ce\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/tx.js\":\"ce126398c3d053ce\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/typedBlockQuery.js\":\"2033d5bdcba0a4a3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/user.js\":\"798d28f72419ea4d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresetCore.js\":\"2a256bcae5d0ab0f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresets.js\":\"0aba19a1a10a7ca2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/attachmentCleanerIOVerb.js\":\"1d1e48128ee65ec1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/block.js\":\"99c7974de68863a6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockCache.js\":\"c1cbd3bbe4eb41b3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockId.js\":\"3f84dfc0697e7cd9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockLiveness.js\":\"b412c089179e793d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockMerge.js\":\"b820d35f22818af3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockSchema.js\":\"9f9f3e29c18eb05e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypeLookup.js\":\"5708b65562175817\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypes.js\":\"24a3582c955788f6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/childrenView.js\":\"afb7ecd78a56c846\",\"/knowledge-medium/pr-preview/pr-1899/src/data/clientContext.js\":\"6b07bdd7a8f40e9c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/dbFileSiblings.js\":\"a085b06a57bcc2f4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/definitionSeeds.js\":\"7d36c85c0bf579de\",\"/knowledge-medium/pr-preview/pr-1899/src/data/derivedIds.js\":\"ac7a0fff90d62a43\",\"/knowledge-medium/pr-preview/pr-1899/src/data/drawnSubtree.js\":\"2586fbd1f148583d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facetBridge.js\":\"49f384f66b0aaec8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facets.js\":\"f47fa53a4031f721\",\"/knowledge-medium/pr-preview/pr-1899/src/data/globalState.js\":\"c378a3b82e661c24\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/aliasClaimRederiveProcessor.js\":\"c3d8172bac0e2b0a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/ancestorBatch.js\":\"31cdff0d53caf8a6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/blockTypeTypeifyProcessor.js\":\"8af0a60e39c0d503\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/clientSchema.js\":\"8059e6eac8196713\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/commitPipeline.js\":\"c2a21bf417f8971f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/devAssertions.js\":\"69f84cbb25f70d35\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/firstSync.js\":\"b4d563a4528ed68f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/freshInitialLoad.js\":\"3edd01ef213e96e6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/graphBackfillClaim.js\":\"adaa9196049fc257\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/handleStore.js\":\"c89c2549b8f1e0b7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/idleMarkerJobs.js\":\"009842f14948bf22\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initialDownload.js\":\"f93d34940033a672\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initializeClientDatabase.js\":\"2ca98b973644dacb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/jsonCanonical.js\":\"ccc434a4a1f30abf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelInvalidation.js\":\"33d13cf60974be5a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelProcessors.js\":\"7cff9322d32ed375\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelQueries.js\":\"f84444fef861e00a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/mergeTypeMembershipProcessor.js\":\"01d7f285d47d0503\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/normalizeReferencesProcessor.js\":\"335365a172a735d4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/poolInstrumentation.js\":\"2b37163452595924\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/processorRunner.js\":\"cb8cb0f9bc067c53\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyCellBackfill.js\":\"1155e51b52d5c88d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildMint.js\":\"a60370ad67262e73\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildrenProcessor.js\":\"897157900971df1c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionChangeProcessor.js\":\"20dae20de609df9d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionSynthesis.js\":\"787ad160b1ea3926\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyKeyScan.js\":\"ecc7e60a7d0bf603\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertySchemaResolution.js\":\"a4cc72dfa922853a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyValueEdits.js\":\"edbf121607240bf1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/raiseProtocol.js\":\"8aa58ca2ff44ed5a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/readBatch.js\":\"991e8073e2f63da1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/refProjection.js\":\"ef3087df3155d5d5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetLookups.js\":\"58f2ec43cae2c1c0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetProcessor.js\":\"a05238c18c24637c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/replayMerge.js\":\"608ca7f8ed1061c3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/sqlBinds.js\":\"361cf9ac6e5290c2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"d7d24e10259e000d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/arrivalProcessors.js\":\"decfc7fcf5b0d1df\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/invalidate.js\":\"7f46d376c9dc1d60\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/materialize.js\":\"d20448da27ce8083\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/observer.js\":\"b576e469332205cb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/reconcile.js\":\"8fe17dfba8a7eb8a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/timingMetrics.js\":\"91042e1158d7f6a6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/treeQueries.js\":\"6ed629ab67992e89\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txEngine.js\":\"b69f94e628c3acfb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txSnapshots.js\":\"517e8031e806fc88\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/typedBlockQuery.js\":\"96e28e3d3b916f5a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/undoManager.js\":\"f6f1ea2288d0a90c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/invalidation.js\":\"1802a5efb97eaaf2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelDataExtension.js\":\"70999042c4d1310d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelPage.js\":\"bf9fd89372695437\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelValuePresetCores.js\":\"923fba9d272f6131\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbCorruptionSignal.js\":\"e6f8227f7bb89d07\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbStorage.js\":\"31f6e39bde052d9d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbVfs.js\":\"76db6a5dbb6dc4a6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localSchema.js\":\"f5438dd5cba462d9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/maintenance.js\":\"714b6efa93a131c7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mergeProperties.js\":\"213c5808bb4b7ef1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/metricsConsoleHook.js\":\"3e09cc2d4e0569d1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/migrationsPage.js\":\"15fd626e3c10c238\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mutators.js\":\"1c6e80829dc619af\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKey.js\":\"b8c2eb8bfca5763e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKeyPlacement.js\":\"4db0e128557fa4d7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/outlineSurface.js\":\"1b07ee55bbbf0f9a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingEditorContent.js\":\"cbaa6e51073ca625\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingUploadsSql.js\":\"b32daa37b5cad655\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pluginStateExtensions.js\":\"485a7f0294a98d89\",\"/knowledge-medium/pr-preview/pr-1899/src/data/powerSyncLogger.js\":\"ce2e1e05ea960efd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/projectorRuntime.js\":\"ea762f7bd14dae3d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/properties.js\":\"a54a201d80e0c79c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertiesPage.js\":\"0078f0f5b3f9bc9a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyChildren.js\":\"aa9caf1be256fc0e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionFanout.js\":\"bc3f521e700411a7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionMetadata.js\":\"18aefaaf35134514\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionRegistry.js\":\"8718e6f33988f329\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDisplayMode.js\":\"1395b77f30e99978\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyRowCreation.js\":\"281f92ac32217931\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySchemaCreation.js\":\"ef52c9c56364545f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySeeds.js\":\"222bb07750c086a7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/recentsPage.js\":\"a282e282a366603a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/refTargetComparableProperty.js\":\"45ab137816416151\",\"/knowledge-medium/pr-preview/pr-1899/src/data/referenceBlock.js\":\"e146c7a60014ea57\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rejectedUploads.js\":\"49fd74d1419881ae\",\"/knowledge-medium/pr-preview/pr-1899/src/data/releasePowerSyncConnection.js\":\"a19708c548ab30e0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repo.js\":\"ad7d31aadc9ab33b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repoProvider.js\":\"a4cfaa9f4666a411\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rowProperty.js\":\"878a43c328733d23\",\"/knowledge-medium/pr-preview/pr-1899/src/data/searchFilter.js\":\"c1ac2a39d528456d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/seedIdentityLedger.js\":\"902ac7dab3112674\",\"/knowledge-medium/pr-preview/pr-1899/src/data/stateBlocks.js\":\"80d1eb4412aea72f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralEditPolicy.js\":\"c6232ca654b08782\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralInsert.js\":\"73de2497a3a65bc9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/subtreeDelete.js\":\"0f59103cc3fb9084\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncStreamLock.js\":\"1b1572faa4cb87d6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableSqlRecognizer.js\":\"dc66c9ee9b39dc7b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableWriteGuard.js\":\"08c600cdbecac2ed\",\"/knowledge-medium/pr-preview/pr-1899/src/data/targets.js\":\"46007abadff05521\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeColors.js\":\"382324e4bfad8d8e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionMetadata.js\":\"105cbf32191cbdb5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionRegistry.js\":\"947dd697bc31d681\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeExtraction.js\":\"da8393fd3413627b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeInitialValues.js\":\"1d4ba9f0d9617fb3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typePropertyGroups.js\":\"14883fd78b8c1f41\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeSeeds.js\":\"7f8919068e1aa6bc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeTagger.js\":\"a4dfd1d415d8f3da\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typedRecords.js\":\"260e39ae9d6db78e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typesPage.js\":\"65137680479d656a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userPrefs.js\":\"3b9fb94e77682b6a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userSchemasService.js\":\"873a94d0a8886a53\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userTypesService.js\":\"42fe21a474e10291\",\"/knowledge-medium/pr-preview/pr-1899/src/data/valuePresetRegistry.js\":\"eb95d48bad0dce1d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/visibleChildren.js\":\"2667e4863ea1da04\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceConversion.js\":\"f508e782c7ec9bef\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceFirstSync.js\":\"76263d5616c0eb95\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceIdNamespace.js\":\"05a66609b53c4e2f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceSchema.js\":\"24ec290fbd8dbf18\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaces.js\":\"e79fdc5fe8ec6577\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadLog.js\":\"caf20bf7e4463068\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/BlockPasteShellDecorator.js\":\"a1ece4f1593d16e6\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/atTrigger.js\":\"20205d06ddc28d0f\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/autocomplete.js\":\"642dbc0da2d74c9f\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/codeMirrorExtensions.js\":\"9e7d1bd25a17c436\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/contentFlush.js\":\"9cf50be824b0e1d9\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/defaultInteractions.js\":\"a630ebfda2a469a8\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/editSettleSignal.js\":\"d23a7742505449b5\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/insertImage.js\":\"ea81b796824aa2b0\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceCompletionRange.js\":\"5fa970089470da6b\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceTargetTypes.js\":\"cde2f06d41513ab3\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/syntaxContext.js\":\"6ce78e4cb4edbb79\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/triggerMatch.js\":\"6443a3bfdc670991\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/AppRuntimeProvider.js\":\"b1a0d00477c8635e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/BlockFocusShellDecorator.js\":\"6e5b7cdffc9e8740\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/ExtensionRenderBoundary.js\":\"75c51d99ee8fc9be\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/PanelContentRecovery.js\":\"31e7fbf0ead0d224\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/apiCatalog.js\":\"3227a62d6e6cdf8e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/approveExtensionHere.js\":\"167d50aaf71364be\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/armedCutAppMount.js\":\"d85416d9c76c61c6\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/batchableKeyedStore.js\":\"06b1e9a4bc4f5cbb\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockInteraction.js\":\"a237759aeda7d20e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockSelectionAction.js\":\"040176e6aa52cf43\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compileExtensionModule.js\":\"055690a8fd47d1d7\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compiledModuleCache.js\":\"cf5c7a792f578a24\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/continuousGestures.js\":\"b84e0868b6f5c312\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/core.js\":\"f691b07c147b26c2\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/defaultRenderers.js\":\"3872f707e20c25b8\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/definitionFanoutAppMount.js\":\"08fd0b7360d9e0b1\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dialogAppMount.js\":\"5df741a515e1ef86\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensionSeeds.js\":\"7ecf1ff851c60d2b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensions.js\":\"3f29c65362e36f26\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/exampleExtensions.js\":\"b02370b451ae6f36\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionApprovalStatus.js\":\"254c2efe621a41c1\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrorToast.js\":\"3a45d2fac6293bfc\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrors.js\":\"fe8336459913784a\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLookup.js\":\"382a26601d4d6889\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionToggles.js\":\"3d8dd4cadb2716dc\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionUtilitiesCss.js\":\"7c817568a024f46b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/kernelPageDeletionGuard.js\":\"c1b35b81a8c0098f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/liveRuntime.js\":\"8e0891ae559bdebc\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/openExtensionsSettings.js\":\"e2bcbf93b32f9143\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/overridesCache.js\":\"c021baba7ef4d2f8\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/pluginIds.js\":\"cd87d5685a07f6d5\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/processorRejectionToast.js\":\"3bcef8d9059d5824\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeActions.js\":\"e05c90958679a625\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeContext.js\":\"77ddaffbd929bf61\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticAppExtensions.js\":\"8fb18fa66246801e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticDataExtensions.js\":\"b0fe8fd8ff0caef4\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/toastAppMount.js\":\"fe108760e4d79b60\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useOverrides.js\":\"0fe05e90da44aa85\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useShortcutSurfaceActivations.js\":\"2f74af09d480515b\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/discoverToggleTree.js\":\"6899652a37cd7a03\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/facet.js\":\"b040f822e5881c6f\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/resolveAppRuntime.js\":\"490184af176074e0\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/runtimeEvents.js\":\"b92ab7442375a68c\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/togglable.js\":\"0690a3df0660619f\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/variantFacet.js\":\"a4e99e4f0ebf3bd8\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/verbFacet.js\":\"4b7304776809a924\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/block.js\":\"611b9ae1c7eea708\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/focusedChild.js\":\"1c9f2bfd8c044276\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/propertySchemas.js\":\"0df064485877df65\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/typeRegistry.js\":\"015a8b5e84fc1797\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAncestorCrumbs.js\":\"d63e7d56a7e596f0\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAutocompleteListbox.js\":\"eb6ee15be30142c0\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedSearch.js\":\"30cea0ab74f71b33\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedValue.js\":\"a7e8fb8e6052c13a\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useFacetValue.js\":\"b812b825d860f3d1\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsFocalRender.js\":\"322dfa0ae03ff7fb\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsReadOnly.js\":\"15eff955ebba8959\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMaterializeBacklog.js\":\"0ce651660fcbd994\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMinuteClock.js\":\"74a8be4f2a345af1\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePanelLayoutProjection.js\":\"f8d20299599d98cd\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePendingInvitations.js\":\"579f6733eed72b5e\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRendererRegistry.js\":\"1db44bd3217718c1\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRetainedFieldRows.js\":\"1cef0089b9163bd9\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useWorkspaces.js\":\"720b122d6f31a06a\",\"/knowledge-medium/pr-preview/pr-1899/src/lib/utils.js\":\"662442b981a60f7e\",\"/knowledge-medium/pr-preview/pr-1899/src/main.js\":\"ca3e015b9b501b7e\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/MarkdownImage.js\":\"eb42a9eb2dce5fe8\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/blockSeparators.js\":\"ed40e40c9112643c\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/context.js\":\"450b70a28f6c7aa0\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/defaultMarkdownExtension.js\":\"046601e8471696a7\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/extensions.js\":\"a1a0f096c5a7102a\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/renderMarkdownHtml.js\":\"baba7409f3ee4bfb\",\"/knowledge-medium/pr-preview/pr-1899/src/minimal-editor.js\":\"d7600ca9aee2b732\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/armedCut.js\":\"67ce1be2e85e27e1\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/captureMediaVerb.js\":\"8ab4a7605929cd33\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/clipboard.js\":\"e855cae0e70a079b\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/decision.js\":\"a99e898a00657a12\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/operations.js\":\"adaab1c1341b1687\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/AccountHeaderItem.js\":\"cf4166555f1c47c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/index.js\":\"f5572391dd0ffd52\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"506efe9ae447f33e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askAgent.js\":\"d79ceac2499e8f05\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askedStore.js\":\"47e858c6102df39d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"98b9bf3814dcc57a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/chipState.js\":\"ff24c186d74f202c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/dataExtension.js\":\"620a174a5628c83b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/index.js\":\"55d8bcd208fe3d58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"597ae50bac781539\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/schema.js\":\"93c9c2216a71b110\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/AgentTokensDialog.js\":\"f42fe4f0cd3f5961\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a94890a6fa146b98\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/addMedia.js\":\"593aa87d580ef4bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/backlinks.js\":\"2295c899a77f4f45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/block.js\":\"13c711938beaf9ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/context.js\":\"84510b99cbf688ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a8668421e4542cd0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/index.js\":\"106b38d2af0ab807\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/outline.js\":\"38feb2ae74393422\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/properties.js\":\"cd5d32a866bd380b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/refs.js\":\"368aa7d94314f372\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"7c6d0969bb51a60b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/search.js\":\"8e1326a209398368\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/shared.js\":\"d9e6d7b009010e09\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f4b4907d454d6705\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/text.js\":\"a815ef90cf6d3da0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentWrites.js\":\"c5ddc8e3e08ed653\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/authoringCatalog.js\":\"426c8e12aa9bfe11\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/blockRefTargets.js\":\"8eb1195050d57ac8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridge.js\":\"a86948bf3868e7ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridgeLoop.js\":\"27fac22b8630265d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/changeHistory.js\":\"81fd81175a5781e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commands.js\":\"288bf839d1639abb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commentsCommands.js\":\"19a278db6ac2a200\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataExtension.js\":\"07f73425a7867fae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataModelGuide.js\":\"59b6a0426c894321\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dayPropertyInputs.js\":\"9e6fa1ef22f54da8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/describeRuntime.js\":\"5355c3e12163ffeb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/extensionLint.js\":\"5061c87d8f7ad609\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/grainAudit.js\":\"7cbc4c38901093e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/healthCommand.js\":\"69549a87a750ef7b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/index.js\":\"7c4f60b635be254f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/presetIdentity.js\":\"8466dd3510a35b77\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8362c4b77721ead9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/readMedia.js\":\"c211ccb933255581\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/schema.js\":\"9188c462edf9e09a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/serialization.js\":\"0cbbfb5f3c1f42f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/targets.js\":\"82209073c9ccd9b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/tokens.js\":\"c0d9d9fb2a2ec61a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/watchEvents.js\":\"bf170242cf9f7a33\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/workspaceGuard.js\":\"ca8e6ca7c5b4f4a3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/writeCommands.js\":\"0b140b321c2a0e0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/AliasCollisionToast.js\":\"f72059ce7ef1a9af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/DuplicateNameBanner.js\":\"5e5b2e88f08e3d73\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/collisionMerge.js\":\"2f761eea4468fd09\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/dataExtension.js\":\"582ec4e96abd90be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/index.js\":\"c91fb005ace8e8e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/mergeCollisionAction.js\":\"d1ef0c358ca6ab89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/pageStyling.js\":\"af4e3513a068cdf9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/rejectionToast.js\":\"16579f439a330a3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/syncProcessor.js\":\"537bc9dde9f535e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/actions.js\":\"4475d820aefe9721\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/addComment.js\":\"967f529b2fb01318\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchor.js\":\"bfe3ff9aabdf3942\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchorState.js\":\"6687b66b569615b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/commentLinks.js\":\"34507679d67c025b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/confirmThreadDeletion.js\":\"8345f4cdca1d7a69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/container.js\":\"da0c50da3a15f41d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/dataExtension.js\":\"cd8a6d4cca55af30\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/deleteComment.js\":\"9093c8f28ff15543\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/highlights.js\":\"56075420f5b5c29f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/index.js\":\"fcd99d9533716edd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/linkedCommentsPill.js\":\"75f02e4f6e2e6b4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/margin.js\":\"2b88843e12619558\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginAnchorLinks.js\":\"977b080e578059c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginSchema.js\":\"506c745722b4feec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/newComment.js\":\"fdd88791453bd3e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ownThreadPicker.js\":\"8ae376ddf4c65306\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/placement.js\":\"51d0d73239a9722f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/queries.js\":\"b2b7fdb147e38e00\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotePosition.js\":\"fe605642d118f927\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedIn.js\":\"8ca9a57d88adc4b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedRange.js\":\"60854360e1badc3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/rangeRefs.js\":\"4a8643b131d20efc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readHighlights.js\":\"08143148867ff9a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelection.js\":\"77079f63f5bdf7eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelectionUi.js\":\"737cfec25105d960\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/reanchor.js\":\"3ad2f859b78cd715\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/schema.js\":\"fd3406fb97ccc5bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scope.js\":\"4d23f2b3f0a0a643\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scopeThreads.js\":\"abe0864834be46ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/splitRetarget.js\":\"5b795f414893db8a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestionCard.js\":\"06b6cc60159ef31b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestions.js\":\"5a79b9724d357808\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaries.js\":\"623653377331e126\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaryBatch.js\":\"f6dba04c7f1caac7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/surface.js\":\"b745a3f8b3a09ba1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threadNavigation.js\":\"7a4c813abaed8d49\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threads.js\":\"add7025ce57f7180\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ui.js\":\"68d2518a2920d3a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/uiStore.js\":\"b3252381eb49531a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/appIntents.js\":\"1ff68a8988428b51\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/index.js\":\"38b69c0a647d5d56\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/index.js\":\"cdd53f9e042a5c41\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/status.js\":\"f2be58af6b1a4be1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"8b0388c7d262025e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaBlockRenderer.js\":\"ff77bd0a0777f8f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b09512496eaa4784\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaUploadReconciler.js\":\"aa5bb9d801590d15\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetDownLane.js\":\"296b47c8fbad898a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetResolver.js\":\"7a15dfaf521387c0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetUpload.js\":\"e95c69ad0f7688a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/attachmentCleanerIO.js\":\"8b217555524404de\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f72c2655c0f9315c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/blobStore.js\":\"bac383d3f8114737\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/browserMedia.js\":\"38375ea08bc2b991\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/byteStore.js\":\"713d4641994e004f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanerIO.js\":\"dcf1af08af756d2a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanupAttachments.js\":\"eae014c08d277ac4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/dataExtension.js\":\"a4a6e70a3b9bb0f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/downLane.js\":\"35772fda77ee6a48\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/index.js\":\"dfdea5c0b6191115\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/insertImageContribution.js\":\"436350cd30517f3f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneArming.js\":\"8f4272c45dabf37c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneLock.js\":\"fc2ec21ef0f59030\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaBlock.js\":\"ad6d8678e9ef97b2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaCapture.js\":\"5457ed53cc7aaac0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaLanes.js\":\"ffd66b225d76a658\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewers.js\":\"3d5f172cf9bf8ad1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewersFacet.js\":\"09084e765b360bc6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/pasteCapture.js\":\"22eb3248861d53cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/resolver.js\":\"3d0d3ee587e18ce4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/retryUploadsAction.js\":\"715d1e4b8d325132\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/storagePaths.js\":\"87c76ec4cb40af2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadDrain.js\":\"bb95c3721aa710f1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadLaneStatus.js\":\"8a4d2fd11cbd87bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadReconcile.js\":\"64e239ef4eb4a7e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadRecovery.js\":\"9798d7059e6530c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadStore.js\":\"f15fb23dbc6694e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/useAssetObjectUrl.js\":\"b457b94f75e23300\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"79b431c232f5de64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5514c5a634065d44\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/facet.js\":\"0084de023eb60052\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/index.js\":\"8605bcdb13805915\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/prop.js\":\"f1c02ea30bc1c781\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinkFilters.js\":\"3a19abe7fe6b333a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9e08a5182f5f7170\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BlockEntry.js\":\"5d8eb3d5fbadbb69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/LinkedReferences.js\":\"d944446f8b6a0f85\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5e266c157c6708f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dailyNoteDefaults.js\":\"72d07b4661c75348\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dataExtension.js\":\"76e31cdf0dadedcf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/edgeExclusions.js\":\"46755af6a6f67c0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/filterProperty.js\":\"db657759c7dfe7c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/index.js\":\"9b3940356630628b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"72f062096183f8a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/applies.js\":\"801aacb1bda01bba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/countQuery.js\":\"a5c9a44f68d0ba7b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ecc00206492168ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/index.js\":\"8155c4810eb5c158\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"6b2ea1eb061a8dee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/presentationInvalidation.js\":\"4cb4e1de2788f252\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyEditorOverride.js\":\"58c3191f3eda7761\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyFilter.js\":\"a88e5e43393220b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/query.js\":\"fcb0bd5959dc8ba8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/resolveFilter.js\":\"4cb15c025b3beb34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sourceBatch.js\":\"66022b3cee2ab41a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sources.js\":\"6ebeb30108dd6a9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useBacklinks.js\":\"aebc8ff6461c21a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"9d8f26888c6fd095\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayCelebration.js\":\"c3eb6ee949a6e47e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayOverlay.js\":\"34bc799e4f44b7c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/gate.js\":\"cfea74107139e7c0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/index.js\":\"5d573ac92e93aa7f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/wolfTheme.js\":\"c725ffbff1d7fb7e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/BlockDragLayer.js\":\"cbc62792d7d162c0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dragController.js\":\"e184a708d4392de3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dropTarget.js\":\"d8f947418172dac7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/index.js\":\"80de55c85656ace8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/projection.js\":\"8065be275f6d0bd7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/BlockMetaCard.js\":\"67dd7390e1ab3599\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/index.js\":\"197431b417a59fb8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/AddTagDialog.js\":\"983e46f9d433ec62\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"fc1cb0916c20862a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/TagNameIssueHint.js\":\"0e4420c389dc5c45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/addTagAction.js\":\"10a53c0db8ad6b52\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/appendTag.js\":\"825c2e5825f0c45b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/config.js\":\"32ece7f6e2b876c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/dataExtension.js\":\"ab764c0b1eaab79a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/index.js\":\"2487f5b554b2b11f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/propertyEditorOverride.js\":\"df697817d1a16c0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbList.js\":\"2722212ed512769b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"760e3a197a86f2e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/Breadcrumbs.js\":\"779727db45dcb1f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e248c708e9068ada\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"980689d8738d5efe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/index.js\":\"9358c44bdfd41861\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"4f24a0f053a8230c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/CharacterCountItem.js\":\"6c094641b2a059e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/ProfilePropertyEditor.js\":\"d7cea2bfc1a8a0be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/actions.js\":\"d07d2f7c594547eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/blockType.js\":\"5dd49dd55f12a8d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/charCount.js\":\"526ba832d1ef5879\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/dataExtension.js\":\"63d574eb197d7877\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/index.js\":\"6dbdfb6a06b1ad0e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/profiles.js\":\"82bf5ac7aad2ac67\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/properties.js\":\"97baeb8117761e2c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/subtree.js\":\"4fc5c821137cea71\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/textCounts.js\":\"86bfd220f46208c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/colemak-keybindings/index.js\":\"693218eff16052e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/CommandPalette.js\":\"42a83c400355c62f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/HeaderItem.js\":\"7e8b3d1a0f95e43a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/context.js\":\"00797c2582a743d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/index.js\":\"1727ca9b3b26744e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/selection.js\":\"fae220347c485a62\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/toggleStore.js\":\"0c233ddc2e7fcf7b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/useCommandPaletteActions.js\":\"56ecebd45383007c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ContributorBadges.js\":\"fc2520422775be2b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ProfilePicture.js\":\"7f7418c3337e58c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/author.js\":\"a476e4fad52abab2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/codeMirrorExtensions.js\":\"93ce49f8d82489d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/dataExtension.js\":\"3c244cd43607f1fb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/index.js\":\"905e57b760cb1e07\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/mentionAutocomplete.js\":\"73ba09844cb8eaeb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/processor.js\":\"5f1502af48556935\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/profiles.js\":\"a5d17d5d23bba693\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/queries.js\":\"d48f17662e0fb4c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/schema.js\":\"a254c0e870627a81\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/useCommentAuthor.js\":\"e95799c16e9759d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"71bf575965af0448\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/followOrigin.js\":\"3f6e39905628f788\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/index.js\":\"347d855a76756ad7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5ded8b29591b4eae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"efb1a37c5864be8c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/CalendarGrid.js\":\"19c4e1e871aa891d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DailyNotePicker.js\":\"e872ccdb5c6505ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b2f6e0b8339f4cc3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateNavDecorator.js\":\"315ea27140729882\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateScrubOverlay.js\":\"bd1ef849672d566a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayPropertyControl.js\":\"b8e0219be71a962a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayValueReferenceControl.js\":\"dd0dfec879277988\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/HeaderItem.js\":\"cd6405e432a95398\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/ReschedulePicker.js\":\"07dd4c7bdef5be63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/SpreadDatesDialog.js\":\"64eec5f14dd8b28b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/actions.js\":\"9e3232e4e5023a2b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/blockDateAdapter.js\":\"0b527623fcaf2cea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/calendar.js\":\"9f858ce95e8041c0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dailyNotes.js\":\"ff9ce874434b14c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dataExtension.js\":\"c8f885aa8f1a7c44\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubActions.js\":\"7b46f917f74888ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGesture.js\":\"456ef897f96555e8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGestureActions.js\":\"4e6272970d4ccf59\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubRecognizer.js\":\"15aa82da62f3f2b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayProperty.js\":\"6d7e749fbc957a38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"4afc44ace695c1ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/deletionGuard.js\":\"8b6d8ddd93a25668\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dueQuery.js\":\"eb4a3c6076c00364\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/index.js\":\"3263749780db12df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/landing.js\":\"a6a8cee6cee1c655\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/localSchema.js\":\"6329fa599f3f77cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/referenceDateAdapter.js\":\"bd14e19aa705d1a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/rescheduleAction.js\":\"48daf73f248f9bd4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/schema.js\":\"cba784e71bd9e3a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadBlockDates.js\":\"108ce37231dad664\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadDatesAction.js\":\"61d15441dac625a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/today.js\":\"5f8fbe237a316551\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"097eb268d01d0174\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"dac8f2b9b24b388e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/audit.js\":\"2d9626f01c23eaee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditAction.js\":\"b4e120db01787383\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditRanges.js\":\"e51bce4caa587834\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/diagnosticsSource.js\":\"187538a4480659a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/divergenceScan.js\":\"c355f0ec15086773\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/index.js\":\"ea5acb9534c7e1dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e8e152af299510dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/referencesMirror.js\":\"fd1f512e2cbb9d3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/rowJson.js\":\"de03b514ba48704f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/schedule.js\":\"ebe8621a508d89b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/store.js\":\"448e783e28661d84\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/action.js\":\"16f0a7caeb0abd17\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/index.js\":\"bf6f0276cf0d8596\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/plugin.js\":\"a89b764962dd20d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0d5434460bcc946d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/actions.js\":\"151993bf0857cd0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/changeMarker.js\":\"06821157b8ec4924\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/diagnostics.js\":\"cb2e8aa014e22d62\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/fileSystemAccess.js\":\"9937b2a412e77ecb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/filenames.js\":\"faa2b12c828c5b03\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/index.js\":\"fd4083d59718cb98\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/mirror.js\":\"7eda29bed8c256f1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runLock.js\":\"4cad0f74b71be0d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runtimeHealth.js\":\"d0775c25adcef45e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/schedule.js\":\"361e70656a051d72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/store.js\":\"012318edbe70be7a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/index.js\":\"dd8769a8965042ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/themes.js\":\"56edde73e55d57e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/facet.js\":\"1025df3e080c26c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/useDiagnostics.js\":\"b567570b2e085b34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/dismissals.js\":\"d850353096defb30\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/index.js\":\"09ada1d11ac016c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/status.js\":\"52ff38f95511db47\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/store.js\":\"becdca5a9d1bc110\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"684463022220307d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a7d7a585d7b7a3a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/actions.js\":\"2b5abd8f03c29608\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/config.js\":\"1c531063017d0775\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/dataExtension.js\":\"9b0c08fa96702acf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/effect.js\":\"44366af4d0275691\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/index.js\":\"f18a830d35cc8c1a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/propertyEditorOverride.js\":\"97861374e0347c62\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/useToggleTree.js\":\"0370c566f547adb7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/ExtractTypeDialog.js\":\"278ab261dffd14bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"bc97280fc11ac285\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/PropertyShapePicker.js\":\"12004900c971610f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/action.js\":\"ee9288966a5009ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/index.js\":\"2e2b601de2888df0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/FindReplaceDialog.js\":\"3adc458042a9a40a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/HeaderItem.js\":\"fba582194b819cd0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/dataExtension.js\":\"f70d98de3bb09c91\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/index.js\":\"b884eaadd18bf175\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/search.js\":\"377a9e59831d69c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/toggleStore.js\":\"583bdf464b0ffb25\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/LocationPropertyEditor.js\":\"b84eb733f84487fb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/MapView.js\":\"397ab819c8b11a96\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/blockTypes.js\":\"f45b556d8168c7a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/codeMirrorExtensions.js\":\"81f1b70984e68ff8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/createOrFindPlace.js\":\"c94303c8dc881271\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/currentLocation.js\":\"20ece1b993ceba3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/dataExtension.js\":\"92f9c91b640a4a3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/geoContentDecorator.js\":\"892eb7423d99699c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/googlePlacesClient.js\":\"d5a91e71cabfcc24\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/index.js\":\"5280d2679aa0077d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/locationsPage.js\":\"5315afffac9c0829\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/mapViewport.js\":\"c315c86d49b1445d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/pickCurrentLocation.js\":\"e28d4d299c7cf75d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeAutocomplete.js\":\"f0ff36761c0a12e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeNameCollision.js\":\"67ec3587e2ba1a0b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/properties.js\":\"b867095a3e380617\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/propertyEditorOverrides.js\":\"30725ce3a5198084\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/query.js\":\"5be3abc4dd7343ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/usePlaceSearch.js\":\"4ce2c2eeb95c777f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"557c186d7f877939\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"62dd11270e7a5ae3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"07a5c244f72a6177\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/config.js\":\"fdb58fd8380e8148\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/dataExtension.js\":\"135bd4ba0bb31912\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/facet.js\":\"1e413777faef9a71\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/grouping.js\":\"f0b0efda959ad9a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/index.js\":\"d43af409384f4695\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"9aff8ef21eb734bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/query.js\":\"4ae3876c3d1899be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/resolveConfig.js\":\"d1b7b22a770cc591\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"b6f6b8096cbb58f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e815b08ec4d0a08c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlDocumentContent.js\":\"31e1087f884099d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlFrame.js\":\"e2ce5e74004f4489\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/actions.js\":\"7b3bbf88cc621968\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/blockType.js\":\"d5b672787b18d299\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/confirmRunScripts.js\":\"758f9f1bba35952b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/dataExtension.js\":\"a0bc5462699a023b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameAnnotations.js\":\"509a9e31ce086e1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameDocument.js\":\"1692c8d79d937f84\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameTheme.js\":\"10dea9c1bccfd79a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/index.js\":\"7b26d8a946507e31\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/scriptConsent.js\":\"23bbedd33dae5411\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/sourceMap.js\":\"5bc245e5b5f8438e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/useDocumentScripts.js\":\"9a71613470b52e0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/index.js\":\"0761fa4d6077523f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/record.js\":\"5603cf7e20f6dbff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/recordStore.js\":\"f7225fda3decde13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/responsiveness.js\":\"3658cf82dc3618d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/schedule.js\":\"372a5b5c83f5e687\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/sessionContext.js\":\"40ca4634be17b232\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c9f4e84f1f9651a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"197d9a629ef8b26d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/actions.js\":\"1b121c1d4ac513c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/config.js\":\"0e07a604ab2d1851\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/dataExtension.js\":\"d626ce4f19c95809\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/effect.js\":\"cc27726f424baccc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/index.js\":\"20693ebe9a85b8d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/keyCapture.js\":\"ad5c0adcf2b008c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/overrideStore.js\":\"a24f58f0de16c26b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"cdccfd1d5dd62e45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/HeaderItem.js\":\"e69cb9b5410b4ae3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/LeftSidebar.js\":\"d5b06207d4c7df0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/actions.js\":\"80df1a34f4b32551\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/facet.js\":\"c6fd68ace083f362\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/index.js\":\"d2cb03f636b3ad68\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/shortcuts.js\":\"49d9ab6ae4b7cced\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/toggleStore.js\":\"8cceaba0f86c4b03\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/MergePicker.js\":\"904a94d7c1eb7a20\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/index.js\":\"950fcc530c112ae5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/mergeAction.js\":\"8a1dc453edf40458\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/strategy.js\":\"f7ffdff40531578b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/Button.js\":\"8457cc808bf0362a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0792ae6ef768817d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/defaultItems.js\":\"30033c55e1dabeab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/facet.js\":\"ed0cc1706e088132\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/index.js\":\"c3743bb28afb3e6e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"ec95b2e29aa79165\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/actions.js\":\"29d56018cb6f1ca7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"9de1ebfe7a04cf15\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/facet.js\":\"66e9f90d8d1bf07d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/index.js\":\"cc05a035229bf922\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/MoveDestinationPicker.js\":\"860bbc4c3819b829\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/blockSubtreeMembership.js\":\"6b18464357b192a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/contextMenuItem.js\":\"d7fdeb024273f9e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/index.js\":\"3be47498ad85c7fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveAction.js\":\"c5ed7cbc469831df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveBlocks.js\":\"4987308280ea5e29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/selectionAfterMove.js\":\"02c2b6c88c2d53c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/TutorialBanner.js\":\"5a5a53e31aca004d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/action.js\":\"177fe8c8725dade1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/bannerDismissal.js\":\"f7ab906e9b2651e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/documents/cheatSheet.js\":\"0fdf1c381d375180\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/index.js\":\"275f45c613c09cc5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/keys.js\":\"63875dd8eb0a295f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/landing.js\":\"b1499208b70c2736\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/outline.js\":\"9284d8b9ab1c904c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/seed.js\":\"0d8e3cc72cbcdd8d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/PerfTrendDialog.js\":\"6c5724e63fae7344\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/analyze.js\":\"4cd0adb8cbd3a792\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/diagnosticsSource.js\":\"b293ee256dbb9707\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/index.js\":\"7fae14cc780e18a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/load.js\":\"1ed1a0e40613bc34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/monitorRun.js\":\"56d6354d316b8b6f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/schedule.js\":\"bd3efc6c6325a1d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/series.js\":\"a92909c7d2a92547\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/store.js\":\"f7061989ca5d5052\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/trendAction.js\":\"e5a4d284a5c8810e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/verdict.js\":\"c8b87314b5041207\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/clickToEditAction.js\":\"49f2504d05c0efca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/index.js\":\"56f25575b77d789e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/interactions.js\":\"990b1124f73a2200\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"94991f884da6c7ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGate.js\":\"8d92138b02b9e28b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGateDialog.js\":\"e927aedb1e017115\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/action.js\":\"14382fe1f2b91fd6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/index.js\":\"e5381a44f4ffcc72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/localRunMessage.js\":\"d3eedc094f7fa0cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/plugin.js\":\"f22ff712522d8641\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/progressReport.js\":\"61c121051180b99f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/sweepProgress.js\":\"4fc7cc4bbc9ff82a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/FieldRowRenderer.js\":\"0fe178f39421fc29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/ValueRowRenderer.js\":\"da77a49c5ea92ce9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/actions.js\":\"db05ae84e6e2c021\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/autocomplete.js\":\"d518b6dd576dad00\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/fieldRow.js\":\"633d8082c5811cac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/index.js\":\"33fa98d1a93939ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/referenceWarning.js\":\"4d50f5b3dc53e7da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueAutocomplete.js\":\"2a7e94b07fb91733\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueSchema.js\":\"4423cfc564acdc9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/HeaderItem.js\":\"cc8b030a34ae201e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/QuickFind.js\":\"175c61bf26cec659\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/index.js\":\"0c97eb9c50e2893c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/recents.js\":\"35493ceebf56032c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/resultItems.js\":\"4cef786803fbefa7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/selection.js\":\"b59f4cfbded51870\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/toggleStore.js\":\"cdbcd71e4fd48c71\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/HeaderItem.js\":\"8570d4f49cea076c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/RecentsPageBlockRenderer.js\":\"1329c462f3760f52\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/grouping.js\":\"32f38d5478b8935b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/index.js\":\"242f2403ed24325a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/target.js\":\"fc7606deab92259a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/codeMirrorExtensions.js\":\"16ce397c5752aa3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/contentPrefill.js\":\"e5ab65b94c5f5b3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/dataExtension.js\":\"6cd5916fe92065af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/index.js\":\"b849f45ca6511ab7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"934303c93773abd8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/invalidation.js\":\"98f6718cc2b36843\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/localSchema.js\":\"be95be7bd95b6626\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/index.js\":\"3ddb665d95cccd8d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"18e316537f7bc985\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/index.js\":\"5b82f8a0effdcfa1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/referenceNode.js\":\"d3bf96130a9cc417\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/remark-reference-occurrences.js\":\"eaf55cffb3714f2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"11d58b23b5655ae9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/index.js\":\"3cd33b61f6dddc09\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"af478751a202c956\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"949f0721dc9570d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/mergeRetargetProcessor.js\":\"31ee4caac935d5b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/parseFence.js\":\"9e57edb913b8cba4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceParser.js\":\"b73ac34a72e53a22\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceProjection.js\":\"75276ff5c5c67e9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referencesProcessor.js\":\"9035796e276009f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/renameProcessor.js\":\"b7206401764ee7bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/spanReplacement.js\":\"e760307057d4371a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/htmlToOutline.js\":\"805f8dcb5d92eeeb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/index.js\":\"8873a267e89242a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/normalizeClipboardDom.js\":\"851abae7a7690e32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/pasteDecision.js\":\"424ff3ffb93564af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/action.js\":\"0b8b19dbfbebfbb5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/blockIds.js\":\"a11f29ff3d9b9f5e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/content.js\":\"c48b9dddb7bd8a2f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/effect.js\":\"59dc2fdbb336c32b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/ids.js\":\"dcd52203f2d5427f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/import.js\":\"b027e3fbc9fdad6c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/index.js\":\"0ee01729056db73d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plan.js\":\"0e07934109988ca6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plugin.js\":\"973266b8ccdf21ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/promotion.js\":\"9e4a7e91c3553c26\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/properties.js\":\"263f91cef5ff50d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/references.js\":\"93606ffed31e5522\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/report.js\":\"1f8abd5c92d61cd7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/roamMemo.js\":\"b68cddc6d9a99b71\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/runtime.js\":\"c099086e4863b872\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/schemaReconciliation.js\":\"b7b6ed4dda70be34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/srsMarkers.js\":\"ecb49a5b61a1d44f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/todo.js\":\"3c603ee578a83ba1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/typeCandidates.js\":\"dc416b44563a64aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/types.js\":\"0550e51cff2482b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/index.js\":\"53292441dfcecdda\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/store.js\":\"ae800b5cb26cab71\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/HeaderItem.js\":\"01205a1fcfdf2f70\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a6e49c82961e9486\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/index.js\":\"6255775994ac6231\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/model.js\":\"e99a859c4b1bd40e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/toggleStore.js\":\"c3f8c17ebb6f961b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/useKeyInspector.js\":\"0dcffdd4ad418071\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"dd90090a39f17679\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/ShellDecorator.js\":\"ff91436f91e49f3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/actions.js\":\"e772821642d229d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c755b5d68f2f4054\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/index.js\":\"94b5fc1e5fb2edf0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/shell.js\":\"eaa39d4356bcb0e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/surface.js\":\"9c384ac0e62731b1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/walker.js\":\"8711652e058ab87b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/RescheduleToast.js\":\"911b81d7a4a137a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/dataExtension.js\":\"745c5d4524da1b13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/index.js\":\"78fa3bb2e806d1d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/indicator.js\":\"4f16b629157b06a3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/moveSrsState.js\":\"5603fdeacab592d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8ef73cb37ce67b8e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/scheduler.js\":\"252df8ceb7ab9ed0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/schema.js\":\"505da4cf831cc94f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"7695ede039ea7c9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsClipboard.js\":\"57804653314ea59f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"cfa9721f6f520a05\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DailyNoteReviewHint.js\":\"03c5920be90b12d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DeckPicker.js\":\"4e33483613dd167c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewControls.js\":\"07fc9400fceda2cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3384d8497a71240b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewSession.js\":\"eb312c4a89fe0462\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/actions.js\":\"24110d1ae895f6e3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/archive.js\":\"8b8667623bfcfbcf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dataExtension.js\":\"50eea7bb0f1d447b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/deck.js\":\"fdba07a25d28bac3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dueQuery.js\":\"e82ea19c4f63fa99\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/gradeDecision.js\":\"8611382979ce79a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/index.js\":\"6cad03ac51346e84\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/keyHints.js\":\"d0e9acc3c2488085\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewCardLayout.js\":\"81f86d0aac3bb2aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewProgress.js\":\"9811817e49f2a5d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/schema.js\":\"010c9c637017088b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/useDueCards.js\":\"d60edb33a77aa9c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/index.js\":\"400abdbf10204c5d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/record.js\":\"e6b76f15c1ffc774\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/index.js\":\"7c1746e7bdd4f033\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/persistenceStatus.js\":\"f111441bb3c5af95\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/requestAction.js\":\"b8c82874e5067fa9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/TypeChipsDecorator.js\":\"8c5f24e0141a529c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/codeMirrorExtensions.js\":\"bea3e161988ffe1a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/index.js\":\"b90b96ef48e8d4fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/typeAutocomplete.js\":\"043be9cf6b37d97a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"197bfd32224e1fd5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/actions.js\":\"d056559a5edd055e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/anchor.js\":\"1c1fd918ab8f7b64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/events.js\":\"13b921a2005bca52\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/gestureActions.js\":\"13e33ac2987eee2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/index.js\":\"4c18ec8789d9f7e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"df016be9d2361ec2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/collect.js\":\"9d336eb68165fa48\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/index.js\":\"4aa8b086798fcfae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/record.js\":\"2825c2730c6e45e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/RejectionDialog.js\":\"db6096fbb48b5dfc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/SystemStatusHeaderItem.js\":\"66640de2e45f758d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/index.js\":\"013612311adf9ae4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/model.js\":\"bbb96cf3bde16fab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/queueCounts.js\":\"ba15ee1b4bae152e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rejectedHelpers.js\":\"2f2c13c9404cd2f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rematerializeAction.js\":\"e8512eb631e4deda\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/useHysteresis.js\":\"4ee6faa9291825fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/ColumnHeaders.js\":\"ca5dd0629b82a918\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/QueryUi.js\":\"1f729e5179e1010d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/TableLayout.js\":\"6a6093d6583e1f77\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/actions.js\":\"ef5f2ea72f7cbe90\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/cellEdits.js\":\"7bd2bebf083b8d7a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/childrenViews.js\":\"b30d714f5ba7d135\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/columns.js\":\"e957b38858ff3f6f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/controller.js\":\"47bef93c59f44f81\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/convert.js\":\"57d82e72bf354cf8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/dataExtension.js\":\"37014b56b0b62c13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/index.js\":\"863a251d37ce0598\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/keys.js\":\"c6514a79bd956358\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/model.js\":\"f30587b0c242dbaa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/QueryText.js\":\"14a7f3c4c177bfed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/backfill.js\":\"bd4bbd063070752e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/completion.js\":\"690bdcef3e29228e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/format.js\":\"1ee2705131a3ed32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/parse.js\":\"aad71e147d2c74d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/queryValue.js\":\"5d17055535d166a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/registrations.js\":\"670ba1eae3ff456f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/source.js\":\"3a1a3821fa3920be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/registry.js\":\"430a2b2f3cf3fae3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowGutter.js\":\"3628ed5935675164\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowVerbs.js\":\"26523f4841d9ab40\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/schema.js\":\"33fe65d3f4b97063\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/sort.js\":\"b5713ce3f2f2c76a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/effect.js\":\"b419dc0b464491cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/index.js\":\"280da824f512bf9a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/theme.js\":\"c07c2e8807c872ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/actions.js\":\"c01106705775d1ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/dataExtension.js\":\"32f5b7d5e3e2862c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/index.js\":\"ac8d5143f75fc5e8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/schema.js\":\"4816b92c23493488\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/TouchSelectionLayer.js\":\"32cb7f3d4d98a2d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/actions.js\":\"7eca5472f37f2341\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/defaultItems.js\":\"bc3d6ba1252898b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/facet.js\":\"09b98dbe3821c2fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/holdRecognizer.js\":\"7ce2ca57f0578c1b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/index.js\":\"afad48e3dde7e455\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/UpdateIndicator.js\":\"a3f15f38ef861746\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/index.js\":\"fe2928cd6e1718c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/loadTimes.js\":\"1099520e7f0f235e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoNotesRenderer.js\":\"72fb722fdd6719fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoPlayerRenderer.js\":\"a928ca3eac2e416a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoTimeStamp.js\":\"5b4dbb3156b8dd83\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/actions.js\":\"969d51b2cc1ce225\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/index.js\":\"f5bc886ece44c644\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/markdown.js\":\"32ebc430814cc995\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/notes.js\":\"35275d5927f9aadc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/registry.js\":\"f8bf829c0246da79\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/remark-timestamps.js\":\"08519930337ea54b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/view.js\":\"6da08123a689cb2b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/LinkHints.js\":\"ff67a3c4721aba21\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/index.js\":\"8258f98c6007151c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/model.js\":\"b17c6a1e74312c79\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/settings.js\":\"881a2e7cd19575da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/actions.js\":\"85f24193ce7a2d89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/index.js\":\"fe91c082a37d9a29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/interactions.js\":\"c5b47f076ab14b44\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/workspace-header/index.js\":\"4a5e13518c6bcc5b\",\"/knowledge-medium/pr-preview/pr-1899/src/registerServiceWorker.js\":\"f381ef8ca7906bc7\",\"/knowledge-medium/pr-preview/pr-1899/src/requestPersistentStorage.js\":\"a357741c41f934c7\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authRequestDeadline.js\":\"a960768a3a22804e\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authStorage.js\":\"b4f17d1d61b8a39f\",\"/knowledge-medium/pr-preview/pr-1899/src/services/powersync.js\":\"9ba5b6dded6c80eb\",\"/knowledge-medium/pr-preview/pr-1899/src/services/supabase.js\":\"090d7dec8b84a60e\",\"/knowledge-medium/pr-preview/pr-1899/src/services/uploadErrorClassifier.js\":\"9ce64c34ba4c731d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/ActiveContexts.js\":\"4371a75d0a66cc8b\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/HotkeyReconciler.js\":\"b2507586448b8376\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/WipeLocalDataDialog.js\":\"f00c3bd384bc1cd8\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionDispatch.js\":\"698c297e178fdaa9\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionRefItems.js\":\"0303f5c19bc6ca9f\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/applyKeybindingOverrides.js\":\"1bfd317c79c94b8f\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockActions.js\":\"f9744545d896f048\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockMergeGesture.js\":\"6bbac71b95a078db\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/canonicalizeChord.js\":\"55030d8b9afd2945\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultContexts.js\":\"dc8451c190385d04\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultShortcuts.js\":\"0fd9b3bfa66bc91a\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/effectiveActions.js\":\"c7f1c62daee8e59c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureAction.js\":\"4b0e90fdd44e96d7\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureBinding.js\":\"02b1ce3e729f2219\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/holdRegistry.js\":\"5e9e1beb36390b3d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingConflicts.js\":\"7ce488da72a62f73\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingOverrides.js\":\"9af32e8e142a0237\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/pointerAction.js\":\"f406faf6185d2d8b\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/resolve.js\":\"7a4f6f93021bbd14\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/runAction.js\":\"05ac6121bc6975a5\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/sequenceMatcher.js\":\"5f77764886f30a0c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/types.js\":\"d4d3d6b33edaf207\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionContext.js\":\"9e6200350b62740f\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionDiscovery.js\":\"c505c6df4e6447b0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/utils.js\":\"22520b9e393df709\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/bootStore.js\":\"6bbfedcfb0c664b0\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/previewDatabases.js\":\"1ebbb7d3879c8837\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/byteTransform.js\":\"c8df3db603e5236a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/attachmentCleaner.js\":\"741717bd4dbf1d7b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/attachmentParts.js\":\"0b97ea7d3049bf93\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleParts.js\":\"a8944f15945c8f3e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleRecord.js\":\"c9e3c61d6423d311\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/manifest.js\":\"b63a69443247e2e5\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/takeBundle.js\":\"11cd7a932c27c189\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/verifyBundle.js\":\"ef8cd43d3cfcffc9\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/cleaningStage.js\":\"44671e9198b631d8\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionKey.js\":\"c57ca76dc380ed0b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionServer.js\":\"dbbd73121f64703d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flip.js\":\"8a2ffeeca62b3698\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flipAttempts.js\":\"26c5bd38a43b1eac\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/pages.js\":\"8b672e2e7933f909\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/preflight.js\":\"077b17f53798040b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/reseal.js\":\"b830c7d2f716d345\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runConversion.js\":\"9833824dae16d9a5\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runLock.js\":\"66cf715d0aaa4696\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealing.js\":\"5db36e711a6df938\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealingStage.js\":\"79b6953540796f2e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/stage.js\":\"3327e06e75746209\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/verifyReseal.js\":\"fc873a8ea3ba91fe\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aad.js\":\"87284c0754740ac3\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aead.js\":\"da1fcda9460e061f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base32.js\":\"fd4a7ed1d186ff7f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base64url.js\":\"7f8358661118bd3e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/binaryEnvelope.js\":\"5b4b2567dbcf4f93\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/byteAead.js\":\"155eebe390df566d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/canary.js\":\"f64d4e80bc477d2c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentHash.js\":\"f22dc1e6d6cbb7c9\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentKey.js\":\"63aae7be91b436a4\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/derivedIdNamespace.js\":\"883079b03a5da950\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/envelope.js\":\"7005769636374a54\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/hex.js\":\"0388751d0a416dd4\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/sha256Hex.js\":\"40d033fa886a00cb\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/workspaceKey.js\":\"23cce3f8ad48de61\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/conversionState.js\":\"db9c19c3a7339203\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/createEncryptedWorkspace.js\":\"d0db0baca3b94a3b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/pastedKey.js\":\"733a2b45ec1329be\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"7ed5251b4579d0d8\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/upgradeWorkspacePin.js\":\"123dff7a0c85c435\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/keyStore.js\":\"0a946c923e017c93\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/mintWorkspaceKey.js\":\"850d6f6e659aea6e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/modePin.js\":\"88ab30222126c12f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/openWorkspaceKeys.js\":\"81dfdb7518969878\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolveWorkspaceEntry.js\":\"129f8738b22111c6\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolver.js\":\"df2e10e42751c905\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/workspaceAccess.js\":\"0b71de259fdcaaec\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/transform.js\":\"42da846111c3d74a\",\"/knowledge-medium/pr-preview/pr-1899/src/themeBootDefaults.js\":\"08e11a09a369625c\",\"/knowledge-medium/pr-preview/pr-1899/src/types.js\":\"790e823b34fd2b0b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/ClientLocalSettings.js\":\"fc25d483d3ed292f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/abortableSleep.js\":\"14fffe72f7358865\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/array.js\":\"a236f38215c68978\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/backlinkAutocomplete.js\":\"15ce3a9c9b816d6e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockCrumbs.js\":\"15088e11aa11be92\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockrefAutocomplete.js\":\"c4219b97177cd1a2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/cadencedIdleJob.js\":\"9d3bff8a40659242\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/callbackSet.js\":\"f778a05b24a0f055\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/clientId.js\":\"57ef043a4c27447e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirror.js\":\"0cbc051261d0451d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirrorCompletion.js\":\"48ca3f569c419923\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/copy.js\":\"60bfa9f793aba7a1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dailyPage.js\":\"783ec6c0a9963428\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensics.js\":\"8f1597bdaf0f0742\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensicsHooks.js\":\"c791fac59999432a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/deleteBlockThroughUi.js\":\"0194aafe1825e1c7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dialogs.js\":\"7cabb3e85caa5460\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dom.js\":\"9c51ec7c5cde0abb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/downloadBlob.js\":\"73521c49dde948c6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/drawnWalk.js\":\"84a920e4a53c7b84\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/exportSqliteDb.js\":\"c26571645c6bf95a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fileSystemAccess.js\":\"10e55021a6d70030\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/flipSlide.js\":\"4c30c7abca840b25\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fnv1a.js\":\"fc680a25760ac65d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/formatBytes.js\":\"732bea13eecf361c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fuzzyRank.js\":\"eff33bb64334ce50\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idbKeyedStore.js\":\"6964732a12989731\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idleCallbackPolyfill.js\":\"35661794a0001851\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardAwareScroll.js\":\"9e1ccfb030ef4b82\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardViewport.js\":\"10c95c8cdf8764fe\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/lastWorkspace.js\":\"2276fcae22b38d2f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutColumns.js\":\"1888b8962a66b209\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionDom.js\":\"a9742675537943f0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionId.js\":\"40a42f1749d7166a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkClickGestures.js\":\"bb8501783da3b948\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkTargetAutocomplete.js\":\"99dd49e44788e5dd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbCorruption.js\":\"e52761d82913e073\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbRecovery.js\":\"c1e0bc0751a0597a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/markdownParser.js\":\"e7295fcdcbd38efa\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/memoize.js\":\"4072027c678bb124\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameFieldCommit.js\":\"e3a81a6f91e3c416\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameList.js\":\"be7e4f564f1718ac\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/navigation.js\":\"d6c9f98cbe4734b7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/omnilinerNamespace.js\":\"397edd8b6968b6ba\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/opfsPageScan.js\":\"f859c0a3507257e5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelClearance.js\":\"9d01d95dd2d24dae\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelHistory.js\":\"7df6a1c56a99bd14\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLanes.js\":\"776b3fbcc7c91664\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLayoutProjection.js\":\"89bf1920bd62aa5e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelScrollAnchor.js\":\"ea92a7257ba3f6aa\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelUrlFlags.js\":\"10354981bfa70d17\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/platform.js\":\"c464a3498ddf3270\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/pluralize.js\":\"910d462ed6ee3522\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyCreation.js\":\"2a7897e95b37571f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyNavigation.js\":\"4fc568d7d778566d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyValueContext.js\":\"8098b6afb03f0613\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/react.js\":\"9667ffb670501da0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeDate.js\":\"b7576931054b2b7d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeTime.js\":\"af06ec52cf6974b9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/renderScope.js\":\"dd7d6a86bbefee5d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/resolvedThenable.js\":\"a141bba2cd8fd3d4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/routing.js\":\"4d06e77dbd465ab3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/safeMode.js\":\"d2edebe85b0f4a19\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/scheduleIdle.js\":\"577207df1124d667\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/screenWakeLock.js\":\"e004b4c38bc45a99\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/selection.js\":\"789e4c5b86feed6f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/softKeyboardGrab.js\":\"4884e25cd113b677\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/startupTimeline.js\":\"539c2cad9da1b89c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/state.js\":\"241c71ad0a789993\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/string.js\":\"9e9cffcc50a1c818\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/surfaceZoom.js\":\"12bfa2d67d0f49a1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/time.js\":\"7aae6bb808d8c704\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toast.js\":\"815be1ab3756c377\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toggleStore.js\":\"4fa41b1567808550\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/untilStopped.js\":\"e3131b1ca9929281\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/userActivity.js\":\"c77dbead524d147e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewTransition.js\":\"a2cd0d3f41fb7eaf\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewport.js\":\"48bb5288753af29d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/webLock.js\":\"16aa10f3dd3a7e2e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceRecovery.js\":\"f91db4338026d522\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceSnapshotStore.js\":\"7444bcd3750ed7c8\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-compiler-runtime.js\":\"d7162b58e35971a6\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-client.js\":\"2377c14f608d9308\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server-edge.js\":\"e4c22236516cbd8e\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server.js\":\"471bd4d09e12fadf\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static-edge.js\":\"ba20e557c568a683\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static.js\":\"641c94d8cee247a2\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-test-utils.js\":\"da32a176af928652\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom.js\":\"97ccca2b334d07c9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-runtime.js\":\"dceb037f4d888478\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react.js\":\"dc96bf1a7ff4219e\",\"/knowledge-medium/pr-preview/pr-1899/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
