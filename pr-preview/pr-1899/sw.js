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
		buildId: "624c358c6af9-e3253646",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/\":\"5d3096036edac59b\",\"/knowledge-medium/pr-preview/pr-1899/index.html\":\"5d3096036edac59b\",\"/knowledge-medium/pr-preview/pr-1899/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1899/assets/FacadeVFS-B9jLqfab.js\":\"763eb4093bd8fee9\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSCoopSyncVFS-DtwLKy83.js\":\"f73515a3f3333054\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSWriteAheadVFS-BONy0fP0.js\":\"887ab736a6c34c93\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-DLFUAwdX.js\":\"a0e59f29cbc87ea2\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-BshiGTRj.js\":\"4e27ce816562316b\",\"/knowledge-medium/pr-preview/pr-1899/assets/worker-Bk7aBePL.js\":\"d82d7b0a70bac9ec\",\"/knowledge-medium/pr-preview/pr-1899/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1899/chunks/app-Cp5fxwij.js\":\"837e59654de738e0\",\"/knowledge-medium/pr-preview/pr-1899/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1899/index.js\":\"16f13e5b7bee9d39\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1899/assets/AccessHandlePoolVFS-CyBIsY5o.js\":\"0af4b2b63384cece\",\"/knowledge-medium/pr-preview/pr-1899/assets/IDBBatchAtomicVFS-qTpzDvaH.js\":\"d09c029ddd907795\",\"/knowledge-medium/pr-preview/pr-1899/assets/MemoryVFS-Cbqj_-X1.js\":\"db2fee2b41dfcb76\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cof1KQIi.js\":\"e3aa4671dc972e48\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-C6Nt3FpC.js\":\"ad2ce872698709cb\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1899/chunks/AccessHandlePoolVFS-C7LxYH9U.js\":\"096dfa5b483c7575\",\"/knowledge-medium/pr-preview/pr-1899/chunks/FacadeVFS-CJrlu15Y.js\":\"65f683e77269819d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/IDBBatchAtomicVFS-wzKYWlj5.js\":\"b6cf7dc179f472ce\",\"/knowledge-medium/pr-preview/pr-1899/chunks/MemoryVFS-B5IelZvS.js\":\"98651cedd89859a5\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSCoopSyncVFS-DHQ5OVhj.js\":\"27ed4dd17fde158e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSWriteAheadVFS-B1tk5AoU.js\":\"81ae71544f0c9d4e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/Preview-DoXKnsKz.js\":\"64edf335e3084d3f\",\"/knowledge-medium/pr-preview/pr-1899/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/card-u-LMUCBe.js\":\"62a976b08ed976cc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BOwpsnSW.js\":\"4258923e222c5d9e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-KOTd-Jz-.js\":\"830f130835e933c7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-async-DXpyFyuH.js\":\"07d730191d5534b9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-BeZboaqD.js\":\"fa3b3dcb71c7c5f6\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-C-OnekIe.js\":\"06733d9f0fd458b1\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-C91xmTvN.js\":\"3452666aa12de07a\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-CXdzCFBl.js\":\"496de9739bb415f9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-D0x-I7AS.js\":\"1207f36cf343a272\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DfgabVKm.js\":\"194d334ac503c40d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DmEeEyLW.js\":\"08a62b7461ecc0b4\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DptI2ib-.js\":\"eb75c9938fddf26e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server-legacy.browser.production-YtOf1gZt.js\":\"38835f8beff030c2\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.browser.production-laBFyc2g.js\":\"08242396468b704e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.edge.production-CerBw96e.js\":\"28db154c04a052bc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/server.browser-BdC-FnZP.js\":\"70a17aa7b5954f2a\",\"/knowledge-medium/pr-preview/pr-1899/chunks/textarea-CX8BVPRo.js\":\"f7666f96613b9238\",\"/knowledge-medium/pr-preview/pr-1899/chunks/ui-oRRhG7Lj.js\":\"62f4eabdd00deefb\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-async-KolfQSRg.js\":\"1536c52324bb822c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-jj9ouo2A.js\":\"026bb57fad7ed299\",\"/knowledge-medium/pr-preview/pr-1899/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1899/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/src/App.js\":\"39c15e9dd0d86dbd\",\"/knowledge-medium/pr-preview/pr-1899/src/appUpdate.js\":\"e68fcab66fbde071\",\"/knowledge-medium/pr-preview/pr-1899/src/appVersion.js\":\"9ee0ee48686fee29\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/initialLayout.js\":\"e9744d0ede7795c6\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/openWorkspaceData.js\":\"a982aef6e2594c69\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/resolveWorkspace.js\":\"3affaa1a84e63e35\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/workspaceBootstrap.js\":\"8667024e7f6ac6d3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockComponent.js\":\"b3b00d278ab9732c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockCrumbs.js\":\"83f0082982a4075b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockEditor.js\":\"3093abc16b83054d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockLoadingPlaceholder.js\":\"a299c4ea74899cff\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockProperties.js\":\"861289671c176d2c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockSearchPicker.js\":\"c679d9c7235c6154\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ConfirmBulkDeleteDialog.js\":\"f5434a01dd57ad53\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DividerHandle.js\":\"46fe6111c51e6c26\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DraftEditor.js\":\"69e14419e52dc84e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/GutterPill.js\":\"e0dfe10b118eba44\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Header.js\":\"462dd46ed7fa9ff5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/LazyBlockComponent.js\":\"8104020395784d21\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Login.js\":\"4911a561c0897e50\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ZoomableSurface.js\":\"478607c1494ebb75\",\"/knowledge-medium/pr-preview/pr-1899/src/components/editModeKeepalive.js\":\"e0bd8743bb61df5e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9455366124d66059\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"7b7d4bebe96cae05\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefPropertyEditor.js\":\"baeb7654d4b5a56f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefTargetTypePicker.js\":\"46fc2c64b06ce51b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/SelectPropertyEditor.js\":\"a0fd490be032f893\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/TypesPropertyEditor.js\":\"9ccf0c843659e909\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/defaults.js\":\"17cf5e082d700fcf\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/kernelValuePresets.js\":\"4eec897a172c2be0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/selectablePresets.js\":\"fd315c7c88d315ca\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/typesPropertyUi.js\":\"291040cd82f9fff8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/AddPropertyForm.js\":\"fd78afde1ac465cd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyPicker.js\":\"d90bc00368c073c5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyRow.js\":\"c08a2e7e9646352e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/Rows.js\":\"e1be19849238d03e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/actions.js\":\"c953b014c77870ae\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/declarationOnly.js\":\"f346aa11d35cc903\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/layout.js\":\"32c0eae1ca9f2652\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/model.js\":\"d3ba982652d0abc7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapeUi.js\":\"165cc1e13e834306\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapes.js\":\"ae6085d3ef989c4d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/usePropertyEditingActivation.js\":\"5502169356062445\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/visibility.js\":\"087a1859eaf8b351\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanelSections.js\":\"d104f062224c6da8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockEmbed.js\":\"0e8b08beafc4ee3b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockLink.js\":\"d1e7e24496205306\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockRef.js\":\"7a17ae4bad90c609\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/CompactReferenceLink.js\":\"33bdc95abed6e412\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/ReferenceLink.js\":\"cc570b288804d144\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuard.js\":\"0f5d50e510ebe4e2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuardContext.js\":\"1e8e419bf9cecaa4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/linkInteraction.js\":\"1929ded27510dab3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/referenceLayout.js\":\"524a34a8c5cb40a1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/useBlockRefAncestors.js\":\"38903b948f3250fd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockGutter.js\":\"9801216dc62e66d1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockInfoDialog.js\":\"c91ecf4f79c0aba3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockReadText.js\":\"06503cb9be958ed2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockTypeBlockRenderer.js\":\"43d1f511607ca7f8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BulletHoverCard.js\":\"6dea211f87de9c89\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorContentRenderer.js\":\"89c193d540759700\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5d56d4981984befe\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ColumnResizeHandles.js\":\"371c1d7a0cdbdfc5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"4a253d7620842189\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/DefaultBlockRenderer.js\":\"bf222827cf0cb102\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/LayoutRenderer.js\":\"3357d5dcc1f8db8c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MarkdownContentRenderer.js\":\"3da514dd84c06c9b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MissingDataRenderer.js\":\"0ce1a4d632bc9d7e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PanelRenderer.js\":\"3bfca0938879ea38\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b14d32f4629c4d4a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/TopLevelRenderer.js\":\"a5b760bd23a18d01\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockGutterMode.js\":\"36ad7b3e14c5a88a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockTitleText.js\":\"9131877d817558ed\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/fieldCreationKeydown.js\":\"53343a4434da6809\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/layoutRootContext.js\":\"759df8058e4f4b89\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/TypeChip.js\":\"83cf50ac202c9452\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/chipStyle.js\":\"17ee03b531606f43\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/anchored-floating.js\":\"419860bbdab8b0a2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/button.js\":\"daf51b50fdfddde7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/card.js\":\"735d417d6cac3895\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/checkbox.js\":\"22f19d85a44d46f0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/collapsible.js\":\"5d2ac700928d30d0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/command.js\":\"1a906863884268f4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/context-menu.js\":\"7833e7403eeadf9c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dialog.js\":\"2900971eacd46e8b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dropdown-menu.js\":\"28a011d52445f763\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/floating-listbox.js\":\"6036636a7f20a4d9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/index.js\":\"e3f76f440113b69f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/input.js\":\"f414e4674e971180\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/kbd.js\":\"5cf196e2c6c92d77\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/label.js\":\"ed85670e61ca0c10\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/textarea.js\":\"5b9501d872489c0d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/useEditModeYieldKeepalive.js\":\"c0344cf369272a6a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/BootFallback.js\":\"17abf2e94fc7db82\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/FocusedRowLazyMount.js\":\"03739cfc3a221621\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LazyViewportMount.js\":\"96a6177c714ff9d7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LocalDbCorruptionFallback.js\":\"49e21d2035a5aa18\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/error.js\":\"b43219f513db5843\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/lazyMountRegistry.js\":\"5ba222c88b69110e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/suspense.js\":\"5fb62b5281cd8bd8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/CreateWorkspaceDialog.js\":\"33c24d14857f132a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/PendingInvitations.js\":\"2d28d3c050a7b732\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/SyncProgress.js\":\"3251e4f76297c80b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/UnlockProgress.js\":\"1e7809a9eef0b711\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceKeyGate.js\":\"b1bd99ae3c8c02bf\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSettingsDialog.js\":\"75c0fc8d933bf8df\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSwitcher.js\":\"1fdb43a2ae8d8b64\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSyncGate.js\":\"be014c5035408b29\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlow.js\":\"20ff176dcab52216\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlowHost.js\":\"3f2c087d9cf3183e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/EncryptionSection.js\":\"ebee114dc48f1e9f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/attachmentPrompts.js\":\"f9cde6079849dca9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/bundleFolderPrompts.js\":\"91a7417610b6e35a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowDeps.js\":\"dccec380ba1bd57d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowStore.js\":\"6660b9efd6dbdfea\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/flowUi.js\":\"321da84ab4a60c25\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/useConversionRun.js\":\"59fc766cb5fd9538\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/keyUi.js\":\"4bd2ce2cb895a084\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnKeyLoss.js\":\"3cbc5804f112a316\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnServerE2ee.js\":\"03b6d4ff63653eb9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/workspaceUnlocked.js\":\"71c1996cafe78297\",\"/knowledge-medium/pr-preview/pr-1899/src/context/backgroundSubtree.js\":\"52d70ba312264c2f\",\"/knowledge-medium/pr-preview/pr-1899/src/context/block.js\":\"a60beea121d5b072\",\"/knowledge-medium/pr-preview/pr-1899/src/context/layoutWsContext.js\":\"edb0957cf0cf4fac\",\"/knowledge-medium/pr-preview/pr-1899/src/context/propertyDisplay.js\":\"a00b361203c14c86\",\"/knowledge-medium/pr-preview/pr-1899/src/context/repo.js\":\"7163c8bf39b3e9ef\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasClaim.js\":\"485c63e76e7bb909\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasSeatNamespace.js\":\"523b872515d7f1c1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockData.js\":\"54ea650b16764c12\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockType.js\":\"f974d2cc69e43198\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/changeScope.js\":\"d0aaea116870c686\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/codecs.js\":\"3d3c4a7b83048804\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/derivedData.js\":\"26f2f6a9d141102c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/errors.js\":\"4011d7a9fc636d1b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/events.js\":\"8b9d7feda5c31a4a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/handle.js\":\"27244778995d39c6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/index.js\":\"14a29744d476b3b7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/mutator.js\":\"9e3404e24daae7d3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/processor.js\":\"ab16d240f50f55c7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/propertySchema.js\":\"e0016d657a10b799\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/query.js\":\"ab179071b8ab0bc0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/sameTxProcessor.js\":\"644df44cefeee1e5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/schema.js\":\"27244778995d39c6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/tx.js\":\"27244778995d39c6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/typedBlockQuery.js\":\"1703a942d18e41b6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/user.js\":\"faff4a93c32dd68d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresetCore.js\":\"9f91e1363f2d2cd1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresets.js\":\"cbda056ae5e20da0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/attachmentCleanerIOVerb.js\":\"36fa8e1e8c293b06\",\"/knowledge-medium/pr-preview/pr-1899/src/data/block.js\":\"34e3589684662c03\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockCache.js\":\"9c8e90bbc29bd92b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockId.js\":\"41a0b493d3726f93\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockLiveness.js\":\"81e3ea7da8f06410\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockMerge.js\":\"a9bd32572b871da8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockSchema.js\":\"1203cee0b0c837fa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypeLookup.js\":\"db5e798998c67485\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypes.js\":\"05b904449ab6e985\",\"/knowledge-medium/pr-preview/pr-1899/src/data/childrenView.js\":\"facf16792bc2ec13\",\"/knowledge-medium/pr-preview/pr-1899/src/data/clientContext.js\":\"c01400f1892790ed\",\"/knowledge-medium/pr-preview/pr-1899/src/data/dbFileSiblings.js\":\"2098464138e21b6d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/definitionSeeds.js\":\"95d82ae293706b25\",\"/knowledge-medium/pr-preview/pr-1899/src/data/derivedIds.js\":\"31fc2d37ab127e9f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/drawnSubtree.js\":\"90a754c394f0adc7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facetBridge.js\":\"45a6fdfa2097e739\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facets.js\":\"7b10d7a7d4869da5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/globalState.js\":\"cd6ad3c08ef04aeb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/aliasClaimRederiveProcessor.js\":\"17681a230fd298ff\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/ancestorBatch.js\":\"9293292afc7e0f07\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/blockTypeTypeifyProcessor.js\":\"c535550c23cc90bf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/clientSchema.js\":\"95fe19b13a962ec6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/commitPipeline.js\":\"3de3ab4f5e73b6f4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/devAssertions.js\":\"3e9418fbd706f917\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/firstSync.js\":\"65a15f8fb29aab41\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/freshInitialLoad.js\":\"6bc568386d86cfec\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/graphBackfillClaim.js\":\"d1dedc811e4749b5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/handleStore.js\":\"a129d6b20e778ed0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/idleMarkerJobs.js\":\"481b03f18a324cc1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initialDownload.js\":\"822299aae47012b1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initializeClientDatabase.js\":\"8bd6f48d4e4cdbab\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/jsonCanonical.js\":\"d02a3662475b543c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelInvalidation.js\":\"ac7e5bc4d7a95f16\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelProcessors.js\":\"d496787fab011a77\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelQueries.js\":\"f4d29f7268ec923b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/mergeTypeMembershipProcessor.js\":\"67d84a65b189c021\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/normalizeReferencesProcessor.js\":\"9d22366ff07c01c1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/poolInstrumentation.js\":\"fd3b0e7770c45cf6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/processorRunner.js\":\"2d577beb55cc1f6d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyCellBackfill.js\":\"9b8ce68fc33f3da7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildMint.js\":\"9ae9ad03c3dcfec0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildrenProcessor.js\":\"054ed0cf070018f9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionChangeProcessor.js\":\"d995d872dd859bb9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionSynthesis.js\":\"29e490310cf1d9e1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyKeyScan.js\":\"a0200c7b89f1a439\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertySchemaResolution.js\":\"284d2574a04f3933\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyValueEdits.js\":\"18e93ea381a4e161\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/raiseProtocol.js\":\"4afd2bd239795ee1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/readBatch.js\":\"2c89936bc4046a39\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/refProjection.js\":\"f35ab0625810c30d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetLookups.js\":\"28138d4116c03ec5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetProcessor.js\":\"bc51d0ed3695d57e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/replayMerge.js\":\"9534cc5e838b8547\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/sqlBinds.js\":\"5b6732af0764e9b5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"24896a60c313d5dd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/arrivalProcessors.js\":\"101035f4de4fb109\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/invalidate.js\":\"407a12212b5af6f1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/materialize.js\":\"60dcd33411d86462\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/observer.js\":\"3125bfb26fa9c9e1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/reconcile.js\":\"ce6a17f7449d0264\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/timingMetrics.js\":\"65ffff5b6e5651ad\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/treeQueries.js\":\"170370158b744e9a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txEngine.js\":\"62d147448cf4f16c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txSnapshots.js\":\"a36555578f7f1495\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/typedBlockQuery.js\":\"b974440ef1b538be\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/undoManager.js\":\"084333000e8db8be\",\"/knowledge-medium/pr-preview/pr-1899/src/data/invalidation.js\":\"af5f9f63542bd655\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelDataExtension.js\":\"5469cafb7ce5c00c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelPage.js\":\"4dfbbd26eb7048cc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelValuePresetCores.js\":\"9041d3753187f128\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbCorruptionSignal.js\":\"3f008c5a5dea54ef\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbStorage.js\":\"29ed511ed53e5a6e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbVfs.js\":\"c4df9b8891986346\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localSchema.js\":\"0fe8f14818394578\",\"/knowledge-medium/pr-preview/pr-1899/src/data/maintenance.js\":\"fc9e15d5eaf3821d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mergeProperties.js\":\"6ef99417ba17d215\",\"/knowledge-medium/pr-preview/pr-1899/src/data/metricsConsoleHook.js\":\"462c01885d55f9fa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/migrationsPage.js\":\"d1e71e2a0ba41530\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mutators.js\":\"e632296fa2665703\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKey.js\":\"4b7ff654cde978ab\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKeyPlacement.js\":\"66793876546bff0c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/outlineSurface.js\":\"53931ffbaba323e2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingEditorContent.js\":\"f4afa97e4b6770ba\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingUploadsSql.js\":\"8502852de3e91f4d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pluginStateExtensions.js\":\"f01d4cc7d3f5927b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/powerSyncLogger.js\":\"ba7b3862c42c1bfa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/projectorRuntime.js\":\"c28aeee32540aaa2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/properties.js\":\"92ee3a31928b60b6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertiesPage.js\":\"c7a9fcb6cde38f23\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyChildren.js\":\"655d021bb7a7e7b3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionFanout.js\":\"f0f32318eed5eec5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionMetadata.js\":\"bc4e724bbc92aff2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionRegistry.js\":\"50084afd0d1f7207\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDisplayMode.js\":\"113d361fa1c8cae6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyRowCreation.js\":\"2be077745a3626e9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySchemaCreation.js\":\"c0ba3b5dca6fefd3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySeeds.js\":\"419eab359beb80d8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/recentsPage.js\":\"ccb298714b8b5bea\",\"/knowledge-medium/pr-preview/pr-1899/src/data/refTargetComparableProperty.js\":\"3a570f5bb625eb59\",\"/knowledge-medium/pr-preview/pr-1899/src/data/referenceBlock.js\":\"5180e58559a97f34\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rejectedUploads.js\":\"4bbe8154a366b407\",\"/knowledge-medium/pr-preview/pr-1899/src/data/releasePowerSyncConnection.js\":\"db545c0050205637\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repo.js\":\"eeefc2ebee623dcb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repoProvider.js\":\"31b34edbb01a1411\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rowProperty.js\":\"090a8ee14efd514a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/searchFilter.js\":\"1e72db169bb99181\",\"/knowledge-medium/pr-preview/pr-1899/src/data/seedIdentityLedger.js\":\"be7e7eef64edfd16\",\"/knowledge-medium/pr-preview/pr-1899/src/data/stateBlocks.js\":\"a11d631fe9098e93\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralEditPolicy.js\":\"8644effa2739ae86\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralInsert.js\":\"e09415c47f61da4a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/subtreeDelete.js\":\"32c527e1782ba5cd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncStreamLock.js\":\"ca97805990ee5739\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableSqlRecognizer.js\":\"4467fa51e82f0f9e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableWriteGuard.js\":\"4975af3b85c15bbc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/targets.js\":\"551888fd2addffac\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeColors.js\":\"6b4ae20e12aa9905\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionMetadata.js\":\"129c10566edaa17c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionRegistry.js\":\"32c6500fecf79b5f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeExtraction.js\":\"a841d17d75113759\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeInitialValues.js\":\"4072d729944f8909\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typePropertyGroups.js\":\"890d3b721c531f02\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeSeeds.js\":\"2e642d6fc790d837\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeTagger.js\":\"a2e4d5a3ecdb4328\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typedRecords.js\":\"854067429452e16d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typesPage.js\":\"5cabcb2048c30053\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userPrefs.js\":\"b9aca03f83c9b7c7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userSchemasService.js\":\"007422031e7d513c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userTypesService.js\":\"0bc55f0803e1cb51\",\"/knowledge-medium/pr-preview/pr-1899/src/data/valuePresetRegistry.js\":\"d32ed3dbc1eb70e6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/visibleChildren.js\":\"bfdd93c152b91b08\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceConversion.js\":\"b7e059f09f809304\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceFirstSync.js\":\"40767d236129846b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceIdNamespace.js\":\"0030aa3b43570337\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceSchema.js\":\"e08dad5fa0aec9a5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaces.js\":\"a797e76187c0cd0a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadLog.js\":\"6220d5d3c1d03d7a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/BlockPasteShellDecorator.js\":\"1b16211fd8982ef7\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/atTrigger.js\":\"1367c7593573e568\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/autocomplete.js\":\"415b867dea741af6\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/codeMirrorExtensions.js\":\"0e02a02ea06bbe20\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/contentFlush.js\":\"5d11ba8ff03844a9\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/defaultInteractions.js\":\"530e9b62860bced4\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/editSettleSignal.js\":\"a72f01b6630988b7\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/insertImage.js\":\"c789d4cafe2f0f8e\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceCompletionRange.js\":\"ad098222b8a4b1dc\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceTargetTypes.js\":\"0748f954b0431c48\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/syntaxContext.js\":\"68c9b8492c511cc9\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/triggerMatch.js\":\"c9caa03705a98ea0\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/AppRuntimeProvider.js\":\"cc5a108b30924b8f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/BlockFocusShellDecorator.js\":\"8eaa315f7ad4823f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/ExtensionRenderBoundary.js\":\"cdab622c888c5eaf\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/PanelContentRecovery.js\":\"72115557add496d3\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/apiCatalog.js\":\"5b15d46e938dc28c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/approveExtensionHere.js\":\"083c62430a38c9db\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/armedCutAppMount.js\":\"5f1067cfcd5ada06\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/batchableKeyedStore.js\":\"2c823016c5a26b80\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockInteraction.js\":\"17b53b501a033981\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockSelectionAction.js\":\"76396b255fb49c9c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compileExtensionModule.js\":\"9e5dbe860687784f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compiledModuleCache.js\":\"bff0128ee66bdf1b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/continuousGestures.js\":\"4325d53b3d48a1ad\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/core.js\":\"8f2422ceb990675d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/defaultRenderers.js\":\"19724b6f5acd1efe\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/definitionFanoutAppMount.js\":\"738355d9af000160\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dialogAppMount.js\":\"d69b44a8e2d8d03c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensionSeeds.js\":\"fdd0d8931ed75ab8\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensions.js\":\"ad1736a3c6a47dcc\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/exampleExtensions.js\":\"1e470e35ff3c1488\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionApprovalStatus.js\":\"30dc5d23af388af1\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrorToast.js\":\"6ec185ca633b2983\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrors.js\":\"983e5b6ce843d0ce\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLookup.js\":\"eefa096d5b736d23\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionToggles.js\":\"23bc8c036d217dd7\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionUtilitiesCss.js\":\"2060b9f2006cc959\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/kernelPageDeletionGuard.js\":\"acd71f58c21d31d6\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/liveRuntime.js\":\"f9cfda680256678a\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/openExtensionsSettings.js\":\"0b084c446ec384cb\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/overridesCache.js\":\"c208103c63994576\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/pluginIds.js\":\"15e3c1eefe4d24c3\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/processorRejectionToast.js\":\"7ab7d5d79abd7c05\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeActions.js\":\"6013942825f71bcb\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeContext.js\":\"69e7bebd7e50332a\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticAppExtensions.js\":\"26976dd1537337ee\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticDataExtensions.js\":\"a088ea98d3d42964\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/toastAppMount.js\":\"0aefc3b2b76c35b2\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useOverrides.js\":\"85a19b17a415ff5d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useShortcutSurfaceActivations.js\":\"0742ef94f4ac7a57\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/discoverToggleTree.js\":\"d6025f8fbf009455\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/facet.js\":\"f0161b4b317045b4\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/resolveAppRuntime.js\":\"1093e26e4caca7ca\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/runtimeEvents.js\":\"8788e6f53e35cdee\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/togglable.js\":\"a009b6e11a006fd1\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/variantFacet.js\":\"b68c28fbda398a27\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/verbFacet.js\":\"3a36fe472b452898\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/block.js\":\"5b837cb0ab88307a\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/focusedChild.js\":\"75e84fd5addff4c5\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/propertySchemas.js\":\"4a48fc1c2dfb17f9\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/typeRegistry.js\":\"f32546a5f348e471\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAncestorCrumbs.js\":\"c96f5e10efb2d70d\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAutocompleteListbox.js\":\"6f8b467bc0e6d972\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedSearch.js\":\"bd5d339b85847ff1\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedValue.js\":\"ace498699ef8a863\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useFacetValue.js\":\"f42860165a0838cd\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsFocalRender.js\":\"cbcf5bac0034fce9\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsReadOnly.js\":\"3e7b7037cb408140\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMaterializeBacklog.js\":\"6fbace5fe056dfea\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMinuteClock.js\":\"b20044c887c46757\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePanelLayoutProjection.js\":\"5ab77c497e64e472\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePendingInvitations.js\":\"38e6039776ecf4b4\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRendererRegistry.js\":\"68a823a1a4b6bb42\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRetainedFieldRows.js\":\"aed48cbc5ed92a59\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useWorkspaces.js\":\"34cbdafc33071949\",\"/knowledge-medium/pr-preview/pr-1899/src/lib/utils.js\":\"bd943b8bd93a34cf\",\"/knowledge-medium/pr-preview/pr-1899/src/main.js\":\"bafc42874fea0196\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/MarkdownImage.js\":\"37cdc8f7005fe79a\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/blockSeparators.js\":\"8a0c46b5fc4cc366\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/context.js\":\"19e645ed01b8b066\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/defaultMarkdownExtension.js\":\"87c00482f5100513\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/extensions.js\":\"ef3c836dab06255e\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/renderMarkdownHtml.js\":\"6fec70bff8828d72\",\"/knowledge-medium/pr-preview/pr-1899/src/minimal-editor.js\":\"01929cc1f05560fa\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/armedCut.js\":\"d80a4894232f88cf\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/captureMediaVerb.js\":\"08da52ffa96c4275\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/clipboard.js\":\"da63faa4a2b60131\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/decision.js\":\"52f56b7324dacc06\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/operations.js\":\"2a5aab744b1baecd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/AccountHeaderItem.js\":\"0f5a7e363724e039\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/index.js\":\"a07ca72d785f19cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5af04a104d1f3b50\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askAgent.js\":\"da0f63e5e55d80eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askedStore.js\":\"afe18d056bb2e1b1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"8d27394ba254351d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/chipState.js\":\"2b51d32d1cd865c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/dataExtension.js\":\"506db26e339e144b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/index.js\":\"1ae321dae196273f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8ca915d322d6edb2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/schema.js\":\"d288b53f45a6cf06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d742645a638a7ac2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/BridgePairingDialog.js\":\"bd6fd2f0d4af726b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/addMedia.js\":\"5007593d16f7bc6e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/backlinks.js\":\"75793ca08d3964c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/block.js\":\"898fbbada5131826\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/context.js\":\"b38b562bab5f81d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/displayIds.js\":\"aa2c24903cfc440a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/index.js\":\"32968546a62aaf3d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/outline.js\":\"d9ebf59a4a359aab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/properties.js\":\"bfb5c0d55d593539\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/refs.js\":\"2fa357cd57aacc45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"854cf411b04ce708\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/search.js\":\"f87fadc7b398289f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/shared.js\":\"990226a8da705400\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a1d11f1f4d0d0ec3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/text.js\":\"28bb5f3df6192b75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentWrites.js\":\"f30c4d6f498e91b2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/authoringCatalog.js\":\"a99162248e78783a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/blockRefTargets.js\":\"325b78ee26806533\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridge.js\":\"42c76813e1c31f40\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridgeLoop.js\":\"5498a60471528c46\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/changeHistory.js\":\"9e0385f51c51425e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commands.js\":\"578ec4b70a60a1ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commentsCommands.js\":\"6e6186b3b58d2eb2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataExtension.js\":\"fe8be6ec9693f124\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataModelGuide.js\":\"d3fd2a00a766b60e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dayPropertyInputs.js\":\"d332a9f2b40b8655\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/describeRuntime.js\":\"6bb84d25d5e7762d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/extensionLint.js\":\"e9921bc9c0bf92f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/grainAudit.js\":\"0ff963cfbb007f3f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/healthCommand.js\":\"b0b263376d93bda0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/index.js\":\"84fae320a2ce6f9f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/presetIdentity.js\":\"f731fd2721ded92c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e91bc1a53f71544e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/readMedia.js\":\"b50b6ae843649e97\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/schema.js\":\"c7e85a230a05f8fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/serialization.js\":\"b3c06bb0d3bcef52\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/targets.js\":\"b5e303522a7c7c59\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/tokens.js\":\"29b47429f2ac1b5d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/watchEvents.js\":\"3eef575c66ae1d06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/workspaceGuard.js\":\"43b70a5d5a52f937\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/writeCommands.js\":\"5a686fee95831ef8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/AliasCollisionToast.js\":\"42f613b9354dc5da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/DuplicateNameBanner.js\":\"6f04196cf1be1eb0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/collisionMerge.js\":\"23f69e9951802ac9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/dataExtension.js\":\"4bebcd1aa0e02cf4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/index.js\":\"d76e43e464a2a656\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/mergeCollisionAction.js\":\"74e524ebc3c2f3b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/pageStyling.js\":\"b57008121be1f1fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/rejectionToast.js\":\"b8573b7de45d0a87\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/syncProcessor.js\":\"e818b66a757f5632\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/actions.js\":\"5e46280e80376ffe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/addComment.js\":\"46c47e124cc1405b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchor.js\":\"c792314e037d1c9b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchorState.js\":\"834e460e69e41d51\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/commentLinks.js\":\"7974def6767515e4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/confirmThreadDeletion.js\":\"95e9af512332b600\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/container.js\":\"5dbf6f602ec14718\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/dataExtension.js\":\"9cb8811b3f7b34fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/deleteComment.js\":\"340bcfd27a402dd2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/highlights.js\":\"7701a297af7fa7ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/index.js\":\"a130c986d0bb5830\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/linkedCommentsPill.js\":\"9d441861594c3a0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/margin.js\":\"c66e88337ed119c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginAnchorLinks.js\":\"baba10b97f939dc1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginSchema.js\":\"0d5b8346172d4ffe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/newComment.js\":\"e6fef251a8a80732\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ownThreadPicker.js\":\"06ae7aaad8bf31e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/placement.js\":\"c7b67cf7ec8eea75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/queries.js\":\"45b3ff6f242f1c78\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotePosition.js\":\"27be00e81b7690fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedIn.js\":\"304c0a75fb979bdd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedRange.js\":\"c0067c3cd92c763d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/rangeRefs.js\":\"5a53bd5624e7c588\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readHighlights.js\":\"24cfe28e8698d740\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelection.js\":\"cb18d937c8c847f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelectionUi.js\":\"afa11dd74b5ca1a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/reanchor.js\":\"0f3672d987254055\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/schema.js\":\"566aff00b2ef09dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scope.js\":\"5eb4532ad9ed5056\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scopeThreads.js\":\"4a751b74a454764b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/splitRetarget.js\":\"11a9bcf67ecd466e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestionCard.js\":\"b5c6a9d83c2b7e3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestions.js\":\"821d924790ae9ab4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaries.js\":\"5d9c0806c9bf309c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaryBatch.js\":\"fad1d262edb4f914\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/surface.js\":\"2f6880e8fc9b1d71\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threadNavigation.js\":\"34d3907833335564\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threads.js\":\"1a613ce79e04f9a3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ui.js\":\"aa1b41a126948abe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/uiStore.js\":\"8642a2daf63f7a3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/appIntents.js\":\"2d4ede890911b52b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/index.js\":\"59ee84b02f775eca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/index.js\":\"68648b6c39459067\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/status.js\":\"add42c0d15401a73\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"1ebc291d958fd139\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaBlockRenderer.js\":\"85217cfeaaf3c554\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4b34ad09bbb6f3a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaUploadReconciler.js\":\"eeb74e7fa05fc98d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetDownLane.js\":\"c90a10518fc1cf3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetResolver.js\":\"a3cd5a75db9b1cef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetUpload.js\":\"9ae4e273d8676b89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/attachmentCleanerIO.js\":\"5f40a97a4aa5da1e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/supabaseAuditIO.js\":\"979edc385e4f984f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/blobStore.js\":\"bf4f77181081014d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/browserMedia.js\":\"8fbd837e1f9a2db3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/byteStore.js\":\"bd72a1b5e0447a86\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanerIO.js\":\"506d4424376a53e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanupAttachments.js\":\"49ea95964d5c6661\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/dataExtension.js\":\"440966f67f2f7613\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/downLane.js\":\"c1b1b759b18a8862\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/index.js\":\"5f4361f829863758\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/insertImageContribution.js\":\"aa73c480fe935438\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneArming.js\":\"05fdd7f3ab0617be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneLock.js\":\"26a25c96005fa45e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaBlock.js\":\"753e38a4386e345d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaCapture.js\":\"ea78105ada8a0b78\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaLanes.js\":\"7c5b24b378f539a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewers.js\":\"aa71e8dedf4f3988\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewersFacet.js\":\"b21f938226251fc0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/pasteCapture.js\":\"5d1d9c8643152727\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/resolver.js\":\"f5dba32646b4065b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/retryUploadsAction.js\":\"b730707668727843\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/storagePaths.js\":\"5b51a74b3291b3ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadDrain.js\":\"1fb6524d20d6241e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadLaneStatus.js\":\"44fab2851d4a110e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadReconcile.js\":\"e1e8f8e554551e27\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadRecovery.js\":\"867ebf7b965d9361\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadStore.js\":\"e6f859b6ab5be2dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/useAssetObjectUrl.js\":\"9943385a9c617312\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"874a46a6ab661c1b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fae6b846accfefeb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/facet.js\":\"9d36e59e51d3d815\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/index.js\":\"5fefa0c0d5415c72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/prop.js\":\"642f9cf8b7b376a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinkFilters.js\":\"8404c8d0110a97e0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"c4ab62916613b853\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BlockEntry.js\":\"5e014b2cf5446021\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/LinkedReferences.js\":\"0d7a3bcd4ea8b2fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"a347c432ec4424fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dailyNoteDefaults.js\":\"649f247cb2bb4455\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dataExtension.js\":\"349fb2b4dcc5a8ce\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/edgeExclusions.js\":\"416c0e54997780c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/filterProperty.js\":\"c538941729d92539\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/index.js\":\"920cf11663b6c454\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"55d5e14a862006c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/applies.js\":\"94bb1251fc7b0c1c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/countQuery.js\":\"1984923961b29900\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7c16ff9c485c460e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/index.js\":\"549ef0e39819db07\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3f057a23ac7fda47\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/presentationInvalidation.js\":\"274c182dfd651f7d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyEditorOverride.js\":\"cc2066d551186e6f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyFilter.js\":\"a108113e8e61b34d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/query.js\":\"92c232f2050f89aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/resolveFilter.js\":\"40c472f92fc67119\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sourceBatch.js\":\"a5ed34e1d5b42217\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sources.js\":\"3b15da07aa44410f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useBacklinks.js\":\"42e63239969613a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"82ff1acfdb9f08f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayCelebration.js\":\"25eeaf03336a5e13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayOverlay.js\":\"b8633c5096529468\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/gate.js\":\"fe1403c36527512e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/index.js\":\"29d69bfdb96893c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/wolfTheme.js\":\"30936405c70b31f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/BlockDragLayer.js\":\"1ddaac4183144295\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dragController.js\":\"4cb254533d82cefb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dropTarget.js\":\"4d059faa97edf1a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/index.js\":\"78e50d70a3e1b5bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/projection.js\":\"3022cb25458cce97\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/BlockMetaCard.js\":\"30a8d7a42f68179a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/index.js\":\"412b6e247d4fc784\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/AddTagDialog.js\":\"faaa856bef782aed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7192b68801fac2b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/TagNameIssueHint.js\":\"1e5299af91182573\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/addTagAction.js\":\"4f3e34a00536e6d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/appendTag.js\":\"b27dc9a1b40fa929\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/config.js\":\"8e71714ddf32097b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/dataExtension.js\":\"0057cc6db921ab5f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/index.js\":\"e109c068427fb8dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/propertyEditorOverride.js\":\"5e356e06d4a58385\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f775501c644ec73c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"fba99d9c1a2de678\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a15923741388449b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"11fb7758d93c6713\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"735f711afa0377a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/index.js\":\"c462c08916f76bf9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d239f4f58568d9b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/CharacterCountItem.js\":\"4ec5f9a3ff48479d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3629f3ad3ee39637\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/actions.js\":\"f23c6df353e66992\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/blockType.js\":\"26fd3a14d61d6fe3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/charCount.js\":\"86247d04cd4bc195\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/dataExtension.js\":\"f3dd69160e109074\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/index.js\":\"576bb9750fdba3cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/profiles.js\":\"7f6e1e951bd87d64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/properties.js\":\"667f11e4f8079827\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/subtree.js\":\"2aae8d42b13130b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/textCounts.js\":\"0c325328b345c167\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/colemak-keybindings/index.js\":\"4655e21586f704e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/CommandPalette.js\":\"52438d246a107369\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/HeaderItem.js\":\"45253df26a32c998\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/context.js\":\"bb5cf82280748ab2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/index.js\":\"fa38b46a4d632373\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/selection.js\":\"893fa6107efd23d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/toggleStore.js\":\"edf52547b97d3035\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/useCommandPaletteActions.js\":\"d7ba5f8fc0b9c965\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ContributorBadges.js\":\"b0c2f7f2eb5e011d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ProfilePicture.js\":\"fc50e4c0167341bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/author.js\":\"3d7c955ac1129c84\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/codeMirrorExtensions.js\":\"3ad43ab8d3878d6b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/dataExtension.js\":\"b3207067a91f9176\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/index.js\":\"3897c61ac8ad4bbd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/mentionAutocomplete.js\":\"4613bdab68ddf03a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/processor.js\":\"b2348033fdfdbe9b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/profiles.js\":\"d7c5364aab264dae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/queries.js\":\"56dc98640510737b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/schema.js\":\"0758b898b3f34610\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/useCommentAuthor.js\":\"80f19408a207871a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"0a7ee1de633f616f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/followOrigin.js\":\"3b06b393344b9a56\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/index.js\":\"9ce685ead4a80266\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"ae36d8a73bed04cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"974d4b76cebec5cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/CalendarGrid.js\":\"bac00128ad22d020\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DailyNotePicker.js\":\"3e3603373da3f113\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"dce978125c7d7900\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateNavDecorator.js\":\"01972d6a3c517266\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateScrubOverlay.js\":\"b5e3c948ebed1509\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayPropertyControl.js\":\"11e0aa9c5756d24d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayValueReferenceControl.js\":\"a6ed16283efbd7b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/HeaderItem.js\":\"34a32cb15d37e8c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/ReschedulePicker.js\":\"9398b86e2c488a25\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/SpreadDatesDialog.js\":\"3f1484ae25468ceb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/actions.js\":\"868c5a22c6ee01e4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/blockDateAdapter.js\":\"00362fe620d3da1b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/calendar.js\":\"4db3dd4df10f5d6b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dailyNotes.js\":\"0c8814f0d461dea5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dataExtension.js\":\"a82d67800adbad48\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubActions.js\":\"ab8d2ee5b81024b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGesture.js\":\"f93c7ba45343135f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c403ddabd92f5b11\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubRecognizer.js\":\"2d561613c581015a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayProperty.js\":\"7902e20159644dfd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"11121942570aa8e4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/deletionGuard.js\":\"19ac76b86b8131eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dueQuery.js\":\"9d48dcf9e6d2a8f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/index.js\":\"7ff1a2df83dc8ec9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/landing.js\":\"73c0df5416da890d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/localSchema.js\":\"731fe620a4da7a73\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/referenceDateAdapter.js\":\"3d2174379b80b58a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/rescheduleAction.js\":\"88eac4d78fc65a6c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/schema.js\":\"0167686a3505bb2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadBlockDates.js\":\"ece476b66a8d84d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadDatesAction.js\":\"044381537a291123\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/today.js\":\"8c9f91bfbf308577\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e7b057a8248fb07d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9f8399e90271cb19\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/audit.js\":\"ac33a5e3d97c4cdc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditAction.js\":\"41ac626e82bfdaf0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditRanges.js\":\"3b864696676eb782\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/diagnosticsSource.js\":\"826bc8ab542f30f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/divergenceScan.js\":\"7c393d7afea0b1c1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/index.js\":\"271e31facdcd2e3f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/propertyChildrenChecks.js\":\"bd6070373318555f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/referencesMirror.js\":\"9facdde4684d061e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/rowJson.js\":\"5b97913cd288b0bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/schedule.js\":\"c117fba1c809f822\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/store.js\":\"f1054d95c7ca2310\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/action.js\":\"f71d376172820574\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/index.js\":\"b396a211cb8d5f42\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/plugin.js\":\"029d18cc59053377\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d4a42c1fa843b9dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/actions.js\":\"cece8cdfe93aaa63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/changeMarker.js\":\"bc361929abc7bd77\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/diagnostics.js\":\"a341f46c39468e30\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/fileSystemAccess.js\":\"d07de793c5da07f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/filenames.js\":\"4f171bf88263ddac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/index.js\":\"e78583113369fc1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/mirror.js\":\"8ce34094ea455439\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runLock.js\":\"e8e0ce99a0b3105e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runtimeHealth.js\":\"46c4add6366d94ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/schedule.js\":\"8fcf72baedc2d195\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/store.js\":\"b1b28689a968bead\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/index.js\":\"9a42297dfaa7ea78\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/themes.js\":\"cd2522c50f825213\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/facet.js\":\"5e1572c5f4970675\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/useDiagnostics.js\":\"5dc07984b39e4db2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/dismissals.js\":\"c1c5f17dd258865b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/index.js\":\"e96d8b79894076c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/status.js\":\"c64520f2893470ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/store.js\":\"6a9103abbb6c4baa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"a3e3ebc4e73108d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsSettings.js\":\"2dbcbbda2a0b69ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/actions.js\":\"f1db9c69a8b0be8e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/config.js\":\"391d842019664870\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/dataExtension.js\":\"fc2351f569c6b647\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/effect.js\":\"59b06cce675d7114\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/index.js\":\"771df65fe2f6408d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/propertyEditorOverride.js\":\"40f25bc3ca5a954b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/useToggleTree.js\":\"49a07a57ed5ed79a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/ExtractTypeDialog.js\":\"edd9bd0fd374e86e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f61f373fd14ead3d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/PropertyShapePicker.js\":\"8f54781ba9f5faf4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/action.js\":\"9d9faf586ec43efd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/index.js\":\"a9a26559f7f60906\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/FindReplaceDialog.js\":\"630a3396f3609aeb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/HeaderItem.js\":\"0fa727713cd8d21c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/dataExtension.js\":\"1326b4d58c24c76b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/index.js\":\"1d701fb3c3354879\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/search.js\":\"e3d0049d88987e46\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/toggleStore.js\":\"d684b23afba2f985\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/LocationPropertyEditor.js\":\"9cfae237f93c5ec9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/MapView.js\":\"4d76375e5794ee2c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/blockTypes.js\":\"db4e1584fea94f8d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/codeMirrorExtensions.js\":\"bd8ed11fd3f169d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/createOrFindPlace.js\":\"2b80353a47cbeeb0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/currentLocation.js\":\"3f902a28c9468dcc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/dataExtension.js\":\"17d6c9a85acae857\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/geoContentDecorator.js\":\"f5375a922cc2bbe1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/googlePlacesClient.js\":\"c6022c5c0437fe26\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/index.js\":\"98f84628a15d7fa6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/locationsPage.js\":\"3f3cb23f467a1136\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/mapViewport.js\":\"acb0073239c06a0e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/pickCurrentLocation.js\":\"55e09dd9ce8b1bfd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeAutocomplete.js\":\"746d97917062196d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeNameCollision.js\":\"4a33166593b268e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/properties.js\":\"783d53333aed59de\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/propertyEditorOverrides.js\":\"7c27749aa0028c50\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/query.js\":\"50908aa55f712f5b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/usePlaceSearch.js\":\"0bf238da772dd836\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"652ec5e721a1f0bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"f1ea53cf62e7ac50\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"0505feea7a0da0e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/config.js\":\"06edb072f54f4232\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/dataExtension.js\":\"b0e847b4d276f890\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/facet.js\":\"872a52c91b466678\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/grouping.js\":\"da623225bb365d3f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/index.js\":\"a0a8bb8a92e2aeb3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"ea756ff528915ca0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/query.js\":\"e85f60169ac564f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/resolveConfig.js\":\"012eb913d2a9ce37\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9c188e1426f2359e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"72db4c82ea4b0b5f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlDocumentContent.js\":\"596c60dd2f9d6aa6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlFrame.js\":\"4a0432228d58e2f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/actions.js\":\"0cf269fb7c373cfa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/blockType.js\":\"09f1be0156897cd7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/confirmRunScripts.js\":\"14d4853073cdd223\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/dataExtension.js\":\"53ff6b05174afee2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameAnnotations.js\":\"e843ca65f016b226\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameDocument.js\":\"75846353d6ff6447\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameTheme.js\":\"90de45a4292b2a0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/index.js\":\"373df0dc0830807a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/scriptConsent.js\":\"7e8f915b3ed336aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/sourceMap.js\":\"e9ba70a8e8655835\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/useDocumentScripts.js\":\"1f9f602f0ffa9590\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/index.js\":\"ee287cb002c6f1a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/record.js\":\"20ec81a606bf3af8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/recordStore.js\":\"0180dda9faa10c6b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/responsiveness.js\":\"255f658d4629e9b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/schedule.js\":\"c1ac00a435439f8b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/sessionContext.js\":\"ce51bc811c1753d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"eb7601dff70181ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e3a8d15307e4c276\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/actions.js\":\"411841b81b4caff9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/config.js\":\"50c0755526e599d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/dataExtension.js\":\"ee6529da18657b1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/effect.js\":\"b71cb7c84688e66e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/index.js\":\"53773a56136d7489\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/keyCapture.js\":\"44146244419d9041\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/overrideStore.js\":\"4f53bbb02ce4e080\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"766f465f5f7dae67\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/HeaderItem.js\":\"289810a2698a0f27\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/LeftSidebar.js\":\"fdeeaa8457489b0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/actions.js\":\"871e36193d5b3be3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/facet.js\":\"c5093dc695ee6d74\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/index.js\":\"95ae25155dd23d62\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/shortcuts.js\":\"029de3c0ac735955\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/toggleStore.js\":\"19510e1c974e91c1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/MergePicker.js\":\"139b0eb5ea5a3773\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/index.js\":\"74de83e7546c28b2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/mergeAction.js\":\"99dc72e226ed0956\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/strategy.js\":\"290b5c819624b238\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/Button.js\":\"70b2313fa39f9799\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"476029a8e09fff69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/defaultItems.js\":\"3ce8999333931dd5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/facet.js\":\"17200eeab499a798\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/index.js\":\"29ff49c8b12dbf93\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"33836d56f0f09c2a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/actions.js\":\"80c4934025c2dc34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"98a3f0a5341c6838\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/facet.js\":\"04fcc0fc00c87eec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/index.js\":\"c91321809e717377\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c94e98fa68e7a92b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/blockSubtreeMembership.js\":\"5569f6d7572a31ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/contextMenuItem.js\":\"cb54075f1521f463\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/index.js\":\"1588592390f6b1b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveAction.js\":\"fbb138dd8e6f339c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveBlocks.js\":\"e773cd15aceff117\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/selectionAfterMove.js\":\"94c597a15b03df0e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/TutorialBanner.js\":\"bd280ad4ac5c92a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/action.js\":\"c366aee68ac6d4ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/bannerDismissal.js\":\"97f4fdf0b8edbde2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/documents/cheatSheet.js\":\"298ce816a53a3df2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/index.js\":\"832e8db2efbc4155\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/keys.js\":\"2024f5450cc35661\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/landing.js\":\"f7d818053004e287\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/outline.js\":\"cf23437149e823d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/seed.js\":\"82a647cfc47344a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/PerfTrendDialog.js\":\"4ebeb0659a14c95e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/analyze.js\":\"7c77b4c78714456d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/diagnosticsSource.js\":\"05d94336a4be2a74\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/index.js\":\"65293e623d112ecf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/load.js\":\"8de48a429210d0ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/monitorRun.js\":\"82a9ce1a2cef14cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/schedule.js\":\"acf1146ed97776d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/series.js\":\"2787762bba48f9b1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/store.js\":\"24888ba1054f5f6f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/trendAction.js\":\"59412730dcb753d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/verdict.js\":\"6754c39a83be2e3f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/clickToEditAction.js\":\"b109b2dfba3fb75d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/index.js\":\"931d5601d5cf524f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/interactions.js\":\"3ba7e4fdc6d304c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"be1600fa2705e12d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGate.js\":\"4960c96dc52ba629\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGateDialog.js\":\"32936efe9e982d3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/action.js\":\"731ce7b7c8209564\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/index.js\":\"101081803122bcd8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/localRunMessage.js\":\"1679b39487481b23\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/plugin.js\":\"148b8bc41c81ed6e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/progressReport.js\":\"4782262983ff832e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/sweepProgress.js\":\"89126d0e772a2120\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/FieldRowRenderer.js\":\"eed2c8ab58b22db5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/ValueRowRenderer.js\":\"07d59971bf58d2c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/actions.js\":\"701accdbf4fed1fb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/autocomplete.js\":\"4ffe39302a3ba932\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/fieldRow.js\":\"d6130730ddd230ad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/index.js\":\"41bddaf3694c82d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/referenceWarning.js\":\"96ea94160e352b5d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueAutocomplete.js\":\"b01cd6a2e8deb77d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueSchema.js\":\"ffdaceda63093fb4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/HeaderItem.js\":\"f79c95b3c9034abb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/QuickFind.js\":\"babb2b310b6dfe22\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/index.js\":\"c6b671bdfdd03513\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/recents.js\":\"683256db8e9dd140\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/resultItems.js\":\"cd2f276f785f0b64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/selection.js\":\"57c3d492fa26bbbb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/toggleStore.js\":\"eb8c5c9c97fc4ac2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/HeaderItem.js\":\"69c926ffe252d2f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/RecentsPageBlockRenderer.js\":\"6daf11103e27d351\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/grouping.js\":\"93a836c412728510\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/index.js\":\"09201b3edfb59283\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/target.js\":\"ea945bd447b7411e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/codeMirrorExtensions.js\":\"239092b9c2dfad29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/contentPrefill.js\":\"e16c379eeb183e1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/dataExtension.js\":\"015322c4a95da6e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/index.js\":\"23a05c6f985983bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"aea0811cac1d7c92\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/invalidation.js\":\"ec04ce5205f10716\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/localSchema.js\":\"78b93ddcc484139b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/index.js\":\"ac76334caff99ee6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"93aaab9e57a81e2e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/index.js\":\"0ef783679cc2516b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/referenceNode.js\":\"70784fcde3ae2caa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/remark-reference-occurrences.js\":\"4f5891360e9be46c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b6dc8fdf4b9cb1b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/index.js\":\"0774c889087132dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"b48d613afee35037\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"87e0c1d60a452fad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/mergeRetargetProcessor.js\":\"fe1b093cda9b1657\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/parseFence.js\":\"d759530b8c8e3f29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceParser.js\":\"f7d07e116ec91448\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceProjection.js\":\"33ca152fab8443f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referencesProcessor.js\":\"01b629861382719d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/renameProcessor.js\":\"1020717c803da51d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/spanReplacement.js\":\"7845564894e059a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/htmlToOutline.js\":\"d5c903b552648130\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/index.js\":\"db50bdc98648a5f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f838925dda3e24f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/pasteDecision.js\":\"9de996c610718320\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/action.js\":\"0565aef4b7b3fc95\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/blockIds.js\":\"328479de6b324da7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/content.js\":\"df178c0f1c12d1e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/effect.js\":\"2ae56586e9d60fe2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/ids.js\":\"d12e0a58e0abc5fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/import.js\":\"4ca08e763d05ff2e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/index.js\":\"906adabfe67d0737\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plan.js\":\"788bf04babab6e47\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plugin.js\":\"812a354a950aa5cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/promotion.js\":\"9996a1edb6a28213\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/properties.js\":\"0df42060b79e4651\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/references.js\":\"0197fc38e00a0eb9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/report.js\":\"c9014c03b1cef91b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/roamMemo.js\":\"844bb84323f59664\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/runtime.js\":\"10f87acb3c2d672c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/schemaReconciliation.js\":\"da5b2fdaa2f40146\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/srsMarkers.js\":\"88070054ef5ce0ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/todo.js\":\"1b089163f9e3af0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/typeCandidates.js\":\"b80de0a235d4e2f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/types.js\":\"01826eae4973f37b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/index.js\":\"b13e3d344087d063\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/store.js\":\"812d217297015333\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/HeaderItem.js\":\"ce26b20ad6e6a6ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"4125fc0e1f4934ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/index.js\":\"148fc8c242cd2dfa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/model.js\":\"29248bb225d288d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/toggleStore.js\":\"8bbfd84015a01087\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/useKeyInspector.js\":\"6547b927d97fce72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"76d68a34e3b0dc81\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/ShellDecorator.js\":\"e2915bf4b801a961\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/actions.js\":\"52241d480ea66547\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/exclusionsFacet.js\":\"039488c11714f845\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/index.js\":\"b4a52a4902e0204e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/shell.js\":\"e5ef85b9cf0957dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/surface.js\":\"295d633f871476f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/walker.js\":\"b857d349b2a86b2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/RescheduleToast.js\":\"7f4778fd1f8eaeaf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/dataExtension.js\":\"ba8a2b91fad9dde6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/index.js\":\"10ea2e16135c0703\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/indicator.js\":\"5a5729207ad146d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/moveSrsState.js\":\"8eafee39b9a35469\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"b418b24609b8d189\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/scheduler.js\":\"629128a998e27ea8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/schema.js\":\"9c950b44368c35f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"daa2f564e6cd76f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsClipboard.js\":\"b4641ac071d4beb3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"8014c353c60c5c63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DailyNoteReviewHint.js\":\"20bbd15e2e056ffe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DeckPicker.js\":\"17c9b152be07cab2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewControls.js\":\"62554316b0f3a8c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewDeckRenderer.js\":\"1b84dcf79cf7dae4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewSession.js\":\"32545c446af262d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/actions.js\":\"5cafe36a0b6eaedc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/archive.js\":\"8efc386c24be9dd5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dataExtension.js\":\"443d5761198c2087\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/deck.js\":\"c8bf96a7fd3a7480\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dueQuery.js\":\"ada907209a6c7cd9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/gradeDecision.js\":\"42ff1bd4c4cf98b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/index.js\":\"468a17a894dad76d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/keyHints.js\":\"9f30e07513733b69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewCardLayout.js\":\"34831881f5aabbe1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewProgress.js\":\"9964b8ab63f1881d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/schema.js\":\"5cd4d51f79693d46\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/useDueCards.js\":\"321e9325b0bada20\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/index.js\":\"e3d49eb766e120f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/record.js\":\"0095c637c132900d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/index.js\":\"6515b3bda5a8bdd0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/persistenceStatus.js\":\"e6bb0b05dff54b22\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/requestAction.js\":\"3e0f0526c6fd2418\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/TypeChipsDecorator.js\":\"97a7b68e9f3e9f76\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/codeMirrorExtensions.js\":\"7bfa9bc4e3657f00\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/index.js\":\"db554231dbd4c8f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/typeAutocomplete.js\":\"f4dbd71c2d2144b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6549b1c6bd7e57b1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/actions.js\":\"2b3e6cdb42bcc382\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/anchor.js\":\"658314ec73d5a73b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/events.js\":\"2db19860d1ed2c62\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/gestureActions.js\":\"cb6b6b6f9238c4cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/index.js\":\"58be192dc1fe4a14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"b8b4ece637a3958d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/collect.js\":\"bf8812c18abb4d70\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/index.js\":\"074750e3f00a6153\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/record.js\":\"2f4363ae8854bad9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/RejectionDialog.js\":\"d4fff05c6d133774\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c2422853c7ea0654\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/index.js\":\"622b6e56527ac1b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/model.js\":\"f3a2025cdbb43977\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/queueCounts.js\":\"0c07120f738b05bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rejectedHelpers.js\":\"a5deac3c972ec3ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rematerializeAction.js\":\"1d628c856e46e0b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/useHysteresis.js\":\"b2d6b811b4ff5ab1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/ColumnHeaders.js\":\"9eed29719720afc1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/QueryUi.js\":\"84e3c697bccf125c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/TableLayout.js\":\"4c28ec0541cac67d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/actions.js\":\"e454d921ae47c7b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/cellEdits.js\":\"69586493c12a65be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/childrenViews.js\":\"e55d47572d305465\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/columns.js\":\"86bc698f123d0325\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/controller.js\":\"77b7289abd726df0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/convert.js\":\"6ccbc290a5157047\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/dataExtension.js\":\"7b95b1bd462e1a6c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/index.js\":\"8aeee6a014ac2b83\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/keys.js\":\"534cdc47d1f27568\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/model.js\":\"8869162466fadf92\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/QueryText.js\":\"ce4040368e421f45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/backfill.js\":\"90f2a0fd344bd8c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/completion.js\":\"100697dc3e8172b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/format.js\":\"e578f3bcfe191286\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/parse.js\":\"37b433dc76516a5b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/queryValue.js\":\"baf817fafbd24144\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/registrations.js\":\"618839afda5bcf15\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/source.js\":\"94b0c3b29d7237d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/registry.js\":\"30f158fdaa718958\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowGutter.js\":\"4bdb165efa9894f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowVerbs.js\":\"f5447febb00146fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/schema.js\":\"e825542723e57306\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/sort.js\":\"8757f2cceacaf5c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/effect.js\":\"0321f65e39de07d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/index.js\":\"89c5640035b6781d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/theme.js\":\"9694427130a0d2bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/actions.js\":\"5f1cb1803d44de74\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/dataExtension.js\":\"5d2b1d65ad05d3b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/index.js\":\"f9ef1eaef27c65a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/schema.js\":\"5f53837ae64922de\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/TouchSelectionLayer.js\":\"5437d8cf624a6fac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/actions.js\":\"7dd09a0d5c200a02\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/defaultItems.js\":\"43fbe9e31785d07a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/facet.js\":\"865da0f8b1842ed9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/holdRecognizer.js\":\"2c63842060a29b9b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/index.js\":\"fb5d1d2dcdce8588\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/UpdateIndicator.js\":\"108a826659fc74f1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/index.js\":\"e3f084c02673bec4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/loadTimes.js\":\"76bb249e7782f000\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoNotesRenderer.js\":\"aad7d1999d2dfdb5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoPlayerRenderer.js\":\"3eb032290eb52832\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoTimeStamp.js\":\"8211f3c0914f1447\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/actions.js\":\"a467314daa1fd078\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/index.js\":\"f038c81a18463252\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/markdown.js\":\"4266ed1f881ef5df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/notes.js\":\"d559001d30af7cc9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/registry.js\":\"948bcfef0f0f4a89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/remark-timestamps.js\":\"304cc9c0073d2a67\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/view.js\":\"a0de21620a77921a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/LinkHints.js\":\"82be352b145a47b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/index.js\":\"24dd6b2f3eafec47\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/model.js\":\"4e25b79b4abc5836\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/settings.js\":\"f020f9ea1041d3f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/actions.js\":\"36a4a1e709a22e6a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/index.js\":\"8640b73e17be5ec9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/interactions.js\":\"e8c61e70964391da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/workspace-header/index.js\":\"bf75ca28fb228f46\",\"/knowledge-medium/pr-preview/pr-1899/src/registerServiceWorker.js\":\"ca5d281ed36bbfc7\",\"/knowledge-medium/pr-preview/pr-1899/src/requestPersistentStorage.js\":\"5a7e2bc07165a01e\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authRequestDeadline.js\":\"56bcbe37dbc86b66\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authStorage.js\":\"feac831b02e971c3\",\"/knowledge-medium/pr-preview/pr-1899/src/services/powersync.js\":\"8b6eb4fc9dbaaac2\",\"/knowledge-medium/pr-preview/pr-1899/src/services/supabase.js\":\"3f1e5f3ea187cc52\",\"/knowledge-medium/pr-preview/pr-1899/src/services/uploadErrorClassifier.js\":\"78a4f8160790da32\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/ActiveContexts.js\":\"0e50d13dbf63acda\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/HotkeyReconciler.js\":\"cbcb9263d27b1dcf\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/WipeLocalDataDialog.js\":\"7cddb99d079b43d7\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionDispatch.js\":\"a47f2bd7694cfd33\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionRefItems.js\":\"3bc080508839bd11\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/applyKeybindingOverrides.js\":\"8855c0fddf434e32\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockActions.js\":\"b1e9606729350788\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockMergeGesture.js\":\"11af0a811b492ea5\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/canonicalizeChord.js\":\"1e7662464b1decd0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultContexts.js\":\"deaed77b055be97f\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultShortcuts.js\":\"72735d7c8dfdae3c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/effectiveActions.js\":\"d41dfb96f526aacf\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureAction.js\":\"0ba1804bc0c32ad6\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureBinding.js\":\"c8a47efcbbb7b12c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/holdRegistry.js\":\"9fbafbd8d9673a23\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingConflicts.js\":\"52568505b0f18eb9\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingOverrides.js\":\"93f217c8df82e4ac\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/pointerAction.js\":\"05361d101d5bdec2\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/resolve.js\":\"c17139733810d693\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/runAction.js\":\"33a588d980504c62\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/sequenceMatcher.js\":\"ff3d52f2de11d80d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/types.js\":\"312d3c086b10bf3f\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionContext.js\":\"e8fa59b29b2fd4c4\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionDiscovery.js\":\"d615c6e11e045f86\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/utils.js\":\"52d333ac37fcf34e\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/bootStore.js\":\"ac69d58a0b584c78\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/previewDatabases.js\":\"c713e3a4887e0e88\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/byteTransform.js\":\"9af41b90031c220e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/attachmentCleaner.js\":\"20562d0f843d5a78\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/attachmentParts.js\":\"ff039efd552f2040\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleParts.js\":\"956f50aa92337c9b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleRecord.js\":\"75c58fd45c98d47c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/manifest.js\":\"6386dfbe00a60dcb\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/takeBundle.js\":\"e74b09c06f9a2ed7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/verifyBundle.js\":\"483d4a225db04f56\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/cleaningStage.js\":\"c512e1480a122579\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionKey.js\":\"17a8789b04e3e82a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionServer.js\":\"7ee5370d4025a71b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flip.js\":\"4b69066c39a899c9\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flipAttempts.js\":\"59413c9734672c04\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/pages.js\":\"deebeb07c948ab8b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/preflight.js\":\"a887c101da44aece\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/reseal.js\":\"e68f7887a4134c7f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runConversion.js\":\"cb5581ddc1187a19\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runLock.js\":\"2518858fced827d2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealing.js\":\"dbf50e7f35534965\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealingStage.js\":\"c9753f0c86e978cb\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/stage.js\":\"dab52b7bcd82dd19\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/verifyReseal.js\":\"fbce4f0a3cc9acda\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aad.js\":\"d59b1a46daadd5cb\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aead.js\":\"5f35f69c8ca373af\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base32.js\":\"69f22d6c07c894be\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base64url.js\":\"8710665674cede5b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/binaryEnvelope.js\":\"d32b84427885fbb4\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/byteAead.js\":\"8f1129f682f46e90\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/canary.js\":\"ead76ccaf47186d8\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentHash.js\":\"cda6e531dd32b260\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentKey.js\":\"abc3e3a48ee62afd\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/derivedIdNamespace.js\":\"feb366aaf97e7bf3\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/envelope.js\":\"2a88c6361457377b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/hex.js\":\"b86859526622840d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/sha256Hex.js\":\"b049a79025cf6fb9\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/workspaceKey.js\":\"a04c061634b592e9\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/conversionState.js\":\"f13354f02711776c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0b73fde653f1f5c8\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/pastedKey.js\":\"ebbd9376eda4e9e1\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"45d08142c4f215eb\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ce9540595a5ba791\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/keyStore.js\":\"f8f698a542c6862d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/mintWorkspaceKey.js\":\"43d033c4d550cbb4\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/modePin.js\":\"3b96906b3e0ccccc\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/openWorkspaceKeys.js\":\"1b05cb808d4e61fd\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolveWorkspaceEntry.js\":\"be846adafc172901\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolver.js\":\"4dd474094d10cc25\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/workspaceAccess.js\":\"073b5474719ae141\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/transform.js\":\"7af698540bd2300f\",\"/knowledge-medium/pr-preview/pr-1899/src/themeBootDefaults.js\":\"1233344ad8568bb9\",\"/knowledge-medium/pr-preview/pr-1899/src/types.js\":\"dbade0ed89ae4ddc\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/ClientLocalSettings.js\":\"49cbc17b29497b07\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/abortableSleep.js\":\"8f2ad333e3e76a7a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/array.js\":\"06fe682e23781882\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/backlinkAutocomplete.js\":\"31a747bfa2634dbf\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockCrumbs.js\":\"87adcf6130e95a0a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockrefAutocomplete.js\":\"528935ee7ae0dbef\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/cadencedIdleJob.js\":\"4031a0cdd0acd633\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/callbackSet.js\":\"4c75b2a2a8791913\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/clientId.js\":\"89984ea339b929fa\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirror.js\":\"b2d29deb8f758e3c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirrorCompletion.js\":\"9d7794b2481fb54d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/copy.js\":\"f66f6e8d8c5d6ff9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dailyPage.js\":\"3014be33fae779c6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensics.js\":\"2f3ff64c930a30d4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensicsHooks.js\":\"eb4971436adba5ee\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/deleteBlockThroughUi.js\":\"46067c795938373f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dialogs.js\":\"8b1d835fae4a202c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dom.js\":\"ba142fbf809b576e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/downloadBlob.js\":\"2ada50eccbf920c8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/drawnWalk.js\":\"83a2f911416909ff\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/exportSqliteDb.js\":\"f1ee940290dadc80\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fileSystemAccess.js\":\"a8adbc79f53e189a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/flipSlide.js\":\"9424f722585d8804\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fnv1a.js\":\"fd76ba0ddc81de56\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/formatBytes.js\":\"4d7d750fa3478eae\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fuzzyRank.js\":\"a61e32bd53980808\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idbKeyedStore.js\":\"d623a244c70284ae\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idleCallbackPolyfill.js\":\"748c63c785172166\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardAwareScroll.js\":\"e7498860536cd488\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardViewport.js\":\"b0910fb8d35c7de0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/lastWorkspace.js\":\"d01b62b132ad80ac\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutColumns.js\":\"3ec3f846d86652ff\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionDom.js\":\"5c76746b0326ae58\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionId.js\":\"186f5bdbcd05018c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkClickGestures.js\":\"f004fad1cda8f6e2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkTargetAutocomplete.js\":\"dfa79e15480670c0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbCorruption.js\":\"505fdf48ca8303fb\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbRecovery.js\":\"fa16f31cb87dbcfc\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/markdownParser.js\":\"7a546517d648f67d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/memoize.js\":\"0b0ad88b370afc6c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameFieldCommit.js\":\"fd47b81903899b57\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameList.js\":\"edabc9e6acb3cec6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/navigation.js\":\"21a35b5ed4746b2e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/omnilinerNamespace.js\":\"259bee1184aec6f6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/opfsPageScan.js\":\"42c434bcc9732572\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelClearance.js\":\"ec640ba02c2573b1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelHistory.js\":\"1af37a360731d945\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLanes.js\":\"a55d5c25e42ac5af\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLayoutProjection.js\":\"223f7570aec20ed9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelScrollAnchor.js\":\"03a50c542cc19e29\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelUrlFlags.js\":\"9fb80a0a177a191d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/platform.js\":\"1af8cb6c7021b6a9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/pluralize.js\":\"89ccbe66eac66316\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyCreation.js\":\"8bc7541f00eac3f9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyNavigation.js\":\"dcc33abfa4d33483\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyValueContext.js\":\"fffd90e6842b061f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/react.js\":\"0e3e1db18fb41e4f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeDate.js\":\"7e5181ccd92e587c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeTime.js\":\"ca635a6b7b2cc870\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/renderScope.js\":\"37d65d578cb9e6da\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/resolvedThenable.js\":\"5329e41285b8d7aa\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/routing.js\":\"f7182d7470b58136\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/safeMode.js\":\"a0056750dc69ccf5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/scheduleIdle.js\":\"8c6c38a87c8a585b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/screenWakeLock.js\":\"8960fd11b528bc7d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/selection.js\":\"21f6346e0804d46a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/softKeyboardGrab.js\":\"f9fe013980159a52\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/startupTimeline.js\":\"240b51fd8fd7e555\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/state.js\":\"07ca99e6a737b417\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/string.js\":\"903231def6e03b18\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/surfaceZoom.js\":\"1826b5ec5052c73f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/time.js\":\"7d3d1a2b82750dae\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toast.js\":\"bd3c7ce83bd59d66\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toggleStore.js\":\"00b2498312f6335c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/untilStopped.js\":\"4bd4ee7bfb8b5e99\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/userActivity.js\":\"3d24c7e316095d63\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewTransition.js\":\"9ef8edaaac80c14b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewport.js\":\"b06618cf57233475\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/webLock.js\":\"e05c26f4aed09cf2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceRecovery.js\":\"282d938620a1509b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceSnapshotStore.js\":\"df475ecf6d61e051\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-compiler-runtime.js\":\"9cfee2c99265ff6c\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-client.js\":\"33aab016486a0fac\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server-edge.js\":\"f87602312403fb85\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server.js\":\"9f415609443913c9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static-edge.js\":\"c850bdba5e8cc391\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static.js\":\"522b4c275290ae99\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-test-utils.js\":\"4c52e10a7ebc9c3f\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom.js\":\"8e459917db0ee4dc\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-runtime.js\":\"ad62ff180c0660d0\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react.js\":\"48fdbc628cd573f8\",\"/knowledge-medium/pr-preview/pr-1899/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
