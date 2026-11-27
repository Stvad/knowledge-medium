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
		buildId: "ed8f7351be93-cc62a3a3",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/\":\"496be49555b1c5fd\",\"/knowledge-medium/pr-preview/pr-1904/index.html\":\"496be49555b1c5fd\",\"/knowledge-medium/pr-preview/pr-1904/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1904/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1904/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1904/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1904/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1904/assets/FacadeVFS-BRQpqnC7.js\":\"891ebefe2dd6f73a\",\"/knowledge-medium/pr-preview/pr-1904/assets/OPFSCoopSyncVFS-DMyQDWdY.js\":\"86e4b1b2b1685b21\",\"/knowledge-medium/pr-preview/pr-1904/assets/OPFSWriteAheadVFS-k-M70Pwl.js\":\"eb585f25ac433d89\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-C0HcraJs.js\":\"86aa477d7fa26ed0\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-async-Fz6hWTwQ.js\":\"b9eb189c33a992bf\",\"/knowledge-medium/pr-preview/pr-1904/assets/worker--hK6-iBI.js\":\"a8493596f780837a\",\"/knowledge-medium/pr-preview/pr-1904/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1904/chunks/app-BR_olI5D.js\":\"5608bbccb8e21985\",\"/knowledge-medium/pr-preview/pr-1904/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1904/index.js\":\"3d447e2854a02c93\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1904/assets/AccessHandlePoolVFS-BrTCvkYR.js\":\"691b9b6e34e4c6fb\",\"/knowledge-medium/pr-preview/pr-1904/assets/IDBBatchAtomicVFS-xu9p-z6c.js\":\"0bb34832b79a4ba2\",\"/knowledge-medium/pr-preview/pr-1904/assets/MemoryVFS-ClNzB9Vo.js\":\"6ca89a2ce16db9ec\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-B1ZvrQ6z.js\":\"d2e9ceb833f79291\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-async-pk0cuaze.js\":\"9c6c8a2e595ff098\",\"/knowledge-medium/pr-preview/pr-1904/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1904/chunks/AccessHandlePoolVFS-zKIK6LLL.js\":\"74d9458a50b35a7c\",\"/knowledge-medium/pr-preview/pr-1904/chunks/FacadeVFS-C7KeoD_l.js\":\"9aed0aba6f189fef\",\"/knowledge-medium/pr-preview/pr-1904/chunks/IDBBatchAtomicVFS-B-baJmfp.js\":\"6c5715b2cf579bdc\",\"/knowledge-medium/pr-preview/pr-1904/chunks/MemoryVFS-BvE3U5HU.js\":\"f54bb300d6efc99d\",\"/knowledge-medium/pr-preview/pr-1904/chunks/OPFSCoopSyncVFS-BFd3y42P.js\":\"c56fac7be74424df\",\"/knowledge-medium/pr-preview/pr-1904/chunks/OPFSWriteAheadVFS-DBgp5rCX.js\":\"518706cd01507f19\",\"/knowledge-medium/pr-preview/pr-1904/chunks/Preview-Dz7bYgtx.js\":\"545310b51a738228\",\"/knowledge-medium/pr-preview/pr-1904/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1904/chunks/card-CUtPG_Pd.js\":\"8c7dd68dc9947090\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-oLUablAT.js\":\"0375d660afb91204\",\"/knowledge-medium/pr-preview/pr-1904/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1904/chunks/mc-wa-sqlite-CHQXI_ug.js\":\"3cebfac3cd38c1f1\",\"/knowledge-medium/pr-preview/pr-1904/chunks/mc-wa-sqlite-async-DGCIhIJG.js\":\"b63aa4ddce172a8f\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-5NKnidjR.js\":\"078b04629c057273\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-BPFekSJW.js\":\"9a2fd4c27cd8e02a\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-CXAIVdn5.js\":\"96905e838ba9a5cc\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-CkVFnIg7.js\":\"1a713c6f213c1ddc\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-DMc6H96X.js\":\"d9e347ab7a503142\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-DcXGDNOX.js\":\"4f64d9edbe53f990\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-DvsjHMww.js\":\"01f5a4f19479e8bd\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-JYph4dz5.js\":\"0c0c20cf590eff37\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server-legacy.browser.production-CNQqxFrK.js\":\"c7838ca7b3e52c05\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server.browser.production-mknwMpkb.js\":\"c91e31ada04b1252\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server.edge.production-BmGx_25B.js\":\"e6ed5eba28986fcf\",\"/knowledge-medium/pr-preview/pr-1904/chunks/server.browser-5KdD3NXA.js\":\"35cd47815908648d\",\"/knowledge-medium/pr-preview/pr-1904/chunks/textarea-kEfEYkeh.js\":\"cab0878020d04a62\",\"/knowledge-medium/pr-preview/pr-1904/chunks/ui-bkMjUBA4.js\":\"7ad3a8b62a64eea1\",\"/knowledge-medium/pr-preview/pr-1904/chunks/wa-sqlite-D7BuUaaA.js\":\"cf882e46564c3495\",\"/knowledge-medium/pr-preview/pr-1904/chunks/wa-sqlite-async-D9DWlblA.js\":\"716c106f748a0b7a\",\"/knowledge-medium/pr-preview/pr-1904/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1904/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1904/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1904/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1904/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1904/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1904/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1904/src/App.js\":\"2553924feebf8154\",\"/knowledge-medium/pr-preview/pr-1904/src/appUpdate.js\":\"3c22eb368562bdc2\",\"/knowledge-medium/pr-preview/pr-1904/src/appVersion.js\":\"df640606c33119ea\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/initialLayout.js\":\"692e9d16772817d0\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/openWorkspaceData.js\":\"ac91a7a8edfd4233\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/resolveWorkspace.js\":\"bf076188d6c70b3c\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/workspaceBootstrap.js\":\"f433cc5bfd0c7fa5\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockComponent.js\":\"b1c095e966efbac6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockCrumbs.js\":\"5885cc7becd41fb6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockEditor.js\":\"eac2586b352d5dfd\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockLoadingPlaceholder.js\":\"5559a58314544dd6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockProperties.js\":\"44b79f62806be185\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockSearchPicker.js\":\"2c91d67c9ff1277c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ConfirmBulkDeleteDialog.js\":\"8d5a8bffda6287d0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/DividerHandle.js\":\"9c5eacf142acd931\",\"/knowledge-medium/pr-preview/pr-1904/src/components/DraftEditor.js\":\"ed65082d6aabd81a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/GutterPill.js\":\"226062e34db067f0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/Header.js\":\"15763a5994952e4a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/LazyBlockComponent.js\":\"bbca913f672ceb5f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/Login.js\":\"e6d5ff74c537b304\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ZoomableSurface.js\":\"7bc85cea2bb33ff2\",\"/knowledge-medium/pr-preview/pr-1904/src/components/editModeKeepalive.js\":\"8e2b4d92f6a8e4a8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyDisplay/PropertyDisplayScope.js\":\"3a055ac61d8e4979\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"950aa4333a7ab085\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/RefPropertyEditor.js\":\"9605670bdd8d6ced\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/RefTargetTypePicker.js\":\"3489bba4c7d4b67e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/SelectPropertyEditor.js\":\"ab39c6839428b34d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/TypesPropertyEditor.js\":\"487823ea721cad36\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/defaults.js\":\"92e8f7f55ed37166\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/kernelValuePresets.js\":\"aab4844ca61f1987\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/selectablePresets.js\":\"3f3537e73db6c059\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/typesPropertyUi.js\":\"1175a660d531639c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/AddPropertyForm.js\":\"7b04e940a97936a7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/PropertyPicker.js\":\"6c62628b3344e134\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/PropertyRow.js\":\"54c0802057a282a3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/Rows.js\":\"a1d166cdc8339871\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/actions.js\":\"e5f352eb88588ac1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/declarationOnly.js\":\"99caf3958fd92671\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/layout.js\":\"0b4a5104b4510887\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/model.js\":\"08a6d0da8e6282c8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/shapeUi.js\":\"6b69aea05b4b0206\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/shapes.js\":\"377018ac9b288265\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/usePropertyEditingActivation.js\":\"6e2bf168316611e3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/visibility.js\":\"68c1c8a115115b60\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanelSections.js\":\"f82dad5ed1fcf13a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockEmbed.js\":\"0661d1084413f37e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockLink.js\":\"c578f8f37de4de0d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockRef.js\":\"3a82d74474ad5445\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/CompactReferenceLink.js\":\"47e63bdac70eb598\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/ReferenceLink.js\":\"9eb827c4cb2635b4\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/cycleGuard.js\":\"e4ee4e00c5250c25\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/cycleGuardContext.js\":\"ded29fe6bfaa3db9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/linkInteraction.js\":\"bc106112f6f07205\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/referenceLayout.js\":\"636da9780a49bddb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/useBlockRefAncestors.js\":\"73d4fd58b6550db1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockGutter.js\":\"9c83e7a08ed76c4f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockInfoDialog.js\":\"37c6c7e21c073b09\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockReadText.js\":\"7abc806f5190ec08\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockTypeBlockRenderer.js\":\"448ee2d702a97c47\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BulletHoverCard.js\":\"6da4cee535616e0e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/CodeMirrorContentRenderer.js\":\"a422e5bdbb19cc95\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"023318d7da35c16e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/ColumnResizeHandles.js\":\"756be22e369119af\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"3672e6fce4d308d7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/DefaultBlockRenderer.js\":\"2b2354f59376103b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/LayoutRenderer.js\":\"4ea86e07aa9d6e2a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/MarkdownContentRenderer.js\":\"d19d469fd5521476\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/MissingDataRenderer.js\":\"83b306c3d75e5370\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/PanelRenderer.js\":\"2b0fb3b760c30689\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/PropertySchemaBlockRenderer.js\":\"7d732be4cf86ea9e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/TopLevelRenderer.js\":\"025b58eea86a8186\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/blockGutterMode.js\":\"920eeb5e8e38bae2\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/blockTitleText.js\":\"c3217f4ead61151a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/fieldCreationKeydown.js\":\"57f2350c8ec92c0f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/layoutRootContext.js\":\"a3af470f757c4d57\",\"/knowledge-medium/pr-preview/pr-1904/src/components/typeChip/TypeChip.js\":\"9e9929ca8ce2d5f6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/typeChip/chipStyle.js\":\"c7533ee8db376829\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/anchored-floating.js\":\"570b5e1080887a8c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/button.js\":\"43bdccd03c0ab963\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/card.js\":\"84c2b87c22b3bf6d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/checkbox.js\":\"5ea00b5db8651995\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/collapsible.js\":\"58c0238975461927\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/command.js\":\"54c8a085e85eaaf5\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/context-menu.js\":\"a25c11343123ba59\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/dialog.js\":\"20b7adf94cc726be\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/dropdown-menu.js\":\"e38be07ad4c3a8bb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/floating-listbox.js\":\"6554601554c99ac1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/index.js\":\"4b2ad93966a9abb0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/input.js\":\"05648bf419408496\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/kbd.js\":\"8ad1c36e38e7f065\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/label.js\":\"3dcce460c8fb7e07\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/textarea.js\":\"c588b04ad3fc78cf\",\"/knowledge-medium/pr-preview/pr-1904/src/components/useEditModeYieldKeepalive.js\":\"0060da397b972039\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/BootFallback.js\":\"0753d3e73d922c5f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/FocusedRowLazyMount.js\":\"3956fb91de19e183\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/LazyViewportMount.js\":\"35344fc703dcfb73\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/LocalDbCorruptionFallback.js\":\"5a333eb7cc58c569\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/error.js\":\"e3df2e7c4375edc6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/lazyMountRegistry.js\":\"1e9ded2271eae83f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/suspense.js\":\"a257e65c76477ad3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/CreateWorkspaceDialog.js\":\"62d36e91ebc2a6ed\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/PendingInvitations.js\":\"889a772c45700f7c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/SyncProgress.js\":\"d7c8a2cc379f33f7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/UnlockProgress.js\":\"5e151cbf4da78d97\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceKeyGate.js\":\"0c8bfdf9b5d65f03\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSettingsDialog.js\":\"89c92a4546347eaa\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSwitcher.js\":\"e22ce118820a2c75\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSyncGate.js\":\"d36486247ec867b8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/ConversionFlow.js\":\"f2f246d5f0b962bb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/ConversionFlowHost.js\":\"fc6eef4870c868b8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/EncryptionSection.js\":\"c90b49bdc873463c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/attachmentPrompts.js\":\"a9f0c052d6ca9b95\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b32347f0fb8e4995\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/conversionFlowDeps.js\":\"ea193edd4126d49b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/conversionFlowStore.js\":\"c10abba13a824607\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/flowUi.js\":\"babd6354efcc4e4f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/useConversionRun.js\":\"66172a2fe7c34a47\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/keyUi.js\":\"f8179d4019164073\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/useCloseOnKeyLoss.js\":\"b1139718d29b4afe\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/useCloseOnServerE2ee.js\":\"d40793036d4540db\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/workspaceUnlocked.js\":\"692a08b60a77a421\",\"/knowledge-medium/pr-preview/pr-1904/src/context/backgroundSubtree.js\":\"ae90d6ba59ebd09a\",\"/knowledge-medium/pr-preview/pr-1904/src/context/block.js\":\"c3bdc4ab86c82445\",\"/knowledge-medium/pr-preview/pr-1904/src/context/layoutWsContext.js\":\"d942f0d1c3766d3b\",\"/knowledge-medium/pr-preview/pr-1904/src/context/propertyDisplay.js\":\"fac2a6c65459d7c1\",\"/knowledge-medium/pr-preview/pr-1904/src/context/repo.js\":\"d401c28cc389e5fc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/aliasClaim.js\":\"99235d41d738f19a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/aliasSeatNamespace.js\":\"fa2bc2188c05defd\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/blockData.js\":\"5377c7a0a392fb9c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/blockType.js\":\"30e151f68976776c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/changeScope.js\":\"ef7ab9baf8370c4c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/codecs.js\":\"02519f1e2695c3c9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/derivedData.js\":\"e9350f7e4bda5eb3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/errors.js\":\"6b2b9188fe0c9f9e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/events.js\":\"a719f3d7e5297338\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/handle.js\":\"9b10f7506f9ea411\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/index.js\":\"5c23cac9a229341f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/mutator.js\":\"2c1896c27725a488\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/processor.js\":\"48269a0f2aace087\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/propertySchema.js\":\"adca8ded1506d235\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/query.js\":\"75f818ce7c39b4e4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/sameTxProcessor.js\":\"f6578ad9e01abd1b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/schema.js\":\"9b10f7506f9ea411\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/tx.js\":\"9b10f7506f9ea411\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/typedBlockQuery.js\":\"f74afd29f7c104e5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/user.js\":\"b648253c372ce938\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/valuePresetCore.js\":\"65ea10fd9b92d2f4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/valuePresets.js\":\"ba45d66ccc7201fb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/attachmentCleanerIOVerb.js\":\"b98b78372d2c26a6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/block.js\":\"79f53744a78d048f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockCache.js\":\"eb8c4d55cbf678cb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockId.js\":\"cbb263d88441b28d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockLiveness.js\":\"de1fe07b57f39b10\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockMerge.js\":\"7d10a491f4086ee6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockSchema.js\":\"ae5ca66b3546b1af\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockTypeLookup.js\":\"96f35474e6958f59\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockTypes.js\":\"aaff7dbbf1c14705\",\"/knowledge-medium/pr-preview/pr-1904/src/data/childrenView.js\":\"a0d5e7d2bbb26727\",\"/knowledge-medium/pr-preview/pr-1904/src/data/clientContext.js\":\"214857c524ec29d6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/dbFileSiblings.js\":\"2589020ee6dc78bd\",\"/knowledge-medium/pr-preview/pr-1904/src/data/definitionSeeds.js\":\"24bc24372183bcde\",\"/knowledge-medium/pr-preview/pr-1904/src/data/derivedIds.js\":\"152a4a869ccd813c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/drawnSubtree.js\":\"b9d82916446cd06c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/facetBridge.js\":\"05ce57f158237b75\",\"/knowledge-medium/pr-preview/pr-1904/src/data/facets.js\":\"77ae7d1ee7670b6b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/globalState.js\":\"d5154a9e7ad440f1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/aliasClaimRederiveProcessor.js\":\"37893abe4008274f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/ancestorBatch.js\":\"a5daa28960b9683b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/blockTypeTypeifyProcessor.js\":\"610991f835c789ab\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/clientSchema.js\":\"895dbb2aaf1db225\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/commitPipeline.js\":\"7a5484d4f9eec32d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/devAssertions.js\":\"4e155b565a9a1557\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/firstSync.js\":\"5eedc4f35e6c69a5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/freshInitialLoad.js\":\"600a94dcae24acf9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/graphBackfillClaim.js\":\"c9aa8cab1b60b54a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/handleStore.js\":\"5120dae6673d3536\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/idleMarkerJobs.js\":\"372d46340d9904ea\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/initialDownload.js\":\"c09403024008ec61\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/initializeClientDatabase.js\":\"6fc5db2fe54e8c03\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/jsonCanonical.js\":\"39dd02cb0cff5ccf\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelInvalidation.js\":\"82c3740a5c081fae\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelProcessors.js\":\"685fead0f1674e37\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelQueries.js\":\"3723b4095de39b02\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/mergeTypeMembershipProcessor.js\":\"bd0f805ce49b0266\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/normalizeReferencesProcessor.js\":\"38e23ce665ccc7bd\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/poolInstrumentation.js\":\"b6b08821980749d0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/processorRunner.js\":\"c00fbce5fab555e5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyCellBackfill.js\":\"79a4b21c2993c463\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyChildMint.js\":\"7f46c52ad50ffd76\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyChildrenProcessor.js\":\"71c0a545ad1518ff\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3ff8244b373e11e5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyDefinitionSynthesis.js\":\"0a0d772773f8bfde\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyKeyScan.js\":\"5fd0fd92a535d54b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertySchemaResolution.js\":\"248ae38118da0bbb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyValueEdits.js\":\"70f4d9e022e4a584\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/raiseProtocol.js\":\"92844cb9f30100e1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/readBatch.js\":\"d7c8714a6218a16a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/refProjection.js\":\"62e98c455bb2b7f7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/referenceTargetLookups.js\":\"2f68daa52b955368\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/referenceTargetProcessor.js\":\"cef464d4c73d8ccb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/replayMerge.js\":\"ae063ea6bc43eb73\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/sqlBinds.js\":\"31d5687dd228a0a8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"3a3e093312fa1248\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/arrivalProcessors.js\":\"814b5e2d9a7806f4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/invalidate.js\":\"18f164cb087d36a0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/materialize.js\":\"49820be634a9afa3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/observer.js\":\"04cf640c90c78938\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/reconcile.js\":\"61636dc864b1251f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/timingMetrics.js\":\"ceed35241ed4f62b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/treeQueries.js\":\"18e96623973623dc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/txEngine.js\":\"79f534b2894064bb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/txSnapshots.js\":\"b1818913b9e7dcce\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/typedBlockQuery.js\":\"c563f8a30bdb9939\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/undoManager.js\":\"44e224d0a560ba4c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/invalidation.js\":\"0958457d3b9d8a0a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelDataExtension.js\":\"4cefd5944c5fe1bf\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelPage.js\":\"d1ea8fbd8459147f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelValuePresetCores.js\":\"c5757e39c435c501\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbCorruptionSignal.js\":\"e2b23e1310b23b27\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbStorage.js\":\"639bba5a694199f9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbVfs.js\":\"a1d1fc228bf9e583\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localSchema.js\":\"d8d84a63a11a59e7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/maintenance.js\":\"96b1b510e861bad1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/mergeProperties.js\":\"6fee494d6bdff22d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/metricsConsoleHook.js\":\"362411943395ad5a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/migrationsPage.js\":\"102e655142ba9402\",\"/knowledge-medium/pr-preview/pr-1904/src/data/mutators.js\":\"6f2a162c82b481ba\",\"/knowledge-medium/pr-preview/pr-1904/src/data/orderKey.js\":\"415f9411f9de212c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/orderKeyPlacement.js\":\"bb0cd0c82b1d27c0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/outlineSurface.js\":\"4885e9756b566ef7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pendingEditorContent.js\":\"d1c821ccf1d2e32f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pendingUploadsSql.js\":\"30d7585c40867acc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pluginStateExtensions.js\":\"7054575c0faad291\",\"/knowledge-medium/pr-preview/pr-1904/src/data/powerSyncLogger.js\":\"11c68a1f77343f94\",\"/knowledge-medium/pr-preview/pr-1904/src/data/projectorRuntime.js\":\"676be2436c65a550\",\"/knowledge-medium/pr-preview/pr-1904/src/data/properties.js\":\"c5efef94bacaa5c2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertiesPage.js\":\"0fc93312953664ba\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyChildren.js\":\"2cdb4e6807619cc4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionFanout.js\":\"132adecc3e5ddafc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionMetadata.js\":\"7e31f5dd2db60e0a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionRegistry.js\":\"7c2371a624dfb838\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDisplayMode.js\":\"f7a3cd969f2e3774\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyRowCreation.js\":\"57f616174fb69752\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertySchemaCreation.js\":\"fb1b6fb8bc5ad197\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertySeeds.js\":\"b2609d3a3388d796\",\"/knowledge-medium/pr-preview/pr-1904/src/data/recentsPage.js\":\"34b12f7a05e8fb80\",\"/knowledge-medium/pr-preview/pr-1904/src/data/refTargetComparableProperty.js\":\"0e3603d62ff0b2c4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/referenceBlock.js\":\"338fbb3eb6e6634f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/rejectedUploads.js\":\"76bbf65be315323f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/releasePowerSyncConnection.js\":\"c75ef67b7e1b7c73\",\"/knowledge-medium/pr-preview/pr-1904/src/data/repo.js\":\"9918fafcb12ba66e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/repoProvider.js\":\"dcf959c58e599e77\",\"/knowledge-medium/pr-preview/pr-1904/src/data/rowProperty.js\":\"7fc861c1cc635195\",\"/knowledge-medium/pr-preview/pr-1904/src/data/searchFilter.js\":\"f5350fdc6f91fd9f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/seedIdentityLedger.js\":\"f1bc4883f3a24021\",\"/knowledge-medium/pr-preview/pr-1904/src/data/stateBlocks.js\":\"f07ba3d53d4a01fb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/structuralEditPolicy.js\":\"cb33f5bff8089a20\",\"/knowledge-medium/pr-preview/pr-1904/src/data/structuralInsert.js\":\"638405758d8d9929\",\"/knowledge-medium/pr-preview/pr-1904/src/data/subtreeDelete.js\":\"9a961ca1e8f12634\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncStreamLock.js\":\"3d7ee133a1686631\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncedTableSqlRecognizer.js\":\"7a4f8f0632f79001\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncedTableWriteGuard.js\":\"6f3fcf4b607f6da1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/targets.js\":\"d6f9adcd7b4be827\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeColors.js\":\"b2e9506633283880\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeDefinitionMetadata.js\":\"3df01c36c7061860\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeDefinitionRegistry.js\":\"99527eb435f9682d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeExtraction.js\":\"78a1645a490cf201\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeInitialValues.js\":\"c275736c6d9209e6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typePropertyGroups.js\":\"37f2e51377449de9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeSeeds.js\":\"5adfe6307e16af71\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeTagger.js\":\"8190dae26d219de0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typedRecords.js\":\"b09627173fb46128\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typesPage.js\":\"f5ddf86f9b04c031\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userPrefs.js\":\"d9cc25dd048684dd\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userSchemasService.js\":\"2e587b84c90f9a8a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userTypesService.js\":\"7b74fee144e3fd59\",\"/knowledge-medium/pr-preview/pr-1904/src/data/valuePresetRegistry.js\":\"360c6c4d909e477f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/visibleChildren.js\":\"76f3239f316c5317\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceConversion.js\":\"17c7ce29bc472e3e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceFirstSync.js\":\"f3184819b3552504\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceIdNamespace.js\":\"fad7dca1c3c8ad44\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceSchema.js\":\"2acc9e0a367cd391\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaces.js\":\"4cbb9d92efef1351\",\"/knowledge-medium/pr-preview/pr-1904/src/data/writeAheadLog.js\":\"208b287178c5f34b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/BlockPasteShellDecorator.js\":\"7a9c3f63706820f0\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/atTrigger.js\":\"6e799bc82a043bb9\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/autocomplete.js\":\"420ba7a4ea40ab55\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/codeMirrorExtensions.js\":\"e25974344eb6ee96\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/contentFlush.js\":\"362a0eb48ff46fa4\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/defaultInteractions.js\":\"80806567c65163c7\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/editSettleSignal.js\":\"3f50ce8bdc1ef671\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/insertImage.js\":\"5524bb0f7766490f\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/referenceCompletionRange.js\":\"9641297d04f9868c\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/referenceTargetTypes.js\":\"15aec1917fc6de11\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/syntaxContext.js\":\"f7a23187bc0951b8\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/triggerMatch.js\":\"9a553ff95fa2e434\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/AppRuntimeProvider.js\":\"c31f8ed31b06518c\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/BlockFocusShellDecorator.js\":\"9f8ee51cf8104814\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/ExtensionRenderBoundary.js\":\"9d36c94480dfa058\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/PanelContentRecovery.js\":\"98e426c4d9b76709\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/apiCatalog.js\":\"f940d1d66a50db7e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/approveExtensionHere.js\":\"9b4e7591e85b1f57\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/armedCutAppMount.js\":\"62c389bae1f072f0\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/batchableKeyedStore.js\":\"eb99fba4618e9c64\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/blockInteraction.js\":\"3ee1a1057a13ad9e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/blockSelectionAction.js\":\"803a5fb2c9bb0610\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/compileExtensionModule.js\":\"4e96e63cade12f10\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/compiledModuleCache.js\":\"7c58cb53d6943a8e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/continuousGestures.js\":\"b26209956ef8269e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/core.js\":\"d33356c2aeeacbaf\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/defaultRenderers.js\":\"18f3fb3f3e98e138\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/definitionFanoutAppMount.js\":\"4eacf9a40fbe6368\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dialogAppMount.js\":\"48338397a574d6db\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dynamicExtensionSeeds.js\":\"a2d3cadcf4f3e536\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dynamicExtensions.js\":\"e1fd765a5bcd3d2c\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/exampleExtensions.js\":\"216669c60590b5fd\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionApprovalStatus.js\":\"3e332f34a2be0e99\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLoadErrorToast.js\":\"6dfff996287bf658\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLoadErrors.js\":\"7ca8e171ea87e72d\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLookup.js\":\"cea9392a16a8dc65\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionToggles.js\":\"87e3360e6b4b6454\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionUtilitiesCss.js\":\"7c373cf62e728b6e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/kernelPageDeletionGuard.js\":\"03c5cc511e1735b2\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/liveRuntime.js\":\"fdaa2504020680f3\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/openExtensionsSettings.js\":\"f267976d95b66dd2\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/overridesCache.js\":\"3d1dd72e0cfe878b\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/pluginIds.js\":\"1116263d18c17b19\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/processorRejectionToast.js\":\"e39cb762e861c7f5\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/runtimeActions.js\":\"c42b6b0a944592ef\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/runtimeContext.js\":\"a41e90c9db80fd85\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/staticAppExtensions.js\":\"284a38099879ab3c\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/staticDataExtensions.js\":\"009908b4d024f127\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/toastAppMount.js\":\"b5bccee7c9759d6e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/useOverrides.js\":\"6113e047a46f9d45\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/useShortcutSurfaceActivations.js\":\"45843741376c35ca\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/discoverToggleTree.js\":\"f129a76938e835aa\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/facet.js\":\"f38ee001214d9b8f\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/resolveAppRuntime.js\":\"00be7742fabbddfb\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/runtimeEvents.js\":\"3a0a0cc261ffca06\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/togglable.js\":\"120543638b23fa8e\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/variantFacet.js\":\"3cbdc4cd888bd75d\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/verbFacet.js\":\"a6acd6d6e3027514\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/block.js\":\"43f58d3d2dfa4782\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/focusedChild.js\":\"753995cb9fd04745\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/propertySchemas.js\":\"f1be758fe5f5dfb8\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/typeRegistry.js\":\"3e54b2bba607fda1\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useAncestorCrumbs.js\":\"289158b9a64781ca\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useAutocompleteListbox.js\":\"16acc8ee70b26d9a\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useDebouncedSearch.js\":\"372bba70f2738166\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useDebouncedValue.js\":\"4ead7a8ceb7f7286\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useFacetValue.js\":\"b7bc9718f007e234\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useIsFocalRender.js\":\"7de3f7127c02781b\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useIsReadOnly.js\":\"518a929a233d3e59\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useMaterializeBacklog.js\":\"4c0adc6299c5cd6a\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useMinuteClock.js\":\"46316a03662d1637\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/usePanelLayoutProjection.js\":\"bd4834596f4b0ce1\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/usePendingInvitations.js\":\"68806b21d573755f\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useRendererRegistry.js\":\"950949d02f9437bf\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useRetainedFieldRows.js\":\"bc9e65f73a94bd9c\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useWorkspaces.js\":\"7eec560f5ae77e11\",\"/knowledge-medium/pr-preview/pr-1904/src/lib/utils.js\":\"0289bb524ef74836\",\"/knowledge-medium/pr-preview/pr-1904/src/main.js\":\"2ea9c0d7efc0eaf8\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/MarkdownImage.js\":\"660ebeabc055b852\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/blockSeparators.js\":\"15abf5283d05e138\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/context.js\":\"b9f75a2ebad4a4d8\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/defaultMarkdownExtension.js\":\"4c7c34ebee47e254\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/extensions.js\":\"ef7db147a8494229\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/renderMarkdownHtml.js\":\"4df2724573555e0f\",\"/knowledge-medium/pr-preview/pr-1904/src/minimal-editor.js\":\"763e3c5e8afb037b\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/armedCut.js\":\"c69c0791fef7e9d1\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/captureMediaVerb.js\":\"39f1c70a578e1ad2\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/clipboard.js\":\"16d82673bbf42639\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/decision.js\":\"5e96c53f0c89dade\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/operations.js\":\"da7ef05190515d55\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/account-header/AccountHeaderItem.js\":\"59c2c3824afd213f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/account-header/index.js\":\"6e8ae9361f8f5fef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"cb7e77e48e7577c9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/askAgent.js\":\"d6b2cc3ac3410ad4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/askedStore.js\":\"946ab8efb4480871\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0ff3a2e8fd1912ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/chipState.js\":\"234ec4b2f9e2b045\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/dataExtension.js\":\"80a5687caf77a957\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/index.js\":\"54c5238fb5756f21\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"58a78ef895ab8f6d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/schema.js\":\"16621384116808b9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ebebaf15a86c3f0b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/BridgePairingDialog.js\":\"ec0506c4f62fa479\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/addMedia.js\":\"783c780c7d18bb1e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/backlinks.js\":\"324528976c72f26d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/block.js\":\"7bea490fc96811a6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/context.js\":\"46604272c8994a44\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a97858d6c1141674\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/index.js\":\"9fb7447b0a1ccda7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/outline.js\":\"1abc3670fdb7d8ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/properties.js\":\"48b1a9fb5c8c742b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/refs.js\":\"2036a5f677df0e35\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"58b8aef2e66b6418\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/search.js\":\"95db223eb4db44c5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/shared.js\":\"0f21c6b55d63d873\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"0d34bc17300e979e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/text.js\":\"335ce628080fd07a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentWrites.js\":\"2d573de1ff680fe2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/authoringCatalog.js\":\"136da8a441530f52\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/blockRefTargets.js\":\"7c9346fbfa5a808d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/bridge.js\":\"89fe4f409ee8038e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/bridgeLoop.js\":\"4424f7dcba0900fe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/changeHistory.js\":\"e22634474b2786f4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/commands.js\":\"d982304d57db1c6e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/commentsCommands.js\":\"7c5e8622e10cfdcb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dataExtension.js\":\"b8ab17895a7aab01\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dataModelGuide.js\":\"1960f6534987aa69\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dayPropertyInputs.js\":\"56deda2d88f1c95c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/describeRuntime.js\":\"243b7c0126fd300c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/extensionLint.js\":\"8e0d6f336b6a9baf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/grainAudit.js\":\"21dc3cdb7fa7da85\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/healthCommand.js\":\"fb6a7a83bd4e9a12\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/index.js\":\"3a4745a8a8d73ff5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/presetIdentity.js\":\"e2e3aa4154a079e0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e446fb35b34301e5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/readMedia.js\":\"5444a785b800058f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/schema.js\":\"2e8179d5ce5e8e30\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/serialization.js\":\"6a78a39ca28346f6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/targets.js\":\"fab743441f862e8d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/tokens.js\":\"4702b5abbe334d21\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/watchEvents.js\":\"819e3ab3ca004c58\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/workspaceGuard.js\":\"7e9024aae93c5104\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/writeCommands.js\":\"64c213e01a6648cc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/AliasCollisionToast.js\":\"0a6124fc22659267\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/DuplicateNameBanner.js\":\"bb3c5a4b1f302f5e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/collisionMerge.js\":\"30ea5a215a27a337\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/dataExtension.js\":\"1363f076738c2bd6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/index.js\":\"2124cf381e38dedf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/mergeCollisionAction.js\":\"458c546d1c78419c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/pageStyling.js\":\"2e98824585d9f188\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/rejectionToast.js\":\"563551b4af8e88af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/syncProcessor.js\":\"4369e60213db94eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/actions.js\":\"e1033aaa685cbc08\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/addComment.js\":\"7bab002800ec5a83\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/anchor.js\":\"1a5a6a30bec8bf11\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/anchorState.js\":\"da6c20372cdc4524\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/commentLinks.js\":\"ef1aa3285d05105c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/confirmThreadDeletion.js\":\"e0c6da27a64525db\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/container.js\":\"458409936e3aa2e0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/dataExtension.js\":\"a4af3b6422d362f7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/deleteComment.js\":\"6e5eb766e1c12acb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/highlights.js\":\"1582b465a93bd36c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/index.js\":\"3c4749c16297b66b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/linkedCommentsPill.js\":\"bad0849eaef10ed1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/margin.js\":\"17e645f94c7eb345\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/marginAnchorLinks.js\":\"97501ec32a0525e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/marginSchema.js\":\"161b7cf1180a4c5d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/newComment.js\":\"1ef90fec5bb7e09a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/ownThreadPicker.js\":\"0d19f2f855cb9e29\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/placement.js\":\"5be7d977cf498827\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/queries.js\":\"812844d7ac8d4adc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotePosition.js\":\"98da380d7cbeea39\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotedIn.js\":\"d92bd309b6ac5041\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotedRange.js\":\"5e1ebf8356ea9c0b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/rangeRefs.js\":\"a1551665e56cfe5a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readHighlights.js\":\"b49590fcd7b8f11d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readSelection.js\":\"9fcb6ca9c77c43ff\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readSelectionUi.js\":\"785303062ed63b16\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/reanchor.js\":\"213ff6fe1232c359\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/schema.js\":\"d533367ce6ce0f71\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/scope.js\":\"eea4963b9be05515\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/scopeThreads.js\":\"8d0ef4715b0915df\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/splitRetarget.js\":\"3bea17706023fde8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/suggestionCard.js\":\"86f0e802dbab6639\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/suggestions.js\":\"62cdce602e2f1859\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/summaries.js\":\"06c93818faf9c910\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/summaryBatch.js\":\"775cf19338f5b3ce\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/surface.js\":\"a1093aaecdef2543\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/threadNavigation.js\":\"638476f4f538c02d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/threads.js\":\"d5bf9ae5fff21a8d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/ui.js\":\"25427d8b5b986d15\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/uiStore.js\":\"24e9c87919a52ac7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-intents/appIntents.js\":\"886ce54485226fc6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-intents/index.js\":\"d4b83a0a5fb503c7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-update-prompt/index.js\":\"a54ce99a9598f625\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-update-prompt/status.js\":\"e8658db88a52cc0a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e52aff0f5146ca5c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaBlockRenderer.js\":\"bd2680fd6e4d1070\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0a18460031feb3c0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaUploadReconciler.js\":\"d9aa2693d0529205\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetDownLane.js\":\"2dab13d4f1ea7376\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetResolver.js\":\"c8d425f8add84f93\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetUpload.js\":\"f5ef992edeb1097a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/attachmentCleanerIO.js\":\"13bb492b75971f3b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f47acf61c9bf6a53\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/blobStore.js\":\"1623f98993d498d1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/browserMedia.js\":\"2e31e121d6f656bf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/byteStore.js\":\"671f728f3cfec59f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/cleanerIO.js\":\"b74ead6b5cfc7c5f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/cleanupAttachments.js\":\"7ea7289aaa7a60fe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/dataExtension.js\":\"02ce1e83414d9422\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/downLane.js\":\"6940deed17fa7f3c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/index.js\":\"cd3ec61260bf2959\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/insertImageContribution.js\":\"52015f314d1f7a20\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/laneArming.js\":\"03dba6693d419c7e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/laneLock.js\":\"0edd78de9ecf6a0f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaBlock.js\":\"d3d474f966c71c5f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaCapture.js\":\"c67999553e3eaa41\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaLanes.js\":\"6774a98b2ca11df0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaViewers.js\":\"960f8d51b44568cc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaViewersFacet.js\":\"a159b01cafbd6fa7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/pasteCapture.js\":\"391f9ab89fd73543\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/resolver.js\":\"c36e142c696e1a9e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/retryUploadsAction.js\":\"17be2fdf239c53eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/storagePaths.js\":\"2f98050c0ed25f69\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadDrain.js\":\"c9d34bacce570c5f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadLaneStatus.js\":\"113b918db410c60b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadReconcile.js\":\"8ec7635a8fe5b92e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadRecovery.js\":\"f56cb738d7de2de1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadStore.js\":\"bdfeb9950511539a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/useAssetObjectUrl.js\":\"4d12657cd6416160\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0c0ec6b0c1518fab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d6d0476cdf66cd1d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/facet.js\":\"a1d216c3690d8e0c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/index.js\":\"2739eeac0f71e4a1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/prop.js\":\"a16d146dcb3b4e31\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BacklinkFilters.js\":\"132eb0338f499f27\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"3c5e68213abf0397\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BlockEntry.js\":\"8a1e8ff0f457a23e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/LinkedReferences.js\":\"971a43b89ca21a00\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"5cb54796a07f9717\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/dailyNoteDefaults.js\":\"6b6720881e4b1117\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/dataExtension.js\":\"b1d66166622a4ee1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/edgeExclusions.js\":\"9bb7dc086eb74b4d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/filterProperty.js\":\"c5ebfcd5b99aeb82\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/index.js\":\"ddfe3f85da0953a6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"2496eb076dcd83e0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/applies.js\":\"27521fcefaf540ad\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/countQuery.js\":\"d33b4fbce2b863b0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/expansionStore.js\":\"c9e4fe1163383a03\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/index.js\":\"e18dc7ca8b73b990\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a534425bbda77ff2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/presentationInvalidation.js\":\"cf5ff12cfd491aa2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/propertyEditorOverride.js\":\"349c345f2233198d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/propertyFilter.js\":\"7452d699531af8f4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/query.js\":\"efd281ffc4716228\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/resolveFilter.js\":\"f3d8c0d243170d1a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/sourceBatch.js\":\"0106aa0a51c4ad2e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/sources.js\":\"2273eb802c17b6ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/useBacklinks.js\":\"c1549eb200cea1e2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"36967d88a3e8ffe9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/BirthdayCelebration.js\":\"6bdc3cecb157e561\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/BirthdayOverlay.js\":\"728c0098370cb448\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/gate.js\":\"73ecdbca7aa754c9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/index.js\":\"2712dd9b9f9942ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/wolfTheme.js\":\"26a0ea2c44a1b5f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/BlockDragLayer.js\":\"f9a0c64f305a3d4e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/dragController.js\":\"dd2624eddfd645e4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/dropTarget.js\":\"df4b86d5434fc0d1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/index.js\":\"b947593c598b5964\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/projection.js\":\"f87879e4b86620cf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-info/BlockMetaCard.js\":\"00c2b64df8da17de\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-info/index.js\":\"bbea79ceabe1271c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/AddTagDialog.js\":\"339458180229542c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f664e25fd334584a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/TagNameIssueHint.js\":\"3e992c8e4dd42c3d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/addTagAction.js\":\"cd0ecf14eb6dae4c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/appendTag.js\":\"c7d289530f40239a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/config.js\":\"fe286d872d6281d1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/dataExtension.js\":\"505b0756b8a57c93\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/index.js\":\"369563401d31547e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/propertyEditorOverride.js\":\"28d00bda7d6ebd6a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ebd243f4b1342478\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d5d9575059b5a1d8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/Breadcrumbs.js\":\"775af177938fcce5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b5d582d2e46774eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b36574fc95e1ce00\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/index.js\":\"14d54084889b4e56\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5ae865ae164beb64\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/CharacterCountItem.js\":\"c843be2c66716017\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/ProfilePropertyEditor.js\":\"bd274931e21b6d50\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/actions.js\":\"22f5c114d4165368\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/blockType.js\":\"79ddf4b2304d08c9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/charCount.js\":\"ab2c69da1de08730\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/dataExtension.js\":\"583b72b83800e0fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/index.js\":\"e75b570276ad7b63\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/profiles.js\":\"82d76ebd7bdf28da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/properties.js\":\"9e0b001f427b64c6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/subtree.js\":\"926a1256cbac349b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/textCounts.js\":\"3cbb09d3d3a81f04\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/colemak-keybindings/index.js\":\"00833b3fdbc7772e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/CommandPalette.js\":\"224182acdae28eae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/HeaderItem.js\":\"5cdf154e11748827\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/context.js\":\"b4e29c783d8fd558\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/index.js\":\"b15146facd8b63e8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/selection.js\":\"e8f02b7d5fc865cc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/toggleStore.js\":\"4a88877639f758e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/useCommandPaletteActions.js\":\"34e54a57672459fb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/ContributorBadges.js\":\"f20456bbb90e3e45\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/ProfilePicture.js\":\"9374d366f494870e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/author.js\":\"1ef23e5c15899b59\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/codeMirrorExtensions.js\":\"8233cb76f07181c3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/dataExtension.js\":\"91c0d021b000779e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/index.js\":\"1f40356526f5fdf7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/mentionAutocomplete.js\":\"e33b737145b24d6b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/processor.js\":\"e8b36e3218a950f4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/profiles.js\":\"76fe8b5eb072b37f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/queries.js\":\"a139c1f8edb42d58\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/schema.js\":\"b8a5d65b471a03e7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/useCommentAuthor.js\":\"9fe412dd48152586\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"e833f53940faedf2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c857499207fc34b1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/index.js\":\"96c7bb8fb9ab073f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"ac06a11f0721fcea\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"09ae807da33529e7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/CalendarGrid.js\":\"0be7457ade5466ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DailyNotePicker.js\":\"3d2383d776c01939\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b5141e22752d04b4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateNavDecorator.js\":\"2566932e2cd49cfe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateScrubOverlay.js\":\"05fbcb1da4c19d02\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DayPropertyControl.js\":\"44e68e8fcd6fb3ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DayValueReferenceControl.js\":\"2f5b7b4e8443547f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/HeaderItem.js\":\"5087efca87a745dc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/ReschedulePicker.js\":\"cf4f2903eaecaf49\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/SpreadDatesDialog.js\":\"bbaefb01832e5eda\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/actions.js\":\"57174a0a516e11f1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/blockDateAdapter.js\":\"c847a3f903a34e99\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/calendar.js\":\"33c137296480c0ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dailyNotes.js\":\"322dc0cc9ff85495\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dataExtension.js\":\"94689a8802232791\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubActions.js\":\"9f2b1c2e1a795c10\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubGesture.js\":\"f395a6deb077d426\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubGestureActions.js\":\"45749b89ad21cd5e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubRecognizer.js\":\"97c894d3cf01bd6d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dayProperty.js\":\"5de317ba03500280\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"1d1b06b0bc02d139\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/deletionGuard.js\":\"5ed31eb84256d798\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dueQuery.js\":\"762ee68cf25e921c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/index.js\":\"cfbd0bc6f31edea6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/landing.js\":\"06266ebfff369be1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/localSchema.js\":\"e827be9053397793\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/referenceDateAdapter.js\":\"df783aa3732c0311\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/rescheduleAction.js\":\"4f5692e57ca8e3a6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/schema.js\":\"23eebd8ad1630962\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/spreadBlockDates.js\":\"4451ffd1824f7696\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/spreadDatesAction.js\":\"72784e862096489d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/today.js\":\"61716f1b10e3ff13\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"48a01e9a2516cc17\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6c4240b967ae7bce\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/audit.js\":\"2e008f46ea9cbf87\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/auditAction.js\":\"7464da5d82a4acdc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/auditRanges.js\":\"4147fa9b79156759\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/diagnosticsSource.js\":\"ac003fd9ed39cb16\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/divergenceScan.js\":\"e3b32598bd911970\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/index.js\":\"3ed1988a79b45ff3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c5fc0acac2966e33\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/referencesMirror.js\":\"6bc256225d9ea4e7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/rowJson.js\":\"8e0e88f84f2b1a9d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/schedule.js\":\"9834c81b70becbe2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/store.js\":\"10136ca584484b1f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/action.js\":\"a8a115c62cddad69\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/index.js\":\"1627d5b8bab22239\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/plugin.js\":\"4705109930d26e4a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c12521ef6e5fe417\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/actions.js\":\"c63bf4ed8eb9e39b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/changeMarker.js\":\"9f73bdd58501191b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/diagnostics.js\":\"89f36537399ec0cd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/fileSystemAccess.js\":\"e6dc184949fea3cb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/filenames.js\":\"bded95d0dcf5a4d2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/index.js\":\"29a358255d0e12ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/mirror.js\":\"54b7124af1271ac8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/runLock.js\":\"6b6de462da781b29\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/runtimeHealth.js\":\"997201d8786661d8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/schedule.js\":\"5e0b3b4dd9302311\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/store.js\":\"2f59cc4327e25111\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/default-themes/index.js\":\"da44280636707819\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/default-themes/themes.js\":\"09b535536e815499\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/diagnostics/facet.js\":\"683823bc49e5bc12\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/diagnostics/useDiagnostics.js\":\"454e00614f7c4c0e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/dismissals.js\":\"d192b0b31e0b6e56\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/index.js\":\"6f7fe5d15e0856ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/status.js\":\"9df5414ac2249f84\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/store.js\":\"f1dcc626a97b556b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7727f941bcf4289c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/ExtensionsSettings.js\":\"e08eb73763918b52\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/actions.js\":\"5248c9e9e9b92fb9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/config.js\":\"72ef86b1902618d2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/dataExtension.js\":\"9c7a44052dd30457\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/effect.js\":\"20af00500e1337b1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/index.js\":\"caac9dc9fa803a6d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/propertyEditorOverride.js\":\"d7bc12315fb920e4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/useToggleTree.js\":\"5db10df64bc3aa81\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/ExtractTypeDialog.js\":\"c35203dd9a5c05e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"63ae4041eaed656c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/PropertyShapePicker.js\":\"67b5eed428605bc9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/action.js\":\"fd528fb57c1f7753\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/index.js\":\"b41bcc673632f672\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/FindReplaceDialog.js\":\"d12e7b2993108b45\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/HeaderItem.js\":\"9bd5f10cb9167ab6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/dataExtension.js\":\"e17e1dfb1825204d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/index.js\":\"156fe464c295d3ff\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/search.js\":\"87047f6ce2f445d0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/toggleStore.js\":\"7d84c61eab3920cf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/LocationPropertyEditor.js\":\"a1132ef83e65cc9e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/MapView.js\":\"b6304f4c2b864810\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/blockTypes.js\":\"221fa319f4d9a02c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/codeMirrorExtensions.js\":\"7a127c462852caa3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/createOrFindPlace.js\":\"b1ca4113fc4be3fe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/currentLocation.js\":\"4b543642968ef1d1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/dataExtension.js\":\"0cb40a58f69b1d0a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/geoContentDecorator.js\":\"22fdd67aa66532bb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/googlePlacesClient.js\":\"00b45141b32c2a0c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/index.js\":\"3e11922d946258b4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/locationsPage.js\":\"7649421f9123f1ff\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/mapViewport.js\":\"31d0044af01a71a9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/pickCurrentLocation.js\":\"a28c00a20eae36b7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/placeAutocomplete.js\":\"29968e9037a13109\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/placeNameCollision.js\":\"d4a919c22e75b282\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/properties.js\":\"9454ff48c536add4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/propertyEditorOverrides.js\":\"84a210f0d6c21863\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/query.js\":\"129e5f3df7213eca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/usePlaceSearch.js\":\"a879d2c87c5397c7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"6276251bd8127a74\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c599c9eb1b10b16e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8c5438f6f6fdd15f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/config.js\":\"ece8b9e679b9590f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/dataExtension.js\":\"b924fbef15e94e8c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/facet.js\":\"706db8380d3ca5d3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/grouping.js\":\"ad170fd41cfe4557\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/index.js\":\"6625f89936eb6439\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"569db87572b0b478\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/query.js\":\"75841f17038cbbe0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/resolveConfig.js\":\"9b18a1f98d631000\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"86168600d3b8e75d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b689fb777a62aed8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/HtmlDocumentContent.js\":\"42a823259449f1f5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/HtmlFrame.js\":\"003cb820b0a50ab5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/actions.js\":\"95e2cf8f4f967ce6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/blockType.js\":\"76d2fae028c56257\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/confirmRunScripts.js\":\"3d2f5a3fd38f7057\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/dataExtension.js\":\"9ba2dbb822ed731d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameAnnotations.js\":\"f775bd59f81ae9ea\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameDocument.js\":\"292ea33b01569946\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameTheme.js\":\"039210cfb9ee1d63\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/index.js\":\"e063274b1bd36451\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/scriptConsent.js\":\"e3229d4aa81edfa7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/sourceMap.js\":\"17096d3c9737a1ec\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/useDocumentScripts.js\":\"00fe91863e346be1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/index.js\":\"47cf76d5c24a08ad\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/record.js\":\"57ffbef5bc174f0f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/recordStore.js\":\"93d74045e01d8aad\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/responsiveness.js\":\"9ba9dd06245e8e23\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/schedule.js\":\"5868b25dce591f0c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/sessionContext.js\":\"5fdf2fd8eeca0b37\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"33ab1778c5bdef1e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5092f2752cdc4dcb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/actions.js\":\"7abddca2f9c0374e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/config.js\":\"9f0c5be51cbce6d1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/dataExtension.js\":\"3e609637b1dd8efa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/effect.js\":\"58748d3ec3fb1223\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/index.js\":\"70909170a941f91b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/keyCapture.js\":\"1c61603d5d6a1aa1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/overrideStore.js\":\"d1627e3a5dd6e4bd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4f1517fee87c35d5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/HeaderItem.js\":\"5380471aded50682\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/LeftSidebar.js\":\"1631180e0cc1d972\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/actions.js\":\"c90daf01b4eb1041\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/facet.js\":\"d6fc3df0401ff9a2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/index.js\":\"1daf5de8f8f448c7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/shortcuts.js\":\"10022c09078646ba\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/toggleStore.js\":\"6a9cc974da03ab45\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/MergePicker.js\":\"2e4f2423a71ebe1e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/index.js\":\"b02871172a324aa1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/mergeAction.js\":\"64106c21e144b8a7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/strategy.js\":\"88fa2a3905cd5603\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/Button.js\":\"e9b4efeca6ccf0f2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ef5aeeb1f21f42af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a5be63c4757bab35\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/facet.js\":\"b27e13f19326be98\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/index.js\":\"09de35f968e4d739\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"8d200e278c529fe1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/actions.js\":\"aa399205a3454c66\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"289be62e273dbe00\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9da15c1fab1aa54a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/index.js\":\"8d37d9cdff2b60ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/MoveDestinationPicker.js\":\"0b5a73532da7677d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/blockSubtreeMembership.js\":\"494e543e604fe7b4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/contextMenuItem.js\":\"b76c49e1cedb9d14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/index.js\":\"836a4360e83cb968\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/moveAction.js\":\"d055cbbbb3ed3abc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/moveBlocks.js\":\"1b9791f3f9dfc518\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/selectionAfterMove.js\":\"58665fb60f8866ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/TutorialBanner.js\":\"55f22cb1ffdc3439\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/action.js\":\"477391399c9d5bfd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/bannerDismissal.js\":\"f3eba19a1db41562\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/documents/cheatSheet.js\":\"28aba11a56fd2020\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/index.js\":\"6d07d4f5bd184d62\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/keys.js\":\"eb271e00496064e4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/landing.js\":\"cffce850371c7175\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/outline.js\":\"aabe489860df0b03\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/seed.js\":\"64617f25c1de4aa6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/PerfTrendDialog.js\":\"823fe20c1c407b2f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/analyze.js\":\"5843fbf9fd90c827\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/diagnosticsSource.js\":\"d442b5f4f6a7084a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/index.js\":\"239e6fe6c5340326\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/load.js\":\"e897d6e8f8d1d19b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/monitorRun.js\":\"71ee01f55dc5a829\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/schedule.js\":\"009ece162e1aa129\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/series.js\":\"b814022358f3cd8d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/store.js\":\"9d053990e6165f90\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/trendAction.js\":\"a249700854a4f4af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/verdict.js\":\"31aef6810b7e725a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/clickToEditAction.js\":\"a31faeccebb0f17a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/index.js\":\"6836c99e32d42f72\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/interactions.js\":\"dd7e51682c47b894\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b449576175c77372\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/MigrationGate.js\":\"8016f215f61de19f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/MigrationGateDialog.js\":\"386d16dc34580504\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/action.js\":\"70da75b4b3def7cb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/index.js\":\"deadacbae072a250\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/localRunMessage.js\":\"1fcedd279fc1183f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/plugin.js\":\"d6d65e4ffd05eed5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/progressReport.js\":\"a05e34f9237c71c6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/sweepProgress.js\":\"20ce300c5a7e3ee3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/FieldRowRenderer.js\":\"940d105a82ba4af5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/ValueRowRenderer.js\":\"fba14b955e530b18\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/actions.js\":\"54e43810fcda3b94\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/autocomplete.js\":\"7fc63637d124444f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/fieldRow.js\":\"1fdbf54350b06c9d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/index.js\":\"cedb6af77a7389a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/referenceWarning.js\":\"5f309abe62fb73c6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/valueAutocomplete.js\":\"431102a3fa06607c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/valueSchema.js\":\"6355c4371b7279ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/HeaderItem.js\":\"6d70b9354206fb4d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/QuickFind.js\":\"795fc5605e1fffad\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/index.js\":\"e20e06a1c625445b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/recents.js\":\"69e58d300215770e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/resultItems.js\":\"21aa8c1695610291\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/selection.js\":\"c61314e1ebf3e8f9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/toggleStore.js\":\"29053d4753e6fd44\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/HeaderItem.js\":\"acf12e603eb7d4b8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a955d5ce2c8493e0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/grouping.js\":\"f7aab90cfdc06ded\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/index.js\":\"2679adf4d069c871\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/target.js\":\"0b242c51964f05af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/codeMirrorExtensions.js\":\"b1083249b8dd624b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/contentPrefill.js\":\"9838e8f80013ad8d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/dataExtension.js\":\"ebcbea2aa706bf45\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/index.js\":\"d56fb0b94d100473\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"19dda19066035954\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/invalidation.js\":\"9377c986b93dd659\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/localSchema.js\":\"ae9959ab8a6f11fd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/blockrefs/index.js\":\"ddb40488bbbefc89\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"18d476df976cf0e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/index.js\":\"f21d6c72af05e95f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/referenceNode.js\":\"023f9ecc27ce3451\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b3ea51705c56f300\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"50b59d8c3fb421a1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/index.js\":\"38f5e9fc4711f1e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"d9ed0cb392833f80\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ac430e84f772e75a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/mergeRetargetProcessor.js\":\"23da9d09ea1842ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/parseFence.js\":\"d195949b795039ec\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referenceParser.js\":\"bcd3161411e78ea1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referenceProjection.js\":\"7eadbb782eae7262\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referencesProcessor.js\":\"1931bd196e121c86\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/renameProcessor.js\":\"7d43d3e16ae7b911\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/spanReplacement.js\":\"764ce6e06c49a9c3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/htmlToOutline.js\":\"d393245189a73260\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/index.js\":\"fa8e47dca2943a69\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/normalizeClipboardDom.js\":\"d0243305ce724e5b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/pasteDecision.js\":\"be495f8c0d070368\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/action.js\":\"e7cd2107a7492db8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/blockIds.js\":\"0e4f480f22b5f2a9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/content.js\":\"063cd52af0135530\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/effect.js\":\"2bd27d5cd4ff3bf9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/ids.js\":\"68255d30da5249f6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/import.js\":\"d3686dcf656cfe5b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/index.js\":\"b06dd77fc9c6ff1f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/plan.js\":\"c12fa18561195e0e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/plugin.js\":\"e04ab800dfd6aa7c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/promotion.js\":\"ab099ed30bf85df3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/properties.js\":\"cedce06584d41cef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/references.js\":\"e8c6b03698bd1d29\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/report.js\":\"aa5215d4d9606ab3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/roamMemo.js\":\"2ce1588989d5191b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/runtime.js\":\"af3d519ad8962fae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/schemaReconciliation.js\":\"1f3a3631724355d6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/srsMarkers.js\":\"eb77fa2801970e24\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/todo.js\":\"8002ea5c7bcb3c2b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/typeCandidates.js\":\"d7c05ae3a70a5031\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/types.js\":\"32e19c73cf040398\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/search-health/index.js\":\"b9fc58013198a206\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/search-health/store.js\":\"0648b25b6a314496\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/HeaderItem.js\":\"52869d27a280e941\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"4600272ae2c1b834\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/index.js\":\"15976755542e49b5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/model.js\":\"34852e361ca1762f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/toggleStore.js\":\"1551abdb70c0facb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/useKeyInspector.js\":\"f1d4cd8becd2d9d2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"9d1676c500cccc93\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/ShellDecorator.js\":\"26274167b37a04d8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/actions.js\":\"abee25dfcf0f8707\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/exclusionsFacet.js\":\"379a5f40e40b666d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/index.js\":\"2036c9dc7c6c4773\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/shell.js\":\"0e153bfcf5329afe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/surface.js\":\"173f47c66cb08d46\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/walker.js\":\"47329b63e3c2aa8b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/RescheduleToast.js\":\"188ac488e8b5ce13\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/dataExtension.js\":\"3b0ded6839779567\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/index.js\":\"af5ac21b4212e141\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/indicator.js\":\"2ced8a64b0b69bbf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/moveSrsState.js\":\"551915cff7ddc6c4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f1bbac1eb67e0376\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/scheduler.js\":\"d7e5ec1bc5b5707d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/schema.js\":\"4c3e703bfb5ce870\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a0faa263382d5283\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/srsClipboard.js\":\"6c7783b0e9875d04\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"632635daefbd97ec\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/DailyNoteReviewHint.js\":\"24ff16a18db09042\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/DeckPicker.js\":\"baf8a70cd5ad8389\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewControls.js\":\"89710819374d5a01\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8b46d6522deea875\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewSession.js\":\"2a14ee937db13793\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/actions.js\":\"f47fd91440d4585c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/archive.js\":\"271f7b08e2b06fe6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/dataExtension.js\":\"30a5fffd91e44195\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/deck.js\":\"4994df8526458b4f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/dueQuery.js\":\"0e30ef8a6d4dcb5b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/gradeDecision.js\":\"f8b2f113cd7fc744\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/index.js\":\"3d297f35a05819f1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/keyHints.js\":\"cab009241285df22\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/reviewCardLayout.js\":\"c4e9080ce9c03b91\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/reviewProgress.js\":\"d4c5eb31ddb8777e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/schema.js\":\"5b781f16164f63ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/useDueCards.js\":\"934f2ad8824bf610\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/startup-metrics/index.js\":\"1e6fc53d04722608\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/startup-metrics/record.js\":\"db757570856c7547\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/index.js\":\"dbb0f6634b188302\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/persistenceStatus.js\":\"817d298f2ccee3fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/requestAction.js\":\"69d5c1f891cbce06\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/TypeChipsDecorator.js\":\"b72ff9c272a2c061\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/codeMirrorExtensions.js\":\"fc5091b003bef25d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/index.js\":\"d04dc9f38f57dea8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/typeAutocomplete.js\":\"4540c746e9515ec1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"75b0057c55183b30\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/actions.js\":\"937157e1da7c9111\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/anchor.js\":\"25991ff138d8c349\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/events.js\":\"f156b166a318dad2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/gestureActions.js\":\"8fbbf8221b415fca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/index.js\":\"22366587374ebba6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"6116f5ae883e6e48\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/collect.js\":\"3d2d75c6aab1c8e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/index.js\":\"54308e8696543ed2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/record.js\":\"587c8c71baaf65fb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/RejectionDialog.js\":\"692ce8e8068f4b50\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/SystemStatusHeaderItem.js\":\"0937c3277d0f2dea\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/index.js\":\"ca3d29289762efe3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/model.js\":\"454d122e44ad47da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/queueCounts.js\":\"58dcf7bc50ae9fa5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/rejectedHelpers.js\":\"bfbfb366be1d0ebb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/rematerializeAction.js\":\"ed9a182a90862358\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/useHysteresis.js\":\"af284e12bf376626\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/ColumnHeaders.js\":\"f0e8ea5b7081a6e2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/QueryUi.js\":\"6bd947f16ff40e59\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/TableLayout.js\":\"b988c65fa82e3006\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/actions.js\":\"7fb7a20082613676\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/cellEdits.js\":\"1cdeb4f18d5c30f9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/childrenViews.js\":\"c5b7bd100fd2e801\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/columns.js\":\"e9dcf013f39241c5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/controller.js\":\"6ac1940858c1556f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/convert.js\":\"6733736ad5b971ae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/dataExtension.js\":\"090462504bf5c94a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/index.js\":\"0e71620c81c5933a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/keys.js\":\"a4133c40347a8abc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/model.js\":\"309b8891f4e02735\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/QueryText.js\":\"d303cb2dbf4301ca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/backfill.js\":\"66a27230b882bc4b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/completion.js\":\"6463310deb19c5ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/format.js\":\"2dec0f33ffa9d022\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/parse.js\":\"c78c742229208999\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/queryValue.js\":\"172ea0f3cc82f9fc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/registrations.js\":\"e2293d31ce0fb21f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/source.js\":\"dc94170d07d1179e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/registry.js\":\"4bcc24e56dc8ea3a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/rowGutter.js\":\"92d0d6495491591e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/rowVerbs.js\":\"4d40eab13077f2a4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/schema.js\":\"e3d7f6dbc18975ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/sort.js\":\"f04b5bd905ef8ec5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/effect.js\":\"b3e39990e4e27991\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/index.js\":\"cd7507d6c146c351\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/theme.js\":\"2351000138592a5a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/actions.js\":\"f37becf1ad73b40e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/dataExtension.js\":\"1d923d4cddbef918\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/index.js\":\"c4ebc49bde1962a5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/schema.js\":\"6f7caf93394a96e0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/TouchSelectionLayer.js\":\"9b7ff54b3b14c472\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/actions.js\":\"0e2e140468159325\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/defaultItems.js\":\"aa55bc527f427f07\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/facet.js\":\"e32fca2e2789110d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/holdRecognizer.js\":\"7e74dded5630d5c9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/index.js\":\"bb98d1cc01e975f7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/UpdateIndicator.js\":\"4f0eb3eeaee58e16\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/index.js\":\"55103999566dede1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/loadTimes.js\":\"bb2a05c07c702066\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoNotesRenderer.js\":\"6b06c4d11ae6bb7b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoPlayerRenderer.js\":\"5002253cae942fd6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoTimeStamp.js\":\"6c4c66af2def0c9f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/actions.js\":\"16051535f1ef54a1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/index.js\":\"29219b1cc2080f86\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/markdown.js\":\"b7e1dcbc203c3144\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/notes.js\":\"90578b47b88aa801\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/registry.js\":\"76bd9cb01a6767cd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/remark-timestamps.js\":\"72e6ca6afdb05a36\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/view.js\":\"80215239647ecd46\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/LinkHints.js\":\"6bfc48ba2bcee263\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/index.js\":\"5b15f8c60eed656a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/model.js\":\"3f38826b89b2018b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/settings.js\":\"2e5cb44cc3c2ea7a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/actions.js\":\"6ca864d0b2a5c32b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/index.js\":\"9e02e8707c89e85e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/interactions.js\":\"d85fa23345bd8c74\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/workspace-header/index.js\":\"08abd1445525bc4a\",\"/knowledge-medium/pr-preview/pr-1904/src/registerServiceWorker.js\":\"1a31b3ae18ae0de7\",\"/knowledge-medium/pr-preview/pr-1904/src/requestPersistentStorage.js\":\"f9810ac8fe2072b3\",\"/knowledge-medium/pr-preview/pr-1904/src/services/authRequestDeadline.js\":\"dfac3531057eb35a\",\"/knowledge-medium/pr-preview/pr-1904/src/services/authStorage.js\":\"554dcd2540c87bac\",\"/knowledge-medium/pr-preview/pr-1904/src/services/powersync.js\":\"cb508aed52919764\",\"/knowledge-medium/pr-preview/pr-1904/src/services/supabase.js\":\"5a926c7f968ac41f\",\"/knowledge-medium/pr-preview/pr-1904/src/services/uploadErrorClassifier.js\":\"1525e437d2df79b1\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/ActiveContexts.js\":\"217253bba80889d3\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/HotkeyReconciler.js\":\"0b47a9d791170cb0\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/WipeLocalDataDialog.js\":\"bb534d1d21577af9\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/actionDispatch.js\":\"acfd664f63d62217\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/actionRefItems.js\":\"46347a60541986cf\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/applyKeybindingOverrides.js\":\"07e89cd32ae45d13\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/blockActions.js\":\"a209d5437f5e151f\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/blockMergeGesture.js\":\"f60df528b669bd85\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/canonicalizeChord.js\":\"b48a50adf07f77ad\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/defaultContexts.js\":\"ad8d8eed5bcfd6a4\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/defaultShortcuts.js\":\"f9fb05e11c67381b\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/effectiveActions.js\":\"a8fc8a0c702f660b\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/gestureAction.js\":\"01c744fbc93d97a1\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/gestureBinding.js\":\"62a3c3f6ad4290a2\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/holdRegistry.js\":\"9e6c597d44efb62f\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/keybindingConflicts.js\":\"518962260ff0174c\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/keybindingOverrides.js\":\"5d5d70a6518c2e4d\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/pointerAction.js\":\"180ed4813f511b65\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/resolve.js\":\"cf522d78165f3e83\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/runAction.js\":\"96503ae1935c466a\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/sequenceMatcher.js\":\"8baa181abf0f72bd\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/types.js\":\"7cc2af93dbb95a24\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/useActionContext.js\":\"5c6f8d0c3fc14e5d\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/useActionDiscovery.js\":\"90426dcdc33ea117\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/utils.js\":\"6f5d9426ab3a0687\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/bootStore.js\":\"c20647cf39953bb1\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/previewDatabases.js\":\"3a9e79cbda68a1af\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/byteTransform.js\":\"74592b0c0dde64e0\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/attachmentCleaner.js\":\"e9749f64c2aff8ad\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/attachmentParts.js\":\"ea48f15a0419f2d8\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/bundleParts.js\":\"57acff281dd7f401\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/bundleRecord.js\":\"6d1febd792f34351\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/manifest.js\":\"6f3145024f796e55\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/takeBundle.js\":\"3c17a72738521fe3\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/verifyBundle.js\":\"d634be17b8e9fbe8\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/cleaningStage.js\":\"df795a1c4c0b0bf3\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionKey.js\":\"fbd6e8420f194664\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionServer.js\":\"202ac91fde61d854\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/flip.js\":\"0a805bebfbe570ca\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/flipAttempts.js\":\"1da5bb5ff23dbc10\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/pages.js\":\"987b74580f205220\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/preflight.js\":\"e896c493a48a1705\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/reseal.js\":\"6d15f6cc31e53503\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/runConversion.js\":\"5467758d28569340\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/runLock.js\":\"f62b46fb25fab47a\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/sealing.js\":\"ea61779493f4b919\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/sealingStage.js\":\"0e6d039163ef7f09\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/stage.js\":\"73f99efc181d2949\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/verifyReseal.js\":\"09fc1f8cbd1fd1d1\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/aad.js\":\"70f9aeae3f0cf8c1\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/aead.js\":\"f243acbc49c05169\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/base32.js\":\"adbc5bce0eda4b8b\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/base64url.js\":\"8bec34b73e75e287\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/binaryEnvelope.js\":\"6791b8a6cfd2639d\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/byteAead.js\":\"91037a6323bce100\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/canary.js\":\"154e77e8d19463ca\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/contentHash.js\":\"e698c18cce01059d\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/contentKey.js\":\"4aea85a2b6676d20\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/derivedIdNamespace.js\":\"e56e4725cfec240e\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/envelope.js\":\"9aa92dd3b446759f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/hex.js\":\"8859847a8b04bce6\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/sha256Hex.js\":\"4ef0559c868d4c99\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/workspaceKey.js\":\"08a75e6a474c7dc2\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/conversionState.js\":\"ace79048d2cea567\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e7c7b8a492e8b695\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/pastedKey.js\":\"83a9b9f40302ff69\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"0da1049cb3eda015\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7e209cb39d5a89dc\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/keyStore.js\":\"360e74c8b70ab5c4\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/mintWorkspaceKey.js\":\"e9730de1f34473e9\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/modePin.js\":\"73c8d0b4679a2a33\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/openWorkspaceKeys.js\":\"bedaad130feb79cb\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/resolveWorkspaceEntry.js\":\"af7463aa5b15a8bf\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/resolver.js\":\"724cf57038709f31\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/workspaceAccess.js\":\"5f21e4e49d0943f1\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/transform.js\":\"d300bafc9bd72f04\",\"/knowledge-medium/pr-preview/pr-1904/src/themeBootDefaults.js\":\"df4b6708aea15b15\",\"/knowledge-medium/pr-preview/pr-1904/src/types.js\":\"42bacdd622cde3b7\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/ClientLocalSettings.js\":\"539bf15058207752\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/abortableSleep.js\":\"0518348398f52727\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/array.js\":\"1b2f69ef87ae36d9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/backlinkAutocomplete.js\":\"3db2fdaaee0ce015\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/blockCrumbs.js\":\"ce4e94fe6f70e85a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/blockrefAutocomplete.js\":\"1e61e2247aa534dc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/cadencedIdleJob.js\":\"7fdb8c49c5c375f9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/callbackSet.js\":\"e1d09fd041661bd5\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/clientId.js\":\"aecad5cb6d5e29b1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/codemirror.js\":\"7e60414d0396b964\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/codemirrorCompletion.js\":\"38db375fd58c1521\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/copy.js\":\"70dee275632ab039\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dailyPage.js\":\"661628f73e6189ff\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dbForensics.js\":\"1b1432d498dca0da\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dbForensicsHooks.js\":\"1c635347b0991479\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/deleteBlockThroughUi.js\":\"3f71dcabf007ee22\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dialogs.js\":\"dd9efb1eca62f1ad\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dom.js\":\"5e14c93b7e5285de\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/downloadBlob.js\":\"95fe6b913863ae36\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/drawnWalk.js\":\"e72e83386fe4d460\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/exportSqliteDb.js\":\"a50b516a2f953871\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fileSystemAccess.js\":\"a1264bdbf5482931\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/flipSlide.js\":\"e23d42ec8e826d4c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fnv1a.js\":\"220d8ad6f81fd896\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/formatBytes.js\":\"383afe97bc1ac7c0\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fuzzyRank.js\":\"7b4ffc196a632728\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/idbKeyedStore.js\":\"67057b0970e1e7fd\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/idleCallbackPolyfill.js\":\"6883bcb7491641cf\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/keyboardAwareScroll.js\":\"b44cd7dbc67ef8d5\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/keyboardViewport.js\":\"4ad89b612c46ea19\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/lastWorkspace.js\":\"a4f664e08f26708b\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutColumns.js\":\"da5237e82403b898\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutSessionDom.js\":\"2b9eda3f6d5bdc62\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutSessionId.js\":\"73b6b03e07750b6e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/linkClickGestures.js\":\"362ca7b9599e4cf7\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/linkTargetAutocomplete.js\":\"f2ff990241067b0e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/localDbCorruption.js\":\"04c8c35a5e354a08\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/localDbRecovery.js\":\"1ec673edef42d109\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/markdownParser.js\":\"481a065e99831f22\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/memoize.js\":\"4d008439c2f702e3\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/nameFieldCommit.js\":\"adc1dd737cc66835\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/nameList.js\":\"eddafd2b45a1effb\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/navigation.js\":\"42fba31aff2d9a0e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/omnilinerNamespace.js\":\"7e37156af4b2f7ca\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/opfsPageScan.js\":\"6e029e19f2a67ad2\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelClearance.js\":\"32cf097808c43a05\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelHistory.js\":\"c383741301faee38\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelLanes.js\":\"f9c9ba807371e0ca\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelLayoutProjection.js\":\"d9bec5795928bbd3\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelScrollAnchor.js\":\"af316e78e18ab970\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelUrlFlags.js\":\"94fa2f64572ce06a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/platform.js\":\"94496f1015806a39\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/pluralize.js\":\"524ea9a6f1b08b55\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyCreation.js\":\"a2cc3c64c0bdec1e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyNavigation.js\":\"ef6bbf48a2d09f4d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyValueContext.js\":\"59a4981dab2b3da1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/react.js\":\"ec573502628b0108\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/relativeDate.js\":\"bd11a76a2b030bf1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/relativeTime.js\":\"d11dce077346e9ab\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/renderScope.js\":\"01266ffbf05f74d1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/resolvedThenable.js\":\"8c8b9aac12b27dea\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/routing.js\":\"722f2e3c918b936d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/safeMode.js\":\"7ff5730355812271\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/scheduleIdle.js\":\"1a14a50faafbea41\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/screenWakeLock.js\":\"bf5f23cb68d5e6ac\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/selection.js\":\"c521eadcb50b3844\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/softKeyboardGrab.js\":\"3d43d9cfd31b04f8\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/startupTimeline.js\":\"a3f20059c73f196e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/state.js\":\"099932323cb730a7\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/string.js\":\"0af2a5127776a291\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/surfaceZoom.js\":\"621b27c8cf6562a3\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/time.js\":\"50f3af8388334a3d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/toast.js\":\"583275737b8d23cb\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/toggleStore.js\":\"2d659b0cb8f9f10c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/untilStopped.js\":\"38d1faa3c29cb1d8\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/userActivity.js\":\"d758fa5e76f941fe\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/viewTransition.js\":\"a76f0d01a325908a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/viewport.js\":\"8e80bea3abee2185\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/webLock.js\":\"aed8823318690af7\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/workspaceRecovery.js\":\"8975d82ae2f21b4d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/workspaceSnapshotStore.js\":\"658099253fc430cb\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-compiler-runtime.js\":\"78608b55ccd85c15\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-client.js\":\"b2fb2ba3ec4fca15\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-server-edge.js\":\"c486de6aadbe2ede\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-server.js\":\"c1a337264f28be50\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-static-edge.js\":\"15b8bb5e4e4f0003\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-static.js\":\"9479095e08b0192d\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-test-utils.js\":\"9ec58c1310927809\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom.js\":\"c615db5532811840\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-jsx-runtime.js\":\"4e53916978aacb43\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react.js\":\"dc510bc8c32543dd\",\"/knowledge-medium/pr-preview/pr-1904/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1904/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1904/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
