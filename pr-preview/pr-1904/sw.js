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
		buildId: "9733f772d05b-d5a36498",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/\":\"d2c5497824c2b375\",\"/knowledge-medium/pr-preview/pr-1904/index.html\":\"d2c5497824c2b375\",\"/knowledge-medium/pr-preview/pr-1904/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1904/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1904/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1904/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1904/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1904/assets/FacadeVFS-BRQpqnC7.js\":\"891ebefe2dd6f73a\",\"/knowledge-medium/pr-preview/pr-1904/assets/OPFSCoopSyncVFS-DMyQDWdY.js\":\"86e4b1b2b1685b21\",\"/knowledge-medium/pr-preview/pr-1904/assets/OPFSWriteAheadVFS-k-M70Pwl.js\":\"eb585f25ac433d89\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-C0HcraJs.js\":\"86aa477d7fa26ed0\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-async-Fz6hWTwQ.js\":\"b9eb189c33a992bf\",\"/knowledge-medium/pr-preview/pr-1904/assets/worker--hK6-iBI.js\":\"a8493596f780837a\",\"/knowledge-medium/pr-preview/pr-1904/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1904/chunks/app-B1wrkHjd.js\":\"ffc27216a9c8952f\",\"/knowledge-medium/pr-preview/pr-1904/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1904/index.js\":\"75349f08276856be\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1904/assets/AccessHandlePoolVFS-BrTCvkYR.js\":\"691b9b6e34e4c6fb\",\"/knowledge-medium/pr-preview/pr-1904/assets/IDBBatchAtomicVFS-xu9p-z6c.js\":\"0bb34832b79a4ba2\",\"/knowledge-medium/pr-preview/pr-1904/assets/MemoryVFS-ClNzB9Vo.js\":\"6ca89a2ce16db9ec\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-B1ZvrQ6z.js\":\"d2e9ceb833f79291\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-async-pk0cuaze.js\":\"9c6c8a2e595ff098\",\"/knowledge-medium/pr-preview/pr-1904/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1904/chunks/AccessHandlePoolVFS-DqU54l0a.js\":\"e23544aa452648db\",\"/knowledge-medium/pr-preview/pr-1904/chunks/FacadeVFS-DWLTsDjD.js\":\"bd1be0d8940ea478\",\"/knowledge-medium/pr-preview/pr-1904/chunks/IDBBatchAtomicVFS-BXqaIlBO.js\":\"6992397165563ffb\",\"/knowledge-medium/pr-preview/pr-1904/chunks/MemoryVFS-BkPp5hJx.js\":\"2faf620147a8088b\",\"/knowledge-medium/pr-preview/pr-1904/chunks/OPFSCoopSyncVFS-nSABdPT8.js\":\"d91a57ad5c6642e7\",\"/knowledge-medium/pr-preview/pr-1904/chunks/OPFSWriteAheadVFS-BtyjDsjh.js\":\"beda490580f119ec\",\"/knowledge-medium/pr-preview/pr-1904/chunks/Preview-CqQraC8i.js\":\"121012ced81edcd7\",\"/knowledge-medium/pr-preview/pr-1904/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1904/chunks/card-B9bFjsiH.js\":\"426519ab9f8ae1a3\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-D4HoGe_b.js\":\"f8d74959717ec300\",\"/knowledge-medium/pr-preview/pr-1904/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1904/chunks/mc-wa-sqlite-CHQXI_ug.js\":\"3cebfac3cd38c1f1\",\"/knowledge-medium/pr-preview/pr-1904/chunks/mc-wa-sqlite-async-DGCIhIJG.js\":\"b63aa4ddce172a8f\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-3CtAWioc.js\":\"550fd93c24ed25bb\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-CRulxHaz.js\":\"2b8cd544f2188b72\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-DB2B14P8.js\":\"ef323de3f076eee0\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-DJSGOyAN.js\":\"8ea1306fecde07cc\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-DV7mmi_L.js\":\"43d4978edd9eb48a\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-DjXLvJ77.js\":\"d3c4a1452bcd3282\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-XF0uXIcW.js\":\"5d6316fa02581cfd\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server-legacy.browser.production-D6sLxgoZ.js\":\"92ccb9e530b61527\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server.browser.production-P5HmQj1v.js\":\"5f57c712020da00c\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server.edge.production-ZJ_3iJW1.js\":\"3d49fa49e4c887d7\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-ezyoypf8.js\":\"9aa4b12d87d8b265\",\"/knowledge-medium/pr-preview/pr-1904/chunks/server.browser-BHk_6Ylb.js\":\"c66e2e39ec15ff99\",\"/knowledge-medium/pr-preview/pr-1904/chunks/textarea-Bi0JHEvL.js\":\"1a27dd9822c70320\",\"/knowledge-medium/pr-preview/pr-1904/chunks/ui-Ufb38ApD.js\":\"3eae8dfe89b679de\",\"/knowledge-medium/pr-preview/pr-1904/chunks/wa-sqlite-D7BuUaaA.js\":\"cf882e46564c3495\",\"/knowledge-medium/pr-preview/pr-1904/chunks/wa-sqlite-async-D9DWlblA.js\":\"716c106f748a0b7a\",\"/knowledge-medium/pr-preview/pr-1904/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1904/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1904/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1904/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1904/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1904/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1904/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1904/src/App.js\":\"6912089041056245\",\"/knowledge-medium/pr-preview/pr-1904/src/appUpdate.js\":\"46fbdb26396bc8e1\",\"/knowledge-medium/pr-preview/pr-1904/src/appVersion.js\":\"3d939df2ce8b6046\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/initialLayout.js\":\"866d4dd40e42a96e\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/openWorkspaceData.js\":\"af73b9daddd12afa\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/resolveWorkspace.js\":\"e4ebb5ef9afa3356\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/workspaceBootstrap.js\":\"1c0dd6a223c77cdb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockComponent.js\":\"092bf00a0a11c65e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockCrumbs.js\":\"8a82338b0de95af8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockEditor.js\":\"f5db05ba9e72abaf\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockLoadingPlaceholder.js\":\"51a2f7628d8aa3b5\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockProperties.js\":\"b390375f4905fba7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockSearchPicker.js\":\"908a2a468925cf37\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ConfirmBulkDeleteDialog.js\":\"91ac8599032f535f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/DividerHandle.js\":\"d1d09c027f44a7fe\",\"/knowledge-medium/pr-preview/pr-1904/src/components/DraftEditor.js\":\"795a130ea954c7a6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/GutterPill.js\":\"4d9d071b601f0bdd\",\"/knowledge-medium/pr-preview/pr-1904/src/components/Header.js\":\"7409141a20f4b246\",\"/knowledge-medium/pr-preview/pr-1904/src/components/LazyBlockComponent.js\":\"ff13270087268adc\",\"/knowledge-medium/pr-preview/pr-1904/src/components/Login.js\":\"c15c0f603cfebadb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ZoomableSurface.js\":\"4d9738eab21b71c5\",\"/knowledge-medium/pr-preview/pr-1904/src/components/editModeKeepalive.js\":\"3222a226ea81685c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e7f1ae7a30a1f213\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f5929f474f4b121a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/RefPropertyEditor.js\":\"0dd22f3c689b77dc\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/RefTargetTypePicker.js\":\"305c26cde52d192c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/SelectPropertyEditor.js\":\"0434bed598614223\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/TypesPropertyEditor.js\":\"5ddd9d28057b1442\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/defaults.js\":\"be0082f4c719c73f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/kernelValuePresets.js\":\"0bae074b9b8547b4\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/selectablePresets.js\":\"e0f10e33e0e50b8b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/typesPropertyUi.js\":\"535e76568dfd4fe1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/AddPropertyForm.js\":\"3c8ea5e086601739\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/PropertyPicker.js\":\"39a51acf57f61a33\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/PropertyRow.js\":\"a80cd23e3d8143e4\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/Rows.js\":\"995d097ceb3cde3f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/actions.js\":\"f857bee9cfe33cee\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/declarationOnly.js\":\"fc5fce774c43b7fe\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/layout.js\":\"618b688698c5aa8a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/model.js\":\"1a2fe4375f6f137a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/shapeUi.js\":\"f1e2bfd64718075c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/shapes.js\":\"67f1a4dd50ff8de5\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/usePropertyEditingActivation.js\":\"26d19516cdbe4e3f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/visibility.js\":\"b211b01b65b28463\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanelSections.js\":\"5379da76cd49acac\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockEmbed.js\":\"946d9bbe5834c51a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockLink.js\":\"63a11e56fe610251\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockRef.js\":\"008a143e6b79c9cc\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/CompactReferenceLink.js\":\"fbe368f6d389b7f0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/ReferenceLink.js\":\"a9bab28e9c601286\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/cycleGuard.js\":\"cb7d3b3fa7cc1cf0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/cycleGuardContext.js\":\"baaa3a63b20ea5fd\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/linkInteraction.js\":\"585ffc0c64fb9099\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/referenceLayout.js\":\"7e130959fd6b6863\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/useBlockRefAncestors.js\":\"8e3a451b6a067e32\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockGutter.js\":\"221d7abd39320fc7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockInfoDialog.js\":\"1aa2387c4248f5da\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockReadText.js\":\"6655652a299e4216\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockTypeBlockRenderer.js\":\"6b7c19e61026a0bf\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BulletHoverCard.js\":\"fa016213289b3cf8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/CodeMirrorContentRenderer.js\":\"cb8f7309601cc296\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"d4c8b576b35a3c44\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/ColumnResizeHandles.js\":\"6c9eed614288e8c2\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c39981582fd0efc4\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/DefaultBlockRenderer.js\":\"baf5fecfd2ebfb79\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/LayoutRenderer.js\":\"a5586c3b4dd116b0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/MarkdownContentRenderer.js\":\"bc7703358f7e67a7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/MissingDataRenderer.js\":\"68a9aa08183e4323\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/PanelRenderer.js\":\"c604c6a7621de28b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d268707769dfff5a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/TopLevelRenderer.js\":\"8c46532ca9696e11\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/blockGutterMode.js\":\"29ea906e71530ca7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/blockTitleText.js\":\"a43708b9581da4f7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/fieldCreationKeydown.js\":\"e8b1079c3c44d799\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/layoutRootContext.js\":\"44d6142c22eaab0f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/typeChip/TypeChip.js\":\"bb487d7a9c3cd2db\",\"/knowledge-medium/pr-preview/pr-1904/src/components/typeChip/chipStyle.js\":\"6204a5a7b8521fa4\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/anchored-floating.js\":\"e751ba8ea2423312\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/button.js\":\"5b97ed20a3922e8c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/card.js\":\"19ceccde85a5599a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/checkbox.js\":\"62ba73723cc73e4b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/collapsible.js\":\"30017eb58b5efc89\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/command.js\":\"1a8f25c0ff5c4d6c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/context-menu.js\":\"7b2793344beaf733\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/dialog.js\":\"245591a10058e2be\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/dropdown-menu.js\":\"f3ca4a96742ca0bb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/floating-listbox.js\":\"e6be7309ef4760f3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/index.js\":\"6a68b5c816ea3080\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/input.js\":\"b84acd5bd052f61d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/kbd.js\":\"3e2fcc97e5c63862\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/label.js\":\"e877d6bde3e34054\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/textarea.js\":\"e6e7fb6c2638203f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/useEditModeYieldKeepalive.js\":\"cee7938ae14f0bde\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/BootFallback.js\":\"6f95b881cc583c1b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/FocusedRowLazyMount.js\":\"302b58f09dde0e54\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/LazyViewportMount.js\":\"347f6730db778fc0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/LocalDbCorruptionFallback.js\":\"d7b97ba865419ad0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/error.js\":\"647f33f62547b54a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/lazyMountRegistry.js\":\"30a5b7d17090f50c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/suspense.js\":\"4901e0307a6e5c74\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/CreateWorkspaceDialog.js\":\"8279768069f6ffe4\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/PendingInvitations.js\":\"61bcf9f33031037f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/SyncProgress.js\":\"8f73ebc4cb874991\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/UnlockProgress.js\":\"f5667840e1a8422f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceKeyGate.js\":\"2ef43f03dd870f3a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSettingsDialog.js\":\"909b754dcb1e3180\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSwitcher.js\":\"4e72b2f776710782\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSyncGate.js\":\"c6ac5b059833f6ac\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/ConversionFlow.js\":\"f16734e95e420dcc\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/ConversionFlowHost.js\":\"3a16b0e3df1c8c3a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/EncryptionSection.js\":\"1d15504c08acf5d9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/attachmentPrompts.js\":\"27f11be243f48838\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/bundleFolderPrompts.js\":\"2783f1893165cae1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/conversionFlowDeps.js\":\"192d9fb9b48d3c72\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/conversionFlowStore.js\":\"bb0cd896ff1092e2\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/flowUi.js\":\"1f4820bbece7e303\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/useConversionRun.js\":\"4750055ecca2dcb2\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/keyUi.js\":\"88993622eb52240d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/useCloseOnKeyLoss.js\":\"297a0b630ddd5c05\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/useCloseOnServerE2ee.js\":\"804c65a5ab338215\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/workspaceUnlocked.js\":\"b4b003e0e1180aeb\",\"/knowledge-medium/pr-preview/pr-1904/src/context/backgroundSubtree.js\":\"6cc64e7b7a2373c6\",\"/knowledge-medium/pr-preview/pr-1904/src/context/block.js\":\"53d0cf388153dd0e\",\"/knowledge-medium/pr-preview/pr-1904/src/context/layoutWsContext.js\":\"9d96dfd6ddf6eccd\",\"/knowledge-medium/pr-preview/pr-1904/src/context/propertyDisplay.js\":\"bdb0bb0812a489e2\",\"/knowledge-medium/pr-preview/pr-1904/src/context/repo.js\":\"4aac4628ea76db1c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/aliasClaim.js\":\"44ba0664d097bc61\",\"/knowledge-medium/pr-preview/pr-1904/src/data/aliasSeatNamespace.js\":\"c9d92c11370ba71e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/blockData.js\":\"483a52ce4eaa2107\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/blockType.js\":\"7461426df453b946\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/changeScope.js\":\"8be3ee1a7c259e16\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/codecs.js\":\"9cc6770a9bf9293e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/derivedData.js\":\"426977630fd0cc3d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/errors.js\":\"c1397723e646380e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/events.js\":\"2e4d0af17bb2e4c2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/handle.js\":\"689185102f983a1e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/index.js\":\"77d153f945bfc293\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/mutator.js\":\"35753994f9b0b9c1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/processor.js\":\"01b0c20290033461\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/propertySchema.js\":\"33b84fa7a86058be\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/query.js\":\"39db03f5c57cea44\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/sameTxProcessor.js\":\"9ff92af9e9b6572a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/schema.js\":\"689185102f983a1e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/tx.js\":\"689185102f983a1e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/typedBlockQuery.js\":\"05a151d26d4ce4b7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/user.js\":\"bf4b2084b2101a26\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/valuePresetCore.js\":\"3cdb4b1837de8f0c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/valuePresets.js\":\"a409e98fffe8088c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/attachmentCleanerIOVerb.js\":\"4a8caff3fc19e342\",\"/knowledge-medium/pr-preview/pr-1904/src/data/block.js\":\"c4d81fdead62ff3b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockCache.js\":\"aeb8dd4bdd04b971\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockId.js\":\"afd53f3663d46a51\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockLiveness.js\":\"9615e6dd19b3b1a4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockMerge.js\":\"38a0f72b0003c165\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockSchema.js\":\"a3a5c21a616c0677\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockTypeLookup.js\":\"c53a091ce4023371\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockTypes.js\":\"88e54253d585745c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/childrenView.js\":\"9062fac6015ebafa\",\"/knowledge-medium/pr-preview/pr-1904/src/data/clientContext.js\":\"80e173f8476b7383\",\"/knowledge-medium/pr-preview/pr-1904/src/data/dbFileSiblings.js\":\"3f4aa099e7e9ed4a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/definitionSeeds.js\":\"54847540406d9bfb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/derivedIds.js\":\"ed7d600f95f088ff\",\"/knowledge-medium/pr-preview/pr-1904/src/data/drawnSubtree.js\":\"eb5a89bc7dc10439\",\"/knowledge-medium/pr-preview/pr-1904/src/data/facetBridge.js\":\"1661ee4fd0358300\",\"/knowledge-medium/pr-preview/pr-1904/src/data/facets.js\":\"4d22c6b3c3b1adae\",\"/knowledge-medium/pr-preview/pr-1904/src/data/globalState.js\":\"94a5a241d87f8aa5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/aliasClaimRederiveProcessor.js\":\"8f7b23cf7ed1fddb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/ancestorBatch.js\":\"8adbae661287101e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/blockTypeTypeifyProcessor.js\":\"471c0c967a2d97b8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/clientSchema.js\":\"d10f4ff39ef62107\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/commitPipeline.js\":\"a761acdfb550c8b3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/devAssertions.js\":\"832a971c9e92b659\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/firstSync.js\":\"5e8c9832fd6728ae\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/freshInitialLoad.js\":\"228156a4d9ac0910\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/graphBackfillClaim.js\":\"a5c87617d344aa2e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/handleStore.js\":\"a3a299ebe3d2a71e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/idleMarkerJobs.js\":\"0dda5cc508e7b97b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/initialDownload.js\":\"f745baf2f72dc18d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/initializeClientDatabase.js\":\"541c84f0dba735a8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/jsonCanonical.js\":\"50df67f1d591cdf7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelInvalidation.js\":\"4e93422b824beb27\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelProcessors.js\":\"4243735a7f35944c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelQueries.js\":\"5208bc04fd916fa5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/mergeTypeMembershipProcessor.js\":\"8fa9cc6aaf7a234a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/normalizeReferencesProcessor.js\":\"cc6bf93b51216e41\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/poolInstrumentation.js\":\"830c0ec31ddb99b0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/processorRunner.js\":\"36b07baeeaaf62d3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyCellBackfill.js\":\"f6c98d11e9a50874\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyChildMint.js\":\"098dcaab86cf504b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyChildrenProcessor.js\":\"d1e60a5e9ace8095\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyDefinitionChangeProcessor.js\":\"ccc3458f21152ff7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyDefinitionSynthesis.js\":\"41c3ac7ef763ccd3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyKeyScan.js\":\"3f917dce78380eb7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertySchemaResolution.js\":\"c427b78f0ccc8954\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyValueEdits.js\":\"f8e02cf8c9bf39bc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/raiseProtocol.js\":\"d515ef4d2e009a19\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/readBatch.js\":\"b92a4d4aeea57d07\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/refProjection.js\":\"bcf5204dd04ce9cd\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/referenceTargetLookups.js\":\"641e112b510df3cb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/referenceTargetProcessor.js\":\"1e9a824a5dee165f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/replayMerge.js\":\"c5c53068c6020998\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/sqlBinds.js\":\"c19aebe5fdafea13\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"f3deed2d1c89c7a2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/arrivalProcessors.js\":\"92c60e0b050a29de\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/invalidate.js\":\"c024001ad3e4d1f7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/materialize.js\":\"9f36cd07730ccff6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/observer.js\":\"72e0e116cdaf54ef\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/reconcile.js\":\"a94232496dd9913d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/timingMetrics.js\":\"0819f00c7ffce41e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/treeQueries.js\":\"b61af0280df5919d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/txEngine.js\":\"06c91590b9918472\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/txSnapshots.js\":\"23de928ba7361e8b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/typedBlockQuery.js\":\"98e5021be2cb727d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/undoManager.js\":\"db1502f1d2a60d92\",\"/knowledge-medium/pr-preview/pr-1904/src/data/invalidation.js\":\"8858f73a074c9be6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelDataExtension.js\":\"244187fe93971077\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelPage.js\":\"715d70712f93383e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelValuePresetCores.js\":\"ad6617dd3c3214f3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbCorruptionSignal.js\":\"0d9fad063cbddf34\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbStorage.js\":\"58497071f4486da4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbVfs.js\":\"4674082670d59c33\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localSchema.js\":\"b69928dd085f9e10\",\"/knowledge-medium/pr-preview/pr-1904/src/data/maintenance.js\":\"92f2688a6edaa50f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/mergeProperties.js\":\"905ea62845987156\",\"/knowledge-medium/pr-preview/pr-1904/src/data/metricsConsoleHook.js\":\"66e0d17ddcb18a36\",\"/knowledge-medium/pr-preview/pr-1904/src/data/migrationsPage.js\":\"20c664a69d06d045\",\"/knowledge-medium/pr-preview/pr-1904/src/data/mutators.js\":\"21b1cb32fda5cb27\",\"/knowledge-medium/pr-preview/pr-1904/src/data/orderKey.js\":\"c594f32f5041289f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/orderKeyPlacement.js\":\"4a88a5525e61e480\",\"/knowledge-medium/pr-preview/pr-1904/src/data/outlineSurface.js\":\"32c1e1ed0732f8e5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pendingEditorContent.js\":\"8e389e957f9b911f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pendingUploadsSql.js\":\"1ad1c9884e62a368\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pluginStateExtensions.js\":\"81b6bb170bde0398\",\"/knowledge-medium/pr-preview/pr-1904/src/data/powerSyncLogger.js\":\"6d90b844291b6fde\",\"/knowledge-medium/pr-preview/pr-1904/src/data/projectorRuntime.js\":\"56be84812bd64949\",\"/knowledge-medium/pr-preview/pr-1904/src/data/properties.js\":\"5c56aa9de8deb4f3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertiesPage.js\":\"c1fa422f277b6e5b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyChildren.js\":\"47d47736fa2070b2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionFanout.js\":\"e109b94f9c42ef7a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionMetadata.js\":\"d055abcd0ad32a96\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionRegistry.js\":\"8a3660d1119bf273\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDisplayMode.js\":\"d81aefff2ecd2fab\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyRowCreation.js\":\"e99cc5d555ea8cda\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertySchemaCreation.js\":\"b8bc0a30834149cd\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertySeeds.js\":\"7724c2670fa5b769\",\"/knowledge-medium/pr-preview/pr-1904/src/data/recentsPage.js\":\"5a80f2212a3c0a9d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/refTargetComparableProperty.js\":\"3d65c12f9a6edf3a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/referenceBlock.js\":\"baef983db50ac61e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/rejectedUploads.js\":\"beec20a20b976421\",\"/knowledge-medium/pr-preview/pr-1904/src/data/releasePowerSyncConnection.js\":\"4b3f111d60c46ce3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/repo.js\":\"62e237bb030900fc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/repoProvider.js\":\"95fc7907424e978a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/rowProperty.js\":\"5feedead2d6ea1c8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/searchFilter.js\":\"83f1e3a74a40f1d1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/seedIdentityLedger.js\":\"0c30f35bbff71a8b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/stateBlocks.js\":\"7d8f697246d0c701\",\"/knowledge-medium/pr-preview/pr-1904/src/data/structuralEditPolicy.js\":\"e5fa4086180182fd\",\"/knowledge-medium/pr-preview/pr-1904/src/data/structuralInsert.js\":\"a3af23ec8ddf8bf6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/subtreeDelete.js\":\"b6210969e11fa6b7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncStreamLock.js\":\"f9723b047f01ae98\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncedTableSqlRecognizer.js\":\"b2bb6a5e5123e509\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncedTableWriteGuard.js\":\"891252aeb7796e48\",\"/knowledge-medium/pr-preview/pr-1904/src/data/targets.js\":\"c32e107695530a26\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeColors.js\":\"3e52554f9804c228\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeDefinitionMetadata.js\":\"31524d8d68b97024\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeDefinitionRegistry.js\":\"e374025e18da1885\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeExtraction.js\":\"e7b95abb88f09347\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeInitialValues.js\":\"5c5e6005e751016b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typePropertyGroups.js\":\"7517d887e4878e56\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeSeeds.js\":\"32dfd48213c16a9b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeTagger.js\":\"26606aba23c863e3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typedRecords.js\":\"78cd0f0bd0e53f04\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typesPage.js\":\"12f71c23fe5cc7ad\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userPrefs.js\":\"e529617ff651b44e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userSchemasService.js\":\"d5eea82c3fe846d7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userTypesService.js\":\"63017477880fc2e3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/valuePresetRegistry.js\":\"5d2e2f3bda394a53\",\"/knowledge-medium/pr-preview/pr-1904/src/data/visibleChildren.js\":\"e86603671f1efa54\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceConversion.js\":\"6ff022be2e62bad4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceFirstSync.js\":\"efc5450d1a246758\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceIdNamespace.js\":\"965957bb6e62e02f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceSchema.js\":\"c9a691b7e7bc53f1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaces.js\":\"2e86436c9615d231\",\"/knowledge-medium/pr-preview/pr-1904/src/data/writeAheadLog.js\":\"882ea19ce8cf81c6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/BlockPasteShellDecorator.js\":\"ec32b36953562d4f\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/atTrigger.js\":\"a96c847597b02fdd\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/autocomplete.js\":\"c9bb8f78dd2e5ae3\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/codeMirrorExtensions.js\":\"54f332019a95f7c4\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/contentFlush.js\":\"8a70bc776631c871\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/defaultInteractions.js\":\"9e101295dfb12951\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/editSettleSignal.js\":\"5ef4b39d3be8910a\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/insertImage.js\":\"a35d94717152239a\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/referenceCompletionRange.js\":\"892f3b47127301ed\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/referenceTargetTypes.js\":\"ac5e06043a5ef526\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/syntaxContext.js\":\"19541ed28942010f\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/triggerMatch.js\":\"c8d9c7ffe36c4069\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/AppRuntimeProvider.js\":\"542290faa60f871f\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/BlockFocusShellDecorator.js\":\"c2ad7f6bdfedbd82\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/ExtensionRenderBoundary.js\":\"5e29662c8a54e7ad\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/PanelContentRecovery.js\":\"acd2c1bf34ccfa2b\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/apiCatalog.js\":\"fba8666fd409ec94\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/approveExtensionHere.js\":\"ad4df8920566cff5\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/armedCutAppMount.js\":\"a9fe046ba263fdee\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/batchableKeyedStore.js\":\"eee41efa648c4e7e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/blockInteraction.js\":\"c73b3e43bb5b4be3\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/blockSelectionAction.js\":\"665d36c00e6005fb\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/compileExtensionModule.js\":\"8f67f38ce3311394\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/compiledModuleCache.js\":\"4848035efbe4238b\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/continuousGestures.js\":\"c11e4af1cb9da755\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/core.js\":\"f72e760de038981e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/defaultRenderers.js\":\"b0636189b27b8505\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/definitionFanoutAppMount.js\":\"27f26f4985b9cd62\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dialogAppMount.js\":\"1bd0b0e5759e7db9\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dynamicExtensionSeeds.js\":\"b68738e9f5eb4405\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dynamicExtensions.js\":\"898cc361ce7ce85a\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/exampleExtensions.js\":\"caa5c654619350e4\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionApprovalStatus.js\":\"a7d96dd9cb5eed0f\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLoadErrorToast.js\":\"11c2ad990d0751f5\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLoadErrors.js\":\"d4a6f61b337182c1\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLookup.js\":\"848d263cf5ecb93b\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionToggles.js\":\"62b1ed2b9f388d8b\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionUtilitiesCss.js\":\"5e6cd41ebd7b7a86\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/kernelPageDeletionGuard.js\":\"1a3b8353a9e4ae55\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/liveRuntime.js\":\"7ef4fed28053d95d\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/openExtensionsSettings.js\":\"61e1e4342fb03689\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/overridesCache.js\":\"edf2e0dd12e90edd\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/pluginIds.js\":\"d5f902714ed1741c\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/processorRejectionToast.js\":\"6b5a37172f9f5bef\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/runtimeActions.js\":\"01777c749c28464a\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/runtimeContext.js\":\"f7c2e882bbf5a02c\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/staticAppExtensions.js\":\"d7ffee016c71007e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/staticDataExtensions.js\":\"4bede2a94aba1334\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/toastAppMount.js\":\"92c3a84c29edb824\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/useOverrides.js\":\"157f4bbd82a1b854\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/useShortcutSurfaceActivations.js\":\"81143aac2a13797d\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/discoverToggleTree.js\":\"c69f9b2772b2f435\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/facet.js\":\"23cc0964f8e55655\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/resolveAppRuntime.js\":\"e871b03ee39a7966\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/runtimeEvents.js\":\"3bade4ce15b2fe24\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/togglable.js\":\"ab0a857971929467\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/variantFacet.js\":\"834614d042a1515d\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/verbFacet.js\":\"24507572e2c75325\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/block.js\":\"d88175e8617e1658\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/focusedChild.js\":\"851a4036cb5a8765\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/propertySchemas.js\":\"ab1e977170203e86\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/typeRegistry.js\":\"0ddad694f1b6db73\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useAncestorCrumbs.js\":\"0dd96a4b6729d69e\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useAutocompleteListbox.js\":\"a3dbdb4d55c9d61b\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useDebouncedSearch.js\":\"b0722f8c8ca0ac93\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useDebouncedValue.js\":\"fcfd52d274acb2c9\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useFacetValue.js\":\"e8bf1c87e1faf76a\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useIsFocalRender.js\":\"0ca6cbe953d64098\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useIsReadOnly.js\":\"da37e7e34ddff1ae\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useMaterializeBacklog.js\":\"2fe9b12fa7acb563\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useMinuteClock.js\":\"f8416e5c21c99f83\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/usePanelLayoutProjection.js\":\"4a36de76a7d0b7d2\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/usePendingInvitations.js\":\"4e40f7d8f5be1fbf\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useRendererRegistry.js\":\"85734d59ab8cb350\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useRetainedFieldRows.js\":\"5ae576ab8e41054c\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useWorkspaces.js\":\"a5a2c249a96bf365\",\"/knowledge-medium/pr-preview/pr-1904/src/lib/utils.js\":\"48170356cdde7cae\",\"/knowledge-medium/pr-preview/pr-1904/src/main.js\":\"cd4567cadef87574\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/MarkdownImage.js\":\"8605ab0dfc076301\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/blockSeparators.js\":\"d5438850d3436508\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/context.js\":\"984750befa846f19\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/defaultMarkdownExtension.js\":\"f5ff3b654d3fd467\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/extensions.js\":\"56fbf0d068ec692a\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/renderMarkdownHtml.js\":\"2b8c484c28f42fd4\",\"/knowledge-medium/pr-preview/pr-1904/src/minimal-editor.js\":\"4972d561b43bbc1a\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/armedCut.js\":\"f1794cde79f19d81\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/captureMediaVerb.js\":\"2f3db0b81b3bafab\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/clipboard.js\":\"fedd2c2ab7699638\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/decision.js\":\"6d145ddd2efcac6a\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/operations.js\":\"33458a18579c7c38\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/account-header/AccountHeaderItem.js\":\"ad602eb9e0d30bc3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/account-header/index.js\":\"af4d7b087642dc0a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"dcb8fc927ab399d8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/askAgent.js\":\"3bd5a08126ff1fd2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/askedStore.js\":\"c4a25d6c70e7462a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9d4ed48510096cd5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/chipState.js\":\"37a351161eeaf972\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/dataExtension.js\":\"169e704ec03e0600\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/index.js\":\"d33b421de1671430\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8d05e7982a48fd0b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/schema.js\":\"6eed9d3781d9e9b3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/AgentTokensDialog.js\":\"43cb325f40706023\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/BridgePairingDialog.js\":\"e3aea074103bd990\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/addMedia.js\":\"9530e9cdb11be886\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/backlinks.js\":\"67ce1a22e12b717f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/block.js\":\"ed6c8e966b75fa21\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/context.js\":\"c16fb7830f352882\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/displayIds.js\":\"c34c5872e9e5c889\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/index.js\":\"b4a2adf6594c1c67\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/outline.js\":\"2bf0bbf6021d984c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/properties.js\":\"f8e93834fac2c3f2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/refs.js\":\"eb1017782887f109\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"6210e88bf1e979d3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/search.js\":\"964ccae99a5a7d5d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/shared.js\":\"3966a37eff34312a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c2550315a8c473ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/text.js\":\"cc0117e5688270c5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentWrites.js\":\"284a10f1725c6b3c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/authoringCatalog.js\":\"c25b6634e8e1fbf6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/blockRefTargets.js\":\"d04df3ac57e0076b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/bridge.js\":\"3bb5b9557e8fe399\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/bridgeLoop.js\":\"4bfd4dd3bb3d95c7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/changeHistory.js\":\"12d6cb7f1adbb8de\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/commands.js\":\"5db869e5489316e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/commentsCommands.js\":\"76540003be359c5f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dataExtension.js\":\"6c11b5ff0d06a44e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dataModelGuide.js\":\"39c74d8cfb9583fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dayPropertyInputs.js\":\"0af930f21ee2a92c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/describeRuntime.js\":\"023080abeb8318ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/extensionLint.js\":\"069f343ea1b4e181\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/grainAudit.js\":\"5228337259fbe854\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/healthCommand.js\":\"4107c58eeda2b1ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/index.js\":\"cf796266e41a5855\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/presetIdentity.js\":\"04cdbc9c2701d246\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"ed2890672f81d36d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/readMedia.js\":\"7d185ed9c8e295da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/schema.js\":\"5b5e6f9a261abba4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/serialization.js\":\"15596170f3555cca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/targets.js\":\"63dd92cce7bb4707\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/tokens.js\":\"9bbfcf4fd7db9e2d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/watchEvents.js\":\"2e10c9fd64979871\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/workspaceGuard.js\":\"878422105e8eaa2d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/writeCommands.js\":\"1210fe1c20212a02\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/AliasCollisionToast.js\":\"0e41c5f925e6603c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/DuplicateNameBanner.js\":\"18f72f912852b960\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/collisionMerge.js\":\"ca567bafba47892a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/dataExtension.js\":\"cdacc7d53f5b58f0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/index.js\":\"395aa509fe40f4b4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/mergeCollisionAction.js\":\"6ed3469b1d4a967c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/pageStyling.js\":\"6f48797feb968a54\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/rejectionToast.js\":\"4ba66e3e4daceab2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/syncProcessor.js\":\"92acf5a3651ea75b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/actions.js\":\"619066e545dc256f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/addComment.js\":\"95d085684ae43620\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/anchor.js\":\"c90491c43c5593c1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/anchorState.js\":\"4d08135844723caf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/commentLinks.js\":\"e44683492d807e05\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/confirmThreadDeletion.js\":\"552c9c8365001e11\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/container.js\":\"d96f14545b2a8d2b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/dataExtension.js\":\"6f6c1478891494c1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/deleteComment.js\":\"5231f601dcafd3a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/highlights.js\":\"d6a9b048e1ef27e7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/index.js\":\"0a17ba451f78bd5e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/linkedCommentsPill.js\":\"b07f74a1ea30e33d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/margin.js\":\"de2e002ef26ea6b6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/marginAnchorLinks.js\":\"0ef10c3f88bb2699\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/marginSchema.js\":\"1a0ece78e0c74e43\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/newComment.js\":\"0ab6de329c64d359\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/ownThreadPicker.js\":\"0e16b12dee224608\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/placement.js\":\"6e866a1a38909044\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/queries.js\":\"f00013f15c48fae2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotePosition.js\":\"45ad428d1a5fabdb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotedIn.js\":\"39fdfd3dc5bf0d18\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotedRange.js\":\"f92d9de637a083ae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/rangeRefs.js\":\"9ba0b64e3f4eaf24\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readHighlights.js\":\"9862a352577b6496\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readSelection.js\":\"a4be205003f42724\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readSelectionUi.js\":\"bbd86972f154d328\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/reanchor.js\":\"15ff6273ded615be\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/schema.js\":\"5c86c3cb4ca20d00\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/scope.js\":\"8ca5c95cd7d9986e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/scopeThreads.js\":\"75887cbeb1cfbd47\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/splitRetarget.js\":\"733f5f34d265c52f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/suggestionCard.js\":\"b0a3010e8e3dc629\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/suggestions.js\":\"5450c0eaf739ad4c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/summaries.js\":\"0231fdc887fe9166\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/summaryBatch.js\":\"5aa31ced2b0fdd08\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/surface.js\":\"d62481a65794fee9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/threadNavigation.js\":\"9a3b132abfdd52c0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/threads.js\":\"1d504cd6781bd460\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/ui.js\":\"65bc82996b2a1f4c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/uiStore.js\":\"5a073cfb4fb011ee\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-intents/appIntents.js\":\"4d56714099a53d6d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-intents/index.js\":\"89eda559f773f62f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-update-prompt/index.js\":\"a984c280286ad02a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-update-prompt/status.js\":\"70ab4f37f976e340\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"ddc3da5c0fca700a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaBlockRenderer.js\":\"85711fe89f89489b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c66b4d1f124b58e5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaUploadReconciler.js\":\"79b50d58ae8b4c18\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetDownLane.js\":\"3d7994b084b0c15c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetResolver.js\":\"629268c32d94d753\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetUpload.js\":\"90dfef1d9dcb6919\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/attachmentCleanerIO.js\":\"535a7754fff73d42\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d99ff1252c3c0aba\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/blobStore.js\":\"1aee2caf7949ad67\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/browserMedia.js\":\"6dbceeb0fb812ecd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/byteStore.js\":\"e6403cc811d646fb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/cleanerIO.js\":\"73f276fb27954530\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/cleanupAttachments.js\":\"2ba60c61fcde2cc3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/dataExtension.js\":\"2885596a4ab8c74a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/downLane.js\":\"dfb0677df1403784\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/index.js\":\"15f7241da59570c9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/insertImageContribution.js\":\"3296ebdbcb9c3b85\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/laneArming.js\":\"905fb2ecf22a8178\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/laneLock.js\":\"e38c032d4cd87734\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaBlock.js\":\"cbb8ea1cd483323b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaCapture.js\":\"a09565b00cc235ee\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaLanes.js\":\"3ec79ea9faccd4d3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaViewers.js\":\"1be263002100a3c4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaViewersFacet.js\":\"b7952c4caf94bbab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/pasteCapture.js\":\"e9f135b6174ed92b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/resolver.js\":\"ed2353bfe27b7777\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/retryUploadsAction.js\":\"d8b88e5f69bc21ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/storagePaths.js\":\"58fcb0ade1db2dc3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadDrain.js\":\"0bfaf5ccfbeea927\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadLaneStatus.js\":\"ad500998e66c232d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadReconcile.js\":\"4a60ee73efc5767d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadRecovery.js\":\"e868c49e4788857b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadStore.js\":\"8850e15f88b7d9e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/useAssetObjectUrl.js\":\"120c5b25e68005a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d60935bd79e2d637\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/BacklinksViewSection.js\":\"32ee372095af26b4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/facet.js\":\"89efe90e65a66b9a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/index.js\":\"2111f6605af7d04c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/prop.js\":\"e925f19cf7e155f8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BacklinkFilters.js\":\"93891598ed97089f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4f4b91ed26283f37\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BlockEntry.js\":\"59cae099f6060abc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/LinkedReferences.js\":\"e37338b37dffaeb7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"48ed07e9d7a486f8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/dailyNoteDefaults.js\":\"ee0976160274c2d7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/dataExtension.js\":\"bfe250ce810ae179\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/edgeExclusions.js\":\"829b82b12453e16d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/filterProperty.js\":\"ae7f45b9d5e0a796\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/index.js\":\"9dd8fac943f76541\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"84184b05e24b30a2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/applies.js\":\"4873af8c9f149871\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/countQuery.js\":\"d3460bd1e184706e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/expansionStore.js\":\"c61bca4043e67c3a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/index.js\":\"f4829796e3cb31db\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"98bba88db7b601b7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/presentationInvalidation.js\":\"4479524bdbb7261a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/propertyEditorOverride.js\":\"8de3ac9d52267f06\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/propertyFilter.js\":\"5390d3c95b28d0ff\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/query.js\":\"4ee803d2cfdabdfe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/resolveFilter.js\":\"fcc8b76bade29edf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/sourceBatch.js\":\"23fe8de6e73712b9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/sources.js\":\"baa452143bf42afc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/useBacklinks.js\":\"01f3de48fc6202c3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"db3b4578da007335\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/BirthdayCelebration.js\":\"bcc1105ca2cc6a98\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/BirthdayOverlay.js\":\"61b5ad1bfb127fa5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/gate.js\":\"7d35ea525518d0e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/index.js\":\"8c150aa770fce5eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/wolfTheme.js\":\"c420be7224eeae40\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/BlockDragLayer.js\":\"4021257c528a32e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/dragController.js\":\"d849ff16fe14c708\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/dropTarget.js\":\"57bad71ef679f9a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/index.js\":\"7cf658881ebc0ada\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/projection.js\":\"2189ade6815ce091\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-info/BlockMetaCard.js\":\"b95837e6e24472d5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-info/index.js\":\"77861f3f57fda211\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/AddTagDialog.js\":\"be5bc7f9979a452c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"ef8bfa6db10adf32\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/TagNameIssueHint.js\":\"235ea54143091668\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/addTagAction.js\":\"13dcbd5fec0e5e17\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/appendTag.js\":\"261c8f86c98507a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/config.js\":\"c64c9f0e40aface5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/dataExtension.js\":\"c6df7bdb0453a6b9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/index.js\":\"60ae3ca7c99a3b1e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/propertyEditorOverride.js\":\"1933707cb783fd9b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5c5c30c52dbc5f27\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"628b1bdd6f4a655c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5cd5b1f9f5179930\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b29c0d630b48cf8f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"da8063e2d3bec8e5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/index.js\":\"e7b87bead1eca528\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"ebb83201efa6c998\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/CharacterCountItem.js\":\"728443a18d751dd6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/ProfilePropertyEditor.js\":\"2e9f54280a190c23\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/actions.js\":\"95b2adb586a954de\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/blockType.js\":\"7b40f0a5196e158f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/charCount.js\":\"2c4ec65d01085532\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/dataExtension.js\":\"9cfbdb3f912aaab0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/index.js\":\"2ab744f90cccadb7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/profiles.js\":\"be487bca350b34f6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/properties.js\":\"b1a2ab98e103836a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/subtree.js\":\"bc53535ee2401c56\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/textCounts.js\":\"2fc457fd3b751cca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/colemak-keybindings/index.js\":\"e3b7a9fc8c458dfd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/CommandPalette.js\":\"c466d4e0bf775c10\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/HeaderItem.js\":\"7dae57f1df8e70ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/context.js\":\"2016f8ff1c4beb0d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/index.js\":\"de0ccb19af6ccf82\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/selection.js\":\"cd9afd03b7ce106f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/toggleStore.js\":\"3a2faba7311a2977\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/useCommandPaletteActions.js\":\"29ce0ceea7c21144\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/ContributorBadges.js\":\"7ff9cae7eb0d10e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/ProfilePicture.js\":\"b380a1a8c9cff25d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/author.js\":\"4c67d167f35b20ad\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/codeMirrorExtensions.js\":\"8c21278296b21e78\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/dataExtension.js\":\"53cd186738ad7aa4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/index.js\":\"8bb34e77ffc16516\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/mentionAutocomplete.js\":\"0d5a433d3bbaa42f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/processor.js\":\"5a46a906ff778098\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/profiles.js\":\"fb7d4ec2a2c3b8cf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/queries.js\":\"df358da1c5a9e5cd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/schema.js\":\"ea4add6d94dc1828\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/useCommentAuthor.js\":\"f4ed942e51f863d3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"843a392a6a52b455\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/followOrigin.js\":\"659dc489b73aac39\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/index.js\":\"44972437a6f0549f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b04865f4c3a9c547\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"479771408d556a6d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/CalendarGrid.js\":\"0274f212ee95220d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DailyNotePicker.js\":\"432c4b1b8412cf14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"ee82c27169134fca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateNavDecorator.js\":\"0431feb9acd2085b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateScrubOverlay.js\":\"0cd3d4e015e6ae00\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DayPropertyControl.js\":\"49013a91c7ad66bc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DayValueReferenceControl.js\":\"54ace3dddc5da832\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/HeaderItem.js\":\"8fc07987dcd254c6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/ReschedulePicker.js\":\"958e176a5b35701b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c0d8a31936f7fb5f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/actions.js\":\"f057ec485c686e03\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/blockDateAdapter.js\":\"dfd7addaf3e7505c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/calendar.js\":\"d58fe9ed963431e8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dailyNotes.js\":\"c34cfe2c58fc81d3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dataExtension.js\":\"1151e38c224aaddf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubActions.js\":\"11af2a2e695b3e7b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubGesture.js\":\"fded5cd036f3038f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubGestureActions.js\":\"05fec58a6aa61eaf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubRecognizer.js\":\"bb1b41f7002e5fc4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dayProperty.js\":\"b9455ab0ad85171c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"d8b8136716db1eb3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/deletionGuard.js\":\"6cee3f5e807ec6b2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dueQuery.js\":\"8bae8ace78831704\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/index.js\":\"0c52509b304da9c1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/landing.js\":\"45a0e72614bd8697\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/localSchema.js\":\"12248b0cf9f23693\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/referenceDateAdapter.js\":\"4c2360d1acb1a26a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/rescheduleAction.js\":\"b8011933f1f1ea3f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/schema.js\":\"505a5d59240ba2b4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/spreadBlockDates.js\":\"dad784c2d0ffa209\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/spreadDatesAction.js\":\"e4fd7be242306d71\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/today.js\":\"2fec43ef25afc0c6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e7c3654bdcadaa1a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"68c63ca6a9167ad1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/audit.js\":\"b12da0825df63c33\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/auditAction.js\":\"7f56321b22967bde\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/auditRanges.js\":\"f17fb012b4387c6c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/diagnosticsSource.js\":\"c3514b598cf784b4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/divergenceScan.js\":\"ac7e315e0e4597d3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/index.js\":\"c0ae8f408dd1c75c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/propertyChildrenChecks.js\":\"a4c86b543dab4c85\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/referencesMirror.js\":\"9193752bcd7ef16e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/rowJson.js\":\"19c3595c6ff13b90\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/schedule.js\":\"aec46a25b8f93292\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/store.js\":\"82cbeceadb3824af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/action.js\":\"a7c80fd51d2bee28\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/index.js\":\"7de97671db4e1f82\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/plugin.js\":\"fea59eaa7a607c38\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"7e2aa3c62b60d5ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/actions.js\":\"743bbfd23accb415\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/changeMarker.js\":\"57238c6b28a8dbee\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/diagnostics.js\":\"9faa51472bc4e12c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/fileSystemAccess.js\":\"537cbdf406abcdf4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/filenames.js\":\"2b40224ccacfc31c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/index.js\":\"c1a5e2b8139f746c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/mirror.js\":\"72e71f455525eedc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/runLock.js\":\"ee23cc98acfa8899\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/runtimeHealth.js\":\"3c02a2d86ff116d0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/schedule.js\":\"c87d306f6073189b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/store.js\":\"ea28840490e64be9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/default-themes/index.js\":\"59aaf92e8d29d735\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/default-themes/themes.js\":\"ee4e5e55b2b21f12\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/diagnostics/facet.js\":\"998153e491754ced\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/diagnostics/useDiagnostics.js\":\"2268470b91f3e109\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/dismissals.js\":\"c6849b5e2bd5253b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/index.js\":\"b185d267b682740d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/status.js\":\"dd0fe88f888638d4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/store.js\":\"41f71e6a27ba1e4d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"ac80690626a2bf32\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/ExtensionsSettings.js\":\"96b7ba992fb66c91\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/actions.js\":\"896b6c456116ea0d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/config.js\":\"400c4b1668edf268\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/dataExtension.js\":\"b32fc0a859453188\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/effect.js\":\"8f026e213ca157da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/index.js\":\"ca3ae4ec0681defc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/propertyEditorOverride.js\":\"45392c6d51a45dc7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/useToggleTree.js\":\"ca0b7c31a6ce106d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/ExtractTypeDialog.js\":\"ed52e922a0a1e5fc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b56be44a7204c4fe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/PropertyShapePicker.js\":\"2e0fdff9d491fcbe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/action.js\":\"88a940b51e0ca3a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/index.js\":\"8f38d63ab0e3135a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/FindReplaceDialog.js\":\"8f08e6bbb16b8e7d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/HeaderItem.js\":\"70dbb11f7cef6127\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/dataExtension.js\":\"5ed75b9692d53eb5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/index.js\":\"4b553aa54aa8c830\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/search.js\":\"04499f53dd236084\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/toggleStore.js\":\"9a78325fe80bf9de\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/LocationPropertyEditor.js\":\"6ede7d9a1ab69bc4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/MapView.js\":\"0251df88c530fac6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/blockTypes.js\":\"590f9d6108b11841\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/codeMirrorExtensions.js\":\"7cd3baf98f9745f8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/createOrFindPlace.js\":\"a5a2c643736af737\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/currentLocation.js\":\"4014490ccc0c10a7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/dataExtension.js\":\"b404b55f410dbfa5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/geoContentDecorator.js\":\"da98e6d219e13e96\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/googlePlacesClient.js\":\"4bee011ba9a5eade\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/index.js\":\"31dbf676b1e91f8a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/locationsPage.js\":\"9a5c76a4b6f46e55\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/mapViewport.js\":\"13a3ab74d4722a4a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/pickCurrentLocation.js\":\"fce477284fc884c2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/placeAutocomplete.js\":\"83e3d80dff7defbc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/placeNameCollision.js\":\"35d99aa19656330a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/properties.js\":\"c64cf3158c5638e8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/propertyEditorOverrides.js\":\"698387c8122e2480\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/query.js\":\"ce05e1dc32530462\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/usePlaceSearch.js\":\"c9663754d45ae669\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"98dfe90913f02999\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9bc168684c7742a8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"90a025a6ab021d43\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/config.js\":\"c9e4daa186c543ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/dataExtension.js\":\"92402c0a89424296\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/facet.js\":\"d8e09057fd05d1d3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/grouping.js\":\"50332a1467fe2ef1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/index.js\":\"d73bd0b8c4af2427\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"952c654446f735ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/query.js\":\"416aa57cda84ffeb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/resolveConfig.js\":\"1bc8cdd3b3b6cc99\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"6b7408d782d8147a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"0b6a48634dc36454\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/HtmlDocumentContent.js\":\"0f3d5882aec8667a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/HtmlFrame.js\":\"a13c9fb8d4096bdc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/actions.js\":\"49aea8b5a39ccfdc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/blockType.js\":\"1de1923a2e26059d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/confirmRunScripts.js\":\"120e80d87ca48519\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/dataExtension.js\":\"fac600ccbc429d47\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameAnnotations.js\":\"51a69d1c0c11d410\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameDocument.js\":\"b4ecd43c937bb732\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameTheme.js\":\"885841ef189f6bf2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/index.js\":\"82a2912b98e0684c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/scriptConsent.js\":\"85b213a19764e603\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/sourceMap.js\":\"574cbc19ab3f8325\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/useDocumentScripts.js\":\"b0db8ec15f35c25d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/index.js\":\"765645264d294df0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/record.js\":\"ea508d9725b71005\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/recordStore.js\":\"e259ef480cd6b99f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/responsiveness.js\":\"5ff5fce3c76d536f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/schedule.js\":\"7152589892c744aa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/sessionContext.js\":\"c51a8bbaa43eb493\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e0fcfba6fdb8838b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3971926ef806a779\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/actions.js\":\"cdd4fbbf73ae2743\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/config.js\":\"a869d2ee39c3b46b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/dataExtension.js\":\"82fad79fd913b680\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/effect.js\":\"4d251564cf96dac7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/index.js\":\"6dff24125ff97006\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/keyCapture.js\":\"53093e0af7eda2c8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/overrideStore.js\":\"630369d9387115a4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"046aa0887feee74f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/HeaderItem.js\":\"c316c619e07fe648\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/LeftSidebar.js\":\"420666e65d81994f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/actions.js\":\"61f7eb856a8713f6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/facet.js\":\"58f99c08d547abf4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/index.js\":\"898417146ded8bfc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/shortcuts.js\":\"69e88c950009d331\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/toggleStore.js\":\"32af50b8398a8dc5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/MergePicker.js\":\"5e259688ae4a11b5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/index.js\":\"98bdfc32a02fff9a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/mergeAction.js\":\"03746f4fa1e6f3d6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/strategy.js\":\"b110ad22f603723e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/Button.js\":\"952203a1b3b2bb09\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ac42fd343cb7bd0f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/defaultItems.js\":\"15dc3c968084c84e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/facet.js\":\"71c5e41e4a641de7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/index.js\":\"9510cb8a6b018142\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"05bc86dd19dc88c4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c7516b7de70f7ef5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b4217a1a4fbd5e56\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/facet.js\":\"f89da881907bac2f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/index.js\":\"099e6c4b306d0a0c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/MoveDestinationPicker.js\":\"d577c3e55fac07c2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/blockSubtreeMembership.js\":\"4a9738a7db1e4f09\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/contextMenuItem.js\":\"19efadfcd5fa4451\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/index.js\":\"be26147d36282792\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/moveAction.js\":\"4fe4ab0fd0b639fe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/moveBlocks.js\":\"54272382315b42f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/selectionAfterMove.js\":\"34378f90bf7fd2d2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/TutorialBanner.js\":\"db3cc1310bc997cd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/action.js\":\"95637796443e9271\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/bannerDismissal.js\":\"fe458edcee88c818\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/documents/cheatSheet.js\":\"a339c505766fe7eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/index.js\":\"64300199db43b8d6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/keys.js\":\"2809136f6f115836\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/landing.js\":\"b735f2fe856b88c9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/outline.js\":\"d47f0d73edf9d18f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/seed.js\":\"c75b30c198d8052b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/PerfTrendDialog.js\":\"4765f6774d9e4382\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/analyze.js\":\"e0f702443f5ffd2a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/diagnosticsSource.js\":\"887e4770dc355f49\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/index.js\":\"0201d599e208aad1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/load.js\":\"9e087c1a204928eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/monitorRun.js\":\"4c60b2cc30a7cca1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/schedule.js\":\"bf8eccf6a5d665c5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/series.js\":\"e83c9715034b72b1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/store.js\":\"468cdb88c8ee5f73\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/trendAction.js\":\"d0a8aa28f1456ec3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/verdict.js\":\"cefab66cb017d923\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/clickToEditAction.js\":\"ec9f057841aef6cf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/index.js\":\"db6268e93c17b95e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/interactions.js\":\"22ece02285e71d62\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"957cb83a078cb301\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/MigrationGate.js\":\"8427085ab7afe7b2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/MigrationGateDialog.js\":\"bb92aea2722a5296\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/action.js\":\"9c734001b27d2eee\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/index.js\":\"57647512e1854f95\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/localRunMessage.js\":\"8d875db2f1d722c9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/plugin.js\":\"82e0f681fc54f02d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/progressReport.js\":\"07dba497034286b3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/sweepProgress.js\":\"6932bffcf46bfee2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/FieldRowRenderer.js\":\"a036f8617693d301\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/ValueRowRenderer.js\":\"9f28ac405ca23b5a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/actions.js\":\"99f07d70a2edb952\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/autocomplete.js\":\"73a64c54fae0d020\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/fieldRow.js\":\"049d75961d81fed6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/index.js\":\"f20cf8854dad880d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/referenceWarning.js\":\"24cfabab7f134983\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/valueAutocomplete.js\":\"31f5ea56e78d43ee\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/valueSchema.js\":\"dc27e9e26fd4e95c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/HeaderItem.js\":\"8a0334feae67452f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/QuickFind.js\":\"baa5d121a50b1564\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/index.js\":\"e63890b086ac7d62\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/recents.js\":\"270cd661a83fd2ee\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/resultItems.js\":\"5f1f26d3bec26023\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/selection.js\":\"42ca32c2d4d3655d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/toggleStore.js\":\"c6c96b69d65216d6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/HeaderItem.js\":\"d45a3e477d1937bb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/RecentsPageBlockRenderer.js\":\"45305068b6b97c96\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/grouping.js\":\"97ec2a5a8ba65a7e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/index.js\":\"bf58e0c6d670b010\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/target.js\":\"0efd59a960c667c6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/codeMirrorExtensions.js\":\"768fe41888441133\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/contentPrefill.js\":\"19a61ac91ab85b40\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/dataExtension.js\":\"eeeabae0c5386b29\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/index.js\":\"2ad3e043a6db960a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d26e4317fa2bc6e5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/invalidation.js\":\"a34cfa23e6f59bd8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/localSchema.js\":\"158ce27d7cb12497\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/blockrefs/index.js\":\"3de2e0b3503767e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"fdfe9ab9665cf348\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/index.js\":\"5efd33961bc5de45\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/referenceNode.js\":\"baee1e16e6f0ff32\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/remark-reference-occurrences.js\":\"742e1ce816d88f88\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f141660d0012edfd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/index.js\":\"6d72e868b2ea1a23\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"bcdcc2edf232770f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"0557f2f250528ecd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/mergeRetargetProcessor.js\":\"d33c5a819cefbbb7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/parseFence.js\":\"c3c87abd1029282d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referenceParser.js\":\"cbeb42dd74c34909\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referenceProjection.js\":\"d21216ab6f513b4b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referencesProcessor.js\":\"c6d2d828608f294e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/renameProcessor.js\":\"e706b67ff1f89010\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/spanReplacement.js\":\"c99864199e817c57\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/htmlToOutline.js\":\"d1a2f604b34c2c01\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/index.js\":\"b9bd93ed451b4f35\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/normalizeClipboardDom.js\":\"0ce0cf7d764153b9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/pasteDecision.js\":\"e47783691d8d4573\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/action.js\":\"26d23c9bbfce6aca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/blockIds.js\":\"0eca722b54598c8e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/content.js\":\"aa65ad7b10809af6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/effect.js\":\"3df27d5459adf4b8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/ids.js\":\"35bd15df5c4c27e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/import.js\":\"3954a2284b1eb9c7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/index.js\":\"5282569954de75de\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/plan.js\":\"10d6e7d98e41f4a8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/plugin.js\":\"63050cb53d9a653b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/promotion.js\":\"b028c194e19096c3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/properties.js\":\"2de20123cedfc8be\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/references.js\":\"919ddf4a7cb37066\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/report.js\":\"d3250b97eab7b690\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/roamMemo.js\":\"3db0eb480c237fac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/runtime.js\":\"111f61eaebdc6538\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/schemaReconciliation.js\":\"48897db4b5723349\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/srsMarkers.js\":\"8cf0c9079a168bed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/todo.js\":\"3833aa1f73bd09a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/typeCandidates.js\":\"ff3bcebfe68cb796\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/types.js\":\"101e558001bb6114\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/search-health/index.js\":\"25ffda88f2d1409e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/search-health/store.js\":\"c4d75f0c8e595f0e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/HeaderItem.js\":\"5a021f1915cd03b5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ba5dfb56fabbf70b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/index.js\":\"1ba21fbb2d306216\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/model.js\":\"d757b506c0fd8a9e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/toggleStore.js\":\"dbd1553dbee188f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/useKeyInspector.js\":\"476abf718b1dbd89\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c435f706c260364c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/ShellDecorator.js\":\"471a053243972f3a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/actions.js\":\"b87c88ec1a93558a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/exclusionsFacet.js\":\"cf2db46275edda4c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/index.js\":\"c1c9f786453875ce\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/shell.js\":\"88bd6344bd7b209d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/surface.js\":\"28ed9bc5bca3f071\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/walker.js\":\"899d1e2b3744a9d6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/RescheduleToast.js\":\"199b170780e6403b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/dataExtension.js\":\"b39cffd71fa69083\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/index.js\":\"2ba3971753697769\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/indicator.js\":\"778fc7d3273bd5ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/moveSrsState.js\":\"361a91fa739a335d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"1f0134d60b4a224f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/scheduler.js\":\"1c0f3882831cd307\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/schema.js\":\"4d7a237bc1796ac3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"976733b8acacc8d5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/srsClipboard.js\":\"21012b9359a21435\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"22dae2681fb9fe5a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/DailyNoteReviewHint.js\":\"286e0a672c9b5ed3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/DeckPicker.js\":\"560ee5a42a3ce622\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewControls.js\":\"f1b6189e282acac1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewDeckRenderer.js\":\"fa3e47f6ed0d66ea\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewSession.js\":\"1be9e32a02cb89e5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/actions.js\":\"5277d7d5111ab946\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/archive.js\":\"93fb4c0c677c24d3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/dataExtension.js\":\"75e24d47b044d94e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/deck.js\":\"31fc3d6ac45e5779\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/dueQuery.js\":\"0dca1ea6f77d8bb2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/gradeDecision.js\":\"da5923c6a4772fef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/index.js\":\"c8e6fcea21312f9d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/keyHints.js\":\"e727922539c7bf78\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/reviewCardLayout.js\":\"a1ad6040e786b696\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/reviewProgress.js\":\"70ec6cd1ac4c8512\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/schema.js\":\"19af1e71fa359d0d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/useDueCards.js\":\"58b435a530060818\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/startup-metrics/index.js\":\"f526a5bde9165307\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/startup-metrics/record.js\":\"857e5c510c7dac1a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/index.js\":\"53397006ffefb932\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/persistenceStatus.js\":\"62bf10414a0a1903\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/requestAction.js\":\"d4d77265daa893d8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/TypeChipsDecorator.js\":\"7e2f9c5bfe526516\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/codeMirrorExtensions.js\":\"2435902a2984e474\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/index.js\":\"d163547336eda4fe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/typeAutocomplete.js\":\"185578119a39dcc1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"bdf63d3d3cfce52d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/actions.js\":\"f1097f498f8ac452\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/anchor.js\":\"b1de5eccc075cff1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/events.js\":\"94d8be26db13a74f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/gestureActions.js\":\"0d90efba753f3b28\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/index.js\":\"808d546e42f1aabb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"a5159c5e5b31dbf0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/collect.js\":\"9cad6782a94e6f76\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/index.js\":\"8e1bdf87710b4ff0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/record.js\":\"ddfa27ae24a025a1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/RejectionDialog.js\":\"a96b6e092da75a6e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9dfa1567fd47e33a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/index.js\":\"1cc31e72eb12863e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/model.js\":\"2c829c74227f2b62\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/queueCounts.js\":\"0772a7afe2250f4a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/rejectedHelpers.js\":\"1ae6ed69c6e3968e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/rematerializeAction.js\":\"940b8fc6e5ff20db\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/useHysteresis.js\":\"db65982542637ef9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/ColumnHeaders.js\":\"be471da36a6caab7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/QueryUi.js\":\"848be4452677d202\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/TableLayout.js\":\"969baf885a882108\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/actions.js\":\"f6f42495b1c8ed40\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/cellEdits.js\":\"b15183faa3e2b8fb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/childrenViews.js\":\"39199dc352ca1c15\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/columns.js\":\"051e6acec5719aaf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/controller.js\":\"5cceda3f987ed402\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/convert.js\":\"44514c5a3a15fd1c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/dataExtension.js\":\"b36a347f35ee56af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/index.js\":\"732f8738d2b668da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/keys.js\":\"63d055aa313ad3f7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/model.js\":\"81935082295a6a58\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/QueryText.js\":\"425874a3c7f0751b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/backfill.js\":\"c9a7a4614967a2d9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/completion.js\":\"9cfdbbaec478e768\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/format.js\":\"e9f320abe95204a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/parse.js\":\"b6ef71d20f738842\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/queryValue.js\":\"b418bcd17da28fda\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/registrations.js\":\"8ae533b8301caf14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/source.js\":\"b8d410519b305f2d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/registry.js\":\"654ab81d8485ca51\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/rowGutter.js\":\"f6b46a1a58a48a8a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/rowVerbs.js\":\"d1d0b039243b1613\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/schema.js\":\"b34deaa732e3d396\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/sort.js\":\"57e8ef8fc5a3b675\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/effect.js\":\"606d18a726678abf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/index.js\":\"552938fcb0289af0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/theme.js\":\"20e61f25fa57c155\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/actions.js\":\"1546240c1c8cc773\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/dataExtension.js\":\"01779df64d793d5f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/index.js\":\"8bef191a919557e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/schema.js\":\"8a0281fa398aee02\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/TouchSelectionLayer.js\":\"f34bc179792b051c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/actions.js\":\"cc7e8686b5e4c67d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/defaultItems.js\":\"fe82c3f4c196aae0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/facet.js\":\"32db09e10e3625c1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/holdRecognizer.js\":\"9bcb24ce46508a6e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/index.js\":\"331d6cb4a0f4c660\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/UpdateIndicator.js\":\"c4b7c0fb0b5c8a64\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/index.js\":\"f1a0a5056947d2f9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/loadTimes.js\":\"8d9fe9cd1d6ee9c3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoNotesRenderer.js\":\"894bd12204838178\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoPlayerRenderer.js\":\"beab5edfe280b78c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoTimeStamp.js\":\"301a765e659de890\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/actions.js\":\"416e6d715c561043\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/index.js\":\"4a91ca55227fafe3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/markdown.js\":\"197a57e01c327060\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/notes.js\":\"1d664024053ee9e4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/registry.js\":\"7545de76f87d4275\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/remark-timestamps.js\":\"cbadb6141a23370e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/view.js\":\"19e120da5173dd1c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/LinkHints.js\":\"2cb9d432d6c8149b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/index.js\":\"15907bf7bb853f67\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/model.js\":\"c0be946f689602ae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/settings.js\":\"42846c1d9e3fefdb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/actions.js\":\"74c281ad6e17cfa9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/index.js\":\"64fd6b88e2700361\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/interactions.js\":\"035c3cdf3c96dae9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/workspace-header/index.js\":\"139304e322c143e5\",\"/knowledge-medium/pr-preview/pr-1904/src/registerServiceWorker.js\":\"f66645e61a9e8206\",\"/knowledge-medium/pr-preview/pr-1904/src/requestPersistentStorage.js\":\"5edbadc69a595e75\",\"/knowledge-medium/pr-preview/pr-1904/src/services/authRequestDeadline.js\":\"283e8bdc19a08a10\",\"/knowledge-medium/pr-preview/pr-1904/src/services/authStorage.js\":\"9c5da48ef40bd8f8\",\"/knowledge-medium/pr-preview/pr-1904/src/services/powersync.js\":\"9403c67b544fd2f5\",\"/knowledge-medium/pr-preview/pr-1904/src/services/supabase.js\":\"0ae90f0fa145f562\",\"/knowledge-medium/pr-preview/pr-1904/src/services/uploadErrorClassifier.js\":\"f146dcbe991f4127\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/ActiveContexts.js\":\"c11bb0879a143679\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/HotkeyReconciler.js\":\"6193b5255f7ed1ea\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/WipeLocalDataDialog.js\":\"41ab90fcdffde73e\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/actionDispatch.js\":\"0f6c69ae0616d415\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/actionRefItems.js\":\"ac91a40ea1c4d0bd\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/applyKeybindingOverrides.js\":\"6e412d105caf59f9\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/blockActions.js\":\"099df659cca9cb97\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/blockMergeGesture.js\":\"17294aa59650cfaf\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/canonicalizeChord.js\":\"992083f49ab4344d\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/defaultContexts.js\":\"4cddbdeae7311237\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/defaultShortcuts.js\":\"e64a25c5fe05c5c5\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/effectiveActions.js\":\"919d5366acb3a763\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/gestureAction.js\":\"8329f06defb60b28\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/gestureBinding.js\":\"19a8522c889d1bc6\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/holdRegistry.js\":\"3e919d81e2391200\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/keybindingConflicts.js\":\"51f0fbafd6b2b8fe\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/keybindingOverrides.js\":\"4d73f1b71ee93d14\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/pointerAction.js\":\"0f945bf4c3e12d29\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/resolve.js\":\"cce3f27fbf5ebe78\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/runAction.js\":\"d29679e4f4ba65be\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/sequenceMatcher.js\":\"f1bd8e1170b8d48c\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/types.js\":\"acdb47ff8c645929\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/useActionContext.js\":\"ce1824b10d7818e0\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/useActionDiscovery.js\":\"65bc83f5e2b0a82e\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/utils.js\":\"37681a680de36f76\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/bootStore.js\":\"6914804cedbd8455\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/previewDatabases.js\":\"c0ca50b21ce84629\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/byteTransform.js\":\"957ce6a6c11267fc\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/attachmentCleaner.js\":\"56a1d32141284f58\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/attachmentParts.js\":\"dbd877391f2d5be7\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/bundleParts.js\":\"b2fb64cf88b3779f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/bundleRecord.js\":\"27319e7b87d7d9e5\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/manifest.js\":\"5398cf0abde89f1e\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/takeBundle.js\":\"9177378fbcd732dc\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/verifyBundle.js\":\"35a8f227522a38d2\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/cleaningStage.js\":\"72db930967b64e53\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionKey.js\":\"37c78acc0abb6979\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionServer.js\":\"cbe7d0f52252760f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/flip.js\":\"189e8a4e66121faa\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/flipAttempts.js\":\"107231134275dac5\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/pages.js\":\"343c33bbfa049712\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/preflight.js\":\"d57738ee2d667d98\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/reseal.js\":\"0eaecfead6672fd3\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/runConversion.js\":\"04aaa375a88c5268\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/runLock.js\":\"4836df5a4f423ed1\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/sealing.js\":\"9a97c066b41a35b0\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/sealingStage.js\":\"d29f526e4a1b5c29\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/stage.js\":\"592f3e043526f36f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/verifyReseal.js\":\"2b53b27866ca8737\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/aad.js\":\"f78121bb7dc875fa\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/aead.js\":\"13e14e947bedcab5\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/base32.js\":\"46facf0f1dbbd369\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/base64url.js\":\"d8a7ab696356abd7\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/binaryEnvelope.js\":\"d03c7a9bc597f8f9\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/byteAead.js\":\"df000019fbb741f0\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/canary.js\":\"b18db46af289b16d\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/contentHash.js\":\"66522eaabd81e0c9\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/contentKey.js\":\"a67aafbc735227fe\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/derivedIdNamespace.js\":\"7bac5ec79534d01a\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/envelope.js\":\"e48cfcc91faeba4c\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/hex.js\":\"6cdf4fc0f8db2cab\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/sha256Hex.js\":\"e75303628059b4d2\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/workspaceKey.js\":\"1268860dc9b6d38e\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/conversionState.js\":\"4157e9a0aa1f0234\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0d3f0765a7fa4271\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/pastedKey.js\":\"faef0828fdbc369f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"91e57fc15b3cab02\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c5bd0a176bb3bc76\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/keyStore.js\":\"83d6a2d10a80223f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/mintWorkspaceKey.js\":\"637480874ac0da1b\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/modePin.js\":\"0e8188bfb2eb66de\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/openWorkspaceKeys.js\":\"73bbbd04178cfc14\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/resolveWorkspaceEntry.js\":\"7feefb7f3f834d60\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/resolver.js\":\"51153eac1598570e\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/workspaceAccess.js\":\"e404984369ced785\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/transform.js\":\"f302f2eefbc276d1\",\"/knowledge-medium/pr-preview/pr-1904/src/themeBootDefaults.js\":\"d79baa3eb6f8cf90\",\"/knowledge-medium/pr-preview/pr-1904/src/types.js\":\"d45a3e3ec6f7606a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/ClientLocalSettings.js\":\"5834e52ab13ca556\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/abortableSleep.js\":\"d9b1cf3c5ab6b90b\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/array.js\":\"dd5ee88126eabbc6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/backlinkAutocomplete.js\":\"3ccf2cb013f64cb5\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/blockCrumbs.js\":\"6d647e162c9efcc0\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/blockrefAutocomplete.js\":\"eb6a22eca3ccb9f7\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/cadencedIdleJob.js\":\"fecb62365b630d1f\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/callbackSet.js\":\"8db7f4dbb8e3c99c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/clientId.js\":\"c1cb1481d1359729\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/codemirror.js\":\"cdea4e26af08be8c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/codemirrorCompletion.js\":\"ad06559927073fb5\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/copy.js\":\"268cb75e04555731\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dailyPage.js\":\"658803d48249d38a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dbForensics.js\":\"011eefbc557ccec8\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dbForensicsHooks.js\":\"e2b15979e78661f9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/deleteBlockThroughUi.js\":\"18f7c64245ca2a97\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dialogs.js\":\"5c8a585342470ebc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dom.js\":\"ef6952cfd47acdbb\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/downloadBlob.js\":\"228fec719fa7fc48\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/drawnWalk.js\":\"6283c14fbdcab876\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/exportSqliteDb.js\":\"ebda3948395c77bc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fileSystemAccess.js\":\"a596264fb167eb73\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/flipSlide.js\":\"3a87150ee60ba74d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fnv1a.js\":\"d3d8245bbae69a8e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/formatBytes.js\":\"234ff44af51a09ec\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fuzzyRank.js\":\"d9f50491a215d8ed\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/idbKeyedStore.js\":\"d2e4020acac12ca3\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/idleCallbackPolyfill.js\":\"7ccd1c0070fadef9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/keyboardAwareScroll.js\":\"c4892005dc22b262\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/keyboardViewport.js\":\"aecbca7ff29311e5\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/lastWorkspace.js\":\"105e736e57a66f23\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutColumns.js\":\"3523846e0775ec20\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutSessionDom.js\":\"d96734e97a845441\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutSessionId.js\":\"09596a13db180d05\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/linkClickGestures.js\":\"638f3330c4d1b2c2\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/linkTargetAutocomplete.js\":\"f16777832b6bc0bc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/localDbCorruption.js\":\"a378d2aa49b4bf1a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/localDbRecovery.js\":\"458dc1c42a0ef7bc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/markdownParser.js\":\"9d946a8469992441\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/memoize.js\":\"93278658b1f026ec\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/nameFieldCommit.js\":\"84872d818ec79d4d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/nameList.js\":\"f64f354b00e8d982\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/navigation.js\":\"f722b83700d28a73\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/omnilinerNamespace.js\":\"3379b9217582f153\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/opfsPageScan.js\":\"08cefb20336938fb\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelClearance.js\":\"6c0143ba3933509c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelHistory.js\":\"69e48150339fba31\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelLanes.js\":\"2d55c808bd6e636a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelLayoutProjection.js\":\"4009b1cfd86110e4\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelScrollAnchor.js\":\"7c3d5ac3a7baf1b6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelUrlFlags.js\":\"30fde978588ceb82\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/platform.js\":\"35d93525f9702a38\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/pluralize.js\":\"9b8d9000bbcfb5f9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyCreation.js\":\"b49586d6ccea3597\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyNavigation.js\":\"23d0a5082566e761\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyValueContext.js\":\"ff2ca23642d5480a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/react.js\":\"f605e743c439ebd9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/relativeDate.js\":\"7d6a72233d7fc13f\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/relativeTime.js\":\"92f1258d625583b7\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/renderScope.js\":\"3797d3e806f83b7c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/resolvedThenable.js\":\"96856879ba86332f\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/routing.js\":\"a1ca4306ee4d9078\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/safeMode.js\":\"630ebcb00ffe5f3d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/scheduleIdle.js\":\"67465370f0927cdf\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/screenWakeLock.js\":\"3e6e5bf84082ac19\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/selection.js\":\"b21c9b334c8da38a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/softKeyboardGrab.js\":\"1280001f7af8facc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/startupTimeline.js\":\"edaf79117531162d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/state.js\":\"c78c5b0d7bf055b2\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/string.js\":\"6c5e01c93b08330d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/surfaceZoom.js\":\"52f4b14a1e391e34\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/time.js\":\"84bdc45568035e2a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/toast.js\":\"5319811c2d2850fd\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/toggleStore.js\":\"3ab6ecb33615d0c1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/untilStopped.js\":\"6d5174a182d7c722\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/userActivity.js\":\"30a2c52ee94bd49a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/viewTransition.js\":\"88ff1f9476f2cf98\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/viewport.js\":\"c165769057d330e4\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/webLock.js\":\"1f685dd2d49927f5\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/workspaceRecovery.js\":\"939f6f6163f3e503\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/workspaceSnapshotStore.js\":\"6bce2b1d12fa93b6\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-compiler-runtime.js\":\"c085de13c88e9815\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-client.js\":\"c108018592ff7e93\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-server-edge.js\":\"4473a9e22fe79443\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-server.js\":\"8c0ef9bbfcfe72bb\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-static-edge.js\":\"f449fc35bc31e9da\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-static.js\":\"1a50602cb85285ff\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-test-utils.js\":\"00ef46dd379a69dc\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom.js\":\"3eeafb3b2c43bc37\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-jsx-runtime.js\":\"a3ec2252c312c4fe\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react.js\":\"ce61d51ba07e73d9\",\"/knowledge-medium/pr-preview/pr-1904/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1904/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1904/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
