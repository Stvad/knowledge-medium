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
		buildId: "30776e4c4428-88cb1b8f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/\":\"b786135b70983093\",\"/knowledge-medium/pr-preview/pr-1899/index.html\":\"b786135b70983093\",\"/knowledge-medium/pr-preview/pr-1899/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1899/assets/FacadeVFS-B9jLqfab.js\":\"763eb4093bd8fee9\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSCoopSyncVFS-DtwLKy83.js\":\"f73515a3f3333054\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSWriteAheadVFS-BONy0fP0.js\":\"887ab736a6c34c93\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-DLFUAwdX.js\":\"a0e59f29cbc87ea2\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-BshiGTRj.js\":\"4e27ce816562316b\",\"/knowledge-medium/pr-preview/pr-1899/assets/worker-Bk7aBePL.js\":\"d82d7b0a70bac9ec\",\"/knowledge-medium/pr-preview/pr-1899/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1899/chunks/app-AWmcPxAI.js\":\"82bfd60839d5b2f3\",\"/knowledge-medium/pr-preview/pr-1899/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1899/index.js\":\"f0546a23f5f70c0b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1899/assets/AccessHandlePoolVFS-CyBIsY5o.js\":\"0af4b2b63384cece\",\"/knowledge-medium/pr-preview/pr-1899/assets/IDBBatchAtomicVFS-qTpzDvaH.js\":\"d09c029ddd907795\",\"/knowledge-medium/pr-preview/pr-1899/assets/MemoryVFS-Cbqj_-X1.js\":\"db2fee2b41dfcb76\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cof1KQIi.js\":\"e3aa4671dc972e48\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-C6Nt3FpC.js\":\"ad2ce872698709cb\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1899/chunks/AccessHandlePoolVFS-DlZ9Vcud.js\":\"278bfb60d5ef0b89\",\"/knowledge-medium/pr-preview/pr-1899/chunks/FacadeVFS-eoNTRWHo.js\":\"5e0887d63bb54397\",\"/knowledge-medium/pr-preview/pr-1899/chunks/IDBBatchAtomicVFS-eeCfuVjG.js\":\"a83256ae866adb99\",\"/knowledge-medium/pr-preview/pr-1899/chunks/MemoryVFS-DkDFKV_a.js\":\"3f3b9d2f4acb32cc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSCoopSyncVFS-Be8WACkk.js\":\"d3529d532e918916\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSWriteAheadVFS-DHwn2tT9.js\":\"71ed8c30b35b8276\",\"/knowledge-medium/pr-preview/pr-1899/chunks/Preview-DSjQNNjM.js\":\"ce40e1fdaad4752d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/card-76PsYuHr.js\":\"3278130bf797d33f\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BqwVoAu8.js\":\"35e2b2aced5b8b1d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-KOTd-Jz-.js\":\"830f130835e933c7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-async-DXpyFyuH.js\":\"07d730191d5534b9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-BSVRpnMJ.js\":\"ee07f16dce0a5ea2\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-BukHcgPK.js\":\"d6f2bdda2caebc19\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-C0D8kyy4.js\":\"36af7d3f89061bd2\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-C9vprjEA.js\":\"8fe83a519c419390\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-D7coiZ5S.js\":\"90d187582b659df6\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DdezNFBk.js\":\"64c84dbdfd914ebe\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DzL4v6oH.js\":\"031ada045575a82f\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server-legacy.browser.production-CXs-g77a.js\":\"2d8cc7cd957ff1e8\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.browser.production-BxYkxC0U.js\":\"39eb8afbdd3a4288\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.edge.production-nuRH-OiM.js\":\"416a1941bb14e094\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-fW8Qggdy.js\":\"3e8ec8a38fe96476\",\"/knowledge-medium/pr-preview/pr-1899/chunks/server.browser-D3WiPgLu.js\":\"fbe0b23839d5704b\",\"/knowledge-medium/pr-preview/pr-1899/chunks/textarea-BqicryNq.js\":\"ee5411669e373b72\",\"/knowledge-medium/pr-preview/pr-1899/chunks/ui-D0GPGMCX.js\":\"5dd2b6f839119066\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-async-KolfQSRg.js\":\"1536c52324bb822c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-jj9ouo2A.js\":\"026bb57fad7ed299\",\"/knowledge-medium/pr-preview/pr-1899/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1899/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/src/App.js\":\"5badb6069d929dc1\",\"/knowledge-medium/pr-preview/pr-1899/src/appUpdate.js\":\"96eb57751131a8bb\",\"/knowledge-medium/pr-preview/pr-1899/src/appVersion.js\":\"0f7627380f511933\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/initialLayout.js\":\"8f04af11c09c9bb3\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/openWorkspaceData.js\":\"2f1c7ff87712477f\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/resolveWorkspace.js\":\"31bada1642b7838e\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/workspaceBootstrap.js\":\"6b32a86e0652cb8d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockComponent.js\":\"841f2fe332df8a78\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockCrumbs.js\":\"982649d8ca020ee1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockEditor.js\":\"8709a8cb506ba0ba\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockLoadingPlaceholder.js\":\"055e54ee1fe79cfd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockProperties.js\":\"49b4e4105e185144\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockSearchPicker.js\":\"5dc9842fd73eb1e1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ConfirmBulkDeleteDialog.js\":\"84e0c609d6904aa2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DividerHandle.js\":\"22b759ad6e9d3879\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DraftEditor.js\":\"7f394d1dde92d74a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/GutterPill.js\":\"0e138bb3e5638314\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Header.js\":\"baa4dec064d8e102\",\"/knowledge-medium/pr-preview/pr-1899/src/components/LazyBlockComponent.js\":\"e6fc45b51527e6e0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Login.js\":\"256d20ef019825a0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ZoomableSurface.js\":\"ad2051f7e83444d7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/editModeKeepalive.js\":\"ad89bac92c2b3fa0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d9f57db3f524b7c5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"21d4a188cc3c6b23\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefPropertyEditor.js\":\"1e03ad7263e7b5d3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefTargetTypePicker.js\":\"69ab88616744f110\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/SelectPropertyEditor.js\":\"63f36f88cfafeb1b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/TypesPropertyEditor.js\":\"f371e2b9844aee07\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/defaults.js\":\"f1db64173b6e3ea2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/kernelValuePresets.js\":\"c67d2135b9b9d436\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/selectablePresets.js\":\"210ca6f0d3bad5fa\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/typesPropertyUi.js\":\"55b764e34cb146e4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/AddPropertyForm.js\":\"522e88e92bba3825\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyPicker.js\":\"94fe5387f446f465\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyRow.js\":\"0814cfad6ff2dcfc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/Rows.js\":\"27b59e7d14183b64\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/actions.js\":\"d320cb3b9dc35fe7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/declarationOnly.js\":\"b51ac86590238abc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/layout.js\":\"25f4f9a8c6a0bb5c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/model.js\":\"d5e9ec9137535c57\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapeUi.js\":\"a2efdf658d06539a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapes.js\":\"0bfef0a94b61d34e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/usePropertyEditingActivation.js\":\"75f4d3adcd331790\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/visibility.js\":\"7816e813bf888ac4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanelSections.js\":\"dc65fb921cf38173\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockEmbed.js\":\"6f1fe71623baecff\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockLink.js\":\"07d65d761e68999a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockRef.js\":\"e6946abcc7f9d408\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/CompactReferenceLink.js\":\"cd0535764ffc07d4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/ReferenceLink.js\":\"c30ae5c933692d9f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuard.js\":\"650fe5141d24635e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuardContext.js\":\"948749ab9802bc76\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/linkInteraction.js\":\"faec730b67f5a896\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/referenceLayout.js\":\"76c1152896dfda4b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/useBlockRefAncestors.js\":\"75ef86d5dd861f5b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockGutter.js\":\"07303dc5c287a9ff\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockInfoDialog.js\":\"f71e57df8d4fd899\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockReadText.js\":\"56de6308d6441d90\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockTypeBlockRenderer.js\":\"3c6a043ad7cfc706\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BulletHoverCard.js\":\"861e82f9afff6fd0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorContentRenderer.js\":\"6f1dac25ec058d03\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f2ea7571dc73a37e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ColumnResizeHandles.js\":\"38d882e1569b1e62\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"5809b892dcff494e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/DefaultBlockRenderer.js\":\"3931cfdbaef287be\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/LayoutRenderer.js\":\"7aa9b8d23f355eaf\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MarkdownContentRenderer.js\":\"5659e9aa3e6a70f1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MissingDataRenderer.js\":\"374c1a5e0904306d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PanelRenderer.js\":\"c5bcd80efcdcded9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d881de335653d787\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/TopLevelRenderer.js\":\"bed423cdfc17c310\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockGutterMode.js\":\"2e2c7b18a684ccb7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockTitleText.js\":\"7b67fa568459f7b5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/fieldCreationKeydown.js\":\"5dad95a749e20d64\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/layoutRootContext.js\":\"74364614456b3755\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/TypeChip.js\":\"d7bfafcad4bbd6d8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/chipStyle.js\":\"b8b42df1fb429c33\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/anchored-floating.js\":\"bfc92e216b30aeb1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/button.js\":\"9918bb3307232cb2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/card.js\":\"7d729bb21b9ce30e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/checkbox.js\":\"3776e929f9bbcded\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/collapsible.js\":\"9a6f3edc301745a1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/command.js\":\"63639e27403b0987\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/context-menu.js\":\"a8b7d258c7d238b5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dialog.js\":\"345bd31c267eb824\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dropdown-menu.js\":\"c251b24c1ce8cb9b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/floating-listbox.js\":\"6e009651ccd321f6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/index.js\":\"11836212f5f05087\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/input.js\":\"04484db15e73354d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/kbd.js\":\"6427fb83d9eddc7b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/label.js\":\"58d7fb80a8ecb75b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/textarea.js\":\"7ea7ad43f04110b1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/useEditModeYieldKeepalive.js\":\"84e64cdef252dd2b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/BootFallback.js\":\"0d695162787eab6c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/FocusedRowLazyMount.js\":\"51b8563435418f82\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LazyViewportMount.js\":\"3cfc0850f018e7b5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LocalDbCorruptionFallback.js\":\"7bc28eb82635d03b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/error.js\":\"6b53546b60ff42b2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/lazyMountRegistry.js\":\"7d1d340a6811c1d5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/suspense.js\":\"c7c32f92c9b82a39\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/CreateWorkspaceDialog.js\":\"3f117d5e85b30649\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/PendingInvitations.js\":\"a4692cb6c9e6ea05\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/SyncProgress.js\":\"25525a7482d5af4b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/UnlockProgress.js\":\"6b18881c9c3f7ec6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceKeyGate.js\":\"4c8b8a05c59ba744\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSettingsDialog.js\":\"8e826bb30b06b4df\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSwitcher.js\":\"c0bf80f286674801\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSyncGate.js\":\"431d0e75e2c6fe02\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlow.js\":\"192fa00d1e6c844c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlowHost.js\":\"e62fd8e13eb49f33\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/EncryptionSection.js\":\"d889f76a8d2c86cd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/attachmentPrompts.js\":\"c304176ba1345414\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/bundleFolderPrompts.js\":\"c527776d47520f02\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowDeps.js\":\"e130803ea649c03b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowStore.js\":\"97a245250f049e49\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/flowUi.js\":\"abe577a0b8aff99c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/useConversionRun.js\":\"e1c5dc97c0e53d2b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/keyUi.js\":\"dca500b1a24d1e0d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnKeyLoss.js\":\"5cae7b939244e744\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnServerE2ee.js\":\"9a2b627cc81454a3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/workspaceUnlocked.js\":\"7d531b3e42d74e27\",\"/knowledge-medium/pr-preview/pr-1899/src/context/backgroundSubtree.js\":\"999af4fc0e2660c1\",\"/knowledge-medium/pr-preview/pr-1899/src/context/block.js\":\"6eaa2fbf3d1a6435\",\"/knowledge-medium/pr-preview/pr-1899/src/context/layoutWsContext.js\":\"8fa72e90122152e5\",\"/knowledge-medium/pr-preview/pr-1899/src/context/propertyDisplay.js\":\"f4f1991a68713dad\",\"/knowledge-medium/pr-preview/pr-1899/src/context/repo.js\":\"52167d574d2b7398\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasClaim.js\":\"b0c78b278ea1a4f6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasSeatNamespace.js\":\"d406ae080d89e30e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockData.js\":\"c4f18a4f328df163\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockType.js\":\"ec79023d7f2ee438\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/changeScope.js\":\"4ea8bb50eaa2ab88\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/codecs.js\":\"50cb565517655a50\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/derivedData.js\":\"acba1f44ae367edf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/errors.js\":\"aa323b775eab9cd1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/events.js\":\"086aa2507bbd8da4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/handle.js\":\"4c4cdd9ec48037c4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/index.js\":\"62803e52f72bd57a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/mutator.js\":\"681bd24341e205bd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/processor.js\":\"294fbc08801c3e07\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/propertySchema.js\":\"1d8bcc17d655a0c6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/query.js\":\"cd414289bb50c425\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/sameTxProcessor.js\":\"2ef47a86533669d3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/schema.js\":\"4c4cdd9ec48037c4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/tx.js\":\"4c4cdd9ec48037c4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/typedBlockQuery.js\":\"15fcec8383ac66de\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/user.js\":\"7a972ecdace0a870\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresetCore.js\":\"f80e7728beabb56e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresets.js\":\"aad0e5b4382d8ec8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/attachmentCleanerIOVerb.js\":\"f3b6bc78b56709ee\",\"/knowledge-medium/pr-preview/pr-1899/src/data/block.js\":\"53f11fbae4f25154\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockCache.js\":\"3ad373f4321eb715\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockId.js\":\"4f7ceca987fa4574\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockLiveness.js\":\"ee883ef822cbec4d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockMerge.js\":\"5a78d19b8fe70e04\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockSchema.js\":\"81dae4ba3dbb3df5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypeLookup.js\":\"abd412a7c1911671\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypes.js\":\"9b51a244f3178ccb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/childrenView.js\":\"606809c9a71b8ba2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/clientContext.js\":\"e16bd3f736c357a0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/dbFileSiblings.js\":\"0f7e28d054a656ac\",\"/knowledge-medium/pr-preview/pr-1899/src/data/definitionSeeds.js\":\"0eb409b5062887da\",\"/knowledge-medium/pr-preview/pr-1899/src/data/derivedIds.js\":\"f7e14847b182ddc8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/drawnSubtree.js\":\"6735b6458fbf1be9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facetBridge.js\":\"a67209b7cbcc3520\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facets.js\":\"a4df7d4a00059e3b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/globalState.js\":\"a6fa9ca6c1e4fda5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/aliasClaimRederiveProcessor.js\":\"7623ffd1e371075a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/ancestorBatch.js\":\"8dea2cd2a3e29b4f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/blockTypeTypeifyProcessor.js\":\"e2908dd839cc776b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/clientSchema.js\":\"876de63d94206138\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/commitPipeline.js\":\"16cc8e9cff641532\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/devAssertions.js\":\"18faa29bf5b61e2e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/firstSync.js\":\"4639a05b7f4aea3a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/freshInitialLoad.js\":\"5bbbd0f9ab16e762\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/graphBackfillClaim.js\":\"05c97ac0988d5f67\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/handleStore.js\":\"255486ac4852d58f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/idleMarkerJobs.js\":\"45adc33596af2745\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initialDownload.js\":\"417c25f92be8a4d7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initializeClientDatabase.js\":\"7bd64e136aee4250\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/jsonCanonical.js\":\"bf053d2073d72daf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelInvalidation.js\":\"66effb8fcc110810\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelProcessors.js\":\"84325dc0289c5df8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelQueries.js\":\"77365d1dd374e802\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/mergeTypeMembershipProcessor.js\":\"f73edda0acdb9a3e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/normalizeReferencesProcessor.js\":\"71cfa3e52330afd8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/poolInstrumentation.js\":\"94d6e50d6607b44b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/processorRunner.js\":\"835816780d92fa3b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyCellBackfill.js\":\"71b65b6ccd09539d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildMint.js\":\"5a5179ac702e64a5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildrenProcessor.js\":\"960c391dde49dc17\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionChangeProcessor.js\":\"cc5ea0f2ddcebf0d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionSynthesis.js\":\"bcb5bf2d0bd0635c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyKeyScan.js\":\"7f6f2c3816b28286\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertySchemaResolution.js\":\"f61cadb3f1780f7f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyValueEdits.js\":\"a33d46a909c2fbf5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/raiseProtocol.js\":\"39798457d4819dd2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/readBatch.js\":\"0bd5084bcaf7f553\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/refProjection.js\":\"e4796c4bbf5b2c40\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetLookups.js\":\"900844ae0d4276cc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetProcessor.js\":\"8f2c82e9eb50927a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/replayMerge.js\":\"723c6da06f35dccc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/sqlBinds.js\":\"5405f126e4f3516c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"196bdcb685e22850\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/arrivalProcessors.js\":\"baa50bab529533a4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/invalidate.js\":\"a2d28e6d3b2a4399\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/materialize.js\":\"df0a7485bbb077b4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/observer.js\":\"69428f5703ca8b7d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/reconcile.js\":\"97ac86ee1753b14b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/timingMetrics.js\":\"4955a3a74385befa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/treeQueries.js\":\"924a84cbdc980ed0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txEngine.js\":\"e796bfcf8f9f7eba\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txSnapshots.js\":\"4061c92d5f6ab053\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/typedBlockQuery.js\":\"44ba17b0f6eb7239\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/undoManager.js\":\"199dfa5a9bd3401d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/invalidation.js\":\"5f917494484c4eb3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelDataExtension.js\":\"e85a74c941a195e0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelPage.js\":\"2638cc2f63bd7397\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelValuePresetCores.js\":\"3a9c628867351368\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbCorruptionSignal.js\":\"d2e0ded9e97d7dda\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbStorage.js\":\"8583c0e43c0668ae\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbVfs.js\":\"622641de3203cac4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localSchema.js\":\"4f4d344d1c430270\",\"/knowledge-medium/pr-preview/pr-1899/src/data/maintenance.js\":\"edb34c5c7fcca93b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mergeProperties.js\":\"77e3a3c844c72758\",\"/knowledge-medium/pr-preview/pr-1899/src/data/metricsConsoleHook.js\":\"4659fb1eadae4210\",\"/knowledge-medium/pr-preview/pr-1899/src/data/migrationsPage.js\":\"9baa01566841ba1c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mutators.js\":\"19f14dda11ffd271\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKey.js\":\"ccd2ad4288604a80\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKeyPlacement.js\":\"7f5b883ab49a4915\",\"/knowledge-medium/pr-preview/pr-1899/src/data/outlineSurface.js\":\"929ce912c36dd89d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingEditorContent.js\":\"f6d16b7b85ea4056\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingUploadsSql.js\":\"019cda2146ec3bb9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pluginStateExtensions.js\":\"d701a378a7c75aab\",\"/knowledge-medium/pr-preview/pr-1899/src/data/powerSyncLogger.js\":\"99c6b046ff48c743\",\"/knowledge-medium/pr-preview/pr-1899/src/data/projectorRuntime.js\":\"d08fefb391b58122\",\"/knowledge-medium/pr-preview/pr-1899/src/data/properties.js\":\"18284b0e24071f3c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertiesPage.js\":\"2270a287a2660d43\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyChildren.js\":\"0038f54f9ef23dc4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionFanout.js\":\"020c7d281f93c3a3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionMetadata.js\":\"7a4c42e0c1c25d30\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionRegistry.js\":\"183d4712d909c968\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDisplayMode.js\":\"120df08d188a9dd4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyRowCreation.js\":\"c558caf30e7fb013\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySchemaCreation.js\":\"ce4c782e9bdda068\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySeeds.js\":\"0769571f5f8868f6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/recentsPage.js\":\"e5c3becbff918e48\",\"/knowledge-medium/pr-preview/pr-1899/src/data/refTargetComparableProperty.js\":\"367cf5c9c721791f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/referenceBlock.js\":\"de27ff6b2e0ab44d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rejectedUploads.js\":\"1dcf83519f94557c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/releasePowerSyncConnection.js\":\"352b3a8496115d1c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repo.js\":\"a6c8def2d1afbcf4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repoProvider.js\":\"95d2c3adb1712cb9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rowProperty.js\":\"299079daf0257a15\",\"/knowledge-medium/pr-preview/pr-1899/src/data/searchFilter.js\":\"4d455c01ce7b9fab\",\"/knowledge-medium/pr-preview/pr-1899/src/data/seedIdentityLedger.js\":\"f22c5f07f9ac3b48\",\"/knowledge-medium/pr-preview/pr-1899/src/data/stateBlocks.js\":\"57913d496c7c7c1f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralEditPolicy.js\":\"c2faaa647f279b82\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralInsert.js\":\"938ce3c65dbd6eab\",\"/knowledge-medium/pr-preview/pr-1899/src/data/subtreeDelete.js\":\"af418a2ffe54f55f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncStreamLock.js\":\"41dcf7c261e8d8bf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableSqlRecognizer.js\":\"614b34e90b92f652\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableWriteGuard.js\":\"59b57dddcbabeaea\",\"/knowledge-medium/pr-preview/pr-1899/src/data/targets.js\":\"3b16f3bebb6f338f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeColors.js\":\"db875d4d8e6c7db3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionMetadata.js\":\"0fcf8a8f434d82b3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionRegistry.js\":\"805e427059fd51aa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeExtraction.js\":\"2bf79bcacaa53991\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeInitialValues.js\":\"b16bcbdb70799b3f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typePropertyGroups.js\":\"0e89c630ca833b51\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeSeeds.js\":\"d1431eee372718f4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeTagger.js\":\"d35924a48965657f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typedRecords.js\":\"db13377368a67735\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typesPage.js\":\"d93e401c9f7117b5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userPrefs.js\":\"5420798d217e5e12\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userSchemasService.js\":\"a44797dc30b9a66c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userTypesService.js\":\"78f2e73cc3e93c81\",\"/knowledge-medium/pr-preview/pr-1899/src/data/valuePresetRegistry.js\":\"e16916913b71a88e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/visibleChildren.js\":\"71fdc5ae1fc3dbb4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceConversion.js\":\"81f5168c3af00a78\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceFirstSync.js\":\"afd539732d06ad4c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceIdNamespace.js\":\"c896dcf910ea5f61\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceSchema.js\":\"3ce0539e44fb742c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaces.js\":\"79e2775c6563ca9c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadLog.js\":\"ae7cbae4a9292135\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/BlockPasteShellDecorator.js\":\"1132461afe00b033\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/atTrigger.js\":\"3f7db42fe4365516\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/autocomplete.js\":\"771d43d39c59cf42\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/codeMirrorExtensions.js\":\"0853c67b7bd7e6aa\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/contentFlush.js\":\"432058ac09cb5c53\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/defaultInteractions.js\":\"003089633416baf3\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/editSettleSignal.js\":\"33690d539400f0b3\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/insertImage.js\":\"006aad9b587819de\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceCompletionRange.js\":\"41a01fab46a2f9f6\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceTargetTypes.js\":\"48fd4d9b284808dd\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/syntaxContext.js\":\"a2dd3e80368d9e1e\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/triggerMatch.js\":\"81ddc371d180381d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/AppRuntimeProvider.js\":\"7e3e7227881beb98\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/BlockFocusShellDecorator.js\":\"e8ee3340f6508fab\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/ExtensionRenderBoundary.js\":\"fe0c1a1c17834de8\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/PanelContentRecovery.js\":\"5dbd636c2fbc8155\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/apiCatalog.js\":\"b4ea92264b33f8df\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/approveExtensionHere.js\":\"2cdd70e88eadfb0d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/armedCutAppMount.js\":\"f78ed78f0142bb55\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/batchableKeyedStore.js\":\"8313365ac43a0988\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockInteraction.js\":\"10102cdff1d2ca3c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockSelectionAction.js\":\"dec69943ac9395b5\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compileExtensionModule.js\":\"88ed24b33cd0236e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compiledModuleCache.js\":\"e2497c1f1abb4a99\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/continuousGestures.js\":\"bea3132d5913a925\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/core.js\":\"725e1e6432589aa9\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/defaultRenderers.js\":\"0e391741b7409687\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/definitionFanoutAppMount.js\":\"c997ed0c81e75bec\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dialogAppMount.js\":\"33b7be604df7adb1\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensionSeeds.js\":\"5ef5530fb2a86d4b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensions.js\":\"451d64556daebf58\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/exampleExtensions.js\":\"f10b2b6f452b1e84\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionApprovalStatus.js\":\"89eac1bee5736f6a\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrorToast.js\":\"f9baf566f22c9ef0\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrors.js\":\"2b5885b2e204fab4\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLookup.js\":\"995a4241a0fe86ca\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionToggles.js\":\"34e1f454d77fce0c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionUtilitiesCss.js\":\"fe9176550584e7e8\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/kernelPageDeletionGuard.js\":\"142636790489c31f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/liveRuntime.js\":\"8292b99d13b5935e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/openExtensionsSettings.js\":\"f942b4f32b45f266\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/overridesCache.js\":\"7dac2c7a628cedf3\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/pluginIds.js\":\"0e3275f20adaabf1\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/processorRejectionToast.js\":\"6d0744b39910d9da\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeActions.js\":\"d832e8dc445df764\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeContext.js\":\"e627b1e55de71440\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticAppExtensions.js\":\"3e913bafb6d5d375\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticDataExtensions.js\":\"dc90c4584d46166f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/toastAppMount.js\":\"934eaa6181c9edf1\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useOverrides.js\":\"402aa7856c7dfeab\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useShortcutSurfaceActivations.js\":\"3fc1a95d4ada035d\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/discoverToggleTree.js\":\"f1e7ef58f6a421f5\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/facet.js\":\"824dcbecdca74241\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/resolveAppRuntime.js\":\"b064cfacdaaeca37\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/runtimeEvents.js\":\"f458c232d12c76e1\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/togglable.js\":\"4662959ab1c1a181\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/variantFacet.js\":\"b27924f9d47a6a73\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/verbFacet.js\":\"395da371988eab0c\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/block.js\":\"1afb360e7e91c08d\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/focusedChild.js\":\"47604862378eec75\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/propertySchemas.js\":\"d879df7526a1d391\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/typeRegistry.js\":\"d4a210ac379d5ec3\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAncestorCrumbs.js\":\"4831fc0c2694b224\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAutocompleteListbox.js\":\"8a7ca15c2c3ef0b7\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedSearch.js\":\"b7483e2578ce7094\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedValue.js\":\"65ec03b2dd7dc48d\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useFacetValue.js\":\"4e059837320ba8a8\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsFocalRender.js\":\"90c0ad28756a9d3e\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsReadOnly.js\":\"1c2f5eb8bc98c25a\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMaterializeBacklog.js\":\"645a7b24ee8d1303\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMinuteClock.js\":\"40ccd324666fdd95\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePanelLayoutProjection.js\":\"a58f832a5750fd14\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePendingInvitations.js\":\"65ea0d742d744dca\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRendererRegistry.js\":\"1fe5848a2f248297\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRetainedFieldRows.js\":\"b956464447926aa4\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useWorkspaces.js\":\"bc5fc12826bc435f\",\"/knowledge-medium/pr-preview/pr-1899/src/lib/utils.js\":\"6c6b7ca2825aa4e1\",\"/knowledge-medium/pr-preview/pr-1899/src/main.js\":\"5bfa9ceb27cec12c\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/MarkdownImage.js\":\"f50bb919c390eb9b\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/blockSeparators.js\":\"b6bf38e4b35f9c82\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/context.js\":\"1115d44709ccdc60\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/defaultMarkdownExtension.js\":\"87697a598873a919\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/extensions.js\":\"7c80eb71e148d495\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/renderMarkdownHtml.js\":\"585cc254ff486123\",\"/knowledge-medium/pr-preview/pr-1899/src/minimal-editor.js\":\"41be6f9797a385d8\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/armedCut.js\":\"becb267c1e962b1b\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/captureMediaVerb.js\":\"1b88a243aa9b01a3\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/clipboard.js\":\"54148711551f2abb\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/decision.js\":\"e6f155388b0b5e4c\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/operations.js\":\"3356f90c2159b0fb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/AccountHeaderItem.js\":\"7650d20975451a71\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/index.js\":\"a1daf2eb893ce2bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"0378dd300949adaf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askAgent.js\":\"c6fd72ba9e596074\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askedStore.js\":\"85d9c54fcef00b0b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"08284958d4bd46e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/chipState.js\":\"e5d1cd27e62566f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2bc76f29f394a905\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/index.js\":\"9a7e18111b56e8f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9122b471f6168ee8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/schema.js\":\"4bd11739c1a04126\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ab9e8fad9e4be371\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/BridgePairingDialog.js\":\"761b1d9619d4fbb4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/addMedia.js\":\"ad85bf7bfc82a913\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/backlinks.js\":\"77c893e0f12318bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/block.js\":\"1ad546fde630daec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/context.js\":\"c16f90cdafa4eb29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/displayIds.js\":\"ef9ea3766c0f947f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/index.js\":\"de5d12fa3b46654e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/outline.js\":\"6d68b79ba72f7741\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/properties.js\":\"3c0eaa5854a9857f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/refs.js\":\"f401ccf97952dc04\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"80dd7183681aafb5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/search.js\":\"c1e753dad73c0366\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/shared.js\":\"175535c81a10e4bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"fc875f3256aa99df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/text.js\":\"2cd323f1120f2c4e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentWrites.js\":\"dfd7763429f7ec18\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/authoringCatalog.js\":\"f2675cba213e2192\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/blockRefTargets.js\":\"2df19f233fe36549\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridge.js\":\"7205f5d1a01e24c1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridgeLoop.js\":\"ed643422d79d7652\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/changeHistory.js\":\"c8013ee011185bd7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commands.js\":\"612ddb199a586c00\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commentsCommands.js\":\"dae870595eadc113\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataExtension.js\":\"621a2e187b8f8dea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataModelGuide.js\":\"ae14d26f591c2c3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dayPropertyInputs.js\":\"a59972378f0de21b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/describeRuntime.js\":\"be13eff8d05c756d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/extensionLint.js\":\"97b116952491de67\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/grainAudit.js\":\"51624bcf99fe51a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/healthCommand.js\":\"3459defd1d7cc490\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/index.js\":\"fb8aa560650213e0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/presetIdentity.js\":\"cd4e927129a7ce13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"7b042642bfe3c479\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/readMedia.js\":\"961b4a554f774b9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/schema.js\":\"7e0615b900ffc6e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/serialization.js\":\"e728bf319fe3f67b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/targets.js\":\"24a65caa5e7d4c8c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/tokens.js\":\"b8fa0e280e5630a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/watchEvents.js\":\"2cd76d476141a69f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/workspaceGuard.js\":\"aa6f61c4788adeb6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/writeCommands.js\":\"6b06e06ce2cc5af8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/AliasCollisionToast.js\":\"3fbf4672c8ff21d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/DuplicateNameBanner.js\":\"931c58ad393db089\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/collisionMerge.js\":\"37dc8dcd6a299458\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/dataExtension.js\":\"2b13e01af6a0ca73\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/index.js\":\"3659f98e87a711a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/mergeCollisionAction.js\":\"f13c75df8f865a6f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/pageStyling.js\":\"ce979311470758f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/rejectionToast.js\":\"f266e53c881abc8a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/syncProcessor.js\":\"a24b88e8a48470d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/actions.js\":\"b107c6ad71c5d273\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/addComment.js\":\"54c93db127044150\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchor.js\":\"61b5cbcb068f1820\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchorState.js\":\"b763d628ee7676a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/commentLinks.js\":\"022d2c8f58b7e32a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/confirmThreadDeletion.js\":\"48b52a4ec21ad24d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/container.js\":\"8d15f3868a7c7385\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/dataExtension.js\":\"c3234c1de9165d6e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/deleteComment.js\":\"cd6386d0ad746334\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/highlights.js\":\"84915f16508ef747\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/index.js\":\"3fde75f4314b6e63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/linkedCommentsPill.js\":\"2de1391f85ce0784\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/margin.js\":\"4f1e1fc378bfa352\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginAnchorLinks.js\":\"504e3bc0c11c17ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginSchema.js\":\"455b2b220c9011ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/newComment.js\":\"4c76eece284c0306\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ownThreadPicker.js\":\"f94d73065e53fe92\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/placement.js\":\"629efeb0842d6e09\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/queries.js\":\"8312cad8731e4c5b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotePosition.js\":\"5a9bf670f3502e75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedIn.js\":\"82562c16eb5eab05\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedRange.js\":\"1b6eb182c5d6e04d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/rangeRefs.js\":\"49fbc985c5d2cf2e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readHighlights.js\":\"ad2b804a9bd8bd5e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelection.js\":\"8316c72425c47eab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelectionUi.js\":\"730c5ec6921d9bd7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/reanchor.js\":\"b44fb82be0701523\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/schema.js\":\"8914426c17f1787e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scope.js\":\"bfdd3b808742349d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scopeThreads.js\":\"8f471a99a42febdd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/splitRetarget.js\":\"2dcf795e0107ba90\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestionCard.js\":\"49276c3bac3041d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestions.js\":\"bd9dd27b71856729\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaries.js\":\"521fc69729470f78\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaryBatch.js\":\"c504e49165d2c374\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/surface.js\":\"245a49b5fbdf04ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threadNavigation.js\":\"a021556553c8ce3d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threads.js\":\"dcfbec849ecf95e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ui.js\":\"32e28ac3e16a9419\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/uiStore.js\":\"d6f7f1606d7612c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/appIntents.js\":\"7f65bbc0e6fe96ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/index.js\":\"10eaf26162d4fada\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/index.js\":\"d9821b6cc235ad0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/status.js\":\"2798272a0cc19cfe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"9c657492b990baf3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaBlockRenderer.js\":\"e2d16224600e82bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaDownLaneReplicator.js\":\"57a2e59ed3a590ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaUploadReconciler.js\":\"c2a89e047788e66e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetDownLane.js\":\"4ada287dcd1a9b3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetResolver.js\":\"c5fad491704ac818\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetUpload.js\":\"da4839111c8f9961\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/attachmentCleanerIO.js\":\"39d56d3a0872fdc2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/supabaseAuditIO.js\":\"9d79f6c95fbcb165\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/blobStore.js\":\"b62364c01876aec7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/browserMedia.js\":\"089db92b0cead517\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/byteStore.js\":\"d6cb73d266d9af6e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanerIO.js\":\"c2e4723d24830951\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanupAttachments.js\":\"2ee9e21e0a6c90da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/dataExtension.js\":\"1833ddb0ba6c677f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/downLane.js\":\"e2b3c6b624853d82\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/index.js\":\"7a96d4df7af273b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/insertImageContribution.js\":\"983c68b77541f6c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneArming.js\":\"c5d6acad9e44506c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneLock.js\":\"9585effad03a231a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaBlock.js\":\"d0414fe223b6ad2c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaCapture.js\":\"aceb8938d49cf71e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaLanes.js\":\"307caa8a5692c4a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewers.js\":\"1a22e6bf5b3e3dad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewersFacet.js\":\"045af75db6a89ccb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/pasteCapture.js\":\"ca95a1e8264aa478\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/resolver.js\":\"612d1d514ba0f304\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/retryUploadsAction.js\":\"5a151a994a695c7b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/storagePaths.js\":\"3390d93c82bea2d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadDrain.js\":\"8f270976e4994fe4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadLaneStatus.js\":\"b8849ea6361c78c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadReconcile.js\":\"81c10d009c371b1e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadRecovery.js\":\"90c80a7fd5c3435b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadStore.js\":\"7c1e8370bbcaf0ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/useAssetObjectUrl.js\":\"3718220eb42b188e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ce80ac3f1cbbe0e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksViewSection.js\":\"413ed8d05e2f8919\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/facet.js\":\"bd44dc85b6b46f3f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/index.js\":\"0c23ed5041a030a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/prop.js\":\"33f609c89668e27d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinkFilters.js\":\"32aa276d2adf8e7f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"197de5ad8b67e272\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BlockEntry.js\":\"973777e614808c21\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/LinkedReferences.js\":\"ce19a2b8b5b170e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"410993f3b2e1a80f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dailyNoteDefaults.js\":\"ffd56156e079fffc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dataExtension.js\":\"926d4c4b90c34619\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/edgeExclusions.js\":\"c052b7abd0529120\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/filterProperty.js\":\"560e981551097bb6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/index.js\":\"33839da7b1165415\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"5036343c13f5a640\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/applies.js\":\"bed00511bc6e89c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/countQuery.js\":\"761420bf2fe4ccb5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/expansionStore.js\":\"3305fed071bd29ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/index.js\":\"e25d6d7358846d63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"be82888ddf07bc45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/presentationInvalidation.js\":\"b9ee805624a3c7c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyEditorOverride.js\":\"29185353a8aa3a15\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyFilter.js\":\"2322bcbb2c83ff99\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/query.js\":\"6f73c5542eee4a62\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/resolveFilter.js\":\"db073f42b45c3874\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sourceBatch.js\":\"1bd2de34c44408d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sources.js\":\"39e0f894865be8ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useBacklinks.js\":\"69b849d0988e27ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"1bd6ba8a865a30c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayCelebration.js\":\"05ca9e3801abfeb5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayOverlay.js\":\"d477f10f1c6df81b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/gate.js\":\"770a7a6729bd7859\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/index.js\":\"5461b41166686ccd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/wolfTheme.js\":\"db6118281ea46b0b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/BlockDragLayer.js\":\"9cd1af9a4c32f731\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dragController.js\":\"5924fab86290366e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dropTarget.js\":\"db5265752c22088e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/index.js\":\"9e613a04e6f3bf53\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/projection.js\":\"6d4c87cac2c861dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/BlockMetaCard.js\":\"87d328e3d5a63807\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/index.js\":\"b05fddf80c00d4e8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/AddTagDialog.js\":\"7aed086e13f5d28c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f915db34d1263504\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/TagNameIssueHint.js\":\"83664e8ae0cdcf42\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/addTagAction.js\":\"961b21b637523394\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/appendTag.js\":\"a03a5e10004508ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/config.js\":\"c17edc06cf95caa6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/dataExtension.js\":\"ae6d9d6bd10afdf7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/index.js\":\"3983a8a8c653fca2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/propertyEditorOverride.js\":\"5d620b0a38c71fda\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbList.js\":\"a5990dd9ff78477a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"8af8ab81cbf68024\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/Breadcrumbs.js\":\"ba8d0f13c7cb1f83\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"eb9cfb6b48eecc32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"16ce471ef81d0fb1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/index.js\":\"69eacc06f6f95323\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"3650d0ac37c76839\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/CharacterCountItem.js\":\"e5585f2ca182c0d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5514f133330e31ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/actions.js\":\"dfe2182664b53e77\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/blockType.js\":\"393acfdc45804733\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/charCount.js\":\"f5195bf77e7b1b45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/dataExtension.js\":\"f629135e3199cd73\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/index.js\":\"ef6cbeac0023419d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/profiles.js\":\"f69c7b0a1f16f07d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/properties.js\":\"f14e11840a9e76b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/subtree.js\":\"e7e6634ca19b5e31\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/textCounts.js\":\"d949a8acac423bfc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/colemak-keybindings/index.js\":\"2e03ac550e22f4f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/CommandPalette.js\":\"4075a19e56ca147a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/HeaderItem.js\":\"15b236176f8a56b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/context.js\":\"b8dd63e473da04bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/index.js\":\"95cb038ecddb2b96\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/selection.js\":\"0350588c095e0599\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/toggleStore.js\":\"7a6580f5b4fc901a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/useCommandPaletteActions.js\":\"e766e36f81697a82\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ContributorBadges.js\":\"2521132a56e59431\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ProfilePicture.js\":\"cc16d8f4d780ab0e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/author.js\":\"f12202376eaf7d76\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/codeMirrorExtensions.js\":\"ac9179519594e183\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/dataExtension.js\":\"d71efd4130859b57\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/index.js\":\"c0fdcbe408227e29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/mentionAutocomplete.js\":\"9d7ab9adf0391674\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/processor.js\":\"4d0891cfe444161d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/profiles.js\":\"09983a34341d9dde\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/queries.js\":\"e8ab3457a9dd1dc6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/schema.js\":\"1b73e72a8d93f92e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/useCommentAuthor.js\":\"3c0ef0dee9691a94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"aac6bd8e54cffc3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/followOrigin.js\":\"3ff126afd4a2099f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/index.js\":\"587a319c3da7a34b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"18d678266b68c533\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"cbe7044b2b3711a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/CalendarGrid.js\":\"ff6c8d849260fe4e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DailyNotePicker.js\":\"4b03975e78697365\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a304e1a3c7b48197\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateNavDecorator.js\":\"32ec6c03a2840bd6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateScrubOverlay.js\":\"75ce891fafef4ac2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayPropertyControl.js\":\"ce0b5c2127a84c03\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayValueReferenceControl.js\":\"6ee5621678f90c25\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/HeaderItem.js\":\"a4172a38e0302cff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/ReschedulePicker.js\":\"91a9ee52e99b6dcc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c48034f804402370\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/actions.js\":\"86cfe6a4ea97c88a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/blockDateAdapter.js\":\"da927967c08c845b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/calendar.js\":\"ee728b7226e6dfc9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dailyNotes.js\":\"e356f97d4c983cd7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dataExtension.js\":\"654c55876accaa04\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubActions.js\":\"89240c848ebf3210\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGesture.js\":\"07c7600359d9a856\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGestureActions.js\":\"76721ed4dd5bc943\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9085b8d3b9f1a55a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayProperty.js\":\"c4a2065b8f0d63ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"b1bfa5096fcd17d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/deletionGuard.js\":\"f70f2f62a8c49a04\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dueQuery.js\":\"039965d215a96818\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/index.js\":\"003204ec9a1532a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/landing.js\":\"ad31740ae6c19f58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/localSchema.js\":\"e55122cfe3492a9b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/referenceDateAdapter.js\":\"26786dba42615332\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/rescheduleAction.js\":\"0e28f9a0ec84fc1b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/schema.js\":\"9b287ed067c93198\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadBlockDates.js\":\"5de13387c057bfe2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadDatesAction.js\":\"1fd199a9b1e43d54\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/today.js\":\"a9eeef7986261c8e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"4fc8290927021084\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"331e9514263bb79b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/audit.js\":\"c9efb185dc245d09\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditAction.js\":\"364b0aa436fe2335\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditRanges.js\":\"333127b5f5fc0f83\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/diagnosticsSource.js\":\"de7d3151b827ae54\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/divergenceScan.js\":\"1e43758bec4585ce\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/index.js\":\"3641e7a9e3f98f21\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/propertyChildrenChecks.js\":\"2a0e09c2d2d2204b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/referencesMirror.js\":\"106b2ac2c518528e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/rowJson.js\":\"995a68c727736d0b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/schedule.js\":\"9cc3861f966b32fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/store.js\":\"1215ad729bb5a068\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/action.js\":\"71a596c31df9f4a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/index.js\":\"7a78e32b43c915f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/plugin.js\":\"a61b756208c3926a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"27c989f416fab962\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/actions.js\":\"ed7ccbc3366d7564\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/changeMarker.js\":\"eb8e6bf791b1a3aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/diagnostics.js\":\"f5a45fb77bf923cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/fileSystemAccess.js\":\"98f7f81fb8aba854\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/filenames.js\":\"008c18e6c78ea310\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/index.js\":\"a7772f7531268edc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/mirror.js\":\"58e9b42ff61b137f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runLock.js\":\"5f6bf22a562f576b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runtimeHealth.js\":\"d5c0204d3461481b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/schedule.js\":\"cfb0d8befe527728\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/store.js\":\"7c5074afcfde692d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/index.js\":\"4fe7c3beb9eb04f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/themes.js\":\"815977aeb3899ffb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/facet.js\":\"cd059350a21caa34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/useDiagnostics.js\":\"0f94463fd3b483a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/dismissals.js\":\"76f4fe81e5d31247\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/index.js\":\"5ba1cebad1ce682a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/status.js\":\"e04cb210e1c26daf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/store.js\":\"2a291825591eb4c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"50e88406978882d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsSettings.js\":\"225a7764e1647072\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/actions.js\":\"6f4aba6d907d7ec4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/config.js\":\"77572c8589c178b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/dataExtension.js\":\"39087e5bc583d96e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/effect.js\":\"aa980991c4788608\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/index.js\":\"2dc4cea5804ace99\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/propertyEditorOverride.js\":\"46188123e07c6603\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/useToggleTree.js\":\"218b34aec8630997\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/ExtractTypeDialog.js\":\"c441e6d1b7628ab3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"23ee44c7ac3d9bf9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/PropertyShapePicker.js\":\"abd7da71e77d8880\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/action.js\":\"5e1841ac2405a5bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/index.js\":\"4552ec6dfa77ac22\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/FindReplaceDialog.js\":\"f0e2d16b6fe743cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/HeaderItem.js\":\"cab5c53ef6e65b35\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/dataExtension.js\":\"af6cb87bae3dc34e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/index.js\":\"6a59afc113e777a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/search.js\":\"60ec657eb7c1e5f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/toggleStore.js\":\"3e261f0b44670001\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/LocationPropertyEditor.js\":\"2717bb253459d236\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/MapView.js\":\"aee290cb1ede88da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/blockTypes.js\":\"e6eade96843b4f6f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/codeMirrorExtensions.js\":\"fae16e971f4645c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/createOrFindPlace.js\":\"dd796d3d4f6e3764\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/currentLocation.js\":\"66cc7e8ca1ef6be2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/dataExtension.js\":\"fdbc81b0d63382b1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/geoContentDecorator.js\":\"c244e33942a5436a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/googlePlacesClient.js\":\"5bf3fe250d3c4eda\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/index.js\":\"688bb316e9d13633\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/locationsPage.js\":\"65f6829f7b83807b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/mapViewport.js\":\"23b6189e40d0fc7a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/pickCurrentLocation.js\":\"852e7b27cd927979\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeAutocomplete.js\":\"4a3a2a7f3143fc0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeNameCollision.js\":\"b892861ec1d252b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/properties.js\":\"4565410e4fc387df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/propertyEditorOverrides.js\":\"259c9ad347491ef6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/query.js\":\"9ea8fae01b707add\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/usePlaceSearch.js\":\"6780d31938bbb8b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"442e9d3cd46ce615\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"22b1b73f2b9cb19b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9ec775eefacbde28\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/config.js\":\"9a1ed0e23bff1865\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/dataExtension.js\":\"57bcffe2ccd47d25\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/facet.js\":\"b9ad82ada60d94a3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/grouping.js\":\"4f95fd9e6334ef33\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/index.js\":\"f43445ee4323deec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"888feacbf48ce25f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/query.js\":\"39dc62f121df23c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/resolveConfig.js\":\"d23a079599f7aced\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"2419a6a78cd39718\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"9fa66f68903c102e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlDocumentContent.js\":\"b3d702a4f4f81037\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlFrame.js\":\"fbd6b7560d627b7a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/actions.js\":\"c3f07a53e00b3d94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/blockType.js\":\"62a8cfe1d168c88c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/confirmRunScripts.js\":\"969e1a200687d8d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/dataExtension.js\":\"65682c6b28b62766\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameAnnotations.js\":\"bcaacfc5f1264bac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameDocument.js\":\"96f5a562e82c6807\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameTheme.js\":\"9c2a4fd184758a22\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/index.js\":\"295532c907a38031\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/scriptConsent.js\":\"bd558d2a59c28ca5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/sourceMap.js\":\"16c26245b0218d4c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/useDocumentScripts.js\":\"85df7f3ea66958db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/index.js\":\"5bdbf182aaf949e8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/record.js\":\"b266dd51ea766366\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/recordStore.js\":\"290fa116f02715d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/responsiveness.js\":\"2c56c075a0048473\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/schedule.js\":\"adbc4876930bfa56\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/sessionContext.js\":\"2bd978d71798be5a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e813fa7e46ab27b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"211475901630eba5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/actions.js\":\"77a80b4a3f77169f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/config.js\":\"656034667b9ccc80\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/dataExtension.js\":\"883bc0db96c96f7e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/effect.js\":\"d740f344a6b93c5b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/index.js\":\"ebb952bb9563fab8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/keyCapture.js\":\"d332b8f7919b8e52\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/overrideStore.js\":\"c868c53894c32c42\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c3ea4084e9c99d31\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/HeaderItem.js\":\"b24095507eb0b08c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/LeftSidebar.js\":\"3f93bf94b2a02fa7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/actions.js\":\"7906e8b9fe507cb1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/facet.js\":\"f02ea24d20df7359\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/index.js\":\"0c2a9d44a1916c68\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/shortcuts.js\":\"56d54b81a01236a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/toggleStore.js\":\"72d274e447a1e9ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/MergePicker.js\":\"ae4b595aa4eedc58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/index.js\":\"a6499c05ac8bce9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/mergeAction.js\":\"796016c11b919d75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/strategy.js\":\"5987b3c43563b791\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/Button.js\":\"ab93f9abd3200908\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5fd18b220fb52a3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/defaultItems.js\":\"68e65e5dc4097759\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/facet.js\":\"1d7a6d482efc18c7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/index.js\":\"7d47db22dc95d83a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"6448abe485da5fcb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/actions.js\":\"3f60688593fdc4a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"c81fe8f13d51cf86\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ab9bd3db2f9d79fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/index.js\":\"674607b0510d20fb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/MoveDestinationPicker.js\":\"faef03934dad5ba4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ba3a7e28d7085227\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/contextMenuItem.js\":\"c242085d80371fa5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/index.js\":\"ee376c1796c82e54\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveAction.js\":\"7d59340938d1b37c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveBlocks.js\":\"d0781a54d4cb9944\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/selectionAfterMove.js\":\"724c6dfdce9bcac9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/TutorialBanner.js\":\"7101731efaaf39d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/action.js\":\"2fab5a5477a891de\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/bannerDismissal.js\":\"3b02e6a67ee60489\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/documents/cheatSheet.js\":\"ba8b3a6432177714\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/index.js\":\"2b990957b0285ce3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/keys.js\":\"467111a95d4ef5ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/landing.js\":\"60a482896a4b230c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/outline.js\":\"40644ac85bf986cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/seed.js\":\"75bcc90262e5471c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/PerfTrendDialog.js\":\"6a283b6602ec0c58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/analyze.js\":\"1f361483bf20820a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/diagnosticsSource.js\":\"3bc1fbbc2c727db8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/index.js\":\"4b02319c3628e7e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/load.js\":\"111746f96740851c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/monitorRun.js\":\"3fbfa56e6e7860f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/schedule.js\":\"fc691ae0a525c518\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/series.js\":\"4bee1392aae0786d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/store.js\":\"66c24b88ac0046b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/trendAction.js\":\"ace04d55eed17fbc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/verdict.js\":\"674786d162726911\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/clickToEditAction.js\":\"7866d79d8035277f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/index.js\":\"da03008eb84e5186\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/interactions.js\":\"b12e6680494dd61e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8b6dc2572fd31982\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGate.js\":\"e80799abd2d1a74c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGateDialog.js\":\"e6a9ddd9e8cc685a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/action.js\":\"f97f1d9e838a67af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/index.js\":\"f3e2a84824e9e3e0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/localRunMessage.js\":\"1bf421c55f5a1d02\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/plugin.js\":\"ef2b457399cbb55e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/progressReport.js\":\"d864220f024fe8d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/sweepProgress.js\":\"629422d2f3cde359\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/FieldRowRenderer.js\":\"ca981d1892c3ed0b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/ValueRowRenderer.js\":\"0e88a7732a651368\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/actions.js\":\"6bcd06a5ae9f153f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/autocomplete.js\":\"2b44859ef02d6a72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/fieldRow.js\":\"395ffee2bb57b07f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/index.js\":\"560e5beebebed1d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/referenceWarning.js\":\"44176795b025c445\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueAutocomplete.js\":\"06c5323ad3d7fd73\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueSchema.js\":\"4f99b991771b1983\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/HeaderItem.js\":\"c16a81aea647d111\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/QuickFind.js\":\"f4d7bfef74e45cd9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/index.js\":\"6f71569f878688a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/recents.js\":\"da2a4c36582470e3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/resultItems.js\":\"5099f0c3b7df1ac3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/selection.js\":\"abc79a67ad689cb9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/toggleStore.js\":\"e8959c754840a533\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/HeaderItem.js\":\"69da4b73ce71f047\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/RecentsPageBlockRenderer.js\":\"bd9678889fe8c377\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/grouping.js\":\"6f0dec4f53437144\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/index.js\":\"d807d69f645768aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/target.js\":\"f1eebe53eab7abad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/codeMirrorExtensions.js\":\"dc18943e769cf385\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/contentPrefill.js\":\"519faafa25a35e8b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/dataExtension.js\":\"24c280bb17048bd2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/index.js\":\"961bcfedac67dc73\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a593087b2634f6f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/invalidation.js\":\"9381782352f43778\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/localSchema.js\":\"e0b09414672bc3dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/index.js\":\"19857da7063ced0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2ecd62ca2cfbdae8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/index.js\":\"cdceba25fba5806b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/referenceNode.js\":\"ae6ac3f4300ec8ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/remark-reference-occurrences.js\":\"98f8aa665d25bb76\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"cae11fd5687d04a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/index.js\":\"0e019efd796531a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"4e0c85e7ca223635\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"e0754c13c0a232a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/mergeRetargetProcessor.js\":\"eafa92d44ea84054\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/parseFence.js\":\"3765d31e94405c65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceParser.js\":\"3ecaa62199a1398e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceProjection.js\":\"2e842f13fa9d89df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referencesProcessor.js\":\"e5f9e038cd2b4dac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/renameProcessor.js\":\"3cbe58a9bdb5be30\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/spanReplacement.js\":\"e6c68745ef634c3d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/htmlToOutline.js\":\"95bd344ed8c39e78\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/index.js\":\"f7363b4ed7f9b267\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/normalizeClipboardDom.js\":\"0e8cb69e5f0a8144\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/pasteDecision.js\":\"51cd10d2ea6f8b67\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/action.js\":\"3945267e2f141aab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/blockIds.js\":\"6ea40eaba9eddde2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/content.js\":\"514ff48d5f650211\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/effect.js\":\"c5c60a875501d1d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/ids.js\":\"303b8e22e5f61ad2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/import.js\":\"c1b26ff3d73db873\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/index.js\":\"96862636ef3e08ce\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plan.js\":\"a530f6a4facd5de5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plugin.js\":\"c81db2ba2ab8bbd0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/promotion.js\":\"917c1c983d11845e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/properties.js\":\"bc0a6b67c8449dee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/references.js\":\"ccbdd9f96c0a4850\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/report.js\":\"71ed512f72e11ba9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/roamMemo.js\":\"9e758e9ef18b08a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/runtime.js\":\"8f34cadff4f11c5c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/schemaReconciliation.js\":\"87dff351298457ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/srsMarkers.js\":\"be9320c104bd4561\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/todo.js\":\"4286a27eb394f462\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/typeCandidates.js\":\"292624d881761e33\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/types.js\":\"92501767a1c38eb2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/index.js\":\"8e6ff1aa38bc8d3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/store.js\":\"30951863194c6cea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/HeaderItem.js\":\"87fbeb54ed5286fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"78619fa16da2da22\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/index.js\":\"3aebdfc6206d055c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/model.js\":\"017908b5410dbd7d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/toggleStore.js\":\"cb72fb7254a0a1c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/useKeyInspector.js\":\"76bc7eb3562ea533\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"985041a613623a0b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/ShellDecorator.js\":\"c8dc31340287368c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/actions.js\":\"741c5240a598077b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e411db97b15ec0ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/index.js\":\"6f8fcd40725ff67a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/shell.js\":\"7d6f5f8fe4a24957\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/surface.js\":\"a537b97e742d9e3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/walker.js\":\"02e7e0136ccab967\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/RescheduleToast.js\":\"3136774e8de73bfc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/dataExtension.js\":\"7090d67eadc923f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/index.js\":\"130fe1f8ee1a8918\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/indicator.js\":\"a68cc7ae8709c578\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/moveSrsState.js\":\"b38bff901175461b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"3cae8243e26eb6f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/scheduler.js\":\"9529e133c23dd039\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/schema.js\":\"c4ea9be450a0e266\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"08fb7dbb61bdd1bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsClipboard.js\":\"d16dea43abfc8cc9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"61bf1f0202cf040f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DailyNoteReviewHint.js\":\"15c19fe885312544\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DeckPicker.js\":\"d05196710d03881f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewControls.js\":\"5b7ad3894046561e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewDeckRenderer.js\":\"c425478ddce90169\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewSession.js\":\"d7de1e9d4be66152\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/actions.js\":\"d9c392b0891ddf36\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/archive.js\":\"2ff9f713c14a19bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dataExtension.js\":\"1ef7eff74ebe0ab5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/deck.js\":\"04ab50fdd0164ea4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dueQuery.js\":\"602263186cd40e89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/gradeDecision.js\":\"0a82780b0e440e5f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/index.js\":\"a3ecc515172efe8c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/keyHints.js\":\"ecbed1efb807cb4e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewCardLayout.js\":\"ae68041646195c8e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewProgress.js\":\"9d8f7fb349b3144a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/schema.js\":\"e554b1922bf90684\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/useDueCards.js\":\"21092294ddf9ddad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/index.js\":\"107c5f177ca4170e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/record.js\":\"c4173adb4c39a34e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/index.js\":\"ae31a0eafd0f23aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/persistenceStatus.js\":\"369468d4324fb41b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/requestAction.js\":\"ec99719a0b9b023b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/TypeChipsDecorator.js\":\"13b9466e7e75c626\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/codeMirrorExtensions.js\":\"cb029669bf215703\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/index.js\":\"222947b8748bb155\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/typeAutocomplete.js\":\"2617f91df4000556\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ab055bfba58cffd3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/actions.js\":\"262a41c07a43bead\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/anchor.js\":\"481f64fc8d450cf5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/events.js\":\"b7aafd7d638e8e38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/gestureActions.js\":\"7097124932196f5c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/index.js\":\"ba5c597b5e43b0ce\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"42d66a279da42ef5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/collect.js\":\"37930cf7401e7197\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/index.js\":\"0426aa3773f9425e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/record.js\":\"0f30aae96e7244c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/RejectionDialog.js\":\"cb47da59206f6728\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b88f7dc111c022a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/index.js\":\"a54cc36332fe9c69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/model.js\":\"7074c24daf9d86ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/queueCounts.js\":\"695f17e83dd575cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rejectedHelpers.js\":\"664058b069d9436a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rematerializeAction.js\":\"e3061ddd267f989c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/useHysteresis.js\":\"5f220cc2825a8493\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/ColumnHeaders.js\":\"7c10cdf161481e86\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/QueryUi.js\":\"962df74b447d9594\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/TableLayout.js\":\"6f013ae7694c217b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/actions.js\":\"24f60b7a77aecd69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/cellEdits.js\":\"fc040badacddd82e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/childrenViews.js\":\"34451a0ef82ef390\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/columns.js\":\"56fa01e109c2f053\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/controller.js\":\"a57644c0ba00b84f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/convert.js\":\"2bd68658d86f6418\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/dataExtension.js\":\"70258f9fc7444a5d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/index.js\":\"c72cd8a0f58c8995\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/keys.js\":\"eef70f0b8abbc269\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/model.js\":\"0e6c2d8382ab72b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/QueryText.js\":\"7c5a4c0de8140b9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/backfill.js\":\"e393cde6a9105022\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/completion.js\":\"9bccccd46cec23b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/format.js\":\"2a5e7f060409a43f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/parse.js\":\"d080050a9362e7f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/queryValue.js\":\"1c68e9c3c4ef96b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/registrations.js\":\"8116c9279c07eb15\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/source.js\":\"ae3da2392f50509d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/registry.js\":\"f2196a2c9480a869\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowGutter.js\":\"02a6305ea5feb565\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowVerbs.js\":\"5b0b91656bc2dd4c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/schema.js\":\"23e2522d5f0e4fc8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/sort.js\":\"322354b87e31359d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/effect.js\":\"6e500331c130ada7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/index.js\":\"14e0eb84061ad8e4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/theme.js\":\"43982478e00054ad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/actions.js\":\"86b235d08a80fb91\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/dataExtension.js\":\"43cdd02f90bb9891\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/index.js\":\"b3011906026cca20\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/schema.js\":\"f81c2215e310c5d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/TouchSelectionLayer.js\":\"97d0c5e5a93be5db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/actions.js\":\"6c15e52f24aa3a0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/defaultItems.js\":\"a7839c0e8336ba97\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/facet.js\":\"0ca49f74d0801691\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/holdRecognizer.js\":\"f0a0fd1420869f3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/index.js\":\"72c0a02261759d7d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/UpdateIndicator.js\":\"1362ca6d3128344b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/index.js\":\"d3a0d2a804cf4f0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/loadTimes.js\":\"aa5f56f08869d8ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoNotesRenderer.js\":\"449907933660b981\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoPlayerRenderer.js\":\"79683b5724356ad2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoTimeStamp.js\":\"c0a79114d2a92127\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/actions.js\":\"d9421fb183c1cc45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/index.js\":\"23c3fb1c4260e6c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/markdown.js\":\"edcc2513f555baa8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/notes.js\":\"a0f3cdda4c98958f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/registry.js\":\"792907c30c0a3418\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/remark-timestamps.js\":\"e2c10938d362951a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/view.js\":\"cda5220b0a7f72e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/LinkHints.js\":\"3a4d95ec355b77e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/index.js\":\"832612f595e94bcd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/model.js\":\"e58f6af95513b260\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/settings.js\":\"7b01f00dfafff830\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/actions.js\":\"a070ede6b89f1304\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/index.js\":\"3140d894abc1ed7d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/interactions.js\":\"1155978a887fcade\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/workspace-header/index.js\":\"4435b1f77f903c97\",\"/knowledge-medium/pr-preview/pr-1899/src/registerServiceWorker.js\":\"b4a81aa0d70b7eb1\",\"/knowledge-medium/pr-preview/pr-1899/src/requestPersistentStorage.js\":\"0ba956100bb6aead\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authRequestDeadline.js\":\"f11f9b025d7f6703\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authStorage.js\":\"09cda2e630ee4ec0\",\"/knowledge-medium/pr-preview/pr-1899/src/services/powersync.js\":\"e216c52e390c12bc\",\"/knowledge-medium/pr-preview/pr-1899/src/services/supabase.js\":\"f5ad76a4cf4356dd\",\"/knowledge-medium/pr-preview/pr-1899/src/services/uploadErrorClassifier.js\":\"542377a3b74ba2d3\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/ActiveContexts.js\":\"28d9ca5cdc2b33f7\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/HotkeyReconciler.js\":\"8b469bbcf441c02f\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/WipeLocalDataDialog.js\":\"5dfac07383bc8369\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionDispatch.js\":\"922502e188f24132\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionRefItems.js\":\"a41275c6282d80d5\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/applyKeybindingOverrides.js\":\"cec512619f03e0b8\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockActions.js\":\"3f1dc0e82e8ef1d9\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockMergeGesture.js\":\"53442b8babe08f93\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/canonicalizeChord.js\":\"901c26bb12b7374a\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultContexts.js\":\"d60f5e79944231fa\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultShortcuts.js\":\"3136eb9ae854a956\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/effectiveActions.js\":\"4641d8e055f4b7c8\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureAction.js\":\"7527fd54a3fb2039\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureBinding.js\":\"84f6f748676a9d3d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/holdRegistry.js\":\"ba58d878ab04a29b\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingConflicts.js\":\"e0826db1297b0960\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingOverrides.js\":\"d5e4185794f3bc53\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/pointerAction.js\":\"9625323ac2a7a33d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/resolve.js\":\"5afac7863fb4043f\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/runAction.js\":\"da192d2567177d10\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/sequenceMatcher.js\":\"0af80e8d2631e08d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/types.js\":\"afcc9bdd3b296990\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionContext.js\":\"e1596b86f1df2dea\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionDiscovery.js\":\"778fbd68b34ab5f8\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/utils.js\":\"75c78830a8dbf6aa\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/bootStore.js\":\"95d5adc61bc75d2d\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/previewDatabases.js\":\"8ee78dc2ec79f799\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/byteTransform.js\":\"dc4030a65e41871e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/attachmentCleaner.js\":\"251ba0f546d1d078\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/attachmentParts.js\":\"8a46a11e1b87b939\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleParts.js\":\"4832554ee52ff0bb\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleRecord.js\":\"a1a29c0f8dcd5b8b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/manifest.js\":\"d6a3d5ba8e796dc3\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/takeBundle.js\":\"af8b88a032cbd12e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/verifyBundle.js\":\"0596ad4c6eeef26d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/cleaningStage.js\":\"b55dacbe81e1f286\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionKey.js\":\"d3d4cc64fb15b327\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionServer.js\":\"1990aac52c61959b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flip.js\":\"7dc74a753db724c3\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flipAttempts.js\":\"372ba563e53d81f0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/pages.js\":\"7fc01c65054c2d22\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/preflight.js\":\"6586e17fd3c39363\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/reseal.js\":\"8d3537ac3463c087\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runConversion.js\":\"94f25dac6c91dc35\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runLock.js\":\"57e3c3d0536cb6be\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealing.js\":\"b12ef5ffb27a12c2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealingStage.js\":\"8ee594654eeadce9\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/stage.js\":\"c07c9b3f75932db6\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/verifyReseal.js\":\"e5c9afd0b0a2c8f3\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aad.js\":\"9a54005e9898e9cc\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aead.js\":\"9d6d552f9869e6a0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base32.js\":\"b7710df4a343f236\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base64url.js\":\"9d8eb9c9d5c1171e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/binaryEnvelope.js\":\"45aedf0bc7625aba\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/byteAead.js\":\"79618893378252b0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/canary.js\":\"0c35b016600b3e50\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentHash.js\":\"523bd58bd9a1af63\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentKey.js\":\"7d63819732f23d90\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/derivedIdNamespace.js\":\"bd96b61e86d35f3b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/envelope.js\":\"503f7813b6061249\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/hex.js\":\"1e233cfdd62862c6\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/sha256Hex.js\":\"423f7931ad73f366\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/workspaceKey.js\":\"82a66041bdedb1df\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/conversionState.js\":\"f040cb9ed60e8f2c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/createEncryptedWorkspace.js\":\"d880839888983986\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/pastedKey.js\":\"c4ce6651e49160d1\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"3668ed864d35b96f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/upgradeWorkspacePin.js\":\"15e6a222a0801f43\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/keyStore.js\":\"d181ffacade97e1f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/mintWorkspaceKey.js\":\"603821ab60277f98\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/modePin.js\":\"37ef709bdec58794\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/openWorkspaceKeys.js\":\"277622263958585e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolveWorkspaceEntry.js\":\"b6da6dcb976809a0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolver.js\":\"9db2d911031c2e2d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/workspaceAccess.js\":\"edcd2152d2735311\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/transform.js\":\"8a57c4948b780809\",\"/knowledge-medium/pr-preview/pr-1899/src/themeBootDefaults.js\":\"0701dcef993f4c65\",\"/knowledge-medium/pr-preview/pr-1899/src/types.js\":\"af13d898458b993b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/ClientLocalSettings.js\":\"d40b306b654e0de6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/abortableSleep.js\":\"b2a3d186b4ddbc8e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/array.js\":\"c7d9e62d56fc08ac\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/backlinkAutocomplete.js\":\"6f82d00fd8956f2f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockCrumbs.js\":\"037945ed4ee6d59c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockrefAutocomplete.js\":\"e71940d650c22f47\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/cadencedIdleJob.js\":\"8acdb08f659c4d68\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/callbackSet.js\":\"0c09345456c011bc\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/clientId.js\":\"368d23b33dd772c4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirror.js\":\"890f6867ed6f86df\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirrorCompletion.js\":\"8b1a48afd771d903\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/copy.js\":\"3072a4470bde96be\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dailyPage.js\":\"ca5fcefc246d5ef0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensics.js\":\"6e56b64dc7c62c3a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensicsHooks.js\":\"2ec41bcf7ee7202a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/deleteBlockThroughUi.js\":\"85569c8316681b3d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dialogs.js\":\"362a1916664e3f6c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dom.js\":\"58325f535ffe3702\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/downloadBlob.js\":\"419838cfbb3054a5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/drawnWalk.js\":\"69a57cd1a6cce939\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/exportSqliteDb.js\":\"d044c111e6af2edb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fileSystemAccess.js\":\"40931ccf218baa75\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/flipSlide.js\":\"be7779f925b30328\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fnv1a.js\":\"9eb7dcb5bca287e9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/formatBytes.js\":\"d7910034eb3db731\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fuzzyRank.js\":\"6a1fcb68e7ba8772\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idbKeyedStore.js\":\"907170f7a7cc7742\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idleCallbackPolyfill.js\":\"a0549b357b14830d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardAwareScroll.js\":\"25432acfd8b414c6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardViewport.js\":\"02ed1ba4f4326aaf\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/lastWorkspace.js\":\"0eefc6925a439207\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutColumns.js\":\"06c0e841e4c26c8f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionDom.js\":\"a0218c0d5d242973\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionId.js\":\"c84aaca58f6dc369\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkClickGestures.js\":\"e587b5e1b2c8cfe9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkTargetAutocomplete.js\":\"91f89a30c0994ee6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbCorruption.js\":\"10958b121f8fe202\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbRecovery.js\":\"75b0a8f8a8e97ca2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/markdownParser.js\":\"8a4fa40aa62488cc\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/memoize.js\":\"a3c1bbf3b1c360b8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameFieldCommit.js\":\"478b1198a0c642e8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameList.js\":\"f24223a5a73dea0c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/navigation.js\":\"6a45a650a95fddd0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/omnilinerNamespace.js\":\"29f338b7e1a9287e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/opfsPageScan.js\":\"7003b204ef25373b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelClearance.js\":\"620ccab56bff2a2d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelHistory.js\":\"d0bfe2e6019d7777\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLanes.js\":\"002a9c66413bf74b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLayoutProjection.js\":\"a83eeffe3289dc3a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelScrollAnchor.js\":\"38ff363bd717c870\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelUrlFlags.js\":\"f6632771b546ebe8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/platform.js\":\"1d12e3191f22df6f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/pluralize.js\":\"a3b1392b90d9d123\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyCreation.js\":\"d2e6a5c997a71bf0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyNavigation.js\":\"a5b135e615ed5283\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyValueContext.js\":\"5549ce35a6907689\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/react.js\":\"ca34197322215933\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeDate.js\":\"f52a76481e97263c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeTime.js\":\"4c072cf24ec8256d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/renderScope.js\":\"3b6e1ec3a21ed9ac\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/resolvedThenable.js\":\"23a438982003eb0c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/routing.js\":\"0491482899fa43ef\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/safeMode.js\":\"6911219266f26ed0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/scheduleIdle.js\":\"0e3f4ee08a283b20\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/screenWakeLock.js\":\"998c05d351633516\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/selection.js\":\"91b5f31565c8009f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/softKeyboardGrab.js\":\"84bfdd0258d62a02\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/startupTimeline.js\":\"746a1152cbf1555c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/state.js\":\"18d74f6ae7f44cb5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/string.js\":\"167800c41d12e9aa\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/surfaceZoom.js\":\"81a6306718df3722\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/time.js\":\"6666469f1dcff75e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toast.js\":\"ce6c90be3c1fd7b9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toggleStore.js\":\"a17755729ec696a4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/untilStopped.js\":\"054c87508158d550\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/userActivity.js\":\"8d3a254bd1c6aaae\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewTransition.js\":\"8d2e3a19a0453d72\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewport.js\":\"c6c76ec710fc92b7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/webLock.js\":\"c82ccb7a67085537\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceRecovery.js\":\"b701cf0bd3891464\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceSnapshotStore.js\":\"0ba203ea270076cc\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-compiler-runtime.js\":\"76c446c59b2cfb3e\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-client.js\":\"cb5d492be5204952\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server-edge.js\":\"7d613cc1f62742cf\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server.js\":\"6602dca661328a21\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static-edge.js\":\"ac58bfed311ddc05\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static.js\":\"62f3296fd414f76f\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-test-utils.js\":\"c9850c855e9322be\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom.js\":\"b50b73cdd284a94e\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-runtime.js\":\"ab3ea5a8c27108be\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react.js\":\"52ee481625b6bb85\",\"/knowledge-medium/pr-preview/pr-1899/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
