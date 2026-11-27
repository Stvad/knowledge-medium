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
		buildId: "7597e8a7c55a-2c9cc83d",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/\":\"2a842d74039f282f\",\"/knowledge-medium/pr-preview/pr-1899/index.html\":\"2a842d74039f282f\",\"/knowledge-medium/pr-preview/pr-1899/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1899/assets/FacadeVFS-B9jLqfab.js\":\"763eb4093bd8fee9\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSCoopSyncVFS-DtwLKy83.js\":\"f73515a3f3333054\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSWriteAheadVFS-BONy0fP0.js\":\"887ab736a6c34c93\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-DLFUAwdX.js\":\"a0e59f29cbc87ea2\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-BshiGTRj.js\":\"4e27ce816562316b\",\"/knowledge-medium/pr-preview/pr-1899/assets/worker-Bk7aBePL.js\":\"d82d7b0a70bac9ec\",\"/knowledge-medium/pr-preview/pr-1899/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1899/chunks/app-B0YhglPC.js\":\"9e7bd97a79d9de37\",\"/knowledge-medium/pr-preview/pr-1899/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1899/index.js\":\"6682d919ecba0793\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1899/assets/AccessHandlePoolVFS-CyBIsY5o.js\":\"0af4b2b63384cece\",\"/knowledge-medium/pr-preview/pr-1899/assets/IDBBatchAtomicVFS-qTpzDvaH.js\":\"d09c029ddd907795\",\"/knowledge-medium/pr-preview/pr-1899/assets/MemoryVFS-Cbqj_-X1.js\":\"db2fee2b41dfcb76\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cof1KQIi.js\":\"e3aa4671dc972e48\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-C6Nt3FpC.js\":\"ad2ce872698709cb\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1899/chunks/AccessHandlePoolVFS-CChI9puu.js\":\"e2552140f678a9f5\",\"/knowledge-medium/pr-preview/pr-1899/chunks/FacadeVFS-DdzoXOto.js\":\"35c4c0d09a26e743\",\"/knowledge-medium/pr-preview/pr-1899/chunks/IDBBatchAtomicVFS-B3PlX-y7.js\":\"9ad0b58e6d696bc9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/MemoryVFS-BxqsjxUd.js\":\"21068b91eae5ec7d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSCoopSyncVFS-u3yTYxjn.js\":\"7fb3b247d31337d7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSWriteAheadVFS-ABT_Nuy-.js\":\"4b882b0b8ce72fad\",\"/knowledge-medium/pr-preview/pr-1899/chunks/Preview-D6v8WSHa.js\":\"d6d08aea6b9412ed\",\"/knowledge-medium/pr-preview/pr-1899/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/card-8sTeBqtx.js\":\"e298ac393823fe01\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-CirmSehV.js\":\"91a240fc0b334a8a\",\"/knowledge-medium/pr-preview/pr-1899/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-KOTd-Jz-.js\":\"830f130835e933c7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-async-DXpyFyuH.js\":\"07d730191d5534b9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-0yMSpIi_.js\":\"50c054125545ad17\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-2a1euky4.js\":\"151b40db858e37fb\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-2wcXTIdz.js\":\"89efe9ef7cf2c337\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-Bv3zG-PE.js\":\"8dfaad24541f07e2\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-C6K_hMbI.js\":\"3c664442dcf1b9f1\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-CFHNsqT3.js\":\"7af159cc017fa953\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-D3fzyKSZ.js\":\"941a98a3a3164aa6\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-D69Pco5M.js\":\"edbac05d5f5ff179\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server-legacy.browser.production-BURFSMP3.js\":\"ba28998e6a63692b\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.browser.production-CKeEFxbo.js\":\"d046c2aac5d12188\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.edge.production-DKjbirwk.js\":\"917e8ca0943c59e0\",\"/knowledge-medium/pr-preview/pr-1899/chunks/server.browser-CE41g89f.js\":\"8c802372019aabe4\",\"/knowledge-medium/pr-preview/pr-1899/chunks/textarea-BEhc48G5.js\":\"ca0ef941ad8982c4\",\"/knowledge-medium/pr-preview/pr-1899/chunks/ui-CDbxuX2I.js\":\"1aeb11bcafac2e57\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-async-KolfQSRg.js\":\"1536c52324bb822c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-jj9ouo2A.js\":\"026bb57fad7ed299\",\"/knowledge-medium/pr-preview/pr-1899/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1899/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/src/App.js\":\"2aed0ac193635736\",\"/knowledge-medium/pr-preview/pr-1899/src/appUpdate.js\":\"16955d2376d539b2\",\"/knowledge-medium/pr-preview/pr-1899/src/appVersion.js\":\"9e544d8a319ef298\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/initialLayout.js\":\"59cdc1d7a36972de\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/openWorkspaceData.js\":\"2e90d24193feb2c1\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/resolveWorkspace.js\":\"c338af36f17d2763\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/workspaceBootstrap.js\":\"cc937cf699af61bf\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockComponent.js\":\"04e0fd9d6365b747\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockCrumbs.js\":\"cc15631b2aba7d60\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockEditor.js\":\"6069be9c8da4301f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockLoadingPlaceholder.js\":\"5f4f6a6902ae281c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockProperties.js\":\"d549f11378786921\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockSearchPicker.js\":\"d4ac94d8da09b10b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ConfirmBulkDeleteDialog.js\":\"0770b10173cd3c6a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DividerHandle.js\":\"bfdada9e851e7d45\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DraftEditor.js\":\"6484d19c94646aa4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/GutterPill.js\":\"8093d027f0943fe6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Header.js\":\"b8b74964e2fb2d85\",\"/knowledge-medium/pr-preview/pr-1899/src/components/LazyBlockComponent.js\":\"e3e1abb885784a29\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Login.js\":\"b1fb5da7859ce950\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ZoomableSurface.js\":\"51df0d830fc5074c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/editModeKeepalive.js\":\"5a0d187f020d493c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyDisplay/PropertyDisplayScope.js\":\"136f5a22fa349530\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5a93ed1d5014420e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefPropertyEditor.js\":\"86f13b4a3c37bfb2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefTargetTypePicker.js\":\"7c3b77cabe3a861c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/SelectPropertyEditor.js\":\"78a3ad3ce553217d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/TypesPropertyEditor.js\":\"2211407c5705518b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/defaults.js\":\"d498af4096fbe297\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/kernelValuePresets.js\":\"d06be7a29efb13bb\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/selectablePresets.js\":\"4a55e2b98911117f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/typesPropertyUi.js\":\"b3144c942db48ac3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/AddPropertyForm.js\":\"af7e4c193761a5d5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyPicker.js\":\"a8013b83c7f3424a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyRow.js\":\"cc6a2b7d403d7018\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/Rows.js\":\"bb4b4934ee9288c7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/actions.js\":\"1a55a7e60ebf54a9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/declarationOnly.js\":\"9d54c96c7daea5a1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/layout.js\":\"ff0671e12590cd67\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/model.js\":\"f7609c4d1a852c7d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapeUi.js\":\"5e44293d5fda3f85\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapes.js\":\"eb8617ace121cb14\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c6c6b7fa6586403c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/visibility.js\":\"f2967581716d2b17\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanelSections.js\":\"066db5d1215cda17\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockEmbed.js\":\"0d83bef4b356b8fd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockLink.js\":\"79ba0b8885109b00\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockRef.js\":\"ca6e2c63e12808e6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/CompactReferenceLink.js\":\"a3663a73f49f29c2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/ReferenceLink.js\":\"ac7ee0ed86ccd0c2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuard.js\":\"db272292047021d9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuardContext.js\":\"2ebe3ba7a85d1127\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/linkInteraction.js\":\"d3ad0f5926f23250\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/referenceLayout.js\":\"9399674cd614863f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/useBlockRefAncestors.js\":\"6e79c662e2eae32e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockGutter.js\":\"bc97f70544537941\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockInfoDialog.js\":\"36ccc86450416637\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockReadText.js\":\"d8883f885a5f336f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockTypeBlockRenderer.js\":\"9daf85bae1271397\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BulletHoverCard.js\":\"995c284b0a015332\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorContentRenderer.js\":\"d421b162d80b5a21\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0b1aa8fda252bdad\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ColumnResizeHandles.js\":\"bace7755e55dbb77\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"04a9c40e03e7a5e1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/DefaultBlockRenderer.js\":\"1d63fcd7819e8409\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/LayoutRenderer.js\":\"752e70ae95298e7d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MarkdownContentRenderer.js\":\"bbc594f1cd166375\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MissingDataRenderer.js\":\"5d3f47b741c5a645\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PanelRenderer.js\":\"997480a82c1578b1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PropertySchemaBlockRenderer.js\":\"a6d47d781fe8adae\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/TopLevelRenderer.js\":\"0d7f415d2c27d107\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockGutterMode.js\":\"33f98f3759c09b93\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockTitleText.js\":\"91bc76d6b5d1ae17\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/fieldCreationKeydown.js\":\"2bd368b639f90991\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/layoutRootContext.js\":\"814360fb0a76d117\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/TypeChip.js\":\"bfa60c39683a755c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/chipStyle.js\":\"354d5b8b56a65ea2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/anchored-floating.js\":\"441ec3f6dc00752f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/button.js\":\"52d0d1db0e96cf01\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/card.js\":\"c0aaddd4f4d8a5cc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/checkbox.js\":\"d22dcc90c811d45a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/collapsible.js\":\"89a865995a23cee8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/command.js\":\"2c4d43cb9270084d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/context-menu.js\":\"27cbb4f9eebd150a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dialog.js\":\"7f97957615dae723\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dropdown-menu.js\":\"96076146eb3b4352\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/floating-listbox.js\":\"07d1b16dd3a94876\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/index.js\":\"ece061ac319f1602\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/input.js\":\"dcfe4aac90b3c6c2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/kbd.js\":\"9b7f5e2691c93ceb\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/label.js\":\"10d5da246efbb955\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/textarea.js\":\"e5a086f34139f282\",\"/knowledge-medium/pr-preview/pr-1899/src/components/useEditModeYieldKeepalive.js\":\"71634335771f5496\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/BootFallback.js\":\"1a7636f42f01dfcd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/FocusedRowLazyMount.js\":\"76990bd49796753e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LazyViewportMount.js\":\"de68598150d63595\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LocalDbCorruptionFallback.js\":\"5b7e64caa732e85d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/error.js\":\"e30ec3c511c2213e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/lazyMountRegistry.js\":\"b9acb181d7ff2e4a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/suspense.js\":\"33573958e8fdd981\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/CreateWorkspaceDialog.js\":\"4c7d8084e13f1651\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/PendingInvitations.js\":\"871876a822401b56\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/SyncProgress.js\":\"79f0e375aacd86db\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/UnlockProgress.js\":\"48ff1b051bc5930d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceKeyGate.js\":\"3e5e34ff26215fef\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSettingsDialog.js\":\"64ab1be3c818a074\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSwitcher.js\":\"4be5947142bb0093\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSyncGate.js\":\"82b0ddd30b9e8470\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlow.js\":\"3c802e33a304423f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlowHost.js\":\"59cea5236e618268\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/EncryptionSection.js\":\"70ed341042dcd3ff\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/attachmentPrompts.js\":\"2003219ecf8bde83\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a58dcda5211030c5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowDeps.js\":\"aa9ea2037ae39322\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowStore.js\":\"2129f56099727dac\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/flowUi.js\":\"ad215cc7d197cbb3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/useConversionRun.js\":\"b20b7da009daa064\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/keyUi.js\":\"6610b7dae4e8cc90\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnKeyLoss.js\":\"b2577e8213a240dd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnServerE2ee.js\":\"06b36c5ffdf8e1db\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/workspaceUnlocked.js\":\"320cfdfe584744fe\",\"/knowledge-medium/pr-preview/pr-1899/src/context/backgroundSubtree.js\":\"e908afbd4a145866\",\"/knowledge-medium/pr-preview/pr-1899/src/context/block.js\":\"ee384e207e24236a\",\"/knowledge-medium/pr-preview/pr-1899/src/context/layoutWsContext.js\":\"9732f5dd5c31b23e\",\"/knowledge-medium/pr-preview/pr-1899/src/context/propertyDisplay.js\":\"3daa09a2b6ae02e5\",\"/knowledge-medium/pr-preview/pr-1899/src/context/repo.js\":\"5a150b29aee76f6b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasClaim.js\":\"d2c8071cd1458fc7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasSeatNamespace.js\":\"fde9b9b3d06e4fdc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockData.js\":\"c4761781ba42cd7b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockType.js\":\"b0381525f731850d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/changeScope.js\":\"b418eb6690665990\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/codecs.js\":\"4daf6a371d369d39\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/derivedData.js\":\"c2f6d99423b8cbfb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/errors.js\":\"ff7c6619f630fdff\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/events.js\":\"2aa5776a4ceeb9d4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/handle.js\":\"832deb185de360b5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/index.js\":\"323cd925035776ea\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/mutator.js\":\"30d731b60308a78f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/processor.js\":\"46ba427b6be51763\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/propertySchema.js\":\"b89a5022ed5fda49\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/query.js\":\"c3bfdf62e79caae7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/sameTxProcessor.js\":\"f7da4a798f3abf02\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/schema.js\":\"832deb185de360b5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/tx.js\":\"832deb185de360b5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/typedBlockQuery.js\":\"628cc1718d947ccd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/user.js\":\"b1599f1995a35d42\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresetCore.js\":\"bceb75a6cb4c58b3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresets.js\":\"45292ea366d35ea4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/attachmentCleanerIOVerb.js\":\"b855a9fdb931d0aa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/block.js\":\"1eb3f2e04718aedb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockCache.js\":\"21f139c4673ceda6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockId.js\":\"e715050fe2ea6650\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockLiveness.js\":\"bda186752af93b16\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockMerge.js\":\"68aeae91dc760263\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockSchema.js\":\"7543cc81715fd24f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypeLookup.js\":\"facfd21f403204fd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypes.js\":\"985bd7e1b746661d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/childrenView.js\":\"c8cfe34f7d1ccea5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/clientContext.js\":\"c79700548d3489c0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/dbFileSiblings.js\":\"0eb9c9b69308d065\",\"/knowledge-medium/pr-preview/pr-1899/src/data/definitionSeeds.js\":\"818f4d3dce6dcf12\",\"/knowledge-medium/pr-preview/pr-1899/src/data/derivedIds.js\":\"fcb6422f4cca9339\",\"/knowledge-medium/pr-preview/pr-1899/src/data/drawnSubtree.js\":\"e9dc51ce7ecb3f38\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facetBridge.js\":\"1d50850aecfe9c33\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facets.js\":\"1742b9985ae61845\",\"/knowledge-medium/pr-preview/pr-1899/src/data/globalState.js\":\"f2223d514eb82e6a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/aliasClaimRederiveProcessor.js\":\"842752c191094856\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/ancestorBatch.js\":\"c117dbf5c7e67768\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/blockTypeTypeifyProcessor.js\":\"6cb16293d18e14f8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/clientSchema.js\":\"d41692abdb652348\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/commitPipeline.js\":\"76a9ebbaed71d1a2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/devAssertions.js\":\"7d88e9667a2eb710\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/firstSync.js\":\"4765ea49ec718ca3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/freshInitialLoad.js\":\"519d8a7c36ee7a4b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/graphBackfillClaim.js\":\"a489d5f82293c8ae\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/handleStore.js\":\"48dc3e878ceb7b8a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/idleMarkerJobs.js\":\"7a88b6abdbea4e1a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initialDownload.js\":\"09feb46531bd59e7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initializeClientDatabase.js\":\"36a9afa487590a25\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/jsonCanonical.js\":\"001a453db2da5b51\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelInvalidation.js\":\"d0e68ee97339bf02\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelProcessors.js\":\"467d24a2d4eeab2d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelQueries.js\":\"4caab3c322e08118\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/mergeTypeMembershipProcessor.js\":\"90a052de35334b36\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/normalizeReferencesProcessor.js\":\"8d45aacd562dc2bf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/poolInstrumentation.js\":\"6b4f45285295f578\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/processorRunner.js\":\"f5960741fcd238e6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyCellBackfill.js\":\"04d42946e6393a96\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildMint.js\":\"a6e6924480be7f0a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildrenProcessor.js\":\"213eb5b355e55bed\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionChangeProcessor.js\":\"0ccaa928628a5bb7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionSynthesis.js\":\"82341b022143dacc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyKeyScan.js\":\"ba0f9e35b2992afb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertySchemaResolution.js\":\"f92fe6198a21acc3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyValueEdits.js\":\"8280b63854de0291\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/raiseProtocol.js\":\"f64b915a08caa621\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/readBatch.js\":\"107577e86d20f623\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/refProjection.js\":\"91d5b5bb389417e5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetLookups.js\":\"6374ebe34725fa0b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetProcessor.js\":\"a36f5cda9426a424\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/replayMerge.js\":\"bef939abd5dfdf7a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/sqlBinds.js\":\"62ecee0edf59a74a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"31d6a3c025ff2335\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/arrivalProcessors.js\":\"e6b04dafb93e20e1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/invalidate.js\":\"96a717b92041dd21\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/materialize.js\":\"114bf6f9855521e3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/observer.js\":\"bd948eaebab1d0b5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/reconcile.js\":\"450ce6d81974f6a5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/timingMetrics.js\":\"8e3ea57cf4259500\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/treeQueries.js\":\"2d2bab6acce38323\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txEngine.js\":\"703b3f1e5a225c98\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txSnapshots.js\":\"59725ad059b43b7d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/typedBlockQuery.js\":\"770e97e348e6ef95\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/undoManager.js\":\"4b6b1ddf4c12e0ec\",\"/knowledge-medium/pr-preview/pr-1899/src/data/invalidation.js\":\"d24c06c16b9f919b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelDataExtension.js\":\"0373c0aa308939e5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelPage.js\":\"4b91cb691586e23e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelValuePresetCores.js\":\"9f23214ae5335d73\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbCorruptionSignal.js\":\"a20982907bc8be4a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbStorage.js\":\"d1d89c9ed82df42d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbVfs.js\":\"28fdb3ffb4ae26e4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localSchema.js\":\"4c12285e8a021638\",\"/knowledge-medium/pr-preview/pr-1899/src/data/maintenance.js\":\"ee02521b7bc68b90\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mergeProperties.js\":\"b79557084ffb58f6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/metricsConsoleHook.js\":\"0613716a9e7c270c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/migrationsPage.js\":\"532a3f37fb884139\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mutators.js\":\"86bf33f8fc5595f9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKey.js\":\"a4b0088dc792c7a3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKeyPlacement.js\":\"898e45d3943c0b21\",\"/knowledge-medium/pr-preview/pr-1899/src/data/outlineSurface.js\":\"eafebd51838240b9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingEditorContent.js\":\"9d7d80dd767c3d72\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingUploadsSql.js\":\"0fa8124c6e65e7b5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pluginStateExtensions.js\":\"c2a2788cc224f419\",\"/knowledge-medium/pr-preview/pr-1899/src/data/powerSyncLogger.js\":\"a7b88fbc6acd68cd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/projectorRuntime.js\":\"17eed57056d5478c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/properties.js\":\"42aa443298f1a1c6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertiesPage.js\":\"9888de1b18d70353\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyChildren.js\":\"6e03273862fd1b95\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionFanout.js\":\"ab45bd80255f1f07\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionMetadata.js\":\"8a984b7bca88ada0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionRegistry.js\":\"29de1403e4fb1f1b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDisplayMode.js\":\"2670970a927ba55e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyRowCreation.js\":\"76bcd1a7c365fc3f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySchemaCreation.js\":\"aa2f8bbbcf1514ea\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySeeds.js\":\"b5f211457127b7a2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/recentsPage.js\":\"6159ed36e7e67fd4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/refTargetComparableProperty.js\":\"b325e49e8b5cbefb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/referenceBlock.js\":\"8fb08b93ea97b6ab\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rejectedUploads.js\":\"773cf756a4dffbd5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/releasePowerSyncConnection.js\":\"43d526b01bff3f4b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repo.js\":\"78326fcdd65c230d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repoProvider.js\":\"8ebefc0eed92cb4f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rowProperty.js\":\"b4f495187bdd027b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/searchFilter.js\":\"61199eab3d93b3c3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/seedIdentityLedger.js\":\"428382c060d20185\",\"/knowledge-medium/pr-preview/pr-1899/src/data/stateBlocks.js\":\"3c4fba77cbc36470\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralEditPolicy.js\":\"a04622598c294f8e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralInsert.js\":\"ac06ae9166569143\",\"/knowledge-medium/pr-preview/pr-1899/src/data/subtreeDelete.js\":\"6b8c8944adaf7b14\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncStreamLock.js\":\"8987f1b4b9ae54ae\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableSqlRecognizer.js\":\"17fe3c2b994a81ae\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableWriteGuard.js\":\"dcec3ca8041d04e7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/targets.js\":\"520c58ef1752c7ef\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeColors.js\":\"9136f2b123cb17f4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionMetadata.js\":\"20b85cc473b5a9ba\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionRegistry.js\":\"1cc1577badcd9444\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeExtraction.js\":\"15a37516fb14eb62\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeInitialValues.js\":\"4d1e8ebfb2d70216\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typePropertyGroups.js\":\"252f4f3c6bf102fb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeSeeds.js\":\"bc8c631c1ed2826f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeTagger.js\":\"2282e225e7875e4e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typedRecords.js\":\"a930bc8c2dc37165\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typesPage.js\":\"eb31c907a16fc24f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userPrefs.js\":\"86605fc2aa389afd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userSchemasService.js\":\"2e59471e2a5b7852\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userTypesService.js\":\"18ac3fbfa618353f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/valuePresetRegistry.js\":\"dfb1fd234464fdd8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/visibleChildren.js\":\"b6310d9c29b61bd2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceConversion.js\":\"19c5ca5306be29ba\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceFirstSync.js\":\"0d01495c6ae95088\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceIdNamespace.js\":\"0d26377406abc449\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceSchema.js\":\"289e2a24c735e364\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaces.js\":\"f177db104af93510\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadLog.js\":\"62864024f037127e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/BlockPasteShellDecorator.js\":\"3ab6836b3aa97ae2\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/atTrigger.js\":\"f1e7ad7885b096a2\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/autocomplete.js\":\"0c890401cf846cb4\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/codeMirrorExtensions.js\":\"d9db3de8931a0446\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/contentFlush.js\":\"f9188d7872700270\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/defaultInteractions.js\":\"5bcb949e1558a3fd\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/editSettleSignal.js\":\"04a6567c2e9cc3ba\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/insertImage.js\":\"62a84181d2c70858\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceCompletionRange.js\":\"b3e62a94a22bb807\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceTargetTypes.js\":\"4e374be9d10c2f45\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/syntaxContext.js\":\"1017a8c0ada0a60f\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/triggerMatch.js\":\"e6ab2ddb640bc31d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/AppRuntimeProvider.js\":\"9ecf52ed0b301758\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/BlockFocusShellDecorator.js\":\"85ff86d74489d067\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/ExtensionRenderBoundary.js\":\"ba61319181dd0363\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/PanelContentRecovery.js\":\"91821b5f84720b9d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/apiCatalog.js\":\"5ecd1e8307358e0c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/approveExtensionHere.js\":\"bcbaa59882e7e71a\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/armedCutAppMount.js\":\"43abcb9708c6f2ef\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/batchableKeyedStore.js\":\"6c2d9ef13da27bb4\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockInteraction.js\":\"a48a27000aa8f94b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockSelectionAction.js\":\"f3a6f99d60df51c2\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compileExtensionModule.js\":\"85ba6b3ba07356ba\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compiledModuleCache.js\":\"453c6d3bae72d12b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/continuousGestures.js\":\"1a8de64e28edf805\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/core.js\":\"88d9742b5f1be982\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/defaultRenderers.js\":\"9558efcc19cd7b74\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/definitionFanoutAppMount.js\":\"0719e6d902072ccf\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dialogAppMount.js\":\"7f870e6050f5e6bf\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensionSeeds.js\":\"f094492694cc00e8\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensions.js\":\"44b9700118d6c92d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/exampleExtensions.js\":\"5550d6fc5fef1ba5\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionApprovalStatus.js\":\"8c33c1e9b6d81ade\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrorToast.js\":\"21b52419fa2f03ee\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrors.js\":\"6804b1fad9178cbb\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLookup.js\":\"2b663fce675ae216\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionToggles.js\":\"1fa8b42e138cde10\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionUtilitiesCss.js\":\"156fc12d3c6f7c99\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/kernelPageDeletionGuard.js\":\"202c31d06ffc6c31\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/liveRuntime.js\":\"5ae7928f495a9d3c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/openExtensionsSettings.js\":\"b2e9eb5e7ef5c56f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/overridesCache.js\":\"8d18e21534a0239e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/pluginIds.js\":\"64e840ccef46f6b6\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/processorRejectionToast.js\":\"feb20829539a0449\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeActions.js\":\"f5f2f0ce4c70ae4b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeContext.js\":\"233dc710e78628d6\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticAppExtensions.js\":\"27368b679d8ba76e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticDataExtensions.js\":\"a5718d3965955c3e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/toastAppMount.js\":\"ba331b1a7d9737b1\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useOverrides.js\":\"3b52a37894312fb4\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useShortcutSurfaceActivations.js\":\"86fccd0dd9904594\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/discoverToggleTree.js\":\"e5c1855d4cee9044\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/facet.js\":\"4f69a628e83dab0e\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/resolveAppRuntime.js\":\"4ac8643ecb531b63\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/runtimeEvents.js\":\"a8d0f27321642ae4\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/togglable.js\":\"97afb672b3a9fc78\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/variantFacet.js\":\"80adc756788c6e57\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/verbFacet.js\":\"c2865ca6d412dd96\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/block.js\":\"131a17e2d770982c\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/focusedChild.js\":\"dcb91ce98450d97c\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/propertySchemas.js\":\"447886a1793a64fe\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/typeRegistry.js\":\"7e8c265f287e1af4\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAncestorCrumbs.js\":\"939b2163d202d94e\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAutocompleteListbox.js\":\"5ac01268598af77f\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedSearch.js\":\"e08b55cda830cafc\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedValue.js\":\"eef45269a09005ed\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useFacetValue.js\":\"45aba288c43e8f9a\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsFocalRender.js\":\"b4f4d386e0a4df1e\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsReadOnly.js\":\"631b84c90ad90e08\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMaterializeBacklog.js\":\"0f397cd127a0ab39\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMinuteClock.js\":\"12aade6c255e9015\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePanelLayoutProjection.js\":\"cc640b5018ccec0a\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePendingInvitations.js\":\"8d7af6a8d0777062\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRendererRegistry.js\":\"c7156cf4e62839b1\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRetainedFieldRows.js\":\"faea2f2e28550967\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useWorkspaces.js\":\"df36c6933275e74d\",\"/knowledge-medium/pr-preview/pr-1899/src/lib/utils.js\":\"260d41dab021a54f\",\"/knowledge-medium/pr-preview/pr-1899/src/main.js\":\"dba6ad3580b40e7e\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/MarkdownImage.js\":\"5d9537c5c49ec0c4\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/blockSeparators.js\":\"ec02401bd487658e\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/context.js\":\"bd63060a40af0e87\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/defaultMarkdownExtension.js\":\"0d9c50aa42816ced\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/extensions.js\":\"897a95e94d8f6831\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/renderMarkdownHtml.js\":\"3ff930adc139d51b\",\"/knowledge-medium/pr-preview/pr-1899/src/minimal-editor.js\":\"0cc07756dbc2e6cd\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/armedCut.js\":\"873f6e49185366d6\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/captureMediaVerb.js\":\"8b15382bce9f61b3\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/clipboard.js\":\"ec6ac940c28292b6\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/decision.js\":\"290ce85738c2fc7f\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/operations.js\":\"5fbfc13f0ad12889\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/AccountHeaderItem.js\":\"a35d97c8c97d3db6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/index.js\":\"6aa453011f76bd15\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"2b7b6d551c5ad205\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askAgent.js\":\"e76d5eec5713ddaa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askedStore.js\":\"72405c9fe807a2d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f70a4d4aecb82960\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/chipState.js\":\"003b1ef650893989\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/dataExtension.js\":\"86958aa9181d7b5a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/index.js\":\"854bb4fb5e0b253d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"18888cc02e87bc9d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/schema.js\":\"82520fea09c506f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/AgentTokensDialog.js\":\"79184d939274a34a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/BridgePairingDialog.js\":\"85c1b14b936071ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/addMedia.js\":\"5bd5d6a5e1a45f72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/backlinks.js\":\"182df78fd6451eee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/block.js\":\"da77938107f371f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/context.js\":\"2bdd66cf3edb50a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/displayIds.js\":\"34fb23eba94d881b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/index.js\":\"8fb4df7cad14583e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/outline.js\":\"c57ef1a39109b392\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/properties.js\":\"d6ad9f1a391d017f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/refs.js\":\"2faf40679aad523c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"59ab3969760b8abd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/search.js\":\"ffc37fabd67d2199\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/shared.js\":\"0f1af5db1145436d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"cfa897ae2a397103\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/text.js\":\"f4af65d239355999\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentWrites.js\":\"263f4e19d41e87b2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/authoringCatalog.js\":\"2c15af238621e863\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/blockRefTargets.js\":\"5eb7b25ba50bf4a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridge.js\":\"a8ab1b0ab98d014b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridgeLoop.js\":\"d467de55d1c04bdd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/changeHistory.js\":\"04baf3253c970e0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commands.js\":\"ad497be71ec155ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commentsCommands.js\":\"7aa9f75ce49d81f1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataExtension.js\":\"7e32227bb35fe3b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataModelGuide.js\":\"c794e6e33d85e8a3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dayPropertyInputs.js\":\"7ce9334c44db2c67\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/describeRuntime.js\":\"3fdee812bfe649ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/extensionLint.js\":\"e1eb0c8e739a9f3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/grainAudit.js\":\"6cb69ed56df57fb0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/healthCommand.js\":\"b41ba0df1119291b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/index.js\":\"72dd9f2acb509dc2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/presetIdentity.js\":\"9206736d1e272993\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"bc86da36420b7ea5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/readMedia.js\":\"13bc2b6fc392cd1a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/schema.js\":\"0129916780bbdd7e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/serialization.js\":\"f04dba1ad3244de8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/targets.js\":\"fa242b1aa39071b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/tokens.js\":\"be88da6e3fe564d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/watchEvents.js\":\"d46a68e25d6e1f16\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/workspaceGuard.js\":\"e63bfa8d9349feba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/writeCommands.js\":\"d7baa16691a911d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/AliasCollisionToast.js\":\"5bca51fdf9457d68\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/DuplicateNameBanner.js\":\"c75c2284fd76a083\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/collisionMerge.js\":\"8bb8c724abf68a15\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/dataExtension.js\":\"2628bd4f46f78e5c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/index.js\":\"42b4fc2ddd42a2b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/mergeCollisionAction.js\":\"700d008520ab1d2f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/pageStyling.js\":\"105765a5cd2f3a41\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/rejectionToast.js\":\"153f7bf812fe9b5b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/syncProcessor.js\":\"f3060eb9c9e8ca88\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/actions.js\":\"bef3c440457fb4bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/addComment.js\":\"669dcd84b3e2b9d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchor.js\":\"04444129b812a792\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchorState.js\":\"69cfce63f1024631\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/commentLinks.js\":\"068561be96025536\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/confirmThreadDeletion.js\":\"f424a19531fe20e8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/container.js\":\"adce9d552990e59d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/dataExtension.js\":\"c858a5dd405da43c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/deleteComment.js\":\"8445c67a34adc2f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/highlights.js\":\"4f5044d2af3c7f3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/index.js\":\"690088cffffad6b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/linkedCommentsPill.js\":\"7a5b7ba95b96babb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/margin.js\":\"85d1a15626bdc313\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginAnchorLinks.js\":\"e7b60f2e286aba88\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginSchema.js\":\"6d7439cb1f8f7a21\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/newComment.js\":\"53c57b9c11d295ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ownThreadPicker.js\":\"0a473bca41e6306a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/placement.js\":\"91e8c629b8539a66\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/queries.js\":\"4465ddc2467da837\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotePosition.js\":\"50bc673affb32c30\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedIn.js\":\"83a5473f31409266\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedRange.js\":\"7e50c2a9d165a115\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/rangeRefs.js\":\"fc8a5d5979102c49\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readHighlights.js\":\"c1bef464464d9d8a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelection.js\":\"f10ce73540bf4f57\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelectionUi.js\":\"edb5e10482bcb724\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/reanchor.js\":\"bed8a950e20cffa4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/schema.js\":\"35ee3438223ea749\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scope.js\":\"60f341cedc454cf5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scopeThreads.js\":\"59f2d887c3985bb2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/splitRetarget.js\":\"cfdd9c68116c3a01\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestionCard.js\":\"b888cb35bc9b5723\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestions.js\":\"8b861beef2ff1022\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaries.js\":\"381b214853cbd71a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaryBatch.js\":\"bca80b7afc3c3b13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/surface.js\":\"8cbf8f3c2e59cf90\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threadNavigation.js\":\"5a859ae47c5ba837\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threads.js\":\"6820cb706da256ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ui.js\":\"757cfa9ccd918d44\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/uiStore.js\":\"0c33469749279997\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/appIntents.js\":\"cc8c13ab40d35f79\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/index.js\":\"6d8f8f6778326e8a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/index.js\":\"b60b72dd48912475\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/status.js\":\"d1acce3351256c88\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"5a43cd3226bd1322\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaBlockRenderer.js\":\"fe9c61af7ead647b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d5e2163c7eb5aae2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaUploadReconciler.js\":\"6454c1c7bea2af34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetDownLane.js\":\"589f9e08137b007d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetResolver.js\":\"f321696ae544c198\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetUpload.js\":\"27ad7f3d311e831e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/attachmentCleanerIO.js\":\"01829240f6674ed4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/supabaseAuditIO.js\":\"0eedb3f6925b5f8f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/blobStore.js\":\"b18c06ba14b14764\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/browserMedia.js\":\"4521fb252b282ec9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/byteStore.js\":\"d4c4d39f3c60af9a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanerIO.js\":\"1f33d2207d499bde\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanupAttachments.js\":\"90d582711923dda5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/dataExtension.js\":\"7bd0d259889fb387\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/downLane.js\":\"1dc7b389d34b85df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/index.js\":\"2c265545066aa623\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/insertImageContribution.js\":\"649ce3ab459e1786\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneArming.js\":\"3a36d551638c237a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneLock.js\":\"9c830d8dc4ef1a64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaBlock.js\":\"48cd15d9f1603ad2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaCapture.js\":\"297fd5837b70acfd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaLanes.js\":\"9bd064cc62f2e53b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewers.js\":\"5fc72986e11f9c04\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewersFacet.js\":\"fa15d1fbfa94699d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/pasteCapture.js\":\"55e0de22d0b46e66\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/resolver.js\":\"1fa2037d2fecc3bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/retryUploadsAction.js\":\"90f2fddf924dd65f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/storagePaths.js\":\"6cd5093c2814416a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadDrain.js\":\"4355ba0bf0130093\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadLaneStatus.js\":\"4a013063720bda50\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadReconcile.js\":\"c28f88154625a699\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadRecovery.js\":\"55f5dbd4e80a24ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadStore.js\":\"7efed82238615b84\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/useAssetObjectUrl.js\":\"da40c49da067b89a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0beacfbbcb221032\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksViewSection.js\":\"64f7d738b1305ef5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/facet.js\":\"362bdcecaaddf165\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/index.js\":\"785d6f5ff3a42d98\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/prop.js\":\"c686ee2ed361f692\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinkFilters.js\":\"3910e2902a05ae62\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"42ef186fdfafd5f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BlockEntry.js\":\"a04b3eeb37995013\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/LinkedReferences.js\":\"4c40c1589a9e0c51\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"db54428d71a12403\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dailyNoteDefaults.js\":\"88a64ebffce6dbbb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dataExtension.js\":\"6648a5e6c385ead4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/edgeExclusions.js\":\"53b1d29c18f2710a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/filterProperty.js\":\"ddb1ccb7e28314c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/index.js\":\"e631a8cbcbe1abd1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"fe42fb2021949601\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/applies.js\":\"aef5f199aa140733\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/countQuery.js\":\"99bf29a0e6446a18\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/expansionStore.js\":\"eacd0378b6b6ea89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/index.js\":\"2497e08b16ad6715\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d01a536dd76f3f33\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/presentationInvalidation.js\":\"5a81cdbd4cd04a36\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyEditorOverride.js\":\"fc3c9f5991a6e724\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyFilter.js\":\"6104417fec26a4a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/query.js\":\"2f4e21ae30628c53\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/resolveFilter.js\":\"4514a2ab6c1c4286\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sourceBatch.js\":\"42138490899e559d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sources.js\":\"c4691373cc283335\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useBacklinks.js\":\"7dcb8fe5d9064453\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5a656aca70fa159e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayCelebration.js\":\"8e91d1db10592086\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayOverlay.js\":\"1363881e401c0b87\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/gate.js\":\"94d8dd35166d9274\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/index.js\":\"51a9f6fdac503cc3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/wolfTheme.js\":\"ddeb0340a3d3210f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/BlockDragLayer.js\":\"cc8239a4d5bb092d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dragController.js\":\"22cf65329a452038\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dropTarget.js\":\"d60866f5c2db272f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/index.js\":\"5b18e140b4bb7474\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/projection.js\":\"dfed0296fa8221bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/BlockMetaCard.js\":\"3293b11133b5ab5f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/index.js\":\"0fa18d56259051fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/AddTagDialog.js\":\"83b84ca6675670c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"3617aef0f1e55fa0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/TagNameIssueHint.js\":\"7a9a82382386ce5e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/addTagAction.js\":\"e1703e334123e2b1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/appendTag.js\":\"edf21809ef2c856e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/config.js\":\"3a354ad39ae97bc8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/dataExtension.js\":\"a16284ccc32010ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/index.js\":\"212565abe019301d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/propertyEditorOverride.js\":\"3e203aacd5a5cf9e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbList.js\":\"79f55bef215d796c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"405331acb4e51309\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e64df7bb3cccbaf5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1157560ad7f82f03\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"98fee8bef53233e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/index.js\":\"24fca611266bd557\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"34eb36087a842e9d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/CharacterCountItem.js\":\"47c4625a8fc4a3d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e00113085bdaa196\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/actions.js\":\"f242b175d650372e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/blockType.js\":\"5e0bd6a8fd941efc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/charCount.js\":\"cf2175285c16e45a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/dataExtension.js\":\"b1fde5d15f04c102\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/index.js\":\"037249f9d0357cdb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/profiles.js\":\"ef1bd38782b3cdb6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/properties.js\":\"14bab5c9150916b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/subtree.js\":\"fc95e5d7bfa67a44\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/textCounts.js\":\"4dbb9de866900247\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/colemak-keybindings/index.js\":\"4f192ad880f3a46d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/CommandPalette.js\":\"d7075846a859145f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/HeaderItem.js\":\"45facf419537cd15\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/context.js\":\"cd2ef3ae7d7706ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/index.js\":\"3df797b5d19dd3e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/selection.js\":\"e9a93b217d83ed6e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/toggleStore.js\":\"abda1d340d6776b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/useCommandPaletteActions.js\":\"7ef4fe578ed93a99\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ContributorBadges.js\":\"8c03c923317a94f0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ProfilePicture.js\":\"1094d5783a031b72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/author.js\":\"3488d722eed059c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/codeMirrorExtensions.js\":\"95b7e4ae039ed391\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/dataExtension.js\":\"9fd4f67e2f954440\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/index.js\":\"0d3709231d4e873f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/mentionAutocomplete.js\":\"1ed8680de5f6a14f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/processor.js\":\"acfdf4726925188b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/profiles.js\":\"74957c0e2d6480fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/queries.js\":\"95c5bc7812cb5e5e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/schema.js\":\"21c147a50c94db24\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/useCommentAuthor.js\":\"bf9f727c0c5b7a89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"6c5eac5b80bc25f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/followOrigin.js\":\"02c194c2474f34e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/index.js\":\"c43cd1d293283885\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"6a66bb531af84da3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"eea25d06ecb978c0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/CalendarGrid.js\":\"3532b2a372e40533\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DailyNotePicker.js\":\"32bdad56703dd3ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3a86271f426c5945\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateNavDecorator.js\":\"173f6486728aae4c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateScrubOverlay.js\":\"07c7efe3bb7deb0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayPropertyControl.js\":\"90c874689485e010\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayValueReferenceControl.js\":\"f3c1536f779c0d8b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/HeaderItem.js\":\"12da9f56acbed0c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/ReschedulePicker.js\":\"a78271fabc661b46\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c85407b1c370e991\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/actions.js\":\"028104b1bdbde290\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/blockDateAdapter.js\":\"75ef77843a6f1f95\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/calendar.js\":\"0405eb2cfe3d38b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dailyNotes.js\":\"96fb591cf3ea62c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dataExtension.js\":\"ac5b5f5583a24956\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubActions.js\":\"02dbc4df2de3215d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGesture.js\":\"7e313059fce2f12e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGestureActions.js\":\"02cbc397bc4afd87\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubRecognizer.js\":\"2a54d6d4896955ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayProperty.js\":\"4b25a103914f6301\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"6abdbd68578da0f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/deletionGuard.js\":\"8ff65a27bd1b3da3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dueQuery.js\":\"105c10770d101d9f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/index.js\":\"b2e3a739fcac5728\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/landing.js\":\"df32ff7f54bf7792\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/localSchema.js\":\"09687ba9fff898ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/referenceDateAdapter.js\":\"e34577f7850e4a31\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/rescheduleAction.js\":\"b871e76c68285b05\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/schema.js\":\"3f35da50b26fd96d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadBlockDates.js\":\"172a6b87cd998437\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadDatesAction.js\":\"3fb868db3f456a87\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/today.js\":\"ad58cd9bbe49454d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ed29bf1234d1bf93\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7f3801e12093a58d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/audit.js\":\"a977e77b1ea45b4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditAction.js\":\"dd0167502ffbf318\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditRanges.js\":\"d40d86028899750b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/diagnosticsSource.js\":\"036d689696462801\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/divergenceScan.js\":\"c202240b5c1e5443\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/index.js\":\"bd4657ca84e3b728\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/propertyChildrenChecks.js\":\"608619d09f047bc6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/referencesMirror.js\":\"8ce06f758f63ee62\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/rowJson.js\":\"e04692389788bc73\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/schedule.js\":\"b6fd492d3e0d0968\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/store.js\":\"172413ca9648f8e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/action.js\":\"baa71caed3db85d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/index.js\":\"becca993aace32f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/plugin.js\":\"375a9574f4ac4aaf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d2707355b0ab3652\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/actions.js\":\"8d978d668b5fa478\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/changeMarker.js\":\"2bbc73bc5e803e7e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/diagnostics.js\":\"7afd42654c41cc24\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/fileSystemAccess.js\":\"bc5e4c95e83a4328\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/filenames.js\":\"55a979f4648e5549\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/index.js\":\"69cd9d3d7306c8e0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/mirror.js\":\"91ce5138dc357425\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runLock.js\":\"462eb4867a45964c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runtimeHealth.js\":\"a7cdbf601c7b44d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/schedule.js\":\"ca1035709bb6460c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/store.js\":\"3658346dede920c0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/index.js\":\"4593f09667a268d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/themes.js\":\"5d11671e28dcbff1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/facet.js\":\"f0af37c7be44762d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/useDiagnostics.js\":\"8f413bc803e4b6bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/dismissals.js\":\"a7b638da18e3b896\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/index.js\":\"db98429f665c0cb4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/status.js\":\"2907cf6a177cf8ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/store.js\":\"decdf08e0cff444e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"f9ee30bae9926357\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsSettings.js\":\"fea08c45ecd44fdd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/actions.js\":\"612deebb48d4a124\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/config.js\":\"349b438bc63dd76e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/dataExtension.js\":\"7d8e48abc0e914d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/effect.js\":\"f6a4ed23b269f6d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/index.js\":\"cfe28abb6c689b4e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ece23526a0e0797e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/useToggleTree.js\":\"8a85a71df869e7fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/ExtractTypeDialog.js\":\"ac836e8b0186fbc2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ad516be49cde12f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/PropertyShapePicker.js\":\"59a1e7c865d0ea5e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/action.js\":\"bc90196e117002e0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/index.js\":\"e7a76b7f263be418\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/FindReplaceDialog.js\":\"f3d4c4e3263e81eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/HeaderItem.js\":\"76895f78020f8067\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/dataExtension.js\":\"8295e5e14a525b21\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/index.js\":\"5632b9b0fa284452\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/search.js\":\"072ee46d08d4ad38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/toggleStore.js\":\"66edbb1d6112519f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/LocationPropertyEditor.js\":\"e4e589f3195d3ac1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/MapView.js\":\"89edc414444e0a31\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/blockTypes.js\":\"e11170fe6dda96a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/codeMirrorExtensions.js\":\"82ddc86e8a3fd24c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/createOrFindPlace.js\":\"6d22c9fed97fe868\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/currentLocation.js\":\"123d7dc8f29b0b90\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/dataExtension.js\":\"a2923e7046f97f36\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/geoContentDecorator.js\":\"9e1193fa33c7d0f0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/googlePlacesClient.js\":\"a45390ae22170b70\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/index.js\":\"e2299a029fdfe63c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/locationsPage.js\":\"e1d542669c3fb0e4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/mapViewport.js\":\"3ece6c0e28156ba5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/pickCurrentLocation.js\":\"d6bef4e19119dbb4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeAutocomplete.js\":\"bc48f9300330d379\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeNameCollision.js\":\"5d83e45f531284dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/properties.js\":\"07008198d4986ded\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/propertyEditorOverrides.js\":\"490499a572293bfe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/query.js\":\"8e97f039a99499a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/usePlaceSearch.js\":\"8dfb0daddef3188e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"2ec80b9c0f6a4134\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3e6fa1f7b2cde655\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"311f3c2f13853fe8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/config.js\":\"30755cc70615c4d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/dataExtension.js\":\"0ce0a48a2fbce985\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/facet.js\":\"46efdcfabde213bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/grouping.js\":\"1632e261a68732b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/index.js\":\"b6ce85792fa8bf01\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"a6f2ec354cb343b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/query.js\":\"0df3f1fc58b40d8d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/resolveConfig.js\":\"1a7512d652c20845\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d02f776ebdeb2a18\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"49e064648f31fe66\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlDocumentContent.js\":\"7917d3aa305abfbc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlFrame.js\":\"93965b868c281186\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/actions.js\":\"4c59801750a484d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/blockType.js\":\"e6ed02cecb93e758\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/confirmRunScripts.js\":\"8fdb2fa615947ec2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/dataExtension.js\":\"281510dc5502cc0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameAnnotations.js\":\"387fdf2c1fe2fb11\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameDocument.js\":\"a66b3b220f4c7965\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameTheme.js\":\"cee386a66a3186d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/index.js\":\"896246b5f257f5ad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/scriptConsent.js\":\"53700b5e148f5d7d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/sourceMap.js\":\"6c88f0aee5878d2a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/useDocumentScripts.js\":\"7c29ecc39b050e05\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/index.js\":\"73b45795854add1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/record.js\":\"b3b2a796407a4aa4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/recordStore.js\":\"56a65159c972ec84\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/responsiveness.js\":\"9935990252d329bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/schedule.js\":\"be0a9e48671a300b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/sessionContext.js\":\"7b79f6fbfbf1ccfc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b505bc8c228bdd5d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"f2d4b4ffbec7b38e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/actions.js\":\"e434441e22f149e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/config.js\":\"d122ad15a69d42d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/dataExtension.js\":\"78434feb718b3704\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/effect.js\":\"755b7cd98c3c9302\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/index.js\":\"595d1b4fcf4a1d74\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/keyCapture.js\":\"01b70cf3bf76ce81\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/overrideStore.js\":\"c19d464dc91314b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"81ddf9f3b9f6ca68\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/HeaderItem.js\":\"c2c0c151e1943d7e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/LeftSidebar.js\":\"968a252e646d3f27\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/actions.js\":\"e04ce8335b388bcc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/facet.js\":\"fc234836af6ae07d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/index.js\":\"a3cad34b17d31124\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/shortcuts.js\":\"ca13395199d054e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/toggleStore.js\":\"11361c8d8f10dfea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/MergePicker.js\":\"e40a40cd6e91842e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/index.js\":\"16cc2a06f7d0366e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/mergeAction.js\":\"e3f27f873ba1179d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/strategy.js\":\"b9095d8e4831f9cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/Button.js\":\"097f637413844601\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"9d0bd3db56674278\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/defaultItems.js\":\"42015227e01b82f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/facet.js\":\"d45cb101a85d1391\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/index.js\":\"42053a5a448bd5cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"cc534aaf8b722e81\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/actions.js\":\"bbbcbc9c0e274ae5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"caa2a5838c6d4efa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/facet.js\":\"8db112f6c9e19885\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/index.js\":\"acef145a1d037a82\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/MoveDestinationPicker.js\":\"22a7bc274eda7cce\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b7a5fdeff8d105c7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/contextMenuItem.js\":\"76fb19f7f6c562c1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/index.js\":\"b4eab0c90e43317a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveAction.js\":\"adca24f502a17a72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveBlocks.js\":\"1e83b87eab27dd99\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/selectionAfterMove.js\":\"d0a217d40fcd7204\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/TutorialBanner.js\":\"7c0ee1a4aa244ffb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/action.js\":\"f39cdcdb16266140\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/bannerDismissal.js\":\"62d2bef6bf9ad387\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/documents/cheatSheet.js\":\"175f9cdf68a060ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/index.js\":\"09275f1ae0185f5f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/keys.js\":\"11b3b2c873db071e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/landing.js\":\"3f3d75c6aace2c49\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/outline.js\":\"57c229324cb010c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/seed.js\":\"f871368e0b8d4aa7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/PerfTrendDialog.js\":\"28588144e95366f0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/analyze.js\":\"be357024fabb0c3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/diagnosticsSource.js\":\"db66413592581eeb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/index.js\":\"1839fe993e7166c0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/load.js\":\"c96cf4b59a5cefe2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/monitorRun.js\":\"a738fbb491605f4c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/schedule.js\":\"0cc39e4f44a872c7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/series.js\":\"2c359872054b8671\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/store.js\":\"42062ea2343d1b5e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/trendAction.js\":\"086de7e2c2d465ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/verdict.js\":\"5cf334911d82c376\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/clickToEditAction.js\":\"d330ffb3050b8f8d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/index.js\":\"22972854f11951f0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/interactions.js\":\"1dfd5ba97562dcae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"54a2da2198504ae0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGate.js\":\"34af11815c8fc9e3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGateDialog.js\":\"aae1aec1aa7bef29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/action.js\":\"9c6a05be544f35ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/index.js\":\"53c720e707425343\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/localRunMessage.js\":\"90c407c08a2d7e5f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/plugin.js\":\"d8c46fa21f9b0261\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/progressReport.js\":\"98fadc0908538c37\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/sweepProgress.js\":\"6b47e1c53272ed25\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/FieldRowRenderer.js\":\"f3c7f36a544c5b2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/ValueRowRenderer.js\":\"9a80a297cf035bf1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/actions.js\":\"09d9af4523e63ac8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/autocomplete.js\":\"13c9fab9d81a534c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/fieldRow.js\":\"c3d1c58dce86b067\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/index.js\":\"c2cd88b6aee799cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/referenceWarning.js\":\"17813b6dee4b85f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueAutocomplete.js\":\"5c6bfcc66a15711b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueSchema.js\":\"0ac51375cb1921ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/HeaderItem.js\":\"c1ea9751e186751a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/QuickFind.js\":\"0de9b24ee1669793\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/index.js\":\"545e4632c2087445\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/recents.js\":\"39864140ed13c0b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/resultItems.js\":\"013acbfae3ec2de0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/selection.js\":\"eaaf75e32210b279\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/toggleStore.js\":\"6958c72e5e8fd427\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/HeaderItem.js\":\"9820455c0e7fc87c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/RecentsPageBlockRenderer.js\":\"5efd5fb815394319\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/grouping.js\":\"b9b17ed145387753\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/index.js\":\"85d111cd3926dc82\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/target.js\":\"7564e120c05969bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/codeMirrorExtensions.js\":\"6171de7ae365de44\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/contentPrefill.js\":\"accdaefa4637d6bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/dataExtension.js\":\"5dc9a28a420c4bcb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/index.js\":\"d1715dbb781222f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"c9fdecd3faa3808b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/invalidation.js\":\"33e7f0e4d8c9afb5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/localSchema.js\":\"6856a84384aadd10\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/index.js\":\"080970340e798f25\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"a1a2c7193ac6a001\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/index.js\":\"a6ae12a319ef3527\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/referenceNode.js\":\"a9f0b79d3c153fe8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e8f79610f03a4371\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9735b96344b24a06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/index.js\":\"afcf777a295c0acc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ec252bbc637c98aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c877bfe6452d6eae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/mergeRetargetProcessor.js\":\"ca435b0eab486d0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/parseFence.js\":\"288fb838fc7a0116\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceParser.js\":\"589afa232de84683\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceProjection.js\":\"5f3ae9417ba31778\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referencesProcessor.js\":\"f2285950e26b2870\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/renameProcessor.js\":\"29ce0d78258e4581\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/spanReplacement.js\":\"606b840b84748667\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/htmlToOutline.js\":\"9a27ff0743fb58e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/index.js\":\"6841fb0b414105fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/normalizeClipboardDom.js\":\"373f932e346473d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/pasteDecision.js\":\"46c91152338d0ea1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/action.js\":\"ea486eb51e0539cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/blockIds.js\":\"28296b4f68e5c0d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/content.js\":\"d3d4b1bcfd86b31c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/effect.js\":\"87ba6a8f466a9158\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/ids.js\":\"69f77ab0798c8566\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/import.js\":\"e0873eb74d267e52\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/index.js\":\"83fbfe3329aa3e60\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plan.js\":\"466f89db22d4be19\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plugin.js\":\"9aa5938bfa4ed8e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/promotion.js\":\"aa5c1be10a2181f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/properties.js\":\"b5b20925124e2ff7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/references.js\":\"8aa45c53d7803d9d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/report.js\":\"0287142b4be926ad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/roamMemo.js\":\"d49d7465c78f6a81\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/runtime.js\":\"df1f97be8616f11f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/schemaReconciliation.js\":\"e5e761fec8477b26\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/srsMarkers.js\":\"65b1cc43d576fb84\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/todo.js\":\"1f993a2d710c0f67\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/typeCandidates.js\":\"c93f9e270df3ec76\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/types.js\":\"87e26a2e06d6a6e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/index.js\":\"06e39bf7a77e168d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/store.js\":\"55296d834bcfd728\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/HeaderItem.js\":\"3744da822b9be6c1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"dbfe5684951daf58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/index.js\":\"c484f785739b28d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/model.js\":\"1b2d4181e50fcd9f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/toggleStore.js\":\"8032ccba2ccef38e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/useKeyInspector.js\":\"b960759dfb8eae0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"177a45f87c22a0fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/ShellDecorator.js\":\"6854a6cef6259b64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/actions.js\":\"fbe08a0ffce243bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/exclusionsFacet.js\":\"2e9dfdd1bf75d02a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/index.js\":\"e3e0b14a1a367339\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/shell.js\":\"b18e5b002b3619a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/surface.js\":\"75abfa3cc8134de1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/walker.js\":\"b90de2cd4413cf02\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/RescheduleToast.js\":\"34044956fe79621e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/dataExtension.js\":\"6abe7700f749b29a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/index.js\":\"4e84dc7c176447f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/indicator.js\":\"d98c91c8306f6e0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/moveSrsState.js\":\"ebc5c94ec1567e18\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"39cc9ba9740978f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/scheduler.js\":\"1e5964e5cbd77187\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/schema.js\":\"ce9465c540cc4a97\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a3e8ff4a3dde3398\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsClipboard.js\":\"40ebf9caf4630f72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"cf4c606219a3fd7b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7a9ebb85bb42be72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DeckPicker.js\":\"1caaacffa0de160f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewControls.js\":\"1a83c85751bb59e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewDeckRenderer.js\":\"074d67b3ec2712b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewSession.js\":\"743ddce32a8134ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/actions.js\":\"496cc5eb853b4128\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/archive.js\":\"2eb46666e3abdccd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dataExtension.js\":\"6cc80650548359bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/deck.js\":\"7aa85245156f8652\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dueQuery.js\":\"ba4d99b040db849d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/gradeDecision.js\":\"99808b4ebf9c7991\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/index.js\":\"a59f65c2eb05d017\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/keyHints.js\":\"783b4952d8da63d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewCardLayout.js\":\"ce07a1f847c474af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewProgress.js\":\"85de8aabc86008f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/schema.js\":\"e4b5f83003384897\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/useDueCards.js\":\"3a8f537f82ab9b36\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/index.js\":\"526b25c58a64f74b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/record.js\":\"c8f2d045c2f5dcf3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/index.js\":\"f48441ca9a6d505e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/persistenceStatus.js\":\"334d8b1343fd7613\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/requestAction.js\":\"02f0128346f72ff2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/TypeChipsDecorator.js\":\"11d95236dfeaaa49\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/codeMirrorExtensions.js\":\"51c0ecf0ff940f76\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/index.js\":\"59519237bb4b681c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/typeAutocomplete.js\":\"253812e57319d928\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ef2536e1bfd574a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/actions.js\":\"94ac19deac2c846e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/anchor.js\":\"f2c4ae2dd4765a96\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/events.js\":\"d3ba137937640980\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/gestureActions.js\":\"cbed2efc3751f235\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/index.js\":\"2c31f9a9ce31b4e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"211d84d8aad24e24\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/collect.js\":\"9bfe068a65820f67\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/index.js\":\"6d102ab958a43bb5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/record.js\":\"4325e3f21f532222\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/RejectionDialog.js\":\"afd4390f557d9635\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/SystemStatusHeaderItem.js\":\"eceb4ad71bdc7648\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/index.js\":\"974bfe3d1ebd07b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/model.js\":\"7b521800f10af395\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/queueCounts.js\":\"b6f0e98cd8127f3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rejectedHelpers.js\":\"fe841d303ffd76ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rematerializeAction.js\":\"cb6fa2901b9d7f88\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/useHysteresis.js\":\"0c11772a13d5d837\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/ColumnHeaders.js\":\"4553d10228f0894f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/QueryUi.js\":\"c980c04b37745ae2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/TableLayout.js\":\"fdce6751b7dba3c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/actions.js\":\"34de33bb0be5539f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/cellEdits.js\":\"42f1752887e38ca5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/childrenViews.js\":\"b41411a877d42ef1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/columns.js\":\"08edd5ff83ca0a28\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/controller.js\":\"8ab731465c7eca92\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/convert.js\":\"100610f859bf7f24\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/dataExtension.js\":\"cbe65b0b5a469c6c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/index.js\":\"10351c87ea74cbd3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/keys.js\":\"59ddd6d2b8491b89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/model.js\":\"3f12b19395d212a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/QueryText.js\":\"d93fc4f9646ec670\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/backfill.js\":\"3e27739fb17a3330\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/completion.js\":\"4f36fc831a8cc130\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/format.js\":\"b88a7af78498b427\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/parse.js\":\"99f3e2990efd0d72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/queryValue.js\":\"7a336627e33aee3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/registrations.js\":\"8caef012d31125f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/source.js\":\"208045ba34447603\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/registry.js\":\"471fffce23123a1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowGutter.js\":\"01a37b6f78a844d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowVerbs.js\":\"590c070897562db8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/schema.js\":\"d52f0c0bdd1662ce\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/sort.js\":\"fdc697080692579f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/effect.js\":\"48f1ba6bb8e7c8c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/index.js\":\"c0be458b18e5edfe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/theme.js\":\"d17a0df40a696d2c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/actions.js\":\"f9e1d6324d2751d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/dataExtension.js\":\"8b20b709d5e04d40\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/index.js\":\"d18774f9346cceab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/schema.js\":\"acb35b33603fbde4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/TouchSelectionLayer.js\":\"47f9f391d903a574\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/actions.js\":\"c7bf5452e0980ea2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/defaultItems.js\":\"7c9c678ac010143a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/facet.js\":\"3b0d201e29bd9415\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/holdRecognizer.js\":\"91e81f1a9410b765\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/index.js\":\"3d4457ab8f877869\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/UpdateIndicator.js\":\"3f72ad87cd83c19b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/index.js\":\"3013a6de9b492468\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/loadTimes.js\":\"624b33f29cf21263\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoNotesRenderer.js\":\"95f8743c9471758f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoPlayerRenderer.js\":\"935bf8c7868d9a7b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoTimeStamp.js\":\"4265902dfce223ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/actions.js\":\"7c8a0b5f6506a442\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/index.js\":\"c003a77ea2c1c1c7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/markdown.js\":\"197d630dc4d25601\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/notes.js\":\"80a4eede9e5c4059\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/registry.js\":\"83f2ce135a2582ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/remark-timestamps.js\":\"f0a8b0e40e5b1899\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/view.js\":\"85d0ebc1bc13fdee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/LinkHints.js\":\"f7360c0cbd3c6ea4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/index.js\":\"a19a3d547ee7ac83\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/model.js\":\"e1e2ff655fd3f6cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/settings.js\":\"989f2dd287c751f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/actions.js\":\"a85a00e59d7e5f5f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/index.js\":\"147e3114304fa1d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/interactions.js\":\"fa8a8ee17e9de14a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/workspace-header/index.js\":\"a04674854ccd724d\",\"/knowledge-medium/pr-preview/pr-1899/src/registerServiceWorker.js\":\"9f4559d06e018bf3\",\"/knowledge-medium/pr-preview/pr-1899/src/requestPersistentStorage.js\":\"41b681619f7aa5ce\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authRequestDeadline.js\":\"b854638c7edd169e\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authStorage.js\":\"b1724ce534c8b8a0\",\"/knowledge-medium/pr-preview/pr-1899/src/services/powersync.js\":\"9e0fd7780461794f\",\"/knowledge-medium/pr-preview/pr-1899/src/services/supabase.js\":\"347aac216927fae9\",\"/knowledge-medium/pr-preview/pr-1899/src/services/uploadErrorClassifier.js\":\"6f0734798976658b\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/ActiveContexts.js\":\"26457f35cebf6b3e\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/HotkeyReconciler.js\":\"6f12995ff0c5439d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/WipeLocalDataDialog.js\":\"17106310354a2a36\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionDispatch.js\":\"483cff29568e5b13\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionRefItems.js\":\"2669c14a2d76556d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/applyKeybindingOverrides.js\":\"b8bf96e66c667432\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockActions.js\":\"72f9ef68b6e599c0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockMergeGesture.js\":\"e00d9a071466a0ab\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/canonicalizeChord.js\":\"4ae0cbfdbfe1c6e4\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultContexts.js\":\"3d80a1bce12835d8\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultShortcuts.js\":\"bea00c68f1f3d277\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/effectiveActions.js\":\"7933266b2113f9a7\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureAction.js\":\"b4c3e30ea4ee2949\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureBinding.js\":\"28f3a0e356ba72e8\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/holdRegistry.js\":\"1219ce47ea70fe8f\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingConflicts.js\":\"6d6573b4565b41e8\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingOverrides.js\":\"e4df21cb128b95d0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/pointerAction.js\":\"5613bd65eb49339c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/resolve.js\":\"5b1f7787d2107c0c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/runAction.js\":\"1e123d3cc618d91c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/sequenceMatcher.js\":\"d9c1b33044f97441\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/types.js\":\"c54695645318f135\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionContext.js\":\"6efbcc331225916b\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionDiscovery.js\":\"fe0e5f0594984d0a\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/utils.js\":\"4d75205866a6417e\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/bootStore.js\":\"155ce7093a4071b2\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/previewDatabases.js\":\"0ddc99a94de07662\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/byteTransform.js\":\"ac096f5b311e5efc\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/attachmentCleaner.js\":\"fd74f6453afdc70f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/attachmentParts.js\":\"ae9c419b9da9de67\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleParts.js\":\"6e7e42b20e3336bf\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleRecord.js\":\"111029e26fb4c03f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/manifest.js\":\"50ff20b6016a93e5\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/takeBundle.js\":\"4feaad7654607d88\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/verifyBundle.js\":\"7e216c69ad993570\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/cleaningStage.js\":\"844e79d5e6babde2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionKey.js\":\"71dfd7166625aef1\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionServer.js\":\"7072342468ad8648\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flip.js\":\"461d6111a1bbc1b1\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flipAttempts.js\":\"e99c531c7d5d4738\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/pages.js\":\"0dae7fbe4cb50679\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/preflight.js\":\"f1a3a08613c0d78d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/reseal.js\":\"c1138a5a88711653\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runConversion.js\":\"b00ae897fa83697f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runLock.js\":\"480ac1be2eaf347d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealing.js\":\"f9180b4d7eb71359\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealingStage.js\":\"3981953243afef45\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/stage.js\":\"b8a943915dfa2c6a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/verifyReseal.js\":\"ae4678a8e6212025\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aad.js\":\"4232c598e5835068\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aead.js\":\"42f50cb46c10710a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base32.js\":\"51ba2cc6f74087db\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base64url.js\":\"af20da525c575f99\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/binaryEnvelope.js\":\"0565e3ae171cdc10\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/byteAead.js\":\"43839edba55ccb0a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/canary.js\":\"64dfaa1332bc833a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentHash.js\":\"9e524f1982e6b7cd\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentKey.js\":\"0660d1d140e30ea5\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/derivedIdNamespace.js\":\"e4dc08219e5a5d63\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/envelope.js\":\"1e9c3ccc2cf13cf9\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/hex.js\":\"e48484312023c122\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/sha256Hex.js\":\"043636134c102c70\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/workspaceKey.js\":\"f60adc44364ce359\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/conversionState.js\":\"0ae7075a00c9839e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6bf255839c08edbe\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/pastedKey.js\":\"cfbe4a123d7d7467\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"fbbe96d3c89b6a67\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/upgradeWorkspacePin.js\":\"af2254260b984f99\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/keyStore.js\":\"3435d4f123c6e48a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/mintWorkspaceKey.js\":\"fa70a19f1f58699e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/modePin.js\":\"03c5a53840ece4b1\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/openWorkspaceKeys.js\":\"d9173533d6d73721\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolveWorkspaceEntry.js\":\"75b7c107b90fa2fe\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolver.js\":\"aceb3876586bec03\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/workspaceAccess.js\":\"b38d1097507d899f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/transform.js\":\"f42ef7dbe3b62541\",\"/knowledge-medium/pr-preview/pr-1899/src/themeBootDefaults.js\":\"36a65a5dd8308cbe\",\"/knowledge-medium/pr-preview/pr-1899/src/types.js\":\"46e90cda1c27e3e2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/ClientLocalSettings.js\":\"0e37625541f55cf5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/abortableSleep.js\":\"f8228f8072d601fe\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/array.js\":\"6b9c958572d686c7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/backlinkAutocomplete.js\":\"5b47e7a54b50b38c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockCrumbs.js\":\"cbcbe21d5325a6b7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockrefAutocomplete.js\":\"823b49d785a2c29f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/cadencedIdleJob.js\":\"c398bee3af36f623\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/callbackSet.js\":\"4c93a8c0baaabb10\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/clientId.js\":\"6d7485f3c3dcf862\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirror.js\":\"75c8efc7587e4622\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirrorCompletion.js\":\"d428a71c67317a60\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/copy.js\":\"89b365a033a69e1f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dailyPage.js\":\"343113a1bac09234\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensics.js\":\"9b4ed4489bba7067\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensicsHooks.js\":\"cdcac29f337e10bd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/deleteBlockThroughUi.js\":\"31d6ea33ac6884ad\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dialogs.js\":\"f2d3df8e80a6e8cb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dom.js\":\"c84a6a500aa16c52\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/downloadBlob.js\":\"109ac04e67f5853e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/drawnWalk.js\":\"687b2060f51487d5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/exportSqliteDb.js\":\"5953ae5e02fe2ec4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fileSystemAccess.js\":\"07adc23eb6b0c231\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/flipSlide.js\":\"14bfab843aaad54e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fnv1a.js\":\"92029f2305071b7c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/formatBytes.js\":\"e642d334cc42c8fd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fuzzyRank.js\":\"a28ee96caac4318e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idbKeyedStore.js\":\"2582dc3cba36eacd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idleCallbackPolyfill.js\":\"639ef1c53a465481\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardAwareScroll.js\":\"ed3e9014744c7148\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardViewport.js\":\"86552c27ba351026\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/lastWorkspace.js\":\"0929876a3993ec7b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutColumns.js\":\"41dd87fbcc9cf64d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionDom.js\":\"16b95626e0c7f635\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionId.js\":\"5e21049d0098fc17\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkClickGestures.js\":\"17f3410a7811a1b5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkTargetAutocomplete.js\":\"119113ffeb813933\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbCorruption.js\":\"b834709f83febc92\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbRecovery.js\":\"ab339764f929bf47\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/markdownParser.js\":\"668f092ac368496d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/memoize.js\":\"9524818dd84bb143\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameFieldCommit.js\":\"14e68940d0a9f5a4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameList.js\":\"d0c3d6ed1b598103\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/navigation.js\":\"1b6c2e3f9c1f5a59\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/omnilinerNamespace.js\":\"bebd78cdb363a7b7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/opfsPageScan.js\":\"eb6d6b8fc59f935e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelClearance.js\":\"c9f4e941ea61ade1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelHistory.js\":\"3d58aee1d1a386fe\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLanes.js\":\"9465b30d35851571\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLayoutProjection.js\":\"b23f912e3b16d3bd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelScrollAnchor.js\":\"a7f2229a1dae460f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelUrlFlags.js\":\"5a632b62596bc0f8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/platform.js\":\"3e3c7d86c867df43\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/pluralize.js\":\"ace6e23d00043335\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyCreation.js\":\"894c9c9312a185fb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyNavigation.js\":\"93c046ee92772136\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyValueContext.js\":\"387c2302dce95b2c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/react.js\":\"b0521989ee41ef44\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeDate.js\":\"6834ecd35fa5dcd4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeTime.js\":\"272b7ad83b8cc0a2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/renderScope.js\":\"620f89201a59e258\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/resolvedThenable.js\":\"c6b290156b1dc481\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/routing.js\":\"07cbf55329177873\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/safeMode.js\":\"716e3e5c3e25901b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/scheduleIdle.js\":\"cba5e455be0fb622\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/screenWakeLock.js\":\"6dd52d33777718ed\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/selection.js\":\"2b47a7710965fd70\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/softKeyboardGrab.js\":\"4e30657d2dd5d406\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/startupTimeline.js\":\"c576061b641da5cc\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/state.js\":\"5cd955bae04e29a6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/string.js\":\"ed40affc1438bf7f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/surfaceZoom.js\":\"2369e30fdcd37410\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/time.js\":\"493678af7f2acdbd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toast.js\":\"17fcad3338e74639\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toggleStore.js\":\"29a33146717dc89c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/untilStopped.js\":\"94bb6232f87cac54\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/userActivity.js\":\"b4613a57f4e5d1ee\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewTransition.js\":\"0e8961e326e58daa\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewport.js\":\"1122753e396df348\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/webLock.js\":\"c1a6a5ab8599bc8b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceRecovery.js\":\"8520d43d9acdc136\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceSnapshotStore.js\":\"7982c74d5c355ae7\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-compiler-runtime.js\":\"0a27e054a1e33ee6\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-client.js\":\"692bc247b7543b44\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server-edge.js\":\"36086bdf71090969\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server.js\":\"7d21021eaf12d0a2\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static-edge.js\":\"5f1fc4836b82ae0d\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static.js\":\"8434a8331452c85a\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-test-utils.js\":\"bf846bb4d32b92ee\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom.js\":\"0640bdb5dfa11e80\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-runtime.js\":\"877ed7bd5ee1bf8a\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react.js\":\"9b32f8b741a4b62a\",\"/knowledge-medium/pr-preview/pr-1899/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
