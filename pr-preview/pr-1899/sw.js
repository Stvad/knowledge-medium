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
		buildId: "77c3f60305c4-e864e36d",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/\":\"1e8799b69a9845a6\",\"/knowledge-medium/pr-preview/pr-1899/index.html\":\"1e8799b69a9845a6\",\"/knowledge-medium/pr-preview/pr-1899/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1899/assets/FacadeVFS-B9jLqfab.js\":\"763eb4093bd8fee9\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSCoopSyncVFS-DtwLKy83.js\":\"f73515a3f3333054\",\"/knowledge-medium/pr-preview/pr-1899/assets/OPFSWriteAheadVFS-BONy0fP0.js\":\"887ab736a6c34c93\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-DLFUAwdX.js\":\"a0e59f29cbc87ea2\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/assets/wa-sqlite-async-BshiGTRj.js\":\"4e27ce816562316b\",\"/knowledge-medium/pr-preview/pr-1899/assets/worker-Bk7aBePL.js\":\"d82d7b0a70bac9ec\",\"/knowledge-medium/pr-preview/pr-1899/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1899/chunks/app-DfgrbnEk.js\":\"4d5fd2148d684fa4\",\"/knowledge-medium/pr-preview/pr-1899/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1899/index.js\":\"6ea6c1909a297a01\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1899/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1899/assets/AccessHandlePoolVFS-CyBIsY5o.js\":\"0af4b2b63384cece\",\"/knowledge-medium/pr-preview/pr-1899/assets/IDBBatchAtomicVFS-qTpzDvaH.js\":\"d09c029ddd907795\",\"/knowledge-medium/pr-preview/pr-1899/assets/MemoryVFS-Cbqj_-X1.js\":\"db2fee2b41dfcb76\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cof1KQIi.js\":\"e3aa4671dc972e48\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-C6Nt3FpC.js\":\"ad2ce872698709cb\",\"/knowledge-medium/pr-preview/pr-1899/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1899/chunks/AccessHandlePoolVFS-BI9mFRfp.js\":\"ef4eab78a40a3c12\",\"/knowledge-medium/pr-preview/pr-1899/chunks/FacadeVFS-SzZ9Wxlx.js\":\"508591a1e15180ba\",\"/knowledge-medium/pr-preview/pr-1899/chunks/IDBBatchAtomicVFS-Dhba0eoX.js\":\"a85b816dc902984f\",\"/knowledge-medium/pr-preview/pr-1899/chunks/MemoryVFS-D4Ix2lFD.js\":\"8f8a955c81baaa08\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSCoopSyncVFS-BrvKKCCj.js\":\"51e20fa54152dcd0\",\"/knowledge-medium/pr-preview/pr-1899/chunks/OPFSWriteAheadVFS-Becuabv6.js\":\"3fa4cfd69fd392d0\",\"/knowledge-medium/pr-preview/pr-1899/chunks/Preview-CTa-1fMn.js\":\"9a06b555bdc39189\",\"/knowledge-medium/pr-preview/pr-1899/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/card-Dlu2EtHv.js\":\"78cf0781ebacef0f\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist--vftktMP.js\":\"bd6e8a3b0464d567\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1899/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1899/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-KOTd-Jz-.js\":\"830f130835e933c7\",\"/knowledge-medium/pr-preview/pr-1899/chunks/mc-wa-sqlite-async-DXpyFyuH.js\":\"07d730191d5534b9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-45N5VEyN.js\":\"7c1e9dd4a0c3bacb\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-CIv6_8w3.js\":\"965e565eb601f39a\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DUpTF6i4.js\":\"86852a8566df9b02\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DgBBzZGH.js\":\"f6e14a31ca06b912\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-DxsB9iaZ.js\":\"593fae05cf945ae6\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server-legacy.browser.production-Cj9jPiea.js\":\"14390bea614e4d5b\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.browser.production-_9nYlpaB.js\":\"7636f5851cb62198\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-dom-server.edge.production-BHUTa9cD.js\":\"68b1e228805af003\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-fqtlCZLw.js\":\"ebe31c5717e92440\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-q_UIcEe-.js\":\"eb19d6a37eca82b9\",\"/knowledge-medium/pr-preview/pr-1899/chunks/react-uGL7X0ik.js\":\"8e4acec6ab0f5f9c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/server.browser-D_031XcM.js\":\"beef291d62fe8c23\",\"/knowledge-medium/pr-preview/pr-1899/chunks/textarea-x5AxsOoG.js\":\"69e76d461bf6148f\",\"/knowledge-medium/pr-preview/pr-1899/chunks/ui-DQKS6ObJ.js\":\"04002f7c51971d29\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-async-KolfQSRg.js\":\"1536c52324bb822c\",\"/knowledge-medium/pr-preview/pr-1899/chunks/wa-sqlite-jj9ouo2A.js\":\"026bb57fad7ed299\",\"/knowledge-medium/pr-preview/pr-1899/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1899/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1899/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1899/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1899/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1899/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1899/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1899/src/App.js\":\"35ef78aaaf78c34a\",\"/knowledge-medium/pr-preview/pr-1899/src/appUpdate.js\":\"a33f468be325bc38\",\"/knowledge-medium/pr-preview/pr-1899/src/appVersion.js\":\"15f487a121a537e1\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/initialLayout.js\":\"fb085205bca571d6\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/openWorkspaceData.js\":\"08c9e868b47b87e6\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/resolveWorkspace.js\":\"2da6323a2fcaf22a\",\"/knowledge-medium/pr-preview/pr-1899/src/bootstrap/workspaceBootstrap.js\":\"5e1d0db669c05656\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockComponent.js\":\"7df3da4ba9390460\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockCrumbs.js\":\"5936096db379b879\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockEditor.js\":\"971cecf307815824\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockLoadingPlaceholder.js\":\"5568fccc45a94470\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockProperties.js\":\"96d3524f7f611872\",\"/knowledge-medium/pr-preview/pr-1899/src/components/BlockSearchPicker.js\":\"173031b6748963ff\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ConfirmBulkDeleteDialog.js\":\"258e3f4b6b84460f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DividerHandle.js\":\"900760546fdf7011\",\"/knowledge-medium/pr-preview/pr-1899/src/components/DraftEditor.js\":\"a6e99e66d3aededa\",\"/knowledge-medium/pr-preview/pr-1899/src/components/GutterPill.js\":\"b88b8d553bc1b87f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Header.js\":\"915addfce325040b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/LazyBlockComponent.js\":\"7eba1f04a075ec6c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/Login.js\":\"2accb61cab23317f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ZoomableSurface.js\":\"a9394ce8dc3d71c5\",\"/knowledge-medium/pr-preview/pr-1899/src/components/editModeKeepalive.js\":\"09968e4f87dd9b9e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyDisplay/PropertyDisplayScope.js\":\"55b9a1802d06e530\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"abb0f98cc617f602\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefPropertyEditor.js\":\"a2c916f4a9aac5ac\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/RefTargetTypePicker.js\":\"c0207159cd0f3502\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/SelectPropertyEditor.js\":\"84c2224c8283b9ef\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/TypesPropertyEditor.js\":\"24fef34b8ef7aed0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/defaults.js\":\"19644082b293d978\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/kernelValuePresets.js\":\"7aea9d4b5a9aee4d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/selectablePresets.js\":\"aa32f59a29c0ee9f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyEditors/typesPropertyUi.js\":\"03c39d358d226f86\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/AddPropertyForm.js\":\"0e6be5fc2525351a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyPicker.js\":\"2d581482e0ae3f9f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/PropertyRow.js\":\"d6e326c5bb780eed\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/Rows.js\":\"7ec5e1497ae2c6ff\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/actions.js\":\"667935ea803621c7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/declarationOnly.js\":\"231ce2cd15f75790\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/layout.js\":\"ca8252f2d36e7f80\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/model.js\":\"a345492f37385c8b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapeUi.js\":\"b6e55a4470d7a46a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/shapes.js\":\"6cd3416028609f61\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/usePropertyEditingActivation.js\":\"8493090da7183ce3\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanel/visibility.js\":\"07faa8105989a045\",\"/knowledge-medium/pr-preview/pr-1899/src/components/propertyPanelSections.js\":\"40bd06476de389fd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockEmbed.js\":\"2e7fcf1fcf1dd927\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockLink.js\":\"9609fae373d5452b\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/BlockRef.js\":\"c5dc15a10cabab44\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/CompactReferenceLink.js\":\"589f081c84562158\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/ReferenceLink.js\":\"554b186225004178\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuard.js\":\"7f62d00d01b0190a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/cycleGuardContext.js\":\"00d0821247d810c7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/linkInteraction.js\":\"a591065a2982eb4f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/referenceLayout.js\":\"428cf460c38286b2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/references/useBlockRefAncestors.js\":\"fe97023b1edaeb30\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockGutter.js\":\"7714c1f16e1a504e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockInfoDialog.js\":\"4e9d9362e8409be0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockReadText.js\":\"cbacffc56f60ca11\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BlockTypeBlockRenderer.js\":\"d81ac74648cb2480\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/BulletHoverCard.js\":\"d309dfe25ab62acc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorContentRenderer.js\":\"c30bedfbd804c007\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c1e1bbc9e22102b1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ColumnResizeHandles.js\":\"ac52336584d02695\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"3c891f735cb6adac\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/DefaultBlockRenderer.js\":\"e6315b6220175313\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/LayoutRenderer.js\":\"4a1b535ddbccd264\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MarkdownContentRenderer.js\":\"527ce37a24d97d15\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/MissingDataRenderer.js\":\"7729b05fda429a23\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PanelRenderer.js\":\"50c694ca07b447c0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/PropertySchemaBlockRenderer.js\":\"fd07a982d5849b05\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/TopLevelRenderer.js\":\"17e570f2919553e7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockGutterMode.js\":\"b029f975c6b43f27\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/blockTitleText.js\":\"971dc0b3a52ac4b1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/fieldCreationKeydown.js\":\"b8cc5e07ad4c9e6c\",\"/knowledge-medium/pr-preview/pr-1899/src/components/renderer/layoutRootContext.js\":\"e400693b6c15a4b1\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/TypeChip.js\":\"3fa88b254e2fb01f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/typeChip/chipStyle.js\":\"ac6e1a365d733f69\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/anchored-floating.js\":\"7235144f517bb617\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/button.js\":\"de22a69a4623c242\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/card.js\":\"33d4d164a0860df0\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/checkbox.js\":\"9ab751c51b59a52a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/collapsible.js\":\"09ec5a21976726a9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/command.js\":\"d2ef50a34c32faa7\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/context-menu.js\":\"050d7df2f8206f55\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dialog.js\":\"f2044996b8891b27\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/dropdown-menu.js\":\"c2d27ebcd000e0de\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/floating-listbox.js\":\"6d9f65b0440b7b23\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/index.js\":\"a2ac712529126cd4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/input.js\":\"d695f07ad5ed904d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/kbd.js\":\"be3a641a1c3649f2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/label.js\":\"8c407560709d7e2a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/ui/textarea.js\":\"b57ee572c1e2a835\",\"/knowledge-medium/pr-preview/pr-1899/src/components/useEditModeYieldKeepalive.js\":\"7b2f23c5a5e32370\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/BootFallback.js\":\"7bd7370902e33edd\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/FocusedRowLazyMount.js\":\"dc12a58c28f80251\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LazyViewportMount.js\":\"f5850324b729528d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/LocalDbCorruptionFallback.js\":\"c88e9b8f560edb30\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/error.js\":\"29e1cbb4ccc7e289\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/lazyMountRegistry.js\":\"ae3518e94876bb7f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/util/suspense.js\":\"827f9c2aaa3b026a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/CreateWorkspaceDialog.js\":\"5351f45ef588fbb4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/PendingInvitations.js\":\"2794684c26e527b8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/SyncProgress.js\":\"90ac132e351799e2\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/UnlockProgress.js\":\"bad02122d75afbdc\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceKeyGate.js\":\"2f8d63540664ed98\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSettingsDialog.js\":\"7151bb4ddfec0e7d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSwitcher.js\":\"63b74e684eefe594\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/WorkspaceSyncGate.js\":\"f082bc879d49e5c9\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlow.js\":\"2ac9da01df774ce4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/ConversionFlowHost.js\":\"ced2989088478e8a\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/EncryptionSection.js\":\"eae0a980c1d0e54f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/attachmentPrompts.js\":\"92298e3a25f12374\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/bundleFolderPrompts.js\":\"cc25e348853b0af8\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowDeps.js\":\"6f2f32495e38a76e\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/conversionFlowStore.js\":\"6d901e73ee3f633d\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/flowUi.js\":\"e9fdf9bc594d3385\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/conversion/useConversionRun.js\":\"8b95dcca5fed14a4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/keyUi.js\":\"d7166f20641922ca\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnKeyLoss.js\":\"3693623aec40b08f\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/useCloseOnServerE2ee.js\":\"248c9cb0149ad2c4\",\"/knowledge-medium/pr-preview/pr-1899/src/components/workspace/workspaceUnlocked.js\":\"10bedb2f142a7942\",\"/knowledge-medium/pr-preview/pr-1899/src/context/backgroundSubtree.js\":\"1d6ccb023ed00c86\",\"/knowledge-medium/pr-preview/pr-1899/src/context/block.js\":\"eab0ad18a1e01b8f\",\"/knowledge-medium/pr-preview/pr-1899/src/context/layoutWsContext.js\":\"ab7faca3ddf7da30\",\"/knowledge-medium/pr-preview/pr-1899/src/context/propertyDisplay.js\":\"d0e91795e3cff459\",\"/knowledge-medium/pr-preview/pr-1899/src/context/repo.js\":\"abe2cffaf7c5cef4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasClaim.js\":\"70c09f0e239f043f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/aliasSeatNamespace.js\":\"95b6672ae2b8ef10\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockData.js\":\"b22abe4bfcce94f5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/blockType.js\":\"4cabad41f74538b9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/changeScope.js\":\"55b1f9589e22c117\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/codecs.js\":\"60be00ec16b0a33f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/derivedData.js\":\"590812d62ffec1f9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/errors.js\":\"b3a81d207d703dc0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/events.js\":\"6a8afef60dfc340d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/handle.js\":\"c457f234eedc0953\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/index.js\":\"d08ee57b02fa1a2e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/mutator.js\":\"e28d2a39b4da082a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/processor.js\":\"b587eeb58c5e8ec5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/propertySchema.js\":\"83d9d8ba4b2a60c8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/query.js\":\"eaba4208b87e8bdd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/sameTxProcessor.js\":\"67e51f1e292e564a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/schema.js\":\"c457f234eedc0953\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/tx.js\":\"c457f234eedc0953\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/typedBlockQuery.js\":\"858c1ddf430eddfe\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/user.js\":\"0d71f127f911b11f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresetCore.js\":\"0636a9ca9c602efd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/api/valuePresets.js\":\"0c701b90629e9b9e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/attachmentCleanerIOVerb.js\":\"c0c4b9bed6235c3b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/block.js\":\"1c0b771ac9cb79c5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockCache.js\":\"0dfcaa0590d866c8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockId.js\":\"46242353f83f22b0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockLiveness.js\":\"d281b9c4f3644eab\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockMerge.js\":\"e9db1d6521d12bb6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockSchema.js\":\"24c4bb5fa3f91b15\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypeLookup.js\":\"3a7dcfebed9234a3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/blockTypes.js\":\"247ee31a03de0591\",\"/knowledge-medium/pr-preview/pr-1899/src/data/childrenView.js\":\"bcf6f1be4f2aa0bd\",\"/knowledge-medium/pr-preview/pr-1899/src/data/clientContext.js\":\"cc3eef970bc86e7e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/dbFileSiblings.js\":\"64cb520d1c28778c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/definitionSeeds.js\":\"cd71751dbaa02be7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/derivedIds.js\":\"6be6167eaef50ca8\",\"/knowledge-medium/pr-preview/pr-1899/src/data/drawnSubtree.js\":\"fa2f7d1f3aa73b58\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facetBridge.js\":\"5e071d57ac855129\",\"/knowledge-medium/pr-preview/pr-1899/src/data/facets.js\":\"0aaa66321d7a18ce\",\"/knowledge-medium/pr-preview/pr-1899/src/data/globalState.js\":\"0de50212fd29aef3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/aliasClaimRederiveProcessor.js\":\"9827b0ed6bfeeb73\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/ancestorBatch.js\":\"67bd0d94741f1ff4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/blockTypeTypeifyProcessor.js\":\"ba96a0011667de8c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/clientSchema.js\":\"31c1cf7f0c4aaeed\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/commitPipeline.js\":\"59696c91c826f84f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/devAssertions.js\":\"a0f3069d8cc2d392\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/firstSync.js\":\"9b4c2b7a53a48b45\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/freshInitialLoad.js\":\"e6ef6ccda53ba84c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/graphBackfillClaim.js\":\"2bf71975673e9581\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/handleStore.js\":\"cba54e8a23f2caf1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/idleMarkerJobs.js\":\"fff60af62b2ce797\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initialDownload.js\":\"1751b5922c353765\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/initializeClientDatabase.js\":\"70795da7e9434f51\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/jsonCanonical.js\":\"84e75a482954034b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelInvalidation.js\":\"8f28b4b149bde177\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelProcessors.js\":\"795d3a6e80d94981\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/kernelQueries.js\":\"58b61914df3b5094\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/mergeTypeMembershipProcessor.js\":\"ae964a6a92a0dcc0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/normalizeReferencesProcessor.js\":\"f8022728201dcfe9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/poolInstrumentation.js\":\"81e40745829cbf96\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/processorRunner.js\":\"82e8da84a602f294\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyCellBackfill.js\":\"ab91352599aaf6c2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildMint.js\":\"a5d276b6ff654456\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyChildrenProcessor.js\":\"a12fd783164d21c4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4bf18a082c3ac5e4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyDefinitionSynthesis.js\":\"c775600aed06446c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyKeyScan.js\":\"ddd84384fcc3be38\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertySchemaResolution.js\":\"2d3406ed1f503d44\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/propertyValueEdits.js\":\"08cbf4d415a3bc6d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/raiseProtocol.js\":\"61712bcbb8fe7b42\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/readBatch.js\":\"33383fee40d3d7bc\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/refProjection.js\":\"03b909aaeea1beb6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetLookups.js\":\"0dbbddcd7ca72d73\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/referenceTargetProcessor.js\":\"7d293a090b02a6c1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/replayMerge.js\":\"4ecb84505e64292d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/sqlBinds.js\":\"d32d4359fe28db73\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"a3664bf475eb921d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/arrivalProcessors.js\":\"23e1f32e49c6e35a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/invalidate.js\":\"b2fe26fba40dc069\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/materialize.js\":\"ce70a1b13bcc5fd3\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/observer.js\":\"3ca78f9ffd96a1b9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/syncObserver/reconcile.js\":\"fa0f6cb07d89ebf0\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/timingMetrics.js\":\"a89876d2294b6386\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/treeQueries.js\":\"2f10ee74311ef64f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txEngine.js\":\"178a7191b10b7466\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/txSnapshots.js\":\"5b3498a6f1ef434d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/typedBlockQuery.js\":\"f30ee2d53a685de2\",\"/knowledge-medium/pr-preview/pr-1899/src/data/internals/undoManager.js\":\"0f032660e89b31ed\",\"/knowledge-medium/pr-preview/pr-1899/src/data/invalidation.js\":\"09d11c36d98cebc9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelDataExtension.js\":\"4aca0148af7daaaa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelPage.js\":\"e9bf37e9bff1f68f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/kernelValuePresetCores.js\":\"8bf6ff71f608ab27\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbCorruptionSignal.js\":\"305590970f6e5465\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbStorage.js\":\"4b5c5e873b379b15\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localDbVfs.js\":\"c4cd7f53a47731fb\",\"/knowledge-medium/pr-preview/pr-1899/src/data/localSchema.js\":\"37fac5ad39141fc9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/maintenance.js\":\"582774cbbefff496\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mergeProperties.js\":\"7cbb327bd0ae04d7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/metricsConsoleHook.js\":\"a89fcbbfbfcbbe44\",\"/knowledge-medium/pr-preview/pr-1899/src/data/migrationsPage.js\":\"534b0543c35f8500\",\"/knowledge-medium/pr-preview/pr-1899/src/data/mutators.js\":\"72b55299e24c4b42\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKey.js\":\"e8e86b49d1fe2bf7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/orderKeyPlacement.js\":\"38a0bf2e1c313522\",\"/knowledge-medium/pr-preview/pr-1899/src/data/outlineSurface.js\":\"150ac96860d3fa64\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingEditorContent.js\":\"2c503723ec1ef69a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pendingUploadsSql.js\":\"08b046435ec9a72e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/pluginStateExtensions.js\":\"bdd4258f3dab1876\",\"/knowledge-medium/pr-preview/pr-1899/src/data/powerSyncLogger.js\":\"dd3a43f805014c6c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/projectorRuntime.js\":\"edfd2bdec2dd1c2f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/properties.js\":\"7fd5d387d9e4db91\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertiesPage.js\":\"d9317586c9e66586\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyChildren.js\":\"bfead8233dbe76c9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionFanout.js\":\"e3c20a67493fb423\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionMetadata.js\":\"54fb2cc5b0fa72c1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDefinitionRegistry.js\":\"8d9552697907c44e\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyDisplayMode.js\":\"b65f333213740daa\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertyRowCreation.js\":\"c0ea2491bf18a550\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySchemaCreation.js\":\"de26415779e13605\",\"/knowledge-medium/pr-preview/pr-1899/src/data/propertySeeds.js\":\"6c089ac1a71715df\",\"/knowledge-medium/pr-preview/pr-1899/src/data/recentsPage.js\":\"68f9d5a87110890d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/refTargetComparableProperty.js\":\"7c605222be37f584\",\"/knowledge-medium/pr-preview/pr-1899/src/data/referenceBlock.js\":\"8a0f692e8e486541\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rejectedUploads.js\":\"5753dc14ba90b148\",\"/knowledge-medium/pr-preview/pr-1899/src/data/releasePowerSyncConnection.js\":\"c7eb3d295c94c444\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repo.js\":\"c5e9a6ecb7345516\",\"/knowledge-medium/pr-preview/pr-1899/src/data/repoProvider.js\":\"f3231f555fdc2886\",\"/knowledge-medium/pr-preview/pr-1899/src/data/rowProperty.js\":\"c1e8849638a39dbf\",\"/knowledge-medium/pr-preview/pr-1899/src/data/searchFilter.js\":\"a1fc4dbdacc97f91\",\"/knowledge-medium/pr-preview/pr-1899/src/data/seedIdentityLedger.js\":\"0a8cd95ddeaaa746\",\"/knowledge-medium/pr-preview/pr-1899/src/data/stateBlocks.js\":\"f54fa529b9047515\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralEditPolicy.js\":\"ccb96009524b9ad9\",\"/knowledge-medium/pr-preview/pr-1899/src/data/structuralInsert.js\":\"24bf4a89c3a5a9c1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/subtreeDelete.js\":\"3d9c3c3d26bf6a98\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncStreamLock.js\":\"dae11c3449e68009\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableSqlRecognizer.js\":\"b7ece7757982585c\",\"/knowledge-medium/pr-preview/pr-1899/src/data/syncedTableWriteGuard.js\":\"6d102b4738afa6c1\",\"/knowledge-medium/pr-preview/pr-1899/src/data/targets.js\":\"5b15eb3780c23765\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeColors.js\":\"1c3941aefdeebb7b\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionMetadata.js\":\"73b850c159bbfc71\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeDefinitionRegistry.js\":\"92778de7f35e47b6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeExtraction.js\":\"b1e516d9b61a1851\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeInitialValues.js\":\"b9d84502d1fe8bb5\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typePropertyGroups.js\":\"a11388cd5ed2d455\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeSeeds.js\":\"706ea131a100615f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typeTagger.js\":\"0d6955340c441fb4\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typedRecords.js\":\"612c2c02af4f6220\",\"/knowledge-medium/pr-preview/pr-1899/src/data/typesPage.js\":\"c6cd8ed59bb672ef\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userPrefs.js\":\"bca5d45407a4cf57\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userSchemasService.js\":\"3f842c79383e6884\",\"/knowledge-medium/pr-preview/pr-1899/src/data/userTypesService.js\":\"55b1b7ed34eeaa10\",\"/knowledge-medium/pr-preview/pr-1899/src/data/valuePresetRegistry.js\":\"34000467d24a4eb6\",\"/knowledge-medium/pr-preview/pr-1899/src/data/visibleChildren.js\":\"156ecde366588c5f\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceConversion.js\":\"7adadb34f0026eac\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceFirstSync.js\":\"c42a0dd5583e1742\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceIdNamespace.js\":\"50d5ed682e7e5f7d\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaceSchema.js\":\"3e70d052d67dcaf7\",\"/knowledge-medium/pr-preview/pr-1899/src/data/workspaces.js\":\"0ad5aca050fb8321\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadLog.js\":\"10941b5a127ecf6a\",\"/knowledge-medium/pr-preview/pr-1899/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/BlockPasteShellDecorator.js\":\"4d846c60c6915e3a\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/atTrigger.js\":\"8ec817e295935363\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/autocomplete.js\":\"dbebc72bbf56e008\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/codeMirrorExtensions.js\":\"b86e1888c88cad8e\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/contentFlush.js\":\"4d65f6465b7727b2\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/defaultInteractions.js\":\"24b57f8edbc35379\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/editSettleSignal.js\":\"6eff71c91907547a\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/insertImage.js\":\"8a441b1354be2809\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceCompletionRange.js\":\"de73bc5d6041c555\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/referenceTargetTypes.js\":\"329164eebde895ca\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/syntaxContext.js\":\"a1df2017b8bae1a1\",\"/knowledge-medium/pr-preview/pr-1899/src/editor/triggerMatch.js\":\"715a1a9a99466d22\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/AppRuntimeProvider.js\":\"e64afe49bc3344b3\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/BlockFocusShellDecorator.js\":\"271b2d7a666be8b4\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/ExtensionRenderBoundary.js\":\"12479f6bc47418c6\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/PanelContentRecovery.js\":\"4548f9f01233d11d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/apiCatalog.js\":\"8928c31dd232657a\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/approveExtensionHere.js\":\"8de7cfb30a023541\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/armedCutAppMount.js\":\"ddc822ebfe983331\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/batchableKeyedStore.js\":\"d0c7ee4d6312964e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockInteraction.js\":\"344043ffd49cbb49\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/blockSelectionAction.js\":\"0e9679acaaf0688a\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compileExtensionModule.js\":\"e5c0b0d3a6ffd2ad\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/compiledModuleCache.js\":\"dbc8fa2ae05b961f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/continuousGestures.js\":\"62118013d4b6f118\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/core.js\":\"9bb840138c7fafd7\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/defaultRenderers.js\":\"2ebf41f18b5ec121\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/definitionFanoutAppMount.js\":\"2466118f7a75cbe4\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dialogAppMount.js\":\"b3fb86f5a1516225\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensionSeeds.js\":\"1fdd4115872d31ab\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/dynamicExtensions.js\":\"dc25423fd3acef4e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/exampleExtensions.js\":\"125d6bfeb4e850fe\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionApprovalStatus.js\":\"f211d5f472201192\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrorToast.js\":\"7512c6a4aa8d6eda\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLoadErrors.js\":\"8de649aebe75174c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionLookup.js\":\"95263011a160409d\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionToggles.js\":\"43477f64524e6aba\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/extensionUtilitiesCss.js\":\"50e303bdac33549a\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/kernelPageDeletionGuard.js\":\"f3b7dc2ad99e36f1\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/liveRuntime.js\":\"fe9b2724c3a0ff0f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/openExtensionsSettings.js\":\"119e49442fa43e75\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/overridesCache.js\":\"635c5ef8a417f817\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/pluginIds.js\":\"ea401f61368d25d6\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/processorRejectionToast.js\":\"b0eaaba5ef78163c\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeActions.js\":\"8ff7af243117f4e4\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/runtimeContext.js\":\"64b701147bd1283e\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticAppExtensions.js\":\"c2c87c4617b2f548\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/staticDataExtensions.js\":\"a8eae20bea0075cc\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/toastAppMount.js\":\"247de47b3578ea2f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useOverrides.js\":\"23a2a884e7613a7f\",\"/knowledge-medium/pr-preview/pr-1899/src/extensions/useShortcutSurfaceActivations.js\":\"92dbece375fa44fe\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/discoverToggleTree.js\":\"f8b5e0a04a95e6fe\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/facet.js\":\"0773e9cf0c60ff91\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/resolveAppRuntime.js\":\"272f16402b0c04db\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/runtimeEvents.js\":\"b0b6c656ebd311b4\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/togglable.js\":\"3483b5ac9cfeccac\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/variantFacet.js\":\"9ee25fabdeaf38a7\",\"/knowledge-medium/pr-preview/pr-1899/src/facets/verbFacet.js\":\"6d65b2f4f93d1fe2\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/block.js\":\"128f157f8b0e78ac\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/focusedChild.js\":\"6b7f77b98c1102b7\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/propertySchemas.js\":\"3846df5061bd21c2\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/typeRegistry.js\":\"aa408ae12d072cf8\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAncestorCrumbs.js\":\"ab2a6721200768f3\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useAutocompleteListbox.js\":\"32aca784944aab16\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedSearch.js\":\"ebd241d893a9b674\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useDebouncedValue.js\":\"1424aa83f8756a83\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useFacetValue.js\":\"6f6166ea6a07da0b\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsFocalRender.js\":\"2df8034c1ed84447\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useIsReadOnly.js\":\"9e922b698915aae3\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMaterializeBacklog.js\":\"6747dbfd998dd789\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useMinuteClock.js\":\"5042f414aef33062\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePanelLayoutProjection.js\":\"fae640bcd41b263b\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/usePendingInvitations.js\":\"2974e8d313f64abe\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRendererRegistry.js\":\"c8d6de3556245a34\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useRetainedFieldRows.js\":\"07ef79beb96bda9d\",\"/knowledge-medium/pr-preview/pr-1899/src/hooks/useWorkspaces.js\":\"a587e47971c01178\",\"/knowledge-medium/pr-preview/pr-1899/src/lib/utils.js\":\"ede6239ed9b9c14f\",\"/knowledge-medium/pr-preview/pr-1899/src/main.js\":\"519ec1ebb2af6915\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/MarkdownImage.js\":\"bc338041e7c1b5cf\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/blockSeparators.js\":\"29a6616ef8564131\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/context.js\":\"fd375b4d89214c2e\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/defaultMarkdownExtension.js\":\"38b49b91eb001a46\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/extensions.js\":\"9e12759d418ad088\",\"/knowledge-medium/pr-preview/pr-1899/src/markdown/renderMarkdownHtml.js\":\"a3074b439f50bc00\",\"/knowledge-medium/pr-preview/pr-1899/src/minimal-editor.js\":\"73e8ad5f1e7c9029\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/armedCut.js\":\"cf1f8f0b2dcbe537\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/captureMediaVerb.js\":\"0bd9e2b036140de9\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/clipboard.js\":\"b69cceaa65144b58\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/decision.js\":\"1773321d999f31f4\",\"/knowledge-medium/pr-preview/pr-1899/src/paste/operations.js\":\"911ba2cee0d7eebe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/AccountHeaderItem.js\":\"5218beb3a1698c61\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/account-header/index.js\":\"1587f7034ed88ed1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5b4a908868f82c1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askAgent.js\":\"e4eb8e89ca9a9fff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/askedStore.js\":\"c984d76ea46f3f9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"1ca3a9ec7497d8d5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/chipState.js\":\"6173a0b56b47f37f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/dataExtension.js\":\"510f5e00f9c921a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/index.js\":\"36bc4c6b51b52e6a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"cd63b1cea0646ace\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-dispatch-companion/schema.js\":\"1a4cb4a21e309850\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d0cf396604d699a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/BridgePairingDialog.js\":\"49b2be785a9a1ad3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/addMedia.js\":\"d0691061c454b172\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9740184965dcd67b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/block.js\":\"58511c3773810e80\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/context.js\":\"44630ca7cdad9a9a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/displayIds.js\":\"02b03efca6d77179\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/index.js\":\"9f30232ac0b11ce0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/outline.js\":\"f28398accfa84a17\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/properties.js\":\"c9c1c6a21821c4e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/refs.js\":\"be616236d239c0ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"afcf97a92ebb19bf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/search.js\":\"d4f5c43bdfdadc42\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/shared.js\":\"b68b496bb1ab8f80\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"5887909db44b1ec5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentViews/text.js\":\"5711ce6eabd9cd35\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/agentWrites.js\":\"44f4a1f61366cc35\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/authoringCatalog.js\":\"31e8d395b34add80\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/blockRefTargets.js\":\"9654d2f4e14013b7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridge.js\":\"112e188ade5f6a28\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/bridgeLoop.js\":\"1d4c960df61341c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/changeHistory.js\":\"f5859c5e37d5130a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commands.js\":\"cc6882b3dd85074f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/commentsCommands.js\":\"2ba93f9f15644aac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataExtension.js\":\"75ebe109154dfacc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dataModelGuide.js\":\"dd880aba6cc1f63b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/dayPropertyInputs.js\":\"7fd2acea8cf88dca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/describeRuntime.js\":\"4bd04733e4bbe424\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/extensionLint.js\":\"7b32cd10e22f6b28\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/grainAudit.js\":\"95232c9301ad2c61\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/healthCommand.js\":\"22522ae53b85413e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/index.js\":\"2d71679a2ad11339\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/presetIdentity.js\":\"02837623a262e498\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e973802375534390\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/readMedia.js\":\"dbee4c762ddf4b08\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/schema.js\":\"2933fde8af103ba8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/serialization.js\":\"e98b63ba4fec3561\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/targets.js\":\"7f1c46b8ae703330\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/tokens.js\":\"6f5e769a2ed9498e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/watchEvents.js\":\"391bedc9272c3c47\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/workspaceGuard.js\":\"c9fe4cc078bb55b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/agent-runtime/writeCommands.js\":\"a14107a3334010c4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/AliasCollisionToast.js\":\"684117f26340da2c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/DuplicateNameBanner.js\":\"f0dffb883160e101\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/collisionMerge.js\":\"e8caa3ca5aa3dfbe\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/dataExtension.js\":\"8a50250c269cca0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/index.js\":\"37a6cb8c4866184b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/mergeCollisionAction.js\":\"2900667af5ff6c15\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/pageStyling.js\":\"0a5b3e3726013ae6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/rejectionToast.js\":\"8fae351bf3c4ce15\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/alias/syncProcessor.js\":\"bb7728d0da66e779\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/actions.js\":\"b082c63590557f94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/addComment.js\":\"860a0a6e184a9b93\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchor.js\":\"286b6d3e21eb639c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/anchorState.js\":\"2571078ba2fbf9c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/commentLinks.js\":\"a856e042216c805c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/confirmThreadDeletion.js\":\"9abf1e4cf7874d30\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/container.js\":\"dcc3112fc280f230\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/dataExtension.js\":\"bae2d82cf13fcca8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/deleteComment.js\":\"9c2f727a0d0a000c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/highlights.js\":\"f4fa84dd41087bb1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/index.js\":\"ee545e875700cf5c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/linkedCommentsPill.js\":\"343e444e8a1f4f3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/margin.js\":\"61f4f46d99acfe69\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginAnchorLinks.js\":\"8220307dadf1ab40\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/marginSchema.js\":\"5af926e1a7cba9e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/newComment.js\":\"96fa8030015f4a89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ownThreadPicker.js\":\"7b715fa95e932cac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/placement.js\":\"fc56ab0681dc5161\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/queries.js\":\"9dab3f297eb44727\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotePosition.js\":\"6c6d60e3a28cb39b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedIn.js\":\"297b5da7f8bde559\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/quotedRange.js\":\"6cb39594a495412d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/rangeRefs.js\":\"28a389780e9d2165\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readHighlights.js\":\"f942dcc3e6519389\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelection.js\":\"eb929ffa0820ca4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/readSelectionUi.js\":\"1d5b74cab42f3d05\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/reanchor.js\":\"4eebcb2be9ca37ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/schema.js\":\"d1d545bbaf9d867a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scope.js\":\"c87ce10c74e0116f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/scopeThreads.js\":\"742c02500fa7e165\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/splitRetarget.js\":\"b502cdb883da2b16\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestionCard.js\":\"c475f06d04b786e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/suggestions.js\":\"bffc5d43656571ee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaries.js\":\"fc194c324b33597b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/summaryBatch.js\":\"453320228e55a854\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/surface.js\":\"4cb7012aa2c2a8b1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threadNavigation.js\":\"ea77eb4396bdb012\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/threads.js\":\"61616f8c1f958b37\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/ui.js\":\"797a705ba214f338\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/annotations/uiStore.js\":\"61fde44704607841\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/appIntents.js\":\"40a2a0f4466eb1df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-intents/index.js\":\"d8caca196e9470e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/index.js\":\"ae3499d45cc792e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/app-update-prompt/status.js\":\"b9a5aca11690ef30\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"10afd6a709a229f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaBlockRenderer.js\":\"7e442da08d9c9086\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaDownLaneReplicator.js\":\"45168b85a8f8974d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/MediaUploadReconciler.js\":\"817f2fe57a5ca0dd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetDownLane.js\":\"f1175de2ea222958\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetResolver.js\":\"182d763e15a29c10\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/assetUpload.js\":\"7028f22fa8ce4292\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/attachmentCleanerIO.js\":\"4c8bbd392703e9e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/supabaseAuditIO.js\":\"99c632c88cafea21\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/blobStore.js\":\"1a65c04eedcc3f84\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/browserMedia.js\":\"310370a0f64c7c52\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/byteStore.js\":\"e7ac3fb8b7bc2afb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanerIO.js\":\"71e15abf19c040ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/cleanupAttachments.js\":\"aed8d07d1b5efee1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/dataExtension.js\":\"c4fa5cece87f8a50\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/downLane.js\":\"14ca7c2f0c143364\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/index.js\":\"9b81b7733e816cbc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/insertImageContribution.js\":\"385f3a24ce5c1543\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneArming.js\":\"f6f6aff13373cced\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/laneLock.js\":\"a9b1b872b3103b3c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaBlock.js\":\"b7c9634a12f56d1a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaCapture.js\":\"b3dc4d3e9215f012\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaLanes.js\":\"10827676b609ca38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewers.js\":\"da3c92342915e223\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/mediaViewersFacet.js\":\"65c216bddb38ff74\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/pasteCapture.js\":\"eafacd04d9a6fcac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/resolver.js\":\"154a57b9500761cc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/retryUploadsAction.js\":\"fbed94842443e07a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/storagePaths.js\":\"6868a98ab3e04700\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadDrain.js\":\"af59039a43e01b34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadLaneStatus.js\":\"a2169467dd20fe38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadReconcile.js\":\"fc724ecd7e60c5e2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadRecovery.js\":\"bdc8fbe271d66321\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/uploadStore.js\":\"4c7b397b805c2bae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/attachments/useAssetObjectUrl.js\":\"d4ca6fe48b596380\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5cd0786c698ef094\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/BacklinksViewSection.js\":\"666e95c0dae1f154\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/facet.js\":\"06e941c7fea3ad1f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/index.js\":\"1b306eced37edd9f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks-view/prop.js\":\"13ecb300e8a75f26\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinkFilters.js\":\"727f3168391b6b0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"7293a25e65c845d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/BlockEntry.js\":\"29849ac60092adfb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/LinkedReferences.js\":\"57cfb4d9889e713a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"547f5cf3e82dbe8e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dailyNoteDefaults.js\":\"f2ca1fa0226fccd8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/dataExtension.js\":\"bdb0e692c934e814\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/edgeExclusions.js\":\"8fc9a7ed35d3e10f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/filterProperty.js\":\"b011a6dbfb139771\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/index.js\":\"0af8538b97bd8846\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"8d040464c2ec49d8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/applies.js\":\"eeb0a70e99833159\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/countQuery.js\":\"8671a3fe0182ba4b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/expansionStore.js\":\"13e5d878275ce58f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/index.js\":\"b0685d1d8dc49807\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3d71174e42f14a3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/presentationInvalidation.js\":\"14ef05548bc14c42\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyEditorOverride.js\":\"8dec13b3b9fcb585\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/propertyFilter.js\":\"a434a14bf981c31e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/query.js\":\"58c826bf1350117d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/resolveFilter.js\":\"de61728a0dea493d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sourceBatch.js\":\"36263dfa2149799d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/sources.js\":\"f6ef3ed9eccd125f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useBacklinks.js\":\"6c937b8a0a811667\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"e59e87869488ca33\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayCelebration.js\":\"c89222733f731298\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/BirthdayOverlay.js\":\"f8fd4e9f11908e34\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/gate.js\":\"c51842154a288e57\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/index.js\":\"ee43a1af2ffb757a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/birthday/wolfTheme.js\":\"e38ed8de6fa1857b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/BlockDragLayer.js\":\"bcd4917aedc44102\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dragController.js\":\"709ddfd20f483bd7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/dropTarget.js\":\"fb0761bb4d13df92\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/index.js\":\"8c41c067e6399f97\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-drag/projection.js\":\"9b59cff5b1bedd4c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/BlockMetaCard.js\":\"38db9f3b9f90c4ca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-info/index.js\":\"376cfd0094fe23a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/AddTagDialog.js\":\"3bcd83f36a7834b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"0fc0ec613828381f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/TagNameIssueHint.js\":\"fb5b755cb8549bac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/addTagAction.js\":\"fe4d7b5c88558b92\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/appendTag.js\":\"0f10fe357e3ed84e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/config.js\":\"c58ff7db1c811eb7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/dataExtension.js\":\"93b03310de732c5e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/index.js\":\"d4fce2b71de497fc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/block-tagging/propertyEditorOverride.js\":\"cb90248898e914ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbList.js\":\"d7a1011c37b26e1b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"2b8adddfc430a005\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/Breadcrumbs.js\":\"fcd24f2948b6dd3d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"314dc28a8ade370f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e5a0e423960dc287\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/index.js\":\"b6dd530d5788bd59\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"c7578f87335cb2a8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/CharacterCountItem.js\":\"44ea819764f15c0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/ProfilePropertyEditor.js\":\"4f07c3d6d457fd44\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/actions.js\":\"7ad4e8db5356f0e6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/blockType.js\":\"e729b954ada89f67\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/charCount.js\":\"fdf7a884165de297\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/dataExtension.js\":\"74e27aea25d51eee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/index.js\":\"0303d2ff3bbc3b97\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/profiles.js\":\"20c73a635f31c98d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/properties.js\":\"b0a240c9b5002c20\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/subtree.js\":\"ae095a35f2dc1c2f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/character-counter/textCounts.js\":\"d332910e2366c503\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/colemak-keybindings/index.js\":\"f266350ad48d66c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/CommandPalette.js\":\"121fae1c1df6f09a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/HeaderItem.js\":\"fc4fcb4bea330c92\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/context.js\":\"66742fc26b914497\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/index.js\":\"bbb5e8bb1510ef75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/selection.js\":\"9bb0ee5896927210\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/toggleStore.js\":\"a59e97edd283b4f3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/command-palette/useCommandPaletteActions.js\":\"a294fae09f1ab925\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ContributorBadges.js\":\"9aff828481ef4590\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/ProfilePicture.js\":\"201ccdd363a89e94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/author.js\":\"019b26b1985e37a3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/codeMirrorExtensions.js\":\"72d2a5efcdc60ebd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/dataExtension.js\":\"b9a130498fccf2bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/index.js\":\"2f5f84eb64d83081\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/mentionAutocomplete.js\":\"29d9f2729a1029a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/processor.js\":\"4e438537d5787448\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/profiles.js\":\"85e130661639b08d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/queries.js\":\"ca72f8d45b302e75\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/schema.js\":\"75a29c669c928b31\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/contributors/useCommentAuthor.js\":\"bce6a2a570c0e62b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"cb4c14e9019ef9ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/followOrigin.js\":\"0d9c4feae08aeb38\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/index.js\":\"77e4f69364fdc674\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"329f6bd2f9a966e0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e946cf16328efc0f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/CalendarGrid.js\":\"9c8ab423f2f3eb41\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DailyNotePicker.js\":\"5d78d7e53e19f34a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"78f7e33bd0386ec5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateNavDecorator.js\":\"3a6ac205f834eb1f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DateScrubOverlay.js\":\"3297db98b2bd8461\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayPropertyControl.js\":\"436b2c8a1465a47a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/DayValueReferenceControl.js\":\"a82f499ba9aa8f32\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/HeaderItem.js\":\"ec6ec639acd7a22d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/ReschedulePicker.js\":\"6e602a972be76702\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/SpreadDatesDialog.js\":\"1c17b73e7257162d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/actions.js\":\"8211feb5c5f1c6ad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/blockDateAdapter.js\":\"a82878a1423e3f2d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/calendar.js\":\"bf4b47f1334925e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dailyNotes.js\":\"657bd53e97d70792\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dataExtension.js\":\"afe7dbcba94ceb59\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubActions.js\":\"415aa49cb4238764\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGesture.js\":\"2d037d4a8c8d0e08\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0ea988bacfe3e973\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dateScrubRecognizer.js\":\"361259493539e0bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayProperty.js\":\"1436a7b3f9817905\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"206765a7ae5384ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/deletionGuard.js\":\"e20c76d1dd90ac1f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/dueQuery.js\":\"427c7a343ca3a0e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/index.js\":\"dbd7cf84cb8bdbe2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/landing.js\":\"f17d850493b5453b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/localSchema.js\":\"b83c54cc9ec8efca\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/referenceDateAdapter.js\":\"e12d3e0fccd32b9a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/rescheduleAction.js\":\"f89427aea8f97d20\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/schema.js\":\"334ae1f812c814ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadBlockDates.js\":\"8cb0bf3c85f8a406\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/spreadDatesAction.js\":\"1ebc84ff7cdeef64\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/today.js\":\"f25113039cc6699a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"0d5377a9e4fdc705\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"87e5fd5a8990904d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/audit.js\":\"d7c5a58ddb94af95\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditAction.js\":\"7a15d8e5740fab41\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/auditRanges.js\":\"eebf73b0eaa6638d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/diagnosticsSource.js\":\"95cb0e643a613d12\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/divergenceScan.js\":\"79f809ea99bceb1f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/index.js\":\"2718e2290b9e7e0b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/propertyChildrenChecks.js\":\"86e1410bad31eccb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/referencesMirror.js\":\"2ac86de6688599b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/rowJson.js\":\"e16a39b19f292c66\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/schedule.js\":\"7548e0b2118ca9f1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/data-integrity/store.js\":\"a4d690a58f6bcc99\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/action.js\":\"6e63a71518aceeaf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/index.js\":\"e55e814fccd71e6d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-maintenance/plugin.js\":\"a32390434d02401d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"3b5adc5ae551eefb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/actions.js\":\"312f6592f987cf7e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/changeMarker.js\":\"62ab03d56f9867af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/diagnostics.js\":\"8d9a0a48ad09cdea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/fileSystemAccess.js\":\"7d2dd93edadafefb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/filenames.js\":\"652153ea54dabbd9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/index.js\":\"51054c7834c5df78\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/mirror.js\":\"d419e12a919d3700\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runLock.js\":\"4594610b8e95248b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/runtimeHealth.js\":\"f78edbd86532aadb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/schedule.js\":\"a99555e6c68d15a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/db-mirror/store.js\":\"20dafd788a918357\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/index.js\":\"fd78afe81b5abd45\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/default-themes/themes.js\":\"7ebaee48c8c66e95\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/facet.js\":\"18ffd2b33c45bb01\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/diagnostics/useDiagnostics.js\":\"8e72e10ec5228dd3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/dismissals.js\":\"679ab6e0e93adf49\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/index.js\":\"18560efec1e7855a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/status.js\":\"5bba89f9b75a6dc2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extension-prompts/store.js\":\"46fc3d19f78417c1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"fa0f039892edb24c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/ExtensionsSettings.js\":\"2afaebcafa03b02e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/actions.js\":\"b031c39bac1bb8c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/config.js\":\"7c4bc18edac56301\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/dataExtension.js\":\"fa6ad12e4b68b946\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/effect.js\":\"f606b9c2a9497575\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/index.js\":\"4e497e6fc03f8466\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/propertyEditorOverride.js\":\"39de1f76a9c5293f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extensions-settings/useToggleTree.js\":\"2804751bb97da1bb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/ExtractTypeDialog.js\":\"73d8616db4d80e13\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"8df9b11b1f6632c0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/PropertyShapePicker.js\":\"01d73b88d7686d2c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/action.js\":\"17734a21e4abdf23\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/extract-type/index.js\":\"fbb909d1b7d9cca4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/FindReplaceDialog.js\":\"ce7cbe855dea3d1d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/HeaderItem.js\":\"4f990098343823a3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/dataExtension.js\":\"57101b3db8347a41\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/index.js\":\"5ca96ed886e90eee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/search.js\":\"49d6376bd312ccb8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/toggleStore.js\":\"931b59a56baad844\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/LocationPropertyEditor.js\":\"0bd4264e0443f7ac\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/MapView.js\":\"2f6010e364a625a5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/blockTypes.js\":\"09e6a1126e8f4dd9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/codeMirrorExtensions.js\":\"d19e1aa5a7b04fd8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/createOrFindPlace.js\":\"adf080ea9aae91cd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/currentLocation.js\":\"548d6336d227ba8c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/dataExtension.js\":\"64a4d02aecc73d36\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/geoContentDecorator.js\":\"afb21afed7f92028\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/googlePlacesClient.js\":\"0bda4e2e4f1f8e23\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/index.js\":\"3703a77e62d1bcb3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/locationsPage.js\":\"fbc574269b75e054\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/mapViewport.js\":\"64153564f75468ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/pickCurrentLocation.js\":\"2a6926b23efae553\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeAutocomplete.js\":\"7e6ef3bbcadc9468\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/placeNameCollision.js\":\"2785224d0dfe9d81\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/properties.js\":\"6e421cf3a5b9f7ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/propertyEditorOverrides.js\":\"496b41a53b0f16f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/query.js\":\"644f32dac02aef0e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/geo/usePlaceSearch.js\":\"8749c4962ecb6c3e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"6fd7ed179c1559a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"fde85b884455648c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8c857e4f99c94f8d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/config.js\":\"563c2556c9a7786d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/dataExtension.js\":\"dea15a2c2fe01fef\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/facet.js\":\"93314fafdd2f79be\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/grouping.js\":\"ba7cfa460134837f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/index.js\":\"e367352f91228527\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1889476f97b89686\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/query.js\":\"1d070c610da880dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/resolveConfig.js\":\"a3990e8a8f083658\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"2b36411151ead532\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"bdcf6c7c0ddc0af1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlDocumentContent.js\":\"a6cf5561704f6e47\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/HtmlFrame.js\":\"8bb001075729b009\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/actions.js\":\"861fee8c525fb889\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/blockType.js\":\"05176765f17c7cee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/confirmRunScripts.js\":\"16a478a733a08a55\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/dataExtension.js\":\"46890d9768cbe20c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameAnnotations.js\":\"13d461d67a1be0d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameDocument.js\":\"c30b03ba74a81b30\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/frameTheme.js\":\"d6a51bd413a29a57\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/index.js\":\"a90e44d36b766cf9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/scriptConsent.js\":\"4135d09aa7dc1951\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/sourceMap.js\":\"4ec4a4c24e41cfa4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/html-document/useDocumentScripts.js\":\"df3e41db6537936d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/index.js\":\"0e9991023b9ec180\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/record.js\":\"d11aaf41500278fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/recordStore.js\":\"5c59ec6644de6118\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/responsiveness.js\":\"91052004bc30b3d3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/schedule.js\":\"9e8b32c9545da90b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/interaction-metrics/sessionContext.js\":\"d12302f9934eca33\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"25a9fff4e0c4b1c9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"49c1c29563d38b8f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/actions.js\":\"e450eff7ad09f97a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/config.js\":\"779c5ac7a7668de9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/dataExtension.js\":\"ee329e69c64e5b3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/effect.js\":\"38ec7bd1820a7819\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/index.js\":\"9898236398753cf5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/keyCapture.js\":\"0f0d44cf085b9e72\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/overrideStore.js\":\"08ff829f939f4a98\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"a23e4ac28c451637\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/HeaderItem.js\":\"c22e23de0d61ed79\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/LeftSidebar.js\":\"9d7e35c1eb02a4fd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/actions.js\":\"46c848e5b49a494e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/facet.js\":\"d50f8a23c9ae9202\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/index.js\":\"9b0bcbf13891dbb5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/shortcuts.js\":\"43f4916a87fa8eaf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/left-sidebar/toggleStore.js\":\"67ac127909858ae7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/MergePicker.js\":\"2c16412a3fe87853\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/index.js\":\"b5d82e7dccd73e6b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/mergeAction.js\":\"51f5157297fec92e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/merge-blocks/strategy.js\":\"cac4677186236fb9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/Button.js\":\"a75a59ab7207e230\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"7b4cc4ce6f09c0b0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a8876a8087e01b2e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/facet.js\":\"05ea166027949e89\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-bottom-nav/index.js\":\"5ceb406e40ffe874\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"deeb04f637a0a043\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d278f017db321d8f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"dd305e943ae46a7d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/facet.js\":\"e6726387b330a312\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/mobile-keyboard-toolbar/index.js\":\"5c5c5b58d6430aa8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/MoveDestinationPicker.js\":\"23c35c77c0732b71\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/blockSubtreeMembership.js\":\"6363e95f1763e15f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/contextMenuItem.js\":\"e51c4f65e2bd0e84\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/index.js\":\"76f908007ee718e5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveAction.js\":\"04f67dac3ed240d6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/moveBlocks.js\":\"1a55c18e54efe9a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/move-blocks/selectionAfterMove.js\":\"39e989bfdf1354ae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/TutorialBanner.js\":\"92a9f9253e28f2e7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/action.js\":\"d1742d787e9bba63\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/bannerDismissal.js\":\"73faea6a86eeee96\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/documents/cheatSheet.js\":\"3ba393369473cbd3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/index.js\":\"381029fd22fd3592\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/keys.js\":\"30f33a15b431c201\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/landing.js\":\"e1b8ba8834900589\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/outline.js\":\"40f687093b731fc9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/onboarding/seed.js\":\"8ea5b9fb8f9590ec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/PerfTrendDialog.js\":\"51578b1ab8336c41\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/analyze.js\":\"31de1ac175c8f7c6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/diagnosticsSource.js\":\"cb50904b681bab86\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/index.js\":\"2c364b2fcb8ae7e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/load.js\":\"97fff4a0c18a7359\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/monitorRun.js\":\"21d954fd79bba453\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/schedule.js\":\"652e00be4652bea5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/series.js\":\"915756e5eab5960d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/store.js\":\"8fa1fcede303e45d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/trendAction.js\":\"8da30876396e8ef7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/perf-monitor/verdict.js\":\"1995caf249c7415b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/clickToEditAction.js\":\"67c57816c31717df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/index.js\":\"3acbb6a1be8baecb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/plain-outliner/interactions.js\":\"6359550c084d6671\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"12b3eb9ded18bb3a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGate.js\":\"2fc6a709e9a7b833\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/MigrationGateDialog.js\":\"134e9bb867b6ea73\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/action.js\":\"537721a895c77967\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/index.js\":\"3b7321272c7dd49c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/localRunMessage.js\":\"7d20ae4191dc76ea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/plugin.js\":\"31b5e94d8568dde1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/progressReport.js\":\"4ac2682e67e8c092\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/properties-migration/sweepProgress.js\":\"c1dcfb9c0e0ecb86\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/FieldRowRenderer.js\":\"bdc0288e80adcbf8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/ValueRowRenderer.js\":\"af1700f556f5f0c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/actions.js\":\"ffe8362fe83d57ab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/autocomplete.js\":\"12d2b7ebb169697b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/fieldRow.js\":\"47b9abb5db9306da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/index.js\":\"c79290db8b094103\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/referenceWarning.js\":\"5123e0c161d04189\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueAutocomplete.js\":\"f11f4226522297af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/property-rows/valueSchema.js\":\"9ba7eda277ebe412\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/HeaderItem.js\":\"d6a293def7666ad7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/QuickFind.js\":\"902b23c6c914f944\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/index.js\":\"b61bffcc3b760e8e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/recents.js\":\"73b0843b7a55a3da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/resultItems.js\":\"f30157b33f4e44e9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/selection.js\":\"386d24695ef3c078\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/quick-find/toggleStore.js\":\"ad912003cf60424c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/HeaderItem.js\":\"bfbd31de3c15a255\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d132d3938e0c89b1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/grouping.js\":\"56309bb1fdf20707\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/index.js\":\"c8418a186628f264\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/recents/target.js\":\"3336751d6b9222b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/codeMirrorExtensions.js\":\"c763f2d4fa3b1f99\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/contentPrefill.js\":\"df1881f1f5ac6b77\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/dataExtension.js\":\"e8d61061de183c06\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/index.js\":\"e7cff357c9380166\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"787e305626331a9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/invalidation.js\":\"85867c66a545dab4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/localSchema.js\":\"8bc9d38383b4a4f9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/index.js\":\"d7a5e595cea97d08\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"5692ab466c621c1a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/index.js\":\"1ee44ba98f799055\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/referenceNode.js\":\"84809727cf79ceae\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/remark-reference-occurrences.js\":\"7473b0fdb200362e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c9804be6ed31fc95\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/index.js\":\"de18f80e8c940bcb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"561d5b379bbf2e7a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"dcce1a1a98163acc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/mergeRetargetProcessor.js\":\"1ffbfb70932ff229\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/parseFence.js\":\"fcacfc34e8279ed7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceParser.js\":\"1a6184557f0ba116\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referenceProjection.js\":\"d5552b00ffd05697\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/referencesProcessor.js\":\"0f949fb53543561d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/renameProcessor.js\":\"b37dfcf7d086b8a4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/references/spanReplacement.js\":\"5129aa0778b29cd9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/htmlToOutline.js\":\"8e1bf4dbae826241\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/index.js\":\"9436cea37e8397e1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/normalizeClipboardDom.js\":\"35bb99f47eb7664d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/rich-paste/pasteDecision.js\":\"1542ab98c87b1224\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/action.js\":\"0ed9626480874def\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/blockIds.js\":\"726f7094a6cdcad3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/content.js\":\"37012bfaf0b9610a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/effect.js\":\"92181c6e8133265b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/ids.js\":\"8dc420d7daafa163\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/import.js\":\"f26b991638090b36\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/index.js\":\"ec31e4203dfcacf5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plan.js\":\"5e343ef983f3b95c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/plugin.js\":\"0f9009137a4f6fe4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/promotion.js\":\"189fc28898f0572e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/properties.js\":\"3a0c3830f7034876\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/references.js\":\"4811e6a5228f1511\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/report.js\":\"3cb241ffdb3a6ef1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/roamMemo.js\":\"45f27028d05a962a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/runtime.js\":\"5e4052f1e1fe09af\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/schemaReconciliation.js\":\"13ea96af8409460b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/srsMarkers.js\":\"d29ec88722f190a1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/todo.js\":\"5eeda396ec4fd703\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/typeCandidates.js\":\"15ae413b7ce39dea\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/roam-import/types.js\":\"42ead1822c1c0b00\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/index.js\":\"7f0ba6730ccaf164\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/search-health/store.js\":\"bf3592554875ced6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/HeaderItem.js\":\"a3cdea4aa00c9626\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"8e670c54c9f8a84c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/index.js\":\"1f1e135bcc8db7ad\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/model.js\":\"5a6d79ceabe1cf0e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/toggleStore.js\":\"594708913e2dd8b6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/shortcut-help/useKeyInspector.js\":\"9814496988e24903\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0a216c1cb74a5817\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/ShellDecorator.js\":\"1d0867e8af2556a7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/actions.js\":\"b67f34bda535584e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/exclusionsFacet.js\":\"92131a33513ffc54\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/index.js\":\"a8e83b5cd52789da\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/shell.js\":\"2273ff2753a1ca0a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/surface.js\":\"473396e1f9b8b3ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/spatial-navigation/walker.js\":\"f8119e66de486441\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/RescheduleToast.js\":\"3ec8b381d4b0dba4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/dataExtension.js\":\"e5396d45cf4d6137\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/index.js\":\"5d26e32c9f8edec6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/indicator.js\":\"23751cad9cd32dab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/moveSrsState.js\":\"34aeaae9827ef626\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"51274bdcec427e9c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/scheduler.js\":\"3cdd64a6e083035f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/schema.js\":\"b04c4466c0b9df00\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"094e4950e8302bbf\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/srsClipboard.js\":\"a473bb2bc68880c2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e0334f5d3b6ad0fa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DailyNoteReviewHint.js\":\"cfb4abdcda4682c8\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/DeckPicker.js\":\"473917e446b79087\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewControls.js\":\"fa1cea9261d41110\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewDeckRenderer.js\":\"091cb275d7288a49\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/ReviewSession.js\":\"37957e622e619824\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/actions.js\":\"9ec88f916f6fc739\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/archive.js\":\"fbc652d647545797\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dataExtension.js\":\"2389e0b8a5976d27\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/deck.js\":\"c0e9c7cabd7b4011\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/dueQuery.js\":\"61255419eab22b53\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/gradeDecision.js\":\"f3cb947f950c5b1f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/index.js\":\"348d3c7b1d71f4b3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/keyHints.js\":\"66a6243844cbaaf5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewCardLayout.js\":\"af98592e97dc6ce9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/reviewProgress.js\":\"dc69436a50f4d0a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/schema.js\":\"16c80c897fef7a20\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/srs-review/useDueCards.js\":\"7f763003f1a6d2eb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/index.js\":\"537ee9abf8d0b1a0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/startup-metrics/record.js\":\"c669e139d3883857\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/index.js\":\"093dd0de286049ba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/persistenceStatus.js\":\"c1341fe91979bee9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/storage-persistence/requestAction.js\":\"6c0c11645917b081\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/TypeChipsDecorator.js\":\"ef0b870357612ff9\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/codeMirrorExtensions.js\":\"fb53875b3e9033a6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/index.js\":\"efa8bfbaa825b512\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/supertags/typeAutocomplete.js\":\"75fc3f3dd8920fab\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"f3a11e851deb1419\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/actions.js\":\"cdb5632c564fe8c5\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/anchor.js\":\"8caae3d239ead966\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/events.js\":\"5b9fff9b59330f56\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/gestureActions.js\":\"243fb9b923614c3d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/index.js\":\"88fe8654e602485d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"3d49ac4279db9bf6\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/collect.js\":\"6d60b146a0309cee\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/index.js\":\"1005df9c9080428e\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/sync-metrics/record.js\":\"3055b2b3927e1026\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/RejectionDialog.js\":\"0933c5dfe5ea23b4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/SystemStatusHeaderItem.js\":\"122e1d4c90d37345\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/index.js\":\"0d524d257d35d9c1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/model.js\":\"6b7452d58556dbe7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/queueCounts.js\":\"e43d6b3c198fe903\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rejectedHelpers.js\":\"b1177e3635c8da98\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/rematerializeAction.js\":\"10b2aac0b030aca7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/system-status/useHysteresis.js\":\"9f228ec3831590ff\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/ColumnHeaders.js\":\"8bca6dc971944af3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/QueryUi.js\":\"b8cf5d6b9b393289\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/TableLayout.js\":\"543adf3746c04bb3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/actions.js\":\"8a9e2aac8eb5797f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/cellEdits.js\":\"cb2ed810ce2293aa\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/childrenViews.js\":\"b4b76be9d4ed9e50\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/columns.js\":\"f7f717b0b72f6c97\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/controller.js\":\"1030e5162ab6f63c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/convert.js\":\"c8d26441e5b9bf99\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/dataExtension.js\":\"f67d6f209f71df4d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/index.js\":\"21134d9ee95a992d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/keys.js\":\"e28b89b2e131b7ed\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/model.js\":\"ef174c82f5128bd1\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/QueryText.js\":\"074fab31e81ac455\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/backfill.js\":\"11e78e6f2e2e898c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/completion.js\":\"af3fd8da937c700f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/format.js\":\"04dd13cd4edde683\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/parse.js\":\"51ac11aa464effc7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/queryValue.js\":\"bd0cacba103c74dc\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/registrations.js\":\"29e0e2ece29e1e3b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/query/source.js\":\"d5ee0a9baee4c43a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/registry.js\":\"1664e2e557d44a04\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowGutter.js\":\"f3d08dc55ead7bd0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/rowVerbs.js\":\"d18328b93b9018fb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/schema.js\":\"c75eeb3001e36e7f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/tables/sort.js\":\"71103f148839edba\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/effect.js\":\"0c8bd18bdb325ecb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/index.js\":\"5218e9a142b48c40\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/theme-toggle/theme.js\":\"272a346fb9692eec\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/actions.js\":\"7fb2807c02eb0cd7\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/dataExtension.js\":\"8df87c1d96c9b31b\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/index.js\":\"8d18d2937604e30f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/todo/schema.js\":\"d575ab0676a18825\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d5e26bc64e2458bd\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/actions.js\":\"c7170f41ad180027\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/defaultItems.js\":\"c2ff72b0893b038d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/facet.js\":\"4e3341f3c0047c54\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/holdRecognizer.js\":\"2d68c1bf8a12a17f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/touch-selection/index.js\":\"fa7fe926f6fdf08c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/UpdateIndicator.js\":\"6bb57ce4ca9a51e3\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/index.js\":\"3725536a3b16ed1c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/update-indicator/loadTimes.js\":\"d523c1acb539c26d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoNotesRenderer.js\":\"274011169918cdd2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoPlayerRenderer.js\":\"89ac475c1e850deb\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/VideoTimeStamp.js\":\"ac45cce0848902f4\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/actions.js\":\"7ab6ca96d29a917c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/index.js\":\"c0fc038ed5fbf310\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/markdown.js\":\"27138fbf4ccc68d0\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/notes.js\":\"f54a7e4d62880d93\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/registry.js\":\"f592176bbdcd5663\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/remark-timestamps.js\":\"361b0c0f38ae1f1c\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/video-player/view.js\":\"355da64f5adda66f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/LinkHints.js\":\"ddc62fb58667454d\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/index.js\":\"b59f3f2a04a02040\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/model.js\":\"69f2ec24288b2b94\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-link-hints/settings.js\":\"e96b24e3ac1fd8a2\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/actions.js\":\"9e6d836b8006156a\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/index.js\":\"07e50fcabb5771df\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/vim-normal-mode/interactions.js\":\"79be58b16c99880f\",\"/knowledge-medium/pr-preview/pr-1899/src/plugins/workspace-header/index.js\":\"0602012cdc4e862e\",\"/knowledge-medium/pr-preview/pr-1899/src/registerServiceWorker.js\":\"b5ab30e0f6ce24f3\",\"/knowledge-medium/pr-preview/pr-1899/src/requestPersistentStorage.js\":\"e0ddabbc9ca7ce8f\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authRequestDeadline.js\":\"34ccc55b52950c2c\",\"/knowledge-medium/pr-preview/pr-1899/src/services/authStorage.js\":\"3b58bc8a693b9c01\",\"/knowledge-medium/pr-preview/pr-1899/src/services/powersync.js\":\"db35d06ac664c0a9\",\"/knowledge-medium/pr-preview/pr-1899/src/services/supabase.js\":\"e5089060d58b030d\",\"/knowledge-medium/pr-preview/pr-1899/src/services/uploadErrorClassifier.js\":\"d0f8c170a25b6217\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/ActiveContexts.js\":\"ca176d6b7bc9376d\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/HotkeyReconciler.js\":\"64b885b8aa139def\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/WipeLocalDataDialog.js\":\"b3a681d356a09e60\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionDispatch.js\":\"c3e91dfb4c587586\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/actionRefItems.js\":\"ab4e4d9113a5de23\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/applyKeybindingOverrides.js\":\"20523f984bb3392f\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockActions.js\":\"182cb9e204b16825\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/blockMergeGesture.js\":\"5f561a44e3652999\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/canonicalizeChord.js\":\"02392e77c35e5f3a\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultContexts.js\":\"2a85f790a15ebd1c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/defaultShortcuts.js\":\"e1a039bc2c6dcaa1\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/effectiveActions.js\":\"e7a2712210c3ad1e\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureAction.js\":\"74049ec4af18a619\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/gestureBinding.js\":\"f0afe6d4d8aa96f4\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/holdRegistry.js\":\"58ac699dc4841d44\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingConflicts.js\":\"a7e354743d5acbab\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/keybindingOverrides.js\":\"a1fe1cb841305642\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/pointerAction.js\":\"ab0d95919876d0eb\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/resolve.js\":\"40ea8cf7f73901ed\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/runAction.js\":\"68b943ba49c1d3d0\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/sequenceMatcher.js\":\"4aebb160d0bfc14c\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/types.js\":\"743cfff45dd96867\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionContext.js\":\"1081b9c028a963b8\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/useActionDiscovery.js\":\"f243d1fffdbac361\",\"/knowledge-medium/pr-preview/pr-1899/src/shortcuts/utils.js\":\"57ceafb278ee24c0\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/bootStore.js\":\"af155ccb6aa4bf70\",\"/knowledge-medium/pr-preview/pr-1899/src/sw/previewDatabases.js\":\"643b84d171a1fd7b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/byteTransform.js\":\"12230891c7615dc8\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/attachmentCleaner.js\":\"80ef2739a25f064c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/attachmentParts.js\":\"f4e34bb6d6f56a29\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleParts.js\":\"f1dcf51c67938ba2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/bundleRecord.js\":\"e5e876771703e22d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/manifest.js\":\"14790151024245f4\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/takeBundle.js\":\"8a0dccdb1049aa47\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/bundle/verifyBundle.js\":\"11bb2cf13e453962\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/cleaningStage.js\":\"a45a258b6ce914ff\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionKey.js\":\"3625601ab77fbf5d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/conversionServer.js\":\"36fe9bf496ebec70\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flip.js\":\"37e04878ce7c8848\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/flipAttempts.js\":\"b707a4a2c6c359c7\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/pages.js\":\"b6c9abca92910eac\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/preflight.js\":\"84df7d7173b2be83\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/reseal.js\":\"78528fb5d3c0d9ee\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runConversion.js\":\"f12d2885876e114e\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/runLock.js\":\"3f3992b86090dcd2\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealing.js\":\"751f4b9a0494d405\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/sealingStage.js\":\"8c52ca930f27c1f1\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/stage.js\":\"2ce9d6bfd8a2ca89\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/conversion/verifyReseal.js\":\"1b1e0062aca37bcf\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aad.js\":\"04931dc100cb9a45\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/aead.js\":\"d3c586cd107bff70\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base32.js\":\"9524264c9014bb69\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/base64url.js\":\"903d1b2c53ceaaa8\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/binaryEnvelope.js\":\"ecc8ed12c94238b8\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/byteAead.js\":\"7946fa24140b66c0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/canary.js\":\"a0ac37fef4f8277d\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentHash.js\":\"97621e608b1017cb\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/contentKey.js\":\"35660aae5ac4586f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/derivedIdNamespace.js\":\"4e853f9571aa7c65\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/envelope.js\":\"1769d95606d93ac1\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/hex.js\":\"5098d47972f793ae\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/sha256Hex.js\":\"d86680ec802803de\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/crypto/workspaceKey.js\":\"bfa14a46cffff033\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/conversionState.js\":\"8e573d23f3715be9\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4405af231902a5d0\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/pastedKey.js\":\"24a24be7e43e8a42\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"7557903de5bb620a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/flows/upgradeWorkspacePin.js\":\"50b7b7a6aff25158\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/keyStore.js\":\"2bd47ca65633c8bc\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/mintWorkspaceKey.js\":\"64e7150e0bad6e3b\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/modePin.js\":\"321b0f52681158da\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/openWorkspaceKeys.js\":\"3683baa900fdf451\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolveWorkspaceEntry.js\":\"af43f82d5a68b96a\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/resolver.js\":\"7d424feadda1792f\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/keys/workspaceAccess.js\":\"fab4f0bb3fc3155c\",\"/knowledge-medium/pr-preview/pr-1899/src/sync/transform.js\":\"4a3f527463c6838c\",\"/knowledge-medium/pr-preview/pr-1899/src/themeBootDefaults.js\":\"d51e328abe7e867b\",\"/knowledge-medium/pr-preview/pr-1899/src/types.js\":\"f1b033bcf3f12392\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/ClientLocalSettings.js\":\"0c8c07e61318b794\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/abortableSleep.js\":\"f048539e14c67c26\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/array.js\":\"df3989efeb9a2251\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/backlinkAutocomplete.js\":\"bcd9751a83fe70f9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockCrumbs.js\":\"86c42b4cdb585c2e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/blockrefAutocomplete.js\":\"8d1aef9d71c1e0e9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/cadencedIdleJob.js\":\"c5729bcbd52a1059\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/callbackSet.js\":\"8e1556993416009d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/clientId.js\":\"526e3cebd1447455\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirror.js\":\"7e2b747e44dba38a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/codemirrorCompletion.js\":\"0bcc42fc66bdf342\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/copy.js\":\"0528e4afd8404685\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dailyPage.js\":\"5e53a51c0ada1a61\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensics.js\":\"fffbc8d246e22d34\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dbForensicsHooks.js\":\"c8c3666d271bcbfd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/deleteBlockThroughUi.js\":\"76a63fbc50c9f6b3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dialogs.js\":\"5a410c0f98bfc0a1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/dom.js\":\"77a3f193f53f2d2d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/downloadBlob.js\":\"3288fc23f1c7b4b5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/drawnWalk.js\":\"b43dff96ac42f841\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/exportSqliteDb.js\":\"17edf144049b93c3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fileSystemAccess.js\":\"491c569e08dea486\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/flipSlide.js\":\"925b9d0da404fa75\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fnv1a.js\":\"af77e4ee84e297c9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/formatBytes.js\":\"b823757408a2cd7e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/fuzzyRank.js\":\"04bffa6ea9c7bdc3\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idbKeyedStore.js\":\"c39b93b15a3e4b19\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/idleCallbackPolyfill.js\":\"8c89cd67a8cd5ac0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardAwareScroll.js\":\"a2b1748332799b53\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/keyboardViewport.js\":\"a3483602812b6be1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/lastWorkspace.js\":\"6a186cd3f1660215\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutColumns.js\":\"09fff0d42fd565e4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionDom.js\":\"9ab8c024a55b7a72\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/layoutSessionId.js\":\"86e83c9cb3209105\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkClickGestures.js\":\"a17d03c44e1cf57a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/linkTargetAutocomplete.js\":\"e05e35bfd1dc9431\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbCorruption.js\":\"581e0de95fc24ddf\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/localDbRecovery.js\":\"3cade7c24ffa9abd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/markdownParser.js\":\"f88c1ea6993dc57b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/memoize.js\":\"63af14e418d86fb5\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameFieldCommit.js\":\"a9d0238a133f5785\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/nameList.js\":\"69330a8c130020cf\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/navigation.js\":\"39e102ee4e8b495d\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/omnilinerNamespace.js\":\"5c6cd793f242d081\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/opfsPageScan.js\":\"cfb641c401f0af55\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelClearance.js\":\"015e4e5b88fd4d04\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelHistory.js\":\"6158dddf11550b6c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLanes.js\":\"2883a8ddfc862712\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelLayoutProjection.js\":\"3f32169f233c7686\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelScrollAnchor.js\":\"4e569bc6e7e48b16\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/panelUrlFlags.js\":\"890e036e792eb483\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/platform.js\":\"4d93b6d14bb62116\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/pluralize.js\":\"a760eef76b7d666c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyCreation.js\":\"7362e7cd31ef1ade\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyNavigation.js\":\"877056497d06c256\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/propertyValueContext.js\":\"8be278e1b09b055a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/react.js\":\"c235e0b1622a0cf7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeDate.js\":\"e7170fd66997e04e\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/relativeTime.js\":\"d175ea120a2a1cfe\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/renderScope.js\":\"90a6fe08ed0ac59f\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/resolvedThenable.js\":\"b7414602135d3ca0\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/routing.js\":\"95e076bc38bd96cd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/safeMode.js\":\"d24dc37f0e596ddf\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/scheduleIdle.js\":\"c5d8717eba360b43\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/screenWakeLock.js\":\"e431fa602b822a79\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/selection.js\":\"96eb3e66c1468db1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/softKeyboardGrab.js\":\"3b994f2762f930ce\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/startupTimeline.js\":\"1277dd282118bb2b\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/state.js\":\"acb0049a4c8a44de\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/string.js\":\"06cc876815160f4c\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/surfaceZoom.js\":\"349119edf3245788\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/time.js\":\"097119bf13f3bafd\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toast.js\":\"0656de01406ae131\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/toggleStore.js\":\"85d8a6bc5bff1445\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/untilStopped.js\":\"18a87bb8a4a98ad4\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/userActivity.js\":\"ef75daca361a59c7\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewTransition.js\":\"d9bcccad04988fe1\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/viewport.js\":\"41138bc95b3132c9\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/webLock.js\":\"5dd42be42d60cd60\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceRecovery.js\":\"33c4f558e6df724a\",\"/knowledge-medium/pr-preview/pr-1899/src/utils/workspaceSnapshotStore.js\":\"4dd0bd537eddb6ec\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-compiler-runtime.js\":\"6324604af61e860c\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-client.js\":\"afc1bbf64a7111c1\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server-edge.js\":\"a8b465b1e90df1fd\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-server.js\":\"8fda748c8f8855fc\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static-edge.js\":\"d0f34ea306b8a5a1\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-static.js\":\"5f2ccbb4fe79fb0b\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom-test-utils.js\":\"08c9c273d513e870\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-dom.js\":\"53651b70a764b065\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react-jsx-runtime.js\":\"024ca173ddc7c7c8\",\"/knowledge-medium/pr-preview/pr-1899/src/vendor/react.js\":\"ec84d9ca3e02ff7f\",\"/knowledge-medium/pr-preview/pr-1899/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1899/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
