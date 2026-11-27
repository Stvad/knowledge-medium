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
		buildId: "f466d4f446ae-b6aee9e6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1903/\":\"b67d22d81f9f1bfe\",\"/knowledge-medium/pr-preview/pr-1903/index.html\":\"b67d22d81f9f1bfe\",\"/knowledge-medium/pr-preview/pr-1903/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1903/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1903/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1903/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1903/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1903/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1903/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1903/assets/FacadeVFS-B1aCB3GR.js\":\"873919a03bc62208\",\"/knowledge-medium/pr-preview/pr-1903/assets/OPFSCoopSyncVFS-DGCJDipR.js\":\"1d9b114937453550\",\"/knowledge-medium/pr-preview/pr-1903/assets/OPFSWriteAheadVFS-DWbcpiS6.js\":\"4d550985ba960f94\",\"/knowledge-medium/pr-preview/pr-1903/assets/wa-sqlite-CMLCFGtu.js\":\"dc140e3617e1ffea\",\"/knowledge-medium/pr-preview/pr-1903/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1903/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1903/assets/wa-sqlite-async-FYDjNOkO.js\":\"de5ffb2605fe3eb5\",\"/knowledge-medium/pr-preview/pr-1903/assets/worker-BSXxLlDH.js\":\"9466d465a0a555a6\",\"/knowledge-medium/pr-preview/pr-1903/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1903/chunks/app-BhMwcM1h.js\":\"99c2de5219a5c31e\",\"/knowledge-medium/pr-preview/pr-1903/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1903/index.js\":\"2b6bd8194de9a75f\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1903/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1903/assets/AccessHandlePoolVFS-n65mDOU_.js\":\"12f2047dbb6587d2\",\"/knowledge-medium/pr-preview/pr-1903/assets/IDBBatchAtomicVFS-CNr9jOLC.js\":\"237e9b224dcc07cf\",\"/knowledge-medium/pr-preview/pr-1903/assets/MemoryVFS-DTrJOxsL.js\":\"2fcd537d142b9bb3\",\"/knowledge-medium/pr-preview/pr-1903/assets/mc-wa-sqlite-Bwe96JvC.js\":\"cec9c331e9662866\",\"/knowledge-medium/pr-preview/pr-1903/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1903/assets/mc-wa-sqlite-async-BYXv0DwJ.js\":\"9039a3562b67cd27\",\"/knowledge-medium/pr-preview/pr-1903/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1903/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1903/chunks/AccessHandlePoolVFS-CUFKpcUQ.js\":\"31e13d6d43427ebf\",\"/knowledge-medium/pr-preview/pr-1903/chunks/FacadeVFS-DrQUsgjx.js\":\"648c8cee31238d5e\",\"/knowledge-medium/pr-preview/pr-1903/chunks/IDBBatchAtomicVFS-4W7P5pyA.js\":\"2c5e5979be8b4724\",\"/knowledge-medium/pr-preview/pr-1903/chunks/MemoryVFS-D-PHg1By.js\":\"ac89ddabc0fee37d\",\"/knowledge-medium/pr-preview/pr-1903/chunks/OPFSCoopSyncVFS-nRuPfw0l.js\":\"808c7ac6a4835a64\",\"/knowledge-medium/pr-preview/pr-1903/chunks/OPFSWriteAheadVFS-BS20b3PK.js\":\"786742bec7a72934\",\"/knowledge-medium/pr-preview/pr-1903/chunks/Preview-D6nZ-d-N.js\":\"5ed6bd7760e1cc3c\",\"/knowledge-medium/pr-preview/pr-1903/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1903/chunks/card-ClJvvuZh.js\":\"d3fd932439737ca1\",\"/knowledge-medium/pr-preview/pr-1903/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1903/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1903/chunks/dist-BQFiHAr2.js\":\"b144877ecd32a0e4\",\"/knowledge-medium/pr-preview/pr-1903/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1903/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1903/chunks/mc-wa-sqlite-8sSQ6hvR.js\":\"becff65d2447451b\",\"/knowledge-medium/pr-preview/pr-1903/chunks/mc-wa-sqlite-async-C8EmQ3oW.js\":\"454adc12f2eac529\",\"/knowledge-medium/pr-preview/pr-1903/chunks/react-BKrP6bGP.js\":\"5e4c8a991bab9073\",\"/knowledge-medium/pr-preview/pr-1903/chunks/react-BVK671KF.js\":\"c8356488ade3dffa\",\"/knowledge-medium/pr-preview/pr-1903/chunks/react-BYa_j899.js\":\"fb99d4fad5365a8d\",\"/knowledge-medium/pr-preview/pr-1903/chunks/react-BkHnkGUT.js\":\"4a15f1bdcf400a46\",\"/knowledge-medium/pr-preview/pr-1903/chunks/react-CRak85-u.js\":\"4a86c0ba0d4ec60d\",\"/knowledge-medium/pr-preview/pr-1903/chunks/react-CdQe1TLi.js\":\"6d3e060264f3afcc\",\"/knowledge-medium/pr-preview/pr-1903/chunks/react-DJqnAKIN.js\":\"a24a845fdb102b11\",\"/knowledge-medium/pr-preview/pr-1903/chunks/react-Dlv8vip3.js\":\"38feb1e14ae9cc7a\",\"/knowledge-medium/pr-preview/pr-1903/chunks/react-dom-server-legacy.browser.production-CYG24jcp.js\":\"2006521c793d31f0\",\"/knowledge-medium/pr-preview/pr-1903/chunks/react-dom-server.browser.production-CcCSbP-j.js\":\"7844eac4bf73142f\",\"/knowledge-medium/pr-preview/pr-1903/chunks/react-dom-server.edge.production-B37GIT54.js\":\"c540247eb729bfa8\",\"/knowledge-medium/pr-preview/pr-1903/chunks/server.browser-ChM8F3pr.js\":\"ccd434702e2b4a27\",\"/knowledge-medium/pr-preview/pr-1903/chunks/textarea-DqHFOPua.js\":\"7a8e1e5caeee26f7\",\"/knowledge-medium/pr-preview/pr-1903/chunks/ui-DrtuafH8.js\":\"9dbc27d2d6cbc177\",\"/knowledge-medium/pr-preview/pr-1903/chunks/wa-sqlite-Bfw3W7QY.js\":\"98d5f5c322ef140f\",\"/knowledge-medium/pr-preview/pr-1903/chunks/wa-sqlite-async-CvvM2BZy.js\":\"e4ac9e23e775ebeb\",\"/knowledge-medium/pr-preview/pr-1903/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1903/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1903/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1903/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1903/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1903/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1903/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1903/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1903/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1903/src/App.js\":\"94b89b1c62989978\",\"/knowledge-medium/pr-preview/pr-1903/src/appUpdate.js\":\"e956a144c2c96767\",\"/knowledge-medium/pr-preview/pr-1903/src/appVersion.js\":\"1bcf9374b25717ac\",\"/knowledge-medium/pr-preview/pr-1903/src/bootstrap/initialLayout.js\":\"1cdeeebacf9b0b33\",\"/knowledge-medium/pr-preview/pr-1903/src/bootstrap/openWorkspaceData.js\":\"488d25624cc32fbd\",\"/knowledge-medium/pr-preview/pr-1903/src/bootstrap/resolveWorkspace.js\":\"58db67c30663ea6a\",\"/knowledge-medium/pr-preview/pr-1903/src/bootstrap/workspaceBootstrap.js\":\"7d11c76761e6369a\",\"/knowledge-medium/pr-preview/pr-1903/src/components/BlockComponent.js\":\"10e89e35ec25f6aa\",\"/knowledge-medium/pr-preview/pr-1903/src/components/BlockCrumbs.js\":\"1ba2af75998558da\",\"/knowledge-medium/pr-preview/pr-1903/src/components/BlockEditor.js\":\"b9b28b998ad34141\",\"/knowledge-medium/pr-preview/pr-1903/src/components/BlockLoadingPlaceholder.js\":\"59a3d5ceb5a0f23e\",\"/knowledge-medium/pr-preview/pr-1903/src/components/BlockProperties.js\":\"20f77f5a2754f7ab\",\"/knowledge-medium/pr-preview/pr-1903/src/components/BlockSearchPicker.js\":\"e680bb2d69250c5b\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ConfirmBulkDeleteDialog.js\":\"369108eec2cc5ea6\",\"/knowledge-medium/pr-preview/pr-1903/src/components/DividerHandle.js\":\"338082c130552a4a\",\"/knowledge-medium/pr-preview/pr-1903/src/components/DraftEditor.js\":\"7bbb646c049475ea\",\"/knowledge-medium/pr-preview/pr-1903/src/components/GutterPill.js\":\"ee309a9ce693cbda\",\"/knowledge-medium/pr-preview/pr-1903/src/components/Header.js\":\"44dac1fe6f36a95a\",\"/knowledge-medium/pr-preview/pr-1903/src/components/LazyBlockComponent.js\":\"9a45e0335024eb98\",\"/knowledge-medium/pr-preview/pr-1903/src/components/Login.js\":\"c6fbeba904fb3c73\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ZoomableSurface.js\":\"b4b2735ba44ee7f9\",\"/knowledge-medium/pr-preview/pr-1903/src/components/editModeKeepalive.js\":\"f164b6c428cef954\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyDisplay/PropertyDisplayScope.js\":\"3757bd2198c2ba95\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"121f8ffe11cd7058\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyEditors/RefPropertyEditor.js\":\"b825dc60d70fea3e\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyEditors/RefTargetTypePicker.js\":\"4b27c1e0cd3b4533\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyEditors/SelectPropertyEditor.js\":\"882b8dfe71e111e1\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyEditors/TypesPropertyEditor.js\":\"abd63b6028b03364\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyEditors/defaults.js\":\"9826019c8f9de4f3\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyEditors/kernelValuePresets.js\":\"d3d849f60e075bcf\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyEditors/selectablePresets.js\":\"4a464506ad36a408\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyEditors/typesPropertyUi.js\":\"a34d4c3b39068c0a\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyPanel/AddPropertyForm.js\":\"13ee203adb6c815b\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyPanel/PropertyPicker.js\":\"c8b3298a5fc77883\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyPanel/PropertyRow.js\":\"c7a4cf602a5c44f4\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyPanel/Rows.js\":\"f4885bb554ee177b\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyPanel/actions.js\":\"c21a6305f62acf88\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyPanel/declarationOnly.js\":\"3789838415b3a6c9\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyPanel/layout.js\":\"319fc71efcbad88e\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyPanel/model.js\":\"18cce8472b689538\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyPanel/shapeUi.js\":\"3e6194e94724eed3\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyPanel/shapes.js\":\"95d49fcc07dbe2ea\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a89a86c54e6858f7\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyPanel/visibility.js\":\"5c637f6c396abb20\",\"/knowledge-medium/pr-preview/pr-1903/src/components/propertyPanelSections.js\":\"3025dd370edbcdb7\",\"/knowledge-medium/pr-preview/pr-1903/src/components/references/BlockEmbed.js\":\"1ea4f944e870501b\",\"/knowledge-medium/pr-preview/pr-1903/src/components/references/BlockLink.js\":\"65b282bbf6f7e9bd\",\"/knowledge-medium/pr-preview/pr-1903/src/components/references/BlockRef.js\":\"a00dbc5ea9cafea1\",\"/knowledge-medium/pr-preview/pr-1903/src/components/references/CompactReferenceLink.js\":\"ca6d3f3ab03bf23b\",\"/knowledge-medium/pr-preview/pr-1903/src/components/references/ReferenceLink.js\":\"dcce5d2194194591\",\"/knowledge-medium/pr-preview/pr-1903/src/components/references/cycleGuard.js\":\"74431192b55da4ea\",\"/knowledge-medium/pr-preview/pr-1903/src/components/references/cycleGuardContext.js\":\"e048865e1894f306\",\"/knowledge-medium/pr-preview/pr-1903/src/components/references/linkInteraction.js\":\"5b18529b0cd15cfc\",\"/knowledge-medium/pr-preview/pr-1903/src/components/references/referenceLayout.js\":\"846f731e9e85f024\",\"/knowledge-medium/pr-preview/pr-1903/src/components/references/useBlockRefAncestors.js\":\"08a04c1509a40a16\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/BlockGutter.js\":\"ee5b4751f715f586\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/BlockInfoDialog.js\":\"9861aac378d93dcb\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/BlockReadText.js\":\"48912293f304ca16\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/BlockTypeBlockRenderer.js\":\"4913821c649b6b04\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/BulletHoverCard.js\":\"cb9c0c5e90e5fb3d\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/CodeMirrorContentRenderer.js\":\"553ac1f48d69af67\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7b9acc5f66d29bf3\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/ColumnResizeHandles.js\":\"23c7d8a4daec342b\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"94daf7a896f88103\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/DefaultBlockRenderer.js\":\"f860ad787b8d5210\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/LayoutRenderer.js\":\"190fbe77669b09d0\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/MarkdownContentRenderer.js\":\"b758df858a5f9f85\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/MissingDataRenderer.js\":\"8802e980bd526eb1\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/PanelRenderer.js\":\"908a850fcda7e465\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/PropertySchemaBlockRenderer.js\":\"80ebd4c3adb23515\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/TopLevelRenderer.js\":\"1b768390a9ba3a06\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/blockGutterMode.js\":\"25c1e2c6dcdc8221\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/blockTitleText.js\":\"2a6ce900799b6edb\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/fieldCreationKeydown.js\":\"55c9cb08abd30043\",\"/knowledge-medium/pr-preview/pr-1903/src/components/renderer/layoutRootContext.js\":\"64227253881a866c\",\"/knowledge-medium/pr-preview/pr-1903/src/components/typeChip/TypeChip.js\":\"ec919786349a69d0\",\"/knowledge-medium/pr-preview/pr-1903/src/components/typeChip/chipStyle.js\":\"64ea97d9e0cd20de\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/anchored-floating.js\":\"476576303292ae33\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/button.js\":\"1e6b5b0439e97761\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/card.js\":\"dc5eb3a5a2ae1d18\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/checkbox.js\":\"2a2a7bc81381cb50\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/collapsible.js\":\"b54c5799587e38cd\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/command.js\":\"c372e4d35ba408a2\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/context-menu.js\":\"51b3c66eeeb2d062\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/dialog.js\":\"8ef2efea4569946d\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/dropdown-menu.js\":\"3387e8e324b6e793\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/floating-listbox.js\":\"aa606f68e1e2d84b\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/index.js\":\"4276a10fa0b10db1\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/input.js\":\"934520478577277c\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/kbd.js\":\"bc5e46bb0c45ce3a\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/label.js\":\"5658dd0e4afbcf20\",\"/knowledge-medium/pr-preview/pr-1903/src/components/ui/textarea.js\":\"4d197e8db7b78074\",\"/knowledge-medium/pr-preview/pr-1903/src/components/useEditModeYieldKeepalive.js\":\"39e991e5bd024616\",\"/knowledge-medium/pr-preview/pr-1903/src/components/util/BootFallback.js\":\"1faf5a3b2ca6a418\",\"/knowledge-medium/pr-preview/pr-1903/src/components/util/FocusedRowLazyMount.js\":\"8c35ab1303090787\",\"/knowledge-medium/pr-preview/pr-1903/src/components/util/LazyViewportMount.js\":\"24b4bbc450826016\",\"/knowledge-medium/pr-preview/pr-1903/src/components/util/LocalDbCorruptionFallback.js\":\"90630b154c707813\",\"/knowledge-medium/pr-preview/pr-1903/src/components/util/error.js\":\"d268a04a53f6d172\",\"/knowledge-medium/pr-preview/pr-1903/src/components/util/lazyMountRegistry.js\":\"8caf9c348a8b31c3\",\"/knowledge-medium/pr-preview/pr-1903/src/components/util/suspense.js\":\"0e0df057950b710e\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/CreateWorkspaceDialog.js\":\"d1229b9cb85c8484\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/PendingInvitations.js\":\"d71abf864b1cf92a\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/SyncProgress.js\":\"4ce0a5000c039a52\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/UnlockProgress.js\":\"ac7b3a9d4e62a21d\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/WorkspaceKeyGate.js\":\"e9f8a49a65c2b4ac\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/WorkspaceSettingsDialog.js\":\"de2bee6385cfbe5d\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/WorkspaceSwitcher.js\":\"3bf6393b71212e5c\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/WorkspaceSyncGate.js\":\"6d2cac79bd38bce2\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/conversion/ConversionFlow.js\":\"55cd27f289cecbdf\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/conversion/ConversionFlowHost.js\":\"97823c695acc830c\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/conversion/EncryptionSection.js\":\"f0282a8357a553e2\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/conversion/attachmentPrompts.js\":\"f2e4d7ff0909f25a\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/conversion/bundleFolderPrompts.js\":\"72727456580f87bb\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/conversion/conversionFlowDeps.js\":\"5dc6ed2ed6451873\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/conversion/conversionFlowStore.js\":\"dfb0f8afad45b766\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/conversion/flowUi.js\":\"8305b46a820ab59c\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/conversion/useConversionRun.js\":\"2c7a7bfe94a1d681\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/keyUi.js\":\"b43a00364a46d297\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/useCloseOnKeyLoss.js\":\"59014c970ba7bbd4\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/useCloseOnServerE2ee.js\":\"bed30c01c1ffe7be\",\"/knowledge-medium/pr-preview/pr-1903/src/components/workspace/workspaceUnlocked.js\":\"20ebd876b14d04fc\",\"/knowledge-medium/pr-preview/pr-1903/src/context/backgroundSubtree.js\":\"4b2ebd650fad76ca\",\"/knowledge-medium/pr-preview/pr-1903/src/context/block.js\":\"f6fd3a9e8b3c9ec2\",\"/knowledge-medium/pr-preview/pr-1903/src/context/layoutWsContext.js\":\"a7499211f934ba9e\",\"/knowledge-medium/pr-preview/pr-1903/src/context/propertyDisplay.js\":\"dc1cf5d9c03982d4\",\"/knowledge-medium/pr-preview/pr-1903/src/context/repo.js\":\"aacc7ef851f4fc61\",\"/knowledge-medium/pr-preview/pr-1903/src/data/aliasClaim.js\":\"d2374a4e5cca84ee\",\"/knowledge-medium/pr-preview/pr-1903/src/data/aliasSeatNamespace.js\":\"d9551818f966d942\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/blockData.js\":\"8017fff8bbe68558\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/blockType.js\":\"53aab2fbb3138b67\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/changeScope.js\":\"f7d76945085a67e9\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/codecs.js\":\"639972875b7ad545\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/derivedData.js\":\"886ce37567412337\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/errors.js\":\"cb6bbf0a5398ec79\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/events.js\":\"a9158a6942aae21f\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/handle.js\":\"79e500acb37c52cf\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/index.js\":\"318a825cc819581c\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/mutator.js\":\"55cb5ed584d722ab\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/processor.js\":\"5cf1d01e5c02ed9d\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/propertySchema.js\":\"8805b551e71483d9\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/query.js\":\"3260994ee9c85501\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/sameTxProcessor.js\":\"f9925e31df1a2e37\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/schema.js\":\"79e500acb37c52cf\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/tx.js\":\"79e500acb37c52cf\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/typedBlockQuery.js\":\"3ba8cece50826c10\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/user.js\":\"3028bc10e174701f\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/valuePresetCore.js\":\"53db79aebc4ac0be\",\"/knowledge-medium/pr-preview/pr-1903/src/data/api/valuePresets.js\":\"f05c63008ba08c71\",\"/knowledge-medium/pr-preview/pr-1903/src/data/attachmentCleanerIOVerb.js\":\"c71c85af92e60213\",\"/knowledge-medium/pr-preview/pr-1903/src/data/block.js\":\"899785065193f7fc\",\"/knowledge-medium/pr-preview/pr-1903/src/data/blockCache.js\":\"7b1dc6f3bd151a0a\",\"/knowledge-medium/pr-preview/pr-1903/src/data/blockId.js\":\"43df8c8222d4fdfd\",\"/knowledge-medium/pr-preview/pr-1903/src/data/blockLiveness.js\":\"4bab48aea8952ee0\",\"/knowledge-medium/pr-preview/pr-1903/src/data/blockMerge.js\":\"1b5086176e497025\",\"/knowledge-medium/pr-preview/pr-1903/src/data/blockSchema.js\":\"4279229cf15d999d\",\"/knowledge-medium/pr-preview/pr-1903/src/data/blockTypeLookup.js\":\"2fc33995dab39568\",\"/knowledge-medium/pr-preview/pr-1903/src/data/blockTypes.js\":\"5bbb53f17401a201\",\"/knowledge-medium/pr-preview/pr-1903/src/data/childrenView.js\":\"f33362f0d837093a\",\"/knowledge-medium/pr-preview/pr-1903/src/data/clientContext.js\":\"183db2b762d0a4b7\",\"/knowledge-medium/pr-preview/pr-1903/src/data/dbFileSiblings.js\":\"cdd2ca2f8e835c9f\",\"/knowledge-medium/pr-preview/pr-1903/src/data/definitionSeeds.js\":\"fbc57516dec7b971\",\"/knowledge-medium/pr-preview/pr-1903/src/data/derivedIds.js\":\"5eb1ea412af677e8\",\"/knowledge-medium/pr-preview/pr-1903/src/data/drawnSubtree.js\":\"8d9e902c607b54c1\",\"/knowledge-medium/pr-preview/pr-1903/src/data/facetBridge.js\":\"b809473ff3ee8b0e\",\"/knowledge-medium/pr-preview/pr-1903/src/data/facets.js\":\"a9f81758e97fc64c\",\"/knowledge-medium/pr-preview/pr-1903/src/data/globalState.js\":\"b66d4f2bd78296e6\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/aliasClaimRederiveProcessor.js\":\"d7dec678a3f622e1\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/ancestorBatch.js\":\"cc3f89ce10aacf4b\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/blockTypeTypeifyProcessor.js\":\"eae2226226ebe78d\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/clientSchema.js\":\"c6b081a89b0cbe3e\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/commitPipeline.js\":\"9ec40fe0f46a1072\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/devAssertions.js\":\"5c38160536c1f40d\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/firstSync.js\":\"7b291caf454bcdf0\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/freshInitialLoad.js\":\"a9237f3398681506\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/graphBackfillClaim.js\":\"d911cd1017ba640b\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/handleStore.js\":\"1824d0cd6059f14f\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/idleMarkerJobs.js\":\"49a706ced0cb56f0\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/initialDownload.js\":\"0e02b6afdfde8d3c\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/initializeClientDatabase.js\":\"d032c4c8fc928523\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/jsonCanonical.js\":\"89c169ca8bbd49fd\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/kernelInvalidation.js\":\"5dccc115a8a13f32\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/kernelProcessors.js\":\"2e9db0321d5509d7\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/kernelQueries.js\":\"84769ad0c8eaf980\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/mergeTypeMembershipProcessor.js\":\"c00aa9f75f41db0a\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/normalizeReferencesProcessor.js\":\"d56a96cf25826557\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/poolInstrumentation.js\":\"4ad9b5ab9586b50f\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/processorRunner.js\":\"e1ed3265af3f2c76\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/propertyCellBackfill.js\":\"1c56e4221dcc10bf\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/propertyChildMint.js\":\"91ac934501ef6941\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/propertyChildrenProcessor.js\":\"c5ff92eae852b828\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/propertyDefinitionChangeProcessor.js\":\"7078c17ce0aa99a0\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/propertyDefinitionSynthesis.js\":\"1858c2ea51984eb3\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/propertyKeyScan.js\":\"2f46b23ae10dc358\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/propertySchemaResolution.js\":\"085bf758d322d54e\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/propertyValueEdits.js\":\"e9ac2e7451fb275a\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/raiseProtocol.js\":\"e28948321daf4179\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/readBatch.js\":\"743ba7212e07fc1f\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/refProjection.js\":\"a929871d929af7c7\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/referenceTargetLookups.js\":\"ba9017a9f435f2f1\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/referenceTargetProcessor.js\":\"148a9233972fe274\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/replayMerge.js\":\"3da05a865adccc88\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/sqlBinds.js\":\"b49e0d0a7662835a\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"011ba0d524ec40c1\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/syncObserver/arrivalProcessors.js\":\"5608265588da24ae\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/syncObserver/invalidate.js\":\"9a249f89919cc77d\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/syncObserver/materialize.js\":\"cc4cb74592e7812e\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/syncObserver/observer.js\":\"a24ef926384c0c0e\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/syncObserver/reconcile.js\":\"05b6cfed6b79d4b2\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/timingMetrics.js\":\"8bc4fc8418cbc827\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/treeQueries.js\":\"c12af19392fc01dd\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/txEngine.js\":\"bab49229c0ef49ae\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/txSnapshots.js\":\"662bdb44db0ccf87\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/typedBlockQuery.js\":\"11ff4a4358e3ad74\",\"/knowledge-medium/pr-preview/pr-1903/src/data/internals/undoManager.js\":\"f41b13980ea93f58\",\"/knowledge-medium/pr-preview/pr-1903/src/data/invalidation.js\":\"37f6981a978024d7\",\"/knowledge-medium/pr-preview/pr-1903/src/data/kernelDataExtension.js\":\"57d9b3b0e8d1b20d\",\"/knowledge-medium/pr-preview/pr-1903/src/data/kernelPage.js\":\"ade81a8f64e1cbe4\",\"/knowledge-medium/pr-preview/pr-1903/src/data/kernelValuePresetCores.js\":\"7ae21078027f4943\",\"/knowledge-medium/pr-preview/pr-1903/src/data/localDbCorruptionSignal.js\":\"76bb32406986f118\",\"/knowledge-medium/pr-preview/pr-1903/src/data/localDbStorage.js\":\"c26255e7be0950ae\",\"/knowledge-medium/pr-preview/pr-1903/src/data/localDbVfs.js\":\"aa705998cf149990\",\"/knowledge-medium/pr-preview/pr-1903/src/data/localSchema.js\":\"ea13bc21a89bf02b\",\"/knowledge-medium/pr-preview/pr-1903/src/data/maintenance.js\":\"dd312c12dd51f9b5\",\"/knowledge-medium/pr-preview/pr-1903/src/data/mergeProperties.js\":\"2e0634e228cac164\",\"/knowledge-medium/pr-preview/pr-1903/src/data/metricsConsoleHook.js\":\"1360f9de19a203da\",\"/knowledge-medium/pr-preview/pr-1903/src/data/migrationsPage.js\":\"fbc1e2b11255e2b5\",\"/knowledge-medium/pr-preview/pr-1903/src/data/mutators.js\":\"9d600ce403d1766e\",\"/knowledge-medium/pr-preview/pr-1903/src/data/orderKey.js\":\"9f27f2b80ec2c14b\",\"/knowledge-medium/pr-preview/pr-1903/src/data/orderKeyPlacement.js\":\"d6db8542a819d617\",\"/knowledge-medium/pr-preview/pr-1903/src/data/outlineSurface.js\":\"990f11fb44c1b569\",\"/knowledge-medium/pr-preview/pr-1903/src/data/pendingEditorContent.js\":\"2c161daf37442952\",\"/knowledge-medium/pr-preview/pr-1903/src/data/pendingUploadsSql.js\":\"98d9ca53e72dd26c\",\"/knowledge-medium/pr-preview/pr-1903/src/data/pluginStateExtensions.js\":\"3a99a65cac999a2d\",\"/knowledge-medium/pr-preview/pr-1903/src/data/powerSyncLogger.js\":\"7c3ca9e9f0b3303f\",\"/knowledge-medium/pr-preview/pr-1903/src/data/projectorRuntime.js\":\"cd8bd743c458165b\",\"/knowledge-medium/pr-preview/pr-1903/src/data/properties.js\":\"3f71503cf37830a6\",\"/knowledge-medium/pr-preview/pr-1903/src/data/propertiesPage.js\":\"1d470f59dcb1fd73\",\"/knowledge-medium/pr-preview/pr-1903/src/data/propertyChildren.js\":\"5e3f19413cbbf544\",\"/knowledge-medium/pr-preview/pr-1903/src/data/propertyDefinitionFanout.js\":\"754086cd525e5f49\",\"/knowledge-medium/pr-preview/pr-1903/src/data/propertyDefinitionMetadata.js\":\"3fdb843a541173b7\",\"/knowledge-medium/pr-preview/pr-1903/src/data/propertyDefinitionRegistry.js\":\"32e71b2bfab8fcc2\",\"/knowledge-medium/pr-preview/pr-1903/src/data/propertyDisplayMode.js\":\"979338cb2d3bf69a\",\"/knowledge-medium/pr-preview/pr-1903/src/data/propertyRowCreation.js\":\"5c30807047300488\",\"/knowledge-medium/pr-preview/pr-1903/src/data/propertySchemaCreation.js\":\"7d343c43936f59cc\",\"/knowledge-medium/pr-preview/pr-1903/src/data/propertySeeds.js\":\"560f1a10029ce57e\",\"/knowledge-medium/pr-preview/pr-1903/src/data/recentsPage.js\":\"000f3204e1968ff6\",\"/knowledge-medium/pr-preview/pr-1903/src/data/refTargetComparableProperty.js\":\"0cd237d5673f088c\",\"/knowledge-medium/pr-preview/pr-1903/src/data/referenceBlock.js\":\"ee1e2ee73b979766\",\"/knowledge-medium/pr-preview/pr-1903/src/data/rejectedUploads.js\":\"1b4eaa98564d7f39\",\"/knowledge-medium/pr-preview/pr-1903/src/data/releasePowerSyncConnection.js\":\"b70ad8060601f95a\",\"/knowledge-medium/pr-preview/pr-1903/src/data/repo.js\":\"91f3925b315bca4b\",\"/knowledge-medium/pr-preview/pr-1903/src/data/repoProvider.js\":\"84d1316bded94a54\",\"/knowledge-medium/pr-preview/pr-1903/src/data/rowProperty.js\":\"98d368789f819850\",\"/knowledge-medium/pr-preview/pr-1903/src/data/searchFilter.js\":\"1298fcbdbb8ceafd\",\"/knowledge-medium/pr-preview/pr-1903/src/data/seedIdentityLedger.js\":\"2abcfcc4cc50a599\",\"/knowledge-medium/pr-preview/pr-1903/src/data/stateBlocks.js\":\"19b162cceee336d4\",\"/knowledge-medium/pr-preview/pr-1903/src/data/structuralEditPolicy.js\":\"7f8963cb837df073\",\"/knowledge-medium/pr-preview/pr-1903/src/data/structuralInsert.js\":\"08abda9ccc12fb15\",\"/knowledge-medium/pr-preview/pr-1903/src/data/subtreeDelete.js\":\"579cc724808841e3\",\"/knowledge-medium/pr-preview/pr-1903/src/data/syncStreamLock.js\":\"5c54701c89dcf454\",\"/knowledge-medium/pr-preview/pr-1903/src/data/syncedTableSqlRecognizer.js\":\"1efd89b2b6fd8894\",\"/knowledge-medium/pr-preview/pr-1903/src/data/syncedTableWriteGuard.js\":\"404763f13a295be6\",\"/knowledge-medium/pr-preview/pr-1903/src/data/targets.js\":\"ddc8c20247806903\",\"/knowledge-medium/pr-preview/pr-1903/src/data/typeColors.js\":\"e472dbf39ed85d44\",\"/knowledge-medium/pr-preview/pr-1903/src/data/typeDefinitionMetadata.js\":\"52f1dbb23c399860\",\"/knowledge-medium/pr-preview/pr-1903/src/data/typeDefinitionRegistry.js\":\"699b7f7ea95b3aba\",\"/knowledge-medium/pr-preview/pr-1903/src/data/typeExtraction.js\":\"4b9cdc9e477fe9f9\",\"/knowledge-medium/pr-preview/pr-1903/src/data/typeInitialValues.js\":\"59f921aa1db458e0\",\"/knowledge-medium/pr-preview/pr-1903/src/data/typePropertyGroups.js\":\"a123c2f9ea0099c9\",\"/knowledge-medium/pr-preview/pr-1903/src/data/typeSeeds.js\":\"380249ea37d0446e\",\"/knowledge-medium/pr-preview/pr-1903/src/data/typeTagger.js\":\"805df38484793d91\",\"/knowledge-medium/pr-preview/pr-1903/src/data/typedRecords.js\":\"442bddc51b33fccf\",\"/knowledge-medium/pr-preview/pr-1903/src/data/typesPage.js\":\"30b6e7ba57777c5b\",\"/knowledge-medium/pr-preview/pr-1903/src/data/userPrefs.js\":\"b85b3fb9bd9156a5\",\"/knowledge-medium/pr-preview/pr-1903/src/data/userSchemasService.js\":\"620543d1208e67d4\",\"/knowledge-medium/pr-preview/pr-1903/src/data/userTypesService.js\":\"1ee57e89ab75768a\",\"/knowledge-medium/pr-preview/pr-1903/src/data/valuePresetRegistry.js\":\"d1796d8dfddea244\",\"/knowledge-medium/pr-preview/pr-1903/src/data/visibleChildren.js\":\"478e16a752ea3d5c\",\"/knowledge-medium/pr-preview/pr-1903/src/data/workspaceConversion.js\":\"0bc80f55793bf3c4\",\"/knowledge-medium/pr-preview/pr-1903/src/data/workspaceFirstSync.js\":\"1eaba405309c9447\",\"/knowledge-medium/pr-preview/pr-1903/src/data/workspaceIdNamespace.js\":\"9efba636d3cf1089\",\"/knowledge-medium/pr-preview/pr-1903/src/data/workspaceSchema.js\":\"aebb24eb17146149\",\"/knowledge-medium/pr-preview/pr-1903/src/data/workspaces.js\":\"0dc9b2e9ce074270\",\"/knowledge-medium/pr-preview/pr-1903/src/data/writeAheadLog.js\":\"b501de3e9174fb32\",\"/knowledge-medium/pr-preview/pr-1903/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1903/src/editor/BlockPasteShellDecorator.js\":\"fc01dfefa0c10279\",\"/knowledge-medium/pr-preview/pr-1903/src/editor/atTrigger.js\":\"7b9d4b9104b1e03f\",\"/knowledge-medium/pr-preview/pr-1903/src/editor/autocomplete.js\":\"3f703057e9e0520a\",\"/knowledge-medium/pr-preview/pr-1903/src/editor/codeMirrorExtensions.js\":\"dc9755ff14bedb20\",\"/knowledge-medium/pr-preview/pr-1903/src/editor/contentFlush.js\":\"32a67c79d310dc48\",\"/knowledge-medium/pr-preview/pr-1903/src/editor/defaultInteractions.js\":\"da62ea6faec54d25\",\"/knowledge-medium/pr-preview/pr-1903/src/editor/editSettleSignal.js\":\"5cf3cc1d495b7cb5\",\"/knowledge-medium/pr-preview/pr-1903/src/editor/insertImage.js\":\"0a899ef8ce57a555\",\"/knowledge-medium/pr-preview/pr-1903/src/editor/referenceCompletionRange.js\":\"9feff433ed274714\",\"/knowledge-medium/pr-preview/pr-1903/src/editor/referenceTargetTypes.js\":\"78462e41dfa9d9a9\",\"/knowledge-medium/pr-preview/pr-1903/src/editor/syntaxContext.js\":\"874ad1cdb5dfe938\",\"/knowledge-medium/pr-preview/pr-1903/src/editor/triggerMatch.js\":\"1925f5f07c50adaf\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/AppRuntimeProvider.js\":\"f42bd6797dcc9045\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/BlockFocusShellDecorator.js\":\"f912ad960787500d\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/ExtensionRenderBoundary.js\":\"da05f7178c97e42a\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/PanelContentRecovery.js\":\"94e137a20366f33c\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/apiCatalog.js\":\"26030542160213be\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/approveExtensionHere.js\":\"0e73cd8abb2f96dd\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/armedCutAppMount.js\":\"bb9d6287a8ed2b9d\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/batchableKeyedStore.js\":\"4abf0e197c149dba\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/blockInteraction.js\":\"55583f45c4dc4f5a\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/blockSelectionAction.js\":\"f0b3cae5955771b1\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/compileExtensionModule.js\":\"4bb90dbbd7b31d91\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/compiledModuleCache.js\":\"78bd07d27a802ec7\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/continuousGestures.js\":\"aeab7f2668df5f09\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/core.js\":\"ee8e8237a18dc66b\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/defaultRenderers.js\":\"6905df3cf75f4e1f\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/definitionFanoutAppMount.js\":\"eea459831bb1d129\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/dialogAppMount.js\":\"faede939658d3ef5\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/dynamicExtensionSeeds.js\":\"7e141e01ddb4ec37\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/dynamicExtensions.js\":\"ecb7cd0b34d520a6\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/exampleExtensions.js\":\"97572ca8169025bb\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/extensionApprovalStatus.js\":\"e6abcd413ad52259\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/extensionLoadErrorToast.js\":\"f0ca2ac8f2bbe5de\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/extensionLoadErrors.js\":\"f8ea88170ac2c128\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/extensionLookup.js\":\"bc6c33f71b363c4b\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/extensionToggles.js\":\"7e01cde8ec119156\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/extensionUtilitiesCss.js\":\"a385e5c9d795e01b\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/kernelPageDeletionGuard.js\":\"061b16e5cf95d6a0\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/liveRuntime.js\":\"ae81e5cce2e57286\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/openExtensionsSettings.js\":\"b6e4e551a8b4ebce\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/overridesCache.js\":\"381fcfde9383cbd9\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/pluginIds.js\":\"a9a74d0df00c8e11\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/processorRejectionToast.js\":\"c64fa259f40afa38\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/runtimeActions.js\":\"9db0b4ffdd65f73a\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/runtimeContext.js\":\"79f6f66c8de3396d\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/staticAppExtensions.js\":\"0584319e2c3e9117\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/staticDataExtensions.js\":\"19a621e7611ab06c\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/toastAppMount.js\":\"b886b9a990d092c2\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/useOverrides.js\":\"1b349ad7de0df195\",\"/knowledge-medium/pr-preview/pr-1903/src/extensions/useShortcutSurfaceActivations.js\":\"4acc88211444c65a\",\"/knowledge-medium/pr-preview/pr-1903/src/facets/discoverToggleTree.js\":\"945fceaa6d5a4df8\",\"/knowledge-medium/pr-preview/pr-1903/src/facets/facet.js\":\"cba1fc9c1c661aa2\",\"/knowledge-medium/pr-preview/pr-1903/src/facets/resolveAppRuntime.js\":\"d7671b8ecd161948\",\"/knowledge-medium/pr-preview/pr-1903/src/facets/runtimeEvents.js\":\"dea833ab6818c1bc\",\"/knowledge-medium/pr-preview/pr-1903/src/facets/togglable.js\":\"71d259558ce60f34\",\"/knowledge-medium/pr-preview/pr-1903/src/facets/variantFacet.js\":\"7e573c80f8279481\",\"/knowledge-medium/pr-preview/pr-1903/src/facets/verbFacet.js\":\"0c606498e06d9ca6\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/block.js\":\"6b12c5ff00a39ba7\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/focusedChild.js\":\"4ae6428427aada0c\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/propertySchemas.js\":\"ebb3fd50caf5054e\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/typeRegistry.js\":\"423f772250e49384\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/useAncestorCrumbs.js\":\"37ad38f345a0cda3\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/useAutocompleteListbox.js\":\"7b54f6a0e908b788\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/useDebouncedSearch.js\":\"882454c83a679ac1\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/useDebouncedValue.js\":\"e08ea6ba83bab9b2\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/useFacetValue.js\":\"e3c50cdff8aa2927\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/useIsFocalRender.js\":\"586425a0e34a84ff\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/useIsReadOnly.js\":\"c210db9e834b19a9\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/useMaterializeBacklog.js\":\"d50b0f3984f2c7b4\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/useMinuteClock.js\":\"4fbf485051e6b576\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/usePanelLayoutProjection.js\":\"69d1d820137323d2\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/usePendingInvitations.js\":\"7f6f6cc3e02a7888\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/useRendererRegistry.js\":\"29c2b982f0734eb6\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/useRetainedFieldRows.js\":\"230753f6f600d1f0\",\"/knowledge-medium/pr-preview/pr-1903/src/hooks/useWorkspaces.js\":\"676154b6a5fd5e4d\",\"/knowledge-medium/pr-preview/pr-1903/src/lib/utils.js\":\"e37eda2f3db2dbaf\",\"/knowledge-medium/pr-preview/pr-1903/src/main.js\":\"cf529220dfac0775\",\"/knowledge-medium/pr-preview/pr-1903/src/markdown/MarkdownImage.js\":\"e036b4aa97baf04b\",\"/knowledge-medium/pr-preview/pr-1903/src/markdown/blockSeparators.js\":\"40db5ce87bc51269\",\"/knowledge-medium/pr-preview/pr-1903/src/markdown/context.js\":\"7128d0cdd932be02\",\"/knowledge-medium/pr-preview/pr-1903/src/markdown/defaultMarkdownExtension.js\":\"a829543579344b16\",\"/knowledge-medium/pr-preview/pr-1903/src/markdown/extensions.js\":\"e8e2b13225f190b7\",\"/knowledge-medium/pr-preview/pr-1903/src/markdown/renderMarkdownHtml.js\":\"da12687342aa9b33\",\"/knowledge-medium/pr-preview/pr-1903/src/minimal-editor.js\":\"c10092261d6a6147\",\"/knowledge-medium/pr-preview/pr-1903/src/paste/armedCut.js\":\"9b84c72db51ae735\",\"/knowledge-medium/pr-preview/pr-1903/src/paste/captureMediaVerb.js\":\"ffc6ed3ebc3eaa37\",\"/knowledge-medium/pr-preview/pr-1903/src/paste/clipboard.js\":\"9b636fed74da5495\",\"/knowledge-medium/pr-preview/pr-1903/src/paste/decision.js\":\"5db02cb1f7a930db\",\"/knowledge-medium/pr-preview/pr-1903/src/paste/operations.js\":\"987634e30830d4e1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/account-header/AccountHeaderItem.js\":\"6f9ce3bec076945e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/account-header/index.js\":\"60c861270a911a8e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"97a1ea8ed9dd2434\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-dispatch-companion/askAgent.js\":\"cc27a22b42c88913\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-dispatch-companion/askedStore.js\":\"c18daf705bb1bed1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d3c1192001d8d6e7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-dispatch-companion/chipState.js\":\"deb03279f06a7a47\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-dispatch-companion/dataExtension.js\":\"26d602f05792daca\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-dispatch-companion/index.js\":\"3cd313148855a974\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"3111c56447cfac6a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-dispatch-companion/schema.js\":\"0b13b5cfe2824811\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8b20a7b24698a037\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c4da4fc56b548de6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/addMedia.js\":\"43faf8ef6e53f36c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b93ba9f1638bace1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentViews/block.js\":\"7e2ba2a82b0bee78\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentViews/context.js\":\"b89b8c2c2d692b39\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a8f647a2bbc6793d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentViews/index.js\":\"01322f940b7e531a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentViews/outline.js\":\"5aff47cfe5e88388\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentViews/properties.js\":\"0205074894e8e539\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentViews/refs.js\":\"5fc9ca3bf96f08aa\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"1b128dea25f1ed38\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentViews/search.js\":\"ff2c108013e7a126\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentViews/shared.js\":\"2b08cf47eb3aac88\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"04c51a4a9af648c3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentViews/text.js\":\"2c96bbd150dc5f31\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/agentWrites.js\":\"9239f3800d694989\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/authoringCatalog.js\":\"38ad0bcd16628523\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/blockRefTargets.js\":\"6c5243d36261d6dd\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/bridge.js\":\"a984d8990df5e809\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/bridgeLoop.js\":\"d9870cf3bda705d0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/changeHistory.js\":\"a46c4c9c7ca587a6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/commands.js\":\"0f8eeea2dec412e0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/commentsCommands.js\":\"72078e9be8fbea16\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/dataExtension.js\":\"0ccb2513af960402\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/dataModelGuide.js\":\"0cc590baf1cd2555\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/dayPropertyInputs.js\":\"a494668d4fcf7d65\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/describeRuntime.js\":\"7c7aa3723b644d15\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/extensionLint.js\":\"ab54a619495b0ac4\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/grainAudit.js\":\"9eccb7b70717d007\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/healthCommand.js\":\"44add02bda4fbcdd\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/index.js\":\"9a3c56d8710619f0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/presetIdentity.js\":\"6722b5d6ded57321\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5c776a6d8d279af3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/readMedia.js\":\"deac76fac4338dcf\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/schema.js\":\"332b5d5df69ccd72\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/serialization.js\":\"bf525a1359da0477\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/targets.js\":\"f05e38a119cfe57c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/tokens.js\":\"166acba27c62e107\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/watchEvents.js\":\"6ff0ec4e22f4e889\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/workspaceGuard.js\":\"e68a7700737f4466\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/agent-runtime/writeCommands.js\":\"10b163a205af578a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/alias/AliasCollisionToast.js\":\"d1aeda38a7161e5d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/alias/DuplicateNameBanner.js\":\"5fafd33da3046624\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/alias/collisionMerge.js\":\"0b6364d3ede95667\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/alias/dataExtension.js\":\"c9c2ff6a6c7b82d7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/alias/index.js\":\"9086cfdd4243c530\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/alias/mergeCollisionAction.js\":\"c919893c621ba379\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/alias/pageStyling.js\":\"bc510bb9c3e96ec9\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/alias/rejectionToast.js\":\"97787c13a802f69c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/alias/syncProcessor.js\":\"1ee83956f777f7cf\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/actions.js\":\"996394f66d45ba79\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/addComment.js\":\"4faaa255caf5e3ed\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/anchor.js\":\"e0bdf85ae5f673a5\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/anchorState.js\":\"36f4508d94242658\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/commentLinks.js\":\"bbd293fcfd966a22\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/confirmThreadDeletion.js\":\"ebe7021d291997ed\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/container.js\":\"4af7265c1da88f23\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/dataExtension.js\":\"3ebc8cbf472bb437\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/deleteComment.js\":\"6a53ab09773f9614\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/highlights.js\":\"033878892c4408ec\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/index.js\":\"20aa9245775ebd18\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/linkedCommentsPill.js\":\"5f92542cdc1f55b0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/margin.js\":\"fd6083a63cd30f52\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/marginAnchorLinks.js\":\"9691eda9fc7802e4\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/marginSchema.js\":\"f39ffe3ee1e83b87\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/newComment.js\":\"abb15a1ff56c084f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/ownThreadPicker.js\":\"07bc0abbc91ac487\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/placement.js\":\"b6e98f60284ac72f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/queries.js\":\"95b95e240158c3d7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/quotePosition.js\":\"ef8baf8e42943c27\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/quotedIn.js\":\"59f391f2851cbacf\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/quotedRange.js\":\"13f187bf18a7ef92\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/rangeRefs.js\":\"e5f5e136c7af5063\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/readHighlights.js\":\"8c9b63e636543282\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/readSelection.js\":\"5d88fac7daaa080e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/readSelectionUi.js\":\"9d84d1b6d029dda3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/reanchor.js\":\"a45e4f7a5bcb89a0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/schema.js\":\"9d0199746f8d91e8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/scope.js\":\"0e3470b321a959ba\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/scopeThreads.js\":\"0aa9c4bc3e4844f8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/splitRetarget.js\":\"fd9785f6d8e05b98\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/suggestionCard.js\":\"57cabaea96de91ba\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/suggestions.js\":\"6e106d83699a4f4b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/summaries.js\":\"e9aea2613feb575a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/summaryBatch.js\":\"de132e99f934cf0f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/surface.js\":\"46fbdccea876e2df\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/threadNavigation.js\":\"bdafe571ba44d727\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/threads.js\":\"2bc549e4901f530f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/ui.js\":\"1ff335fdbc568401\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/annotations/uiStore.js\":\"260b46aaf17ae006\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/app-intents/appIntents.js\":\"e86e4de2c0555b68\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/app-intents/index.js\":\"6b61fe8bf0b49b1c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/app-update-prompt/index.js\":\"bf3c96f5e9ef07dd\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/app-update-prompt/status.js\":\"e9d1e6484120c877\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f6002fffa485c8c4\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/MediaBlockRenderer.js\":\"16b92b77fd385a2c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e5e88e8d945e1a1a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/MediaUploadReconciler.js\":\"de69cc05caf36f0d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/assetDownLane.js\":\"bb7bd8919c6cfc03\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/assetResolver.js\":\"607167daddf6bbe7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/assetUpload.js\":\"5e54e6c640fd6a36\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/attachmentCleanerIO.js\":\"989c515bda8158ff\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/audit/supabaseAuditIO.js\":\"944a5ac1e8f5ebb9\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/blobStore.js\":\"aa7a261e258457a8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/browserMedia.js\":\"9f0a05327e648a1a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/byteStore.js\":\"ee06cfc49ca33bc9\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/cleanerIO.js\":\"bde51e80f041336a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/cleanupAttachments.js\":\"ad3b486b7798ab4d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/dataExtension.js\":\"f28eaac5a5565a6b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/downLane.js\":\"c6806bc2d91bbad6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/index.js\":\"9d11bc6e02f52fcd\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/insertImageContribution.js\":\"bfab5a08bcc9dfe7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/laneArming.js\":\"4d6fcb5a567c38c4\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/laneLock.js\":\"f64ffa0d437dc5f3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/mediaBlock.js\":\"0637464d7f47dd36\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/mediaCapture.js\":\"7dd2d7ff47574494\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/mediaLanes.js\":\"52d2450016c8fdfe\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/mediaViewers.js\":\"6edd2c2d87bc32ca\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/mediaViewersFacet.js\":\"b0c3b24c1d940ac6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/pasteCapture.js\":\"f00bd9cee3296588\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/resolver.js\":\"474291d5b70e81d3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/retryUploadsAction.js\":\"777acd007d2826b8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/storagePaths.js\":\"ed15270560978f7a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/uploadDrain.js\":\"a96740a3852fe8a5\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/uploadLaneStatus.js\":\"92fa4ba329cfa42c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/uploadReconcile.js\":\"be93d9b3818c628c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/uploadRecovery.js\":\"b18f1891b822e064\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/uploadStore.js\":\"f8475a071d32e294\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/attachments/useAssetObjectUrl.js\":\"63d3a7230658d7db\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"8c841dfcd478b66a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks-view/BacklinksViewSection.js\":\"dcfb8ea94f842094\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks-view/facet.js\":\"6250ef7b2d3ea3ee\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks-view/index.js\":\"0c60b18eb30c8356\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks-view/prop.js\":\"cd8955cf57468a23\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/BacklinkFilters.js\":\"194bb35ec52f72e3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ce092b2f1e216d05\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/BlockEntry.js\":\"57faeff4b8df1ffc\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/LinkedReferences.js\":\"8bdda054314fdc19\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5580254c5b719b2c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/dailyNoteDefaults.js\":\"66de7f999b478e0c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/dataExtension.js\":\"9f3d9ed121737e4a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/edgeExclusions.js\":\"57131b207d201cb6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/filterProperty.js\":\"e9aeebdfccf701da\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/index.js\":\"379ddf186f65c815\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"9bb8584459bbce03\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/inline-counts/applies.js\":\"b5dc975386a1cf1f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/inline-counts/countQuery.js\":\"ed63705bd7086db6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/inline-counts/expansionStore.js\":\"cb81a36af9b54c9b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/inline-counts/index.js\":\"b0d202e18663d894\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"228d8f5901559b7d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/presentationInvalidation.js\":\"6f07ae65ecdcc979\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/propertyEditorOverride.js\":\"cf5b930e3eabf3ce\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/propertyFilter.js\":\"6ae966ba295617a9\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/query.js\":\"d056beaf193a310d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/resolveFilter.js\":\"51f70a04b6096085\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/sourceBatch.js\":\"8e96226af875f6e1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/sources.js\":\"6666e9317c159488\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/useBacklinks.js\":\"fb6106ab13b8f372\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"10cbee3448a9a6e3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/birthday/BirthdayCelebration.js\":\"eb58965d422d28f1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/birthday/BirthdayOverlay.js\":\"0bb64736e086be35\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/birthday/gate.js\":\"0439e954c6094aa0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/birthday/index.js\":\"f54bd76a02de67f2\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/birthday/wolfTheme.js\":\"4766095ef0fa6f80\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-drag/BlockDragLayer.js\":\"05548384bead245f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-drag/dragController.js\":\"5734d1830236817c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-drag/dropTarget.js\":\"89d6a38143b91dc5\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-drag/index.js\":\"7ee3cb00d3313640\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-drag/projection.js\":\"6b81e19ab4057c9a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-info/BlockMetaCard.js\":\"e01a31f399dbc45a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-info/index.js\":\"2e14fbede462acc2\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-tagging/AddTagDialog.js\":\"5dfde8e4521116ae\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"e66a7791965654d6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-tagging/TagNameIssueHint.js\":\"01f5c15468359463\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-tagging/addTagAction.js\":\"ecc910cc257ed25e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-tagging/appendTag.js\":\"99970b6efc1e4e5f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-tagging/config.js\":\"3f5d8938b6f9fb19\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-tagging/dataExtension.js\":\"18b90fd57d700032\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-tagging/index.js\":\"c58ddeaadc560258\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/block-tagging/propertyEditorOverride.js\":\"111ba3fb2e01a8c2\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6b3ec705f47b678c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"958f8ab144b0d83e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/breadcrumbs/Breadcrumbs.js\":\"44520c82c0572647\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b30cdde990fdbdd5\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d5e3f49c896bea6f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/breadcrumbs/index.js\":\"d57c59fa236052c0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9bc163e16e9e6a6e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/character-counter/CharacterCountItem.js\":\"0eb102e20f56cca9\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/character-counter/ProfilePropertyEditor.js\":\"f5d3be9a999e3810\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/character-counter/actions.js\":\"6afcf890ba65893d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/character-counter/blockType.js\":\"90ed6635e78c7fc2\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/character-counter/charCount.js\":\"c7780490b6dccf40\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/character-counter/dataExtension.js\":\"0946a2d74ed203ef\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/character-counter/index.js\":\"a74f9da6f3c4879b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/character-counter/profiles.js\":\"18a978baa84e79d3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/character-counter/properties.js\":\"e338fcc60c94b868\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/character-counter/subtree.js\":\"626ca3be5aedfd6f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/character-counter/textCounts.js\":\"5449768c37085073\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/colemak-keybindings/index.js\":\"f4c5336ad713be64\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/command-palette/CommandPalette.js\":\"1cc6ab179f279933\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/command-palette/HeaderItem.js\":\"bfabb2d307e7241e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/command-palette/context.js\":\"4d1822c735de5bf6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/command-palette/index.js\":\"663a57fc272d7113\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/command-palette/selection.js\":\"451f3ad0a4e53401\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/command-palette/toggleStore.js\":\"66bae1c770ad5a8f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/command-palette/useCommandPaletteActions.js\":\"82a2d30345d9afd7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/contributors/ContributorBadges.js\":\"40bec23f3846fa9b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/contributors/ProfilePicture.js\":\"4b2f9a9509189da6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/contributors/author.js\":\"c419f0999e7a0931\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/contributors/codeMirrorExtensions.js\":\"0d1124dd0d2b8fac\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/contributors/dataExtension.js\":\"b910297fc542cfb9\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/contributors/index.js\":\"d4c1dc911ee78db6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/contributors/mentionAutocomplete.js\":\"0f3a885dbd68ac27\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/contributors/processor.js\":\"0d0b924948c5a39b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/contributors/profiles.js\":\"0d6499bc71f8bfc3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/contributors/queries.js\":\"d6331b3ec10de22b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/contributors/schema.js\":\"e6e8c78f929d34b7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/contributors/useCommentAuthor.js\":\"7237b56011d8c167\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b21a12f6328b4590\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/cursor-follows-scroll/followOrigin.js\":\"d9ed916221e81453\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/cursor-follows-scroll/index.js\":\"3a616690ca84cfbc\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"f91d59c60fee463f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b81a7d2df59f49d8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/CalendarGrid.js\":\"a8c373002814c52b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/DailyNotePicker.js\":\"bdd0a83841154d33\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"319724a54162fcb2\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/DateNavDecorator.js\":\"96ed25ca97f3eead\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/DateScrubOverlay.js\":\"1cb6ca8722175188\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/DayPropertyControl.js\":\"9e48a45514c2cc9a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/DayValueReferenceControl.js\":\"213ac71e92cf2204\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/HeaderItem.js\":\"9b51d2a9cdf7874e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/ReschedulePicker.js\":\"cd8301fbd182b80a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/SpreadDatesDialog.js\":\"136079531280be99\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/actions.js\":\"9ed6a2acd2818d88\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/blockDateAdapter.js\":\"0f5ed30f36a6caac\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/calendar.js\":\"f0a2a83dd994c9cc\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/dailyNotes.js\":\"a98be4c3c22cc28f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/dataExtension.js\":\"936ad35f0f69108d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/dateScrubActions.js\":\"5cf4d9612fab07e6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/dateScrubGesture.js\":\"1c4371e04a0e3d92\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/dateScrubGestureActions.js\":\"720397acc18a1888\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/dateScrubRecognizer.js\":\"64aa9a92630f0de5\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/dayProperty.js\":\"922ca7833c593ddf\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"5d52d348ae8af92a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/deletionGuard.js\":\"4f481754237c5eb6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/dueQuery.js\":\"998c382f74803264\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/index.js\":\"99925b296f61d945\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/landing.js\":\"e35cc012d10b250c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/localSchema.js\":\"77cdaa3c8305c6fc\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/referenceDateAdapter.js\":\"d39963a8a6462aac\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/rescheduleAction.js\":\"aad9de153aaac0b5\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/schema.js\":\"118af43921998202\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/spreadBlockDates.js\":\"b3ac1f57f91dd79b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/spreadDatesAction.js\":\"6d7089f9f61a87bd\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/today.js\":\"69598226fe7b68b0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"086fe1971f4b6707\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f0b83ec401da727d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/data-integrity/audit.js\":\"e1731461ae539992\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/data-integrity/auditAction.js\":\"3479b88ce03e1e89\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/data-integrity/auditRanges.js\":\"7a8afdbf2ac6bc34\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/data-integrity/diagnosticsSource.js\":\"624b24b28415f191\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/data-integrity/divergenceScan.js\":\"f7fd8697624f3851\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/data-integrity/index.js\":\"0a98072c4433a24e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/data-integrity/propertyChildrenChecks.js\":\"4a1d045ec447111c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/data-integrity/referencesMirror.js\":\"31a796bdaa8b63f2\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/data-integrity/rowJson.js\":\"f30a7dc842605c35\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/data-integrity/schedule.js\":\"d2e5e61face037cb\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/data-integrity/store.js\":\"b20b536176aa62f7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-maintenance/action.js\":\"2e4445458172be6b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-maintenance/index.js\":\"0c198f6c467a6ed0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-maintenance/plugin.js\":\"71731dcecc688d52\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2d95fa658eee35f2\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-mirror/actions.js\":\"124af2ec0653a63c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-mirror/changeMarker.js\":\"909d25f6f6ffadff\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-mirror/diagnostics.js\":\"3e39b1e1c9548751\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-mirror/fileSystemAccess.js\":\"a53ed451038054bc\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-mirror/filenames.js\":\"d5a0b3fa76b947fa\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-mirror/index.js\":\"9a17b6cd5d5d1215\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-mirror/mirror.js\":\"7eb3c41b60b62713\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-mirror/runLock.js\":\"98ecb09703912e82\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-mirror/runtimeHealth.js\":\"3fa52651ddf223f3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-mirror/schedule.js\":\"d74dc2ff7b8016b4\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/db-mirror/store.js\":\"3ca4852f68eb7658\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/default-themes/index.js\":\"140d93da09372d18\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/default-themes/themes.js\":\"48ec5228a980ab92\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/diagnostics/facet.js\":\"0e323ed538bab0e3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/diagnostics/useDiagnostics.js\":\"d86bc09bef11ceb7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extension-prompts/dismissals.js\":\"40fb7b5dcbe5454e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extension-prompts/index.js\":\"2597c118a247ef6f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extension-prompts/status.js\":\"ea21358ef36216b7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extension-prompts/store.js\":\"4decbf77ef357210\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e1b6292ff994b41a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extensions-settings/ExtensionsSettings.js\":\"6f61c2197034b79e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extensions-settings/actions.js\":\"871e60c57b7b0138\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extensions-settings/config.js\":\"b0c89eb2f7a6dbd1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extensions-settings/dataExtension.js\":\"333b35a9f3e9fbaf\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extensions-settings/effect.js\":\"ae44b17ba6abbccc\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extensions-settings/index.js\":\"90d14e3b0c88c1d7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extensions-settings/propertyEditorOverride.js\":\"50adbde8752da87e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extensions-settings/useToggleTree.js\":\"36c2c7cc70903423\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extract-type/ExtractTypeDialog.js\":\"ab48c997ee3f647a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f5ba519e0a1fabef\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extract-type/PropertyShapePicker.js\":\"5f5976626de898ec\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extract-type/action.js\":\"1ed4f9b18c51c81e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/extract-type/index.js\":\"f0e7809f37fbb27e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/find-replace/FindReplaceDialog.js\":\"2ddec283687b5b3a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/find-replace/HeaderItem.js\":\"ee59830280192d23\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/find-replace/dataExtension.js\":\"c1785caee866ddf6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/find-replace/index.js\":\"76aed7ddc22b5e20\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/find-replace/search.js\":\"9a14d31d58693e0a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/find-replace/toggleStore.js\":\"863729ec6f77d891\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/LocationPropertyEditor.js\":\"5877bd43a9dd9209\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/MapView.js\":\"742a6d3591f48d3f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/blockTypes.js\":\"e502df91fa78e410\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/codeMirrorExtensions.js\":\"32d426ca7c9b74d8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/createOrFindPlace.js\":\"f6143504f6ee577d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/currentLocation.js\":\"a6c7ae9e1a505911\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/dataExtension.js\":\"82fcfbe215648423\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/geoContentDecorator.js\":\"fbaceb3228e86857\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/googlePlacesClient.js\":\"b788a712a244b2b0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/index.js\":\"2bdd60e5593e2283\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/locationsPage.js\":\"12fd05d3f8fd18bf\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/mapViewport.js\":\"05eb3921944b5aef\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/pickCurrentLocation.js\":\"12c0eb3b83a12100\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/placeAutocomplete.js\":\"357c79844b99597b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/placeNameCollision.js\":\"3ff4eb7cf7e0baa1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/properties.js\":\"190be4d3f263f534\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/propertyEditorOverrides.js\":\"1ae32370d605760f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/query.js\":\"1c068e36df9b78cb\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/geo/usePlaceSearch.js\":\"07cf27cb3be532d0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"726299125e5d7d2a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"90b419c97ee632a1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"524bda0061d31e9c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/grouped-backlinks/config.js\":\"3150cd0bbfc71e92\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/grouped-backlinks/dataExtension.js\":\"21a2f175845d59e8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/grouped-backlinks/facet.js\":\"197fe674b23e1060\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/grouped-backlinks/grouping.js\":\"20d9cb58731104b1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/grouped-backlinks/index.js\":\"80600cb4616fe209\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"3715b985910c5c4e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/grouped-backlinks/query.js\":\"351a5fcd9e4c4418\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/grouped-backlinks/resolveConfig.js\":\"3671c60d20b4ac2b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"3bb7ac6258a4658c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"5aee7a1e303b8f3d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/html-document/HtmlDocumentContent.js\":\"93f2e0621f5440f4\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/html-document/HtmlFrame.js\":\"2e20d629d52563ab\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/html-document/actions.js\":\"7b67ded7e07197c2\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/html-document/blockType.js\":\"ef70bb9002eb555d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/html-document/confirmRunScripts.js\":\"e1ff077c2b8871d6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/html-document/dataExtension.js\":\"11f1728f0b64745c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/html-document/frameAnnotations.js\":\"aca6317de7a24c0c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/html-document/frameDocument.js\":\"78d995d30629bbef\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/html-document/frameTheme.js\":\"ae32caa97fd561e2\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/html-document/index.js\":\"0430e04c255ff481\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/html-document/scriptConsent.js\":\"ddf9505d8fc4f28c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/html-document/sourceMap.js\":\"e20d946cd73f1364\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/html-document/useDocumentScripts.js\":\"fff33b1dfc5976e8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/interaction-metrics/index.js\":\"bca6bd3a6a219e30\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/interaction-metrics/record.js\":\"ec84369a21b0cfe7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/interaction-metrics/recordStore.js\":\"8d0e460256345dbd\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/interaction-metrics/responsiveness.js\":\"d2659863dcf3602a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/interaction-metrics/schedule.js\":\"df235b9a8835b7a8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/interaction-metrics/sessionContext.js\":\"7262eec2d827cb7a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"164ba1c0f4a6905a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"b72e2da9ea623c85\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/keybindings-settings/actions.js\":\"356a7d79d67accb1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/keybindings-settings/config.js\":\"bb1ba9451b7c1c0f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/keybindings-settings/dataExtension.js\":\"ed36cda3d53ee96b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/keybindings-settings/effect.js\":\"e339abe43eec111d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/keybindings-settings/index.js\":\"9efc5898f7409893\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/keybindings-settings/keyCapture.js\":\"d942b28b213d0fdb\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/keybindings-settings/overrideStore.js\":\"ed838daf4f3e905d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"011e6fce358a9567\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/left-sidebar/HeaderItem.js\":\"3eb516b124f47a29\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/left-sidebar/LeftSidebar.js\":\"e30759bb520b64c3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/left-sidebar/actions.js\":\"5b8e7dc88ec286c4\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/left-sidebar/facet.js\":\"563258b4a6031509\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/left-sidebar/index.js\":\"8ac41217a2139552\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/left-sidebar/shortcuts.js\":\"a65001cafd11187b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/left-sidebar/toggleStore.js\":\"2834d09500feabd3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/merge-blocks/MergePicker.js\":\"161a5f9e4f59c2f4\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/merge-blocks/index.js\":\"28581f4d68345425\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/merge-blocks/mergeAction.js\":\"3c4842160902a91c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/merge-blocks/strategy.js\":\"81109c222bb1cf3b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/mobile-bottom-nav/Button.js\":\"b04b9570891fdda0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5d5405ecda4700c8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/mobile-bottom-nav/defaultItems.js\":\"4e38a13d326b3840\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/mobile-bottom-nav/facet.js\":\"dae2d60e7d8fe70b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/mobile-bottom-nav/index.js\":\"7d9194055a1e0219\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b2c2f877e972daa6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/mobile-keyboard-toolbar/actions.js\":\"9695a53096e221cf\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ce29f43e6fd9c580\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/mobile-keyboard-toolbar/facet.js\":\"457bbc224f915420\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/mobile-keyboard-toolbar/index.js\":\"5542a5efc490174f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/move-blocks/MoveDestinationPicker.js\":\"1a5ac4174d85d61c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/move-blocks/blockSubtreeMembership.js\":\"4d6418804a797c23\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/move-blocks/contextMenuItem.js\":\"67754531a8d786f2\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/move-blocks/index.js\":\"682eef905bb1984a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/move-blocks/moveAction.js\":\"6b5079032d760981\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/move-blocks/moveBlocks.js\":\"4bff6d00de1db367\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/move-blocks/selectionAfterMove.js\":\"cbb6be8208abe7a3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/onboarding/TutorialBanner.js\":\"9d2e396d9a23d79a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/onboarding/action.js\":\"2d91efb789a38c68\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/onboarding/bannerDismissal.js\":\"6451a4ca8c89603f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/onboarding/documents/cheatSheet.js\":\"502a1bd60bdb72ad\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/onboarding/index.js\":\"561468dee8500ba8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/onboarding/keys.js\":\"ba96085fc0ea78a4\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/onboarding/landing.js\":\"52348fa858c70015\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/onboarding/outline.js\":\"fecd02f57c4fa316\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/onboarding/seed.js\":\"9931854d4eda1568\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/perf-monitor/PerfTrendDialog.js\":\"3d796d53438cc568\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/perf-monitor/analyze.js\":\"182429516cdd1bd7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/perf-monitor/diagnosticsSource.js\":\"662e33aa9638d8c2\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/perf-monitor/index.js\":\"7cd9bd2f0fe9032e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/perf-monitor/load.js\":\"d414c8de68e06f7e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/perf-monitor/monitorRun.js\":\"160976c1231e8633\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/perf-monitor/schedule.js\":\"ad18889f21223dd9\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/perf-monitor/series.js\":\"b94d25c262d12ae8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/perf-monitor/store.js\":\"e0f53caff0c70b11\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/perf-monitor/trendAction.js\":\"5a6fd77c798e7187\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/perf-monitor/verdict.js\":\"8d0b49ce5ccac9e1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/plain-outliner/clickToEditAction.js\":\"222aff7653604757\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/plain-outliner/index.js\":\"a7bf022f36d06fe4\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/plain-outliner/interactions.js\":\"bea51e705de4330d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9fcca189e5072b3f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/properties-migration/MigrationGate.js\":\"c07e388de2cbb4b4\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/properties-migration/MigrationGateDialog.js\":\"9be3a4665a910df8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/properties-migration/action.js\":\"9d3074cc5347d1d8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/properties-migration/index.js\":\"a749c01c12e99b33\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/properties-migration/localRunMessage.js\":\"cbdc7fa28b7baec3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/properties-migration/plugin.js\":\"5aa906bf5ba837c6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/properties-migration/progressReport.js\":\"498c0f2078e6f0a0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/properties-migration/sweepProgress.js\":\"a04082cac35faa95\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/property-rows/FieldRowRenderer.js\":\"8305f27c58487254\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/property-rows/ValueRowRenderer.js\":\"88697ad9aac6d6d8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/property-rows/actions.js\":\"da22982f346c2b5a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/property-rows/autocomplete.js\":\"194cba88b66ffbf5\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/property-rows/fieldRow.js\":\"c9dbdc3795534462\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/property-rows/index.js\":\"5ed029129a7d34f9\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/property-rows/referenceWarning.js\":\"d3256cde40b76c57\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/property-rows/valueAutocomplete.js\":\"0949c7c8d5586956\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/property-rows/valueSchema.js\":\"ddceb6f9a8db5c2b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/quick-find/HeaderItem.js\":\"512e2514ebd2c91a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/quick-find/QuickFind.js\":\"59725fd53ef04e6c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/quick-find/index.js\":\"2efd40e6839c8284\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/quick-find/recents.js\":\"d06d7e4d00909473\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/quick-find/resultItems.js\":\"484a6076eef7d042\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/quick-find/selection.js\":\"504e5cc8fe78b75d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/quick-find/toggleStore.js\":\"2e98b51dcb5bbf3a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/recents/HeaderItem.js\":\"16816ce7f328a7d7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e3e59bc82e0ce148\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/recents/grouping.js\":\"3800537509791cdd\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/recents/index.js\":\"896694ee6d42cef5\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/recents/target.js\":\"cd6c7faa738fa18d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/codeMirrorExtensions.js\":\"498dbac2681cdbcf\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/contentPrefill.js\":\"fa001cade0c717f1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/dataExtension.js\":\"c62d68f08240a7a9\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/index.js\":\"3f03cad8e775a755\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"51a0d7c5d7e9a45c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/invalidation.js\":\"f7dfc145d991635c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/localSchema.js\":\"c1bed476ec0fbb2f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/markdown/blockrefs/index.js\":\"84c4fe62e1c32968\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"14cc73951b7a8596\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/markdown/index.js\":\"b900c3c19b5c7368\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/markdown/referenceNode.js\":\"2860c15aedc31755\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/markdown/remark-reference-occurrences.js\":\"8ad1077c29f35290\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a99c34324b21e49a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/markdown/wikilinks/index.js\":\"edc6ca1b5f2e82c6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"99ed903d22ef3691\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"9694cb403cc2b551\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/mergeRetargetProcessor.js\":\"08d425d99a67e428\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/parseFence.js\":\"8b75f5200eadc045\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/referenceParser.js\":\"8900ecb411b8b7fd\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/referenceProjection.js\":\"f625e691d55e8dfd\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/referencesProcessor.js\":\"78f1c1d4de373289\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/renameProcessor.js\":\"dfa791cf8fda758e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/references/spanReplacement.js\":\"2948e2dbf0b21718\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/rich-paste/htmlToOutline.js\":\"cc4e4a60a6150642\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/rich-paste/index.js\":\"7995bb23b81e39be\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/rich-paste/normalizeClipboardDom.js\":\"9e5d929503e2479f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/rich-paste/pasteDecision.js\":\"5c33ebadc6bc827c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/action.js\":\"3b870fa48a7b0b4f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/blockIds.js\":\"74d5645fa225a998\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/content.js\":\"c54d90fefe3f4a59\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/effect.js\":\"1884ab2c58a1233b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/ids.js\":\"1dc13310749f41fe\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/import.js\":\"06cc8f87724fe8ec\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/index.js\":\"f5c3c5071b00ab8d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/plan.js\":\"2bb1ef692b2e54cc\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/plugin.js\":\"6bbdc938478c2775\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/promotion.js\":\"14670cc0b342e685\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/properties.js\":\"fb43a00785775a2e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/references.js\":\"2bee2728c8a2e8d6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/report.js\":\"f979f15d6a1d107a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/roamMemo.js\":\"b2cc61e0745def72\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/runtime.js\":\"15837002be05c523\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/schemaReconciliation.js\":\"d691201fdce6b303\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/srsMarkers.js\":\"303c55f17364d9db\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/todo.js\":\"a01c983043f784b4\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/typeCandidates.js\":\"38e6c47143df9848\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/roam-import/types.js\":\"aae3384a6787dfc8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/search-health/index.js\":\"f3f9abab52bdd73d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/search-health/store.js\":\"f845a2f8278e45c3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/shortcut-help/HeaderItem.js\":\"072c450a8df0a3e2\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"f7308e9960dc011d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/shortcut-help/index.js\":\"b0d10b9ee8247a3e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/shortcut-help/model.js\":\"509a1fbe06b70e49\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/shortcut-help/toggleStore.js\":\"52991e31c2f19453\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/shortcut-help/useKeyInspector.js\":\"929703bd22bc29ac\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"ca723d193fb7602c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/spatial-navigation/ShellDecorator.js\":\"c3a08ccac9664b37\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/spatial-navigation/actions.js\":\"0888e41153ce6893\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/spatial-navigation/exclusionsFacet.js\":\"7b6f92e9d78f75e7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/spatial-navigation/index.js\":\"4e60b55b3e772d06\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/spatial-navigation/shell.js\":\"ba5633891d5891cb\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/spatial-navigation/surface.js\":\"39446eb5d96b5364\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/spatial-navigation/walker.js\":\"ca2ff633ffcae969\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-rescheduling/RescheduleToast.js\":\"83758b3e1b0b855f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-rescheduling/dataExtension.js\":\"ea5cb3e79c67294f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-rescheduling/index.js\":\"8e803fd84b0c4253\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-rescheduling/indicator.js\":\"a524231f2981dc7f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-rescheduling/moveSrsState.js\":\"6c80c4549d1aa10f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e5a5580238536f87\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-rescheduling/scheduler.js\":\"c998dcf8912887c1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-rescheduling/schema.js\":\"7f106cbb6a64d545\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e0f82ab695b12454\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-rescheduling/srsClipboard.js\":\"ead633f50fce2e41\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"7bc64bc1f24e2fd8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f694db41a6139225\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/DeckPicker.js\":\"2e96f76cfe508eaa\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/ReviewControls.js\":\"1c99a633ce947916\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/ReviewDeckRenderer.js\":\"fffe3683ffb8832c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/ReviewSession.js\":\"24532d398a60779f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/actions.js\":\"043fad589e510f5b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/archive.js\":\"41b9c1de699b4aad\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/dataExtension.js\":\"c824c4c8dfd78dca\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/deck.js\":\"3359fde9dcbe6797\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/dueQuery.js\":\"61202a4fafc5a3d4\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/gradeDecision.js\":\"b1ea4cdf92c893cc\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/index.js\":\"aac2a73118d82b50\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/keyHints.js\":\"201d4fe643bd2f23\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/reviewCardLayout.js\":\"6b2c216767dde76f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/reviewProgress.js\":\"1e42566d9c26df6e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/schema.js\":\"be93384ea5f25430\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/srs-review/useDueCards.js\":\"f13f1e44d75a1279\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/startup-metrics/index.js\":\"96804b471e7dca8c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/startup-metrics/record.js\":\"36fc28935c6241c6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/storage-persistence/index.js\":\"0ca7d3f2e56d39e2\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/storage-persistence/persistenceStatus.js\":\"f1371922fbe82f38\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/storage-persistence/requestAction.js\":\"a957f1172b89d365\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/supertags/TypeChipsDecorator.js\":\"05773e26c911ec18\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/supertags/codeMirrorExtensions.js\":\"93759b4c42e222ff\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/supertags/index.js\":\"fcaed08c58ffdad1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/supertags/typeAutocomplete.js\":\"edbf7b65a22774bf\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"accdeaa03d80d8e1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/swipe-quick-actions/actions.js\":\"81b44967201c8242\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/swipe-quick-actions/anchor.js\":\"5d5b85eff05fc7ea\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/swipe-quick-actions/events.js\":\"c2f5e3b640113f03\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/swipe-quick-actions/gestureActions.js\":\"13745cd3ba13ac6f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/swipe-quick-actions/index.js\":\"d718e0c48992294c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"829208da7675fefa\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/sync-metrics/collect.js\":\"271b95f6222e9aff\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/sync-metrics/index.js\":\"6ebeb55db16a4504\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/sync-metrics/record.js\":\"114bfbc235c86e23\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/system-status/RejectionDialog.js\":\"27a3f88afcc2a0e5\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/system-status/SystemStatusHeaderItem.js\":\"e71167653e0be519\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/system-status/index.js\":\"3ee38a2c6184dcbf\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/system-status/model.js\":\"7ac2707ef66d1750\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/system-status/queueCounts.js\":\"6085726830a23689\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/system-status/rejectedHelpers.js\":\"96d14744221fc430\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/system-status/rematerializeAction.js\":\"950b8e591088a374\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/system-status/useHysteresis.js\":\"9b08414e32e9d1f0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/ColumnHeaders.js\":\"c3d19831b27db9fc\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/QueryUi.js\":\"cab5b5a6d4e5848d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/TableLayout.js\":\"dd337125fd2d340b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/actions.js\":\"9684e1a0f04cffcc\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/cellEdits.js\":\"3615e8b2fc91baf5\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/childrenViews.js\":\"050252249bcbf63b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/columns.js\":\"89b2ab38e37ce831\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/controller.js\":\"2e98bb9c3160cfa3\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/convert.js\":\"cf2c270136cde51d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/dataExtension.js\":\"9f3b573e1c26d0a7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/index.js\":\"9ed70effb212352e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/keys.js\":\"181d99a9c08c3405\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/model.js\":\"71aff5e0bd55fdb0\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/query/QueryText.js\":\"a39a9a7cca17a58d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/query/backfill.js\":\"dedf8ec2dc300f47\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/query/completion.js\":\"ef0831c6123c4471\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/query/format.js\":\"e1147c8e2450c8f6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/query/parse.js\":\"bc1f37920ee4ed28\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/query/queryValue.js\":\"863a769266da08c8\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/query/registrations.js\":\"23b145ad9c10714a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/query/source.js\":\"22dd0b40443972ca\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/registry.js\":\"9bfcc0c363bb5413\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/rowGutter.js\":\"36be8064c19e45ef\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/rowVerbs.js\":\"21385d91a3b466c1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/schema.js\":\"ec2c276b76703c67\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/tables/sort.js\":\"160db642e6975096\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/theme-toggle/effect.js\":\"f6bc13fb2421d093\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/theme-toggle/index.js\":\"57166e94cbd876ca\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/theme-toggle/theme.js\":\"d91e6459253cdfd6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/todo/actions.js\":\"49830bfb2ce4a194\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/todo/dataExtension.js\":\"5e7cafd818df881c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/todo/index.js\":\"b407903bd1526c27\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/todo/schema.js\":\"b62ffdb795784b26\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/touch-selection/TouchSelectionLayer.js\":\"bca2c131c23f76df\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/touch-selection/actions.js\":\"af5da8cc3f1d1e78\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/touch-selection/defaultItems.js\":\"a79414da24ee71a1\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/touch-selection/facet.js\":\"bdcbf3b805b8fddb\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/touch-selection/holdRecognizer.js\":\"ef688d11d2e03334\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/touch-selection/index.js\":\"1c7987eb6808984e\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/update-indicator/UpdateIndicator.js\":\"135a39318c83f571\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/update-indicator/index.js\":\"b5649bb58c0c0249\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/update-indicator/loadTimes.js\":\"6d6591675c957edd\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/video-player/VideoNotesRenderer.js\":\"a1ba52d60f35a8d6\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/video-player/VideoPlayerRenderer.js\":\"7de99e9600627795\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/video-player/VideoTimeStamp.js\":\"c9b0afe10a7fded7\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/video-player/actions.js\":\"1373070aab8347df\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/video-player/index.js\":\"bbdc0897ad34c951\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/video-player/markdown.js\":\"5c9a68118e9b1ee9\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/video-player/notes.js\":\"75cb0e9f3478b69c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/video-player/registry.js\":\"ab12875409f499ec\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/video-player/remark-timestamps.js\":\"b748eaeceee0c99a\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/video-player/view.js\":\"20ce7a6bca216c3c\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/vim-link-hints/LinkHints.js\":\"0fa76ac161b7330b\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/vim-link-hints/index.js\":\"857c94f8373a7a3f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/vim-link-hints/model.js\":\"56b6a816b4a3717d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/vim-link-hints/settings.js\":\"29d83d508a71283d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/vim-normal-mode/actions.js\":\"2e61b01a51c1b469\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/vim-normal-mode/index.js\":\"f62da7558677f27f\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/vim-normal-mode/interactions.js\":\"da7ffc05989ac46d\",\"/knowledge-medium/pr-preview/pr-1903/src/plugins/workspace-header/index.js\":\"5d94bfa67e465470\",\"/knowledge-medium/pr-preview/pr-1903/src/registerServiceWorker.js\":\"aa9fd3ecbfccc62f\",\"/knowledge-medium/pr-preview/pr-1903/src/requestPersistentStorage.js\":\"1d195a35e46475c9\",\"/knowledge-medium/pr-preview/pr-1903/src/services/authRequestDeadline.js\":\"2aa1ac19e6a13be8\",\"/knowledge-medium/pr-preview/pr-1903/src/services/authStorage.js\":\"f0e71ab16f8199ad\",\"/knowledge-medium/pr-preview/pr-1903/src/services/powersync.js\":\"0c0aa0e7f55bf7cc\",\"/knowledge-medium/pr-preview/pr-1903/src/services/supabase.js\":\"c6d5d3d2ec66a05d\",\"/knowledge-medium/pr-preview/pr-1903/src/services/uploadErrorClassifier.js\":\"5c3d60126fd24289\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/ActiveContexts.js\":\"65215341db998521\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/HotkeyReconciler.js\":\"bb74784a9d8b3b41\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/WipeLocalDataDialog.js\":\"9c0a83e978077799\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/actionDispatch.js\":\"527ef3dd4ad4c342\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/actionRefItems.js\":\"8baa36ae4c79eb68\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/applyKeybindingOverrides.js\":\"9d1f16ff5208bbcc\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/blockActions.js\":\"5bdde04327a1e157\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/blockMergeGesture.js\":\"b2aac9789e8e783d\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/canonicalizeChord.js\":\"538fcb962268ed93\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/defaultContexts.js\":\"b8f136470188c3b8\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/defaultShortcuts.js\":\"cc4ce14bafaf479b\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/effectiveActions.js\":\"1dac9383acb013e6\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/gestureAction.js\":\"3eb4317460131e41\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/gestureBinding.js\":\"57da994eb6b91616\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/holdRegistry.js\":\"9b97ab64d5a4c874\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/keybindingConflicts.js\":\"9efd3015d920a793\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/keybindingOverrides.js\":\"f5c1f8812933a270\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/pointerAction.js\":\"687bd8c355bcff2a\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/resolve.js\":\"7ec680b175d6fe5f\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/runAction.js\":\"aaa590fe000315ff\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/sequenceMatcher.js\":\"d4ba1ac09760f8a1\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/types.js\":\"9010948b593777a1\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/useActionContext.js\":\"84e6ce3e9152afe7\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/useActionDiscovery.js\":\"fd9ea2fb895438a8\",\"/knowledge-medium/pr-preview/pr-1903/src/shortcuts/utils.js\":\"e8c20714ac966f4b\",\"/knowledge-medium/pr-preview/pr-1903/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1903/src/sw/bootStore.js\":\"97c418e1c2ab3cd4\",\"/knowledge-medium/pr-preview/pr-1903/src/sw/previewDatabases.js\":\"e6627d7d8f456a19\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/byteTransform.js\":\"c2f39148e771dcb8\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/attachmentCleaner.js\":\"d3f94c15b166256c\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/bundle/attachmentParts.js\":\"6258bfbcd2e8e00e\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/bundle/bundleParts.js\":\"5c73409f83cbc11e\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/bundle/bundleRecord.js\":\"427a5fb98f48d1f1\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/bundle/manifest.js\":\"7ccf2c73a777b0ea\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/bundle/takeBundle.js\":\"9eb208b86d550ad3\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/bundle/verifyBundle.js\":\"f31f0df3cd7a6c0a\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/cleaningStage.js\":\"d771128e44eed6e9\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/conversionKey.js\":\"5e5da72aa0e18c64\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/conversionServer.js\":\"4be94eabc2437592\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/flip.js\":\"9310396b6f367e43\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/flipAttempts.js\":\"cdb62c7422134e14\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/pages.js\":\"5d779bdbfd0da6c5\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/preflight.js\":\"a4d51223ffa8f35e\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/reseal.js\":\"5a2e17ebec08aef1\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/runConversion.js\":\"1a328b7e9da8bc5d\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/runLock.js\":\"9d02555711a25ce2\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/sealing.js\":\"7b808537fd830c50\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/sealingStage.js\":\"ebfd77f382413555\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/stage.js\":\"40bbd0ad9ebf0814\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/conversion/verifyReseal.js\":\"6c678f0792172ab3\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/aad.js\":\"62d329954720fd90\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/aead.js\":\"ddff8aaa30c5cdb3\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/base32.js\":\"7183e6aec80bddcd\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/base64url.js\":\"cb4e3726f986f06e\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/binaryEnvelope.js\":\"e6538e1b6529f758\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/byteAead.js\":\"814116527684bd54\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/canary.js\":\"84a23db2b0565440\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/contentHash.js\":\"7bc054e5d1fa2a6e\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/contentKey.js\":\"682ddd1bf4d8e6c3\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/derivedIdNamespace.js\":\"db5a610d6ab6923d\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/envelope.js\":\"828bb561f4b6faa0\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/hex.js\":\"0be6235c16ce21ec\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/sha256Hex.js\":\"282c9f7cde6574e7\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/crypto/workspaceKey.js\":\"72591d456a4e0df0\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/keys/conversionState.js\":\"b58941e3570ff131\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3aed2b51c357da6f\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/keys/flows/pastedKey.js\":\"41e4a897e42177f9\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"5349129784d30689\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ba3786e34556c764\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/keys/keyStore.js\":\"2f4aaa2bcbdbe8a5\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/keys/mintWorkspaceKey.js\":\"10a2a48a304390b6\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/keys/modePin.js\":\"1c6e9bfac5ae96ba\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/keys/openWorkspaceKeys.js\":\"90f2d385399df409\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/keys/resolveWorkspaceEntry.js\":\"0e1e979d2fb107aa\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/keys/resolver.js\":\"d16dc5678a1a3623\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/keys/workspaceAccess.js\":\"2f890944284f2337\",\"/knowledge-medium/pr-preview/pr-1903/src/sync/transform.js\":\"12870777487e9e15\",\"/knowledge-medium/pr-preview/pr-1903/src/themeBootDefaults.js\":\"465e719bd05f8538\",\"/knowledge-medium/pr-preview/pr-1903/src/types.js\":\"b0e4bcc54fed81d3\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/ClientLocalSettings.js\":\"5392e5f6e7a58653\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/abortableSleep.js\":\"313d8258ef5c962b\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/array.js\":\"c2e4effcdb5276a7\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/backlinkAutocomplete.js\":\"5a49355503a8e944\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/blockCrumbs.js\":\"6951ee96367aea64\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/blockrefAutocomplete.js\":\"53250e4ae952f459\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/cadencedIdleJob.js\":\"7635f00b0e301f13\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/callbackSet.js\":\"e930a785e4f5bf84\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/clientId.js\":\"3f6eaf5ee24d3b88\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/codemirror.js\":\"cfbb3d7f86145476\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/codemirrorCompletion.js\":\"ae4f1c44734db9f2\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/copy.js\":\"9762ac47477552ab\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/dailyPage.js\":\"39827af782dae238\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/dbForensics.js\":\"e56214e9179909df\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/dbForensicsHooks.js\":\"4806e08bb9b66c36\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/deleteBlockThroughUi.js\":\"c9e12c8dfb4c29dd\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/dialogs.js\":\"a10176e70fa3c09f\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/dom.js\":\"e731a9dd034b2f32\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/downloadBlob.js\":\"43750cf0c8ab40f4\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/drawnWalk.js\":\"5f46ff057792286b\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/exportSqliteDb.js\":\"63ef9112cea6b6b7\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/fileSystemAccess.js\":\"8e6de6d6615353c1\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/flipSlide.js\":\"4cbbd9b506750ba3\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/fnv1a.js\":\"bf42f70bdd77f1c5\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/formatBytes.js\":\"b528f5fd0aa03337\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/fuzzyRank.js\":\"f7355199164e6c73\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/idbKeyedStore.js\":\"90f982cf522eb460\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/idleCallbackPolyfill.js\":\"3424c87680358509\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/keyboardAwareScroll.js\":\"f27728493f98ea3d\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/keyboardViewport.js\":\"5edebf85c9f9e5ff\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/lastWorkspace.js\":\"95f22279f1b38b70\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/layoutColumns.js\":\"ce3afdbcfbc862c0\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/layoutSessionDom.js\":\"9b92383e516f51d1\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/layoutSessionId.js\":\"30ab0f379fb77129\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/linkClickGestures.js\":\"2935af7b3f4e1fdd\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/linkTargetAutocomplete.js\":\"8204b20161a167f8\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/localDbCorruption.js\":\"17fcb58087e3537e\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/localDbRecovery.js\":\"d103052481dfd765\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/markdownParser.js\":\"88dfd9ac3e653b22\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/memoize.js\":\"46fa10b67ef37497\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/nameFieldCommit.js\":\"9d895c0c8973d4f8\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/nameList.js\":\"3446ae306c75e6c8\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/navigation.js\":\"c9e2e308e7f36a88\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/omnilinerNamespace.js\":\"092152b2d0c6889e\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/opfsPageScan.js\":\"de787d6b26ed7cf3\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/panelClearance.js\":\"f65e70256d7ff8da\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/panelHistory.js\":\"58c38ca1dacb5f3d\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/panelLanes.js\":\"8a2df9ea146b5357\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/panelLayoutProjection.js\":\"fb24149d586bce52\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/panelScrollAnchor.js\":\"6f897684ab551f3a\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/panelUrlFlags.js\":\"7ee511ec88318346\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/platform.js\":\"ce6e5134ef3671f8\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/pluralize.js\":\"1df3afe8908a9b58\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/propertyCreation.js\":\"da0f7e3a8f0cce95\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/propertyNavigation.js\":\"ba04f6262eb2cf0d\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/propertyValueContext.js\":\"22c5134d593c2f95\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/react.js\":\"ec3a9fd147392209\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/relativeDate.js\":\"f32ff51b4aee1f49\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/relativeTime.js\":\"335fca0a98537152\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/renderScope.js\":\"eafa06ba3e8eeacc\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/resolvedThenable.js\":\"233115c6c9dc9c31\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/routing.js\":\"8a03657875e6a929\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/safeMode.js\":\"3d5eabc347e4e618\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/scheduleIdle.js\":\"fb0049b813b6cee0\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/screenWakeLock.js\":\"a12faaae89457b9d\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/selection.js\":\"87c3f9c6fcafefbd\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/softKeyboardGrab.js\":\"c120f00038659d64\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/startupTimeline.js\":\"73441400677bcd61\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/state.js\":\"4ef1bbc4645b6279\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/string.js\":\"a22d733167f83faa\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/surfaceZoom.js\":\"70666db9e6f3ff1f\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/time.js\":\"dec9208b509850d0\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/toast.js\":\"9e67ce4da202ee38\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/toggleStore.js\":\"ace452ff0ab9fb1f\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/untilStopped.js\":\"720f03388dbfc010\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/userActivity.js\":\"780d01c880e48e8a\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/viewTransition.js\":\"bcd10485b9b0e18c\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/viewport.js\":\"667afeed762917a4\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/webLock.js\":\"70c4809eaa9d0706\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/workspaceRecovery.js\":\"2184099ec90798e6\",\"/knowledge-medium/pr-preview/pr-1903/src/utils/workspaceSnapshotStore.js\":\"6d512a404ec35039\",\"/knowledge-medium/pr-preview/pr-1903/src/vendor/react-compiler-runtime.js\":\"82d9ae9251933721\",\"/knowledge-medium/pr-preview/pr-1903/src/vendor/react-dom-client.js\":\"bf4fa5d89253c31c\",\"/knowledge-medium/pr-preview/pr-1903/src/vendor/react-dom-server-edge.js\":\"ef4932d7b65e329a\",\"/knowledge-medium/pr-preview/pr-1903/src/vendor/react-dom-server.js\":\"406908bb9748a7cf\",\"/knowledge-medium/pr-preview/pr-1903/src/vendor/react-dom-static-edge.js\":\"d6a8453d25554dfc\",\"/knowledge-medium/pr-preview/pr-1903/src/vendor/react-dom-static.js\":\"be3982e9b95c799f\",\"/knowledge-medium/pr-preview/pr-1903/src/vendor/react-dom-test-utils.js\":\"3c2875f084b26e6f\",\"/knowledge-medium/pr-preview/pr-1903/src/vendor/react-dom.js\":\"24fdfa00d1cd3862\",\"/knowledge-medium/pr-preview/pr-1903/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1903/src/vendor/react-jsx-runtime.js\":\"3fc4f63c5862a6d4\",\"/knowledge-medium/pr-preview/pr-1903/src/vendor/react.js\":\"a0131203e6d51a72\",\"/knowledge-medium/pr-preview/pr-1903/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1903/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1903/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
