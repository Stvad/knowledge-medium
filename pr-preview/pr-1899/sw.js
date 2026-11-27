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
		buildId: "01715060a161-8b1f1ce9",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/\":\"566a7324ff01c301\",\"/knowledge-medium/pr-preview/pr-1899/index.html\":\"566a7324ff01c301\",\"/knowledge-medium/pr-preview/pr-1899/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1899/assets/FacadeVFS-B9jLqfab.js\":\"763eb4093bd8fee9\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSCoopSyncVFS-DtwLKy83.js\":\"f73515a3f3333054\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSWriteAheadVFS-BONy0fP0.js\":\"887ab736a6c34c93\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-DLFUAwdX.js\":\"a0e59f29cbc87ea2\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-BshiGTRj.js\":\"4e27ce816562316b\",\"/knowledge-medium/pr-preview/pr-1899/assets/worker-Bk7aBePL.js\":\"d82d7b0a70bac9ec\",\"/knowledge-medium/pr-preview/pr-1899/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1899/chunks/app-IkphmdPz.js\":\"89e97439dc714a6e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1899/index.js\":\"c0f256df80b50813\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1899/assets/AccessHandlePoolVFS-CyBIsY5o.js\":\"0af4b2b63384cece\",\"/knowledge-medium/pr-preview/pr-1899/assets/IDBBatchAtomicVFS-qTpzDvaH.js\":\"d09c029ddd907795\",\"/knowledge-medium/pr-preview/pr-1899/assets/MemoryVFS-Cbqj_-X1.js\":\"db2fee2b41dfcb76\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cof1KQIi.js\":\"e3aa4671dc972e48\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-C6Nt3FpC.js\":\"ad2ce872698709cb\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1899/chunks/AccessHandlePoolVFS-BfVaWCY4.js\":\"1ab48d0dceb84a0e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/FacadeVFS-C7J2FmdA.js\":\"60e4fa6f1f94e6ef\",\"/knowledge-medium/pr-preview/pr-1899/chunks/IDBBatchAtomicVFS-j2ePInDt.js\":\"f8f79102de39c005\",\"/knowledge-medium/pr-preview/pr-1899/chunks/MemoryVFS-B4d1DXW1.js\":\"dea69a4b63d99851\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSCoopSyncVFS-v_abOS-q.js\":\"bf2785a1cf37e742\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSWriteAheadVFS-B6XGhszZ.js\":\"a644c9d685fdf557\",\"/knowledge-medium/pr-preview/pr-1899/chunks/Preview-BLJ0p8kK.js\":\"efa891f33d3b3662\",\"/knowledge-medium/pr-preview/pr-1899/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/card-B941qjZp.js\":\"020b6c117f012b71\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-B9zB3fG9.js\":\"a348e1ec3528908e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-KOTd-Jz-.js\":\"830f130835e933c7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-async-DXpyFyuH.js\":\"07d730191d5534b9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-9pEVhUth.js\":\"22c32c86fb480612\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-BBmMZF7w.js\":\"57faae03359323d2\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-BNB9wOH9.js\":\"4b2d0b70b11dec7e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-Bs6uew-l.js\":\"95d08a633eb3ddb8\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-C4jhMSIO.js\":\"bc7d32aedfb34ab7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-D7C1lEj3.js\":\"ce5db8b8fa76d2ab\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DdmKbmHe.js\":\"afd9bf54bab29fe2\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DvarVjXW.js\":\"99aa7611fe8fcf47\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server-legacy.browser.production-Bi98GvsN.js\":\"be9928905b414153\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.browser.production-CjNEZnJj.js\":\"6ebc9701a066aa65\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.edge.production-wf18vAsH.js\":\"46cee2767f95d6fd\",\"/knowledge-medium/pr-preview/pr-1899/chunks/server.browser-BB_hBHBs.js\":\"aeb338259b17dfd1\",\"/knowledge-medium/pr-preview/pr-1899/chunks/textarea-BzEKY5WI.js\":\"01be91bac83ba66d\",\"/knowledge-medium/pr-preview/pr-1899/chunks/ui-15UmEpyY.js\":\"ba4af650c974467f\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-async-KolfQSRg.js\":\"1536c52324bb822c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-jj9ouo2A.js\":\"026bb57fad7ed299\",\"/knowledge-medium/pr-preview/pr-1899/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1899/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/src/App.js\":\"9781b709271c156b\",\"/knowledge-medium/pr-preview/pr-1899/src/appUpdate.js\":\"800dc0ddfc05d6d8\",\"/knowledge-medium/pr-preview/pr-1899/src/appVersion.js\":\"040901ce01df68e4\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/initialLayout.js\":\"fe976e5a73609669\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/openWorkspaceData.js\":\"ff087fbddd51a6f7\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/resolveWorkspace.js\":\"d6e4931c5bbb4ed1\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/workspaceBootstrap.js\":\"b1e1515929e39f5f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockComponent.js\":\"2fdf54001e76595e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockCrumbs.js\":\"a0792ef136cede8a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockEditor.js\":\"540a0e86365434f3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockLoadingPlaceholder.js\":\"8f97bf417dd5634f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockProperties.js\":\"badde3fbb12e69f5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockSearchPicker.js\":\"a54db1bfbbed70c7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ConfirmBulkDeleteDialog.js\":\"19f3e8c924fb2553\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DividerHandle.js\":\"e7e6fdf464af1b54\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DraftEditor.js\":\"4cacc51592732e09\",\"/knowledge-medium/pr-preview/pr-1899/src/components/GutterPill.js\":\"124c916d695c3706\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Header.js\":\"de4a4cfd71c611e2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/LazyBlockComponent.js\":\"0f7eb44ed4683b8c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Login.js\":\"e00b1682d6a610a4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ZoomableSurface.js\":\"9cf3f0aa23989175\",\"/knowledge-medium/pr-preview/pr-1899/src/components/editModeKeepalive.js\":\"18089707076af25e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyDisplay/PropertyDisplayScope.js\":\"dd1ae62031f01397\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ca5d455423217906\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefPropertyEditor.js\":\"a956790379518677\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefTargetTypePicker.js\":\"299319e387a3956b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/SelectPropertyEditor.js\":\"a2d6870500c04398\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/TypesPropertyEditor.js\":\"fca7fcfaba0e5d1e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/defaults.js\":\"2fd3ef3b2fb77c38\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/kernelValuePresets.js\":\"bedf4ef2dbb7d4b6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/selectablePresets.js\":\"5fba1d17441899d2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/typesPropertyUi.js\":\"b7a7106dfa7247b6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/AddPropertyForm.js\":\"208dbcfc9fdb23a6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyPicker.js\":\"0f47ae0095e24a56\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyRow.js\":\"90b0d50b5d93ce7d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/Rows.js\":\"6b06509353b74d12\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/actions.js\":\"178b642728a8f65b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/declarationOnly.js\":\"32b2c7612d452bd5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/layout.js\":\"198f5aabcd3db278\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/model.js\":\"fdd7fe4578bcdd60\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapeUi.js\":\"bc14f0126e936f07\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapes.js\":\"80ebdb477cf6eb1a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/usePropertyEditingActivation.js\":\"843b8a0bc20dada0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/visibility.js\":\"59244f45f3a2051a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanelSections.js\":\"d4ee6aea447079cf\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockEmbed.js\":\"76fd637b476d6488\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockLink.js\":\"60fc3943c513d41c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockRef.js\":\"8c8e24a772889704\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/CompactReferenceLink.js\":\"b623e36ca370f691\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/ReferenceLink.js\":\"7bdf754c17cf4201\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuard.js\":\"2428fc962e43d8f3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuardContext.js\":\"b694a4593a5164ce\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/linkInteraction.js\":\"d2e1e178fafe1542\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/referenceLayout.js\":\"f7dc334c54e51dde\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/useBlockRefAncestors.js\":\"ca6ff636033e7873\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockGutter.js\":\"0e6bf017c98bccdb\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockInfoDialog.js\":\"4a0942f9e5b5fcb1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockReadText.js\":\"a7517eb74346d830\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockTypeBlockRenderer.js\":\"3a6fcecd56129d71\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BulletHoverCard.js\":\"4a8b42ad326c1b73\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorContentRenderer.js\":\"64247a42242ad870\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"3467a4b3618fc05b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ColumnResizeHandles.js\":\"d00619fbaa4f866a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f5c57f6da5d01a59\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/DefaultBlockRenderer.js\":\"4bb57629ce615523\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/LayoutRenderer.js\":\"890b5c3de4ce5e7a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MarkdownContentRenderer.js\":\"77172b54efbe3f5b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MissingDataRenderer.js\":\"3a54349f5d718cb4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PanelRenderer.js\":\"2a33b4c067dca984\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PropertySchemaBlockRenderer.js\":\"58c62cfb190e6610\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/TopLevelRenderer.js\":\"f3bb2a8c063059c7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockGutterMode.js\":\"1b81c9125034c61e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockTitleText.js\":\"349b11931b811cdb\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/fieldCreationKeydown.js\":\"4daca79003e7358a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/layoutRootContext.js\":\"28c2324854140168\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/TypeChip.js\":\"15bcefcb28bd4dfe\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/chipStyle.js\":\"386a44def61c7a88\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/anchored-floating.js\":\"2d21bc6ad19bf392\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/button.js\":\"b07225087e3617e3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/card.js\":\"f2ea9bcbff6bb2bd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/checkbox.js\":\"7bafbaae738c9c89\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/collapsible.js\":\"001d7a3ca5f1a84a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/command.js\":\"a77203558f22647b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/context-menu.js\":\"ed290f25eba4ee65\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dialog.js\":\"1e07b3d2463435d6\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dropdown-menu.js\":\"399c0cb3acdedccf\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/floating-listbox.js\":\"7d179fcb439d7c74\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/index.js\":\"d504ddad0dec3ab4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/input.js\":\"d2d00315a31fa987\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/kbd.js\":\"5137118bee2c44ea\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/label.js\":\"47af31bf8a747af7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/textarea.js\":\"de1d4a40c1581055\",\"/knowledge-medium/pr-preview/pr-1899/src/components/useEditModeYieldKeepalive.js\":\"70a7a48081313c97\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/BootFallback.js\":\"717f63ddd306f1a4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/FocusedRowLazyMount.js\":\"a598cfab4768952e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LazyViewportMount.js\":\"ba5f9f78f97699fd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LocalDbCorruptionFallback.js\":\"4883ab881eabf24b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/error.js\":\"c7cbcfa9ed9ea6d0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/lazyMountRegistry.js\":\"e92da0f24cb2b7a7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/suspense.js\":\"894ab81a28216c1c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/CreateWorkspaceDialog.js\":\"19de7edcf929c989\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/PendingInvitations.js\":\"92a0f621236f2161\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/SyncProgress.js\":\"29b0e53605ad6096\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/UnlockProgress.js\":\"7398c9e79284423a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceKeyGate.js\":\"de5cc1a6fa14bf6e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSettingsDialog.js\":\"35091a128a83f778\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSwitcher.js\":\"19bbe89d4c9b2aaa\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSyncGate.js\":\"5af98902f7e27d24\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlow.js\":\"232684be78d278a0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlowHost.js\":\"c5794da601305406\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/EncryptionSection.js\":\"355f5963350bdec3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/attachmentPrompts.js\":\"794183f34039d8a1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/bundleFolderPrompts.js\":\"94838f3b68404082\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowDeps.js\":\"69c31a7a74a711df\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowStore.js\":\"3568990db991ce54\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/flowUi.js\":\"7739ed97f8feff8d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/useConversionRun.js\":\"077219959f764c6a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/keyUi.js\":\"eba350e2d9df029d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnKeyLoss.js\":\"773b06167bfbaf60\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnServerE2ee.js\":\"ecc0607d622341df\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/workspaceUnlocked.js\":\"7b6a680958129a5d\",\"/knowledge-medium/pr-preview/pr-1899/src/context/backgroundSubtree.js\":\"eac7210068a1b897\",\"/knowledge-medium/pr-preview/pr-1899/src/context/block.js\":\"b6e9bc490bcfc536\",\"/knowledge-medium/pr-preview/pr-1899/src/context/layoutWsContext.js\":\"182046cc05424cbd\",\"/knowledge-medium/pr-preview/pr-1899/src/context/propertyDisplay.js\":\"37683aa00ea00878\",\"/knowledge-medium/pr-preview/pr-1899/src/context/repo.js\":\"9e7921f335391434\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasClaim.js\":\"d7cbeaa71dbaa3f7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasSeatNamespace.js\":\"3ffcf01d7d261ca4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockData.js\":\"98b5c09a96eede70\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockType.js\":\"c104aaf780ef0aaf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/changeScope.js\":\"fee9b4d468803f4b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/codecs.js\":\"00ae493e43981fdb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/derivedData.js\":\"9191795483eb4ea5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/errors.js\":\"40ba47f47c75fe2b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/events.js\":\"6d78d086ff72f9c2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/handle.js\":\"cbe2dfea814d37ca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/index.js\":\"5c26ca26e02202a3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/mutator.js\":\"240336686e405a98\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/processor.js\":\"4b3327254a513ce1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/propertySchema.js\":\"302ee85cdb789d5f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/query.js\":\"9ea28b73f92e901e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/sameTxProcessor.js\":\"f8cd4ece7dcba242\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/schema.js\":\"cbe2dfea814d37ca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/tx.js\":\"cbe2dfea814d37ca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/typedBlockQuery.js\":\"b797f99f4b270e34\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/user.js\":\"e2f1e5c3bef999ef\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresetCore.js\":\"fdc4c06b9ba50db6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresets.js\":\"bd4ba8e78f9d404a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/attachmentCleanerIOVerb.js\":\"4b7c8a51fb880303\",\"/knowledge-medium/pr-preview/pr-1899/src/data/block.js\":\"57b4cc4bcaa0ea4c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockCache.js\":\"c915ffc124d1b9a7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockId.js\":\"2ed734e95f08d600\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockLiveness.js\":\"ecc91147b5dfdd25\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockMerge.js\":\"0ccdf9f24aa47935\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockSchema.js\":\"055b53bcc4b4a3f3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypeLookup.js\":\"0c7dd67ca36af1c5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypes.js\":\"16e0f5c14abf2867\",\"/knowledge-medium/pr-preview/pr-1899/src/data/childrenView.js\":\"23ed51f9ee3bc6dc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/clientContext.js\":\"6034419333afea09\",\"/knowledge-medium/pr-preview/pr-1899/src/data/dbFileSiblings.js\":\"5a7cb1cab600bf98\",\"/knowledge-medium/pr-preview/pr-1899/src/data/definitionSeeds.js\":\"c40357e03e27d99e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/derivedIds.js\":\"f8ac3a797a663779\",\"/knowledge-medium/pr-preview/pr-1899/src/data/drawnSubtree.js\":\"31094c177d02e5ea\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facetBridge.js\":\"c6e227e2b1daf2c9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facets.js\":\"37c25490ca6be5a1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/globalState.js\":\"5d7e56f051d4880e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/aliasClaimRederiveProcessor.js\":\"b1f8e7b4ab6b1373\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/ancestorBatch.js\":\"b206755701dea33e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/blockTypeTypeifyProcessor.js\":\"8be80c5e09b43ac9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/clientSchema.js\":\"7c8163369a25fb70\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/commitPipeline.js\":\"0e241ed5570cc54d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/devAssertions.js\":\"6494aa6d03fa531b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/firstSync.js\":\"37ed5cd7d01842ef\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/freshInitialLoad.js\":\"ef7bb3f0072c0529\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/graphBackfillClaim.js\":\"0b8119fe1931090d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/handleStore.js\":\"afbcbbfc6cd345df\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/idleMarkerJobs.js\":\"b8e0678c717adfff\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initialDownload.js\":\"b8511a89df186ebf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initializeClientDatabase.js\":\"804be6ad3c2724b5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/jsonCanonical.js\":\"af61294aceb7d60e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelInvalidation.js\":\"4e18ed19d7079888\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelProcessors.js\":\"428e83c9a84e7977\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelQueries.js\":\"e72fd0acfbb62fca\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/mergeTypeMembershipProcessor.js\":\"a65e9924ebc96f8f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/normalizeReferencesProcessor.js\":\"001ec776db3b3624\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/poolInstrumentation.js\":\"7d4372915c53f2b0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/processorRunner.js\":\"1c624021592cd4e4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyCellBackfill.js\":\"1eae1d6a705bf966\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildMint.js\":\"eb37f08b2ac1e4c5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildrenProcessor.js\":\"d576bbfe0bcb0171\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9b108433baf7d5de\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionSynthesis.js\":\"75c24469df24e097\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyKeyScan.js\":\"6a7cced66480eb5f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertySchemaResolution.js\":\"9842d9fd6b1231a2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyValueEdits.js\":\"46f17a1f8e4e44ab\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/raiseProtocol.js\":\"e605ced13c7a2d4d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/readBatch.js\":\"c0464b04b1e40b3d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/refProjection.js\":\"7ba9c383ec5f1d8c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetLookups.js\":\"075a079db12983b3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetProcessor.js\":\"d903ed857bf13325\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/replayMerge.js\":\"c83a9ce63a4d732f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/sqlBinds.js\":\"5b37ba6a638878ff\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"33c84e0476140956\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/arrivalProcessors.js\":\"873917d1ec845198\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/invalidate.js\":\"ad9d2801147a49c2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/materialize.js\":\"347f4bdcf71bd553\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/observer.js\":\"78c5c57238d4d94a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/reconcile.js\":\"98b6252a71d9bc4a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/timingMetrics.js\":\"f45a46e718524cd2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/treeQueries.js\":\"60a204a90938c012\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txEngine.js\":\"4d11b6dfcb7cf433\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txSnapshots.js\":\"0a9f9f8aaca7e88f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/typedBlockQuery.js\":\"ea96ee1919c20781\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/undoManager.js\":\"a0b1966a87b9928d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/invalidation.js\":\"16f1b1f5773651eb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelDataExtension.js\":\"426d58fc13592331\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelPage.js\":\"a92712febb237163\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelValuePresetCores.js\":\"4e9824ec33f09f14\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbCorruptionSignal.js\":\"4f4b31c2b7926e9f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbStorage.js\":\"451ee4d703e8428e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbVfs.js\":\"08738fedd8377732\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localSchema.js\":\"7344fe9a5efcf77b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/maintenance.js\":\"7c7f4cdfa09ac065\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mergeProperties.js\":\"f98153aa26c3f502\",\"/knowledge-medium/pr-preview/pr-1899/src/data/metricsConsoleHook.js\":\"8ac021d2d20d9267\",\"/knowledge-medium/pr-preview/pr-1899/src/data/migrationsPage.js\":\"d2280def58480b36\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mutators.js\":\"22f0761df2c64b5d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKey.js\":\"138d400124040d11\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKeyPlacement.js\":\"4c3ded5be29c47b9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/outlineSurface.js\":\"741407b319e03317\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingEditorContent.js\":\"a314f777b502151e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingUploadsSql.js\":\"05ac345246ef087c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pluginStateExtensions.js\":\"0939054ced06241b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/powerSyncLogger.js\":\"c63895479c422755\",\"/knowledge-medium/pr-preview/pr-1899/src/data/projectorRuntime.js\":\"c93cf4c157723ce6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/properties.js\":\"da865e77b942503f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertiesPage.js\":\"ff08451243744061\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyChildren.js\":\"fc2bb7e25089a17c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionFanout.js\":\"e6d5afb853f209c1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionMetadata.js\":\"51c551a5f08944b2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionRegistry.js\":\"6fbef294866ef457\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDisplayMode.js\":\"6a606c7f3d287629\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyRowCreation.js\":\"2d74e1a60a9bef18\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySchemaCreation.js\":\"5de44bb1eef71daf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySeeds.js\":\"8dd72d1a49e8f29d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/recentsPage.js\":\"0252fdee15adc7e9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/refTargetComparableProperty.js\":\"99ae1ce560749a34\",\"/knowledge-medium/pr-preview/pr-1899/src/data/referenceBlock.js\":\"ac3c0fa7716ce8c2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rejectedUploads.js\":\"04f1b4a4107d163e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/releasePowerSyncConnection.js\":\"8b5d886fbf51bbf9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repo.js\":\"8cc542eb7da6452b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repoProvider.js\":\"9556402451662044\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rowProperty.js\":\"c196d987ecaf3114\",\"/knowledge-medium/pr-preview/pr-1899/src/data/searchFilter.js\":\"bc2dc2f5196f19d5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/seedIdentityLedger.js\":\"bcf8e8ea7b283c3e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/stateBlocks.js\":\"94c0ad110b8eb0f9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralEditPolicy.js\":\"20c7b33fedf9bc17\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralInsert.js\":\"e7a61995cbee3446\",\"/knowledge-medium/pr-preview/pr-1899/src/data/subtreeDelete.js\":\"7687893f12c928e2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncStreamLock.js\":\"c5e8cedc15a0fa05\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableSqlRecognizer.js\":\"b1bfe133cc3c8bc2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableWriteGuard.js\":\"5e8c43aae86db661\",\"/knowledge-medium/pr-preview/pr-1899/src/data/targets.js\":\"3892c522099878d3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeColors.js\":\"a7e10126b55f175e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionMetadata.js\":\"18f7c1b9a9225be4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionRegistry.js\":\"a2f92eb028390e96\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeExtraction.js\":\"662768802d7a403e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeInitialValues.js\":\"b49c0e2056b56df8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typePropertyGroups.js\":\"38614e84de66c12d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeSeeds.js\":\"ecd1227403c83f8e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeTagger.js\":\"55fc654536bea734\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typedRecords.js\":\"7b79b3017590d65c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typesPage.js\":\"db283317de79770a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userPrefs.js\":\"c0ae595660ba76c7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userSchemasService.js\":\"f1d92d2316642485\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userTypesService.js\":\"2dbed9bd98032b2e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/valuePresetRegistry.js\":\"5c06df3878039bc2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/visibleChildren.js\":\"7968fe310fa76e84\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceConversion.js\":\"2844f60b57668255\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceFirstSync.js\":\"6e6403b2adaec3e3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceIdNamespace.js\":\"6de6dd9a46ba2654\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceSchema.js\":\"7c7afd13108f59b6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaces.js\":\"ba10a1d862dc7c2d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadLog.js\":\"05730ab99ae01547\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/BlockPasteShellDecorator.js\":\"04bcecb1fa0409d6\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/atTrigger.js\":\"985b7bb220e56ea5\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/autocomplete.js\":\"ba236f71c8a13e5e\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/codeMirrorExtensions.js\":\"43f94bc6c1388d1b\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/contentFlush.js\":\"c1843afe71ebc808\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/defaultInteractions.js\":\"1761ee15a9635cc2\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/editSettleSignal.js\":\"3e5658e29eb754fd\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/insertImage.js\":\"61ad012af2610071\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceCompletionRange.js\":\"9067050c4fb3599a\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceTargetTypes.js\":\"6afbfe6805f74d04\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/syntaxContext.js\":\"fdb5838ebfd3bf8d\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/triggerMatch.js\":\"1f2255349eb85a02\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/AppRuntimeProvider.js\":\"142b748dd9d2107f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/BlockFocusShellDecorator.js\":\"5385593529a42f58\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/ExtensionRenderBoundary.js\":\"cd8b42be1281bc7c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/PanelContentRecovery.js\":\"83e6f20f9aff09a8\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/apiCatalog.js\":\"51188d954f7a9b73\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/approveExtensionHere.js\":\"bf480b59b498f077\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/armedCutAppMount.js\":\"9e75fc95bd6be012\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/batchableKeyedStore.js\":\"9a00fde18be84fda\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockInteraction.js\":\"d2f940146f3d5562\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockSelectionAction.js\":\"96f65d92b7a71ec0\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compileExtensionModule.js\":\"9fce47f1a2879375\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compiledModuleCache.js\":\"1e2488fab50e38f7\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/continuousGestures.js\":\"4f11b7cf5d4cb22b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/core.js\":\"b3634c0ce721f5f9\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/defaultRenderers.js\":\"f8abc0f181e50e0a\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/definitionFanoutAppMount.js\":\"c3ed1abd0534878c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dialogAppMount.js\":\"3ea7161f742edac2\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensionSeeds.js\":\"491c66f575cee87e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensions.js\":\"aea700da1390bac4\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/exampleExtensions.js\":\"06bd03ee06b63273\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionApprovalStatus.js\":\"debf3f233133dd7b\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrorToast.js\":\"7b32a88f6a087e80\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrors.js\":\"80827ae6588eee6e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLookup.js\":\"823f1347c23ec90f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionToggles.js\":\"c47985aad09c5c67\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionUtilitiesCss.js\":\"22788bfd33517d7e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/kernelPageDeletionGuard.js\":\"551decbb3e95e1e0\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/liveRuntime.js\":\"4a4c9bce8f8aad65\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/openExtensionsSettings.js\":\"092b86c6786a0d29\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/overridesCache.js\":\"b48ad89d0e7b390c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/pluginIds.js\":\"9a4cd584e4a2b38f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/processorRejectionToast.js\":\"9ae86e952adee804\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeActions.js\":\"97f00fff352cf1d4\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeContext.js\":\"0ff45f9e3fe4fb4e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticAppExtensions.js\":\"9004e22e04c120a2\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticDataExtensions.js\":\"51fc0c3062d686e0\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/toastAppMount.js\":\"f8dc7148de3e71c2\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useOverrides.js\":\"fa99be31bd9c4ea0\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useShortcutSurfaceActivations.js\":\"4cc783edc80892c9\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/discoverToggleTree.js\":\"0ffb5a76991a0128\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/facet.js\":\"bc824d089ab597ad\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/resolveAppRuntime.js\":\"5216c10280235da6\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/runtimeEvents.js\":\"cb9644877b5a7819\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/togglable.js\":\"94b4871be9223cf0\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/variantFacet.js\":\"1fc94e82d47c529a\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/verbFacet.js\":\"86a160a587b4fd92\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/block.js\":\"b05821b04be623ae\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/focusedChild.js\":\"e59a563bb1067caa\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/propertySchemas.js\":\"9e044bdfe260ca51\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/typeRegistry.js\":\"6e1fe040ce1c900b\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAncestorCrumbs.js\":\"f885cad96551757e\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAutocompleteListbox.js\":\"011add155345b1c6\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedSearch.js\":\"94d85549a7f55230\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedValue.js\":\"af2f56446adf82cb\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useFacetValue.js\":\"6e6ac81d0721c068\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsFocalRender.js\":\"b67af51eb92fbf02\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsReadOnly.js\":\"a7dcb7793fee20eb\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMaterializeBacklog.js\":\"4c77b879aafd885e\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMinuteClock.js\":\"c8429d9b9ee43a09\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePanelLayoutProjection.js\":\"0ecfb7ee8acaec0d\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePendingInvitations.js\":\"33226cc5f713a519\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRendererRegistry.js\":\"52baed5ace336580\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRetainedFieldRows.js\":\"febedfb6777a22b2\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useWorkspaces.js\":\"e83e6f863e6a7a7b\",\"/knowledge-medium/pr-preview/pr-1899/src/lib/utils.js\":\"ac5b0137aa2f074e\",\"/knowledge-medium/pr-preview/pr-1899/src/main.js\":\"2b8df80a38632880\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/MarkdownImage.js\":\"b46aa208ba6604b6\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/blockSeparators.js\":\"e8546b5c100bbb1c\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/context.js\":\"d3fc567413c81e2d\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/defaultMarkdownExtension.js\":\"4d24a3e0e346773e\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/extensions.js\":\"feff707a31011a3b\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/renderMarkdownHtml.js\":\"a1d10b1e685ecfea\",\"/knowledge-medium/pr-preview/pr-1899/src/minimal-editor.js\":\"5af31b6466a208fb\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/armedCut.js\":\"350d29781fda81ca\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/captureMediaVerb.js\":\"0198c26bb80ca902\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/clipboard.js\":\"02397dd87e079ed4\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/decision.js\":\"4548700414ea64e6\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/operations.js\":\"ba3f5f10df291b39\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/AccountHeaderItem.js\":\"7bd25ba67e6f22db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/index.js\":\"f79b7f21ddef2faf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9f8f1cb39a18d52f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askAgent.js\":\"0c78f104815068bc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askedStore.js\":\"3d879c36a2dfe193\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"12eb4a92b0ded384\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/chipState.js\":\"bb96bd8323f05563\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3928b704d3fe44cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/index.js\":\"244fee84a6711985\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"35e9a4a7a71f385a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/schema.js\":\"a9e1d92a820fa828\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c3071c323944a75d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/BridgePairingDialog.js\":\"e4c9e2ec62450de7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/addMedia.js\":\"ae7962cbacf290ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6e8f7de852c27c1c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/block.js\":\"c399076fd3a35377\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/context.js\":\"b32b0ccf230f6bbc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/displayIds.js\":\"59bdd7d47c2f43b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/index.js\":\"486dc915ad2fb72d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/outline.js\":\"990953fb47e08a4c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/properties.js\":\"9d9327a7fd672da7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/refs.js\":\"a87216883c481858\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"da7659ed06596516\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/search.js\":\"4c9b57ee23c11c62\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/shared.js\":\"eb66a1778abb4261\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"31c8200fb38ddd2f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/text.js\":\"81b9ff181ba2308e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentWrites.js\":\"8664d403c8da92d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/authoringCatalog.js\":\"fe500860ed95ba4f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/blockRefTargets.js\":\"03d553b13344befc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridge.js\":\"1117ffdfd3cb5c45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridgeLoop.js\":\"5515073e6059f766\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/changeHistory.js\":\"2eefeccb10d0e697\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commands.js\":\"505f4ec6115479f2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commentsCommands.js\":\"f99f0ee8cc101735\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataExtension.js\":\"4fcd5665c723d824\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataModelGuide.js\":\"674bdd4050f7fd18\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dayPropertyInputs.js\":\"df3e10b7ce7049c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/describeRuntime.js\":\"f32735fc78610578\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/extensionLint.js\":\"d41edd5cfaa796e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/grainAudit.js\":\"a9872e446624b441\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/healthCommand.js\":\"289ed8c4411e471b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/index.js\":\"b01bfdde5e275bdf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/presetIdentity.js\":\"aeef74b87bd1d514\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"ac4d2790272a66c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/readMedia.js\":\"2bac837d78d592c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/schema.js\":\"8ffd51ccadea6815\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/serialization.js\":\"3e61b71d4a9dffaa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/targets.js\":\"6076444d8cb3d994\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/tokens.js\":\"c4ab6c2d91e72495\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/watchEvents.js\":\"e212e7d96331a927\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/workspaceGuard.js\":\"d56f96b040307b25\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/writeCommands.js\":\"fe95716c05f84482\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/AliasCollisionToast.js\":\"14d54c2208a0a378\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/DuplicateNameBanner.js\":\"a6de573c96de729d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/collisionMerge.js\":\"b7a5d80deaa598bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/dataExtension.js\":\"8fdf1af6cf2c5557\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/index.js\":\"2aba2b57b8d490bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/mergeCollisionAction.js\":\"f4989dbe3bb1ee0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/pageStyling.js\":\"cdb7ae8076592c01\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/rejectionToast.js\":\"22c293aaea0c5c94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/syncProcessor.js\":\"01cc0f3d92226dfe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/actions.js\":\"343602417a2aba02\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/addComment.js\":\"3206eabb251e134c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchor.js\":\"9ae8a095b575c1d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchorState.js\":\"a85b869ff766e9cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/commentLinks.js\":\"27565764feb5c388\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/confirmThreadDeletion.js\":\"d95bf53e3b44238b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/container.js\":\"79d1512f20adc180\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/dataExtension.js\":\"4a65ac48d39f5b82\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/deleteComment.js\":\"1a80e63cf2fec612\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/highlights.js\":\"919de8cb3b1c5128\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/index.js\":\"5dd8a0f1f8e473e4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/linkedCommentsPill.js\":\"614730dab74201b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/margin.js\":\"c403962e857b2831\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginAnchorLinks.js\":\"7346367f9dd11919\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginSchema.js\":\"75b3b0417c0c6980\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/newComment.js\":\"aeec3c1af67c9e68\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ownThreadPicker.js\":\"c913428c873f500f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/placement.js\":\"7c20473d8950de40\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/queries.js\":\"97f4700943ee3e24\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotePosition.js\":\"0ad3376310698f7f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedIn.js\":\"46c9a2ccadeefafe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedRange.js\":\"dd4c325823ec7648\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/rangeRefs.js\":\"4dea2ddf03899065\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readHighlights.js\":\"a8c3962023b193e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelection.js\":\"b2ca951a9e08a807\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelectionUi.js\":\"03d24643fa2ebac9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/reanchor.js\":\"d0ca25dd9b3e22a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/schema.js\":\"307cdc0c6e940de6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scope.js\":\"552a9dfd62cf7029\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scopeThreads.js\":\"667e80f668e6c12b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/splitRetarget.js\":\"ce55e9ab9a6d88f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestionCard.js\":\"9d42af5a5e069a78\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestions.js\":\"36c659eb1eefdbe8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaries.js\":\"02cf4cd63d804036\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaryBatch.js\":\"368584bf6ce29b6c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/surface.js\":\"932da82d08509720\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threadNavigation.js\":\"4474114ff8912f3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threads.js\":\"d3fbe65e8e7cfbc7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ui.js\":\"9dd7512ac1a93c4c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/uiStore.js\":\"45e7bd25fe348c0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/appIntents.js\":\"70271c4283a14cc4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/index.js\":\"86b0042ea34eecf1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/index.js\":\"2779e53063d1d9db\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/status.js\":\"f286ec09ccaf30d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c640586a3c2e7ebb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaBlockRenderer.js\":\"b534f6dec7b7f1f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaDownLaneReplicator.js\":\"29ddf05f94e993ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaUploadReconciler.js\":\"810281ec53825c29\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetDownLane.js\":\"32275afe90db99f0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetResolver.js\":\"296d8aa8aa7410df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetUpload.js\":\"5ce3da840f511f7b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/attachmentCleanerIO.js\":\"93927e75b0a62f3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f96d4b98a2ba21da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/blobStore.js\":\"66f315edf8f9b771\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/browserMedia.js\":\"c49b7dfce4756718\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/byteStore.js\":\"5311341ceadc3ad8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanerIO.js\":\"4c61b8ea080fea0d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanupAttachments.js\":\"a8c17d467510c16e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/dataExtension.js\":\"a04499fdfaf1d8bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/downLane.js\":\"08a555159866be36\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/index.js\":\"b6cf0b89a9dd787f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/insertImageContribution.js\":\"5a5d13710deadedf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneArming.js\":\"ea81a5ab2568a406\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneLock.js\":\"4beecb2cb901c2f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaBlock.js\":\"97925d01fa1a171d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaCapture.js\":\"86b519381a621049\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaLanes.js\":\"e10911378e9dd0dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewers.js\":\"444bfd26103f2a37\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewersFacet.js\":\"1950435bdefffeb9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/pasteCapture.js\":\"6a186c27b7e576ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/resolver.js\":\"7602565402f7f20c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/retryUploadsAction.js\":\"9c61f9e69541c950\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/storagePaths.js\":\"5dcbaa37fa79a998\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadDrain.js\":\"2576ccc14afcb421\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadLaneStatus.js\":\"ae32c81a75f4cb2b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadReconcile.js\":\"ae2da6903dcf4864\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadRecovery.js\":\"fb2388af5746ed8f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadStore.js\":\"079e80af56f11400\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/useAssetObjectUrl.js\":\"6d99ca1929be047c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"abbd46ca396c0164\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksViewSection.js\":\"fa2f0dc82087ad36\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/facet.js\":\"0e263ae21974d335\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/index.js\":\"ee440a850c658618\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/prop.js\":\"24e3dc74291fd8c7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinkFilters.js\":\"8e6bdd961ec73042\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ab73a5627d6247e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BlockEntry.js\":\"1a73b93298369b38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/LinkedReferences.js\":\"7ce5b809c476c8ad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8ff0768c357505ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dailyNoteDefaults.js\":\"b100e11f124fcf5b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dataExtension.js\":\"bc9efabc360804a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/edgeExclusions.js\":\"5ff7001956046def\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/filterProperty.js\":\"3d5612edf00012d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/index.js\":\"0dad0cfc6c93c3a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"6cba18293373b5e3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/applies.js\":\"6d37582fbb36f53a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/countQuery.js\":\"64328298b4d6e325\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/expansionStore.js\":\"375fd9fb60457818\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/index.js\":\"72ba153733ff64e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"95495fd0d5b88471\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/presentationInvalidation.js\":\"2cd0eeeadfe96dfb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyEditorOverride.js\":\"fe534ccf074528a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyFilter.js\":\"4d14c51e2248e946\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/query.js\":\"5122ae2c32961334\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/resolveFilter.js\":\"0180b6d19c3f8163\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sourceBatch.js\":\"daace5871b7099c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sources.js\":\"00ac7a8f5f08b57c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useBacklinks.js\":\"06bfb5a2772e90b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d647696c8352e871\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayCelebration.js\":\"b9aa1811495001d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayOverlay.js\":\"643fec473438219f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/gate.js\":\"6523126aa7046a00\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/index.js\":\"9f0c8f026d8f77b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/wolfTheme.js\":\"d4adbf0991476803\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/BlockDragLayer.js\":\"1e27a14e5e642abb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dragController.js\":\"0b06626c8526c4c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dropTarget.js\":\"17795b30c2c37f4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/index.js\":\"2e9905a3fba68536\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/projection.js\":\"671690c17f0dd0fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/BlockMetaCard.js\":\"87c212f0ce98b0c1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/index.js\":\"2182d71a132af69f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/AddTagDialog.js\":\"b9fb496bf71743b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"abb8fae8337aef09\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/TagNameIssueHint.js\":\"02960b7166caee3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/addTagAction.js\":\"37c7719636863d93\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/appendTag.js\":\"290ef7e148fa2ea6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/config.js\":\"0b30191dee348c02\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/dataExtension.js\":\"e3a39cca1a7876bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/index.js\":\"ba3a4e311ee41a6c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/propertyEditorOverride.js\":\"5dc929c029dfca43\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbList.js\":\"41e9fa7d9d33bb3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"5671a8d6bf550ec5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/Breadcrumbs.js\":\"9b5132c2ec2da8df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"d319505218205b43\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"35eda9ee16a1f5c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/index.js\":\"35283bdf6c64c3ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"96224f875be3302d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/CharacterCountItem.js\":\"2853591dedc6a035\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b9ad9be85e369049\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/actions.js\":\"471430f0ef08cb56\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/blockType.js\":\"042a4ba4ac8b7882\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/charCount.js\":\"98b90f549111f9d2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/dataExtension.js\":\"1a4ed02d8d8f1940\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/index.js\":\"a310afb89722d208\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/profiles.js\":\"dfcb42ad81707072\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/properties.js\":\"4e909a81d6596dfb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/subtree.js\":\"e006ee10cc6ce682\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/textCounts.js\":\"17efc1e0f00d0181\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/colemak-keybindings/index.js\":\"0dc732d351767a85\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/CommandPalette.js\":\"3b69c59f4499ed9a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/HeaderItem.js\":\"8042a8d31e6da420\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/context.js\":\"673f33ef178b4105\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/index.js\":\"5e3301e7b4fd346a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/selection.js\":\"5eaac1ea408a7e37\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/toggleStore.js\":\"0e06c7c488202496\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/useCommandPaletteActions.js\":\"5ec9ae5d50156426\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ContributorBadges.js\":\"469cedb5f8952297\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ProfilePicture.js\":\"1f0f82bed4d57101\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/author.js\":\"5005bb0b7acce8ce\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/codeMirrorExtensions.js\":\"e10c5a057f5fd3ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/dataExtension.js\":\"cb6e9b07a7d787ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/index.js\":\"cca2498287d45ce8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/mentionAutocomplete.js\":\"6189d32c026a897a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/processor.js\":\"a75e15c4218fdb2a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/profiles.js\":\"120af7fbb5cfeed3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/queries.js\":\"5aa97e08ee66c609\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/schema.js\":\"a6e0a5b336fd00ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/useCommentAuthor.js\":\"3532c1faa410d626\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"6f815a5e58ef1291\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b90e79d22397feff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/index.js\":\"8a29b060381a6939\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a407cafe8e1e1334\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7a5826e1da8031dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/CalendarGrid.js\":\"b7dab21b10e6006d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DailyNotePicker.js\":\"c9f2f1a55155cf16\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"743b56f8a90a9de5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateNavDecorator.js\":\"77e1f44101da236e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateScrubOverlay.js\":\"3a8bac9d207ddca6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayPropertyControl.js\":\"6e6c46c3df472c6c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayValueReferenceControl.js\":\"ac026cf51f49b340\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/HeaderItem.js\":\"e7fc2ccf79bc6db7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/ReschedulePicker.js\":\"a9af9488af061dbc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4f7a6aef73a4f856\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/actions.js\":\"793215022eff9e2b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/blockDateAdapter.js\":\"643c9de1d7bf8ca5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/calendar.js\":\"3d1973f107e47e13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dailyNotes.js\":\"f24941ba51be39c3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dataExtension.js\":\"e7cd82771fd64532\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubActions.js\":\"73e368bd59d004dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGesture.js\":\"cbc3ca90ba230276\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c168d4a8c20bc39a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubRecognizer.js\":\"e908c4da03917ab3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayProperty.js\":\"9af3ad257e786283\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"bac82ed339b2630d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/deletionGuard.js\":\"c756e98a37e3e9af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dueQuery.js\":\"da8118c523eb9bc2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/index.js\":\"3c22e97f81a2fa34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/landing.js\":\"ee7618addb6ebdf8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/localSchema.js\":\"513e2c40598d8c01\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/referenceDateAdapter.js\":\"ac79b7e14a39d9a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/rescheduleAction.js\":\"d3c82ec2de831300\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/schema.js\":\"6a76fd48306c3539\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadBlockDates.js\":\"ddbfd983c4fe10ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadDatesAction.js\":\"27f3f3a0f31451f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/today.js\":\"e01ead011bef108f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3770d36606cf5653\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c4896034b14de3df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/audit.js\":\"f755a568cb39a355\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditAction.js\":\"a9ca7ba495e5fb64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditRanges.js\":\"152a06fa029fd802\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/diagnosticsSource.js\":\"c484775de9facc8b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/divergenceScan.js\":\"82776e4fddb8f846\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/index.js\":\"3f8b7201efaff871\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b147428f962893fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/referencesMirror.js\":\"a3bc426c25468416\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/rowJson.js\":\"4a4a91049bd717c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/schedule.js\":\"a2a1240d881c686a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/store.js\":\"6262cfc19baa60dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/action.js\":\"101052f50ec3cf4d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/index.js\":\"60c8c7ceaad34064\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/plugin.js\":\"ee18aec58c196f55\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"08013fee22c2e35e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/actions.js\":\"0ef9fcc88925c322\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/changeMarker.js\":\"ec77c9ee2d862e3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/diagnostics.js\":\"c34426afbc0deff5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/fileSystemAccess.js\":\"47c453dec2ef13f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/filenames.js\":\"d893d9f01b0fc12f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/index.js\":\"8343164b486beaa5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/mirror.js\":\"3bc21a48ea941f0b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runLock.js\":\"70efd2ee5c8b722c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runtimeHealth.js\":\"4361aa4d2b78fee3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/schedule.js\":\"c37492b78500992f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/store.js\":\"d43ea1359f90a17d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/index.js\":\"f9a4645d48b1928c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/themes.js\":\"347dfda8f2ed9d9d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/facet.js\":\"a4ff33e951e90fb2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/useDiagnostics.js\":\"23bc9503b0f46834\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/dismissals.js\":\"3e5b64d31083a8dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/index.js\":\"b80d2a9c9f6b10a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/status.js\":\"040bdb383fc738be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/store.js\":\"ded8e9584f7453b5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"15d163443585e459\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsSettings.js\":\"ec5bc5fdb58f36bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/actions.js\":\"b208311b0a0b2f37\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/config.js\":\"33ef3952babb6f6d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/dataExtension.js\":\"e5ef62853d37ac16\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/effect.js\":\"d2dba6657864f9d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/index.js\":\"f8ddebfdb8006dc3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/propertyEditorOverride.js\":\"8297831ff47b6d01\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/useToggleTree.js\":\"47edfe355d9b6403\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/ExtractTypeDialog.js\":\"cdfe25dbeaee99be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ceb951727394fd5c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/PropertyShapePicker.js\":\"0ac877fe817b4a6a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/action.js\":\"b680c75a1cea6700\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/index.js\":\"1651f9d00ba87a4d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/FindReplaceDialog.js\":\"797c7c7e71ac1302\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/HeaderItem.js\":\"f883e36a6c834524\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/dataExtension.js\":\"47f0f5eace647e17\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/index.js\":\"50278ec599544628\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/search.js\":\"e492357ab3f673a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/toggleStore.js\":\"20ce1ff1f66674fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/LocationPropertyEditor.js\":\"c1e77858bf3cdf0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/MapView.js\":\"62c72e04bc6664a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/blockTypes.js\":\"e891a52cb811fd4e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/codeMirrorExtensions.js\":\"2c45e751ffb02fd4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/createOrFindPlace.js\":\"9b6961a60dc64ea4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/currentLocation.js\":\"d3f325604b06b464\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/dataExtension.js\":\"128100f349ea2147\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/geoContentDecorator.js\":\"d799e7e1b0af1cbc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/googlePlacesClient.js\":\"4bb4004d60eaff54\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/index.js\":\"d40c4e7f6d050ea7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/locationsPage.js\":\"3243b31a6639c4ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/mapViewport.js\":\"7919334006634ab0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/pickCurrentLocation.js\":\"6e097cfed8afe63f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeAutocomplete.js\":\"c05fe8d76356752b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeNameCollision.js\":\"9d3e75f0a5b796a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/properties.js\":\"9921990c80febb30\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/propertyEditorOverrides.js\":\"7184cc30a42855ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/query.js\":\"74f114d4f69495a3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/usePlaceSearch.js\":\"b613760f78bd852d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"122b7cf6f46165b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c55181cb3bf3e8ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"c60f2258db22dd0b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/config.js\":\"4ea032ae8691369d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/dataExtension.js\":\"fff44ffe7e9ae85c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/facet.js\":\"33b003a0ae3b0827\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/grouping.js\":\"e7a156cfac16587e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/index.js\":\"bdf6e5bfd90d385f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"cd145b3e2a1c3646\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/query.js\":\"d603082f166cce12\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/resolveConfig.js\":\"1b81f618f45586fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"b19fb5df49bc5075\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"549b97ff5fc208dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlDocumentContent.js\":\"21fd0d21fdfab88a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlFrame.js\":\"16bb895095b1e669\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/actions.js\":\"ead8b3e708519a5a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/blockType.js\":\"d93a98b58a970873\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/confirmRunScripts.js\":\"1c003dfac5a3d56f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/dataExtension.js\":\"5834d33c6c94fa96\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameAnnotations.js\":\"ead3a2caa27a2a45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameDocument.js\":\"8d9aff8ce20271d7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameTheme.js\":\"e1a52cecda943e75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/index.js\":\"d9e8098128f88acf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/scriptConsent.js\":\"579432b32306397f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/sourceMap.js\":\"defd403e3872b122\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/useDocumentScripts.js\":\"0a54f2aebae2fe3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/index.js\":\"f92eda0c6edf52a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/record.js\":\"d6dd23511b8e1edf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/recordStore.js\":\"4f6902870ff92f63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/responsiveness.js\":\"58de4e4fcb79657e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/schedule.js\":\"9cab7a94974ee112\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/sessionContext.js\":\"5cee8bfbb1f5068a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"576b0d033a438558\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"81ffa4d1fede1fb1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/actions.js\":\"8525d8c11bcce8bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/config.js\":\"c8f7a42fd7272c35\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/dataExtension.js\":\"583ea0c31c1c362f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/effect.js\":\"5532e9c6c907c8fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/index.js\":\"525f2ebab92d3d7e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/keyCapture.js\":\"5f0c3e9a4645a35e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/overrideStore.js\":\"1a247869e63027e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"fa1482db9b214c46\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/HeaderItem.js\":\"2b62a4deb7658faf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/LeftSidebar.js\":\"e26e1e52725c1271\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/actions.js\":\"c0eaf580b3d0d8bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/facet.js\":\"49fce2999ee578cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/index.js\":\"b4f0eca156b01d90\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/shortcuts.js\":\"b33c07f639057286\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/toggleStore.js\":\"bef91039b0e13015\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/MergePicker.js\":\"a9f38c1bbffd4108\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/index.js\":\"2347aae84d6a9e06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/mergeAction.js\":\"f542e027581a1db2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/strategy.js\":\"3f5268d2e650f3d1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/Button.js\":\"54efa709916d612e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"73805a7b95349045\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d82eaeb3c06f318d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/facet.js\":\"df70f60bbdbd792c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/index.js\":\"5845a5b2dab5d5cd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"7ac376fa4ad122c1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/actions.js\":\"71cc01a2530b3f57\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"415487e82e192d96\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/facet.js\":\"abadc0eb57298dcb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/index.js\":\"7be48210f04b1ce7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/MoveDestinationPicker.js\":\"91f1ab7fcfcd8615\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/blockSubtreeMembership.js\":\"882a0e9ee809bd76\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/contextMenuItem.js\":\"c5356b012185023b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/index.js\":\"97ac89f0802174b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveAction.js\":\"1534a9bb6f147c69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveBlocks.js\":\"46ce1cabd03a2abb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/selectionAfterMove.js\":\"e8b732d051a4f595\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/TutorialBanner.js\":\"d9b4c540ae6b069e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/action.js\":\"d56c3d9ebf055dc2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/bannerDismissal.js\":\"8670f7f298f892a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/documents/cheatSheet.js\":\"7a8ebf3982c6d599\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/index.js\":\"388c5ec8d2f3f214\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/keys.js\":\"eec7fb9ba08e29f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/landing.js\":\"c294f0bd9d471d5f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/outline.js\":\"fda2d9dee8967087\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/seed.js\":\"3efdfb850ca230fb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/PerfTrendDialog.js\":\"79a110d48a85bae8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/analyze.js\":\"000e635fa6c6f4ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/diagnosticsSource.js\":\"f40204ae542d82e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/index.js\":\"69261bcf6e4df671\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/load.js\":\"06f70187a92614eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/monitorRun.js\":\"1989802c14c494a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/schedule.js\":\"93d7d90e71aa74c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/series.js\":\"873fb6a763153030\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/store.js\":\"321257b5f13e6976\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/trendAction.js\":\"faa0500317211f2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/verdict.js\":\"3ceb1d0c6ee7d5cd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/clickToEditAction.js\":\"0141b5a81e28a2d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/index.js\":\"20b1e60bd8f2a8ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/interactions.js\":\"f9e3b18fdfa3bcba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"17cbd9ab13bb55ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGate.js\":\"facb8aa6e8597b34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGateDialog.js\":\"3bed7b2cc68e1451\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/action.js\":\"b12cd1c45c90cd47\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/index.js\":\"c4599da953d10b41\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/localRunMessage.js\":\"e7f138316904121c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/plugin.js\":\"78e53a7ed8c0831e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/progressReport.js\":\"0f4686d346e22ebf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/sweepProgress.js\":\"964b951a15dc6844\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/FieldRowRenderer.js\":\"5ef0b2126cffd540\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/ValueRowRenderer.js\":\"b6caa6d8a73b7b4d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/actions.js\":\"7b80c48d0cc222c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/autocomplete.js\":\"c74dbe0e9cfb99b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/fieldRow.js\":\"1b5a8ad7ebbb06e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/index.js\":\"c201e682b5b3c968\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/referenceWarning.js\":\"838fc5453777f22c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueAutocomplete.js\":\"2b11f49a4917eb63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueSchema.js\":\"1896d5087980337e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/HeaderItem.js\":\"082ded19f37afb1e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/QuickFind.js\":\"6b65df9146c4ffac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/index.js\":\"5a9a8a543149675f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/recents.js\":\"76581dcd6eca6f44\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/resultItems.js\":\"acdc5bfd9153fd04\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/selection.js\":\"ee2a9aaa77345cb5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/toggleStore.js\":\"90f90be75b8b3305\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/HeaderItem.js\":\"063c7b52c605494b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/RecentsPageBlockRenderer.js\":\"f57aabdd688cc3da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/grouping.js\":\"4b87422c830f031e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/index.js\":\"10c0a4668bcd7ff2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/target.js\":\"ea47279b2a6b57ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/codeMirrorExtensions.js\":\"fdd1cb3da7ea2dda\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/contentPrefill.js\":\"814039c4bfbcf171\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/dataExtension.js\":\"7e6e503f7adbdaf2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/index.js\":\"54784067c72e9ae6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0931c345efd794cb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/invalidation.js\":\"3113ba3bbaf8d617\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/localSchema.js\":\"2f88524fe1d6bd11\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/index.js\":\"b366a9e2ba85f2a9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2ef67f10fdefc957\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/index.js\":\"51ac0d90402bc5eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/referenceNode.js\":\"9a9cc4a1ead238ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d0596c88c330cf46\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"25b6d21c257ee7ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/index.js\":\"040b7b7eb50e6fcf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"fece1603d285688c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3b348059226e7c95\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/mergeRetargetProcessor.js\":\"bb27c18e13a2ca3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/parseFence.js\":\"ee67a99d67b4c764\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceParser.js\":\"658e9fa13646084c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceProjection.js\":\"dcf44db777e3fd2c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referencesProcessor.js\":\"834deaeb6f01a54f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/renameProcessor.js\":\"d7f554395650dc62\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/spanReplacement.js\":\"20a5bb59bc23bb5b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/htmlToOutline.js\":\"eb97e2a72d93e2f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/index.js\":\"e5b2fd0a48179053\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a64617c45dfa3335\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/pasteDecision.js\":\"408e90bfcca45e6a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/action.js\":\"8abe6c23499eae6e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/blockIds.js\":\"2b1278e3d443a253\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/content.js\":\"9989375a3ee19914\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/effect.js\":\"36c467501c1c398c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/ids.js\":\"121978524e24b802\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/import.js\":\"d4c3f5e69e7863e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/index.js\":\"7872dbeb519ec3f8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plan.js\":\"978f954997887159\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plugin.js\":\"927d5af66c0c232b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/promotion.js\":\"d26651a566e1ae9d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/properties.js\":\"b807ce8a3532331d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/references.js\":\"748fccb4e0c73f47\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/report.js\":\"a3faf6c22ae5ab5d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/roamMemo.js\":\"7d318659c246eabf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/runtime.js\":\"b831c3ed5f6f20e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/schemaReconciliation.js\":\"a3fd320dfe53781f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/srsMarkers.js\":\"cb5ac5411cb766b9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/todo.js\":\"71bf6490a55379fe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/typeCandidates.js\":\"170025c618ef3402\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/types.js\":\"96eacc323a5e4d01\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/index.js\":\"63abcda5075784a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/store.js\":\"07eaf80955c9ece0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/HeaderItem.js\":\"ddd880b7aeca3431\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"b5d286cfb5f6b4ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/index.js\":\"e1430c6f7425d6bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/model.js\":\"7a7b879c2787b787\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/toggleStore.js\":\"870dfd1515eeb224\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/useKeyInspector.js\":\"2edc771aedb34757\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"3f0861d455a73f67\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/ShellDecorator.js\":\"f7667c06e0a78ca4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/actions.js\":\"34c38f0769ee78c1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/exclusionsFacet.js\":\"52cd797648e77eee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/index.js\":\"64f5c22f813da52c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/shell.js\":\"a71e6c17b42e4596\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/surface.js\":\"8954bac83cb44854\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/walker.js\":\"c132c3349f565998\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/RescheduleToast.js\":\"5ab53f1689ec721e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/dataExtension.js\":\"dace0c57a19cd8b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/index.js\":\"93e9010438b7ddfd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/indicator.js\":\"e0d7d7e30b6d04af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/moveSrsState.js\":\"61ee7eab127a4174\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"31f7ebefe6b39aec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/scheduler.js\":\"6f9f8b7320d3c9e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/schema.js\":\"f1efb53423531a7b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e553eda80608a97f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsClipboard.js\":\"82b13bc3301a5f19\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e2ff3d5461bdfa0e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DailyNoteReviewHint.js\":\"acbffcd0f088bbaf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DeckPicker.js\":\"758d309e45056c38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewControls.js\":\"942602844aedf049\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewDeckRenderer.js\":\"b312044fc99e5b54\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewSession.js\":\"02dc7ce93a8f17ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/actions.js\":\"67b7e27da16d297c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/archive.js\":\"50f5f9f71aefe9dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dataExtension.js\":\"9ad5148967507b9d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/deck.js\":\"5d7c24ab3a249a1f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dueQuery.js\":\"09658bd0b6ff7191\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/gradeDecision.js\":\"eb439e29d74ed123\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/index.js\":\"ead0ac434180c36a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/keyHints.js\":\"90f1584a0aadec38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewCardLayout.js\":\"ebef44a6bd648427\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewProgress.js\":\"d946510d6e796ec0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/schema.js\":\"62c1d28031bdcfdc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/useDueCards.js\":\"07b1a7725a562080\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/index.js\":\"f1233c8e3d6c0f4d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/record.js\":\"ac62b8a714297417\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/index.js\":\"f48229734968c36b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/persistenceStatus.js\":\"6a90ef4137a61a6a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/requestAction.js\":\"9c4b1ffd5b88011e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/TypeChipsDecorator.js\":\"437d0d545508df74\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/codeMirrorExtensions.js\":\"ae43ee61f3ded8d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/index.js\":\"51ae9569b38f5b31\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/typeAutocomplete.js\":\"f296e3083bd793a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"86fa7fe2e52870ef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/actions.js\":\"34427e65945776f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/anchor.js\":\"7b59db0b83e85d9d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/events.js\":\"124a034ee813c174\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/gestureActions.js\":\"951823aac62e3837\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/index.js\":\"d34d20bdcf798a11\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e44a3b1de54a43ce\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/collect.js\":\"52638f708e176247\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/index.js\":\"d302651aeb3e12ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/record.js\":\"05b10f76f4e6041b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/RejectionDialog.js\":\"76d40d6810b86b9a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/SystemStatusHeaderItem.js\":\"5d6ce97c470b634d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/index.js\":\"b1ee4cb1174fdd33\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/model.js\":\"a3ebaf9cb4a26a59\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/queueCounts.js\":\"914522e6df6c9c7a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rejectedHelpers.js\":\"a48623552571a929\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rematerializeAction.js\":\"f2e05950c324ab0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/useHysteresis.js\":\"340421da65bda9de\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/ColumnHeaders.js\":\"2e3183ef37cefbc2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/QueryUi.js\":\"194472c3ffa945e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/TableLayout.js\":\"fe0d4439bf465de9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/actions.js\":\"c78194e1ca35359a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/cellEdits.js\":\"2f923045d8caa83f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/childrenViews.js\":\"a7b127bb72ad8a99\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/columns.js\":\"f76361853d0e2ecf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/controller.js\":\"cbe2655206ef167f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/convert.js\":\"54bcc0b2513dc84a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/dataExtension.js\":\"728802b335dc0f7b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/index.js\":\"2bee1dc405b5b69e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/keys.js\":\"d24eb964b68baa83\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/model.js\":\"89804ed37427965b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/QueryText.js\":\"6b1bd5276688918e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/backfill.js\":\"dd5b9ab39c9f3ef7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/completion.js\":\"858c8b7fe5c0045d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/format.js\":\"e6da36d6050dd126\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/parse.js\":\"adab2b33180deb70\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/queryValue.js\":\"dcea4c693082afb9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/registrations.js\":\"57c3d6987c0a85f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/source.js\":\"e8795fd2a6abd5b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/registry.js\":\"4e0581c80ac9595a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowGutter.js\":\"e8826901e585dc5f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowVerbs.js\":\"d3a1b6a413c8ab3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/schema.js\":\"edb42a68b74d59e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/sort.js\":\"c4da8b51d6d1f59a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/effect.js\":\"7f910e5ea58ec63e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/index.js\":\"3babd6e3dc8f27d9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/theme.js\":\"90cc11d9d84e5399\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/actions.js\":\"6207b8a9fb9ec5b1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/dataExtension.js\":\"2a96b55bdf307e88\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/index.js\":\"4b8092c32baf16b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/schema.js\":\"d1102580843854f5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d89f78b95dcb9b58\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/actions.js\":\"fb927f2d8db5c929\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/defaultItems.js\":\"47a6a2637213df8e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/facet.js\":\"4c3b76ad391220af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/holdRecognizer.js\":\"a00dd5be0e8a15a3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/index.js\":\"1730f467dcfb4701\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/UpdateIndicator.js\":\"d8dbce8607e25e9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/index.js\":\"8c321e1105333eb2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/loadTimes.js\":\"f5dd97621ddffcc7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoNotesRenderer.js\":\"5ee41096f8940776\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoPlayerRenderer.js\":\"cc31d150f4b18103\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoTimeStamp.js\":\"cc04434f915868b2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/actions.js\":\"d438bb5c02ff07b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/index.js\":\"e3498d0672ea4379\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/markdown.js\":\"a405ab7b0eaed887\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/notes.js\":\"ae86821f90b50999\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/registry.js\":\"7367a5deeb6e285e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/remark-timestamps.js\":\"aa248cb76fbaadeb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/view.js\":\"823f9b536b904928\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/LinkHints.js\":\"b63eb9127a5ffeb5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/index.js\":\"194d504781390f0c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/model.js\":\"3042d39045c1363a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/settings.js\":\"f4b0b0b3e7666c10\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/actions.js\":\"8cc6462d2e58844e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/index.js\":\"a493ff995bb15e96\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/interactions.js\":\"1e6d02ae9765287e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/workspace-header/index.js\":\"80c430a8d2100ac7\",\"/knowledge-medium/pr-preview/pr-1899/src/registerServiceWorker.js\":\"6d5cfb046c4644d0\",\"/knowledge-medium/pr-preview/pr-1899/src/requestPersistentStorage.js\":\"8b50376690605ee6\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authRequestDeadline.js\":\"69af4506cf2a1406\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authStorage.js\":\"31c8285468463059\",\"/knowledge-medium/pr-preview/pr-1899/src/services/powersync.js\":\"2d9357da9a5f0459\",\"/knowledge-medium/pr-preview/pr-1899/src/services/supabase.js\":\"e1816e9e73b4d97e\",\"/knowledge-medium/pr-preview/pr-1899/src/services/uploadErrorClassifier.js\":\"8b31f4fb9330f127\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/ActiveContexts.js\":\"b1d5a86f8f02b882\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/HotkeyReconciler.js\":\"276d10c5352002c0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/WipeLocalDataDialog.js\":\"1781fcf54627ac1d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionDispatch.js\":\"b49ca15590003862\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionRefItems.js\":\"ce46b3ea45ac860e\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/applyKeybindingOverrides.js\":\"8994cdefd3d5adc0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockActions.js\":\"f13ce015b38d00db\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockMergeGesture.js\":\"1a9dbe9e0449af62\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/canonicalizeChord.js\":\"b4f22e52439d7f28\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultContexts.js\":\"1f38306e09e9f881\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultShortcuts.js\":\"81c5f5da03dca492\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/effectiveActions.js\":\"919ec44cac41753a\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureAction.js\":\"108e9183488871e4\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureBinding.js\":\"76ed31944c9bf5a8\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/holdRegistry.js\":\"de2c451e07b52635\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingConflicts.js\":\"3d38fde3fb4da29e\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingOverrides.js\":\"464d65b0dd6922e5\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/pointerAction.js\":\"38d2cfd26e9de093\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/resolve.js\":\"bceadd2055bf0c6b\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/runAction.js\":\"f84992e0ed4d96eb\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/sequenceMatcher.js\":\"d5cab70fbbc797ad\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/types.js\":\"19ca1209e1fd22b0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionContext.js\":\"bdea3b2712c50d6e\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionDiscovery.js\":\"99aac8111a2752d1\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/utils.js\":\"dadd9b11dfea2fd5\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/bootStore.js\":\"8374d91caa4bf232\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/previewDatabases.js\":\"bbd2ac7779a14b60\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/byteTransform.js\":\"879640934ed7e1dc\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/attachmentCleaner.js\":\"a7a3e03f1c65369e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/attachmentParts.js\":\"ba2558a5f6ea8e17\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleParts.js\":\"0e366e0a249738b7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleRecord.js\":\"5deaea04069db3dc\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/manifest.js\":\"17a90cf095295dbf\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/takeBundle.js\":\"5fd4a4d604cfa9c5\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/verifyBundle.js\":\"724683d7abdcdd4b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/cleaningStage.js\":\"9dfaa1218a0e452b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionKey.js\":\"ebd6f689a21587b0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionServer.js\":\"8c3afbd5cd3669cb\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flip.js\":\"7f5b62fdff33c23f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flipAttempts.js\":\"05d5a9c2947da7ac\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/pages.js\":\"dd8cf42f1d75e011\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/preflight.js\":\"15f87f53b46d322a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/reseal.js\":\"49740a46a30b944b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runConversion.js\":\"732df56bafeca734\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runLock.js\":\"2f62219ac66dd746\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealing.js\":\"7a937307818be5db\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealingStage.js\":\"cfcdb6cbd2c58b97\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/stage.js\":\"7a551fc7d1efd590\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/verifyReseal.js\":\"4e2a9432ccd1a460\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aad.js\":\"96fb1c94a5ad89fc\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aead.js\":\"fcdcacc750463b86\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base32.js\":\"2e048345cfeda17f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base64url.js\":\"6b8a608a624799d2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/binaryEnvelope.js\":\"72d5373fd1c8bc31\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/byteAead.js\":\"d08b4b3013c4be04\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/canary.js\":\"deeb580664e25d7a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentHash.js\":\"1a0a0131f34dfa6a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentKey.js\":\"974a86feb307c632\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/derivedIdNamespace.js\":\"bf1b0c80ec61b833\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/envelope.js\":\"3c7ce0b74c57c017\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/hex.js\":\"4bf71a558d9309d0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/sha256Hex.js\":\"eb516b3685e2a01b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/workspaceKey.js\":\"f24bbfb566a1fbe9\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/conversionState.js\":\"011e42051a038bdc\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/createEncryptedWorkspace.js\":\"01be2eb785a2196d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/pastedKey.js\":\"dc81c7b669172c14\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"c96c5ab61c125021\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/upgradeWorkspacePin.js\":\"63bbb4d0c5b200e5\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/keyStore.js\":\"4f8f53cea89600b7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/mintWorkspaceKey.js\":\"1c7797e33d8d6e38\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/modePin.js\":\"cba51db6dafcb0ba\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/openWorkspaceKeys.js\":\"e96c24bec83c6af7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolveWorkspaceEntry.js\":\"c678c619554c0dbb\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolver.js\":\"0bf95106eb80c43d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/workspaceAccess.js\":\"2a97dd369b467f9a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/transform.js\":\"7405f3ece4147419\",\"/knowledge-medium/pr-preview/pr-1899/src/themeBootDefaults.js\":\"47563a50a9223455\",\"/knowledge-medium/pr-preview/pr-1899/src/types.js\":\"ba7b5c4dccbe37d4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/ClientLocalSettings.js\":\"403463a712c0bb28\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/abortableSleep.js\":\"65a2973090f34b78\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/array.js\":\"9c7871f75ea72713\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/backlinkAutocomplete.js\":\"0a722cc7aca40168\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockCrumbs.js\":\"d1ae5935f6cbb953\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockrefAutocomplete.js\":\"fe0af94c25cadc47\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/cadencedIdleJob.js\":\"12d5a2dd75877ecd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/callbackSet.js\":\"359f8eaa4801ae0e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/clientId.js\":\"dfd643c6fc3981de\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirror.js\":\"30103553d16ef29d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirrorCompletion.js\":\"b50817128f1733d6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/copy.js\":\"0e39ee71d86f8870\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dailyPage.js\":\"546a1080f014335f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensics.js\":\"3d16b0092595208b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensicsHooks.js\":\"a310302cb4e547de\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/deleteBlockThroughUi.js\":\"8a6728d3f25efcf1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dialogs.js\":\"2d671e66601d6505\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dom.js\":\"c38fdd89edb15c27\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/downloadBlob.js\":\"3783a9ed56418203\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/drawnWalk.js\":\"3d385b197ea32f40\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/exportSqliteDb.js\":\"57f26299d540a612\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fileSystemAccess.js\":\"8b5d931e2cb88dab\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/flipSlide.js\":\"9e10e1cb67d14d11\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fnv1a.js\":\"648a28412d7b39f8\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/formatBytes.js\":\"9f72e041e7ae7f08\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fuzzyRank.js\":\"ff5750ef01c382d4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idbKeyedStore.js\":\"d8e7b6eeef6f809d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idleCallbackPolyfill.js\":\"a850e64d22b5eb2a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardAwareScroll.js\":\"befc71f94043e72d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardViewport.js\":\"61638f91660151b2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/lastWorkspace.js\":\"f0cfdac7bbdc7b91\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutColumns.js\":\"0a21bad86d2a69c5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionDom.js\":\"9bbad9708d6ac6bf\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionId.js\":\"4324919de6548d98\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkClickGestures.js\":\"ef6c667404f3b8c5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkTargetAutocomplete.js\":\"d2f840ea94eece11\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbCorruption.js\":\"5ac817225e7dabbe\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbRecovery.js\":\"4b6f3e70408038ee\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/markdownParser.js\":\"796cc113cc6163d2\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/memoize.js\":\"564313faccad1c87\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameFieldCommit.js\":\"87a7156fbbc12009\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameList.js\":\"ce9cd1abb33c731e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/navigation.js\":\"42f9d50a78461b23\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/omnilinerNamespace.js\":\"c6a40984bc5292d6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/opfsPageScan.js\":\"cd83ded4ca31e485\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelClearance.js\":\"659cd9bfd93b8706\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelHistory.js\":\"2d65d2b0b6d4c502\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLanes.js\":\"9c83eab62348a10d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLayoutProjection.js\":\"fc779b8e56b82e5d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelScrollAnchor.js\":\"308b080f3dc37b8b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelUrlFlags.js\":\"593e412f5d807238\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/platform.js\":\"cf3cb022ffdc8150\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/pluralize.js\":\"1417a60cb6b7c57d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyCreation.js\":\"6d9936884185f9c3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyNavigation.js\":\"a6b92c6c41b3eb71\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyValueContext.js\":\"e61ddb87c9ac3712\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/react.js\":\"aaefd4f04b3041e3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeDate.js\":\"b28514e42de656d5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeTime.js\":\"5f9463d43decc747\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/renderScope.js\":\"e79692c47d0c3e62\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/resolvedThenable.js\":\"84e8b56e7b3d1d47\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/routing.js\":\"c668bf4156450b3b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/safeMode.js\":\"c75e6a1eebd361a9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/scheduleIdle.js\":\"5d35240ac2d10068\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/screenWakeLock.js\":\"dde99ed870e6e9c7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/selection.js\":\"0c0ccf86442d794c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/softKeyboardGrab.js\":\"90aa084e246daff1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/startupTimeline.js\":\"4b44874582545bca\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/state.js\":\"593b31348864a2de\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/string.js\":\"bc50db05bb961fdd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/surfaceZoom.js\":\"85f85626c120fa83\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/time.js\":\"5a31e888eccce570\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toast.js\":\"3899417125c39d51\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toggleStore.js\":\"eeed45e081e3c60e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/untilStopped.js\":\"346a43fc600d5dd1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/userActivity.js\":\"53f28b273a1684e5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewTransition.js\":\"2b8e9d73186897f7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewport.js\":\"a2b3c59082b73799\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/webLock.js\":\"9ce81533011f679d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceRecovery.js\":\"69688d6b3e954ebf\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceSnapshotStore.js\":\"a34fd4c6e208253c\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-compiler-runtime.js\":\"750817f0c793a5ac\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-client.js\":\"5c98ce36a0650a10\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server-edge.js\":\"942a52832ae002ba\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server.js\":\"f1b252c4ddfa2726\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static-edge.js\":\"e79c82499b6bf50b\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static.js\":\"ba81792684702361\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-test-utils.js\":\"f16ea8008e2949e1\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom.js\":\"15276a2483ffc2a3\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-runtime.js\":\"79c92d85b1f29a97\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react.js\":\"d3500da4ff777e96\",\"/knowledge-medium/pr-preview/pr-1899/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
