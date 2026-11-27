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
		buildId: "76875aa07fa1-f279f56c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/\":\"2c7ee73232faefd6\",\"/knowledge-medium/pr-preview/pr-1899/index.html\":\"2c7ee73232faefd6\",\"/knowledge-medium/pr-preview/pr-1899/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1899/assets/FacadeVFS-B9jLqfab.js\":\"763eb4093bd8fee9\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSCoopSyncVFS-DtwLKy83.js\":\"f73515a3f3333054\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSWriteAheadVFS-BONy0fP0.js\":\"887ab736a6c34c93\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-DLFUAwdX.js\":\"a0e59f29cbc87ea2\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-BshiGTRj.js\":\"4e27ce816562316b\",\"/knowledge-medium/pr-preview/pr-1899/assets/worker-Bk7aBePL.js\":\"d82d7b0a70bac9ec\",\"/knowledge-medium/pr-preview/pr-1899/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1899/chunks/app-CLsqF8IN.js\":\"f00c3727c582ad0a\",\"/knowledge-medium/pr-preview/pr-1899/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1899/index.js\":\"0597fd4027db80e2\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1899/assets/AccessHandlePoolVFS-CyBIsY5o.js\":\"0af4b2b63384cece\",\"/knowledge-medium/pr-preview/pr-1899/assets/IDBBatchAtomicVFS-qTpzDvaH.js\":\"d09c029ddd907795\",\"/knowledge-medium/pr-preview/pr-1899/assets/MemoryVFS-Cbqj_-X1.js\":\"db2fee2b41dfcb76\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cof1KQIi.js\":\"e3aa4671dc972e48\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-C6Nt3FpC.js\":\"ad2ce872698709cb\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1899/chunks/AccessHandlePoolVFS-iprSIKpa.js\":\"d3455ec8d9bb66ab\",\"/knowledge-medium/pr-preview/pr-1899/chunks/FacadeVFS-PuBu-Gjl.js\":\"e67c75edbc37c31c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/IDBBatchAtomicVFS-j6oVLJyP.js\":\"740e051d190878cb\",\"/knowledge-medium/pr-preview/pr-1899/chunks/MemoryVFS-DLpczBS6.js\":\"b364750a9ca51d72\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSCoopSyncVFS-D9iHKszE.js\":\"d268acf282019a27\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSWriteAheadVFS-DgGsgxCs.js\":\"2cd76aae040f3c5a\",\"/knowledge-medium/pr-preview/pr-1899/chunks/Preview-tC2HD4RT.js\":\"1c32712af3ca949b\",\"/knowledge-medium/pr-preview/pr-1899/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/card-BnlIqlhK.js\":\"b9c9c31b1ddf4755\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-D5CRkP6e.js\":\"b26e71b23f921a38\",\"/knowledge-medium/pr-preview/pr-1899/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-KOTd-Jz-.js\":\"830f130835e933c7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-async-DXpyFyuH.js\":\"07d730191d5534b9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react--C1oRvy8.js\":\"64c5542ad9bf54e4\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-CZw8cE1E.js\":\"5f8bab3f8c7097a5\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-CnqHrLoc.js\":\"b071bc793fc8e5fd\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-D6P4wmz6.js\":\"20361641ce33c35d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DtL6WGnd.js\":\"c3279851ea6edc28\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DtmKAKZI.js\":\"c707afb44be8579f\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server-legacy.browser.production-cT5-P5EK.js\":\"a45fbd0c7befe4c2\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.browser.production-k1C0Krhp.js\":\"dedea484c73a1a22\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.edge.production-B28ND_HO.js\":\"d0317f1ac447fdec\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-r6Hpmvds.js\":\"8bfab3f423b4a2bb\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-whcZLaBl.js\":\"586326b84a5af5a1\",\"/knowledge-medium/pr-preview/pr-1899/chunks/server.browser-Zyi2qtLQ.js\":\"784bd5832a925a0c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/textarea-BBrzKmjc.js\":\"f09638a53dbe3658\",\"/knowledge-medium/pr-preview/pr-1899/chunks/ui-BMEIu5HP.js\":\"5f5d020aae98bf9f\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-async-KolfQSRg.js\":\"1536c52324bb822c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-jj9ouo2A.js\":\"026bb57fad7ed299\",\"/knowledge-medium/pr-preview/pr-1899/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1899/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/src/App.js\":\"9202e816d10f1c26\",\"/knowledge-medium/pr-preview/pr-1899/src/appUpdate.js\":\"61a54018ceb83d87\",\"/knowledge-medium/pr-preview/pr-1899/src/appVersion.js\":\"7b7d2711e8aff377\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/initialLayout.js\":\"8c59a6902d45b64e\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/openWorkspaceData.js\":\"4057e1d05c026973\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/resolveWorkspace.js\":\"0cc13f374f0eaeb2\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/workspaceBootstrap.js\":\"ac1152e86d782a08\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockComponent.js\":\"38784eefd444b3cc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockCrumbs.js\":\"7d6e01a665a691ca\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockEditor.js\":\"99e0c425caccb30f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockLoadingPlaceholder.js\":\"bf24580cb77f6b08\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockProperties.js\":\"23e431302a6cd33a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockSearchPicker.js\":\"71eb948f335c3258\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ConfirmBulkDeleteDialog.js\":\"d51cd5a259004def\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DividerHandle.js\":\"a996a2a54f2db131\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DraftEditor.js\":\"db8f93e7ba61397b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/GutterPill.js\":\"6970783bfaaf777f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Header.js\":\"0d60a72cf36e12ef\",\"/knowledge-medium/pr-preview/pr-1899/src/components/LazyBlockComponent.js\":\"4c20bf04a66ecc94\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Login.js\":\"306c5935e88d126a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ZoomableSurface.js\":\"30d7a05e68195e81\",\"/knowledge-medium/pr-preview/pr-1899/src/components/editModeKeepalive.js\":\"74249e645f42df9e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c6acccabf72da6a1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"c8729e3bd2126179\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefPropertyEditor.js\":\"b6872e61a05d1fc3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefTargetTypePicker.js\":\"9eb75791ffad3c60\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/SelectPropertyEditor.js\":\"15856723b25feaec\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/TypesPropertyEditor.js\":\"77cde6bbb6ed1b30\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/defaults.js\":\"efca6ca2e6da9ffd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/kernelValuePresets.js\":\"9ff0e8276930d769\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/selectablePresets.js\":\"605b2a1affb5045a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/typesPropertyUi.js\":\"30b8aa3e7375682f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/AddPropertyForm.js\":\"532f645720c30b70\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyPicker.js\":\"5dd826db97911851\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyRow.js\":\"29df93ae74104560\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/Rows.js\":\"21c48c633938b960\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/actions.js\":\"c7fe7e00b93efaf5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/declarationOnly.js\":\"e03546e3f6d3f3ff\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/layout.js\":\"5e4a3d7588dbe780\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/model.js\":\"881914a4130085f9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapeUi.js\":\"b29cae6be9c39b5f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapes.js\":\"29cb5855d3aa602d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/usePropertyEditingActivation.js\":\"86b131f7df797306\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/visibility.js\":\"c123f64308a2404d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanelSections.js\":\"91c0551f806441e3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockEmbed.js\":\"0f60c8c32badbd81\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockLink.js\":\"bdbf2315761bdb62\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockRef.js\":\"86f95eba08e79592\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/CompactReferenceLink.js\":\"9be37bcad1a348ed\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/ReferenceLink.js\":\"6528cf387fb7c80e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuard.js\":\"8cd2617b7393eb27\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuardContext.js\":\"bdecd57ae40db21a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/linkInteraction.js\":\"1d550de46a7fd153\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/referenceLayout.js\":\"a9bc328cb95e9bb1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/useBlockRefAncestors.js\":\"a531ec008f4bf166\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockGutter.js\":\"3c95ba4ad65edc3d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockInfoDialog.js\":\"6e9879e70b965eaf\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockReadText.js\":\"d3799b0f0b1f2d20\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockTypeBlockRenderer.js\":\"29cdc8128655bb45\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BulletHoverCard.js\":\"8446ccb97cc878ac\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorContentRenderer.js\":\"efce188ca4da41d9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"871ed2e5a0a7f92c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ColumnResizeHandles.js\":\"1db89c916892c1aa\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"009f09cd89d48663\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/DefaultBlockRenderer.js\":\"8b92c9b4e96844b2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/LayoutRenderer.js\":\"9e711d845ea3ddd1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MarkdownContentRenderer.js\":\"0867a16d84ef7ac2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MissingDataRenderer.js\":\"e4216f0b6752f6ac\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PanelRenderer.js\":\"a704f15c87bce9f8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ed05babecbb4e5f9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/TopLevelRenderer.js\":\"ab579bfba3f1e870\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockGutterMode.js\":\"55e35c1d68ad89b4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockTitleText.js\":\"43117457f2c0f635\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/fieldCreationKeydown.js\":\"21e4c1c723e84490\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/layoutRootContext.js\":\"cdb59557fe3dc6e8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/TypeChip.js\":\"cbae1b966c1d76a5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/chipStyle.js\":\"9b15e8a260122b25\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/anchored-floating.js\":\"15b190329ba838cb\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/button.js\":\"4cfb3768b332c734\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/card.js\":\"768074c47fadca67\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/checkbox.js\":\"8b9c44c576354623\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/collapsible.js\":\"03c09421f0a8b780\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/command.js\":\"274e14cd0cfdc8ef\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/context-menu.js\":\"18aec510f113c976\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dialog.js\":\"d51c0b43db7f6f69\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dropdown-menu.js\":\"91cfc4119391200a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/floating-listbox.js\":\"b124704a58f716b5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/index.js\":\"a712f2fbea01736c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/input.js\":\"d176cf2e31bcab94\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/kbd.js\":\"c26f922519dbd92e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/label.js\":\"59c4884dac56481a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/textarea.js\":\"e7ee1d9a4948a047\",\"/knowledge-medium/pr-preview/pr-1899/src/components/useEditModeYieldKeepalive.js\":\"1f2e3e074002b0b9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/BootFallback.js\":\"8cbcb158fdabeffd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/FocusedRowLazyMount.js\":\"5d9bdc4b777ec593\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LazyViewportMount.js\":\"af58154a17f165de\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LocalDbCorruptionFallback.js\":\"b8fe94654806dd84\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/error.js\":\"f100b65f6eea9593\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/lazyMountRegistry.js\":\"e76a59404aae078c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/suspense.js\":\"ce0f9b34c7f8830a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/CreateWorkspaceDialog.js\":\"329f544f2b9c89c1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/PendingInvitations.js\":\"6c1103d3b32bb015\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/SyncProgress.js\":\"8b4362340b74c51c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/UnlockProgress.js\":\"df7d03eaf1c7bdb8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceKeyGate.js\":\"a5db735ecd9dd9b7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSettingsDialog.js\":\"dbfb781313f7d8dd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSwitcher.js\":\"667efad3f4fdc9d2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSyncGate.js\":\"9be6d74a2a2e86be\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlow.js\":\"e53f9e8123b3da36\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlowHost.js\":\"0b0cd58aa04a316f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/EncryptionSection.js\":\"86411327902dd353\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/attachmentPrompts.js\":\"fbf1526a0ae70e70\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/bundleFolderPrompts.js\":\"e3fa28da91d065ad\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowDeps.js\":\"8e4f6a3f4224bda1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowStore.js\":\"1725006a982133a3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/flowUi.js\":\"bb9bd0d52f7566a3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/useConversionRun.js\":\"f52c50e580f76fb0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/keyUi.js\":\"63c7045ce7abf67b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnKeyLoss.js\":\"77bb423ec256471d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnServerE2ee.js\":\"28118149ca6c5486\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/workspaceUnlocked.js\":\"fc514677cfa60ab8\",\"/knowledge-medium/pr-preview/pr-1899/src/context/backgroundSubtree.js\":\"07912e2dcbd8e975\",\"/knowledge-medium/pr-preview/pr-1899/src/context/block.js\":\"d203d120dce51312\",\"/knowledge-medium/pr-preview/pr-1899/src/context/layoutWsContext.js\":\"cf6e71dc4e185120\",\"/knowledge-medium/pr-preview/pr-1899/src/context/propertyDisplay.js\":\"1e146cd383e651a1\",\"/knowledge-medium/pr-preview/pr-1899/src/context/repo.js\":\"90c28d13ed84b0a9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasClaim.js\":\"ae9021ac5b249348\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasSeatNamespace.js\":\"b38a0c17cebf7c80\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockData.js\":\"447ee458ab7ed05c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockType.js\":\"9b812ee935f4fc45\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/changeScope.js\":\"55dc4d14b9537da4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/codecs.js\":\"26c8fcfbd2034169\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/derivedData.js\":\"ebc9461ae3c3bddf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/errors.js\":\"94b665025dc5cbc3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/events.js\":\"88977bbb1d3011c1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/handle.js\":\"67dd1a84109f14e8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/index.js\":\"9626232b296c2a89\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/mutator.js\":\"2f1a943136f1ab2d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/processor.js\":\"e80b85457bdc1974\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/propertySchema.js\":\"7b50f5246dc82d6a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/query.js\":\"b97d884c07cecf0c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/sameTxProcessor.js\":\"004670974b415818\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/schema.js\":\"67dd1a84109f14e8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/tx.js\":\"67dd1a84109f14e8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/typedBlockQuery.js\":\"a3e3ec4df0c2a756\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/user.js\":\"7f20b22760e3b599\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresetCore.js\":\"c15159257a5ae922\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresets.js\":\"f87ef88f791b66c8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/attachmentCleanerIOVerb.js\":\"d075447612aed5e8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/block.js\":\"8649fdaf70d3c8cd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockCache.js\":\"d5d7ed90aec64e22\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockId.js\":\"63cb149682e1b493\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockLiveness.js\":\"6f5e9ce0269ed17d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockMerge.js\":\"f26005f747409ae6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockSchema.js\":\"5f2c93b6efc49be3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypeLookup.js\":\"fd19795d357d19ad\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypes.js\":\"02e4b3c71e96a5f5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/childrenView.js\":\"73ba954d3fee5c95\",\"/knowledge-medium/pr-preview/pr-1899/src/data/clientContext.js\":\"dedbcbffb70d8da8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/dbFileSiblings.js\":\"136544c4e31aaa2d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/definitionSeeds.js\":\"0db41ea79f6d0686\",\"/knowledge-medium/pr-preview/pr-1899/src/data/derivedIds.js\":\"9f266c90355a2f24\",\"/knowledge-medium/pr-preview/pr-1899/src/data/drawnSubtree.js\":\"aa056b3ff8af00f0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facetBridge.js\":\"d6a273e5eb82fad0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facets.js\":\"2c450838e9d65341\",\"/knowledge-medium/pr-preview/pr-1899/src/data/globalState.js\":\"4ab7ac79624e6839\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/aliasClaimRederiveProcessor.js\":\"fef81f4b6fff9735\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/ancestorBatch.js\":\"02ce58161e898ce4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/blockTypeTypeifyProcessor.js\":\"e41f687834968e39\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/clientSchema.js\":\"24ab2cbcdbf61cf1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/commitPipeline.js\":\"cbe09e2bbfeeeac5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/devAssertions.js\":\"2ab2036276c0447f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/firstSync.js\":\"b6810f563baac75d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/freshInitialLoad.js\":\"96b2e633d3ce84a5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/graphBackfillClaim.js\":\"722d30572c795b8d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/handleStore.js\":\"4271dbf60ac3b52d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/idleMarkerJobs.js\":\"0cc5a2fa11df89f5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initialDownload.js\":\"c090e75f23d00fd6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initializeClientDatabase.js\":\"81952b52f67cfc5a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/jsonCanonical.js\":\"d07595ad1dc540a8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelInvalidation.js\":\"466f8f349dc845d7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelProcessors.js\":\"8db8bad7e40746be\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelQueries.js\":\"249792435e1f809f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/mergeTypeMembershipProcessor.js\":\"92c360a49bd77ee8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/normalizeReferencesProcessor.js\":\"f36e694d9094f038\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/poolInstrumentation.js\":\"557de01b3c0390ed\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/processorRunner.js\":\"04844fba416b4273\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyCellBackfill.js\":\"37b32ba3c9c8e7b8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildMint.js\":\"bee90bd9e092a33d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildrenProcessor.js\":\"3a6cc0b8a86aca07\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionChangeProcessor.js\":\"0b7d80464def968b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionSynthesis.js\":\"9706e7df7f5052ae\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyKeyScan.js\":\"368c95cd8dd756ba\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertySchemaResolution.js\":\"904a91d87893b82c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyValueEdits.js\":\"955023b6e84a6229\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/raiseProtocol.js\":\"f1e8314799b8635f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/readBatch.js\":\"c8193a7c413bc8f5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/refProjection.js\":\"059af40dcda6d581\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetLookups.js\":\"d1415c0f26c490a4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetProcessor.js\":\"744b969da68d5b52\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/replayMerge.js\":\"85e384379e9a9221\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/sqlBinds.js\":\"ea868c113a248de2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"3052334dc3cd095c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/arrivalProcessors.js\":\"54b64f37444eeffa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/invalidate.js\":\"2562bad8b00e1038\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/materialize.js\":\"4ae85ab590f81ffa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/observer.js\":\"1e88bf82bd6a374f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/reconcile.js\":\"ababfd1df206c0c5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/timingMetrics.js\":\"0344828e637d94cd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/treeQueries.js\":\"37c4453380ea7ce7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txEngine.js\":\"0da81b42969b2991\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txSnapshots.js\":\"796ac252b67f6de3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/typedBlockQuery.js\":\"217a6b152ec8feb0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/undoManager.js\":\"dbe8ff0b6e1c67cc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/invalidation.js\":\"4a507a771dc93ae0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelDataExtension.js\":\"ce5ba21276b9579d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelPage.js\":\"bc399fe5d1b9f34f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelValuePresetCores.js\":\"faee24ca72ecb9c5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbCorruptionSignal.js\":\"2a7825a97ce4871c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbStorage.js\":\"64d24caad2373c89\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbVfs.js\":\"a1ff0db5d420bf35\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localSchema.js\":\"fda2e20405c70702\",\"/knowledge-medium/pr-preview/pr-1899/src/data/maintenance.js\":\"dbadd1d4b390a098\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mergeProperties.js\":\"dc194de189204314\",\"/knowledge-medium/pr-preview/pr-1899/src/data/metricsConsoleHook.js\":\"5f486dc35fb08b31\",\"/knowledge-medium/pr-preview/pr-1899/src/data/migrationsPage.js\":\"1587da7486473cc1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mutators.js\":\"889815f9d3ef2593\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKey.js\":\"fa2445db0c5cec3b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKeyPlacement.js\":\"f0e4ae48e5b85df7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/outlineSurface.js\":\"bb2b11216082da69\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingEditorContent.js\":\"884c7d9553546272\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingUploadsSql.js\":\"c2f5330e5acab874\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pluginStateExtensions.js\":\"91d65ed215f94bc9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/powerSyncLogger.js\":\"8bde6239e4e668a0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/projectorRuntime.js\":\"6aae44b1f447d0a2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/properties.js\":\"8745b19622414c2e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertiesPage.js\":\"6da3f649f9b84054\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyChildren.js\":\"7a1fab39b0f44dae\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionFanout.js\":\"82e2865307a3f56a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionMetadata.js\":\"2e99ffd9fadf7f2f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionRegistry.js\":\"e7c72547ffb778dc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDisplayMode.js\":\"878168f9513d0a23\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyRowCreation.js\":\"392044be8702b9ea\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySchemaCreation.js\":\"49eba0382138d45a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySeeds.js\":\"f3af26f251463df2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/recentsPage.js\":\"315b193f8a4e40f6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/refTargetComparableProperty.js\":\"c5a7f8abc7d0449a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/referenceBlock.js\":\"0189ccf1529b3289\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rejectedUploads.js\":\"6bf18c976228d7d6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/releasePowerSyncConnection.js\":\"9c6678504896d77b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repo.js\":\"292ac2152d567263\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repoProvider.js\":\"dd07da8c407d5a19\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rowProperty.js\":\"ad5b4a777b397c61\",\"/knowledge-medium/pr-preview/pr-1899/src/data/searchFilter.js\":\"9263951b2fc215b3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/seedIdentityLedger.js\":\"bc7140cde802ec5a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/stateBlocks.js\":\"6cdab4b1da35c672\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralEditPolicy.js\":\"0ce39074cd2cd01d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralInsert.js\":\"1d6df44880b77e92\",\"/knowledge-medium/pr-preview/pr-1899/src/data/subtreeDelete.js\":\"22f4a71e8e756ed8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncStreamLock.js\":\"1296499790e80c15\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableSqlRecognizer.js\":\"0a5ef28c1a76ec7c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableWriteGuard.js\":\"877a4beafc3046ca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/targets.js\":\"2876e017304b3704\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeColors.js\":\"aca56a679527bcb0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionMetadata.js\":\"12c4bf3e1330a2ca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionRegistry.js\":\"1b8c2230c7007d60\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeExtraction.js\":\"a6d26d84816c2d01\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeInitialValues.js\":\"99a01d0e1945928b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typePropertyGroups.js\":\"79dc4449259f583f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeSeeds.js\":\"92d0bde44a33b3cc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeTagger.js\":\"13d5d62e8675a9e0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typedRecords.js\":\"4ce30b34b3123c0f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typesPage.js\":\"b66e07e5a9471c1c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userPrefs.js\":\"38f149844da4793a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userSchemasService.js\":\"5281f52015d4c829\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userTypesService.js\":\"fc144879dc121021\",\"/knowledge-medium/pr-preview/pr-1899/src/data/valuePresetRegistry.js\":\"e564723687fea9ae\",\"/knowledge-medium/pr-preview/pr-1899/src/data/visibleChildren.js\":\"e206dbbc57b49d3f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceConversion.js\":\"32f2daa7499c3b78\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceFirstSync.js\":\"6700858485394d38\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceIdNamespace.js\":\"5795a01ac03fa7f0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceSchema.js\":\"5fa193ae822ca2a6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaces.js\":\"b814b9541a183d22\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadLog.js\":\"3f940a1b0601a3cb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/BlockPasteShellDecorator.js\":\"992016d0e6fc9804\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/atTrigger.js\":\"2bf8944372cff587\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/autocomplete.js\":\"48897914edeaf808\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/codeMirrorExtensions.js\":\"a60c85872d1ecb5f\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/contentFlush.js\":\"c6ae0e52c6188adc\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/defaultInteractions.js\":\"5bdadebf15f84f04\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/editSettleSignal.js\":\"842fd7bfcd732eb2\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/insertImage.js\":\"b2a37786107d37d6\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceCompletionRange.js\":\"fae2194d0dda2adc\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceTargetTypes.js\":\"333cb89dd467cbdc\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/syntaxContext.js\":\"090727e62a638758\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/triggerMatch.js\":\"bf971fb71d8aa5b1\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/AppRuntimeProvider.js\":\"bb215ec448ddff18\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/BlockFocusShellDecorator.js\":\"7efdf7a6f237ebf8\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/ExtensionRenderBoundary.js\":\"1fb3391d5db9e2cf\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/PanelContentRecovery.js\":\"df0f0e4bd4457e46\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/apiCatalog.js\":\"0388287833a75194\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/approveExtensionHere.js\":\"63fe2e4a337651ad\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/armedCutAppMount.js\":\"25fdc93cff03e1cb\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/batchableKeyedStore.js\":\"920519306e03d8da\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockInteraction.js\":\"3167877a85289904\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockSelectionAction.js\":\"244d0e2bac729b27\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compileExtensionModule.js\":\"9f874d61d89c8190\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compiledModuleCache.js\":\"60067a24c98aee97\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/continuousGestures.js\":\"49a4d0ecd8f37104\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/core.js\":\"e4a68cb71fb72e92\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/defaultRenderers.js\":\"aed24b21239ab4a9\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/definitionFanoutAppMount.js\":\"dd32bd0760b8abaa\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dialogAppMount.js\":\"b5c4d6d5f7ff913f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensionSeeds.js\":\"6845ead2f97906c4\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensions.js\":\"db064dcac16bad76\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/exampleExtensions.js\":\"a7b3dfadd3fac4b6\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionApprovalStatus.js\":\"a3777d63c7282c74\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrorToast.js\":\"f6d3590a11dd06d9\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrors.js\":\"b36f1296335d7ee4\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLookup.js\":\"12726e23e6fada91\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionToggles.js\":\"e41955395edf1a66\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionUtilitiesCss.js\":\"f56d25789a416010\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/kernelPageDeletionGuard.js\":\"68f4db19dfefe7b9\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/liveRuntime.js\":\"15b68ffe3c048021\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/openExtensionsSettings.js\":\"bed1e0d087472aa0\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/overridesCache.js\":\"c76828aea30817e2\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/pluginIds.js\":\"346ec6ced6b26745\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/processorRejectionToast.js\":\"464fb9e3712103ee\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeActions.js\":\"85d8dadaf4d64ec8\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeContext.js\":\"a1d8bb6419ec96a2\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticAppExtensions.js\":\"d10365e59f3857a1\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticDataExtensions.js\":\"f3851d0e77f0af2f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/toastAppMount.js\":\"ddb6e17fe57cb87f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useOverrides.js\":\"f8e224ee948a9f29\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useShortcutSurfaceActivations.js\":\"06e6e6f6c1673294\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/discoverToggleTree.js\":\"719dc8d0458f790b\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/facet.js\":\"2a38ef2d6456d3bc\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/resolveAppRuntime.js\":\"d273a2795176d683\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/runtimeEvents.js\":\"86a31b2d9d67a14e\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/togglable.js\":\"5b2c151609fcbc71\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/variantFacet.js\":\"37f5cc8420fd5440\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/verbFacet.js\":\"95f6fdb197069bfa\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/block.js\":\"5aee787b909d5432\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/focusedChild.js\":\"3c9c21399ca49213\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/propertySchemas.js\":\"c4a864328eaa9e80\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/typeRegistry.js\":\"8132893da1b46f3f\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAncestorCrumbs.js\":\"ccfb620243f98848\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAutocompleteListbox.js\":\"53d4371d41920126\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedSearch.js\":\"4c6808799c5d55bc\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedValue.js\":\"42072c425c32fbd2\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useFacetValue.js\":\"056085912aea980b\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsFocalRender.js\":\"f8fa921ed945161e\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsReadOnly.js\":\"c82f6e5ff8d398f0\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMaterializeBacklog.js\":\"66ba9fd8c6062ac4\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMinuteClock.js\":\"263db66b06e12e6f\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePanelLayoutProjection.js\":\"99cb1cb2b8246438\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePendingInvitations.js\":\"fdd24c078b4c1d6a\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRendererRegistry.js\":\"3b942a19ad5a0ddb\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRetainedFieldRows.js\":\"ea568827be706691\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useWorkspaces.js\":\"ef9edc0aa7950608\",\"/knowledge-medium/pr-preview/pr-1899/src/lib/utils.js\":\"7e6767c48ad2d395\",\"/knowledge-medium/pr-preview/pr-1899/src/main.js\":\"bf8f080971c9c923\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/MarkdownImage.js\":\"32b09a7d28304bc6\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/blockSeparators.js\":\"865dd011a914e939\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/context.js\":\"620e5acf5f385032\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/defaultMarkdownExtension.js\":\"775ed7d0f585bece\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/extensions.js\":\"46706d5f15bc95e4\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/renderMarkdownHtml.js\":\"ad3cb9cbc2ca018b\",\"/knowledge-medium/pr-preview/pr-1899/src/minimal-editor.js\":\"7e9f924705daf28c\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/armedCut.js\":\"b846f57bfc7fe757\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/captureMediaVerb.js\":\"35a58993c0fa8476\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/clipboard.js\":\"84b96e95093a8378\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/decision.js\":\"6e049a3b2d58c10f\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/operations.js\":\"add456beb7c1dd75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/AccountHeaderItem.js\":\"4fce16ebcc6bcef1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/index.js\":\"d9c2809968cb3d51\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ef91bdd457271142\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askAgent.js\":\"069370f19e70d243\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askedStore.js\":\"989b9e03e079de76\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"81003d6fc2562ba3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/chipState.js\":\"e35bf70e91b6e48a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/dataExtension.js\":\"bb66d9c2fd04b985\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/index.js\":\"6871294ef290024e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e55750c125e091b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/schema.js\":\"0cbe9604e836c892\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/AgentTokensDialog.js\":\"38fc5ed16410fa45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/BridgePairingDialog.js\":\"617897ebb7dc7ccf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/addMedia.js\":\"deb80914df927aeb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/backlinks.js\":\"97bcba936eabc6ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/block.js\":\"61b986dab7709adf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/context.js\":\"f9cace842d564055\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b7d63ea83b7c673d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/index.js\":\"5fd7a63d5d8450d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/outline.js\":\"233114a558954cf8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/properties.js\":\"aa0db78dbae0883b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/refs.js\":\"1078aa8fec2fb4a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"5c4f4f99bb4022b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/search.js\":\"5ff2d71bd711bcc3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/shared.js\":\"4f8d503641518aab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"93ffe80902332343\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/text.js\":\"95b9ec4b0211936a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentWrites.js\":\"01cb9d698731d478\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/authoringCatalog.js\":\"6f1c045baa6d3ea3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/blockRefTargets.js\":\"487ffe446b11ef78\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridge.js\":\"bb2be2ed354f9376\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridgeLoop.js\":\"d8f48472aeccf93c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/changeHistory.js\":\"df85db8f4334f997\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commands.js\":\"03efefdf2d6515fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commentsCommands.js\":\"11af1f9176de1458\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataExtension.js\":\"d3d6e7bffb7042f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataModelGuide.js\":\"fee6aaf38c349f94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dayPropertyInputs.js\":\"c73e9fcc19f76fa9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/describeRuntime.js\":\"a7b79d7b007dfa05\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/extensionLint.js\":\"f672568f19ef9783\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/grainAudit.js\":\"9afb36f6aad63a89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/healthCommand.js\":\"261292fc5092fb0b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/index.js\":\"7230e31a089fcab9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/presetIdentity.js\":\"fbfbebf367ca51b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"72d8a3df0deae764\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/readMedia.js\":\"32a5a0491ffc0782\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/schema.js\":\"235a0601a8e3b6a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/serialization.js\":\"85390f89b84fa1f1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/targets.js\":\"e5dc31974f3c9564\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/tokens.js\":\"c1a48cade08d2b79\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/watchEvents.js\":\"12caafe40e55a602\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/workspaceGuard.js\":\"a02afe44b694bdb6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/writeCommands.js\":\"8e35ba0f98db04fb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/AliasCollisionToast.js\":\"31e9523660f50a56\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/DuplicateNameBanner.js\":\"d62565f66bc3330d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/collisionMerge.js\":\"1819aa6dad8cbb94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/dataExtension.js\":\"0b7575930c849ae1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/index.js\":\"faf87afba4dc9dee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/mergeCollisionAction.js\":\"7336f7678d59f948\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/pageStyling.js\":\"614ac5bb09c19b63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/rejectionToast.js\":\"e5e23a929fb9b344\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/syncProcessor.js\":\"f94c6eacc243c139\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/actions.js\":\"0b2197b1f7d5c337\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/addComment.js\":\"7a9583462270dd5a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchor.js\":\"13bdbfc63168e1a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchorState.js\":\"0a7a747b8ddb3490\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/commentLinks.js\":\"743b9f9a2b712e9f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/confirmThreadDeletion.js\":\"fe3563ad7883ef2f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/container.js\":\"1290a296b48c6758\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/dataExtension.js\":\"1a6a087aba413c35\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/deleteComment.js\":\"fd80c16bc212d90d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/highlights.js\":\"33d8272887152c4a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/index.js\":\"2d07cee3963d9d14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/linkedCommentsPill.js\":\"f78fc194bf9dbeed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/margin.js\":\"b271bf396b1c4c01\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginAnchorLinks.js\":\"847332e97ba573b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginSchema.js\":\"a327fb054fd41e38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/newComment.js\":\"9bdac9d4e54ed26c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ownThreadPicker.js\":\"9737883750f3076b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/placement.js\":\"f87c29f5ca95c959\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/queries.js\":\"94512b1ca92f72f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotePosition.js\":\"79d06d42093d265f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedIn.js\":\"87dc49e58572d793\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedRange.js\":\"9dfd6a6b11cabc11\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/rangeRefs.js\":\"d94bd1b37e4501dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readHighlights.js\":\"92906b5d02caf72a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelection.js\":\"eefb28e98576c59c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelectionUi.js\":\"bfa211a8f21312c0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/reanchor.js\":\"3226dceabe908de9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/schema.js\":\"17892ac82e6c66ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scope.js\":\"aa8488a715ea2198\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scopeThreads.js\":\"84fe52012c050c4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/splitRetarget.js\":\"29a9a5bb202eb092\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestionCard.js\":\"6cff6c3a898eb006\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestions.js\":\"73ffe5e250ca04cd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaries.js\":\"5b5a214ca472e2e4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaryBatch.js\":\"907447b14da4b3a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/surface.js\":\"8c0c513857cd004f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threadNavigation.js\":\"53bece7a1894fe6a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threads.js\":\"376de1751e343fcf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ui.js\":\"fde2b9f3733c3232\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/uiStore.js\":\"54ba9e7a08fdae9f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/appIntents.js\":\"fdec7be9ecd2de6d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/index.js\":\"97c9f3e49172bd61\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/index.js\":\"6c65d09c8c2c270b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/status.js\":\"c2ca3e99e6f1024f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"680a46fc115e9356\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaBlockRenderer.js\":\"b1b8375fde61205c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaDownLaneReplicator.js\":\"006d3254e30309c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaUploadReconciler.js\":\"18bb54e29705bb42\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetDownLane.js\":\"b890fb6b9c014411\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetResolver.js\":\"aa76708a4ddb628a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetUpload.js\":\"56d5b61a10458f28\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/attachmentCleanerIO.js\":\"b5f306dc94e05fed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/supabaseAuditIO.js\":\"11796ed3975774b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/blobStore.js\":\"de69e7a9c96723a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/browserMedia.js\":\"1e86ad8f4ff97452\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/byteStore.js\":\"f1f23f8b3871c076\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanerIO.js\":\"5d99123f48b4eb4a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanupAttachments.js\":\"4cad415ec573a39a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/dataExtension.js\":\"d9aacf3a72191f4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/downLane.js\":\"b1a522c41d3f27e0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/index.js\":\"20df2484ae117408\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/insertImageContribution.js\":\"9a5d230fff52c64a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneArming.js\":\"1253ad9f7a346b3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneLock.js\":\"6e28cb5b91596873\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaBlock.js\":\"d838f5348219a24a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaCapture.js\":\"0260a3d52172f20b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaLanes.js\":\"ef62d0dc05969939\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewers.js\":\"033a697a1766e49b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewersFacet.js\":\"959d4be53793d7f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/pasteCapture.js\":\"95557ed435a532a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/resolver.js\":\"455f69bc3043fa75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/retryUploadsAction.js\":\"0fc86509637852b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/storagePaths.js\":\"3aee59dc1f6322e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadDrain.js\":\"2e5e0fbd933b55d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadLaneStatus.js\":\"6b8cb8d0481b4bd8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadReconcile.js\":\"54a12f244ac6ee12\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadRecovery.js\":\"2f67e559c3497607\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadStore.js\":\"b40a1b2a073fc6a3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/useAssetObjectUrl.js\":\"0dd012056776f6d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"51dd96aaeaa33664\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksViewSection.js\":\"f52ac11ad49e11df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/facet.js\":\"6ef030563001d42d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/index.js\":\"14c17cfc97cd7f2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/prop.js\":\"51990a4d1ce66c5e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinkFilters.js\":\"1c2eda7cd2ca5f6c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"588fbadd3d0d0180\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BlockEntry.js\":\"def278d77e8845b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/LinkedReferences.js\":\"a77f66635c0b75cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c82884a8845112de\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dailyNoteDefaults.js\":\"506519349b5383ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dataExtension.js\":\"7b8db1db38ba3e49\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/edgeExclusions.js\":\"326bd564e6e83208\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/filterProperty.js\":\"e894c86ce7a1667e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/index.js\":\"ea9e1a2632bdab7d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"4bde581b05c640a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/applies.js\":\"53bd5473cf06bfbc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/countQuery.js\":\"d1bde2de03ca3143\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/expansionStore.js\":\"cb2bfd01815dfef8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/index.js\":\"5008de43cffb9399\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3728db3e443d099e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/presentationInvalidation.js\":\"e58c174d51f20304\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyEditorOverride.js\":\"cf5e33b3211505bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyFilter.js\":\"de35c2d314b9196b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/query.js\":\"99fbf6048a0013a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/resolveFilter.js\":\"02c577fb234b702f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sourceBatch.js\":\"95c90aba9c2b0f59\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sources.js\":\"754ecd3895ff5cf4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useBacklinks.js\":\"47e3448a814b7509\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"f801838256cd3076\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayCelebration.js\":\"f3a7ed8cfdcf1feb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayOverlay.js\":\"624595da5443a523\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/gate.js\":\"07446bc92fc55dd7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/index.js\":\"0768b4f6b7239f3f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/wolfTheme.js\":\"ac3e3ac57c4724b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/BlockDragLayer.js\":\"6445cdbca16ea66b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dragController.js\":\"503a4be922298c8e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dropTarget.js\":\"1e74d3b5f8b27002\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/index.js\":\"297968d0d204504d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/projection.js\":\"5e535dacaa70b48d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/BlockMetaCard.js\":\"3c0a9517bb661f7e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/index.js\":\"1eac0557b6ebaa1f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/AddTagDialog.js\":\"8a7b505b05bdda29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6257aaf6e58b9c91\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/TagNameIssueHint.js\":\"b87448619d54ec2e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/addTagAction.js\":\"7676e0696c2b2ec6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/appendTag.js\":\"eac34709cf6a6870\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/config.js\":\"85e09cf211891a7e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/dataExtension.js\":\"0e749a84583d3e0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/index.js\":\"3b08725011765613\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/propertyEditorOverride.js\":\"ed8d6f96aade8d4e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbList.js\":\"49712960573573db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"01c85e3c7b5171e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/Breadcrumbs.js\":\"60d09f97eb862059\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"437f321b789c1e6a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ec8f43f7df797b09\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/index.js\":\"7f4cee0a0eb87509\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"db3b3ccca83dd016\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/CharacterCountItem.js\":\"bc83f33d6125cb9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/ProfilePropertyEditor.js\":\"30f43057d7c52219\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/actions.js\":\"19cf0aa6e1fb5713\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/blockType.js\":\"47bb55a87267b120\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/charCount.js\":\"c69fea927d3906ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/dataExtension.js\":\"0914f3209b29e890\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/index.js\":\"9d14086e53d97135\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/profiles.js\":\"3c5b94b86cf2dd56\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/properties.js\":\"010b0b9d718f3e7d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/subtree.js\":\"93ec317cecea7a3f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/textCounts.js\":\"fd0bc1cf6314c7d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/colemak-keybindings/index.js\":\"c0b4599222a76d66\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/CommandPalette.js\":\"043ea522fe1e00eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/HeaderItem.js\":\"b805d255c2eccc52\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/context.js\":\"b015b1802ab214f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/index.js\":\"97a599c68bb011dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/selection.js\":\"806401d0c76bade0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/toggleStore.js\":\"1a3b752229a17514\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/useCommandPaletteActions.js\":\"c5e474693217e9db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ContributorBadges.js\":\"0ac49d4bbecc73f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ProfilePicture.js\":\"93143699eece735d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/author.js\":\"cb26c211a5eba961\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/codeMirrorExtensions.js\":\"843e26694eb9b316\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/dataExtension.js\":\"3892b74ee1db7cd6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/index.js\":\"512f10ec392232c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/mentionAutocomplete.js\":\"7a044526cf0bb0f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/processor.js\":\"408cf4462b3952da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/profiles.js\":\"06c9c3bb3de45c84\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/queries.js\":\"0dc4ee413acae5aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/schema.js\":\"a3a0618df54b496c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/useCommentAuthor.js\":\"e23de4d41a4888f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"57b4fe90b8f4536f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7113669b08ff9449\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/index.js\":\"e263585edc46483d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d98c34a3156cc8ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0efee8347d47fe08\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/CalendarGrid.js\":\"0f82ef91ffdaa496\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DailyNotePicker.js\":\"873215e76f8f94df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ca78485c4892af2a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateNavDecorator.js\":\"48d69c2360049348\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateScrubOverlay.js\":\"754f305c95a1833a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayPropertyControl.js\":\"188b67702bd1a373\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayValueReferenceControl.js\":\"d5e295c5cc5d3196\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/HeaderItem.js\":\"5903f771780e24e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/ReschedulePicker.js\":\"cc2bcb994e812dc5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/SpreadDatesDialog.js\":\"606b5140975daded\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/actions.js\":\"096f35033d9a6df7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/blockDateAdapter.js\":\"c29a38c8e29a4b43\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/calendar.js\":\"2d5363835f840162\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dailyNotes.js\":\"b5835c2359ec97b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dataExtension.js\":\"f49caa7e6dc6feb8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubActions.js\":\"8b45fc88da06ff90\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGesture.js\":\"6e2456cfefa20e49\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c237085b9f942268\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1cd49482b661cdb3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayProperty.js\":\"15646a3167418458\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"54d951732623065d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/deletionGuard.js\":\"80f67032e214e644\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dueQuery.js\":\"4da411a52f360f26\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/index.js\":\"13666c7d538ef023\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/landing.js\":\"d95b0164939c6518\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/localSchema.js\":\"6dce5537662729a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/referenceDateAdapter.js\":\"280006996f52e957\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/rescheduleAction.js\":\"b1b29d7c2a1ef1ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/schema.js\":\"9c53c8a30103fd2a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadBlockDates.js\":\"0fdcdde0aba73c65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadDatesAction.js\":\"0a19333b8b85fee5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/today.js\":\"3565128af38a8a8e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"43d1cdbc50a9d2f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6c258ddf6ec2fbbc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/audit.js\":\"b85aec530992ae84\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditAction.js\":\"7b8216939d9dde2f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditRanges.js\":\"36bd0b996638f8bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/diagnosticsSource.js\":\"8b56b8a5e24a4570\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/divergenceScan.js\":\"75fe6133a47306c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/index.js\":\"f7922b42e94f884e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/propertyChildrenChecks.js\":\"2f3a0fe7f80b171b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/referencesMirror.js\":\"70cd8f1bd994f3a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/rowJson.js\":\"493c4a05ea0de0c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/schedule.js\":\"33bfb0c288879af1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/store.js\":\"19ae85fba4216534\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/action.js\":\"cb84abd70c156029\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/index.js\":\"8abae2038e0bb886\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/plugin.js\":\"b552bcb67a42f696\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"11ad4e0868cbd3a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/actions.js\":\"baa83ba2768b2930\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/changeMarker.js\":\"a18bc6369e4d17ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/diagnostics.js\":\"f7add3bf30f52891\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/fileSystemAccess.js\":\"498c36086167e8ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/filenames.js\":\"372249409d14b8e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/index.js\":\"ff5466f663844f32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/mirror.js\":\"1639cc8eecb5fa3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runLock.js\":\"5160368a3fb1b243\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runtimeHealth.js\":\"03c724858880314d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/schedule.js\":\"1767fcaf6cf2781b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/store.js\":\"cebf0f668701d7c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/index.js\":\"39ec216663682cc2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/themes.js\":\"58cba6a366e86b3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/facet.js\":\"340bd6d775790dad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/useDiagnostics.js\":\"9ff3036abae8fbd9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/dismissals.js\":\"826f670d2911f811\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/index.js\":\"89e74c7b85c0e6bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/status.js\":\"48756fda3feb27f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/store.js\":\"0395f4e9bf95bb6a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c8e8d8229e0abe16\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a630bed32dffb4c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/actions.js\":\"6736e295437ce26c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/config.js\":\"6cf769fc34146e67\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/dataExtension.js\":\"9c58b40e7f7f10ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/effect.js\":\"a294f9fa30a5e55b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/index.js\":\"75b17ec287ce659a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f517c30bd032c7bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/useToggleTree.js\":\"cee8f35872e26a21\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/ExtractTypeDialog.js\":\"e66a50ddef616f2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"2d6b3cfd9412ca0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/PropertyShapePicker.js\":\"68195e359e5d7180\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/action.js\":\"c4ed2eb9cce9ceb1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/index.js\":\"d47dd781605b3a37\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/FindReplaceDialog.js\":\"c81f2a02dae76058\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/HeaderItem.js\":\"0a77613dccfbfb16\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/dataExtension.js\":\"cf7d6b6f33e3ba08\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/index.js\":\"bfbac5e3469eb2a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/search.js\":\"cf799698b1489855\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/toggleStore.js\":\"5ecc772b99461240\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/LocationPropertyEditor.js\":\"d0483c4ccbb6fc53\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/MapView.js\":\"25889d636c384d01\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/blockTypes.js\":\"939ff3b47958a66b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/codeMirrorExtensions.js\":\"c6f5295619c23e6a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/createOrFindPlace.js\":\"25b70fe8d5ece05b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/currentLocation.js\":\"678df05604ffef72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/dataExtension.js\":\"4945d9badb035459\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/geoContentDecorator.js\":\"ff5902bd423ca1fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/googlePlacesClient.js\":\"153851fa85800946\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/index.js\":\"d77828e4750cb7e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/locationsPage.js\":\"e111d28ac8f3b71c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/mapViewport.js\":\"f6e9f03ca29359f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/pickCurrentLocation.js\":\"b167be5257c417ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeAutocomplete.js\":\"6e73a03f85ee02f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeNameCollision.js\":\"c9c5daecc13d39a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/properties.js\":\"485756939f89dbde\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/propertyEditorOverrides.js\":\"77900a232ac138ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/query.js\":\"0978afcb05ec6007\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/usePlaceSearch.js\":\"3d28fbd873eea5ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"8a348ab08ac4220d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a04fa9443a17a37c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d6c377cb9dc93348\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/config.js\":\"535c7e616bc4dd04\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/dataExtension.js\":\"c7523f0c7af698e4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/facet.js\":\"a0808a56cd2eb08d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/grouping.js\":\"224d83bda673d28c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/index.js\":\"61636b18dac95e14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"a8bbfda12e821f64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/query.js\":\"fa1715a55cc7bd4a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/resolveConfig.js\":\"54d9656a3d9002bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"155c1d98eb5385e8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8604ffee6db6f0d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlDocumentContent.js\":\"0b55367f382bce3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlFrame.js\":\"b8b3063f1d48db56\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/actions.js\":\"142aec8a4ac2d55d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/blockType.js\":\"c48af268c1e38d76\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/confirmRunScripts.js\":\"290f9177e6f3b7d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/dataExtension.js\":\"c9e73dc151620645\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameAnnotations.js\":\"3715638d9bbe018b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameDocument.js\":\"4b317c74655853e3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameTheme.js\":\"8d6dcfb8e110ec66\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/index.js\":\"263c2a14eacce4f0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/scriptConsent.js\":\"09a74d69650e284f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/sourceMap.js\":\"091858d076aa1780\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/useDocumentScripts.js\":\"ca7e43756d717457\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/index.js\":\"e380698105b67a06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/record.js\":\"b5d049a5f9543bef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/recordStore.js\":\"b4c97d91eab5a96c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/responsiveness.js\":\"3d3e6f3343a1d12e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/schedule.js\":\"67acc88314663348\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/sessionContext.js\":\"1ea63284fcd134f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9a90c93497d88e13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"15694ad053ca303f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/actions.js\":\"070866a47c1ea5b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/config.js\":\"5da5dc3b3b179694\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/dataExtension.js\":\"3dafb45244064085\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/effect.js\":\"11af90d386b187db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/index.js\":\"eef23a1975262876\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/keyCapture.js\":\"5e981fe7fa7eb777\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/overrideStore.js\":\"60fd5cbbf5a7cc0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"bba7ff29868f7532\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/HeaderItem.js\":\"6941ca534b53aa1c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/LeftSidebar.js\":\"20a97422e1896e47\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/actions.js\":\"981e43b3eba2a676\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/facet.js\":\"b62522f93f0b484f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/index.js\":\"e4550571ce5a9026\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/shortcuts.js\":\"3ae44caf080c471f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/toggleStore.js\":\"026081bb3ff6e211\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/MergePicker.js\":\"81a2704b4e9a0639\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/index.js\":\"6f5d5fa2987d465c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/mergeAction.js\":\"c995e19d7e2ad9d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/strategy.js\":\"9a469c1d5eb968a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/Button.js\":\"a825bc054b7fc7d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ea40ccca4cc042c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/defaultItems.js\":\"b3e5a3a779d311d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/facet.js\":\"d743a84efdee87ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/index.js\":\"a05c1233acdea0b2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a500fc0ef689fdbe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/actions.js\":\"1bc387cf86009d02\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f81a9656587b85cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/facet.js\":\"a5339f8d3ff40865\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/index.js\":\"66dffd2d5f922639\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/MoveDestinationPicker.js\":\"844442ce991216db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/blockSubtreeMembership.js\":\"bf2822f997729b74\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/contextMenuItem.js\":\"4f0f28f6357eeb3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/index.js\":\"73e1bccee82913f6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveAction.js\":\"703e43965e28de82\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveBlocks.js\":\"7e1a7dd9565d3a62\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/selectionAfterMove.js\":\"e53f7689fdc4032c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/TutorialBanner.js\":\"ced41e94f221a2b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/action.js\":\"f07b2d5845b4bb63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/bannerDismissal.js\":\"bb1b3e154e11372d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/documents/cheatSheet.js\":\"dd4ceb50d74ce967\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/index.js\":\"f5dea227ffde3636\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/keys.js\":\"1ed47da455048f8b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/landing.js\":\"1bf6505b4a88998e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/outline.js\":\"6436c6c818aa13fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/seed.js\":\"bc7c797f74850a79\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ed3a7d6c2faa3012\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/analyze.js\":\"47f757f87ea329e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/diagnosticsSource.js\":\"97aa1dfa07a8826c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/index.js\":\"93199dd1e15ac64a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/load.js\":\"dd0e49dd59fde02e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/monitorRun.js\":\"0a00ef23282bfefa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/schedule.js\":\"8cb02b74c3fa0fe5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/series.js\":\"c07055e633d991ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/store.js\":\"25c86f726ecefb8c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/trendAction.js\":\"fb143b9d7cf4b896\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/verdict.js\":\"21fac6cc382964f7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/clickToEditAction.js\":\"0c358754c9ad412b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/index.js\":\"682561c4876fb19a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/interactions.js\":\"d4fe276b9eaf32b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8ec79a951bf543e3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGate.js\":\"9d71584683cd1d90\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGateDialog.js\":\"1176c596d2d67690\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/action.js\":\"5cfd7dc385e5c904\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/index.js\":\"fbcca1538648c3d4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/localRunMessage.js\":\"a03024e4e00a4c9e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/plugin.js\":\"7158c1109f3f498b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/progressReport.js\":\"c7ffca61c1434ee4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/sweepProgress.js\":\"a57d629826bc8e4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/FieldRowRenderer.js\":\"4496c61d65cca83f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/ValueRowRenderer.js\":\"323a130c923c584e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/actions.js\":\"6680766ea16cc8b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/autocomplete.js\":\"d042b3511d12db90\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/fieldRow.js\":\"149b73df812f12f0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/index.js\":\"944dc55178f374c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/referenceWarning.js\":\"e7a88f5cc0e18074\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueAutocomplete.js\":\"407b53ed5f3fdc36\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueSchema.js\":\"df700ec889bd1cc7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/HeaderItem.js\":\"77352ea452e229cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/QuickFind.js\":\"3505ace39a6f7e64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/index.js\":\"1c939c45edfd2cb9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/recents.js\":\"a737b425f12a7a28\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/resultItems.js\":\"cbbaa2c556e2596e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/selection.js\":\"787cb6988c0728ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/toggleStore.js\":\"fd800d0d44313f7a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/HeaderItem.js\":\"22d74e15be51d7f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c018d7cf9165e11e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/grouping.js\":\"759fdd6d9883bcc4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/index.js\":\"e222272ac35809a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/target.js\":\"7ff7a789bb43bc5e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/codeMirrorExtensions.js\":\"71db89baec53d64e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/contentPrefill.js\":\"932dff16f8d326de\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/dataExtension.js\":\"cd8e5ce983729186\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/index.js\":\"14579e2ff50ef05a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"78670be6dc440a58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/invalidation.js\":\"f0c51e6ede9c3d82\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/localSchema.js\":\"af9863e6c77b05a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/index.js\":\"3d320a21af7b01ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b99e2594630b9b54\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/index.js\":\"57bc2dfb248dc475\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/referenceNode.js\":\"12eee3dca6ac7eae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/remark-reference-occurrences.js\":\"7e413da5bad5b482\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"8dac5195b8fe089f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/index.js\":\"1b6352823e3dbc87\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3cd1f10a63ae82d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3de9a7ccc02ed5e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/mergeRetargetProcessor.js\":\"bf4288bcde8b6a0e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/parseFence.js\":\"9ced6b0f841fa59a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceParser.js\":\"6175bd318b0edfd9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceProjection.js\":\"cb5326a4be895bb2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referencesProcessor.js\":\"2898a0085e05478f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/renameProcessor.js\":\"32e9eb8c26985adc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/spanReplacement.js\":\"17aa14b0f0b9cc7a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/htmlToOutline.js\":\"14719f86f501441e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/index.js\":\"8fa9836c2d23a37f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/normalizeClipboardDom.js\":\"bc28b3f0fddfc894\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/pasteDecision.js\":\"54a45bd2ea4edfbc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/action.js\":\"114db884aa00385d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/blockIds.js\":\"81d0f3387965ae8b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/content.js\":\"1aebe85cd6abca47\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/effect.js\":\"d49de0d8494240e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/ids.js\":\"5d27a3de162d5388\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/import.js\":\"0bcae95322dd7af6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/index.js\":\"0624a10c92dc91c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plan.js\":\"5df540d92574665a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plugin.js\":\"9cf117300232013b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/promotion.js\":\"8e1ef84aa90c0eac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/properties.js\":\"1e49c1d12eec4221\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/references.js\":\"671447956f334b64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/report.js\":\"eb8aab8a61ff2fe6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/roamMemo.js\":\"3266f960b0b4ddf3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/runtime.js\":\"0cddb6f132883040\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/schemaReconciliation.js\":\"6f177f3a79bf1786\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/srsMarkers.js\":\"c8a255c344e3f840\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/todo.js\":\"4624ab6447f088be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/typeCandidates.js\":\"9958b4f26f920b9b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/types.js\":\"0707a41976e1c636\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/index.js\":\"b2ec0179fa198eff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/store.js\":\"bc6efea5955bbe5c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/HeaderItem.js\":\"b5d131d236905eb5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"be2417ee3c50eb8a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/index.js\":\"c280b87c5e1ddbec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/model.js\":\"81b4d60709c8e94c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/toggleStore.js\":\"a142b5c8f560d704\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/useKeyInspector.js\":\"f84e5b47eae0e1cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c448551d19bf0ed5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/ShellDecorator.js\":\"bd6b225d6751092a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/actions.js\":\"432b38abff8a68cf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/exclusionsFacet.js\":\"924f3bf60b84b7ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/index.js\":\"1db458a363e51cff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/shell.js\":\"854e5df889108f58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/surface.js\":\"c592f3a38ba0763f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/walker.js\":\"531ab8873c1e4e32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/RescheduleToast.js\":\"616cbcbb7f50493f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/dataExtension.js\":\"1e5420d6620d86d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/index.js\":\"7853cf65916500d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/indicator.js\":\"8130f0c2bb2d831f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/moveSrsState.js\":\"ac947a544b21a5a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2749f32096a9887f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/scheduler.js\":\"cebbf0defbaea05b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/schema.js\":\"6f560acd4503e6eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"77bd4da984424869\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsClipboard.js\":\"1c3f12cadb95379e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"db8dd1ae4afe2065\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b9a51120410fe048\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DeckPicker.js\":\"91543c272aa27c22\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewControls.js\":\"d040fc2b7d043e35\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewDeckRenderer.js\":\"61f44d8671ce24bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewSession.js\":\"b0bafa093969de1b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/actions.js\":\"19a997e270be7bf2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/archive.js\":\"895a23593d6c8b83\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dataExtension.js\":\"6a8b25b133a44f7a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/deck.js\":\"e1c2c69846f494cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dueQuery.js\":\"0d7df49134743f75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/gradeDecision.js\":\"52477686da3e5599\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/index.js\":\"c5e181944bb7146b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/keyHints.js\":\"c492797874680645\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewCardLayout.js\":\"5725a7b4e8db2d50\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewProgress.js\":\"42c2b29babc16c15\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/schema.js\":\"bf0afaaa8e7ae6ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/useDueCards.js\":\"37614df74c8a9ebd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/index.js\":\"244110fdfe96f5b8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/record.js\":\"28925b4f4b0ff61e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/index.js\":\"afcf76e7a4ddd914\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/persistenceStatus.js\":\"9115fd6dc1a70655\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/requestAction.js\":\"44c0914a71c1f807\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/TypeChipsDecorator.js\":\"05c427a0a4327037\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/codeMirrorExtensions.js\":\"4d61c84361445e1f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/index.js\":\"c13b694a9371dd2f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/typeAutocomplete.js\":\"46f14e699b17fef2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"de7b9a752ccdba99\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/actions.js\":\"d704e0eb1ab4b212\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/anchor.js\":\"9055ce6d5a9fc268\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/events.js\":\"0593da73e36b2a67\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/gestureActions.js\":\"513cdd2ce01405a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/index.js\":\"66afb5935bd0683a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"26439b784ec7b297\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/collect.js\":\"2537b62baadb98a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/index.js\":\"c0edaf31bd012652\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/record.js\":\"aac69b46c0ff3c60\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/RejectionDialog.js\":\"c95e69c0a2a7100c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/SystemStatusHeaderItem.js\":\"4ba15594c572d432\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/index.js\":\"d13e19752f4b8749\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/model.js\":\"bca9fbd85f1e40d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/queueCounts.js\":\"485e4adea8165de6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rejectedHelpers.js\":\"a22d6b297865979e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rematerializeAction.js\":\"da1cb16073b2b8e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/useHysteresis.js\":\"8aac4f08afd6ec5f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/ColumnHeaders.js\":\"661c9d34e060fbda\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/QueryUi.js\":\"9ef6cc0001ea924e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/TableLayout.js\":\"2b477d9aad52c6cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/actions.js\":\"1571e2f14459f0e0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/cellEdits.js\":\"994145f2709944d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/childrenViews.js\":\"d4ef5a76e9212d13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/columns.js\":\"05304fb228ff1d72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/controller.js\":\"f3dd7811f1b0e0b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/convert.js\":\"8ae0d1ebee993341\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/dataExtension.js\":\"c07ac3ce94f92d54\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/index.js\":\"7b5198e5a287765e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/keys.js\":\"b4b40b9225c1dc72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/model.js\":\"55bf197830dbb583\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/QueryText.js\":\"8e276584c3954b1a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/backfill.js\":\"3e138b31b5bf5967\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/completion.js\":\"569856bc40846b87\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/format.js\":\"82d3acd2f714716f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/parse.js\":\"ccdd9cc463185a93\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/queryValue.js\":\"317bd16ff7ce1934\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/registrations.js\":\"94ce6807d3fcbb65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/source.js\":\"df26304935064b9a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/registry.js\":\"29a885ec0673c82d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowGutter.js\":\"37c22c268363d9ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowVerbs.js\":\"a1f2709d53cda3ce\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/schema.js\":\"cb59d0b9a1b520fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/sort.js\":\"0f3578b412e11221\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/effect.js\":\"aa7831dcaa000fea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/index.js\":\"8c1a7419b8a71057\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/theme.js\":\"66e0c766dbcb3a89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/actions.js\":\"40c69addd0c99092\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/dataExtension.js\":\"ae9e5334fa381e17\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/index.js\":\"f49a69159156415b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/schema.js\":\"81a2bdd968e0f3f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/TouchSelectionLayer.js\":\"649eff24b47964de\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/actions.js\":\"9750570fb5e60b8a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/defaultItems.js\":\"3f3b7acf8839a0f0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/facet.js\":\"c74c9f880e6f8aa0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/holdRecognizer.js\":\"0f4de86cdd81ab7b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/index.js\":\"12443d7779e5a82c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/UpdateIndicator.js\":\"83c8526dc650d12e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/index.js\":\"02f6008aa2426171\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/loadTimes.js\":\"8075c0f421cd5bbc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoNotesRenderer.js\":\"d646c9eb4d617edc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoPlayerRenderer.js\":\"4e9f191ab7ec02bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoTimeStamp.js\":\"25e8d7064b597d83\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/actions.js\":\"702d6cecaa3c2e1b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/index.js\":\"f7d3ccd7d13613a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/markdown.js\":\"831559c5034df13f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/notes.js\":\"c493371936a83d2f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/registry.js\":\"c793abeaa0e41c64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/remark-timestamps.js\":\"19e605525928ea3f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/view.js\":\"e35ec2ab9eebe683\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/LinkHints.js\":\"ac253f6733a9a11c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/index.js\":\"2e15b1dc47397d96\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/model.js\":\"773a75f915a877ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/settings.js\":\"a5137330672c5294\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/actions.js\":\"a538ab91c61dde7b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/index.js\":\"dbc8cc0047d52783\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/interactions.js\":\"607f4d8b835bfbb6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/workspace-header/index.js\":\"66107461169ba54e\",\"/knowledge-medium/pr-preview/pr-1899/src/registerServiceWorker.js\":\"7222db0357c9b180\",\"/knowledge-medium/pr-preview/pr-1899/src/requestPersistentStorage.js\":\"edd9caea49442fe4\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authRequestDeadline.js\":\"4049fad9f1b48c48\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authStorage.js\":\"2e768ab6830493df\",\"/knowledge-medium/pr-preview/pr-1899/src/services/powersync.js\":\"9d767de7dbe7d6bb\",\"/knowledge-medium/pr-preview/pr-1899/src/services/supabase.js\":\"282073996a45e84b\",\"/knowledge-medium/pr-preview/pr-1899/src/services/uploadErrorClassifier.js\":\"cdf073f3e15d885c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/ActiveContexts.js\":\"fd917b6f16887caf\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/HotkeyReconciler.js\":\"e7923dff26becc38\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/WipeLocalDataDialog.js\":\"6f5df0153352bd53\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionDispatch.js\":\"6e33195a32abdb53\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionRefItems.js\":\"e0bdd06004423be6\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/applyKeybindingOverrides.js\":\"93ce831a28306149\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockActions.js\":\"bd99e154f913fdd1\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockMergeGesture.js\":\"3bdb63e4905899d7\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/canonicalizeChord.js\":\"8cb652c01bbfb3c6\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultContexts.js\":\"bb660b8a746a87fb\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultShortcuts.js\":\"916845fe49a66ac1\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/effectiveActions.js\":\"f8027d3017b70a5c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureAction.js\":\"2f78cdfdd29c5d20\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureBinding.js\":\"2a767ba78c932d27\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/holdRegistry.js\":\"30c4afae1dee32d8\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingConflicts.js\":\"93aa990865dc8629\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingOverrides.js\":\"d978cba0a83fdfb1\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/pointerAction.js\":\"7925967b7ae1c9a3\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/resolve.js\":\"a75ccd2b78ed4e35\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/runAction.js\":\"d4a4214d23fb93a1\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/sequenceMatcher.js\":\"f22ac4a21dea17ee\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/types.js\":\"7fac095824aff965\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionContext.js\":\"64b9d6ad164c1e1d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionDiscovery.js\":\"9127fb869bec56fa\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/utils.js\":\"6f593b515968ed0c\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/bootStore.js\":\"34ac48f528735afc\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/previewDatabases.js\":\"3a2cb0dba3ef7e41\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/byteTransform.js\":\"e4af2925344e6dfe\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/attachmentCleaner.js\":\"4094824394135dd4\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/attachmentParts.js\":\"30dd9b29fd2e07ec\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleParts.js\":\"8f770060d6986e5e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleRecord.js\":\"9d59e031846f7f5b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/manifest.js\":\"4a12ecf9eeaf624b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/takeBundle.js\":\"517849fbafd5b1e2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/verifyBundle.js\":\"43008fcf4b65eeb1\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/cleaningStage.js\":\"51cf81b0f587cc1e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionKey.js\":\"57441c9cd61020de\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionServer.js\":\"71edd12748ddc975\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flip.js\":\"d3c082639165496b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flipAttempts.js\":\"bf54a0886e9f364f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/pages.js\":\"d2cc897421388bcd\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/preflight.js\":\"4935739aa03fa2c7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/reseal.js\":\"c1a8a1fd5fd0b165\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runConversion.js\":\"84ebfcdf0310de82\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runLock.js\":\"d6688183ecfb19d8\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealing.js\":\"75d2b298b36b4177\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealingStage.js\":\"e880de0c49e8d2f2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/stage.js\":\"17e1023336e0408e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/verifyReseal.js\":\"2dfcdd346f222b41\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aad.js\":\"6292faf055ef48b3\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aead.js\":\"51aa5aa93f0f54e2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base32.js\":\"27df249c12bec664\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base64url.js\":\"1fad58a6f0cc4370\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/binaryEnvelope.js\":\"5a6e6bd233ae0e94\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/byteAead.js\":\"55a2de50e8a20864\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/canary.js\":\"6456d5400598a8eb\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentHash.js\":\"1e18d4b075bf787f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentKey.js\":\"9c12963a6b66c033\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/derivedIdNamespace.js\":\"b32fa203e9ec57ec\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/envelope.js\":\"2e4339dd1c35f553\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/hex.js\":\"0dd571f568edd90f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/sha256Hex.js\":\"aaf6c5322965965b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/workspaceKey.js\":\"24fd95daf2a8dd77\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/conversionState.js\":\"acf6e075aa39288a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/createEncryptedWorkspace.js\":\"2d35300e02ce1fb8\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/pastedKey.js\":\"25ace597e0422fdc\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"49050364c3c3b0c9\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/upgradeWorkspacePin.js\":\"917b1c6579c0aa64\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/keyStore.js\":\"db3f964692756c2a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/mintWorkspaceKey.js\":\"3efe90c5406c559f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/modePin.js\":\"250307d8e8e9768e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/openWorkspaceKeys.js\":\"12c2e8d2d7a28cb3\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolveWorkspaceEntry.js\":\"44d846a8ae539a1e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolver.js\":\"3a2b5250115bf7b4\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/workspaceAccess.js\":\"587fe7a7aefee3c3\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/transform.js\":\"dbd04f5dc503567e\",\"/knowledge-medium/pr-preview/pr-1899/src/themeBootDefaults.js\":\"63e9494cb413eec6\",\"/knowledge-medium/pr-preview/pr-1899/src/types.js\":\"9bee492d73e5795b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/ClientLocalSettings.js\":\"12eed95cb3f1426d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/abortableSleep.js\":\"3b62c66a99a699e8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/array.js\":\"23eae65ea1684afc\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/backlinkAutocomplete.js\":\"75126b4eeea7fbc4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockCrumbs.js\":\"32e914e2871290b6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockrefAutocomplete.js\":\"012df161d0d605cc\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/cadencedIdleJob.js\":\"8476a0254d703d94\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/callbackSet.js\":\"d51987497cd3f731\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/clientId.js\":\"7271f41bc3149db6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirror.js\":\"033161ab2cf06c33\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirrorCompletion.js\":\"327cb9e55376bdf4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/copy.js\":\"656dd69468a62490\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dailyPage.js\":\"f03cc1b9df96b88a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensics.js\":\"7f81cb231b57765c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensicsHooks.js\":\"a4ea9d63f3b8959d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/deleteBlockThroughUi.js\":\"b488e41d521de3cf\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dialogs.js\":\"938d8262450e7253\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dom.js\":\"4e1903e6872b75b2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/downloadBlob.js\":\"278bc31f3e317ae7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/drawnWalk.js\":\"ff60eedb1dcb5a77\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/exportSqliteDb.js\":\"0b688a825cd04f56\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fileSystemAccess.js\":\"ef24f6b2619636a2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/flipSlide.js\":\"fcae6a5a1a9fb0ef\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fnv1a.js\":\"2e51240d463df739\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/formatBytes.js\":\"59610adbdf1a36f5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fuzzyRank.js\":\"d4bb8baad1f3a08d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idbKeyedStore.js\":\"66e9ed00fe36e8ba\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idleCallbackPolyfill.js\":\"9f15b42da579c502\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardAwareScroll.js\":\"309616317af2464f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardViewport.js\":\"75906b65443b0348\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/lastWorkspace.js\":\"c8ec9c4e3e739680\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutColumns.js\":\"4ba10d53bcd9f690\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionDom.js\":\"3a1386dc164a505e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionId.js\":\"9c4dd0ab325f874c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkClickGestures.js\":\"718ff285d8d45d32\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkTargetAutocomplete.js\":\"5b135f873473a697\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbCorruption.js\":\"3f5a5555fc39a514\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbRecovery.js\":\"59e66a48b72c50b4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/markdownParser.js\":\"5ed5d3fe580fc08f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/memoize.js\":\"ae8c4a4025ae0871\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameFieldCommit.js\":\"c0a72ca2e1472a60\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameList.js\":\"a7e2e9529db99dfd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/navigation.js\":\"5e523c6e550bf2f6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/omnilinerNamespace.js\":\"5ec52ddb69e67603\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/opfsPageScan.js\":\"f9282eebe935aae5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelClearance.js\":\"8fdab728d6cb93bc\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelHistory.js\":\"9806b338e9b5ca0b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLanes.js\":\"1cb6a86c0f82d65f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLayoutProjection.js\":\"f61570c738a94a6d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelScrollAnchor.js\":\"bb0f3fdf320176d4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelUrlFlags.js\":\"db862d85c347d91e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/platform.js\":\"f8d14e93655526d7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/pluralize.js\":\"d6eba296ee35a7fc\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyCreation.js\":\"5896a3477a992e31\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyNavigation.js\":\"3038a3fe27829c2f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyValueContext.js\":\"76e5c0277460404a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/react.js\":\"b10e991456cabc37\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeDate.js\":\"2f56fadf9b6e1328\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeTime.js\":\"38f285413c837015\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/renderScope.js\":\"cb8feb42d263cb12\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/resolvedThenable.js\":\"0497ec64387f3bb7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/routing.js\":\"7e85802130472438\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/safeMode.js\":\"7e58e18e3f6b3a8e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/scheduleIdle.js\":\"31743aeebfb860ad\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/screenWakeLock.js\":\"7baafdfda8040c80\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/selection.js\":\"95a4eae83dca7daf\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/softKeyboardGrab.js\":\"bfe5cafd7a6ad963\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/startupTimeline.js\":\"b6813f8bde5a6745\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/state.js\":\"ef4d2130c6f98b7c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/string.js\":\"2e0426f30ca8a970\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/surfaceZoom.js\":\"d8c9f8a79e36789a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/time.js\":\"28dbceff523b9a19\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toast.js\":\"a314ea71c9b22ea9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toggleStore.js\":\"73e0ca3c59041d8f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/untilStopped.js\":\"dc156e733ae066dd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/userActivity.js\":\"7eba25c1a7b31c7b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewTransition.js\":\"102418a154b015a7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewport.js\":\"25b1efbda719dc24\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/webLock.js\":\"66fe3dfaf9cbbd05\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceRecovery.js\":\"05136c20df35ecea\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceSnapshotStore.js\":\"be42ba017fa65b4f\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-compiler-runtime.js\":\"c22f68ff90df7981\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-client.js\":\"40d1d56524ded57a\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server-edge.js\":\"2d44d619fda0cfdd\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server.js\":\"c3ad818694b456f3\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static-edge.js\":\"978323878c3d6c66\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static.js\":\"a27914c7135503b3\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-test-utils.js\":\"6c7764e5680bc62c\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom.js\":\"6cb6087f58538208\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-runtime.js\":\"ede9b3d095199395\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react.js\":\"4c4acb36e37d4755\",\"/knowledge-medium/pr-preview/pr-1899/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
