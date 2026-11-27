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
		buildId: "5fc1708db50a-5abffe25",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/\":\"e67d55d1b930c207\",\"/knowledge-medium/pr-preview/pr-1899/index.html\":\"e67d55d1b930c207\",\"/knowledge-medium/pr-preview/pr-1899/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1899/assets/FacadeVFS-B9jLqfab.js\":\"763eb4093bd8fee9\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSCoopSyncVFS-DtwLKy83.js\":\"f73515a3f3333054\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSWriteAheadVFS-BONy0fP0.js\":\"887ab736a6c34c93\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-DLFUAwdX.js\":\"a0e59f29cbc87ea2\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-BshiGTRj.js\":\"4e27ce816562316b\",\"/knowledge-medium/pr-preview/pr-1899/assets/worker-Bk7aBePL.js\":\"d82d7b0a70bac9ec\",\"/knowledge-medium/pr-preview/pr-1899/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1899/chunks/app-B132I0iU.js\":\"fb37bc2bd4b06056\",\"/knowledge-medium/pr-preview/pr-1899/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1899/index.js\":\"3a9c18e1fb7ecfa5\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1899/assets/AccessHandlePoolVFS-CyBIsY5o.js\":\"0af4b2b63384cece\",\"/knowledge-medium/pr-preview/pr-1899/assets/IDBBatchAtomicVFS-qTpzDvaH.js\":\"d09c029ddd907795\",\"/knowledge-medium/pr-preview/pr-1899/assets/MemoryVFS-Cbqj_-X1.js\":\"db2fee2b41dfcb76\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cof1KQIi.js\":\"e3aa4671dc972e48\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-C6Nt3FpC.js\":\"ad2ce872698709cb\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1899/chunks/AccessHandlePoolVFS-CAD-QVjK.js\":\"05127376e07f1ee6\",\"/knowledge-medium/pr-preview/pr-1899/chunks/FacadeVFS-DlkyxPk9.js\":\"2702a0972724c4ea\",\"/knowledge-medium/pr-preview/pr-1899/chunks/IDBBatchAtomicVFS-BO2bWEF8.js\":\"3c6d38c4b5dafb2e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/MemoryVFS-jiwBojgh.js\":\"79ded026eb7863db\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSCoopSyncVFS-CgNG7YR9.js\":\"de4913081cc030be\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSWriteAheadVFS-B5gOcHAf.js\":\"3b4f0862b238a367\",\"/knowledge-medium/pr-preview/pr-1899/chunks/Preview-BdjrhpXr.js\":\"52ae78d6e7f61b7b\",\"/knowledge-medium/pr-preview/pr-1899/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/card-Byi7Bt6K.js\":\"3d29c836096b25ba\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-C5Tx-zSQ.js\":\"5a1c96bc4bf3f2a5\",\"/knowledge-medium/pr-preview/pr-1899/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-KOTd-Jz-.js\":\"830f130835e933c7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-async-DXpyFyuH.js\":\"07d730191d5534b9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-BDev3oAZ.js\":\"425c4b308c9839dc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-CaXBMldc.js\":\"9aa9e33fe5c17cdc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-ClzY54Qm.js\":\"e3042cb6d09bb21c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-Cmzn454I.js\":\"3e8ada8453218642\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-D2tzQ_NL.js\":\"6029235da1b4d8df\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DfpC23in.js\":\"bde57a862d5c85a7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DzJM75UL.js\":\"9c6d15c8578dc7c3\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-OFt9h9dY.js\":\"4b6dac71e3574037\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server-legacy.browser.production-D6DR3m8K.js\":\"4f6d6e68a1321996\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.browser.production-CFFlSL4g.js\":\"3c4e8b9dcdce938d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.edge.production-DEcfN1yr.js\":\"e9acefca5a01e8f8\",\"/knowledge-medium/pr-preview/pr-1899/chunks/server.browser-iDuQ_xz0.js\":\"933dad427d67fa14\",\"/knowledge-medium/pr-preview/pr-1899/chunks/textarea-w5bgGNsS.js\":\"83caa37898e4a80e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/ui-rVUsDvDE.js\":\"0fdd41f1fc6cb9a0\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-async-KolfQSRg.js\":\"1536c52324bb822c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-jj9ouo2A.js\":\"026bb57fad7ed299\",\"/knowledge-medium/pr-preview/pr-1899/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1899/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/src/App.js\":\"7128c230fd52a1e4\",\"/knowledge-medium/pr-preview/pr-1899/src/appUpdate.js\":\"b21f22619f4e7c5b\",\"/knowledge-medium/pr-preview/pr-1899/src/appVersion.js\":\"dfa52198486f8ea6\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/initialLayout.js\":\"7aab3026d463c4f7\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/openWorkspaceData.js\":\"55bc53205b1b734a\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/resolveWorkspace.js\":\"437096caf6d470a5\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/workspaceBootstrap.js\":\"b4f2de5da8caab7e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockComponent.js\":\"3aad199b7634b9d4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockCrumbs.js\":\"2dff8ce0c87a8a76\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockEditor.js\":\"11dcff9c8c980972\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockLoadingPlaceholder.js\":\"e5c2b43a3259fabf\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockProperties.js\":\"389c08e4e2067196\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockSearchPicker.js\":\"fba171400bc8cc46\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ConfirmBulkDeleteDialog.js\":\"349c8357fce2d6a7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DividerHandle.js\":\"c0e0fe7a39999215\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DraftEditor.js\":\"f06050265997ed06\",\"/knowledge-medium/pr-preview/pr-1899/src/components/GutterPill.js\":\"86bdebbb16b3ec81\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Header.js\":\"ace701e24c2d4c5b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/LazyBlockComponent.js\":\"a059ada993841700\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Login.js\":\"0515e90cd1422f03\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ZoomableSurface.js\":\"bfa01c749aa6ce5b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/editModeKeepalive.js\":\"107b97af3a46ff38\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyDisplay/PropertyDisplayScope.js\":\"5200510e3cd3bbec\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"bde29f92a24ec58b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefPropertyEditor.js\":\"93f7456866900a78\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefTargetTypePicker.js\":\"c3b428e659c527ea\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/SelectPropertyEditor.js\":\"f7bec08138b955f8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/TypesPropertyEditor.js\":\"f766d37f6b57fe10\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/defaults.js\":\"0fc5579f619b6af2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/kernelValuePresets.js\":\"77316354b5c8b530\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/selectablePresets.js\":\"fdd1f2a3424aa4fb\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/typesPropertyUi.js\":\"04ae0b214f7de097\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/AddPropertyForm.js\":\"f8e81422c85e3e00\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyPicker.js\":\"7e8321e3711437d8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyRow.js\":\"44411a08debc62ae\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/Rows.js\":\"20c9100ba18ede2b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/actions.js\":\"e29c5820ce190007\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/declarationOnly.js\":\"bf49dffffac8c20c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/layout.js\":\"b47d3daa56de9de9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/model.js\":\"9217658e52a6a0b8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapeUi.js\":\"bf0bfad4802ed181\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapes.js\":\"452d21640a274333\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/usePropertyEditingActivation.js\":\"87c1d245903333c9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/visibility.js\":\"33835cef52c1dcb5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanelSections.js\":\"4637e951b6b2e98f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockEmbed.js\":\"3ff7a4943a34497a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockLink.js\":\"cb3970a8ae63a997\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockRef.js\":\"511b0c4c297ccb00\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/CompactReferenceLink.js\":\"b41eb9df490c83bc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/ReferenceLink.js\":\"dfac239bc57c727e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuard.js\":\"ecc0d643982bbfb5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuardContext.js\":\"aab15dbb4218ce62\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/linkInteraction.js\":\"61f7f7f7f5c8ad36\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/referenceLayout.js\":\"2af8032a2d2c3cf1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/useBlockRefAncestors.js\":\"e75d16ad5b5c7bf5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockGutter.js\":\"0cf50ed885ca3c2d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockInfoDialog.js\":\"68f5145223f9bfc6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockReadText.js\":\"edd8eed038ce8141\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockTypeBlockRenderer.js\":\"76db5a10c87c5ecb\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BulletHoverCard.js\":\"248ada540c97d633\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorContentRenderer.js\":\"6e5d52927ec6c2ce\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"461906ae072d1121\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ColumnResizeHandles.js\":\"3dd93259f1a4f97b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"61ee1027b688b027\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/DefaultBlockRenderer.js\":\"77cfec8e8136c2de\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/LayoutRenderer.js\":\"895844a0feb15f5c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MarkdownContentRenderer.js\":\"2b458602fa4c1f52\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MissingDataRenderer.js\":\"97a18419bb82ceb7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PanelRenderer.js\":\"805f0592a210e178\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0a15216c9d25d10a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/TopLevelRenderer.js\":\"795728854ff635e5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockGutterMode.js\":\"eb923715f5d935d0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockTitleText.js\":\"162584a6850b2758\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/fieldCreationKeydown.js\":\"7eac728770d4526f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/layoutRootContext.js\":\"7218c349180f20b2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/TypeChip.js\":\"422efee371883757\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/chipStyle.js\":\"a7697e9f803be244\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/anchored-floating.js\":\"801e693cd3048c4d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/button.js\":\"d55940426a09de08\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/card.js\":\"4db0b088f871d54e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/checkbox.js\":\"71437aa35c0a864c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/collapsible.js\":\"aa3af2610ae0cff0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/command.js\":\"29c503554a981c17\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/context-menu.js\":\"5d52ee7a1e292222\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dialog.js\":\"3d3542b02d0a5f5f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dropdown-menu.js\":\"7eae6585833aacb5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/floating-listbox.js\":\"baddb9b1525e5e22\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/index.js\":\"12188153b8060a08\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/input.js\":\"fbc317f28c09c4dd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/kbd.js\":\"370bf5b417484096\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/label.js\":\"92960bbdfe5a9a10\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/textarea.js\":\"b8e170882b44e0cf\",\"/knowledge-medium/pr-preview/pr-1899/src/components/useEditModeYieldKeepalive.js\":\"5ca906a7b717c68f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/BootFallback.js\":\"2d1a4957ff23b364\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/FocusedRowLazyMount.js\":\"999ae1061a7309b2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LazyViewportMount.js\":\"f1e11682043d45f9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LocalDbCorruptionFallback.js\":\"673ebe987a69cd31\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/error.js\":\"f403bb222144c4b4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/lazyMountRegistry.js\":\"0afa3c567ade5b3c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/suspense.js\":\"94ac2bc8c61ccd66\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/CreateWorkspaceDialog.js\":\"83d251616590692e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/PendingInvitations.js\":\"c82f8ac84ca19ac1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/SyncProgress.js\":\"e4f27d858f3883dc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/UnlockProgress.js\":\"959f27a6ecd655a7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceKeyGate.js\":\"e84552877c77fd97\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSettingsDialog.js\":\"f9aa4485e40862ca\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSwitcher.js\":\"4af279276c1c639e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSyncGate.js\":\"e3bd155e52f6c879\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlow.js\":\"2984e66c8988555d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlowHost.js\":\"873e19537e42eb62\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/EncryptionSection.js\":\"dc8c0c0fb02370d2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/attachmentPrompts.js\":\"2a6ba0457358b806\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0d0e7781338d1092\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowDeps.js\":\"6f4686ad40b718b4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowStore.js\":\"26a7fb42bce82fc2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/flowUi.js\":\"86c6a4c3fe8efa05\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/useConversionRun.js\":\"2efc55933432e32b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/keyUi.js\":\"18d30ffc67fd52e0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnKeyLoss.js\":\"1dfdae9b5d7f95dc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnServerE2ee.js\":\"de4ad5b477bc73d5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/workspaceUnlocked.js\":\"a40b6ba2177c8460\",\"/knowledge-medium/pr-preview/pr-1899/src/context/backgroundSubtree.js\":\"b87527587a36ceb0\",\"/knowledge-medium/pr-preview/pr-1899/src/context/block.js\":\"a2848fc1acde29ed\",\"/knowledge-medium/pr-preview/pr-1899/src/context/layoutWsContext.js\":\"6106194087b4e485\",\"/knowledge-medium/pr-preview/pr-1899/src/context/propertyDisplay.js\":\"2e04cef093eb64e6\",\"/knowledge-medium/pr-preview/pr-1899/src/context/repo.js\":\"41c8968c50705c5d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasClaim.js\":\"d2ab0fa7e0c7ad3f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasSeatNamespace.js\":\"4bff451cd2d28095\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockData.js\":\"476c75efe669eb27\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockType.js\":\"79bcc4d9ebea0d94\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/changeScope.js\":\"e53774301a5983c9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/codecs.js\":\"a45268fdd77ec323\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/derivedData.js\":\"f75d989cf8cc1b7a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/errors.js\":\"b400f9219341fcbb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/events.js\":\"5ba6bf33ddc086d4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/handle.js\":\"b049a7a99f3a16b0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/index.js\":\"c1f5e7ca64d57df5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/mutator.js\":\"7204fabd0b496179\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/processor.js\":\"e9e2efab9386d0b4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/propertySchema.js\":\"09cfb31837cb7ade\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/query.js\":\"8a278689fcaf2735\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/sameTxProcessor.js\":\"9272987335a606a3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/schema.js\":\"b049a7a99f3a16b0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/tx.js\":\"b049a7a99f3a16b0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/typedBlockQuery.js\":\"1ce29d54510c19bd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/user.js\":\"2f62d4ea9102c4d8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresetCore.js\":\"0b687d6733fb4289\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresets.js\":\"38fd1c48ab09c2fc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/attachmentCleanerIOVerb.js\":\"f52f947920c8c903\",\"/knowledge-medium/pr-preview/pr-1899/src/data/block.js\":\"38f2a6081a3f9542\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockCache.js\":\"c3723782ed6569d8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockId.js\":\"d86e32f8b831bed8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockLiveness.js\":\"a666af0c5db71344\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockMerge.js\":\"8be1096d7ac6d014\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockSchema.js\":\"bf365de15172e71a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypeLookup.js\":\"ffcdf22a20cf88bc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypes.js\":\"a599bf7097d13674\",\"/knowledge-medium/pr-preview/pr-1899/src/data/childrenView.js\":\"fedb57cf2692465f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/clientContext.js\":\"051374d8d83793cc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/dbFileSiblings.js\":\"fed642f5529ec2d9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/definitionSeeds.js\":\"8f4e8d5733915ce0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/derivedIds.js\":\"0f0cfc9a53bf75c8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/drawnSubtree.js\":\"d16b3d5e9cd72195\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facetBridge.js\":\"e47898993a1b409a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facets.js\":\"5fcc89d5af508f93\",\"/knowledge-medium/pr-preview/pr-1899/src/data/globalState.js\":\"6c9634b53888e38f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/aliasClaimRederiveProcessor.js\":\"ae85fdbfb116edea\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/ancestorBatch.js\":\"5ad7b66af97ad522\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/blockTypeTypeifyProcessor.js\":\"a562833484c44e39\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/clientSchema.js\":\"fbce928310c99305\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/commitPipeline.js\":\"504d9ca58103f907\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/devAssertions.js\":\"add2a254aa494c70\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/firstSync.js\":\"aba9b1bee59d8961\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/freshInitialLoad.js\":\"93f67bf94ad8b99c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/graphBackfillClaim.js\":\"5ea241708572f2e5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/handleStore.js\":\"e97475bcc3cfca0e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/idleMarkerJobs.js\":\"4270d25e22a18b2e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initialDownload.js\":\"2a5dbccc1c3028ea\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initializeClientDatabase.js\":\"7c1dec59ec885b21\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/jsonCanonical.js\":\"52b154bc14922ade\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelInvalidation.js\":\"a38baca9284e93cc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelProcessors.js\":\"7e57b138e21870b9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelQueries.js\":\"5533108fa8f0259c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/mergeTypeMembershipProcessor.js\":\"ec74a50cbba05697\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/normalizeReferencesProcessor.js\":\"5f2203b394156e89\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/poolInstrumentation.js\":\"ec67966cc326fadd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/processorRunner.js\":\"ecf9a94626a5dcf9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyCellBackfill.js\":\"814e8bc3222e8553\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildMint.js\":\"600c344618cecc4d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildrenProcessor.js\":\"c639c5f86a612b92\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionChangeProcessor.js\":\"11c3ee97372de1b8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionSynthesis.js\":\"4c9023afc02df6a8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyKeyScan.js\":\"a91b977f6ed12cca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertySchemaResolution.js\":\"31eb185e09ed2bb8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyValueEdits.js\":\"1608498e56b5884f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/raiseProtocol.js\":\"2314ee6826aef88d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/readBatch.js\":\"c3260c6c0912a29c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/refProjection.js\":\"b34b8ae222d0744a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetLookups.js\":\"cd3a34d3f30ac6fd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetProcessor.js\":\"ed553f1a69c63c1a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/replayMerge.js\":\"8cf0333dd8c7ab31\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/sqlBinds.js\":\"3fefbd7cba630447\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"9c9737ce55da5cc6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/arrivalProcessors.js\":\"07e19a0e7309aba6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/invalidate.js\":\"9ebae031f9481808\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/materialize.js\":\"92a931aaa20e1533\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/observer.js\":\"5249db339c251260\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/reconcile.js\":\"fc08fe6f9b0adfa3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/timingMetrics.js\":\"46b21cdd676afdbe\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/treeQueries.js\":\"e60b7127eec9764d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txEngine.js\":\"af24f2747fb29d0d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txSnapshots.js\":\"ef16f1e7fdee18b4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/typedBlockQuery.js\":\"aca652eed49a746b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/undoManager.js\":\"de9a2e5effef753a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/invalidation.js\":\"74a000fb4b375c80\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelDataExtension.js\":\"fd794a119c82f76a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelPage.js\":\"42a0427ea29b5d3c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelValuePresetCores.js\":\"b33336a6b5ee5a24\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbCorruptionSignal.js\":\"0eff48761b3684bf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbStorage.js\":\"7205a6b577785043\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbVfs.js\":\"4eef439c64d9328a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localSchema.js\":\"4b6be4a98518631c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/maintenance.js\":\"3f4e07f0cb298361\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mergeProperties.js\":\"6878fd0e990343ee\",\"/knowledge-medium/pr-preview/pr-1899/src/data/metricsConsoleHook.js\":\"5cf6c8c72c3620d7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/migrationsPage.js\":\"9d744b7262ad061f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mutators.js\":\"c0ceac701c359944\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKey.js\":\"439cd22f5e31418e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKeyPlacement.js\":\"0d680a051bf777b0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/outlineSurface.js\":\"bf3718982ed53e4c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingEditorContent.js\":\"88649491126f710e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingUploadsSql.js\":\"95307da216d6c580\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pluginStateExtensions.js\":\"1e7295b1a4280de2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/powerSyncLogger.js\":\"db1beed0227fefab\",\"/knowledge-medium/pr-preview/pr-1899/src/data/projectorRuntime.js\":\"593c7b94f4e9dc33\",\"/knowledge-medium/pr-preview/pr-1899/src/data/properties.js\":\"d79e2a9a9013e41d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertiesPage.js\":\"c0589fc8c3bf3582\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyChildren.js\":\"bdcae0de5d88c34c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionFanout.js\":\"fd176ce4375dd025\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionMetadata.js\":\"19a6239f23bd2b56\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionRegistry.js\":\"e9b9fc78c0e08139\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDisplayMode.js\":\"27941ee50a9a90d3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyRowCreation.js\":\"f3ed6f6ae01a397e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySchemaCreation.js\":\"36dcafd30fbc4b01\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySeeds.js\":\"091b049302705124\",\"/knowledge-medium/pr-preview/pr-1899/src/data/recentsPage.js\":\"7594ed5f018cc077\",\"/knowledge-medium/pr-preview/pr-1899/src/data/refTargetComparableProperty.js\":\"57551d9de7a40be1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/referenceBlock.js\":\"7296bc6f3fec5e6c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rejectedUploads.js\":\"9e1dd7062640164b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/releasePowerSyncConnection.js\":\"51df62693a645ee7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repo.js\":\"0c2e2d57bfdf8ecb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repoProvider.js\":\"e39f48a2c170708f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rowProperty.js\":\"e2aa4a4616e6e446\",\"/knowledge-medium/pr-preview/pr-1899/src/data/searchFilter.js\":\"7210e997bc550f1c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/seedIdentityLedger.js\":\"de5a90719bb3fb7e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/stateBlocks.js\":\"237cb61ac6e2fed3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralEditPolicy.js\":\"12215c54df689a74\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralInsert.js\":\"291a26dd8de61f84\",\"/knowledge-medium/pr-preview/pr-1899/src/data/subtreeDelete.js\":\"5e787bbab46242ac\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncStreamLock.js\":\"9cd36890496f1016\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableSqlRecognizer.js\":\"805aac28fadd1e00\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableWriteGuard.js\":\"0f9b5251836f81dc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/targets.js\":\"c32832d5baa7dd2e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeColors.js\":\"fe748ba0abcf483a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionMetadata.js\":\"48b5251e1a4f82ba\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionRegistry.js\":\"940ee30e0ad0982c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeExtraction.js\":\"8a72e8e205879b61\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeInitialValues.js\":\"7f53f57c69df51e8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typePropertyGroups.js\":\"6017daca7b16393c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeSeeds.js\":\"e5d15dc3fd8afa18\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeTagger.js\":\"f56b633223f9e08e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typedRecords.js\":\"4e6d18137411b10a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typesPage.js\":\"8d477154aab70ccd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userPrefs.js\":\"0432306f7f21cdaf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userSchemasService.js\":\"6deb4c98e9f49149\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userTypesService.js\":\"46a47e8e20e0ef55\",\"/knowledge-medium/pr-preview/pr-1899/src/data/valuePresetRegistry.js\":\"543aecd4f3e99cf0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/visibleChildren.js\":\"08f4f90b5b07db0b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceConversion.js\":\"2d29a8f37db8cf08\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceFirstSync.js\":\"128894e3b039ea9b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceIdNamespace.js\":\"80eb3bfb89cfc061\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceSchema.js\":\"2580162336dae596\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaces.js\":\"c0e3e8d43c2bcec3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadLog.js\":\"6be369220feeae3f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/BlockPasteShellDecorator.js\":\"40495a63ba4a6ffa\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/atTrigger.js\":\"d08615d3c9485b3d\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/autocomplete.js\":\"4b5f4c12d492543d\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/codeMirrorExtensions.js\":\"daf5b8e665ca3531\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/contentFlush.js\":\"615986aa9604f1ed\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/defaultInteractions.js\":\"be0a1471ba4ee976\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/editSettleSignal.js\":\"e91fca29a088d5c9\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/insertImage.js\":\"87ccf4598b942fe3\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceCompletionRange.js\":\"a6f823fd87324397\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceTargetTypes.js\":\"c005c9bbd17a3eef\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/syntaxContext.js\":\"e57727e8aeedf783\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/triggerMatch.js\":\"fa9b4c862c603d9f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/AppRuntimeProvider.js\":\"8b9793a325807cef\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/BlockFocusShellDecorator.js\":\"a9093aeebd510b6f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/ExtensionRenderBoundary.js\":\"0b704edce88e61b2\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/PanelContentRecovery.js\":\"f410c19686f224a8\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/apiCatalog.js\":\"6fd6a999814a30b3\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/approveExtensionHere.js\":\"ee38b211fd76f29d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/armedCutAppMount.js\":\"c61868703e0cd656\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/batchableKeyedStore.js\":\"8d5d2bacd30f1739\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockInteraction.js\":\"5a1a0163751c9e74\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockSelectionAction.js\":\"b0146c2e467a52f5\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compileExtensionModule.js\":\"662df890815b2ac3\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compiledModuleCache.js\":\"c45cdca8ce70a82b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/continuousGestures.js\":\"b97a4937b2c8625c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/core.js\":\"20c78f8cb8702603\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/defaultRenderers.js\":\"54391aebb8fd3537\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/definitionFanoutAppMount.js\":\"2dc56e6d5dfc4836\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dialogAppMount.js\":\"45f45097a45f9f8c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensionSeeds.js\":\"dff3b74b644a037e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensions.js\":\"67c8993abe7306f8\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/exampleExtensions.js\":\"8b1411db42a3c97e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionApprovalStatus.js\":\"bb32325799ecbc99\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrorToast.js\":\"05b4117beb08e8bf\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrors.js\":\"98d6d671ac85fc0f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLookup.js\":\"1ef2a860c2504a06\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionToggles.js\":\"2f3a352bece24ce8\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionUtilitiesCss.js\":\"86e5ca9eb8d5a5c5\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/kernelPageDeletionGuard.js\":\"b008c22e2d059df8\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/liveRuntime.js\":\"5dd43532254ced2d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/openExtensionsSettings.js\":\"27b7854d10fd1556\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/overridesCache.js\":\"46d0280910dc9014\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/pluginIds.js\":\"25a2b88a31552ee2\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/processorRejectionToast.js\":\"948a09e51fc50322\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeActions.js\":\"7eba530f3cfb60c3\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeContext.js\":\"720ac5ea5b9ba90c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticAppExtensions.js\":\"441de0f462624b2d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticDataExtensions.js\":\"87d01bf468158f0c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/toastAppMount.js\":\"50655fad77d67dc6\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useOverrides.js\":\"1164b8d12c011b41\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useShortcutSurfaceActivations.js\":\"7f213b1c87bebb0b\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/discoverToggleTree.js\":\"ff48d7c2a964de6f\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/facet.js\":\"80080ae6b34e90e6\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/resolveAppRuntime.js\":\"bc2529187106a654\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/runtimeEvents.js\":\"d92452ddb4ab3967\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/togglable.js\":\"42a32502083698a9\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/variantFacet.js\":\"ffd23d2dbcd3ec51\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/verbFacet.js\":\"36b63c61e18a6405\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/block.js\":\"3eacfdcbc57a4924\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/focusedChild.js\":\"83e76ed2e9c831ab\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/propertySchemas.js\":\"08e97deab1233955\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/typeRegistry.js\":\"d43076b9f3093e27\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAncestorCrumbs.js\":\"15a8be174482aefa\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAutocompleteListbox.js\":\"0b8b763ef9d1c0a6\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedSearch.js\":\"0fcba1421acd85c2\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedValue.js\":\"370e52cc4b9a83b2\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useFacetValue.js\":\"3694ef4663e6d4ca\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsFocalRender.js\":\"9e093d03f819f0c4\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsReadOnly.js\":\"c8feb22871ada932\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMaterializeBacklog.js\":\"d6433c2ae3bc643e\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMinuteClock.js\":\"f527f4a3532f87f3\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePanelLayoutProjection.js\":\"9ffdb7458a9a1726\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePendingInvitations.js\":\"74cd1ea129c24bad\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRendererRegistry.js\":\"3c48d67a890cff15\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRetainedFieldRows.js\":\"008904613d4b305c\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useWorkspaces.js\":\"42e31f4e62d1b3c3\",\"/knowledge-medium/pr-preview/pr-1899/src/lib/utils.js\":\"e6d86fffdbc39511\",\"/knowledge-medium/pr-preview/pr-1899/src/main.js\":\"5ee7c6b60136d906\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/MarkdownImage.js\":\"1b89e0eee49333ce\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/blockSeparators.js\":\"9416c35492d68560\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/context.js\":\"86a294ef80505adb\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/defaultMarkdownExtension.js\":\"b87c87ce9c53f49e\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/extensions.js\":\"3d9c514489741f84\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/renderMarkdownHtml.js\":\"0eea63457445af25\",\"/knowledge-medium/pr-preview/pr-1899/src/minimal-editor.js\":\"16c2083e2149b42d\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/armedCut.js\":\"c5d4542b8f5a27fd\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/captureMediaVerb.js\":\"38c85a6b7329931c\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/clipboard.js\":\"1935315ae21bd8b1\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/decision.js\":\"fbfe86fe60b34c59\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/operations.js\":\"c8d8893a200a803d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/AccountHeaderItem.js\":\"9cae0e63738c630d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/index.js\":\"e0cae3106eef1fd8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ded936cbd51fcd89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askAgent.js\":\"5ea182b44366c324\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askedStore.js\":\"126fa48f7fb7af16\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"8d331bee7832533f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/chipState.js\":\"c4d3dce66a876994\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/dataExtension.js\":\"89345d580ebbb8e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/index.js\":\"07bed821c7725b77\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d36c3cadaefd3815\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/schema.js\":\"1c327b765f013d76\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/AgentTokensDialog.js\":\"dd5e6e728315bcfe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4a24e8091ef714f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/addMedia.js\":\"174af0007c5ececb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/backlinks.js\":\"282c9022acf5a526\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/block.js\":\"f1b025aa27d44231\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/context.js\":\"ac249400e78563e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/displayIds.js\":\"6ed5dd3f7a7a47a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/index.js\":\"c73f21139db88d5c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/outline.js\":\"369a255d92c5f359\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/properties.js\":\"ac966ffb37a3c40e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/refs.js\":\"b4885be1eb97fdbb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"0a20e2dd145504af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/search.js\":\"b623509a0e204efb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/shared.js\":\"4d9f998382f48f49\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3f366ec6cf3f38b1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/text.js\":\"2e98966f78e6d46a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentWrites.js\":\"09ae0f24e844b40f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/authoringCatalog.js\":\"5922b508e0f08aa2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/blockRefTargets.js\":\"40924615f71affbb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridge.js\":\"ec32929abc00998c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridgeLoop.js\":\"b05dd4dcc6adbd08\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/changeHistory.js\":\"5cdc3204ec299198\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commands.js\":\"4d72f583a4dfb3c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commentsCommands.js\":\"61c012a02ddedc28\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataExtension.js\":\"d5420a1c3db3528a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataModelGuide.js\":\"58f25b7839569e0e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dayPropertyInputs.js\":\"0840a67156427040\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/describeRuntime.js\":\"3ce76438f695bed9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/extensionLint.js\":\"16863f9b5fcf5cc0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/grainAudit.js\":\"1f36f62f935b70fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/healthCommand.js\":\"a8a2395e529ac28a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/index.js\":\"8810a3d258f4c243\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/presetIdentity.js\":\"eaf2c9bbf861050c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8c0df76e4a9da767\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/readMedia.js\":\"d45d4e48539d8c9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/schema.js\":\"019c1c687ae9aa21\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/serialization.js\":\"a6bdc985f334259c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/targets.js\":\"7249f13440119b5f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/tokens.js\":\"e17be8f028ef26d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/watchEvents.js\":\"36c7893b8c79aafb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/workspaceGuard.js\":\"484a9932d2348cb0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/writeCommands.js\":\"076971a2c4ce7306\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/AliasCollisionToast.js\":\"8e65c604e880320e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/DuplicateNameBanner.js\":\"0bfc10abfd177a1c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/collisionMerge.js\":\"fd2621282f88dfb3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/dataExtension.js\":\"85c2c5a2ec98e355\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/index.js\":\"84cacc4a2798a163\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/mergeCollisionAction.js\":\"7ac260a8ba389a61\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/pageStyling.js\":\"4b839a2ed5481168\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/rejectionToast.js\":\"1c5796c772a19662\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/syncProcessor.js\":\"39602aea5a49956a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/actions.js\":\"3c25cee910706f2f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/addComment.js\":\"5a358a5ce7d7532d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchor.js\":\"bb80c7469a383488\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchorState.js\":\"da9dfe2856db1080\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/commentLinks.js\":\"b6ba06886cc5aba6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/confirmThreadDeletion.js\":\"ac71b632bae19a4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/container.js\":\"a0441b1f1d3db467\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/dataExtension.js\":\"052683b9554bdaa8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/deleteComment.js\":\"3686dc48c2a07352\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/highlights.js\":\"84661ecf2b4a506e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/index.js\":\"cbd29d6feb9613d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/linkedCommentsPill.js\":\"e6914e213a25eedc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/margin.js\":\"9414d523b7256132\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginAnchorLinks.js\":\"fb7a46d809f8a3ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginSchema.js\":\"b4997fc37adec5c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/newComment.js\":\"6821649e4e89cc0e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ownThreadPicker.js\":\"2a8808454b35153f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/placement.js\":\"5be9af3397947f2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/queries.js\":\"4ff661ca2367e656\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotePosition.js\":\"8aba61f6dedac567\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedIn.js\":\"b59b1644de119caa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedRange.js\":\"b71afb5441ca7ec6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/rangeRefs.js\":\"c400c420a04ec0c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readHighlights.js\":\"e910543f4172508f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelection.js\":\"35e7455ce75951ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelectionUi.js\":\"34749cd6505d917d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/reanchor.js\":\"7ae0b177ce9a0e51\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/schema.js\":\"12617b5f05627685\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scope.js\":\"486605d8d99ec19f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scopeThreads.js\":\"62b6ae5a73a54b55\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/splitRetarget.js\":\"7c739ae4ce5969ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestionCard.js\":\"046bae96fab38dd7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestions.js\":\"f3c35a8d7e26ecdb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaries.js\":\"fdea19a601710eda\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaryBatch.js\":\"d8bd97936aac9c35\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/surface.js\":\"dbbd70cad18a185b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threadNavigation.js\":\"78ea0933857d02b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threads.js\":\"9c259fd6a3378521\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ui.js\":\"b86e6df66784095f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/uiStore.js\":\"9bd4b0838854b511\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/appIntents.js\":\"3fedbf933a95d5e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/index.js\":\"f937cf3ad0243a31\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/index.js\":\"b77606f78eebe7cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/status.js\":\"c3c544467ec7809a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"273686c10b06e6fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaBlockRenderer.js\":\"9baca79dd06df016\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaDownLaneReplicator.js\":\"82f1b32cb5c6803e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaUploadReconciler.js\":\"a3f5fc7372652b2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetDownLane.js\":\"aa76c7cb1ce5fbef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetResolver.js\":\"bb3f212954fa1c1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetUpload.js\":\"a39ea45947ca41cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/attachmentCleanerIO.js\":\"4c9aa0da8362b10c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f4c765200dbe1b90\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/blobStore.js\":\"b4590cd29005ee22\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/browserMedia.js\":\"76486445f45f2def\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/byteStore.js\":\"f09f22a531c394a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanerIO.js\":\"9dc010f0acadb329\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanupAttachments.js\":\"f5aa7b22898207a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/dataExtension.js\":\"37fa48c97392fd7f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/downLane.js\":\"c6b900e3080d2ac2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/index.js\":\"b825c259a909e178\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/insertImageContribution.js\":\"66b2013d965713b2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneArming.js\":\"a9d371c2b1e158a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneLock.js\":\"fcbe5b3ba7bba37f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaBlock.js\":\"5e10d0868f70af55\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaCapture.js\":\"fe81cf3ab1595ec8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaLanes.js\":\"8b96a0c7acac9adc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewers.js\":\"db0acbeb91e876d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewersFacet.js\":\"92839a31b051bd73\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/pasteCapture.js\":\"d1dea96e86a1c48c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/resolver.js\":\"48d054a7fb9c2408\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/retryUploadsAction.js\":\"aed90db9ea804235\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/storagePaths.js\":\"a262bf5c40a77e39\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadDrain.js\":\"5b39e642ae69942b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadLaneStatus.js\":\"0549c04922b3d339\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadReconcile.js\":\"42309942e48d7c5b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadRecovery.js\":\"c65606bbfd0221ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadStore.js\":\"2959c336e1fff2ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/useAssetObjectUrl.js\":\"2edefff79a48bdf4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"cb3270a45cb51c1e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksViewSection.js\":\"05879dbceabefa3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/facet.js\":\"ab5dd3b1f16f5541\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/index.js\":\"171a1c5ae077e6c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/prop.js\":\"7cb5cc67418f18f1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinkFilters.js\":\"bc92eb313444c968\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a7ffea3f25789441\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BlockEntry.js\":\"9537b35c88c1b3f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/LinkedReferences.js\":\"49a3c4c80796718e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"13b5ba20aa4e5f9e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dailyNoteDefaults.js\":\"2d4222ec343a1bda\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dataExtension.js\":\"d45e707124793b1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/edgeExclusions.js\":\"cfa5be9360da73d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/filterProperty.js\":\"0be2546e73ea3385\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/index.js\":\"b6541c4e8da75b07\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"49071f5ae010c70a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/applies.js\":\"01b4946b17b01879\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/countQuery.js\":\"8196f46082141e47\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/expansionStore.js\":\"ca2c442ff9aba20c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/index.js\":\"f6bb2df999ee0280\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8b67abc93a46683c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/presentationInvalidation.js\":\"ab394767d9c35795\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyEditorOverride.js\":\"978fa900c403b645\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyFilter.js\":\"d819d2e3edd1f19c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/query.js\":\"0b311ca008d9e1ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/resolveFilter.js\":\"cadb71b1e7318233\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sourceBatch.js\":\"5b07cf7485abaa63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sources.js\":\"9d8ce481250f8813\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useBacklinks.js\":\"03687f0947db3719\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"23a06bc8f667e221\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayCelebration.js\":\"acd0103c216edec1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayOverlay.js\":\"907deb5122b5066f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/gate.js\":\"ced5c5aeec5e5e0e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/index.js\":\"fd86b166989d37c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/wolfTheme.js\":\"9c73675014c876a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/BlockDragLayer.js\":\"6f1a503517704eed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dragController.js\":\"fb03cae9b4fbf386\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dropTarget.js\":\"78889dee65aed15d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/index.js\":\"39322189561d5673\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/projection.js\":\"22d5bc9bb85a0e5b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/BlockMetaCard.js\":\"dc2465615ff587c0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/index.js\":\"9f18e63496a122f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/AddTagDialog.js\":\"cebf7bfbb4052538\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"830cacaf1f86a816\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/TagNameIssueHint.js\":\"32f4bec868b8464a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/addTagAction.js\":\"d102df0fc57548d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/appendTag.js\":\"81a2af9524cd81e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/config.js\":\"ea9a75e539f7568f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/dataExtension.js\":\"279778d8a568ef05\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/index.js\":\"6ce31a89c9f5559e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/propertyEditorOverride.js\":\"6cfbf8127d29420b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbList.js\":\"eecf6e471251b8b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"01a03dc37b6f4782\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6c1115bb1d1e5c32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"06ea2e7a628538e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"62ec4ac2bd0a4573\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/index.js\":\"0c1db5032d176472\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"40123fc357a17faa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/CharacterCountItem.js\":\"2520a0d837546576\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/ProfilePropertyEditor.js\":\"11890d092895aa26\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/actions.js\":\"81840dd68c963f06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/blockType.js\":\"e84bef622a1548e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/charCount.js\":\"67c836b73b247d8d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/dataExtension.js\":\"0f0391fb853ac103\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/index.js\":\"8a78ae84d8851ae7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/profiles.js\":\"6ca3e6fa884080a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/properties.js\":\"05ed4eb27a66591c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/subtree.js\":\"d6e28c81d42b8e6d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/textCounts.js\":\"cf72b3449d59a8c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/colemak-keybindings/index.js\":\"e97861fa10deff82\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/CommandPalette.js\":\"ae177a30ffb4a71a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/HeaderItem.js\":\"4924ddb2d1728fd0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/context.js\":\"8d70e029444da1c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/index.js\":\"fa66a7164cf3ec7a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/selection.js\":\"245e19eafcc0f08d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/toggleStore.js\":\"0c75fd29ecb321b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/useCommandPaletteActions.js\":\"10a05b12bc79edd3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ContributorBadges.js\":\"71a4b95c6c3f71dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ProfilePicture.js\":\"4fced69193fd8f60\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/author.js\":\"e96f03ef7be54430\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/codeMirrorExtensions.js\":\"4a8fcf49658e647b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/dataExtension.js\":\"cf3c5294c04ce37e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/index.js\":\"6cbdb92a0888b46b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/mentionAutocomplete.js\":\"396e865cb7fd03c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/processor.js\":\"93610e3355918fc3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/profiles.js\":\"eceaa27c144ada91\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/queries.js\":\"25ce819dd0d175bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/schema.js\":\"6e83d39493439893\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/useCommentAuthor.js\":\"6749dccedb0138f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"25b6d8de679d32fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/followOrigin.js\":\"3899f6033cb6866f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/index.js\":\"35c36a6c8003a05f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6e098d6a37eb143a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"ae9fbf2e0fc55c32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/CalendarGrid.js\":\"13ae96b4d27642d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DailyNotePicker.js\":\"45a2e9d3ccd3806c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"34110f4808c321b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateNavDecorator.js\":\"e9eec0e63ee4393f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateScrubOverlay.js\":\"c89bd7c5fb7d108e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayPropertyControl.js\":\"520c2683233f52c1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayValueReferenceControl.js\":\"213da7b1738a85e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/HeaderItem.js\":\"1a821ce53c8f9a9f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/ReschedulePicker.js\":\"9c54666c46967f9e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/SpreadDatesDialog.js\":\"432f1aabfc6f4c33\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/actions.js\":\"b5bd802fc35656b1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/blockDateAdapter.js\":\"8f827b859fc5ae4a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/calendar.js\":\"400516085feea5e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dailyNotes.js\":\"55455300dfff75f0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dataExtension.js\":\"ceacd00a57ea1684\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubActions.js\":\"5f4224e91c96af89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGesture.js\":\"6f274fa8d666ad79\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGestureActions.js\":\"b408aa1b40e4198c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b4eb5da75840c2d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayProperty.js\":\"05e4c2e3c82fa261\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"7677e3f5d05e3c4a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/deletionGuard.js\":\"4eb544317ea7054e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dueQuery.js\":\"50a800e430db3848\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/index.js\":\"5475e93e0caf99eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/landing.js\":\"cb1ef05b1b087cd2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/localSchema.js\":\"3b327eebcdb29639\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/referenceDateAdapter.js\":\"c56ab92a74993d27\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/rescheduleAction.js\":\"04b2df4e83b4dbee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/schema.js\":\"cd26db6809d310c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadBlockDates.js\":\"27052499b16bf322\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadDatesAction.js\":\"5d7767c78b812e55\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/today.js\":\"21d49f10c82f5a71\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c58e16760ce2f6d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"91cb22bd94118453\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/audit.js\":\"f3a5b9875a523a7e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditAction.js\":\"b9ee0ca97d5eb78c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditRanges.js\":\"de675a545146d067\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/diagnosticsSource.js\":\"32c6af944b17c948\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/divergenceScan.js\":\"289fcecd3751b519\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/index.js\":\"521771ede133aa89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/propertyChildrenChecks.js\":\"5d25f0e759031273\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/referencesMirror.js\":\"b3f48a0ad04221de\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/rowJson.js\":\"e1120a038cf6cdc5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/schedule.js\":\"c45e30d9d42715c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/store.js\":\"4fc333596a640993\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/action.js\":\"c62fb06f52ff1671\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/index.js\":\"31fa83c48bb7923f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/plugin.js\":\"31689404f65c53a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"5b73d054ffe45e6a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/actions.js\":\"76ca06d27dbff24b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/changeMarker.js\":\"4bf1c25720652aef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/diagnostics.js\":\"7e567c58cfd0987d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/fileSystemAccess.js\":\"92577948e9ca117a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/filenames.js\":\"f9ab29e145bd8bbf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/index.js\":\"80ad4358890c668e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/mirror.js\":\"092d71ed47d55be7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runLock.js\":\"adae9e9002dd751d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runtimeHealth.js\":\"5b66eb1a6e603c56\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/schedule.js\":\"8632d72f110187f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/store.js\":\"a0c5f46bf5628b79\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/index.js\":\"105749f20f20dd7b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/themes.js\":\"424bc8561216e9ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/facet.js\":\"ebe815ca90cec2d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/useDiagnostics.js\":\"0c73fd26262e3e48\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/dismissals.js\":\"8e49ba3956105e7c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/index.js\":\"b3c9ffe88c4bcff1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/status.js\":\"5f70c2cab3a5967d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/store.js\":\"8603f264393f1aa2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"394dc324ee783152\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsSettings.js\":\"599358641d51dff2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/actions.js\":\"b364d595d82022d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/config.js\":\"81df9245135dd93c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/dataExtension.js\":\"db27d000c40ab160\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/effect.js\":\"1212c33e164ca641\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/index.js\":\"3d14bb5a8442feae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/propertyEditorOverride.js\":\"48ab7f13634bd016\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/useToggleTree.js\":\"63842d8c2cf2bcd7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/ExtractTypeDialog.js\":\"fde877fba2d4fe2a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5caf455f463f86ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/PropertyShapePicker.js\":\"5d2d644592fbd59d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/action.js\":\"bd84c58e063cd02f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/index.js\":\"e4a9718a2d8bce60\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/FindReplaceDialog.js\":\"000bea5f6a06611b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/HeaderItem.js\":\"ea592341fc21ee56\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/dataExtension.js\":\"21e651880a80005d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/index.js\":\"fe9e30118b79ce4c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/search.js\":\"715982dd3c0e003b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/toggleStore.js\":\"9ea3f081cfd1e65c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/LocationPropertyEditor.js\":\"1d6b612631b2f44a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/MapView.js\":\"77c85da8b487a8ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/blockTypes.js\":\"16ab3e30be14f782\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/codeMirrorExtensions.js\":\"1f2e44b460de8659\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/createOrFindPlace.js\":\"458564b1b3522ff4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/currentLocation.js\":\"1cc7999ecffe190c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/dataExtension.js\":\"d68e9f570bd88db2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/geoContentDecorator.js\":\"c519800a78395310\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/googlePlacesClient.js\":\"23524863fa032526\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/index.js\":\"128668c33fc3dbbd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/locationsPage.js\":\"8bbe2772836c26dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/mapViewport.js\":\"1b398855df6cadf3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/pickCurrentLocation.js\":\"58b2893ee3f739bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeAutocomplete.js\":\"e479807c9aeff66f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeNameCollision.js\":\"e56102813b687a9d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/properties.js\":\"91d524114ace4fc6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/propertyEditorOverrides.js\":\"43d9f7192f03805f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/query.js\":\"1008ed6b4f350b7f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/usePlaceSearch.js\":\"1efe9e52da95a649\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"3071b35aa797d1ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"5709b8b2379df5fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"24f5fccc5f9b8474\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/config.js\":\"d2a91ac28c9c8a2a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/dataExtension.js\":\"c1b45bfb2d9273f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/facet.js\":\"9a3238a1258aa882\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/grouping.js\":\"d80aa4f75f0f8e32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/index.js\":\"e7b4f7ff901f749b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"10b00ccb94f0356d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/query.js\":\"0c39967c749584ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/resolveConfig.js\":\"1fa2a538bcacd07b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"3d7f36c5060bb017\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"da819e30a8275c61\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlDocumentContent.js\":\"cdf6d7268057768c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlFrame.js\":\"0360bbdb37d27acc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/actions.js\":\"7db20eaa2eaecdd1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/blockType.js\":\"fd299b3f27f1b537\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/confirmRunScripts.js\":\"9444724a906104be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/dataExtension.js\":\"52821dbc420d8fd9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameAnnotations.js\":\"edb6c2dd32e363e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameDocument.js\":\"b8d14d25f9defcf9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameTheme.js\":\"09e6e70af392cd3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/index.js\":\"22963393c6ae704a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/scriptConsent.js\":\"29fc94501b42afa4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/sourceMap.js\":\"6ccb55e36c2df69a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/useDocumentScripts.js\":\"616aca91ef611246\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/index.js\":\"e1c80c1e1043bb59\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/record.js\":\"08d2bfa18c328479\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/recordStore.js\":\"3ad04a41756ad4b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/responsiveness.js\":\"0acb1359e6701372\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/schedule.js\":\"46543b4a624b2930\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/sessionContext.js\":\"68be95589337d971\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"fb80660383906254\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e8087da071ea7027\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/actions.js\":\"6b7cc6b7d374040c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/config.js\":\"eff16759d3b7fd93\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/dataExtension.js\":\"f41f9ab7cf072c35\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/effect.js\":\"e10c2cc042881699\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/index.js\":\"df47f713b7ec1abc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/keyCapture.js\":\"5e82547e7556c4d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/overrideStore.js\":\"538f0a8a28c60760\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6fa546fb8f8e8b06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/HeaderItem.js\":\"d074d1744ff07d09\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/LeftSidebar.js\":\"c0cf85bd202b274b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/actions.js\":\"4537c47fc0f4f5bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/facet.js\":\"89fe8b933cc1a544\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/index.js\":\"c85fbdd4fdce017b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/shortcuts.js\":\"ae8e7a932f42817e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/toggleStore.js\":\"2160e3cc2788b169\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/MergePicker.js\":\"132b9ac2ea4e10b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/index.js\":\"bc937afb5aaf5782\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/mergeAction.js\":\"09de43cd6dc42296\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/strategy.js\":\"bb7a1223068013e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/Button.js\":\"2b243de1d7b8c658\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"fea48d7dbb75809d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/defaultItems.js\":\"6099c4967026fc27\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/facet.js\":\"3cb3e352456dfe58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/index.js\":\"67d0501e6ea4f73d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"cf33ae45b7f9644e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e0ff850eb5f50b59\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"354208b9a1101ee8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/facet.js\":\"4d38271661d48c81\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/index.js\":\"cf1bf3001faebe54\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c6621dc79625d886\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/blockSubtreeMembership.js\":\"79ac6515b82391a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/contextMenuItem.js\":\"82920043ab169edd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/index.js\":\"02f6571d822b2c4a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveAction.js\":\"0f345183ed1d30a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveBlocks.js\":\"01b7572ec4b7b05d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/selectionAfterMove.js\":\"53b8b22dde97c0f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/TutorialBanner.js\":\"5570d8ab724ad5ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/action.js\":\"c9ad17da5544a8aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/bannerDismissal.js\":\"188db90013a00aef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/documents/cheatSheet.js\":\"fdcb9ad631007bda\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/index.js\":\"51d63bf5d27c5618\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/keys.js\":\"9c318a7b3e16601b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/landing.js\":\"eca47ee757607960\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/outline.js\":\"3ac7db3f34ffcfb6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/seed.js\":\"8e39f5381f43a7bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/PerfTrendDialog.js\":\"0f9d63193a65a0f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/analyze.js\":\"5cad570ecf2a908d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/diagnosticsSource.js\":\"03cb8550e890f905\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/index.js\":\"4fdf59fa8bfa6608\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/load.js\":\"0830e23692f686a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/monitorRun.js\":\"03e93ce6961dbf5d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/schedule.js\":\"47596e1707d9fcea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/series.js\":\"646d2b04aa3ac862\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/store.js\":\"51306eedb9b16197\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/trendAction.js\":\"bf7d82ac478f62ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/verdict.js\":\"54a875e0996975b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/clickToEditAction.js\":\"8a5b3b609338c69c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/index.js\":\"64bc527d97a1f45f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/interactions.js\":\"c972a8af9c538c3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b1a1866584073e2b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGate.js\":\"230c095419fb11f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGateDialog.js\":\"c8cd43dfdda8db4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/action.js\":\"73f027e459c331cd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/index.js\":\"4aa55414c9e1a5f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/localRunMessage.js\":\"89fd1b0736ec1301\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/plugin.js\":\"c03e3d72603cce06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/progressReport.js\":\"67e7d30263afda3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/sweepProgress.js\":\"64fbbd326a39178e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/FieldRowRenderer.js\":\"5dc47edeb22e68f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/ValueRowRenderer.js\":\"25a04169186eaa31\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/actions.js\":\"432d8e54f36640c7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/autocomplete.js\":\"457af268e5d53b94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/fieldRow.js\":\"adfd4a80019e2b7b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/index.js\":\"d2a80b0153018c69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/referenceWarning.js\":\"63e1d14d598bf026\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueAutocomplete.js\":\"c4d74e6bc2d4173b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueSchema.js\":\"cb69bf0cda2fd11d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/HeaderItem.js\":\"40ec424653d6da66\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/QuickFind.js\":\"02414510b9857ef1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/index.js\":\"6af59b7dfc942164\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/recents.js\":\"5d17234936d6424d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/resultItems.js\":\"8a85e57c5f841c89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/selection.js\":\"0e395f485870c845\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/toggleStore.js\":\"a4b1ccfee7c12a14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/HeaderItem.js\":\"9e9f8f81de52ef04\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b032c6a140db7d4a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/grouping.js\":\"fda6acb6a17b3851\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/index.js\":\"9545f95979492a39\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/target.js\":\"9e9fb8f4b0c5ae09\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/codeMirrorExtensions.js\":\"342f9716ca0f12f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/contentPrefill.js\":\"345b6e9e5d70e0e8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/dataExtension.js\":\"e6291ee22709794f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/index.js\":\"3029dfda59163e92\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"73ef13ca4566eb2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/invalidation.js\":\"77d3884a22af82fb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/localSchema.js\":\"a46ec97e7a3f5a94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/index.js\":\"f27670bca58bfa83\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"7d6c6a2abf1b8a6a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/index.js\":\"2b34309ff52ca884\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/referenceNode.js\":\"279fbc8c72370796\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/remark-reference-occurrences.js\":\"57b1a682b2227473\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"43522cb07d9d7c3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/index.js\":\"3e60690672507bd6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"038bc41b3b777e58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a416f201ad5f659d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/mergeRetargetProcessor.js\":\"0ab48d44ab28aed3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/parseFence.js\":\"2dcc2104fd73affc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceParser.js\":\"21bc5a0718372188\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceProjection.js\":\"693ecd27026bd135\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referencesProcessor.js\":\"8beb5d4440c47578\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/renameProcessor.js\":\"ba34643ffff0cfe7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/spanReplacement.js\":\"728ce9b33e7d6aff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/htmlToOutline.js\":\"dabc2fbd59941ee4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/index.js\":\"911bac021fe8fd91\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ab2def4c53feffbe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/pasteDecision.js\":\"4a1eae97cda7c3b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/action.js\":\"6a3a65ac198b39b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/blockIds.js\":\"99f016f1930e5869\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/content.js\":\"cacb32c05055b7b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/effect.js\":\"b50b39e076d06bbe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/ids.js\":\"32e796dc63ac8a75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/import.js\":\"668dfb7bad375dc5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/index.js\":\"2385230c73fd686a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plan.js\":\"608c02ace2caffbb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plugin.js\":\"47a71c1b36f368bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/promotion.js\":\"7037fe1f924720bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/properties.js\":\"3fc6f5ccba08b8e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/references.js\":\"a9c8a67a5472a678\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/report.js\":\"f3622ebe80612f28\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/roamMemo.js\":\"68cbe77fb63ea610\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/runtime.js\":\"814536e31ba2bc20\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/schemaReconciliation.js\":\"09d51f32746c6464\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/srsMarkers.js\":\"595f121e4b9232fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/todo.js\":\"6179bf4aa0d1eb42\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/typeCandidates.js\":\"7959fd25024f2783\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/types.js\":\"3f0e1e959f1d58a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/index.js\":\"552aab938d9e892d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/store.js\":\"741c8250835a947a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/HeaderItem.js\":\"a84868ad627ee2fb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"350c9a21cf410a00\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/index.js\":\"4a69fd332dd51ebf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/model.js\":\"60849d797995de78\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/toggleStore.js\":\"bf4fae60784e84c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/useKeyInspector.js\":\"a772dfc320447925\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e781e8cd9a17816d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/ShellDecorator.js\":\"08df872c4a4f06df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/actions.js\":\"25fe9408cb92fc62\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/exclusionsFacet.js\":\"113bd6e159a0da0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/index.js\":\"8bca6fc0409c8935\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/shell.js\":\"a9f6401a3cd582bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/surface.js\":\"437bad28bfae57ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/walker.js\":\"9da891bb323c271c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/RescheduleToast.js\":\"3f27c96bd9b2ce92\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/dataExtension.js\":\"93740981c73129c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/index.js\":\"a221c809a5ea6491\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/indicator.js\":\"3016a54bc3326863\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/moveSrsState.js\":\"37b9f9c1134f4a6f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"4b4867923615ff63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/scheduler.js\":\"f572a011107b9a75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/schema.js\":\"5612831a064fa473\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"6486c2cc7deb3441\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsClipboard.js\":\"e6139c2e9c4d9928\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"85d5f7bb6bd11275\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DailyNoteReviewHint.js\":\"5b64dc95f85ad654\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DeckPicker.js\":\"b1011658ce3b8bc5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewControls.js\":\"581044949d010e93\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0608a89252a452e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewSession.js\":\"321b2e4a50b2c8f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/actions.js\":\"7d39657513f323a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/archive.js\":\"b43e05a22a4f9fc9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dataExtension.js\":\"0fcfb3b420b14f2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/deck.js\":\"39d2450cdb28a912\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dueQuery.js\":\"0c5edfdf50532c40\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/gradeDecision.js\":\"1a68c8b4ef8a10c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/index.js\":\"4a69162be5a5bd71\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/keyHints.js\":\"77864568a0a350de\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewCardLayout.js\":\"5a1a6a5168ffb0bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewProgress.js\":\"e6b19486a86c74c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/schema.js\":\"76ffebfcce7cbac9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/useDueCards.js\":\"d3332289938825a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/index.js\":\"5deb9327f1d86287\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/record.js\":\"918ab8ceff09c6b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/index.js\":\"61f3ae55d5ffc1ad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/persistenceStatus.js\":\"732081222b49a3b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/requestAction.js\":\"9aa866781b2b33e3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/TypeChipsDecorator.js\":\"6e9d56f124205349\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/codeMirrorExtensions.js\":\"4046871ccaea4d24\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/index.js\":\"abd28fb447553c69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/typeAutocomplete.js\":\"ff46f5cebd5c0d40\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d884a0573abc0cf1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/actions.js\":\"7533d5989fa9595b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/anchor.js\":\"4f5eb808cc8737e0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/events.js\":\"e53455d98b6a3eb2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/gestureActions.js\":\"4cd28457f7262058\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/index.js\":\"0e24fea8fbef4668\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"17dff48cdb177440\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/collect.js\":\"10dcb94b15014846\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/index.js\":\"df5d61e17d992ef9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/record.js\":\"bc9ce883cc4d08d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/RejectionDialog.js\":\"57ea465244449f57\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/SystemStatusHeaderItem.js\":\"f44984bbec905e31\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/index.js\":\"b81354274874c10a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/model.js\":\"9585472f0c70c169\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/queueCounts.js\":\"5255587a7afa62b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rejectedHelpers.js\":\"de773b285660bd23\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rematerializeAction.js\":\"2ddcbe33698275bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/useHysteresis.js\":\"108e3a6e2da1a878\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/ColumnHeaders.js\":\"6050a3840a9b88f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/QueryUi.js\":\"cb830117da13b11b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/TableLayout.js\":\"ace36ea03da784e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/actions.js\":\"2be071457d1dea5d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/cellEdits.js\":\"d6cbc56280f884dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/childrenViews.js\":\"5698ab31bcb2cb01\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/columns.js\":\"273cc3b675b76a79\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/controller.js\":\"818ed24fc8379769\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/convert.js\":\"3ad2ebb92132cc63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/dataExtension.js\":\"1e3caa1650bd5494\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/index.js\":\"842abfda45070754\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/keys.js\":\"96a4721752029eec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/model.js\":\"cb1f3a9e4f6b8744\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/QueryText.js\":\"cf2eb093f8ad498e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/backfill.js\":\"55cc5f16563def9e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/completion.js\":\"4d964f1ecb32d9ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/format.js\":\"049aefff9ee3d5df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/parse.js\":\"f272f72d414168b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/queryValue.js\":\"62dabb2e6ec978ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/registrations.js\":\"a8ffedcb29b73de4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/source.js\":\"dbb9252d5c8a0d6e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/registry.js\":\"af6d4e3b3604a3d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowGutter.js\":\"df28b48822117757\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowVerbs.js\":\"60fb4c7abe13ed06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/schema.js\":\"3f57fa9e6737a3c7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/sort.js\":\"ea17b27ccce43bf5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/effect.js\":\"7ed19f1d1c86ee3d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/index.js\":\"a5b95848c3eb8a7d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/theme.js\":\"7bb05c843190b012\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/actions.js\":\"c546cacd37c01dc5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/dataExtension.js\":\"ffa8d80f923f229d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/index.js\":\"1ff800ec8867d2fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/schema.js\":\"cf826feb0f998f6c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/TouchSelectionLayer.js\":\"fbd3bd79e761f704\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/actions.js\":\"24392d8757a17d40\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/defaultItems.js\":\"98c6f76e80b29542\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/facet.js\":\"9f432ea6cc29056f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/holdRecognizer.js\":\"57835d7590b3c670\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/index.js\":\"2b423bafa5c7eed2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/UpdateIndicator.js\":\"3880ac56ed073792\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/index.js\":\"c1d8a69209903194\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/loadTimes.js\":\"f38e4fbaa673cdf1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoNotesRenderer.js\":\"f30e9efc575934b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoPlayerRenderer.js\":\"fbf5e1c217a9c137\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoTimeStamp.js\":\"e8efc38a96722804\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/actions.js\":\"b7c1212df5b99b89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/index.js\":\"39dd378a2a3dde0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/markdown.js\":\"6a0909a98613f000\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/notes.js\":\"810d30ae9145358e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/registry.js\":\"72de82ec58e56bf0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/remark-timestamps.js\":\"4199e6bb8fc7c4c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/view.js\":\"1cfda5db6a31c2ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/LinkHints.js\":\"f72a851fa21180a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/index.js\":\"7a1aa7d64b4f2fb0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/model.js\":\"fb65b7b2cdcbe427\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/settings.js\":\"efa826d39757da2a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/actions.js\":\"b7a7edb45289998c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/index.js\":\"279eeb9a19e82fc5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/interactions.js\":\"1f768a7c4e0bc1af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/workspace-header/index.js\":\"6964c3f6244cdc5c\",\"/knowledge-medium/pr-preview/pr-1899/src/registerServiceWorker.js\":\"5cfef3b0ce568a24\",\"/knowledge-medium/pr-preview/pr-1899/src/requestPersistentStorage.js\":\"838f183b479fd45c\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authRequestDeadline.js\":\"34954822f08cffd0\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authStorage.js\":\"935ba495243d6abc\",\"/knowledge-medium/pr-preview/pr-1899/src/services/powersync.js\":\"89dfd253d45c260e\",\"/knowledge-medium/pr-preview/pr-1899/src/services/supabase.js\":\"89f12a1309b61be9\",\"/knowledge-medium/pr-preview/pr-1899/src/services/uploadErrorClassifier.js\":\"53e940d6b2a7d326\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/ActiveContexts.js\":\"4600fd8c9fb74fbb\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/HotkeyReconciler.js\":\"834d2fcffbda40cc\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/WipeLocalDataDialog.js\":\"6b8f944d22ca7e45\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionDispatch.js\":\"a69b902ce9296780\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionRefItems.js\":\"016efdecc0870ef9\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/applyKeybindingOverrides.js\":\"e45b9fabe098ba71\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockActions.js\":\"4c94b3f60a680a3d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockMergeGesture.js\":\"84b07bd46bf60b48\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/canonicalizeChord.js\":\"95856a7d93726ff2\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultContexts.js\":\"e63016d5211deb64\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultShortcuts.js\":\"f9a370900691929f\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/effectiveActions.js\":\"527489b6a123b317\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureAction.js\":\"f062dd8d7f3bd3b2\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureBinding.js\":\"9f0311e6fa0f1ecf\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/holdRegistry.js\":\"7f8e0ff6d6781edb\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingConflicts.js\":\"0942da63387949a3\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingOverrides.js\":\"4ce7be0e6dee0e18\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/pointerAction.js\":\"1271be7ff3b48c0d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/resolve.js\":\"e69596133abbcf72\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/runAction.js\":\"d323e8ff53549d47\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/sequenceMatcher.js\":\"763cc2658f16819f\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/types.js\":\"d61d11ac7d22b2f2\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionContext.js\":\"c058aaafdc57b88e\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionDiscovery.js\":\"0e2def90103ed60b\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/utils.js\":\"636520ffe90ae95e\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/bootStore.js\":\"08c4269171b47ea9\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/previewDatabases.js\":\"7c36b9cfee44166c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/byteTransform.js\":\"cd61657e3650a4ef\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/attachmentCleaner.js\":\"61e72da4eacc6534\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/attachmentParts.js\":\"59a17bf3655a861a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleParts.js\":\"98274e42a7523850\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleRecord.js\":\"785f23e266bfd678\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/manifest.js\":\"abb4c08489e93343\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/takeBundle.js\":\"c3be454fa2af137c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/verifyBundle.js\":\"c72b814ad4684dd3\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/cleaningStage.js\":\"6a03557f9bb71605\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionKey.js\":\"ab069f31258001b0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionServer.js\":\"4a9ee233fb1d948f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flip.js\":\"1a4e1ed0b19fb915\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flipAttempts.js\":\"ff9fb421ad431b8f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/pages.js\":\"2444db444512964c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/preflight.js\":\"4a6c06eda86929d8\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/reseal.js\":\"2145fde5a07a614c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runConversion.js\":\"c1b8e8a7df1f59f7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runLock.js\":\"82d8726a926fbbcd\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealing.js\":\"f09de01bfc61cb83\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealingStage.js\":\"5967a5150014cc1e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/stage.js\":\"9932caa2cc5832c4\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/verifyReseal.js\":\"32729d176d96224c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aad.js\":\"6210ca48a827eb76\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aead.js\":\"02ef24e9f0c3459b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base32.js\":\"931972a0a66d83f8\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base64url.js\":\"8f56a323025dd100\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/binaryEnvelope.js\":\"970fb611bcba51e7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/byteAead.js\":\"3d8fada4b40adeee\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/canary.js\":\"716ded440ebbb9a2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentHash.js\":\"c533681785c9d6f4\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentKey.js\":\"a3ed47bca56e2cb8\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/derivedIdNamespace.js\":\"7c2ac08a4b755b79\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/envelope.js\":\"4b5ebcc5412e74b7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/hex.js\":\"3d13f12e95855bf7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/sha256Hex.js\":\"0176dd7121ff0be0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/workspaceKey.js\":\"935657cd8c8adcd9\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/conversionState.js\":\"0d45bd0561a09078\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/createEncryptedWorkspace.js\":\"5ca081ce06856f21\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/pastedKey.js\":\"9081b51a00886096\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"877fc442a8aacfe2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/upgradeWorkspacePin.js\":\"5a721ff40487e5ad\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/keyStore.js\":\"29d7b6660eee952a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/mintWorkspaceKey.js\":\"bf069ef9920e8fea\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/modePin.js\":\"e3d55fad24a1b18b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/openWorkspaceKeys.js\":\"710e19f012c5e820\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolveWorkspaceEntry.js\":\"4c2cab3b78840e30\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolver.js\":\"b8b897b51f6049ab\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/workspaceAccess.js\":\"bab635f73c96e242\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/transform.js\":\"73e51a2c4402b092\",\"/knowledge-medium/pr-preview/pr-1899/src/themeBootDefaults.js\":\"d3fee2205f6263e3\",\"/knowledge-medium/pr-preview/pr-1899/src/types.js\":\"a8914623e971ae84\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/ClientLocalSettings.js\":\"cfa33675e89d925f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/abortableSleep.js\":\"077713f4c5922ec8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/array.js\":\"e946e5c9261198bf\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/backlinkAutocomplete.js\":\"408b45c76a17d6d7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockCrumbs.js\":\"3f9536485567cbbf\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockrefAutocomplete.js\":\"4786620f1296d1ff\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/cadencedIdleJob.js\":\"27f4ded2a2727639\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/callbackSet.js\":\"e425a5c0f9122bf5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/clientId.js\":\"c4ac41c7fca01043\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirror.js\":\"69412eaba3106e78\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirrorCompletion.js\":\"c907c6210a3e68ff\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/copy.js\":\"815b8ab9ae3852e1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dailyPage.js\":\"fb3c12ec276f4731\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensics.js\":\"2570691900eb0697\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensicsHooks.js\":\"cb0fd73fd7c971f1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/deleteBlockThroughUi.js\":\"1643d2d3d3b2f5e0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dialogs.js\":\"ba9d25d78c546525\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dom.js\":\"2c5a4518ace4a441\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/downloadBlob.js\":\"c02b657d5c422dfe\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/drawnWalk.js\":\"44135150a8f21296\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/exportSqliteDb.js\":\"f5bc8901cbbd50eb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fileSystemAccess.js\":\"8b1606cc4b75b386\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/flipSlide.js\":\"786fd7297bbb6838\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fnv1a.js\":\"6ba0aa960c737d22\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/formatBytes.js\":\"b9402eaaa5e252b4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fuzzyRank.js\":\"59565a1d8315cad2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idbKeyedStore.js\":\"558d0cabf4091110\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idleCallbackPolyfill.js\":\"269f3944518ac28d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardAwareScroll.js\":\"b6d11b44537756c3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardViewport.js\":\"b794471460254f18\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/lastWorkspace.js\":\"ff8bdbdedf89b803\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutColumns.js\":\"3bb689d0ad82dcf4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionDom.js\":\"03defe85ccec1c8b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionId.js\":\"b6ed308a931a46b7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkClickGestures.js\":\"dab80c496aee1674\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkTargetAutocomplete.js\":\"ddc41f3e1636bca7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbCorruption.js\":\"963a5cc836e361f2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbRecovery.js\":\"5e4c10cd4f98097a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/markdownParser.js\":\"ba41ea5d78d52c24\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/memoize.js\":\"025eabd49e6cec03\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameFieldCommit.js\":\"811e1d17242b3b63\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameList.js\":\"a82bf5afee34b177\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/navigation.js\":\"9cf2a1444c7f79fc\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/omnilinerNamespace.js\":\"1dac14585effb265\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/opfsPageScan.js\":\"b272080dd0bd7d3c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelClearance.js\":\"307cddae13b1a645\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelHistory.js\":\"96c5e2ced86bae9d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLanes.js\":\"8f58e1f2057a3273\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLayoutProjection.js\":\"a2f33391f4c9ca5a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelScrollAnchor.js\":\"8263f95df07df37a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelUrlFlags.js\":\"b4e0ebe13c9a221e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/platform.js\":\"8feeabbe7fbe5b9e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/pluralize.js\":\"0020d9a6001c378d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyCreation.js\":\"2e0290659c58b11d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyNavigation.js\":\"6e4aa91a2e7f2c07\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyValueContext.js\":\"10a4abe6a5fb1b92\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/react.js\":\"41bba5617023e5cd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeDate.js\":\"917bb4ab62ec6da2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeTime.js\":\"487c5cd422708617\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/renderScope.js\":\"2e77bb749a238dee\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/resolvedThenable.js\":\"b49a8cd0fbd16143\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/routing.js\":\"2d49815eb661928d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/safeMode.js\":\"976c334ffed3aec5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/scheduleIdle.js\":\"6b297c412b6cff2f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/screenWakeLock.js\":\"caddd5c589b78f67\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/selection.js\":\"327914be51f892d7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/softKeyboardGrab.js\":\"1c6ef59f15cbbee3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/startupTimeline.js\":\"9eead3b3f8d5124d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/state.js\":\"49d8d37ca052bbeb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/string.js\":\"c2cae10dd20ba6d9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/surfaceZoom.js\":\"3afdcd98eb6b60c3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/time.js\":\"5bc75098944c6c5c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toast.js\":\"f333fc10ad7fe5f4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toggleStore.js\":\"6055fbf9a0194783\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/untilStopped.js\":\"23e9d3cb5292a143\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/userActivity.js\":\"c2e7277aca31e358\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewTransition.js\":\"669b7a951af75e26\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewport.js\":\"cdff3f887e3633c1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/webLock.js\":\"cfc754f569b92f24\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceRecovery.js\":\"c46081642a744b9d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceSnapshotStore.js\":\"0129fbb8f0eec81c\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-compiler-runtime.js\":\"d6668e5d4a073004\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-client.js\":\"171e7235982b32f1\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server-edge.js\":\"b7fc215c6d76fccf\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server.js\":\"90c606c5178962eb\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static-edge.js\":\"4bfaabf19144c4c6\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static.js\":\"82e363e77ccaaf18\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-test-utils.js\":\"6eb20fd5af89befd\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom.js\":\"3fa25e8c773d542a\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-runtime.js\":\"db535db6328da197\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react.js\":\"81bde5c6a029714c\",\"/knowledge-medium/pr-preview/pr-1899/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
