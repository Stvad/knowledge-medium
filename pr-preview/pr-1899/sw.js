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
		buildId: "d9b7d4cd3896-bbd101e4",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/\":\"a077af4fae4e16a7\",\"/knowledge-medium/pr-preview/pr-1899/index.html\":\"a077af4fae4e16a7\",\"/knowledge-medium/pr-preview/pr-1899/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1899/assets/FacadeVFS-B9jLqfab.js\":\"763eb4093bd8fee9\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSCoopSyncVFS-DtwLKy83.js\":\"f73515a3f3333054\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSWriteAheadVFS-BONy0fP0.js\":\"887ab736a6c34c93\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-DLFUAwdX.js\":\"a0e59f29cbc87ea2\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-BshiGTRj.js\":\"4e27ce816562316b\",\"/knowledge-medium/pr-preview/pr-1899/assets/worker-Bk7aBePL.js\":\"d82d7b0a70bac9ec\",\"/knowledge-medium/pr-preview/pr-1899/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1899/chunks/app-Pu0Eed8f.js\":\"bea4279752aed0fc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1899/index.js\":\"24617dd083b41e6a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1899/assets/AccessHandlePoolVFS-CyBIsY5o.js\":\"0af4b2b63384cece\",\"/knowledge-medium/pr-preview/pr-1899/assets/IDBBatchAtomicVFS-qTpzDvaH.js\":\"d09c029ddd907795\",\"/knowledge-medium/pr-preview/pr-1899/assets/MemoryVFS-Cbqj_-X1.js\":\"db2fee2b41dfcb76\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cof1KQIi.js\":\"e3aa4671dc972e48\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-C6Nt3FpC.js\":\"ad2ce872698709cb\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1899/chunks/AccessHandlePoolVFS-CGIXgQCX.js\":\"251483729c32924f\",\"/knowledge-medium/pr-preview/pr-1899/chunks/FacadeVFS-C6b1P6iH.js\":\"a1672a9aad04c0f0\",\"/knowledge-medium/pr-preview/pr-1899/chunks/IDBBatchAtomicVFS-s4wPCO8t.js\":\"f4b5599020e3d685\",\"/knowledge-medium/pr-preview/pr-1899/chunks/MemoryVFS-BGsw_OuK.js\":\"3e42a27e9743889f\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSCoopSyncVFS-xnZH8aIu.js\":\"d0f738cddec2343e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSWriteAheadVFS-C8sskQBh.js\":\"964b2b3d0e61f46b\",\"/knowledge-medium/pr-preview/pr-1899/chunks/Preview-CutKZ185.js\":\"16a290b0dd264a87\",\"/knowledge-medium/pr-preview/pr-1899/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/card-BJpfv5rr.js\":\"f11f7b769f45174d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-AjbR52To.js\":\"4e7049f5e354d572\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-KOTd-Jz-.js\":\"830f130835e933c7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-async-DXpyFyuH.js\":\"07d730191d5534b9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-B1yfsRVG.js\":\"87228772214f2d28\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-CqRSNSKr.js\":\"48f87daba44871c2\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DJp_oqKe.js\":\"a1b486ff0d58845b\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-D_VcnT8c.js\":\"36f270f0670c3e00\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DmOZWUrM.js\":\"f04f85623063e9f5\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DtmeMEx9.js\":\"535a8a2b3ae04bc7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-IeqyPvpx.js\":\"080fa14b303e1c17\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-ba8Psul5.js\":\"420657f8c8bdb9ff\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server-legacy.browser.production-BaZ1oHkE.js\":\"9bc74ee2cdf3a3a8\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.browser.production-BJ0Pi76Z.js\":\"7efadac0f61bdfcf\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.edge.production-woZDPNyZ.js\":\"47cf792f745ef03d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/server.browser-CotqpsSa.js\":\"fbc39a8d4c652f4b\",\"/knowledge-medium/pr-preview/pr-1899/chunks/textarea-BlrIkEFf.js\":\"d22bc95006d8f80a\",\"/knowledge-medium/pr-preview/pr-1899/chunks/ui-BxHWG9zn.js\":\"254a5650ecd0afdd\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-async-KolfQSRg.js\":\"1536c52324bb822c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-jj9ouo2A.js\":\"026bb57fad7ed299\",\"/knowledge-medium/pr-preview/pr-1899/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1899/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/src/App.js\":\"2a98097e17b20b9f\",\"/knowledge-medium/pr-preview/pr-1899/src/appUpdate.js\":\"5af8a7e840c5ed86\",\"/knowledge-medium/pr-preview/pr-1899/src/appVersion.js\":\"04cf59f48ecdbb79\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/initialLayout.js\":\"8b470fc55549c998\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/openWorkspaceData.js\":\"ce021201e75d1837\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/resolveWorkspace.js\":\"2086a8f8271cecce\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/workspaceBootstrap.js\":\"a04ba1a13aa180e1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockComponent.js\":\"162ff9248e1c1f3b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockCrumbs.js\":\"09339e892ef10755\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockEditor.js\":\"1ae277aa3456c623\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockLoadingPlaceholder.js\":\"2f851101702f05dc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockProperties.js\":\"c6b7245885d7a2b5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockSearchPicker.js\":\"3e4c8d92bd7cb570\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ConfirmBulkDeleteDialog.js\":\"543b743c7a52c2d6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DividerHandle.js\":\"c9ca3c0430432a6c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DraftEditor.js\":\"9e4cdf66eb455f11\",\"/knowledge-medium/pr-preview/pr-1899/src/components/GutterPill.js\":\"fe6689e7be54215f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Header.js\":\"16d0735be97cd26d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/LazyBlockComponent.js\":\"76874d51d3420481\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Login.js\":\"ce2f29932fadfbec\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ZoomableSurface.js\":\"0e209982f9bcbc68\",\"/knowledge-medium/pr-preview/pr-1899/src/components/editModeKeepalive.js\":\"fc7f8c35132cc222\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c4efb9d2a0e74c56\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"fe8814c4622fb8cd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefPropertyEditor.js\":\"ffcbe6adbff2c59e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefTargetTypePicker.js\":\"857019f96a337555\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/SelectPropertyEditor.js\":\"4b4eb585191c6d52\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/TypesPropertyEditor.js\":\"3bd1e79e4a176ae2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/defaults.js\":\"5b43e5b12c719d06\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/kernelValuePresets.js\":\"90d8762a0eb3c96c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/selectablePresets.js\":\"bd442cf1d8abbbbe\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/typesPropertyUi.js\":\"50b945b9f263d944\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/AddPropertyForm.js\":\"126bccf6751794d8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyPicker.js\":\"496231cbe32847da\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyRow.js\":\"ff45d7f41695b2da\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/Rows.js\":\"2d55ac94f81d4f2f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/actions.js\":\"979aef9cc58138fa\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/declarationOnly.js\":\"144760698e4ce6a4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/layout.js\":\"19ad88826a3fa146\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/model.js\":\"71a5942d0d90c1be\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapeUi.js\":\"0465f1afc4f67355\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapes.js\":\"61cedc17d8ef59b2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/usePropertyEditingActivation.js\":\"89b62c7e22f5fc1a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/visibility.js\":\"9ffc0a8987eeae38\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanelSections.js\":\"072df8e4d546ae2f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockEmbed.js\":\"6e084c0a23df737b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockLink.js\":\"331f69fafcee011e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockRef.js\":\"1ff94f3a8e9b325a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/CompactReferenceLink.js\":\"5e22bbad5d57e396\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/ReferenceLink.js\":\"257717a1d1b6d2b8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuard.js\":\"675e8307fa3d28dd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuardContext.js\":\"3bd868b288ffda5f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/linkInteraction.js\":\"d071b4f60f9d1b6d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/referenceLayout.js\":\"18f7f2eab2f0bf68\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/useBlockRefAncestors.js\":\"20ff306448fa5297\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockGutter.js\":\"ba57cc05fd28de70\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockInfoDialog.js\":\"65ab1b2b56daab1d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockReadText.js\":\"1e7b6b0cf37d9eee\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockTypeBlockRenderer.js\":\"439764631f4d3ab2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BulletHoverCard.js\":\"4495704a41719966\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorContentRenderer.js\":\"c1298f210d9ac9ef\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"fe9e3b0d2261837b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ColumnResizeHandles.js\":\"d66e8c55145c12f4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"3dfe126574600575\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/DefaultBlockRenderer.js\":\"a5c8ff9983d46734\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/LayoutRenderer.js\":\"a6cb19e6dd230cf7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MarkdownContentRenderer.js\":\"8c2768a1b190b18d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MissingDataRenderer.js\":\"0828a589a78cf60d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PanelRenderer.js\":\"6eb17c2e57397a16\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d477aaeacca8944c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/TopLevelRenderer.js\":\"309da3fdb940d04b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockGutterMode.js\":\"e1108ada29466504\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockTitleText.js\":\"eae66fec0d8fb1c6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/fieldCreationKeydown.js\":\"4e207ec24d3bb014\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/layoutRootContext.js\":\"e74166964de49679\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/TypeChip.js\":\"3b76d1d8c3195871\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/chipStyle.js\":\"da44879ffe5d5e15\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/anchored-floating.js\":\"d2c735f76ecd2d73\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/button.js\":\"9419fcb45ea9c619\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/card.js\":\"001f7b1891584ffe\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/checkbox.js\":\"fce24c1fccceeffc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/collapsible.js\":\"2ae7f623b708155b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/command.js\":\"bd2a57d149c973b3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/context-menu.js\":\"f93780830ad684e9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dialog.js\":\"4d2da3ab82ebaaf1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dropdown-menu.js\":\"2f0879cf52832070\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/floating-listbox.js\":\"fd949cc05c44d371\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/index.js\":\"326eabaab7439b0a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/input.js\":\"11f3e6f77a368b53\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/kbd.js\":\"fab18eb39f24eef3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/label.js\":\"f23d9b69c368ee88\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/textarea.js\":\"8b3aac4eb0963246\",\"/knowledge-medium/pr-preview/pr-1899/src/components/useEditModeYieldKeepalive.js\":\"7ec774f2d8662e9f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/BootFallback.js\":\"d0d113d8b2f5d2e5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/FocusedRowLazyMount.js\":\"fe1bed764de20403\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LazyViewportMount.js\":\"cc96517739e21be9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LocalDbCorruptionFallback.js\":\"477839da45d6e15b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/error.js\":\"a224a92e54810c19\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/lazyMountRegistry.js\":\"74b2f181f84bf812\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/suspense.js\":\"f24c58ab72f25b77\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/CreateWorkspaceDialog.js\":\"493c4508666be2da\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/PendingInvitations.js\":\"0c987e15da62d790\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/SyncProgress.js\":\"193d9da7aad1f174\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/UnlockProgress.js\":\"c66e55979c4ce4a3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceKeyGate.js\":\"015d43987e650c62\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSettingsDialog.js\":\"378dd218129da86f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSwitcher.js\":\"c427aadd1090ac34\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSyncGate.js\":\"e7b1a01bcd8fdd5b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlow.js\":\"657e67275d26219c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlowHost.js\":\"6ab603d2e9b6322c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/EncryptionSection.js\":\"523e947746320558\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/attachmentPrompts.js\":\"d3d8075c17f446da\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/bundleFolderPrompts.js\":\"fa21ed49bbbca9b0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowDeps.js\":\"85bbc79a52d64e9b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowStore.js\":\"90dd0c3f69b71c8b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/flowUi.js\":\"ee74c4cdc950fd99\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/useConversionRun.js\":\"3f2cad3dc5a2f665\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/keyUi.js\":\"38f9fcf1f62d617c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnKeyLoss.js\":\"5aebdb86ab97a670\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnServerE2ee.js\":\"6ef2047d2299a6b9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/workspaceUnlocked.js\":\"19a12a669c6ff319\",\"/knowledge-medium/pr-preview/pr-1899/src/context/backgroundSubtree.js\":\"53aa02b588b89629\",\"/knowledge-medium/pr-preview/pr-1899/src/context/block.js\":\"48963eb621d9a3f1\",\"/knowledge-medium/pr-preview/pr-1899/src/context/layoutWsContext.js\":\"d826d097503c93ab\",\"/knowledge-medium/pr-preview/pr-1899/src/context/propertyDisplay.js\":\"b8543572b9682cd8\",\"/knowledge-medium/pr-preview/pr-1899/src/context/repo.js\":\"28925d0acc2a1c84\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasClaim.js\":\"2c22a27dc675522c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasSeatNamespace.js\":\"d62de98a1d537bdb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockData.js\":\"cfebe972e74ad9fc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockType.js\":\"426c672b90405aa0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/changeScope.js\":\"e7ef23ac6901de87\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/codecs.js\":\"1bb224ff98fe48a1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/derivedData.js\":\"552cbb048959a709\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/errors.js\":\"21362c568918dabb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/events.js\":\"cc5b4c728bc075d7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/handle.js\":\"b6fa1495d6ffb0fb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/index.js\":\"22b177b551419448\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/mutator.js\":\"c6f50143d127a3df\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/processor.js\":\"9df7ecab2056d164\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/propertySchema.js\":\"6e7915c78228185b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/query.js\":\"cfe6e21f6a7985a9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/sameTxProcessor.js\":\"e437f01ec6eec1e7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/schema.js\":\"b6fa1495d6ffb0fb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/tx.js\":\"b6fa1495d6ffb0fb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/typedBlockQuery.js\":\"3fe98a30745e4883\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/user.js\":\"33a95b4ba06f5e1e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresetCore.js\":\"3e7b04261f7439ca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresets.js\":\"4d219c9a56b88c99\",\"/knowledge-medium/pr-preview/pr-1899/src/data/attachmentCleanerIOVerb.js\":\"25052bbc42af0d37\",\"/knowledge-medium/pr-preview/pr-1899/src/data/block.js\":\"a6394fbc03d30464\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockCache.js\":\"4e20d75c4f69a84e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockId.js\":\"02d17365c96d9203\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockLiveness.js\":\"6eff9a634cd4c7e3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockMerge.js\":\"0666d8cb5f7a3fad\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockSchema.js\":\"688e794672a69731\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypeLookup.js\":\"ab8944da9bd10e29\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypes.js\":\"6e46c60f2788a4d7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/childrenView.js\":\"1227039c1c0bff3b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/clientContext.js\":\"f8167e3d125b46dd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/dbFileSiblings.js\":\"eee7fc3846d60e33\",\"/knowledge-medium/pr-preview/pr-1899/src/data/definitionSeeds.js\":\"ecfeacffc40064e4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/derivedIds.js\":\"9e5c2ea47f2eb8d3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/drawnSubtree.js\":\"b02bf020316c294c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facetBridge.js\":\"3013533cb7a8bbd2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facets.js\":\"d9ed736f1acbe6d6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/globalState.js\":\"8856a1a0ee4b5cd8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/aliasClaimRederiveProcessor.js\":\"23d877a697822ad7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/ancestorBatch.js\":\"27e8b8beb7c28f97\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/blockTypeTypeifyProcessor.js\":\"754898559781639f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/clientSchema.js\":\"f6dc1ecdf1d88048\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/commitPipeline.js\":\"3c6f919089998b76\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/devAssertions.js\":\"6dba04b250f1af6b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/firstSync.js\":\"2c90e0a7bf24adaa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/freshInitialLoad.js\":\"4fc33d9fef2a005b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/graphBackfillClaim.js\":\"a47b521fe9b3354a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/handleStore.js\":\"4e18dbaf105ccac4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/idleMarkerJobs.js\":\"df2174518f42c4ed\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initialDownload.js\":\"5d9b6c669a0f71c7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initializeClientDatabase.js\":\"7a00dedb2170426f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/jsonCanonical.js\":\"9a44412dda1681ec\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelInvalidation.js\":\"fe49a94fa8927507\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelProcessors.js\":\"0e2516bc3940ee09\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelQueries.js\":\"771a9010ec5570ee\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/mergeTypeMembershipProcessor.js\":\"51e47dec98bbcf4a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/normalizeReferencesProcessor.js\":\"bb75dcc71eeca7fd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/poolInstrumentation.js\":\"db8a84c182ff67b1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/processorRunner.js\":\"e0bcf96c002017c3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyCellBackfill.js\":\"8c59a3d223fbc979\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildMint.js\":\"181f7b0250883ccf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildrenProcessor.js\":\"d6f80fc99ea377a8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionChangeProcessor.js\":\"fd3d6367730db92c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionSynthesis.js\":\"900e608c66147b9b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyKeyScan.js\":\"7071914afd84eeca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertySchemaResolution.js\":\"e614b27bc30cbdbb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyValueEdits.js\":\"f9b90273cad7e1d8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/raiseProtocol.js\":\"ce755fb48ececdc5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/readBatch.js\":\"cf92732d887f331e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/refProjection.js\":\"3f16cc66a852f05f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetLookups.js\":\"cca242f3c0c20e22\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetProcessor.js\":\"15601cfd0e9bbeb0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/replayMerge.js\":\"dc5c6a26c55a42c8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/sqlBinds.js\":\"8903792ac7276f48\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"cf6bcba0e76ef880\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/arrivalProcessors.js\":\"097bbd7ed2ad6285\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/invalidate.js\":\"fa422e85f506ab91\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/materialize.js\":\"41bc69fa3eb51a1a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/observer.js\":\"d5ab5d96427631b9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/reconcile.js\":\"26d4ede10f4db95b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/timingMetrics.js\":\"bc3e48e87b96dd45\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/treeQueries.js\":\"2207c41818e5270d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txEngine.js\":\"275a33bd9cb56377\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txSnapshots.js\":\"7d7faddf8346c3c5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/typedBlockQuery.js\":\"e42fbaaacafe81f5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/undoManager.js\":\"0c3b4add7658d585\",\"/knowledge-medium/pr-preview/pr-1899/src/data/invalidation.js\":\"4c6d56f1059f9b06\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelDataExtension.js\":\"6d477fcd6959b310\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelPage.js\":\"40ace6803b10ad54\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelValuePresetCores.js\":\"782d5c920c7052fa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbCorruptionSignal.js\":\"313c50ce6a08a594\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbStorage.js\":\"efd64d5abe3e54dd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbVfs.js\":\"b82eef55349cf547\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localSchema.js\":\"c2e44190aac90e06\",\"/knowledge-medium/pr-preview/pr-1899/src/data/maintenance.js\":\"6ba2adc2b4ffe381\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mergeProperties.js\":\"1dd2c3fb597e8d2e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/metricsConsoleHook.js\":\"19253b0449c8b667\",\"/knowledge-medium/pr-preview/pr-1899/src/data/migrationsPage.js\":\"e0237fd2566123fb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mutators.js\":\"0df87a6f309a0020\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKey.js\":\"2d06a634424bcbfe\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKeyPlacement.js\":\"3cd4cab1c04d2b5a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/outlineSurface.js\":\"d35f0d800c4d726f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingEditorContent.js\":\"ebc18ce4cbfae71e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingUploadsSql.js\":\"a6d3551d5cde69a0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pluginStateExtensions.js\":\"c07df90c1e65d1aa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/powerSyncLogger.js\":\"ddb180babf074ed9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/projectorRuntime.js\":\"d3a303405afb6dc9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/properties.js\":\"98295bf169cadb8c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertiesPage.js\":\"894ac5ebab5eea02\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyChildren.js\":\"47eb95ee9746ae25\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionFanout.js\":\"c6355d86beb58b78\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionMetadata.js\":\"18dd17db1f4ca539\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionRegistry.js\":\"acdf234e7fed0ef7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDisplayMode.js\":\"a3a4d1b53f2e8a2e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyRowCreation.js\":\"e09aae6e1e6274ba\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySchemaCreation.js\":\"c7f4232307e7997c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySeeds.js\":\"e898cd6ea1f5b6b8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/recentsPage.js\":\"b2f3f611628072d9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/refTargetComparableProperty.js\":\"5e0204861a0eacac\",\"/knowledge-medium/pr-preview/pr-1899/src/data/referenceBlock.js\":\"9c0c87e7353841ba\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rejectedUploads.js\":\"58c691ec67c51994\",\"/knowledge-medium/pr-preview/pr-1899/src/data/releasePowerSyncConnection.js\":\"db8daa8378181f25\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repo.js\":\"adc5b59319a34189\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repoProvider.js\":\"d8f11651150ee98b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rowProperty.js\":\"11c954a3269124e8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/searchFilter.js\":\"e0e0e8e07f1eb838\",\"/knowledge-medium/pr-preview/pr-1899/src/data/seedIdentityLedger.js\":\"3c5387796f1153d1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/stateBlocks.js\":\"7934db17af12e763\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralEditPolicy.js\":\"0667d9d9adad7bd1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralInsert.js\":\"408e92f57ffd8c6f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/subtreeDelete.js\":\"de78652f52f5c865\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncStreamLock.js\":\"0bd2f9e41a4da29b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableSqlRecognizer.js\":\"ee7f38388203596c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableWriteGuard.js\":\"775f7e827ce266ca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/targets.js\":\"42ceb1361a2cf5be\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeColors.js\":\"40961c68bd384873\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionMetadata.js\":\"86fb6482be820eca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionRegistry.js\":\"aac579f46653fd2d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeExtraction.js\":\"5d0c4d38ffce0af8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeInitialValues.js\":\"abcd500f04a3a07f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typePropertyGroups.js\":\"f0061bff7f37970f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeSeeds.js\":\"7a2c34281f7cd077\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeTagger.js\":\"0da390198bb76126\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typedRecords.js\":\"83ad48c11a4ce196\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typesPage.js\":\"aeb3a210a4982060\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userPrefs.js\":\"a3843b13a715cae4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userSchemasService.js\":\"3565da61abab38f0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userTypesService.js\":\"749c56e026ee4f75\",\"/knowledge-medium/pr-preview/pr-1899/src/data/valuePresetRegistry.js\":\"51abf5ad9fb9ad7e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/visibleChildren.js\":\"29ef17352be9479f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceConversion.js\":\"1bc93da2b10c0fa2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceFirstSync.js\":\"3ac74437351fc17e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceIdNamespace.js\":\"020c0b6bf8e0b264\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceSchema.js\":\"706f9599d52a1bcf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaces.js\":\"f0baf8f60ebbce64\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadLog.js\":\"d8886cd66b05e1ea\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/BlockPasteShellDecorator.js\":\"02e68fefb304ff9e\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/atTrigger.js\":\"e7a784f9bdcd5cc6\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/autocomplete.js\":\"4c9d4cb19b64b7d1\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/codeMirrorExtensions.js\":\"4751e13cacd62f4e\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/contentFlush.js\":\"c60008e8cc0e8b33\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/defaultInteractions.js\":\"713572662993d434\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/editSettleSignal.js\":\"cf8f2081d689df2b\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/insertImage.js\":\"01c03f16c839c91d\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceCompletionRange.js\":\"c2415e896c4a7e1f\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceTargetTypes.js\":\"1ca550db12f41820\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/syntaxContext.js\":\"07140e64efad7eca\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/triggerMatch.js\":\"248d93039c499f07\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/AppRuntimeProvider.js\":\"cc1addda5895c03f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/BlockFocusShellDecorator.js\":\"c04ffc58fa3ba68b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/ExtensionRenderBoundary.js\":\"c60838e024ed9ffe\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/PanelContentRecovery.js\":\"4820e7da464eb4cb\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/apiCatalog.js\":\"514cea412f7cea3b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/approveExtensionHere.js\":\"4e36c6ec5be1a7aa\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/armedCutAppMount.js\":\"6c852a22a6a2e7b3\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/batchableKeyedStore.js\":\"1aa4e11049992259\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockInteraction.js\":\"75e03d5440abcda1\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockSelectionAction.js\":\"440d077896421ecb\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compileExtensionModule.js\":\"35be72e650149169\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compiledModuleCache.js\":\"f7ebc76f32dce0bc\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/continuousGestures.js\":\"22776b33f1869a83\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/core.js\":\"e216801cea41238d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/defaultRenderers.js\":\"79358a451dce5175\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/definitionFanoutAppMount.js\":\"ce43813d3bb7488d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dialogAppMount.js\":\"062e1c6d4812d5d1\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensionSeeds.js\":\"4c4bcb21691242bd\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensions.js\":\"800e48b20f677093\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/exampleExtensions.js\":\"748753e76eaff4ad\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionApprovalStatus.js\":\"5aabd9efae1a7677\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrorToast.js\":\"2fa3131c7634f31c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrors.js\":\"fe305ed03666140f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLookup.js\":\"c958e6fea69c04f7\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionToggles.js\":\"f40b36912e823ae2\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionUtilitiesCss.js\":\"ce2446db67c22082\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/kernelPageDeletionGuard.js\":\"f486fb217a99564c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/liveRuntime.js\":\"9ab83cfde162e124\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/openExtensionsSettings.js\":\"b5b7a09222379827\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/overridesCache.js\":\"6ff992775e3a8244\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/pluginIds.js\":\"c2cc627fa53c8a03\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/processorRejectionToast.js\":\"a9c0a32bf921aa68\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeActions.js\":\"b1d39086aa56fb10\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeContext.js\":\"4b5504ac01a658ea\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticAppExtensions.js\":\"c76d3839c0b180ac\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticDataExtensions.js\":\"e434d388af9a9956\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/toastAppMount.js\":\"cc46c5649d55ef4e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useOverrides.js\":\"1d7c7cbc271021d7\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useShortcutSurfaceActivations.js\":\"429a65fc4628effc\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/discoverToggleTree.js\":\"336d81f257534819\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/facet.js\":\"467c88094292ba70\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/resolveAppRuntime.js\":\"05fa6b8b55034ea7\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/runtimeEvents.js\":\"612ce1ca5300ca7e\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/togglable.js\":\"52e64cf978125659\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/variantFacet.js\":\"c2ae50895c0af94b\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/verbFacet.js\":\"0227396fea71ab92\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/block.js\":\"eecf2e559116884a\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/focusedChild.js\":\"0297dfd09f488a77\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/propertySchemas.js\":\"fa0c90fe98b6e8ab\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/typeRegistry.js\":\"08a56fc91ef818ca\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAncestorCrumbs.js\":\"989e27d2047dde14\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAutocompleteListbox.js\":\"c803dd50431fa356\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedSearch.js\":\"7991cc4c4234b296\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedValue.js\":\"cbeebdc1e5972613\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useFacetValue.js\":\"9dac1da157e582e6\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsFocalRender.js\":\"15552274fc0a6876\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsReadOnly.js\":\"117cee1ffc93e05a\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMaterializeBacklog.js\":\"c155dd1a4e3eb01d\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMinuteClock.js\":\"79f0b88ddae8c0ef\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePanelLayoutProjection.js\":\"4886d39248baa86b\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePendingInvitations.js\":\"b20acc5c5e89ab28\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRendererRegistry.js\":\"9fd7fc09b6aa2281\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRetainedFieldRows.js\":\"b44f27cc774ebf6f\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useWorkspaces.js\":\"809f2ab91353c791\",\"/knowledge-medium/pr-preview/pr-1899/src/lib/utils.js\":\"03a8edc3f7fbe265\",\"/knowledge-medium/pr-preview/pr-1899/src/main.js\":\"5ee3edb84387418a\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/MarkdownImage.js\":\"d693fd51cbdb0dc7\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/blockSeparators.js\":\"fae179118146f97f\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/context.js\":\"b18799c69cb9b59b\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/defaultMarkdownExtension.js\":\"99cb36727c7ad5b4\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/extensions.js\":\"0d4accc7afe02582\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/renderMarkdownHtml.js\":\"0436ca2953434d4b\",\"/knowledge-medium/pr-preview/pr-1899/src/minimal-editor.js\":\"454b6893029d1c13\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/armedCut.js\":\"012d4c959c60c9f8\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/captureMediaVerb.js\":\"fa16d8b8ef9a5a97\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/clipboard.js\":\"1d67a0170cf4f696\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/decision.js\":\"31c67ed1fe615b3b\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/operations.js\":\"9bb0be37053fea8c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/AccountHeaderItem.js\":\"a40e6644ab3a24a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/index.js\":\"a05c6d35b906fcaf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"7872a4a7a0d5957c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askAgent.js\":\"af0459c41fd4cf3d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askedStore.js\":\"3ea9a130f63474d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"cffeb51b17743449\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/chipState.js\":\"c8039aad1b2f2f03\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8b3e29078dc147ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/index.js\":\"e853bb94c3fbbdf4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e3bde4861f785bda\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/schema.js\":\"e44fbc251be445f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/AgentTokensDialog.js\":\"0db8f7371eb514ad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/BridgePairingDialog.js\":\"be37c25753565740\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/addMedia.js\":\"6c94275b38318f29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/backlinks.js\":\"e8ac35a33af0c753\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/block.js\":\"b297a8fd2f34112b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/context.js\":\"b96fa934ce237910\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a9943fd1c18c9347\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/index.js\":\"257a51edb88e5e06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/outline.js\":\"cb93f7074ada3814\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/properties.js\":\"84758db47ba0232f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/refs.js\":\"ea9cef7cc33eeee2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d1d9950bbec0ab38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/search.js\":\"71c0cfdbda9f9ac7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/shared.js\":\"d7ed88e97e232353\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c2d80b7aeb1cd47f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/text.js\":\"524e0b79b48f6904\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentWrites.js\":\"4dad1c697cd49bda\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/authoringCatalog.js\":\"8b13e74606933cc4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/blockRefTargets.js\":\"ad3fbdb61896f46c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridge.js\":\"fa07628f6b3b98d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridgeLoop.js\":\"55fda64932737993\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/changeHistory.js\":\"588298f9d9ec7590\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commands.js\":\"9ca97206edd7bd74\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commentsCommands.js\":\"b4ff4b58120b1cde\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataExtension.js\":\"739f194393402c93\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataModelGuide.js\":\"48883d0a019b0c27\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dayPropertyInputs.js\":\"f008b112709fd4f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/describeRuntime.js\":\"161645f39c47241d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/extensionLint.js\":\"ea9953e1f20b89f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/grainAudit.js\":\"52b0d74a5bb2ba75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/healthCommand.js\":\"8961ec884085fe1b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/index.js\":\"8a22a656546aa863\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/presetIdentity.js\":\"4a8090cd8346ef22\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"4f132624f3d4315e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/readMedia.js\":\"3e2e6286bf3cfc0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/schema.js\":\"f09fe1b62d255e54\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/serialization.js\":\"df8487f453203372\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/targets.js\":\"8ab0ba5f741dca06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/tokens.js\":\"c43c2f28bd51d636\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/watchEvents.js\":\"765247caee32daad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/workspaceGuard.js\":\"fb00a1eb451d6264\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/writeCommands.js\":\"cad420571890c6ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/AliasCollisionToast.js\":\"9984f43e01378ea9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/DuplicateNameBanner.js\":\"8fbb3d2bb7c798b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/collisionMerge.js\":\"4470b56e83aa4d89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/dataExtension.js\":\"d5970fe41f7c18f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/index.js\":\"4d9bd40166801baa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/mergeCollisionAction.js\":\"e239add724a0f107\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/pageStyling.js\":\"d8c56c499b84c13d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/rejectionToast.js\":\"46c27ef1814c54a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/syncProcessor.js\":\"162eb4f0e2d53664\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/actions.js\":\"93de5f5dd9a0d28e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/addComment.js\":\"05fe885243b763c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchor.js\":\"ca3a142380e988ad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchorState.js\":\"6aacacebdca3baf2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/commentLinks.js\":\"60fc807aef99c909\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/confirmThreadDeletion.js\":\"1dbc6084dbb47885\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/container.js\":\"595c352c7b831ed6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/dataExtension.js\":\"c76095e8f54cb46d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/deleteComment.js\":\"94eab5b8f8061211\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/highlights.js\":\"1dabdabc7ffe2666\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/index.js\":\"c8cd72c8f0ea6ebb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/linkedCommentsPill.js\":\"2a2278d4939e37dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/margin.js\":\"b24021bbcd69829f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginAnchorLinks.js\":\"a653caaaade0014d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginSchema.js\":\"5ac7f14a826449b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/newComment.js\":\"49460f183518572b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ownThreadPicker.js\":\"c21b22425ee9584c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/placement.js\":\"616d60539327b311\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/queries.js\":\"d5bb929121d51de4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotePosition.js\":\"aefc09d120a95d7a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedIn.js\":\"2d3a40dd2d34b4aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedRange.js\":\"506c521013db536a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/rangeRefs.js\":\"d3938f260b0bb512\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readHighlights.js\":\"43b73cbfb9d76dc5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelection.js\":\"adb9df34dbdd9d1e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelectionUi.js\":\"339fdad6f57d4fb2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/reanchor.js\":\"18df63bafde062e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/schema.js\":\"67c92540b308c45c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scope.js\":\"2b16d9f417456c78\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scopeThreads.js\":\"cd1397e5320d969b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/splitRetarget.js\":\"52cdcf602735b9ad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestionCard.js\":\"b1c633cc25f76fc5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestions.js\":\"f10bfb67472a0f32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaries.js\":\"3925555ec108aff1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaryBatch.js\":\"2b5d56c165634ca0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/surface.js\":\"12ad658e31a6103e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threadNavigation.js\":\"d369152911064182\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threads.js\":\"9bcc8b802ae07539\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ui.js\":\"60c27b1476fff95f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/uiStore.js\":\"52f863548411678b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/appIntents.js\":\"b3af341c45770028\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/index.js\":\"f15d7ee5339cef4d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/index.js\":\"de10d5481c6d9903\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/status.js\":\"b9ee0742e9df278a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"1db37c6edc0fdb34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaBlockRenderer.js\":\"8b49fd32adf2e092\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaDownLaneReplicator.js\":\"494cae2b20f57a3d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaUploadReconciler.js\":\"4ef9ac965cc494b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetDownLane.js\":\"597c5ea8d6505571\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetResolver.js\":\"2e5184fb9fe1e47e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetUpload.js\":\"de6a47d6549be23c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/attachmentCleanerIO.js\":\"f4424d10065b14ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/supabaseAuditIO.js\":\"963f888efddf8a87\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/blobStore.js\":\"dd74dce4c9dc27f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/browserMedia.js\":\"644aef5e52b00479\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/byteStore.js\":\"ac4c109c29550085\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanerIO.js\":\"e750e773d891e948\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanupAttachments.js\":\"eb2095c49b375c2f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/dataExtension.js\":\"de75835dfece8fae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/downLane.js\":\"2781cb9cdc1022bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/index.js\":\"3156d78565aa7e3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/insertImageContribution.js\":\"191594e5dec67911\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneArming.js\":\"5d234c3dce57a806\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneLock.js\":\"f18257af47970bab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaBlock.js\":\"2047f54d96dae218\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaCapture.js\":\"ecf12647e04b9b89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaLanes.js\":\"ad25b9e0fa5485ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewers.js\":\"b3599ad9328f3607\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewersFacet.js\":\"0fdafa22f0a6a49b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/pasteCapture.js\":\"9009a326a6677eda\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/resolver.js\":\"2ac3bd35dcc11b26\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/retryUploadsAction.js\":\"b8d88a6f471aed2c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/storagePaths.js\":\"111e016653d31885\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadDrain.js\":\"b6645e981f28e241\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadLaneStatus.js\":\"50fa7d19a44c557c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadReconcile.js\":\"cda5a01e8c776fd2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadRecovery.js\":\"cc374e9709b0187c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadStore.js\":\"5792021899ceb5fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/useAssetObjectUrl.js\":\"8db47bddac885c7d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f56448967342870a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksViewSection.js\":\"651d0b1047a8be58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/facet.js\":\"e03e01196bdcb15f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/index.js\":\"bcbbe81062f6d3bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/prop.js\":\"a9fed9e48935607b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinkFilters.js\":\"b15fc53c0b7743b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4b3811a6a508b1d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BlockEntry.js\":\"adcfaeaf7e12a1e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/LinkedReferences.js\":\"4546531c086329d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"530d5a2947e38029\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dailyNoteDefaults.js\":\"d5eb0df0fd9811f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dataExtension.js\":\"75993c1d53e0a541\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/edgeExclusions.js\":\"d496227a5e46d500\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/filterProperty.js\":\"1dcb06e69200fb06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/index.js\":\"2fd59d74997ba97a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"fc242dc731d2b80c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/applies.js\":\"81943c77f1315244\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/countQuery.js\":\"fc6f5d177240ca69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/expansionStore.js\":\"6cc8dcd939f2a1f0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/index.js\":\"3413593559289e96\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f25f4758308c5c5d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/presentationInvalidation.js\":\"34cbae8a58ca4779\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyEditorOverride.js\":\"65c7aab46e9f6563\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyFilter.js\":\"a238ad9b2edaa363\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/query.js\":\"1d5a3e07db0a42af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/resolveFilter.js\":\"341309b8173fce6c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sourceBatch.js\":\"fe37a1aa9d2ed9a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sources.js\":\"9cc707e5b185cb9b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useBacklinks.js\":\"8e989e1444a63e4e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"e1766b19b49cda90\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayCelebration.js\":\"edce926594d8ba34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayOverlay.js\":\"b1f18a657592857f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/gate.js\":\"128ab8ffd41fe1be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/index.js\":\"7f8a0e2bac22c3a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/wolfTheme.js\":\"e4725fc5ef7ce47e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/BlockDragLayer.js\":\"600e91a278ac2a00\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dragController.js\":\"cd970f02bdcf1998\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dropTarget.js\":\"12d4a58ac8a7c817\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/index.js\":\"a45762d6b6cd3546\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/projection.js\":\"4b15bca3686f60c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/BlockMetaCard.js\":\"0f8af90ee28db034\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/index.js\":\"c7674403f5243677\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/AddTagDialog.js\":\"75e1de61d7b45050\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f4c21f2916abfcc1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/TagNameIssueHint.js\":\"7c876fa48519280b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/addTagAction.js\":\"ac0b21dd2d0eee58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/appendTag.js\":\"41c439f8eaff7a71\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/config.js\":\"f4e3c540faed4fa4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/dataExtension.js\":\"5bf50c8e2923f8f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/index.js\":\"e2c83a7459aaece6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/propertyEditorOverride.js\":\"c1cdf6e56d555c6d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ef555a0bf83f4841\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"88cdd26ffbcb7ab7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6fa3706ca0db6abc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8104194c1abfb99e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"0562f39ca342ce56\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/index.js\":\"800eb9736c3b09ce\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"ab760e728400c210\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/CharacterCountItem.js\":\"86a2028fc208ea00\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/ProfilePropertyEditor.js\":\"7465c90a2b074b93\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/actions.js\":\"07a2a292f6760ce8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/blockType.js\":\"ad96f64d667f6443\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/charCount.js\":\"ab276bab187be4dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/dataExtension.js\":\"d68b5efe9683ea12\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/index.js\":\"2c655e121e56512e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/profiles.js\":\"b093b5711304663b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/properties.js\":\"0b39808225b96086\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/subtree.js\":\"29a76f65c35b2cbf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/textCounts.js\":\"eb8ccbc36154a9ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/colemak-keybindings/index.js\":\"da3ff778a5f1cfed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/CommandPalette.js\":\"0fb503050465cfd6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/HeaderItem.js\":\"1f57e41c9bc3fc3f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/context.js\":\"e9cd2380c5694bec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/index.js\":\"fcb04dd59d4e37ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/selection.js\":\"d2ea1035eb8d372c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/toggleStore.js\":\"32724899f26a66ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/useCommandPaletteActions.js\":\"7e1142b082115be7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ContributorBadges.js\":\"8f5996390928c6b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ProfilePicture.js\":\"4b76dd46958a7c17\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/author.js\":\"c7ea528982ca0bee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/codeMirrorExtensions.js\":\"52be37deabb8a9c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/dataExtension.js\":\"249e3a67dff77211\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/index.js\":\"b5b6367e2581e591\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/mentionAutocomplete.js\":\"d7630e2b28b2235d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/processor.js\":\"30657364b81c7f9d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/profiles.js\":\"bd6099d95cb05dca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/queries.js\":\"faee1ceedd894e96\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/schema.js\":\"4272d5d0ba66c7ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/useCommentAuthor.js\":\"9469a1476d9ce34e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7a958e059ac11be2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2c0ba7aab3be533d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/index.js\":\"fecfaf525478f0a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5ef4d4312f1ae363\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"ea5ab32ea687d40c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/CalendarGrid.js\":\"dfd2d8d396f97704\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DailyNotePicker.js\":\"a241eae0f6d7709c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"71e827bf9467c6fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateNavDecorator.js\":\"efec949c852ee41d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateScrubOverlay.js\":\"3f5f3f9ede7fa91e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayPropertyControl.js\":\"d8042db39978d9bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayValueReferenceControl.js\":\"7caef207840362ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/HeaderItem.js\":\"30f7390560392654\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/ReschedulePicker.js\":\"415e3872c265254c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/SpreadDatesDialog.js\":\"7ad379d792957e18\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/actions.js\":\"0056ae25772dcdfd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/blockDateAdapter.js\":\"32a162110afad679\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/calendar.js\":\"5f54f05b61f38938\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dailyNotes.js\":\"2ab58f384d2f544c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dataExtension.js\":\"3bdac421e900768b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubActions.js\":\"d52379a0b4daf5cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGesture.js\":\"40afc44d51f60666\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGestureActions.js\":\"91ab9f05c5d15bd3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9be404fbf832496b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayProperty.js\":\"a99761e09ce94731\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"cd6e02ee6c255358\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/deletionGuard.js\":\"7aebf847600fb63e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dueQuery.js\":\"25e202278aacf8bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/index.js\":\"f5ec99d2cdb03607\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/landing.js\":\"e7c3b8c363486a24\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/localSchema.js\":\"3768a031e64b3765\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/referenceDateAdapter.js\":\"7b4a9ace3709c932\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/rescheduleAction.js\":\"ef3f2c1de08c970b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/schema.js\":\"5685724b32318f0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadBlockDates.js\":\"28e35a163535eac6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadDatesAction.js\":\"292dadcdea51820d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/today.js\":\"f67752450a29a87c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"9345015a2a6664d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"5f8de83112c40259\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/audit.js\":\"e3bd91c391ed8946\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditAction.js\":\"21ceef34dd04a97f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditRanges.js\":\"6e6d29be0c90649b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/diagnosticsSource.js\":\"39d90c65c9bfe74e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/divergenceScan.js\":\"7a7053fd776cf309\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/index.js\":\"17e781ef4a13a174\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c93db7f66d2a320f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/referencesMirror.js\":\"0635a38c34305c6d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/rowJson.js\":\"452db206f7455f5c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/schedule.js\":\"c46ec42f755e699e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/store.js\":\"6583e41885839b5b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/action.js\":\"c324ab11d64a2b6d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/index.js\":\"48857f4fae98cff2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/plugin.js\":\"fb7465243e655515\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"5e4d5acf3b641965\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/actions.js\":\"2c7a1e40bf02e0f1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/changeMarker.js\":\"57aef496cd9bd854\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/diagnostics.js\":\"988386b841fa87d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/fileSystemAccess.js\":\"16f38b7a3da93802\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/filenames.js\":\"acd5241ce39eac1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/index.js\":\"86b705403890e146\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/mirror.js\":\"a77db740b6f169e4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runLock.js\":\"cf52b242db6d7a3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runtimeHealth.js\":\"0293dcd7b71f3756\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/schedule.js\":\"9532285b6dffcd58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/store.js\":\"a290c9647732fef4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/index.js\":\"5cc3962d201b254c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/themes.js\":\"8898ac3649e1658e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/facet.js\":\"f2d4f7b809ce7a92\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/useDiagnostics.js\":\"ae8219cc5f5dcf2e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/dismissals.js\":\"d3470072da40b62f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/index.js\":\"8c153e34a1ae7161\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/status.js\":\"8de7342392cc6341\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/store.js\":\"6885a63ccda567da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4ecb18f7a157bfc0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsSettings.js\":\"1f040618961ccafa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/actions.js\":\"38422180f34912fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/config.js\":\"1749113b1b5725ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/dataExtension.js\":\"633580e47c65da20\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/effect.js\":\"e336d28e3891f9bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/index.js\":\"d81069a581ba6618\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/propertyEditorOverride.js\":\"80f4d8b48df1774d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/useToggleTree.js\":\"26a42d6387bc8b5f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/ExtractTypeDialog.js\":\"58e4e2a6cc340769\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"654903481b37c594\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/PropertyShapePicker.js\":\"9ce917292f50685b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/action.js\":\"2e6bb178a8410d7f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/index.js\":\"cb27c41d2fcac5d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/FindReplaceDialog.js\":\"b9bff6c81d57f0ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/HeaderItem.js\":\"936f19ad5e98f359\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/dataExtension.js\":\"861bf8bff56af8a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/index.js\":\"f93708a761d50282\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/search.js\":\"60f27862ac770fa9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/toggleStore.js\":\"82ad964a374a168a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/LocationPropertyEditor.js\":\"9d02d4ac1679a7c7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/MapView.js\":\"cc1e489a00ea26eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/blockTypes.js\":\"8b38439b17c37860\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/codeMirrorExtensions.js\":\"a503e91450ca97f1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/createOrFindPlace.js\":\"84c6416b130afa74\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/currentLocation.js\":\"3b8dde378f9338a3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/dataExtension.js\":\"5b40e843c64e5497\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/geoContentDecorator.js\":\"821df2fd2c220be1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/googlePlacesClient.js\":\"1c2a7a5a493fc5ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/index.js\":\"f19a2f83b9caf2d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/locationsPage.js\":\"4a0ee49c1ecc0f5c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/mapViewport.js\":\"fc87f474b7993474\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/pickCurrentLocation.js\":\"7b763fd2f65a1300\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeAutocomplete.js\":\"cd429cd562be6c63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeNameCollision.js\":\"813368052f83721b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/properties.js\":\"dd62e2766f46b858\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/propertyEditorOverrides.js\":\"88ed5db9ac80a4a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/query.js\":\"57c9b74fa479d875\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/usePlaceSearch.js\":\"18da7b521c6d838b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"050092dae8e82562\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"d3f084255fa690fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ffd19e6ab4b25d5d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/config.js\":\"ad6441c93b0d6b13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/dataExtension.js\":\"0c7de5fa8a93a418\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/facet.js\":\"ce6d798b71e7645c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/grouping.js\":\"056f261887691ed2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/index.js\":\"e728a23cd11b63af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2db34f3e253a195b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/query.js\":\"1d6e537c217c33d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/resolveConfig.js\":\"b51621deb3649b0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"6cacdb7b23aff233\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f3e4c1d786201555\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlDocumentContent.js\":\"d3fa311750923a5a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlFrame.js\":\"386faf2856dea284\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/actions.js\":\"2506012a9aa4664e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/blockType.js\":\"bcda9641b92d6b51\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/confirmRunScripts.js\":\"49b7a0f93ee6a07c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/dataExtension.js\":\"d9a077a1633d3cbc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameAnnotations.js\":\"61cda4832c019ff4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameDocument.js\":\"0935f6ab687aeed3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameTheme.js\":\"113c781ead65ec4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/index.js\":\"4e0ea6568b8f4bb0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/scriptConsent.js\":\"a545daaf6100ab94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/sourceMap.js\":\"b52cee20c9ee8911\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/useDocumentScripts.js\":\"e9b80baf3a9c94d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/index.js\":\"d17b8068a97ffb93\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/record.js\":\"1c121d11cc4eac45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/recordStore.js\":\"71c8a9178c40383c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/responsiveness.js\":\"ebbeb728682887e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/schedule.js\":\"fd084c8c491ed561\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/sessionContext.js\":\"dc7b15b3f24fe99d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"4fe314078e295f1c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8888b7333bba3ba3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/actions.js\":\"cd69e8c8f65856db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/config.js\":\"3ecc40c6db02cdbd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/dataExtension.js\":\"93266473818d9b69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/effect.js\":\"0f716e8fb80c3072\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/index.js\":\"7368a87e0abb26b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/keyCapture.js\":\"cb47db229e9fe805\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/overrideStore.js\":\"275b763082390c9d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e80547ec749d2376\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/HeaderItem.js\":\"c1143f629894206b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/LeftSidebar.js\":\"d5103d428fa8ec3f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/actions.js\":\"9573799eb5d662bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/facet.js\":\"81020b34562a1495\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/index.js\":\"c345174f8513030c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/shortcuts.js\":\"bdad0cfc3226b7aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/toggleStore.js\":\"97a4504caa55c80d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/MergePicker.js\":\"08473ea351edadec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/index.js\":\"6292168159c07fe9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/mergeAction.js\":\"69147891c73bc967\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/strategy.js\":\"3a34139a4d2847af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/Button.js\":\"1fa6183ebdb30dfd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e1643a4bd5af6c94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/defaultItems.js\":\"9b8c8c414bb0795a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/facet.js\":\"31361da4872d5bae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/index.js\":\"824dc39aef4e38d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"e24fd215ee0fe3d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e200265f43c82545\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"c0c12ebe023adf0c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/facet.js\":\"591b85d17f02d297\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/index.js\":\"18efcfe386be8cb9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/MoveDestinationPicker.js\":\"41f8deda09afbfca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1d81b40b2c2e70a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/contextMenuItem.js\":\"6d839d9da257fdbd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/index.js\":\"7e50c8aa9dac7f65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveAction.js\":\"5939a2491a55180f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveBlocks.js\":\"c49665f13f2158aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/selectionAfterMove.js\":\"2a2d3a8f2be61de4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/TutorialBanner.js\":\"ea441bfda2b14069\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/action.js\":\"67aaeb4190eed5bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/bannerDismissal.js\":\"20fa604927a2f2d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/documents/cheatSheet.js\":\"dd39303f173080e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/index.js\":\"ea2e7b80b01ee9cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/keys.js\":\"8e1db61c0b20eb8f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/landing.js\":\"746a960a6770a513\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/outline.js\":\"8f2897d72a3d1463\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/seed.js\":\"19229fe980de25d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/PerfTrendDialog.js\":\"e79c1761969f0acb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/analyze.js\":\"5bf2625649f43fee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/diagnosticsSource.js\":\"aaabfadf533b42b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/index.js\":\"c12219b8d9dc7081\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/load.js\":\"0bafd353a4c9855a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/monitorRun.js\":\"08252be706d3442b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/schedule.js\":\"af97cbaebb96a64e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/series.js\":\"ea615eb826517fde\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/store.js\":\"aba2982331254696\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/trendAction.js\":\"f4bc4c689057342b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/verdict.js\":\"dad42dc6e1afff92\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/clickToEditAction.js\":\"29dd0270a9e63828\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/index.js\":\"a0e94ade90e95f75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/interactions.js\":\"4cc8b2b592c4f6d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8aeb8f6c9f634ddb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGate.js\":\"c3e255558842a5dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGateDialog.js\":\"493073296d858b86\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/action.js\":\"f81645b96dd4c716\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/index.js\":\"f715e12223cbb01b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/localRunMessage.js\":\"8fef7dfcc2c05a55\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/plugin.js\":\"8b45fab868ce79e8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/progressReport.js\":\"1af35c23cf629065\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/sweepProgress.js\":\"670ab51766df2752\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/FieldRowRenderer.js\":\"b68775e6c94a1129\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/ValueRowRenderer.js\":\"a5826c944f0a6aed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/actions.js\":\"9835be9ddbaa7172\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/autocomplete.js\":\"4a7f5b4fd460fc93\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/fieldRow.js\":\"018f6fc1b14af4ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/index.js\":\"89f11a1f0e91d50c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/referenceWarning.js\":\"8e179daf92a5d40a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueAutocomplete.js\":\"5067d709c3ac1411\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueSchema.js\":\"68f4bf2624260a11\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/HeaderItem.js\":\"dffd4a8478222f91\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/QuickFind.js\":\"b91366e3cebf2a89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/index.js\":\"b36a1485feee74af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/recents.js\":\"793411044abfb91d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/resultItems.js\":\"903860328f9f2208\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/selection.js\":\"23f98c7f28ba3f46\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/toggleStore.js\":\"581bb96505dbd93e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/HeaderItem.js\":\"6853ff7399a2229b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/RecentsPageBlockRenderer.js\":\"cc87942122f36f73\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/grouping.js\":\"9073a505429b3e16\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/index.js\":\"1e962f11f1829a7f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/target.js\":\"d39d71b2bff769c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/codeMirrorExtensions.js\":\"447e75f08a297961\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/contentPrefill.js\":\"c069bc5053dfd784\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/dataExtension.js\":\"bc7402fb2bebfe86\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/index.js\":\"f0007855e1894311\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"ecdb6d3bdb938480\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/invalidation.js\":\"d5cff0715491216c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/localSchema.js\":\"5b647dd05277cc93\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/index.js\":\"6ecd5692039f13c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"1747d0c5c3719d64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/index.js\":\"2c33f4ff963ab7a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/referenceNode.js\":\"5e74de01ef8850f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/remark-reference-occurrences.js\":\"9606b0f24bbe35e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7569be0047ff6371\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/index.js\":\"35085028563ba198\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"899bc3f686019f13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"e58cbe6f03ae6cbf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/mergeRetargetProcessor.js\":\"f7e0429785760acb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/parseFence.js\":\"8a45a5e9371d7528\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceParser.js\":\"b87cb6d01f16f041\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceProjection.js\":\"c37a0b405e549937\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referencesProcessor.js\":\"2cf855b21cce3ec6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/renameProcessor.js\":\"238987bd0811d938\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/spanReplacement.js\":\"2698cf5e8a3e70cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/htmlToOutline.js\":\"13298b05eca59d26\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/index.js\":\"e280e772b5cfc52f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/normalizeClipboardDom.js\":\"d0cf26ab704220a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/pasteDecision.js\":\"5e3114ce167153a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/action.js\":\"1703d70b1cc322bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/blockIds.js\":\"85f91984e5cd1416\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/content.js\":\"9327fe68a8d6ea09\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/effect.js\":\"8635d2dd492255c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/ids.js\":\"c7101dbb911daf9e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/import.js\":\"d069f6b25ea63ad5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/index.js\":\"f826bd951ef48a72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plan.js\":\"5ea355732e288441\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plugin.js\":\"173fa89d2df70fa3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/promotion.js\":\"99eac6d8653c2315\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/properties.js\":\"6eec66fd9d24104f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/references.js\":\"db0827d529598f12\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/report.js\":\"a974c3bfd950722b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/roamMemo.js\":\"bdce26aef7ca9c0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/runtime.js\":\"9fe8964fddf1c79c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/schemaReconciliation.js\":\"b1b2894713e596d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/srsMarkers.js\":\"d484e576b92ba972\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/todo.js\":\"cfea62c94f4b6f39\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/typeCandidates.js\":\"d8838a8620c365f1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/types.js\":\"1b636390f00cf035\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/index.js\":\"2a022097c42f0a69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/store.js\":\"48bc2126b5590047\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/HeaderItem.js\":\"0e195ef03ab132b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"699bd7c0ae89f7bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/index.js\":\"e5c0d98bdead9026\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/model.js\":\"f1bd29af4f23eecc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/toggleStore.js\":\"f9327e810c15c8a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/useKeyInspector.js\":\"cf5f4358e35ee8ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"69fd89d14f8d73e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/ShellDecorator.js\":\"14f8781de52284ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/actions.js\":\"ebdfdbb6635386f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ad5a75eae579fab1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/index.js\":\"22d5bff609e63c83\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/shell.js\":\"24a2fdbccaf366a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/surface.js\":\"10a13a8ccd167db2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/walker.js\":\"70e9609877c163e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/RescheduleToast.js\":\"990e07034e1f434b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/dataExtension.js\":\"c2a917bc80871ef7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/index.js\":\"e73bfbf01aef494d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/indicator.js\":\"a44d9c95df73719b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/moveSrsState.js\":\"8cb457d453354a6b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e107d0ef42dd7949\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/scheduler.js\":\"eec0e4648c2747c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/schema.js\":\"459da2afb7716498\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"220e10b9b0329c6f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsClipboard.js\":\"0e3106df0ecb34e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"63c490e1131d7487\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DailyNoteReviewHint.js\":\"83fb13031125d1a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DeckPicker.js\":\"1f2ee86d5dc9eb21\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewControls.js\":\"82fc3c3f90f081f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewDeckRenderer.js\":\"69414e6684630b37\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewSession.js\":\"89c6153e42698cf5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/actions.js\":\"a75bc1a44d99893c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/archive.js\":\"2cf452dc9e19d93f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dataExtension.js\":\"6ed26f23516a7af9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/deck.js\":\"535f9ddb588c6ce0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dueQuery.js\":\"696767daa1ba728e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/gradeDecision.js\":\"59c56293f3990d24\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/index.js\":\"d79e877e2f052cd6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/keyHints.js\":\"28d197c9233e7ab2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewCardLayout.js\":\"af5970a8271db509\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewProgress.js\":\"7286be27290e95a3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/schema.js\":\"ff8f93bb3c29080c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/useDueCards.js\":\"fa03cd53b454e360\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/index.js\":\"dc7ed19f4d9d66df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/record.js\":\"0ee1cba4ed03ca67\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/index.js\":\"b5c01eba1bf341f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/persistenceStatus.js\":\"4e169cc10d6794c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/requestAction.js\":\"7efbdfb053ca7a0e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/TypeChipsDecorator.js\":\"d5289bff24e6c31c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/codeMirrorExtensions.js\":\"6c0dc75b8ebe51ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/index.js\":\"b3d73d0a9c13a9cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/typeAutocomplete.js\":\"d262c5c96c35501a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a8db705a8b6223db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/actions.js\":\"56e9581a52a145ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/anchor.js\":\"0821f1fa39144a98\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/events.js\":\"bfc57d9e639ffae8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/gestureActions.js\":\"921ad166d56f0cee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/index.js\":\"094c088048743e71\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"cdd30bdc81ed913e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/collect.js\":\"68bc14f316b7e53f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/index.js\":\"04968de8607fc84d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/record.js\":\"e6e1304f512ce360\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/RejectionDialog.js\":\"2aba271f90adeec2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/SystemStatusHeaderItem.js\":\"352446ccc45a77ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/index.js\":\"789f54af48981b6b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/model.js\":\"c4358889b3d5c2f1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/queueCounts.js\":\"3f324d1138ea6fd8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rejectedHelpers.js\":\"6fa2c8fcb651bd5c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rematerializeAction.js\":\"efdd51ac76e05de5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/useHysteresis.js\":\"5c90f44b321f0fd6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/ColumnHeaders.js\":\"ff63de5a24871d07\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/QueryUi.js\":\"13ea902a25bdc109\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/TableLayout.js\":\"61551a8b2b95c740\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/actions.js\":\"b629aa1645320a7e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/cellEdits.js\":\"488840d3d1d0132f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/childrenViews.js\":\"a9135075e47b928f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/columns.js\":\"a6138311f87fb9e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/controller.js\":\"6e9245270b8f260b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/convert.js\":\"b3ca84cfe3593029\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/dataExtension.js\":\"0331078f700a6622\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/index.js\":\"687a06a76946bdbe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/keys.js\":\"206cb5f74f7c41e4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/model.js\":\"a90a80f0e0510723\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/QueryText.js\":\"37472fbee4e9616a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/backfill.js\":\"20f8510c4ffe344b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/completion.js\":\"c576ad390fa00761\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/format.js\":\"14b281ec0620f9d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/parse.js\":\"1f98947c6863d68d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/queryValue.js\":\"371b588b04f0af69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/registrations.js\":\"9bd04b21c8a85200\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/source.js\":\"f71ee52144500753\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/registry.js\":\"f48e6ac702a01c88\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowGutter.js\":\"6848a1cba5fb5804\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowVerbs.js\":\"a2d6f0829331fa58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/schema.js\":\"0b5e4ebb1075cf6d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/sort.js\":\"8f8d609dd863805e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/effect.js\":\"38b283520fb951fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/index.js\":\"b27293c95585803e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/theme.js\":\"4cd47bf942099c7d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/actions.js\":\"eb0901b936e54b2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/dataExtension.js\":\"5e3b5d1c8ae70f6b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/index.js\":\"ba6d32883b66e783\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/schema.js\":\"b2735836a395968a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b13b2450f37d4761\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/actions.js\":\"10620a0fe0c90aba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/defaultItems.js\":\"5da0353a05ebc00b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/facet.js\":\"e71db0cc0435bb4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/holdRecognizer.js\":\"18393cdb176aaa87\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/index.js\":\"fa64db23a772890a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/UpdateIndicator.js\":\"428204c9cfcb7d32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/index.js\":\"5c824753b8877951\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/loadTimes.js\":\"9b673804985e491e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoNotesRenderer.js\":\"dc7b16201ae89bb1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoPlayerRenderer.js\":\"60c53aa5716432ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoTimeStamp.js\":\"738385f23b32ea20\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/actions.js\":\"85ca15352cafe077\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/index.js\":\"909f1645641b026d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/markdown.js\":\"fd746794cbad9e59\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/notes.js\":\"650767917f51726d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/registry.js\":\"2c329acb7eb901c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/remark-timestamps.js\":\"fca0d49f67878c34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/view.js\":\"90f76d41ccb3c4fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/LinkHints.js\":\"3303de49cdcbe532\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/index.js\":\"91f819c3a26b9df8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/model.js\":\"8448c80b8b560520\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/settings.js\":\"3cf9d37d1cd840fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/actions.js\":\"8f333aa99951bcf6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/index.js\":\"9ec4a0d12af1e121\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/interactions.js\":\"4efc2ed9919b92ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/workspace-header/index.js\":\"ccaeefd73f73f1ea\",\"/knowledge-medium/pr-preview/pr-1899/src/registerServiceWorker.js\":\"e7c9fc497f470e4a\",\"/knowledge-medium/pr-preview/pr-1899/src/requestPersistentStorage.js\":\"80f5fbb644b2028a\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authRequestDeadline.js\":\"62d12f192bf329fd\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authStorage.js\":\"8c66e31c861986cd\",\"/knowledge-medium/pr-preview/pr-1899/src/services/powersync.js\":\"2e9c646f675ad5de\",\"/knowledge-medium/pr-preview/pr-1899/src/services/supabase.js\":\"e4133b47575367d0\",\"/knowledge-medium/pr-preview/pr-1899/src/services/uploadErrorClassifier.js\":\"302ee35d872eafb0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/ActiveContexts.js\":\"218d186b149bf251\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/HotkeyReconciler.js\":\"549163da0ead99f8\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/WipeLocalDataDialog.js\":\"f41788dc8e5bcd8f\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionDispatch.js\":\"a325d5c66179fa9b\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionRefItems.js\":\"6b008c0e6a05ec14\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/applyKeybindingOverrides.js\":\"f8456408ce7f296b\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockActions.js\":\"fe02b726aa3e6358\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockMergeGesture.js\":\"6a90b044079127a2\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/canonicalizeChord.js\":\"258530346756fdb0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultContexts.js\":\"54413ea56b091cfd\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultShortcuts.js\":\"f9f7a97c0ab3a3cf\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/effectiveActions.js\":\"d98aebd96e9a51db\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureAction.js\":\"d599f19b5c4a8189\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureBinding.js\":\"dcb97584f64926a4\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/holdRegistry.js\":\"237a29dd7eed7dff\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingConflicts.js\":\"e4ebc347ae670d39\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingOverrides.js\":\"7623b1f932a054f7\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/pointerAction.js\":\"2863277cfd729ff4\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/resolve.js\":\"a8f12e725599df35\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/runAction.js\":\"110215ae602e98eb\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/sequenceMatcher.js\":\"7656e9390783d966\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/types.js\":\"7f28139826980c87\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionContext.js\":\"d3b541f1f257b231\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionDiscovery.js\":\"a1d2d3b76d1d9887\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/utils.js\":\"4f0a50cb1fc9fcce\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/bootStore.js\":\"65fee694699455b0\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/previewDatabases.js\":\"e43dec325857aafc\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/byteTransform.js\":\"c42788b7dd910820\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/attachmentCleaner.js\":\"405ca3048a5eb12f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/attachmentParts.js\":\"adac319ced26118f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleParts.js\":\"0756ecf2757e4efe\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleRecord.js\":\"4c9f70c03b6ffa05\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/manifest.js\":\"d1c9f80764c58494\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/takeBundle.js\":\"e5c5b2e0abd9e9ac\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/verifyBundle.js\":\"2ab82a81d48d0f5a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/cleaningStage.js\":\"5cd743fbdf1f537d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionKey.js\":\"1489ce3c436b1f6d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionServer.js\":\"575995266327def4\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flip.js\":\"9fbd6c86a6ccc881\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flipAttempts.js\":\"549ee406118d993e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/pages.js\":\"8f4c341fd03570f3\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/preflight.js\":\"271c32ced1a71276\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/reseal.js\":\"f87e459cc024eab0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runConversion.js\":\"863e7772233e96d2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runLock.js\":\"38494dd54ce54b33\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealing.js\":\"55c4bd71ea469fe8\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealingStage.js\":\"9d4ab01cfee6c08c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/stage.js\":\"d983571a0408d59c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/verifyReseal.js\":\"8e5bb2ef3b30bae5\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aad.js\":\"e80628a50f096de6\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aead.js\":\"beeb84caa4e2015f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base32.js\":\"b366040aec02af4f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base64url.js\":\"22c57a897575f620\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/binaryEnvelope.js\":\"2fd35db378f18efc\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/byteAead.js\":\"d13878a9b2f98da7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/canary.js\":\"56714671ab259cd1\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentHash.js\":\"3221a14812b8753a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentKey.js\":\"8bda27f6c1ccf15c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/derivedIdNamespace.js\":\"b2251a9894daff4d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/envelope.js\":\"018f7d687cf82039\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/hex.js\":\"97451028df0bfbf5\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/sha256Hex.js\":\"ec91dd11e0c0c091\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/workspaceKey.js\":\"222d4b16b1d9b5a6\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/conversionState.js\":\"566b61fdcba1f454\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9909932ce242fb65\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/pastedKey.js\":\"f85e696135bff1c0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"88f127bac8711abd\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/upgradeWorkspacePin.js\":\"0601dca83dde2688\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/keyStore.js\":\"953d92e7add60f7f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/mintWorkspaceKey.js\":\"f577fd821e08266e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/modePin.js\":\"b8039eac1f9c7c63\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/openWorkspaceKeys.js\":\"2eb36cef1282586a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolveWorkspaceEntry.js\":\"1866bc75fbbcd04b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolver.js\":\"1a6a4d2bcd17feb2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/workspaceAccess.js\":\"9a4c4e0205e567a6\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/transform.js\":\"ebb9db0d174b2c32\",\"/knowledge-medium/pr-preview/pr-1899/src/themeBootDefaults.js\":\"4b56719b1e422fb1\",\"/knowledge-medium/pr-preview/pr-1899/src/types.js\":\"987c4a02e227225e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/ClientLocalSettings.js\":\"2005192aa771d085\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/abortableSleep.js\":\"2810c81f71764538\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/array.js\":\"e32b7494e4dfd9b3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/backlinkAutocomplete.js\":\"e07d89079737c5fa\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockCrumbs.js\":\"8f50adc556b92847\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockrefAutocomplete.js\":\"d5fd52c259e6ee7c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/cadencedIdleJob.js\":\"7116f3f5ee87f256\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/callbackSet.js\":\"f6d2a33eca7062aa\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/clientId.js\":\"a38fc239b0fa7078\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirror.js\":\"f427e9795f2add57\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirrorCompletion.js\":\"d27983fccb690617\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/copy.js\":\"9ea3a2e94e7b0c89\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dailyPage.js\":\"dfe3566c6534d3a3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensics.js\":\"182324763074276f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensicsHooks.js\":\"3e545859daff6ce6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/deleteBlockThroughUi.js\":\"250e50f7fb5d04e6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dialogs.js\":\"f2cce2e0e9472c52\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dom.js\":\"939cd3d90ee4eccd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/downloadBlob.js\":\"6db54c32161bda4f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/drawnWalk.js\":\"cdc5b83c08c33929\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/exportSqliteDb.js\":\"f1756fe051f902dd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fileSystemAccess.js\":\"a82af878076f2d4f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/flipSlide.js\":\"b41d219551ae741c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fnv1a.js\":\"6dcd247a92a62f1f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/formatBytes.js\":\"b30af68563ba1b4f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fuzzyRank.js\":\"ae4b61736e87306e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idbKeyedStore.js\":\"465145373efde9fb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idleCallbackPolyfill.js\":\"c1ddc2f67936882e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardAwareScroll.js\":\"a89a430b74e077a3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardViewport.js\":\"a6610486debee716\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/lastWorkspace.js\":\"f0df45790b70fd4d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutColumns.js\":\"97b31addc7ba0cdd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionDom.js\":\"5e43f39eadf35511\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionId.js\":\"42e8b2aeafc3449e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkClickGestures.js\":\"512deb8aac887b17\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkTargetAutocomplete.js\":\"072a4cd38941e927\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbCorruption.js\":\"48218c0ff9e2e092\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbRecovery.js\":\"3583549cc04e11f3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/markdownParser.js\":\"5cd1d0806eeccde9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/memoize.js\":\"b48b6de598a28612\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameFieldCommit.js\":\"b52f31643179ba05\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameList.js\":\"54967e86648657a8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/navigation.js\":\"eb629670a5cdb1fe\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/omnilinerNamespace.js\":\"cf7dda1f584a8ab6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/opfsPageScan.js\":\"170f92e611ad8bb6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelClearance.js\":\"928035d86c9891c3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelHistory.js\":\"1a47efb4d07c430f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLanes.js\":\"df47a93b3c35ce50\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLayoutProjection.js\":\"b9d0c79776ab1b13\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelScrollAnchor.js\":\"e53e730f35d2e8c3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelUrlFlags.js\":\"03e56e5acb062017\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/platform.js\":\"b7f51cf12229750f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/pluralize.js\":\"f149d3e000cb5e37\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyCreation.js\":\"b69d1bccff7d5294\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyNavigation.js\":\"1dca955de8f6a7ca\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyValueContext.js\":\"9b17a8039a89203d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/react.js\":\"082ecf6f551c8136\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeDate.js\":\"1aafb952b167db6c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeTime.js\":\"f0630709fc0e6ec7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/renderScope.js\":\"397ba9f5edebf130\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/resolvedThenable.js\":\"9f63fee26f91f4b3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/routing.js\":\"5bbea4c5725e20c6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/safeMode.js\":\"36f2fa989947cda4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/scheduleIdle.js\":\"0b003e78a64ade94\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/screenWakeLock.js\":\"0d8074eea0755a70\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/selection.js\":\"9acf262a3b2c96cc\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/softKeyboardGrab.js\":\"f25ef41dd2f66149\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/startupTimeline.js\":\"51a9967442bc54d8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/state.js\":\"62909b62729b20ac\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/string.js\":\"e8768056f078e17a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/surfaceZoom.js\":\"360bf82b07cd78a8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/time.js\":\"0d8347d1f198a97d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toast.js\":\"aa9232dfd6754ef0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toggleStore.js\":\"0a0f3d760dac58ee\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/untilStopped.js\":\"79a89ce063ff2c54\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/userActivity.js\":\"efc7de24aca9126b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewTransition.js\":\"7ffee4887781c5a9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewport.js\":\"9542c189a90f4868\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/webLock.js\":\"13cfb8233ffdba77\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceRecovery.js\":\"7dadf436fe31aa0b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceSnapshotStore.js\":\"4150760963f340e3\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-compiler-runtime.js\":\"f12ddb36145e1c60\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-client.js\":\"4b7878c3850a6e35\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server-edge.js\":\"022c27f9f37d04e9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server.js\":\"db4141e99d3b2a4a\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static-edge.js\":\"cfe1e1dc47807be5\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static.js\":\"2f04549d05bfa3e5\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-test-utils.js\":\"76aff465b9f28c7e\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom.js\":\"8622f81bb8c94500\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-runtime.js\":\"550138766bb2b797\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react.js\":\"2ed7916f8fc91fbc\",\"/knowledge-medium/pr-preview/pr-1899/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
