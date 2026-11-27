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
		buildId: "d734f8444d42-9b6c42ee",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/\":\"ed2b1162a38adc5f\",\"/knowledge-medium/pr-preview/pr-1904/index.html\":\"ed2b1162a38adc5f\",\"/knowledge-medium/pr-preview/pr-1904/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1904/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1904/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1904/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1904/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1904/assets/FacadeVFS-BRQpqnC7.js\":\"891ebefe2dd6f73a\",\"/knowledge-medium/pr-preview/pr-1904/assets/OPFSCoopSyncVFS-DMyQDWdY.js\":\"86e4b1b2b1685b21\",\"/knowledge-medium/pr-preview/pr-1904/assets/OPFSWriteAheadVFS-k-M70Pwl.js\":\"eb585f25ac433d89\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-C0HcraJs.js\":\"86aa477d7fa26ed0\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-async-Fz6hWTwQ.js\":\"b9eb189c33a992bf\",\"/knowledge-medium/pr-preview/pr-1904/assets/worker--hK6-iBI.js\":\"a8493596f780837a\",\"/knowledge-medium/pr-preview/pr-1904/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1904/chunks/app-Hjo-u15d.js\":\"2447b24949fefe60\",\"/knowledge-medium/pr-preview/pr-1904/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1904/index.js\":\"82fe95753b0ffc9a\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1904/assets/AccessHandlePoolVFS-BrTCvkYR.js\":\"691b9b6e34e4c6fb\",\"/knowledge-medium/pr-preview/pr-1904/assets/IDBBatchAtomicVFS-xu9p-z6c.js\":\"0bb34832b79a4ba2\",\"/knowledge-medium/pr-preview/pr-1904/assets/MemoryVFS-ClNzB9Vo.js\":\"6ca89a2ce16db9ec\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-B1ZvrQ6z.js\":\"d2e9ceb833f79291\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-async-pk0cuaze.js\":\"9c6c8a2e595ff098\",\"/knowledge-medium/pr-preview/pr-1904/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1904/chunks/AccessHandlePoolVFS-CHwHcCkk.js\":\"cd61eed820b633ef\",\"/knowledge-medium/pr-preview/pr-1904/chunks/FacadeVFS-Cb08sHQJ.js\":\"051e1440d5a11c27\",\"/knowledge-medium/pr-preview/pr-1904/chunks/IDBBatchAtomicVFS-iNXWzKEP.js\":\"c9d8b6cf9381d518\",\"/knowledge-medium/pr-preview/pr-1904/chunks/MemoryVFS-CjmDIEnr.js\":\"f73fabf3ba9b9af0\",\"/knowledge-medium/pr-preview/pr-1904/chunks/OPFSCoopSyncVFS-DMqwRv8r.js\":\"82628975366fe657\",\"/knowledge-medium/pr-preview/pr-1904/chunks/OPFSWriteAheadVFS-DhpDmHcd.js\":\"1e7ceb7520b3e76d\",\"/knowledge-medium/pr-preview/pr-1904/chunks/Preview-BODPK3C1.js\":\"c10107faa26cfc69\",\"/knowledge-medium/pr-preview/pr-1904/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1904/chunks/card-BXna35P7.js\":\"8bc9264acf39cd6d\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-3MHhK-n5.js\":\"5ca5208841705f83\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1904/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1904/chunks/mc-wa-sqlite-CHQXI_ug.js\":\"3cebfac3cd38c1f1\",\"/knowledge-medium/pr-preview/pr-1904/chunks/mc-wa-sqlite-async-DGCIhIJG.js\":\"b63aa4ddce172a8f\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-BCg7-FmF.js\":\"e40ee1362d2c55b3\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-BLXkTKnC.js\":\"169e32c1542db0cc\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-C7hHAApP.js\":\"9c3aa55ed402b56a\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-CUcWjJnK.js\":\"80be452ee667e814\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-CjTIt-OM.js\":\"b5378a755d9719c3\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-DqbnT73C.js\":\"aa196ee502aa6368\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-QMHYkP-u.js\":\"eaf41d9ffe626a35\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-U-cLstPw.js\":\"604d541aa3dee930\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server-legacy.browser.production-C8rb4IZD.js\":\"49339b8dc34115d5\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server.browser.production-CvLhPH7k.js\":\"c1f887ffdcfd0177\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server.edge.production-Csolva3x.js\":\"5203494720b852e5\",\"/knowledge-medium/pr-preview/pr-1904/chunks/server.browser-BnktJ8jI.js\":\"8aa054971b77857d\",\"/knowledge-medium/pr-preview/pr-1904/chunks/textarea-BSpuGiEk.js\":\"2a6bbd15619a7b5e\",\"/knowledge-medium/pr-preview/pr-1904/chunks/ui-BHcCUmFw.js\":\"5b7479262dd1b236\",\"/knowledge-medium/pr-preview/pr-1904/chunks/wa-sqlite-D7BuUaaA.js\":\"cf882e46564c3495\",\"/knowledge-medium/pr-preview/pr-1904/chunks/wa-sqlite-async-D9DWlblA.js\":\"716c106f748a0b7a\",\"/knowledge-medium/pr-preview/pr-1904/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1904/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1904/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1904/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1904/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1904/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1904/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1904/src/App.js\":\"283aa793d7014507\",\"/knowledge-medium/pr-preview/pr-1904/src/appUpdate.js\":\"c9e46b7b561eb1a0\",\"/knowledge-medium/pr-preview/pr-1904/src/appVersion.js\":\"d9ac666cd440a791\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/initialLayout.js\":\"cfc76800d18d013e\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/openWorkspaceData.js\":\"e44030746b1ca4c6\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/resolveWorkspace.js\":\"28c871f0f4580d58\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/workspaceBootstrap.js\":\"b13c855c560478be\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockComponent.js\":\"749c07c01c1c0fac\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockCrumbs.js\":\"60e65f33da9738ff\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockEditor.js\":\"2014f947969ad71b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockLoadingPlaceholder.js\":\"08c8dd01e463f6a3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockProperties.js\":\"01cf7056081ca670\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockSearchPicker.js\":\"caa8e5a1c2b7a8af\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ConfirmBulkDeleteDialog.js\":\"f1ecd4301c9633e1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/DividerHandle.js\":\"5d391bd7d109903c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/DraftEditor.js\":\"2fccc0d9526bba35\",\"/knowledge-medium/pr-preview/pr-1904/src/components/GutterPill.js\":\"a48ddae5a7c0bf08\",\"/knowledge-medium/pr-preview/pr-1904/src/components/Header.js\":\"ea384f89b50b8bf1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/LazyBlockComponent.js\":\"5274fb496773f424\",\"/knowledge-medium/pr-preview/pr-1904/src/components/Login.js\":\"53cf8181164696ed\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ZoomableSurface.js\":\"c07004fdb64be048\",\"/knowledge-medium/pr-preview/pr-1904/src/components/editModeKeepalive.js\":\"35a46bfe88a12e9e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyDisplay/PropertyDisplayScope.js\":\"364e55f312a0b7ce\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8939eebc7261500e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/RefPropertyEditor.js\":\"877b31d25b4b770f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/RefTargetTypePicker.js\":\"e4342340d3cde18f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/SelectPropertyEditor.js\":\"05fea3a415e300e7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/TypesPropertyEditor.js\":\"70b4f47d629718e2\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/defaults.js\":\"08931081fc63707a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/kernelValuePresets.js\":\"36aea012d1ce9ee9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/selectablePresets.js\":\"417fc3aa62643532\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/typesPropertyUi.js\":\"49d870c5ebe2e4d3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/AddPropertyForm.js\":\"24f92d97dc369ff0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/PropertyPicker.js\":\"44db93542620f745\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/PropertyRow.js\":\"05b55c262f586f6e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/Rows.js\":\"14f10bba8160b964\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/actions.js\":\"56c446e1dfd29645\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/declarationOnly.js\":\"e4f6bf9227fc0128\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/layout.js\":\"34121b8e648dc2ad\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/model.js\":\"218ab6cb15ea2441\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/shapeUi.js\":\"959900183a3e1a09\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/shapes.js\":\"46183ddb8045bbcc\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e2ad05c09a096407\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/visibility.js\":\"e902913d9c769d35\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanelSections.js\":\"002af64df42fd8ad\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockEmbed.js\":\"c1fb8edfc625e043\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockLink.js\":\"4947f3e73565972b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockRef.js\":\"b5bf01b3fb5ec384\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/CompactReferenceLink.js\":\"8327129e33cadaa0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/ReferenceLink.js\":\"499c075fc14be8f1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/cycleGuard.js\":\"49d626d2ed40a0d6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/cycleGuardContext.js\":\"91f665d7ed65b218\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/linkInteraction.js\":\"a38d4661d70bd1d3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/referenceLayout.js\":\"72d3c5c8ac8645f7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/useBlockRefAncestors.js\":\"3a7ccf89ab7235be\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockGutter.js\":\"1b9eb6fd66cd055a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockInfoDialog.js\":\"11e7d08cd787e08d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockReadText.js\":\"3c1ae5715d7d630b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockTypeBlockRenderer.js\":\"158c88951804fe2b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BulletHoverCard.js\":\"68504a1c69cfb781\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/CodeMirrorContentRenderer.js\":\"1e8212ef8565b418\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b511eff2b6dde02c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/ColumnResizeHandles.js\":\"2ad22292e84ac273\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c1f1f5c51e8ee230\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/DefaultBlockRenderer.js\":\"1f83280ee485bda9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/LayoutRenderer.js\":\"1c1a968e14b33cb8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/MarkdownContentRenderer.js\":\"18a9b4adc93f5257\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/MissingDataRenderer.js\":\"97ad6a0de28441d3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/PanelRenderer.js\":\"2030e32ec9e2e663\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/PropertySchemaBlockRenderer.js\":\"063bc0dcf01186e9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/TopLevelRenderer.js\":\"46ad33daad3bca66\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/blockGutterMode.js\":\"4d2a488c277beb9f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/blockTitleText.js\":\"13fd6e4971a3b263\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/fieldCreationKeydown.js\":\"cd5493f8b03841c8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/layoutRootContext.js\":\"41f8ea2634538dc7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/typeChip/TypeChip.js\":\"7598dccf93b7a26f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/typeChip/chipStyle.js\":\"c169a1da645447b6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/anchored-floating.js\":\"e8e264b8655a4063\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/button.js\":\"b498c454c3e9cffd\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/card.js\":\"ffcb24f6d5775d46\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/checkbox.js\":\"2db3528a9260d9eb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/collapsible.js\":\"f22504d8c53ded9d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/command.js\":\"981dfed1d10db949\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/context-menu.js\":\"b4693fe1f8720a62\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/dialog.js\":\"ae31ab69a83eac08\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/dropdown-menu.js\":\"ad966dae7e0743d2\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/floating-listbox.js\":\"b7fa243bf4903cf3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/index.js\":\"4b42aa4e997981bb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/input.js\":\"37546cfc9139f76f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/kbd.js\":\"b72d1bc0a73c7887\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/label.js\":\"7fa37872f1146f6d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/textarea.js\":\"c0ebc74da246d072\",\"/knowledge-medium/pr-preview/pr-1904/src/components/useEditModeYieldKeepalive.js\":\"38edd80fe89ca4a8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/BootFallback.js\":\"3204e08e3c521099\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/FocusedRowLazyMount.js\":\"8f7be2cfc674fe5e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/LazyViewportMount.js\":\"e4e01c283e347252\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/LocalDbCorruptionFallback.js\":\"4203bdd4756112c1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/error.js\":\"b78bff23736f5add\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/lazyMountRegistry.js\":\"bfb2f2def26811e5\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/suspense.js\":\"902b4a4d236da373\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/CreateWorkspaceDialog.js\":\"e8a758654c92e17a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/PendingInvitations.js\":\"6e23c92ebdf3a8ba\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/SyncProgress.js\":\"1e8f3a1ab597363a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/UnlockProgress.js\":\"a7146d457694a6cb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceKeyGate.js\":\"9f6db958a0291248\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSettingsDialog.js\":\"903a155170a2bb7f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSwitcher.js\":\"aaccfe9be1f54eee\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSyncGate.js\":\"4e128475d98751ed\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/ConversionFlow.js\":\"b0c262fd88ade50c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/ConversionFlowHost.js\":\"c946ba109486b0b7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/EncryptionSection.js\":\"6ccbdb47478b4b93\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/attachmentPrompts.js\":\"0f8ca76f33246fd9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/bundleFolderPrompts.js\":\"672f0f49f86df3b7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/conversionFlowDeps.js\":\"6df5eaca3b6de436\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/conversionFlowStore.js\":\"357e6cc5649de328\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/flowUi.js\":\"a43a4d1d2f354452\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/useConversionRun.js\":\"2095147901735139\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/keyUi.js\":\"f98e321852e51150\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/useCloseOnKeyLoss.js\":\"bb8bc05636ebc810\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/useCloseOnServerE2ee.js\":\"ff5c51f25d23a561\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/workspaceUnlocked.js\":\"6d2f77e1ff77d98b\",\"/knowledge-medium/pr-preview/pr-1904/src/context/backgroundSubtree.js\":\"e1988812e450b008\",\"/knowledge-medium/pr-preview/pr-1904/src/context/block.js\":\"eab1ff8bc6f6e5fb\",\"/knowledge-medium/pr-preview/pr-1904/src/context/layoutWsContext.js\":\"a0c66e2726d5d2bb\",\"/knowledge-medium/pr-preview/pr-1904/src/context/propertyDisplay.js\":\"7ab92301aa29628c\",\"/knowledge-medium/pr-preview/pr-1904/src/context/repo.js\":\"f5110bf2e38e2064\",\"/knowledge-medium/pr-preview/pr-1904/src/data/aliasClaim.js\":\"8a5b70d990555761\",\"/knowledge-medium/pr-preview/pr-1904/src/data/aliasSeatNamespace.js\":\"bbf62ddf876bb1ec\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/blockData.js\":\"1072c76bd32e55ec\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/blockType.js\":\"e0717e40d022f78d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/changeScope.js\":\"a1cde7db036069eb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/codecs.js\":\"d177e83b38fb1595\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/derivedData.js\":\"7dacd13dc1a1a12b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/errors.js\":\"55ae8d8617f10df9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/events.js\":\"56f6025c742c90eb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/handle.js\":\"7d91c67708dd37d2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/index.js\":\"96108dcda1e41f99\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/mutator.js\":\"2aa28ed34dd694d9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/processor.js\":\"809e6a5754d36102\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/propertySchema.js\":\"b594890a6efc7395\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/query.js\":\"38341f9f58d93b0e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/sameTxProcessor.js\":\"260e947d64b1a729\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/schema.js\":\"7d91c67708dd37d2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/tx.js\":\"7d91c67708dd37d2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/typedBlockQuery.js\":\"03fb857de75e2d1a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/user.js\":\"a73a9f563d3ccfa0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/valuePresetCore.js\":\"c5cd8f6f8387d742\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/valuePresets.js\":\"d1e20c1c6c988916\",\"/knowledge-medium/pr-preview/pr-1904/src/data/attachmentCleanerIOVerb.js\":\"d8b1c073aba27305\",\"/knowledge-medium/pr-preview/pr-1904/src/data/block.js\":\"850835d6babc9cde\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockCache.js\":\"cbaea807efadd578\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockId.js\":\"7c9c4eb54e2f59a2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockLiveness.js\":\"56d4a54903ef6b1a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockMerge.js\":\"12b6b8aa194d8b24\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockSchema.js\":\"9a649a1e8f4da692\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockTypeLookup.js\":\"04776cfac716c521\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockTypes.js\":\"806faa6f9ac1f2fb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/childrenView.js\":\"76f1e69e8429b777\",\"/knowledge-medium/pr-preview/pr-1904/src/data/clientContext.js\":\"1e804a95fbc7bd34\",\"/knowledge-medium/pr-preview/pr-1904/src/data/dbFileSiblings.js\":\"a2c9a52c6321caac\",\"/knowledge-medium/pr-preview/pr-1904/src/data/definitionSeeds.js\":\"c76908e4eb8b36af\",\"/knowledge-medium/pr-preview/pr-1904/src/data/derivedIds.js\":\"534038f6e6845cec\",\"/knowledge-medium/pr-preview/pr-1904/src/data/drawnSubtree.js\":\"0e56bc64e43d44f7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/facetBridge.js\":\"ba7aaef92c3a7ac2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/facets.js\":\"91f78c78b32e6604\",\"/knowledge-medium/pr-preview/pr-1904/src/data/globalState.js\":\"dff5224de48c5c7b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/aliasClaimRederiveProcessor.js\":\"7b66cdd277945a2c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/ancestorBatch.js\":\"6b6e7b1cfa32713a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/blockTypeTypeifyProcessor.js\":\"420d94f04e2b1814\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/clientSchema.js\":\"e1daa9d436890435\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/commitPipeline.js\":\"e9ecdc8faffe565e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/devAssertions.js\":\"504efc7bd0388e27\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/firstSync.js\":\"83029d7ab0443038\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/freshInitialLoad.js\":\"0df9d7b52a1c7db0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/graphBackfillClaim.js\":\"2a665ec47f95ffe5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/handleStore.js\":\"c9cb71ef0368f830\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/idleMarkerJobs.js\":\"10ad827b13853265\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/initialDownload.js\":\"1da13d0d7fde11c6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/initializeClientDatabase.js\":\"45fcbda1556a05c1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/jsonCanonical.js\":\"e7a81a1167b6aaaa\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelInvalidation.js\":\"31bc4ab6450f0420\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelProcessors.js\":\"667d33ed9137e43c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelQueries.js\":\"3291fb146cbd798a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/mergeTypeMembershipProcessor.js\":\"29b420cfbfe7bca1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/normalizeReferencesProcessor.js\":\"3801ecb037ac4336\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/poolInstrumentation.js\":\"dd7313039a17e45e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/processorRunner.js\":\"16f006466b92f4d1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyCellBackfill.js\":\"5d1c6037535cfed7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyChildMint.js\":\"9fa05ba5a9340d9c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyChildrenProcessor.js\":\"c1ff4f38ff71a0b2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyDefinitionChangeProcessor.js\":\"a014bba3ab8d2f13\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyDefinitionSynthesis.js\":\"6c1b0d3e7d2910be\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyKeyScan.js\":\"4da54a3024fa7b23\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertySchemaResolution.js\":\"735089f9f93d2a81\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyValueEdits.js\":\"c29401ed3f219bd1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/raiseProtocol.js\":\"8600be3b893d0fab\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/readBatch.js\":\"af860c8a8552e3c5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/refProjection.js\":\"766826a0a4365187\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/referenceTargetLookups.js\":\"137222c2243d80ee\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/referenceTargetProcessor.js\":\"40651696f75f3aff\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/replayMerge.js\":\"0a629674649a179e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/sqlBinds.js\":\"e8afda4e337c3850\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"cebe17cff95f92be\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/arrivalProcessors.js\":\"42dcf318b12ccc85\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/invalidate.js\":\"53413e81948b4c53\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/materialize.js\":\"33609064666c0f80\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/observer.js\":\"0b07227f7ee31c33\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/reconcile.js\":\"8edfde2b8f37b36d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/timingMetrics.js\":\"eaa8de2cc4183b25\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/treeQueries.js\":\"e232fa7e5f1bc83f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/txEngine.js\":\"2aa6bc6efedf8247\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/txSnapshots.js\":\"372bb3a9c9d5a924\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/typedBlockQuery.js\":\"c6db8771422dfa1a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/undoManager.js\":\"43966ac32148df2e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/invalidation.js\":\"0ed4e006e784b5bf\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelDataExtension.js\":\"6cc8ad1ad4f36136\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelPage.js\":\"28afff6d6ade4c79\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelValuePresetCores.js\":\"a1acd01ae14eeb1d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbCorruptionSignal.js\":\"4741a37afe502061\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbStorage.js\":\"19f2f1485415a140\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbVfs.js\":\"13be42769b655a75\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localSchema.js\":\"c1eaff87b230ad3d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/maintenance.js\":\"59b19573357ad25e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/mergeProperties.js\":\"ad816a94b812ab3e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/metricsConsoleHook.js\":\"6593363016f0c1a3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/migrationsPage.js\":\"aebfa46ecc720015\",\"/knowledge-medium/pr-preview/pr-1904/src/data/mutators.js\":\"d805308703ead1cd\",\"/knowledge-medium/pr-preview/pr-1904/src/data/orderKey.js\":\"5dab417b505b60a5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/orderKeyPlacement.js\":\"a7b2d6223fdfa981\",\"/knowledge-medium/pr-preview/pr-1904/src/data/outlineSurface.js\":\"573a8c4ae3651b00\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pendingEditorContent.js\":\"f089921eacbdc77c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pendingUploadsSql.js\":\"884ee06ac22387db\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pluginStateExtensions.js\":\"72cc249d4400c7fc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/powerSyncLogger.js\":\"15f5b4a78e88d7ec\",\"/knowledge-medium/pr-preview/pr-1904/src/data/projectorRuntime.js\":\"0b87e72c3427f105\",\"/knowledge-medium/pr-preview/pr-1904/src/data/properties.js\":\"2f9ae45f400f30a3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertiesPage.js\":\"64653344e956c41b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyChildren.js\":\"92f5c95a7d2b3886\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionFanout.js\":\"6c50f50c1708dfcf\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionMetadata.js\":\"4b5b725b585b8443\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionRegistry.js\":\"011abf37d3a32163\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDisplayMode.js\":\"c7f09dc18c97c296\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyRowCreation.js\":\"abea7c1f288cdefb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertySchemaCreation.js\":\"26747ad9af0f89ef\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertySeeds.js\":\"ae2b846f356f4866\",\"/knowledge-medium/pr-preview/pr-1904/src/data/recentsPage.js\":\"7e758bccef0093d9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/refTargetComparableProperty.js\":\"ee785052b64ba3c6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/referenceBlock.js\":\"aee15dae061e1567\",\"/knowledge-medium/pr-preview/pr-1904/src/data/rejectedUploads.js\":\"ed82001ec4a90c45\",\"/knowledge-medium/pr-preview/pr-1904/src/data/releasePowerSyncConnection.js\":\"9bde9b8eb2d6f645\",\"/knowledge-medium/pr-preview/pr-1904/src/data/repo.js\":\"acca2e2ce584d793\",\"/knowledge-medium/pr-preview/pr-1904/src/data/repoProvider.js\":\"c9a1d681a7186cb9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/rowProperty.js\":\"30f953ee290dfd47\",\"/knowledge-medium/pr-preview/pr-1904/src/data/searchFilter.js\":\"27b6d4dd2dbc4544\",\"/knowledge-medium/pr-preview/pr-1904/src/data/seedIdentityLedger.js\":\"53d82e2180881073\",\"/knowledge-medium/pr-preview/pr-1904/src/data/stateBlocks.js\":\"f462a79a23b5cf8f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/structuralEditPolicy.js\":\"d96a18f0b3b788ed\",\"/knowledge-medium/pr-preview/pr-1904/src/data/structuralInsert.js\":\"6135411120253ced\",\"/knowledge-medium/pr-preview/pr-1904/src/data/subtreeDelete.js\":\"b0d230e695f8b407\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncStreamLock.js\":\"916c42d85883cc7d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncedTableSqlRecognizer.js\":\"ed4c395e1d1a9f08\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncedTableWriteGuard.js\":\"c34505c84b692f93\",\"/knowledge-medium/pr-preview/pr-1904/src/data/targets.js\":\"75c2cf3361296e42\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeColors.js\":\"bfd12daed7ad550f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeDefinitionMetadata.js\":\"9607343c3c737050\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeDefinitionRegistry.js\":\"a75ffc3d7783e4f4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeExtraction.js\":\"ff7fdb8a7793ea0f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeInitialValues.js\":\"6f67fb51c52b29ae\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typePropertyGroups.js\":\"550ad5d42e777156\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeSeeds.js\":\"9a09ab97069d3d4f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeTagger.js\":\"a948555dd012acec\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typedRecords.js\":\"3b2fdb82726feff6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typesPage.js\":\"be8ed6e687fdd70d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userPrefs.js\":\"e0845766718362c2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userSchemasService.js\":\"bc96059fdffb20fc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userTypesService.js\":\"dc821889c3f2c53f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/valuePresetRegistry.js\":\"2e2978c6e661e649\",\"/knowledge-medium/pr-preview/pr-1904/src/data/visibleChildren.js\":\"d00339d7c097db15\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceConversion.js\":\"41af37c7b361afb4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceFirstSync.js\":\"8ff2b1458f8b84e9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceIdNamespace.js\":\"6bd3e164dcb3d4f9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceSchema.js\":\"704d9cc7f8c8ff34\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaces.js\":\"ca10e05bf51fd3ac\",\"/knowledge-medium/pr-preview/pr-1904/src/data/writeAheadLog.js\":\"b33191232f543520\",\"/knowledge-medium/pr-preview/pr-1904/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/BlockPasteShellDecorator.js\":\"94bb3fe1682ea0d6\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/atTrigger.js\":\"318ba89ea3a27a20\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/autocomplete.js\":\"960e5081d1240ec5\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/codeMirrorExtensions.js\":\"7b0e9a5ceb0889e0\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/contentFlush.js\":\"62ae294b48e86ad3\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/defaultInteractions.js\":\"989b83895c249a94\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/editSettleSignal.js\":\"3a639f478d04aaf5\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/insertImage.js\":\"c994f27dd165661c\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/referenceCompletionRange.js\":\"df3cd12d397517e0\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/referenceTargetTypes.js\":\"53f51d20dce11e0c\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/syntaxContext.js\":\"47f66934aec11e09\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/triggerMatch.js\":\"661151b02b7bd579\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/AppRuntimeProvider.js\":\"2fed1d8224d03c09\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/BlockFocusShellDecorator.js\":\"cb537305b78c310b\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/ExtensionRenderBoundary.js\":\"14187ae41aebce46\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/PanelContentRecovery.js\":\"a82a1bde673de6a3\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/apiCatalog.js\":\"3a9a8fd9ea7cf518\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/approveExtensionHere.js\":\"0b7fa51c4b551d11\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/armedCutAppMount.js\":\"812919e03b01c514\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/batchableKeyedStore.js\":\"21fca29212e04333\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/blockInteraction.js\":\"5cfc78f819111f60\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/blockSelectionAction.js\":\"e7098d385cde2b8a\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/compileExtensionModule.js\":\"d8577ba561d66d77\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/compiledModuleCache.js\":\"05c86d1353e0c32c\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/continuousGestures.js\":\"194d8ef2407df025\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/core.js\":\"ad88d478e598794c\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/defaultRenderers.js\":\"ae9fc37c246726fd\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/definitionFanoutAppMount.js\":\"9132b1159019ddba\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dialogAppMount.js\":\"610985bacacf8b48\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dynamicExtensionSeeds.js\":\"7d234a6bcb965177\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dynamicExtensions.js\":\"5a46a85c352571ca\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/exampleExtensions.js\":\"0b5e9b9d125094e8\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionApprovalStatus.js\":\"358f68279e354bbd\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLoadErrorToast.js\":\"2ac5ccd31dd9c4ff\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLoadErrors.js\":\"13d70aa458705e12\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLookup.js\":\"9d9ec72b85c0d279\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionToggles.js\":\"20feb8d78acd5529\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionUtilitiesCss.js\":\"996defa731b842cd\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/kernelPageDeletionGuard.js\":\"14d167f81885067e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/liveRuntime.js\":\"380bf9d8bc1fc0ed\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/openExtensionsSettings.js\":\"3bc0fd33b5791df8\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/overridesCache.js\":\"79b68c89157f73a5\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/pluginIds.js\":\"dc6849b9b88d1e7c\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/processorRejectionToast.js\":\"6941e22702e6dcf1\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/runtimeActions.js\":\"5fc67a1f5d2ce264\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/runtimeContext.js\":\"2c23702be23698a7\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/staticAppExtensions.js\":\"7e3e1f5ee02c3ad8\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/staticDataExtensions.js\":\"4243a9b816ac5951\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/toastAppMount.js\":\"9de81c83399e3a0d\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/useOverrides.js\":\"0925a92ed5ea2dc6\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/useShortcutSurfaceActivations.js\":\"30980c9cb2d65af5\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/discoverToggleTree.js\":\"3614134143c29bed\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/facet.js\":\"a6a91fbf5e9a6e7a\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/resolveAppRuntime.js\":\"dd57923037de5fac\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/runtimeEvents.js\":\"d0efa2d08de4ef74\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/togglable.js\":\"5e4bfa552d3a8cba\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/variantFacet.js\":\"43b6dc3cac98dc79\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/verbFacet.js\":\"ebbf6c7f11dc54d6\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/block.js\":\"a1d0378d2f1f3833\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/focusedChild.js\":\"f72904b62823df8a\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/propertySchemas.js\":\"89f7da59de8cffda\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/typeRegistry.js\":\"eaa267a9b76ffaeb\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useAncestorCrumbs.js\":\"be430db64641422e\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useAutocompleteListbox.js\":\"699da15f8a4387a4\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useDebouncedSearch.js\":\"72b72c0f2501daaa\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useDebouncedValue.js\":\"68817e7d0036a84a\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useFacetValue.js\":\"cb43825ed79be9a7\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useIsFocalRender.js\":\"a4cf5d083b9c39a9\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useIsReadOnly.js\":\"8a5a3e91d2aca01e\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useMaterializeBacklog.js\":\"fa5593e0c7cff8b7\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useMinuteClock.js\":\"11e0c611211e8c6d\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/usePanelLayoutProjection.js\":\"67ba1c2253867d62\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/usePendingInvitations.js\":\"305231dcd40ad68e\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useRendererRegistry.js\":\"105a3531331fa5ab\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useRetainedFieldRows.js\":\"790a7e94a49951c8\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useWorkspaces.js\":\"e6bdc56ac3608ded\",\"/knowledge-medium/pr-preview/pr-1904/src/lib/utils.js\":\"f6b00f408eab54c5\",\"/knowledge-medium/pr-preview/pr-1904/src/main.js\":\"4597c1c6bc4b32af\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/MarkdownImage.js\":\"99cb7263f2a659f2\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/blockSeparators.js\":\"3c3a3ef5df979f17\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/context.js\":\"7450d2040069d48b\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/defaultMarkdownExtension.js\":\"480a88873bfcded5\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/extensions.js\":\"45c08854615e0397\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/renderMarkdownHtml.js\":\"93644757e752353b\",\"/knowledge-medium/pr-preview/pr-1904/src/minimal-editor.js\":\"ab8bd71e3253ae3e\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/armedCut.js\":\"de5aa44701c91da1\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/captureMediaVerb.js\":\"ee860c46eb02bb09\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/clipboard.js\":\"338b8a1aaf66409b\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/decision.js\":\"83560f6403e2927d\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/operations.js\":\"36e309ac9a7698d4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/account-header/AccountHeaderItem.js\":\"ee1a2d566eeaedd5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/account-header/index.js\":\"b00a8681742fc050\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"d67e799494c2c706\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/askAgent.js\":\"ec2cbb1f935a2c8f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/askedStore.js\":\"acb05731f3898fb9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f4e5cd5b9e0eaadc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/chipState.js\":\"6551d4e1ceb893dc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/dataExtension.js\":\"423c5201347d3495\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/index.js\":\"2078a7d688394f21\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"dcaf57e5819416b0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/schema.js\":\"7d3e7e2d50a1d167\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/AgentTokensDialog.js\":\"28ca6491c9531529\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/BridgePairingDialog.js\":\"edcc5194f655607c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/addMedia.js\":\"ad233e8c65f209b3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/backlinks.js\":\"520cfe02ca70ca2e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/block.js\":\"a4a13f211b74ed20\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/context.js\":\"372a875856640684\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/displayIds.js\":\"68dcfc945bd67c2b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/index.js\":\"5eb86eabd670b5d5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/outline.js\":\"487005ee352bde61\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/properties.js\":\"8710ae3b133b0d58\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/refs.js\":\"fe101ce2d9903e8c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"53073e25bffa53ea\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/search.js\":\"467a551c4cafe26e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/shared.js\":\"aa36158383b87c45\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c0bc67d1c8a95297\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/text.js\":\"a96e1127dc6d8ddf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentWrites.js\":\"79154450bf0b0e65\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/authoringCatalog.js\":\"1b0e00eabd32a2f4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/blockRefTargets.js\":\"f1225a8d1a0132ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/bridge.js\":\"480272e473ad199a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/bridgeLoop.js\":\"c6e5185a3b9ee2ca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/changeHistory.js\":\"013510c3a64e6fd0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/commands.js\":\"45312815743f358f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/commentsCommands.js\":\"ad692d1bc4ddc4dc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dataExtension.js\":\"da65cd30b190aeb1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dataModelGuide.js\":\"fe6acec01ce47f53\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dayPropertyInputs.js\":\"65c76ddca12ef3e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/describeRuntime.js\":\"3ffeccf902f672b9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/extensionLint.js\":\"c3a6c75a372ef952\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/grainAudit.js\":\"24f3da04bc2d860c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/healthCommand.js\":\"b2255e4fc4d514da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/index.js\":\"a0c811a0c6668f6d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/presetIdentity.js\":\"b06ef0a7c01a8b0a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2e7e3f085c4457ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/readMedia.js\":\"33b92eaa5bbf2614\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/schema.js\":\"a95eabcb3dbb22b7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/serialization.js\":\"4411ca4cbcc0891e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/targets.js\":\"4cbd81445b538893\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/tokens.js\":\"406692ed451fd6ce\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/watchEvents.js\":\"973cf3d807a54147\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/workspaceGuard.js\":\"62d889c1d6eeacd5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/writeCommands.js\":\"d67ebc315342b44a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/AliasCollisionToast.js\":\"09b3951b4457d60c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/DuplicateNameBanner.js\":\"af1bafe31262c24a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/collisionMerge.js\":\"67fa3d6a96a9ed0b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/dataExtension.js\":\"a6df989ea5c9f3b6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/index.js\":\"a855bdaea96708c2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/mergeCollisionAction.js\":\"82355e8f9c8f47c3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/pageStyling.js\":\"bd3eff4eb063248e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/rejectionToast.js\":\"2c2cc7c1a82c4888\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/syncProcessor.js\":\"f2c8730cc3a968e8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/actions.js\":\"54c7d00a0a126ba3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/addComment.js\":\"2d31cf40ac90ba8c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/anchor.js\":\"82aed97434f92c99\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/anchorState.js\":\"707086b1a609fb71\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/commentLinks.js\":\"a4b65c89ae082776\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/confirmThreadDeletion.js\":\"4984d45821dc6522\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/container.js\":\"6f1cdbc0d303c856\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/dataExtension.js\":\"ebd8e4f1772948bb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/deleteComment.js\":\"f8168a68119277db\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/highlights.js\":\"4a2bc094a899fb58\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/index.js\":\"60d4cfba5aa23503\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/linkedCommentsPill.js\":\"04b32091c53f04b1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/margin.js\":\"b97375a9eebec515\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/marginAnchorLinks.js\":\"ea72de46b84c85cd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/marginSchema.js\":\"660a1e2e2f9847ee\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/newComment.js\":\"4c96de9a2e86c981\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/ownThreadPicker.js\":\"bf83f2a6f1adea20\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/placement.js\":\"e9cf880e41313ef9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/queries.js\":\"229646c0cf51129c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotePosition.js\":\"10e6f136c13c25f0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotedIn.js\":\"6cf15df739e71ed2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotedRange.js\":\"d1f6ca1033cd9244\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/rangeRefs.js\":\"08d3d8832f9bd004\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readHighlights.js\":\"628b5e64f356f20e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readSelection.js\":\"02ce482f93b38ef7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readSelectionUi.js\":\"14c08966fe35544e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/reanchor.js\":\"22a27fcccdcd290f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/schema.js\":\"72b0d6d37e322df0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/scope.js\":\"d73b7dd728ef5284\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/scopeThreads.js\":\"793794eb23418da3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/splitRetarget.js\":\"579882ef3f8adc5d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/suggestionCard.js\":\"48a58c52e324ba31\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/suggestions.js\":\"8ac07b6023d4e8b9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/summaries.js\":\"182efbf0188cca39\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/summaryBatch.js\":\"054aa5460c6e4886\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/surface.js\":\"9b64aa4e567adc0a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/threadNavigation.js\":\"20225be01953342a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/threads.js\":\"c24192ef8f1c5ab9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/ui.js\":\"69e0c299485708c3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/uiStore.js\":\"a097bb02a82bf500\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-intents/appIntents.js\":\"d4787ec806c07d7c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-intents/index.js\":\"ae1352ebdbd299ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-update-prompt/index.js\":\"c46a2a45c96257a1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-update-prompt/status.js\":\"e09b032bda85e516\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b29dd1366f8327ea\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaBlockRenderer.js\":\"ceec278f4651d8b9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaDownLaneReplicator.js\":\"a950020d8dc0ebdf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaUploadReconciler.js\":\"9de6c021930a46d5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetDownLane.js\":\"616cf76397462e33\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetResolver.js\":\"db346084e1a399df\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetUpload.js\":\"9673895ecd22e0bc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/attachmentCleanerIO.js\":\"de7625d77f14c336\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/supabaseAuditIO.js\":\"969a192d5195578d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/blobStore.js\":\"b88645d35a4ae177\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/browserMedia.js\":\"a2610492af2ce361\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/byteStore.js\":\"50140726220ef500\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/cleanerIO.js\":\"0058423ee959b503\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/cleanupAttachments.js\":\"98204b8874a359a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/dataExtension.js\":\"b69e1c6f0facc435\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/downLane.js\":\"10ff942198f4a83d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/index.js\":\"4aee15aa3df61245\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/insertImageContribution.js\":\"f31b1fcbc251b932\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/laneArming.js\":\"d134961a9a977fd0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/laneLock.js\":\"eac15efa187737c1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaBlock.js\":\"61e7d764071e7c89\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaCapture.js\":\"ea3635d1e3764484\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaLanes.js\":\"d7d158c93855bbbe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaViewers.js\":\"d06d8ef3cb4b9e8b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaViewersFacet.js\":\"b76ceb47fa71e2e5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/pasteCapture.js\":\"10028e3d8c66615b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/resolver.js\":\"4ff815ad13086aa0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/retryUploadsAction.js\":\"de29c2477dd42068\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/storagePaths.js\":\"ba065c9b76e9406f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadDrain.js\":\"f2a79f428165955e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadLaneStatus.js\":\"be17fd5b6d5edd18\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadReconcile.js\":\"903cfa92bcdfa907\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadRecovery.js\":\"d7629e5473279a33\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadStore.js\":\"3151b2f1b5c733d5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/useAssetObjectUrl.js\":\"b29d95cb10d40520\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ddf817f79b8d737e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/BacklinksViewSection.js\":\"e4c16f2cc49dfa4a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/facet.js\":\"3362bc1a5bff9916\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/index.js\":\"0a47826d3e7da2d3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/prop.js\":\"4141fc163665875d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BacklinkFilters.js\":\"cd9e3d10485260a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"95d82e36f720dc1c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BlockEntry.js\":\"6f097c6c35716e30\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/LinkedReferences.js\":\"9bae29e21d9bb7cf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"bd16ceace213d43b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/dailyNoteDefaults.js\":\"b2fd97dc26cff7a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/dataExtension.js\":\"729ebc7b1943ceee\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/edgeExclusions.js\":\"c43cea22642e5d13\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/filterProperty.js\":\"3828fcc1709f19d2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/index.js\":\"92bed9abbe84dd58\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ae6d5bc820d4a988\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/applies.js\":\"a276a8ab476c794d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/countQuery.js\":\"8f2324883c3ac616\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/expansionStore.js\":\"23b7438d36266fa5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/index.js\":\"e552c91b4ad6e692\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"9f666f7cba498783\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/presentationInvalidation.js\":\"f8448cafa0a51660\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/propertyEditorOverride.js\":\"83c6cbd0d7311acc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/propertyFilter.js\":\"5c37fa1f36efe312\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/query.js\":\"9485769a385fedc0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/resolveFilter.js\":\"9faf406ab3e7555a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/sourceBatch.js\":\"da8834d8e5683fa5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/sources.js\":\"a5c42f6daa259c47\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/useBacklinks.js\":\"096072cdc0c5df78\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2a25050899442f9a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/BirthdayCelebration.js\":\"8ca50bc5108996a4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/BirthdayOverlay.js\":\"747a9240d55bfe02\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/gate.js\":\"dc5a1ebc290f03db\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/index.js\":\"92762773f9d5fa4c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/wolfTheme.js\":\"1a995d861ef32ddf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/BlockDragLayer.js\":\"53879e0c708de2be\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/dragController.js\":\"fc45965047303a90\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/dropTarget.js\":\"fbc843304c86f237\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/index.js\":\"853104c512012be6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/projection.js\":\"094d5c02926d71ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-info/BlockMetaCard.js\":\"7b43912d50f48838\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-info/index.js\":\"78cb00b1b4ca0694\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/AddTagDialog.js\":\"8ddaa02bf5ed0f4a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a81475098c0102d9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/TagNameIssueHint.js\":\"0235c7a09c48b156\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/addTagAction.js\":\"731a1faff8173271\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/appendTag.js\":\"a4d58c73a8a6dc51\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/config.js\":\"5bcb7f31f18c8c37\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/dataExtension.js\":\"2ae7f08035c85766\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/index.js\":\"d7b72ffc0e83897a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/propertyEditorOverride.js\":\"be5472a93fbe80cb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ca360d21fb0b4b86\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"bef4a06bb15f21f0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/Breadcrumbs.js\":\"318e085279c79e87\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a0b4a730f77a4b8d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"fd745b18584cce15\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/index.js\":\"0b71b6f5dc5f7646\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"aea9958f62780d16\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/CharacterCountItem.js\":\"92957512d4d1a65d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/ProfilePropertyEditor.js\":\"a5c2e56b0f6990f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/actions.js\":\"ce8eb81bda8303d9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/blockType.js\":\"9c0a55ad0c2bb701\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/charCount.js\":\"fb644a9d64fc1cf8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/dataExtension.js\":\"d3cb9bc91d8654c9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/index.js\":\"cff156c286df0a92\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/profiles.js\":\"4f95842499a458bb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/properties.js\":\"b2f78428773ec248\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/subtree.js\":\"4a94608537f2d61d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/textCounts.js\":\"fd6c948a0be4413b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/colemak-keybindings/index.js\":\"548487807531bd16\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/CommandPalette.js\":\"9aa95645f5066de8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/HeaderItem.js\":\"390d00d9bee7d551\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/context.js\":\"0daf50c331091112\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/index.js\":\"5fd344df4ab27dbb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/selection.js\":\"c76f12b0160814af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/toggleStore.js\":\"c332b84f7a81d5af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/useCommandPaletteActions.js\":\"a53677922f05e97f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/ContributorBadges.js\":\"674194f7f356ac2e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/ProfilePicture.js\":\"c23016b17a01b23f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/author.js\":\"5fe16ac76217bd26\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/codeMirrorExtensions.js\":\"71b5940ec49384fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/dataExtension.js\":\"3eea6019d0d71470\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/index.js\":\"b58605e29fad371d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/mentionAutocomplete.js\":\"30ace8112ebab00c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/processor.js\":\"44ec551889b47113\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/profiles.js\":\"505388d1f3aa07a9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/queries.js\":\"b14491f225d43af5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/schema.js\":\"ea47d9cfdc0f405a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/useCommentAuthor.js\":\"d0c5f610a9a0ffa7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"542898cd57b4e479\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/followOrigin.js\":\"731c51b48e84d2c0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/index.js\":\"1aa62c14d9b889bc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"8405a5f1d9bc0856\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"769f9692c636475f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/CalendarGrid.js\":\"f78fbea00681d2df\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DailyNotePicker.js\":\"36eb3b5c62fddbf0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"50778328adefd8c4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateNavDecorator.js\":\"3ac8e7250d006526\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateScrubOverlay.js\":\"f84131af8942da12\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DayPropertyControl.js\":\"f468144e1cc4dc2f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DayValueReferenceControl.js\":\"8f4cb15ed0fd00cb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/HeaderItem.js\":\"8ed9c059ed5f3459\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/ReschedulePicker.js\":\"410a5e2667344990\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d76db0a0017563ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/actions.js\":\"98053c1e62c9b5ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/blockDateAdapter.js\":\"e6c2cf8271a216f2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/calendar.js\":\"e4faa0080d68a804\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dailyNotes.js\":\"d9fac58d7d0c607b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dataExtension.js\":\"04ac0ccd34ce2660\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubActions.js\":\"5b33f03d72998238\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubGesture.js\":\"569e84e33c6932ca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a1682a8e239bfd9b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubRecognizer.js\":\"12024c66936a7fbc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dayProperty.js\":\"561b99b494084e00\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"6c89a04a499aefab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/deletionGuard.js\":\"532323c4a40336e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dueQuery.js\":\"bd5d817436d04152\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/index.js\":\"6a43c8d1aee5c752\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/landing.js\":\"a4437a450ea92447\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/localSchema.js\":\"0d4080282ba59ea1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/referenceDateAdapter.js\":\"0c364b5a2f3607f8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/rescheduleAction.js\":\"bfb50fe75c1e18e8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/schema.js\":\"49d32f62150b9b44\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/spreadBlockDates.js\":\"f6a9e37a20a1fd43\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/spreadDatesAction.js\":\"504c3de8079c8d58\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/today.js\":\"075e57368f317a7c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"cd4a1abd4c69a678\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"941132d364b32a3b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/audit.js\":\"cdf8df3e47fd8988\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/auditAction.js\":\"26e1b743464eb5ff\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/auditRanges.js\":\"fc2a28f1c777842c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/diagnosticsSource.js\":\"5cbebfc78fd14c8e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/divergenceScan.js\":\"cc9847d0a315dc2a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/index.js\":\"b49327cce6091aad\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/propertyChildrenChecks.js\":\"adadbcfc3cb054b3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/referencesMirror.js\":\"2c270178409416c7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/rowJson.js\":\"c3bfcdeb534e699d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/schedule.js\":\"eede4941fd74f0c4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/store.js\":\"d870cbf74b5b7cff\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/action.js\":\"82cf0144ceade993\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/index.js\":\"e3ec04606c50d5f6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/plugin.js\":\"2706b20c70113643\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"282b01a9a97184d3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/actions.js\":\"34b99a9e8c70520d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/changeMarker.js\":\"c3a49c54de572c6a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/diagnostics.js\":\"ecc433247e802785\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/fileSystemAccess.js\":\"d7139033c8db9858\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/filenames.js\":\"16167527293d20b9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/index.js\":\"1a2e6e65f7589a00\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/mirror.js\":\"0d3d31d4bfc6774b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/runLock.js\":\"29300d8c4e361952\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/runtimeHealth.js\":\"169a9b8cfc8f1c1e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/schedule.js\":\"685d28e903b070f1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/store.js\":\"fc794a7455f61779\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/default-themes/index.js\":\"79630b478e0e5539\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/default-themes/themes.js\":\"42098325f3475eb8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/diagnostics/facet.js\":\"f2db1be40ddca189\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/diagnostics/useDiagnostics.js\":\"d88e5c7ecba5b3c2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/dismissals.js\":\"8d0191e3c87ad6cd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/index.js\":\"fc866e92f6b50388\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/status.js\":\"b0f2f768dedfeb9f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/store.js\":\"c3f85b883b48fd6a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"f1a7f35accf33d16\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/ExtensionsSettings.js\":\"73aa0f67e7abb84a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/actions.js\":\"e1c7a14127b1f617\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/config.js\":\"b642b87acf77978b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/dataExtension.js\":\"6bb7947d27db9486\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/effect.js\":\"74e66ce2d485d743\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/index.js\":\"7f5a24dce44d33a4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/propertyEditorOverride.js\":\"3b9861a0dc894e59\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/useToggleTree.js\":\"6b39786898aa4c95\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/ExtractTypeDialog.js\":\"b475c21ad1e54d4b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"771fb80b3e8b51d3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/PropertyShapePicker.js\":\"38922c27d00b5487\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/action.js\":\"dc42ebb9b00412af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/index.js\":\"2afec901154f7340\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/FindReplaceDialog.js\":\"ac1b6d52b5a90b2c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/HeaderItem.js\":\"6f09277958bc8a11\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/dataExtension.js\":\"4e06ac67933f42fe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/index.js\":\"a6656d3d23f2c524\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/search.js\":\"27df8f5e1e165801\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/toggleStore.js\":\"51fe7fa1fe076b78\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/LocationPropertyEditor.js\":\"c5b844226164e61a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/MapView.js\":\"d8a4407abffec966\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/blockTypes.js\":\"aa6ad96472ab1c22\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/codeMirrorExtensions.js\":\"35e5fb924eee6569\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/createOrFindPlace.js\":\"1e9e147c3dccdb1d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/currentLocation.js\":\"f7737e6578ea102c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/dataExtension.js\":\"7848101100995181\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/geoContentDecorator.js\":\"4de53cc4306583b2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/googlePlacesClient.js\":\"4b2ae9d20dd8fe8c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/index.js\":\"7964f1521b602096\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/locationsPage.js\":\"325f8285be5bff26\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/mapViewport.js\":\"3e655800cf3ca067\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/pickCurrentLocation.js\":\"d07645263a363c47\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/placeAutocomplete.js\":\"1918db84e5e4e82f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/placeNameCollision.js\":\"6f07548e466466af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/properties.js\":\"930f5d0237813f0f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/propertyEditorOverrides.js\":\"23e877f237720756\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/query.js\":\"45146e4b89a92e7e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/usePlaceSearch.js\":\"3e5b075dbcc7faa2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"8349d9bfc787fcb6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"db6ff8a7934562d6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"0227282d388f1aff\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/config.js\":\"6763b99fef068e6e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/dataExtension.js\":\"94c1120ecbc66eb2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/facet.js\":\"135408dea2f39cbe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/grouping.js\":\"a3f4ba3b542e2d3d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/index.js\":\"689a7fc4064f8abe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7d9e6e2a991ca1a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/query.js\":\"ce025e739a40e096\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/resolveConfig.js\":\"69baddcd8f348ca2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"ab1301806420b16d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"297c77cd82296ab1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/HtmlDocumentContent.js\":\"a836d55267d0a46c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/HtmlFrame.js\":\"6d514ab4af53d227\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/actions.js\":\"552ce5c9bca8ca2f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/blockType.js\":\"f17db3fa66b80163\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/confirmRunScripts.js\":\"53c03f90f888a6e5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/dataExtension.js\":\"658e47223915ceea\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameAnnotations.js\":\"0a24179853ee4257\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameDocument.js\":\"167118e97d4fdd99\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameTheme.js\":\"6d7abc28a233aa11\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/index.js\":\"02e0f40f139148b1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/scriptConsent.js\":\"d91c893c348c82d6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/sourceMap.js\":\"eec504eccb89f901\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/useDocumentScripts.js\":\"a647ae29ed10850f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/index.js\":\"bf0a501201faded2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/record.js\":\"4664bef7b310df60\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/recordStore.js\":\"39f234fe7ae58f3c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/responsiveness.js\":\"c9a28cd7b305679c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/schedule.js\":\"cdf5eb7a9a2b26a7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/sessionContext.js\":\"011d41a8ece85b88\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e53b418418d7f208\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5be8629aa7e6f468\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/actions.js\":\"1e49bc3c2bbb06f2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/config.js\":\"714e26166408fc75\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/dataExtension.js\":\"aed92d789f02693e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/effect.js\":\"c179ff8f7e11f6db\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/index.js\":\"1026fc0b689c3a36\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/keyCapture.js\":\"89675dd7ea308bbb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/overrideStore.js\":\"6ff0736b0f37d81b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"9ddaf3ca64186cbd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/HeaderItem.js\":\"7952c47d71dfe991\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/LeftSidebar.js\":\"81551a8dab1ad616\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/actions.js\":\"23144ec8ada155fc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/facet.js\":\"16840fc9995dc582\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/index.js\":\"5fb19d708d205521\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/shortcuts.js\":\"87a957dd22cda6f4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/toggleStore.js\":\"d7ac70509693f7aa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/MergePicker.js\":\"4b120026eacd1dec\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/index.js\":\"b6c24d38d68358ad\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/mergeAction.js\":\"33a8ed07193ece3d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/strategy.js\":\"57a42699190abcc2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/Button.js\":\"19bb9dedf8b67363\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"efd29f56c74f371f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d38d9b520b4fe455\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/facet.js\":\"c8dfb3f1e9222708\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/index.js\":\"580081d9a0b1a157\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"e7aaaf9893be3956\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2b016e5f0af397e8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"bb88060f6b026f50\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/facet.js\":\"87fb07854c99e9fc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/index.js\":\"7318758ed1d36298\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e12ebef4028f84d8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/blockSubtreeMembership.js\":\"563cc59b2840cffd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/contextMenuItem.js\":\"2f0deb51af641007\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/index.js\":\"69af76bd688e4b45\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/moveAction.js\":\"89ffc9333ee5cec4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/moveBlocks.js\":\"e558c9e75d58a595\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/selectionAfterMove.js\":\"750bce110c1863cc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/TutorialBanner.js\":\"7f0ca17cbd111229\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/action.js\":\"ee69282d490ce19a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/bannerDismissal.js\":\"fa1c7d391d9bfb7a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/documents/cheatSheet.js\":\"0175922752d8e375\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/index.js\":\"4a1e10bbfcd1e0ba\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/keys.js\":\"2d7b9ab802aa897f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/landing.js\":\"61579c6da834620c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/outline.js\":\"d6269234431b0d06\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/seed.js\":\"266447e2b2363f9c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/PerfTrendDialog.js\":\"f957ac0a3f6a3ac3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/analyze.js\":\"53fe8c333f307714\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/diagnosticsSource.js\":\"efc537048c4d4489\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/index.js\":\"a0861eeb1c152d88\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/load.js\":\"8c631d9175ce5d31\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/monitorRun.js\":\"5f869e8a46a564c6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/schedule.js\":\"836bd173285987e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/series.js\":\"8066fd6b3ad0b63e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/store.js\":\"62ff122d382414bf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/trendAction.js\":\"63cfe8cbd90e6f6d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/verdict.js\":\"d21c0d68879ba2eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/clickToEditAction.js\":\"801a7c2cd9c0b4d4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/index.js\":\"90292f192c7b8ade\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/interactions.js\":\"e5418e75250df52c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"4754fad7999244c2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/MigrationGate.js\":\"8323bcbb99f36f36\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/MigrationGateDialog.js\":\"ae0e0085db55332c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/action.js\":\"1a07d9a7792c69f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/index.js\":\"2c6199860d5f6584\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/localRunMessage.js\":\"0cf7d3b7ba0f07a4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/plugin.js\":\"7b3a23292f88fe23\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/progressReport.js\":\"c2c1630a1870f561\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/sweepProgress.js\":\"06efdb62f06f526e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/FieldRowRenderer.js\":\"1bd2c102ae5e942b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/ValueRowRenderer.js\":\"815528de393816a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/actions.js\":\"c40ad935bba00767\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/autocomplete.js\":\"fc0ddd59fb2a72e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/fieldRow.js\":\"5b8383d8da8e1228\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/index.js\":\"c90754e2d9a868e6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/referenceWarning.js\":\"617001fe6ae61a2f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/valueAutocomplete.js\":\"8301fac30eace2b1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/valueSchema.js\":\"25c30c90ddf08965\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/HeaderItem.js\":\"cb16815f76900796\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/QuickFind.js\":\"01075f7fc52bf5d5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/index.js\":\"e9c20f4e4cb9d2a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/recents.js\":\"6d1083a38eba5949\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/resultItems.js\":\"d9b28ba82749111d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/selection.js\":\"503b606c11066274\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/toggleStore.js\":\"49e73cfdb0f228a7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/HeaderItem.js\":\"e115bfe46d44be8b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/RecentsPageBlockRenderer.js\":\"15e8dee645628bc1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/grouping.js\":\"946f517e00debb74\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/index.js\":\"a9a3e1123ba9850b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/target.js\":\"d25cffd81039608a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/codeMirrorExtensions.js\":\"6be810ecb8f807d5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/contentPrefill.js\":\"78ba897418b0fa6c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/dataExtension.js\":\"888982f28a6ea1bf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/index.js\":\"7741f4f5da8bcc29\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b7feac4c7b06edfe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/invalidation.js\":\"7562a9cef6548a18\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/localSchema.js\":\"c15bef896a0cbf83\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/blockrefs/index.js\":\"67bd5617978c941d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e8cb9ab7da83d4bc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/index.js\":\"67dad5b0f32c186e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/referenceNode.js\":\"ac952456f0536c94\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/remark-reference-occurrences.js\":\"137ebbe59e4c7953\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c1b4fee4b1fd4ecc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/index.js\":\"819d530a1321a0c2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"f9494d6d3161868c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"84a3e804f230ab1e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/mergeRetargetProcessor.js\":\"fe7586bc850ef406\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/parseFence.js\":\"db9b30640e6cb069\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referenceParser.js\":\"de43f303e21883fc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referenceProjection.js\":\"9ef5c0bce07609b1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referencesProcessor.js\":\"f69f48d37e3cc2e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/renameProcessor.js\":\"9d9b9620b6f4a536\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/spanReplacement.js\":\"3a3f84703f457526\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/htmlToOutline.js\":\"a2bb9e296256fce1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/index.js\":\"a71f85b5dfa6c8ce\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b17eec343ec6ff1b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/pasteDecision.js\":\"1ade358b580e2ace\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/action.js\":\"544b406f6ac3925a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/blockIds.js\":\"206df1366a2b7701\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/content.js\":\"718530964810b17e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/effect.js\":\"7c548dd47a900dbf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/ids.js\":\"39851e03658aa1e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/import.js\":\"a6b51179d1c56965\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/index.js\":\"3162ce4213ad000d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/plan.js\":\"2a227d8132107f72\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/plugin.js\":\"2918eef3f69e3819\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/promotion.js\":\"1becc2fa0d1a1771\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/properties.js\":\"5825ed784ee9f57a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/references.js\":\"5e3749521e92994d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/report.js\":\"e4e67ee97aa57d94\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/roamMemo.js\":\"b6fd583fbb881bec\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/runtime.js\":\"4b455bb1b89c05c3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/schemaReconciliation.js\":\"ce2e160971e242ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/srsMarkers.js\":\"af057ff979568adc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/todo.js\":\"b3c36cf6985302ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/typeCandidates.js\":\"3fed8b13e48f8086\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/types.js\":\"997995fa09c16374\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/search-health/index.js\":\"4a9b9092d3b00987\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/search-health/store.js\":\"53ac756a266f3197\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/HeaderItem.js\":\"ea7734e07a1e315c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"5338877109580e3d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/index.js\":\"bb6ef17890d7197c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/model.js\":\"466ed6e426c00a76\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/toggleStore.js\":\"270e59ba46fc245e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/useKeyInspector.js\":\"aa511610ed0ddaa0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"65a1a78d400cb3cb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/ShellDecorator.js\":\"0bfe15208896a484\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/actions.js\":\"28e4f8152c232a14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/exclusionsFacet.js\":\"fdce00b38f541df3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/index.js\":\"3510eea3b5d56dc4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/shell.js\":\"74d764c6d602ee85\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/surface.js\":\"5b4ebba43a3e7aed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/walker.js\":\"f1160c1df6d407f6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/RescheduleToast.js\":\"eed933d79879ea05\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/dataExtension.js\":\"18fd279fa8338ee7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/index.js\":\"8c2a2ec5dd15dcd4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/indicator.js\":\"8d00f1a7f59af062\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/moveSrsState.js\":\"bd803f464c05c224\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"44b80eda6ffb7ae7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/scheduler.js\":\"dc6c8b1aeb1a9074\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/schema.js\":\"16b96f93b144ab2f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"b6a3a46f5152a21b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/srsClipboard.js\":\"a7bbd7f20707b596\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"36268148598186c4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/DailyNoteReviewHint.js\":\"a719f95dab7d1cc2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/DeckPicker.js\":\"ca954dd80e1f93cb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewControls.js\":\"107c9c0bacc1808a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewDeckRenderer.js\":\"c71e6cbcb87618d7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewSession.js\":\"5fdc595980ecb589\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/actions.js\":\"3acbd815355a5662\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/archive.js\":\"1828421b73827914\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/dataExtension.js\":\"0b927138f07e373a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/deck.js\":\"027ba9ac48ea40ba\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/dueQuery.js\":\"092afdf5d0553256\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/gradeDecision.js\":\"55f629c3be82bd7d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/index.js\":\"750aab7b2a0b0aca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/keyHints.js\":\"994e6710c5d1ce28\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/reviewCardLayout.js\":\"87672d78e55b6d04\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/reviewProgress.js\":\"74fd083d32d87743\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/schema.js\":\"f783e2e7c237752b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/useDueCards.js\":\"24a125b8bbb7aa4a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/startup-metrics/index.js\":\"72be910e8b94ada2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/startup-metrics/record.js\":\"6c6cd019269f9872\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/index.js\":\"2af5843f4c8af593\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/persistenceStatus.js\":\"f63afaa7a9694cc9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/requestAction.js\":\"72acd9d7b20e721d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/TypeChipsDecorator.js\":\"414485a512198573\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/codeMirrorExtensions.js\":\"291d95555f27036a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/index.js\":\"83089f8764a20dd0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/typeAutocomplete.js\":\"0c8d850d7236d0ce\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d12221fcd6662005\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/actions.js\":\"0a44bc22de16c117\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/anchor.js\":\"28b8659996290f58\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/events.js\":\"5a0b69753151dc90\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/gestureActions.js\":\"065e22d64b8f9d47\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/index.js\":\"9f3075fee7fecbf4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"14a0eab15a48323d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/collect.js\":\"858a1cd01022e357\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/index.js\":\"b3411db43a227610\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/record.js\":\"1d4e12a7e389c326\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/RejectionDialog.js\":\"3b1f35c93c29be0c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/SystemStatusHeaderItem.js\":\"7165909caa6119b6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/index.js\":\"62678acfa0ecb63f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/model.js\":\"91742b4de6c515aa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/queueCounts.js\":\"b576a85fba3b92d7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/rejectedHelpers.js\":\"86f3657d0ff2f32d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/rematerializeAction.js\":\"27676ddcf96b8eb3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/useHysteresis.js\":\"da6e018d0a6d9212\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/ColumnHeaders.js\":\"955830443ef16eb0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/QueryUi.js\":\"c203ffc2e2d0ff23\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/TableLayout.js\":\"4fd1300e4081d415\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/actions.js\":\"63ed3bb84efeea77\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/cellEdits.js\":\"33969b93f65d93e4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/childrenViews.js\":\"e81658431eaad43f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/columns.js\":\"5ce80e22c1b0e234\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/controller.js\":\"43212e9fc0cdc69b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/convert.js\":\"7c00e3fcbbe1f275\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/dataExtension.js\":\"1f67cef450c8cdce\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/index.js\":\"81fd2838e6f0b7c8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/keys.js\":\"516315124c756862\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/model.js\":\"1aeab75d31d83824\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/QueryText.js\":\"7c366138b0a52ce6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/backfill.js\":\"779388ca705636f9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/completion.js\":\"5be8b73d6d57119c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/format.js\":\"54c8437ea2fe7e30\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/parse.js\":\"59483ae2ee3ede04\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/queryValue.js\":\"6e865dc5100bebae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/registrations.js\":\"9dc5096da5e1f032\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/source.js\":\"79581c25cdc10f6d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/registry.js\":\"16b85ce3323f847c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/rowGutter.js\":\"afb4da513bddc1bb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/rowVerbs.js\":\"f5e642bf5d7dc438\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/schema.js\":\"56dba0e6a7cf6be5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/sort.js\":\"3cd544072b926c5b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/effect.js\":\"9983e53df1e22c05\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/index.js\":\"88d9c926493977b5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/theme.js\":\"1f071a1371e29b07\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/actions.js\":\"2cd8639a6ee23780\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/dataExtension.js\":\"82618b5837594445\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/index.js\":\"5803d1024884e0eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/schema.js\":\"a163082a9f3659dc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f4786dc40462e721\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/actions.js\":\"47e142672f474c20\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/defaultItems.js\":\"245b2003c620a2b8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/facet.js\":\"d82539eed43939e2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/holdRecognizer.js\":\"28bcf7f01d976549\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/index.js\":\"647bba5a7408154f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/UpdateIndicator.js\":\"9586219014a672a9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/index.js\":\"7b7600860ef39f8e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/loadTimes.js\":\"b505144ecf4e0d1e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoNotesRenderer.js\":\"f422bb9067c5648c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoPlayerRenderer.js\":\"d012cdda4b4807ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoTimeStamp.js\":\"b955e33d383b993f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/actions.js\":\"6417827caff58305\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/index.js\":\"95742b205128a020\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/markdown.js\":\"83dc3babac83d9c7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/notes.js\":\"3e3b51e5ec880178\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/registry.js\":\"4b41c153e07aa367\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/remark-timestamps.js\":\"7093187d0c1f7b10\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/view.js\":\"049ad55f7f06843b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/LinkHints.js\":\"143ce47009210fbd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/index.js\":\"8cdd2a7a5686cf12\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/model.js\":\"b5faef03287496d4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/settings.js\":\"2f1850c0177f739b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/actions.js\":\"4aeac899e1577dac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/index.js\":\"2ba4f26cb2eb41c4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/interactions.js\":\"591b91bb8908d44c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/workspace-header/index.js\":\"180a7aa101622be1\",\"/knowledge-medium/pr-preview/pr-1904/src/registerServiceWorker.js\":\"4a5a968b55ff6d48\",\"/knowledge-medium/pr-preview/pr-1904/src/requestPersistentStorage.js\":\"7be4187e3bd0b874\",\"/knowledge-medium/pr-preview/pr-1904/src/services/authRequestDeadline.js\":\"3cd8f2c6e547306e\",\"/knowledge-medium/pr-preview/pr-1904/src/services/authStorage.js\":\"d40690fbe2051aed\",\"/knowledge-medium/pr-preview/pr-1904/src/services/powersync.js\":\"7e15cf178d4132c4\",\"/knowledge-medium/pr-preview/pr-1904/src/services/supabase.js\":\"26d5f04b3297856f\",\"/knowledge-medium/pr-preview/pr-1904/src/services/uploadErrorClassifier.js\":\"501a04c812613971\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/ActiveContexts.js\":\"3ffc4319f3461fd9\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/HotkeyReconciler.js\":\"8ca2bb02d9db9eaf\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/WipeLocalDataDialog.js\":\"91b13052376ad98f\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/actionDispatch.js\":\"ddf1f34583db1954\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/actionRefItems.js\":\"f304805504702e0c\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/applyKeybindingOverrides.js\":\"d9f963b0ece22574\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/blockActions.js\":\"f05cf2dd98bfacb8\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/blockMergeGesture.js\":\"3c18adf869d8365a\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/canonicalizeChord.js\":\"41e10b303c93508a\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/defaultContexts.js\":\"d8e380c010863a48\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/defaultShortcuts.js\":\"ef4e0e899d84e8fd\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/effectiveActions.js\":\"f75476141e9cb3a3\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/gestureAction.js\":\"2913f1904bfcfc75\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/gestureBinding.js\":\"959bbcf11fd69f64\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/holdRegistry.js\":\"0ecde775080225de\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/keybindingConflicts.js\":\"2921e53fdcf8be65\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/keybindingOverrides.js\":\"e0345efcde97caf9\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/pointerAction.js\":\"82ecc40f9bd7b9f3\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/resolve.js\":\"6edab600c1480dbb\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/runAction.js\":\"9fdedcf3521da108\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/sequenceMatcher.js\":\"cd36a29637c4181c\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/types.js\":\"55d74e8aaa88381e\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/useActionContext.js\":\"c335ce06d9e53b49\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/useActionDiscovery.js\":\"b113963f592853aa\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/utils.js\":\"667dc73d7d1f5354\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/bootStore.js\":\"6e6866dc1f614f75\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/previewDatabases.js\":\"2589fe9f61334ee9\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/byteTransform.js\":\"cc4989cda4136d2d\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/attachmentCleaner.js\":\"03b25893b967d9eb\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/attachmentParts.js\":\"ec81cb0c7302d5c9\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/bundleParts.js\":\"a3ef90a484717ff4\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/bundleRecord.js\":\"22da0c7113861156\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/manifest.js\":\"a27f127cf99d3c77\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/takeBundle.js\":\"8a237d746a93908b\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/verifyBundle.js\":\"8bac883a7e10fe18\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/cleaningStage.js\":\"8592a89c44c1ade1\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionKey.js\":\"2f3fa563ed4893a1\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionServer.js\":\"f0f858e08ad0bccd\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/flip.js\":\"1fa3456326510ff8\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/flipAttempts.js\":\"5762d2e261f83dc1\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/pages.js\":\"eb7babb261e27152\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/preflight.js\":\"9983bb6141ab9898\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/reseal.js\":\"8092e8408a924ba3\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/runConversion.js\":\"1edcac1405397d64\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/runLock.js\":\"e74cc5a1e4d9030d\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/sealing.js\":\"53163cc0bae93288\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/sealingStage.js\":\"153a2489bbb79172\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/stage.js\":\"e49b87675e137941\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/verifyReseal.js\":\"e9c0ba27106788aa\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/aad.js\":\"01ca595f050dddb1\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/aead.js\":\"cfe75419105250af\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/base32.js\":\"70a04a4ac516a112\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/base64url.js\":\"65a673217e43a838\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/binaryEnvelope.js\":\"a2eb3e71e1e300a0\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/byteAead.js\":\"f4443a0832e05a85\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/canary.js\":\"b1ac2d4d5adf833f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/contentHash.js\":\"34efbd5e601b03a2\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/contentKey.js\":\"5c4967cdcf5100e4\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/derivedIdNamespace.js\":\"5664202a293a1719\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/envelope.js\":\"f5776db0732f7ef3\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/hex.js\":\"9cc23a935bbbbb6a\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/sha256Hex.js\":\"80b23e8138c7307c\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/workspaceKey.js\":\"a677bf8877337532\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/conversionState.js\":\"43f3eaf524417251\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/createEncryptedWorkspace.js\":\"10d3fe3fb7feb1d9\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/pastedKey.js\":\"2da9fe2b01f7757b\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a825ce066bce647b\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/upgradeWorkspacePin.js\":\"9806716e1d9b6c0d\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/keyStore.js\":\"31194f60da0db699\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/mintWorkspaceKey.js\":\"f6ee42c05625020f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/modePin.js\":\"72f090f50eec66d0\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/openWorkspaceKeys.js\":\"247c483907351ce9\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/resolveWorkspaceEntry.js\":\"32e95dcbde4c4764\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/resolver.js\":\"865f79a932da9c30\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/workspaceAccess.js\":\"d64f3ec4118f2d96\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/transform.js\":\"be92d03c1f0a1577\",\"/knowledge-medium/pr-preview/pr-1904/src/themeBootDefaults.js\":\"ba11c512d6c28c55\",\"/knowledge-medium/pr-preview/pr-1904/src/types.js\":\"9595e8944e32b297\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/ClientLocalSettings.js\":\"85e3b4badfb1cac7\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/abortableSleep.js\":\"0ffaad25bd2256a4\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/array.js\":\"2f2ca5c6b5e48c38\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/backlinkAutocomplete.js\":\"32ec708364223300\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/blockCrumbs.js\":\"9d9ac981296fe1fc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/blockrefAutocomplete.js\":\"1a7a5c72226bcf7b\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/cadencedIdleJob.js\":\"e4555d22edb40684\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/callbackSet.js\":\"16cffeec34c2da27\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/clientId.js\":\"893d842eff89e2c8\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/codemirror.js\":\"5983a6b986289912\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/codemirrorCompletion.js\":\"1441cfc4331ef09d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/copy.js\":\"1e0932bceaff6a9c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dailyPage.js\":\"4d2e0ffbfe1d2373\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dbForensics.js\":\"e3444a1bbcbc1c15\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dbForensicsHooks.js\":\"e66d2cd6d89fd77b\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/deleteBlockThroughUi.js\":\"f38621f138b60f49\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dialogs.js\":\"957ea7d375063325\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dom.js\":\"e6420fed1a08e601\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/downloadBlob.js\":\"61f4a049e2c5fbac\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/drawnWalk.js\":\"82b50912e23b5bc1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/exportSqliteDb.js\":\"f7b6bd7a0a8d6459\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fileSystemAccess.js\":\"b511ed4a9918cffc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/flipSlide.js\":\"40e439ee7a802fd9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fnv1a.js\":\"db69d12326ae7cc7\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/formatBytes.js\":\"40a1f4d4dbf89373\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fuzzyRank.js\":\"d0ed4d21e590fcb1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/idbKeyedStore.js\":\"56ce968710e66800\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/idleCallbackPolyfill.js\":\"ccfa69fe9761f607\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/keyboardAwareScroll.js\":\"b3079a12f9e3a262\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/keyboardViewport.js\":\"c57ff5ee5b6b0015\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/lastWorkspace.js\":\"7489444d55433cd1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutColumns.js\":\"e5e5499bbe25a2d0\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutSessionDom.js\":\"a7fac46f858a1c53\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutSessionId.js\":\"3a822cad510678f2\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/linkClickGestures.js\":\"28ff9d58f34df113\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/linkTargetAutocomplete.js\":\"5f5f952aab48b89c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/localDbCorruption.js\":\"cfb9a142f30bcf65\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/localDbRecovery.js\":\"ac5eaa6e4dbf2bc5\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/markdownParser.js\":\"9f079de27a9b064d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/memoize.js\":\"facbe3156c6b9c90\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/nameFieldCommit.js\":\"69ea925d9166cc3e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/nameList.js\":\"80cf625c1be30a46\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/navigation.js\":\"0533573596761792\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/omnilinerNamespace.js\":\"e710bde65d95df13\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/opfsPageScan.js\":\"aa4eba2dc67a0c52\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelClearance.js\":\"df4647626ec23091\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelHistory.js\":\"59dfacc299820148\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelLanes.js\":\"04321715e31acd4c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelLayoutProjection.js\":\"de85233ab5b4bd00\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelScrollAnchor.js\":\"45b516a6695106da\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelUrlFlags.js\":\"2c842f758ccf445c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/platform.js\":\"d0675b2314090525\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/pluralize.js\":\"8daa950368dd9902\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyCreation.js\":\"8db69b48bfb6f7f2\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyNavigation.js\":\"03ed87c6c64ad047\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyValueContext.js\":\"cd3783b11501cfe0\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/react.js\":\"cc87bfe5745c00f0\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/relativeDate.js\":\"668722c79fcc09af\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/relativeTime.js\":\"61ceddb8749918aa\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/renderScope.js\":\"8db36b70c2b652f1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/resolvedThenable.js\":\"943d049e65abc033\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/routing.js\":\"52db902ede997dc8\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/safeMode.js\":\"59021f3e91eb3a88\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/scheduleIdle.js\":\"718900d60f395f63\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/screenWakeLock.js\":\"4a3ce2477cb65697\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/selection.js\":\"70d91e3c407b9087\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/softKeyboardGrab.js\":\"fe874adf07d7dbb3\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/startupTimeline.js\":\"a850f1552b9acb32\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/state.js\":\"0f429b0dc094f834\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/string.js\":\"9785a0f3d08d23fb\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/surfaceZoom.js\":\"f73f425c1dbe3695\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/time.js\":\"907460591a253b27\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/toast.js\":\"ee8c60c4ab3e3196\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/toggleStore.js\":\"952a1dfafdaa558e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/untilStopped.js\":\"ca2703226093f366\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/userActivity.js\":\"035b0c5741a2029b\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/viewTransition.js\":\"5c7c1ccbe5cd440b\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/viewport.js\":\"361c64df93525e98\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/webLock.js\":\"8e1befe679de96c2\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/workspaceRecovery.js\":\"b49fb064d3de3be6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/workspaceSnapshotStore.js\":\"1590ebd8fc8bf0ba\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-compiler-runtime.js\":\"d8020aa8e81f2abb\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-client.js\":\"e2be60d871a4e627\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-server-edge.js\":\"cf89573b81299c9b\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-server.js\":\"0ea713f99172af03\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-static-edge.js\":\"6ca7fcebe7bdd015\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-static.js\":\"d77af466c6fe78ac\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-test-utils.js\":\"b7f35778f657cf3c\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom.js\":\"1af9dea889901383\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-jsx-runtime.js\":\"1c562d9ee2229c34\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react.js\":\"1584af0345b6d206\",\"/knowledge-medium/pr-preview/pr-1904/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1904/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1904/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
