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
		buildId: "1454734755ea-2caa6ecc",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/\":\"714eec35d63a711b\",\"/knowledge-medium/pr-preview/pr-1904/index.html\":\"714eec35d63a711b\",\"/knowledge-medium/pr-preview/pr-1904/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1904/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1904/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1904/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1904/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1904/assets/FacadeVFS-BRQpqnC7.js\":\"891ebefe2dd6f73a\",\"/knowledge-medium/pr-preview/pr-1904/assets/OPFSCoopSyncVFS-DMyQDWdY.js\":\"86e4b1b2b1685b21\",\"/knowledge-medium/pr-preview/pr-1904/assets/OPFSWriteAheadVFS-k-M70Pwl.js\":\"eb585f25ac433d89\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-C0HcraJs.js\":\"86aa477d7fa26ed0\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-async-Fz6hWTwQ.js\":\"b9eb189c33a992bf\",\"/knowledge-medium/pr-preview/pr-1904/assets/worker--hK6-iBI.js\":\"a8493596f780837a\",\"/knowledge-medium/pr-preview/pr-1904/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1904/chunks/app-8Z8bRG5f.js\":\"889db10e43e95bf4\",\"/knowledge-medium/pr-preview/pr-1904/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1904/index.js\":\"713cd2fd242369dc\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1904/assets/AccessHandlePoolVFS-BrTCvkYR.js\":\"691b9b6e34e4c6fb\",\"/knowledge-medium/pr-preview/pr-1904/assets/IDBBatchAtomicVFS-xu9p-z6c.js\":\"0bb34832b79a4ba2\",\"/knowledge-medium/pr-preview/pr-1904/assets/MemoryVFS-ClNzB9Vo.js\":\"6ca89a2ce16db9ec\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-B1ZvrQ6z.js\":\"d2e9ceb833f79291\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-async-pk0cuaze.js\":\"9c6c8a2e595ff098\",\"/knowledge-medium/pr-preview/pr-1904/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1904/chunks/AccessHandlePoolVFS-CNV-xtBN.js\":\"8041686fe9a29eaf\",\"/knowledge-medium/pr-preview/pr-1904/chunks/FacadeVFS-Cr3LazFY.js\":\"e48cb7d228655426\",\"/knowledge-medium/pr-preview/pr-1904/chunks/IDBBatchAtomicVFS-76YQXfQs.js\":\"f180967ceb27f769\",\"/knowledge-medium/pr-preview/pr-1904/chunks/MemoryVFS-BoBOJ82f.js\":\"33d9bbaf3e9b0f1d\",\"/knowledge-medium/pr-preview/pr-1904/chunks/OPFSCoopSyncVFS-DMj18QqV.js\":\"b552a0710aa7472e\",\"/knowledge-medium/pr-preview/pr-1904/chunks/OPFSWriteAheadVFS-BcF3A6gd.js\":\"12178aa3cd84a3f9\",\"/knowledge-medium/pr-preview/pr-1904/chunks/Preview-Ddeg_cQI.js\":\"a1d908ae442d32d8\",\"/knowledge-medium/pr-preview/pr-1904/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1904/chunks/card-qxO39GfL.js\":\"732d8291359a9289\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-BA8x2Aag.js\":\"4a78a829ce9f4af6\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1904/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1904/chunks/mc-wa-sqlite-CHQXI_ug.js\":\"3cebfac3cd38c1f1\",\"/knowledge-medium/pr-preview/pr-1904/chunks/mc-wa-sqlite-async-DGCIhIJG.js\":\"b63aa4ddce172a8f\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-B3c-vihr.js\":\"485d2b9b788993b6\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-B70Q-BCU.js\":\"72ac7e53718e402d\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-B7kPf1HE.js\":\"a97caf26c0e5f560\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-BiHsuj6e.js\":\"6e58795453373731\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-CgkqgYJb.js\":\"ebf556f2c6179de2\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-D1xo445v.js\":\"93b6f4ccfee7c0ee\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-DWRbGYT8.js\":\"c694e66fe1a34175\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-J2CNuABK.js\":\"8f90a5ef437278df\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server-legacy.browser.production-CaR7riV4.js\":\"617a6af710da3718\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server.browser.production-D_14a8Y0.js\":\"f2868cbecd6f6cfb\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server.edge.production-BYqT9A1d.js\":\"6ea3cdaaf0d815cc\",\"/knowledge-medium/pr-preview/pr-1904/chunks/server.browser-BjKZA0Hh.js\":\"4f64d3799e39a369\",\"/knowledge-medium/pr-preview/pr-1904/chunks/textarea-BgSASQLw.js\":\"c4c00f3142c17b6b\",\"/knowledge-medium/pr-preview/pr-1904/chunks/ui-B8wJ68ux.js\":\"fd62956ab5edd124\",\"/knowledge-medium/pr-preview/pr-1904/chunks/wa-sqlite-D7BuUaaA.js\":\"cf882e46564c3495\",\"/knowledge-medium/pr-preview/pr-1904/chunks/wa-sqlite-async-D9DWlblA.js\":\"716c106f748a0b7a\",\"/knowledge-medium/pr-preview/pr-1904/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1904/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1904/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1904/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1904/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1904/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1904/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1904/src/App.js\":\"6bb40a1db4c97a36\",\"/knowledge-medium/pr-preview/pr-1904/src/appUpdate.js\":\"97a7f289af17a329\",\"/knowledge-medium/pr-preview/pr-1904/src/appVersion.js\":\"6107d54ced4e5c9b\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/initialLayout.js\":\"5d6238575cac6e5a\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/openWorkspaceData.js\":\"74b8b4e00a220cfd\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/resolveWorkspace.js\":\"63f7f78ea1a2251c\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/workspaceBootstrap.js\":\"ca1e2f7a12fbb6e4\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockComponent.js\":\"ebe0f3c2085aa9c0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockCrumbs.js\":\"2a8a7bbe4ff18d8e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockEditor.js\":\"1007f55c961cc53c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockLoadingPlaceholder.js\":\"4c25ce0e4be42ddb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockProperties.js\":\"c39a49d54f5c3e23\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockSearchPicker.js\":\"9890e3eed9dec487\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ConfirmBulkDeleteDialog.js\":\"e38e5df6d24f0aa5\",\"/knowledge-medium/pr-preview/pr-1904/src/components/DividerHandle.js\":\"31a2b0da20df58fa\",\"/knowledge-medium/pr-preview/pr-1904/src/components/DraftEditor.js\":\"82b9d8883eff9859\",\"/knowledge-medium/pr-preview/pr-1904/src/components/GutterPill.js\":\"8c712eadc2b4c057\",\"/knowledge-medium/pr-preview/pr-1904/src/components/Header.js\":\"f258c2d4c87eaba8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/LazyBlockComponent.js\":\"e8f603e1926f5f4a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/Login.js\":\"5f247ad76e61cc2b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ZoomableSurface.js\":\"b0259876291a77ef\",\"/knowledge-medium/pr-preview/pr-1904/src/components/editModeKeepalive.js\":\"34674baf3f2bd46f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyDisplay/PropertyDisplayScope.js\":\"fd9ea334050d2247\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"689489f4d67cde9b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/RefPropertyEditor.js\":\"5dd3b04d6788ef77\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/RefTargetTypePicker.js\":\"90de29235ca72491\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/SelectPropertyEditor.js\":\"a807beb5ee86d2f2\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/TypesPropertyEditor.js\":\"456f495c2c5f31f9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/defaults.js\":\"a241818247404a47\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/kernelValuePresets.js\":\"cf2c8cf6eb40486e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/selectablePresets.js\":\"56cf9a00671be087\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/typesPropertyUi.js\":\"09d74c90f90a05c8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/AddPropertyForm.js\":\"9607d5995ae8c282\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/PropertyPicker.js\":\"d69e7b601620039a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/PropertyRow.js\":\"3c8ebe0d56cf0e1d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/Rows.js\":\"92b88ff613de013f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/actions.js\":\"a809b445cbddb1b0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/declarationOnly.js\":\"8e31753a6518ae48\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/layout.js\":\"a101fb7c7ba0b32e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/model.js\":\"ace625a9734a41f2\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/shapeUi.js\":\"857a323c6c5f147c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/shapes.js\":\"adb1fa43fcd3dd9e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/usePropertyEditingActivation.js\":\"959c723c103ca342\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/visibility.js\":\"5263ec2d64ef9073\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanelSections.js\":\"1cbb504aacae162f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockEmbed.js\":\"9a28fef228f18694\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockLink.js\":\"ec2d1d3a0c062632\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockRef.js\":\"5af430fa57cbfe18\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/CompactReferenceLink.js\":\"7f4b3481f7c6782d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/ReferenceLink.js\":\"9b547bfa6143779b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/cycleGuard.js\":\"14942cc50c02d77d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/cycleGuardContext.js\":\"bc108cba5b53545d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/linkInteraction.js\":\"178236a58cf11de3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/referenceLayout.js\":\"0aac8aa378d03d27\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/useBlockRefAncestors.js\":\"88db52ef9d9e8a73\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockGutter.js\":\"277bc1e64ca8c9cc\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockInfoDialog.js\":\"7c9fe1e57dfbb5be\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockReadText.js\":\"26f016b015af1eea\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockTypeBlockRenderer.js\":\"b59a039de4810e67\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BulletHoverCard.js\":\"ef191e5865f0ac4f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/CodeMirrorContentRenderer.js\":\"889fa41b5b20db56\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"54cdb001c44cdebf\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/ColumnResizeHandles.js\":\"ffaffe41e7370039\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"09a3ae6aa35758b2\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/DefaultBlockRenderer.js\":\"b5ac749b98916eae\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/LayoutRenderer.js\":\"a89d2aa5d885ad8d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/MarkdownContentRenderer.js\":\"eaa148a321fb30b0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/MissingDataRenderer.js\":\"6ece260788735529\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/PanelRenderer.js\":\"d960fa63760f95b9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8ffc159060c08452\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/TopLevelRenderer.js\":\"e24a86a6a8fbcbd0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/blockGutterMode.js\":\"bf09740879202929\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/blockTitleText.js\":\"30c5d867233ae8c1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/fieldCreationKeydown.js\":\"78190571a9370d7d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/layoutRootContext.js\":\"9749cd0a04c29e50\",\"/knowledge-medium/pr-preview/pr-1904/src/components/typeChip/TypeChip.js\":\"583c38f205100284\",\"/knowledge-medium/pr-preview/pr-1904/src/components/typeChip/chipStyle.js\":\"ed1cdb177fc58e8b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/anchored-floating.js\":\"6d811c0bd406c0f8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/button.js\":\"14a2ee42bd826c63\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/card.js\":\"2e04ec05a1634a42\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/checkbox.js\":\"34d50f91726e3d82\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/collapsible.js\":\"7956f76ac0fe51e0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/command.js\":\"3d4302df32f6540f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/context-menu.js\":\"e6828e5b437b65a4\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/dialog.js\":\"094aa31b66d9b8c1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/dropdown-menu.js\":\"35676a99f853b465\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/floating-listbox.js\":\"4477c707dd561a26\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/index.js\":\"0c01c07661f991b1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/input.js\":\"afc817bfea2407a6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/kbd.js\":\"83466a59cafa1656\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/label.js\":\"8f9a88ffa8a5bdae\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/textarea.js\":\"2adab9ea9f0ef1d1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/useEditModeYieldKeepalive.js\":\"f2de6fdb89b42d67\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/BootFallback.js\":\"df49ccaa15ef548a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/FocusedRowLazyMount.js\":\"df20b7386b606ad3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/LazyViewportMount.js\":\"ed53358f0f67ab61\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/LocalDbCorruptionFallback.js\":\"3d0bdd3c0ddfba3a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/error.js\":\"7a79e8ac403f5271\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/lazyMountRegistry.js\":\"c9d573ae0b24393f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/suspense.js\":\"957ddd7ece0748e4\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/CreateWorkspaceDialog.js\":\"4407fbb85d429d52\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/PendingInvitations.js\":\"6def748000a2b247\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/SyncProgress.js\":\"f3746438d2b50971\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/UnlockProgress.js\":\"8ecc461b6fbb66ee\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceKeyGate.js\":\"c533186ab2c9aa5a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSettingsDialog.js\":\"fcb6d19ade19e45b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSwitcher.js\":\"9e93144d36eecefd\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSyncGate.js\":\"ba69f49c3a022022\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/ConversionFlow.js\":\"fc37991d75b67067\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/ConversionFlowHost.js\":\"698560254a0c6556\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/EncryptionSection.js\":\"2bfb2afbbdb2d34d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/attachmentPrompts.js\":\"10ec4e12f84ea6c6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b3fe2a7dcebd97c1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/conversionFlowDeps.js\":\"3374db9b4ba87374\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/conversionFlowStore.js\":\"7b1e09c2e6f8beca\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/flowUi.js\":\"80f41e55c92d9b87\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/useConversionRun.js\":\"0ed4bc5f826e54b9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/keyUi.js\":\"d330fc80b0ac2b93\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/useCloseOnKeyLoss.js\":\"6cb1d022fe16b787\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/useCloseOnServerE2ee.js\":\"9e9e4509494fba25\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/workspaceUnlocked.js\":\"b617c4ee7a81325e\",\"/knowledge-medium/pr-preview/pr-1904/src/context/backgroundSubtree.js\":\"021609addf73135a\",\"/knowledge-medium/pr-preview/pr-1904/src/context/block.js\":\"448b9679b1d57de0\",\"/knowledge-medium/pr-preview/pr-1904/src/context/layoutWsContext.js\":\"3c88d5d853060374\",\"/knowledge-medium/pr-preview/pr-1904/src/context/propertyDisplay.js\":\"13dc40f7fcef7180\",\"/knowledge-medium/pr-preview/pr-1904/src/context/repo.js\":\"62c16bbe6d72a7f9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/aliasClaim.js\":\"e9486b15c5b0e4d3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/aliasSeatNamespace.js\":\"aa7af8f3779ad85a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/blockData.js\":\"61de5890e4114c3f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/blockType.js\":\"7a927a0304de803c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/changeScope.js\":\"62e167e90b7b5c81\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/codecs.js\":\"3b21fd90e8b5f860\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/derivedData.js\":\"d9e542e3e22c7b41\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/errors.js\":\"3a73a4655fe6ef6d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/events.js\":\"49d2a28c58977c00\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/handle.js\":\"02e42375ee1ae891\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/index.js\":\"4c8b26c3c85d75f9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/mutator.js\":\"427447e9c08a710c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/processor.js\":\"647db73b978a8a75\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/propertySchema.js\":\"9bc8373c95eb10fc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/query.js\":\"38a807c86dd0d4a2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/sameTxProcessor.js\":\"93bd2c85b28a9246\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/schema.js\":\"02e42375ee1ae891\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/tx.js\":\"02e42375ee1ae891\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/typedBlockQuery.js\":\"114e35771df89f06\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/user.js\":\"2d203528d0179f48\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/valuePresetCore.js\":\"d06054a1c3234958\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/valuePresets.js\":\"339468a91e997b60\",\"/knowledge-medium/pr-preview/pr-1904/src/data/attachmentCleanerIOVerb.js\":\"fd90a64072dfccca\",\"/knowledge-medium/pr-preview/pr-1904/src/data/block.js\":\"d6316387689d3de0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockCache.js\":\"b26d5a0987ee906e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockId.js\":\"8fb32ad1141a6590\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockLiveness.js\":\"6f2f7e0559670e9c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockMerge.js\":\"cd3899d112b0343f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockSchema.js\":\"92eb12bb6f6b62b5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockTypeLookup.js\":\"f6c91a903b1219b8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockTypes.js\":\"2279d8c62fbf1aaf\",\"/knowledge-medium/pr-preview/pr-1904/src/data/childrenView.js\":\"87f247f8f1f6c72e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/clientContext.js\":\"02302436c4b18713\",\"/knowledge-medium/pr-preview/pr-1904/src/data/dbFileSiblings.js\":\"5faa63c593647dbd\",\"/knowledge-medium/pr-preview/pr-1904/src/data/definitionSeeds.js\":\"14a8e5e254948771\",\"/knowledge-medium/pr-preview/pr-1904/src/data/derivedIds.js\":\"4b8562277944acd9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/drawnSubtree.js\":\"b9a51e810a8c82ca\",\"/knowledge-medium/pr-preview/pr-1904/src/data/facetBridge.js\":\"07e08dcb2cd5072f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/facets.js\":\"1da6e1f636ec862e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/globalState.js\":\"a9f856ebf276b2c1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/aliasClaimRederiveProcessor.js\":\"d91c135a26add732\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/ancestorBatch.js\":\"1b94e97632585d41\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/blockTypeTypeifyProcessor.js\":\"1e78109452790315\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/clientSchema.js\":\"7906964dba6077c6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/commitPipeline.js\":\"3734fde261aacf2f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/devAssertions.js\":\"89b1b2de5b38b4f2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/firstSync.js\":\"280ab334c924b17e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/freshInitialLoad.js\":\"b023b4b3fccf749a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/graphBackfillClaim.js\":\"be8c9f6578447d06\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/handleStore.js\":\"5986318d6baa268b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/idleMarkerJobs.js\":\"4616410f5433b7c3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/initialDownload.js\":\"b65f1b9250622bbc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/initializeClientDatabase.js\":\"9a721de1cc53b17d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/jsonCanonical.js\":\"dc06d6bea114984f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelInvalidation.js\":\"30f7b09e6f6b3227\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelProcessors.js\":\"4390c75e7e9094f4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelQueries.js\":\"61bd1c49459fee00\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/mergeTypeMembershipProcessor.js\":\"eb5b3341557c857f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/normalizeReferencesProcessor.js\":\"f07ab3d4e488e9e8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/poolInstrumentation.js\":\"c61cedbf2c05ddef\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/processorRunner.js\":\"741c88413d18de79\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyCellBackfill.js\":\"ff1ae12a112528dd\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyChildMint.js\":\"d2ba5ef071fca8fe\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyChildrenProcessor.js\":\"f3a34e0f56f6423d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4a2704f562dce229\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyDefinitionSynthesis.js\":\"0b837383d9ffcc3e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyKeyScan.js\":\"6b7bbcdd251f0fb5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertySchemaResolution.js\":\"02bb8eb7836ef188\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyValueEdits.js\":\"2cedc81a8c616df5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/raiseProtocol.js\":\"fa54bacaa25268e0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/readBatch.js\":\"e08101b0bb35c312\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/refProjection.js\":\"e4e4bf100d929358\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/referenceTargetLookups.js\":\"b12fc2c7b9383c1a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/referenceTargetProcessor.js\":\"b375b0460020b41d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/replayMerge.js\":\"c8775314f694d05e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/sqlBinds.js\":\"b3186d237ce9b948\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"81efadd4513fb6c7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/arrivalProcessors.js\":\"b763ae37005f4582\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/invalidate.js\":\"ea234eade1d5bd0b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/materialize.js\":\"92dbfba4b299ff02\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/observer.js\":\"78fbf070cc8df120\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/reconcile.js\":\"4e027b97a00583f8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/timingMetrics.js\":\"38e391d56a1ce381\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/treeQueries.js\":\"27d54ffb34b0ccd6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/txEngine.js\":\"1dd17bdd4d3589e0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/txSnapshots.js\":\"41d289a70490613d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/typedBlockQuery.js\":\"4e2eba15b40e4505\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/undoManager.js\":\"459f25ba40636fc6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/invalidation.js\":\"bee9a98e0a95eb7e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelDataExtension.js\":\"613de05a850ef35b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelPage.js\":\"f98033fe6307f3ab\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelValuePresetCores.js\":\"5f5269e9004b494c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbCorruptionSignal.js\":\"94b977a22aa07ca5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbStorage.js\":\"a01302ffc999ee1a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbVfs.js\":\"1d20623a82614d9b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localSchema.js\":\"14e4d98a76a1e6fd\",\"/knowledge-medium/pr-preview/pr-1904/src/data/maintenance.js\":\"e13a4990ad2f6dd4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/mergeProperties.js\":\"1c0ad549244c9e5c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/metricsConsoleHook.js\":\"49d440a8331046b3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/migrationsPage.js\":\"6fe92eab717bbe7c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/mutators.js\":\"918c49a80959a65f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/orderKey.js\":\"63e9ede6e5d2935f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/orderKeyPlacement.js\":\"d4775e38fe2dfae3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/outlineSurface.js\":\"ac91054fd5611eb9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pendingEditorContent.js\":\"9d74196865a3910d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pendingUploadsSql.js\":\"fdb78901e1736d89\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pluginStateExtensions.js\":\"6653146c92e43afc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/powerSyncLogger.js\":\"59d45cf616371dde\",\"/knowledge-medium/pr-preview/pr-1904/src/data/projectorRuntime.js\":\"ffabba7636bf06f2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/properties.js\":\"5d58438ee182cd96\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertiesPage.js\":\"e8ed4eb161826073\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyChildren.js\":\"06e173398b1e6bbb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionFanout.js\":\"3a1412a3aa4a974b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionMetadata.js\":\"ccf0b0aa953f68df\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionRegistry.js\":\"6bcf30ad928a5330\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDisplayMode.js\":\"e36ef0c8d72c8cd3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyRowCreation.js\":\"c4b19af923f17e81\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertySchemaCreation.js\":\"4e443106a3df393d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertySeeds.js\":\"58d4c9e858a6e46b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/recentsPage.js\":\"88e554d4140b8bb2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/refTargetComparableProperty.js\":\"20336f66d6c6b27b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/referenceBlock.js\":\"21a104ce6ab6932e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/rejectedUploads.js\":\"7a7c9855bcdfe768\",\"/knowledge-medium/pr-preview/pr-1904/src/data/releasePowerSyncConnection.js\":\"f28adbb86329579d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/repo.js\":\"f0cd046b18751a48\",\"/knowledge-medium/pr-preview/pr-1904/src/data/repoProvider.js\":\"d7682d34d091910e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/rowProperty.js\":\"2d8de167cd0bbfba\",\"/knowledge-medium/pr-preview/pr-1904/src/data/searchFilter.js\":\"d44f0d306d34c7ba\",\"/knowledge-medium/pr-preview/pr-1904/src/data/seedIdentityLedger.js\":\"d3d106b688d44e36\",\"/knowledge-medium/pr-preview/pr-1904/src/data/stateBlocks.js\":\"d77804a7fa6e8688\",\"/knowledge-medium/pr-preview/pr-1904/src/data/structuralEditPolicy.js\":\"2c26328cf8a54bf7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/structuralInsert.js\":\"744579bf902f7727\",\"/knowledge-medium/pr-preview/pr-1904/src/data/subtreeDelete.js\":\"8d77d53c219901b9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncStreamLock.js\":\"c84d1e1577c9b8d4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncedTableSqlRecognizer.js\":\"29c4aa6984189daf\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncedTableWriteGuard.js\":\"18c3ed65d1b052cd\",\"/knowledge-medium/pr-preview/pr-1904/src/data/targets.js\":\"f896b90bafe60495\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeColors.js\":\"f8f40f634ef98b9e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeDefinitionMetadata.js\":\"17d7d64eab8a5591\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeDefinitionRegistry.js\":\"724f4b89b9608d52\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeExtraction.js\":\"779243dfb1284b5f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeInitialValues.js\":\"1a550d89a311fbe0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typePropertyGroups.js\":\"4aae6292b3a7250a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeSeeds.js\":\"e30a323d94228a05\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeTagger.js\":\"168638fe10adcc01\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typedRecords.js\":\"8da1e3b0625e49c1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typesPage.js\":\"95fedee635832406\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userPrefs.js\":\"4b02e9cc56f7ffb6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userSchemasService.js\":\"ffbe51e133fbc2b5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userTypesService.js\":\"d12b59aa423d18d1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/valuePresetRegistry.js\":\"6075ff05c39a5b8d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/visibleChildren.js\":\"22d275b5780df53f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceConversion.js\":\"381bd046fb59a7a9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceFirstSync.js\":\"89f762143fa8fa55\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceIdNamespace.js\":\"24c8d37cc0f9aae7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceSchema.js\":\"279ab3296ac4ca2e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaces.js\":\"36b64910d8aee4a4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/writeAheadLog.js\":\"5e9a1efd3d9e365b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/BlockPasteShellDecorator.js\":\"98ce942a9a9b57c3\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/atTrigger.js\":\"9f26757bfa9720be\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/autocomplete.js\":\"8b014b51572502c0\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/codeMirrorExtensions.js\":\"7442b62a12d61ccb\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/contentFlush.js\":\"bb6d03221abf155d\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/defaultInteractions.js\":\"015e08a2a9f70078\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/editSettleSignal.js\":\"2711133a35105155\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/insertImage.js\":\"93b4e234d0f512ea\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/referenceCompletionRange.js\":\"174372a1d4f5a599\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/referenceTargetTypes.js\":\"acc746ffcac8b1a4\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/syntaxContext.js\":\"19457a2160c87158\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/triggerMatch.js\":\"4cc61a15fc6d4d56\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/AppRuntimeProvider.js\":\"d258c33d2d838a7c\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/BlockFocusShellDecorator.js\":\"4eee5560c3f417e5\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/ExtensionRenderBoundary.js\":\"c7e1f7001b8e2b00\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/PanelContentRecovery.js\":\"b7e0c983c419cb8b\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/apiCatalog.js\":\"46c252b940d38edc\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/approveExtensionHere.js\":\"dee2a66a283feded\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/armedCutAppMount.js\":\"0d51413605f373a2\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/batchableKeyedStore.js\":\"c11ed114f0915169\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/blockInteraction.js\":\"f6c58592351a0074\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/blockSelectionAction.js\":\"f881a6fcfde56eb3\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/compileExtensionModule.js\":\"7749148cde4549b5\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/compiledModuleCache.js\":\"5670afb01b2bbc96\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/continuousGestures.js\":\"b239f2409aa25952\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/core.js\":\"73391b5153dcc605\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/defaultRenderers.js\":\"0f14361beafad034\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/definitionFanoutAppMount.js\":\"a8b1b75e4c7bfa8f\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dialogAppMount.js\":\"8adbc7d7f3d212d9\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dynamicExtensionSeeds.js\":\"f89f44a71ec6f77e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dynamicExtensions.js\":\"91407fe099210b06\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/exampleExtensions.js\":\"3e5b5fc571c28ab5\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionApprovalStatus.js\":\"d52f221049902736\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLoadErrorToast.js\":\"2f1f65f10f84bcef\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLoadErrors.js\":\"abc573bc1dd34757\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLookup.js\":\"ba4eb9920436230c\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionToggles.js\":\"a3c91fa341d41f6b\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionUtilitiesCss.js\":\"a44c17bc94fa5c6c\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/kernelPageDeletionGuard.js\":\"0675c8b4b442ac95\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/liveRuntime.js\":\"0f30749eb1fd70ac\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/openExtensionsSettings.js\":\"63bd580cd02a600d\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/overridesCache.js\":\"9587bcd293a471dd\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/pluginIds.js\":\"41878d9b2de20ad6\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/processorRejectionToast.js\":\"ad94fd0d4dad8e74\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/runtimeActions.js\":\"03854fcba2e74eb7\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/runtimeContext.js\":\"d2e926922d3e2e54\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/staticAppExtensions.js\":\"4269d887b3877228\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/staticDataExtensions.js\":\"558d38bba932b5c9\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/toastAppMount.js\":\"47bdd256c726c8ed\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/useOverrides.js\":\"33aef7f4958c2ac1\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/useShortcutSurfaceActivations.js\":\"a5a0312fe1adcb6e\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/discoverToggleTree.js\":\"9d8279e82477cbf1\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/facet.js\":\"c8485c6031eebccc\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/resolveAppRuntime.js\":\"5eb8056bab8c62b8\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/runtimeEvents.js\":\"a1a82013e75b28f5\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/togglable.js\":\"1f570495d5fb8f8a\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/variantFacet.js\":\"69b8a2e9f08812cf\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/verbFacet.js\":\"ee58070d88b3521a\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/block.js\":\"d17346fa70b99a34\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/focusedChild.js\":\"ea1d9dba88e9b8c0\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/propertySchemas.js\":\"400504d00783bf68\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/typeRegistry.js\":\"7cd8f0982a705245\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useAncestorCrumbs.js\":\"ce449bcc83864705\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useAutocompleteListbox.js\":\"63dca1a2e9e2db7f\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useDebouncedSearch.js\":\"3c915033100f1097\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useDebouncedValue.js\":\"3c0d320283685daf\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useFacetValue.js\":\"ffdd39225faaafad\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useIsFocalRender.js\":\"dff1e1175390eb00\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useIsReadOnly.js\":\"1ea3b303e4a11908\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useMaterializeBacklog.js\":\"8d1dec32237495ae\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useMinuteClock.js\":\"a13558bc9f2c2d97\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/usePanelLayoutProjection.js\":\"a5dbbdf1a2e10844\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/usePendingInvitations.js\":\"ec4dd7135a2c53ba\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useRendererRegistry.js\":\"0e8f69ab047ad33a\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useRetainedFieldRows.js\":\"982c90f551293a4f\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useWorkspaces.js\":\"46a444e8a5dcd852\",\"/knowledge-medium/pr-preview/pr-1904/src/lib/utils.js\":\"4d2b99304389dfcb\",\"/knowledge-medium/pr-preview/pr-1904/src/main.js\":\"91a4179b8fd832c7\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/MarkdownImage.js\":\"869eb488269f8550\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/blockSeparators.js\":\"e455487cdfc41d3f\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/context.js\":\"914e670aed9eed0f\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/defaultMarkdownExtension.js\":\"5040d36be949c01b\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/extensions.js\":\"e0fed2954b3c42f3\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/renderMarkdownHtml.js\":\"688be3415f38a26e\",\"/knowledge-medium/pr-preview/pr-1904/src/minimal-editor.js\":\"537b2f53f473f1a2\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/armedCut.js\":\"f554f504d92ebfb1\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/captureMediaVerb.js\":\"7ba5df4167632889\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/clipboard.js\":\"f923d6d4fb0089ef\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/decision.js\":\"2d824b1112e201fc\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/operations.js\":\"8afb41f734eaf22d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/account-header/AccountHeaderItem.js\":\"59ba22cebdc402eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/account-header/index.js\":\"ab5cd52fac978c66\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b83ebf9b7c43b550\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/askAgent.js\":\"54b3ac67219bdd90\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/askedStore.js\":\"8ea9e9fc2774b077\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"bcce1c09dd6a8500\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/chipState.js\":\"4da037eda89346d8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2768ab17cec7e5a4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/index.js\":\"b252b0fbe686b78b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d02f0ad5749a62fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/schema.js\":\"8d59879d1a10c4c0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8d8cde0eac463588\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/BridgePairingDialog.js\":\"de1b0bbbb3f31be1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/addMedia.js\":\"27377d4b587b45c5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/backlinks.js\":\"4b830cf445e1a6be\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/block.js\":\"5d33b17faa493a2b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/context.js\":\"8cec681bcb62b98c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e49b603816adaefa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/index.js\":\"8268dbb8d4f486a7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/outline.js\":\"f1c412aaf7cdb8ce\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/properties.js\":\"bf6353a752e350c3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/refs.js\":\"3e90c0c448909226\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ba6d98033f305b84\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/search.js\":\"8f79a916c6ec4175\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/shared.js\":\"9eb824aa26f73c71\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"dc9d7e05bb7b3c4a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/text.js\":\"e19b3fa7996d32f2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentWrites.js\":\"409ab7ed5c750956\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/authoringCatalog.js\":\"b07f8da13bfc5de7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/blockRefTargets.js\":\"56787a158eaf4401\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/bridge.js\":\"452c66c32853bb15\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/bridgeLoop.js\":\"4b663a6dd81c6754\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/changeHistory.js\":\"95adc0e773c89fa6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/commands.js\":\"ff1932dd36a27ed4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/commentsCommands.js\":\"eac284d8e0176009\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dataExtension.js\":\"b72c33680181c01a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dataModelGuide.js\":\"ef46f833f1b071cc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dayPropertyInputs.js\":\"bb79fa8b525156c3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/describeRuntime.js\":\"6f2ce84585777e0f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/extensionLint.js\":\"a2b3cde6afb5cba1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/grainAudit.js\":\"fa03f02e5886325e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/healthCommand.js\":\"82a6022dbdeea855\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/index.js\":\"71e3b66ba3c4422c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/presetIdentity.js\":\"9da7de50b1579d25\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5b64cb50b8dffdc5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/readMedia.js\":\"642045609a176807\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/schema.js\":\"474a193d039b3528\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/serialization.js\":\"0d75f66ad08de060\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/targets.js\":\"b9caa74f9cec1ca1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/tokens.js\":\"8f743803cf16e2f7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/watchEvents.js\":\"6ebe7a76f65b895f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/workspaceGuard.js\":\"3b434d6935a0652b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/writeCommands.js\":\"08686408a11312c7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/AliasCollisionToast.js\":\"c600ee1b65203c1e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/DuplicateNameBanner.js\":\"ce347125e1826da3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/collisionMerge.js\":\"62e8928be4151280\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/dataExtension.js\":\"7ec1166ec115b4a8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/index.js\":\"7330bc8576b7e2de\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/mergeCollisionAction.js\":\"4192b8f494bc2b0e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/pageStyling.js\":\"3d886e4be123a395\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/rejectionToast.js\":\"1ad93f0a11481cc4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/syncProcessor.js\":\"74f9d86591188330\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/actions.js\":\"d34257352594a4ea\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/addComment.js\":\"dd00325baf1a1411\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/anchor.js\":\"e293354bb0b2723c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/anchorState.js\":\"b41c0669f631f71a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/commentLinks.js\":\"e40ed36f6887353f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/confirmThreadDeletion.js\":\"bb655d22fbbd82ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/container.js\":\"b0ecb1468997a88f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/dataExtension.js\":\"bb9b8e86f31be833\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/deleteComment.js\":\"9049758ee8730e6c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/highlights.js\":\"f187f89749608498\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/index.js\":\"92687ab8d2ba4257\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/linkedCommentsPill.js\":\"d7f5e31e04a05c21\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/margin.js\":\"bd1717df0fa78bc6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/marginAnchorLinks.js\":\"d64e10c6a15b6f60\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/marginSchema.js\":\"11dfa9c95d7d3d95\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/newComment.js\":\"f5430261a51b48d4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/ownThreadPicker.js\":\"3022ece16c97a88b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/placement.js\":\"5d0ffb59fdd16a9a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/queries.js\":\"0bb17ef9c55be67d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotePosition.js\":\"8e9aaecb7a0b69f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotedIn.js\":\"04f6e7a284091c28\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotedRange.js\":\"2f785cd050eb4c77\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/rangeRefs.js\":\"a868d31446717068\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readHighlights.js\":\"81da27b70cedf22a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readSelection.js\":\"c8ed0d817166a342\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readSelectionUi.js\":\"a7a01708ce9501aa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/reanchor.js\":\"99c9fdbf24e3691d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/schema.js\":\"06811fdcc513a5ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/scope.js\":\"8908e13c0ca54147\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/scopeThreads.js\":\"3b6583295a98bc11\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/splitRetarget.js\":\"2bcb861e87952d4c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/suggestionCard.js\":\"72e094827d37f9f6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/suggestions.js\":\"47fe4c01970877d4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/summaries.js\":\"8c6d6ddaea7f6b1b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/summaryBatch.js\":\"3221f3c3c66dc6fe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/surface.js\":\"d14727721740f465\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/threadNavigation.js\":\"175fa3262e85551d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/threads.js\":\"fe979e20bab47ed3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/ui.js\":\"e5fb5129b01fdbf6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/uiStore.js\":\"0f744387ade427d7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-intents/appIntents.js\":\"ee9c4aee409f3d81\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-intents/index.js\":\"809bbcbf2628b188\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-update-prompt/index.js\":\"40b93b9117bdea67\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-update-prompt/status.js\":\"2eeb901e493ee068\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c8592f227dca475c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaBlockRenderer.js\":\"ba2dda1795cce61a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaDownLaneReplicator.js\":\"900228fb897130b0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaUploadReconciler.js\":\"33eff703d695dd87\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetDownLane.js\":\"ff2b82695f15480e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetResolver.js\":\"9f8f4e8d3795096b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetUpload.js\":\"62d54b5fa2c4c605\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/attachmentCleanerIO.js\":\"2518d85e82034b68\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c2cb06d11afe27f2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/blobStore.js\":\"03cd3e67d80a1a6e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/browserMedia.js\":\"303834c3849bffe8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/byteStore.js\":\"5d0ffb9eedc3c751\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/cleanerIO.js\":\"540357139f917b6e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/cleanupAttachments.js\":\"d6689bdbd9193205\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/dataExtension.js\":\"65c88ad44161a6f1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/downLane.js\":\"75c5598d5b95ea9b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/index.js\":\"9235c77cf11dd246\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/insertImageContribution.js\":\"ea682f7826c5810c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/laneArming.js\":\"e16e4e9ce8f4e793\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/laneLock.js\":\"5f0c7ae14188edc5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaBlock.js\":\"4cd26767ecf29f24\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaCapture.js\":\"065a3e91e402b076\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaLanes.js\":\"2d0464e873e182a5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaViewers.js\":\"daa7a4e1ff5d43b5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaViewersFacet.js\":\"432875bd859835d3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/pasteCapture.js\":\"f1c2bdd7bd441928\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/resolver.js\":\"5c2d74c221f7115a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/retryUploadsAction.js\":\"a4f2477002d2bfcd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/storagePaths.js\":\"f7011a7f30e2b136\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadDrain.js\":\"0608218a02099559\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadLaneStatus.js\":\"0ce801baac6b6181\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadReconcile.js\":\"7c39db12e6781330\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadRecovery.js\":\"c94bd3b9206274de\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadStore.js\":\"2ca7aac5ad72bc64\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/useAssetObjectUrl.js\":\"e1de31769c83ff66\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"4d7915f70797f71a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/BacklinksViewSection.js\":\"63daf6fd56fc4e59\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/facet.js\":\"a6acd60c5f6428fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/index.js\":\"9e66cfb325c525ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/prop.js\":\"76e64e10e9935d38\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BacklinkFilters.js\":\"5b94119f7b40964b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"900f0b852c016f6f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BlockEntry.js\":\"7e225851042264dd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/LinkedReferences.js\":\"edbdfeffff0da52d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c8b868e51dac6e2e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/dailyNoteDefaults.js\":\"5574b06832e09e53\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/dataExtension.js\":\"a1dfdd8dd7c989d4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/edgeExclusions.js\":\"42aa34345654d9b6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/filterProperty.js\":\"f34da9ab5a1ba7ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/index.js\":\"ccb59d2807e44eae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f64e2a58bb1a54c7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/applies.js\":\"3b29b997b8c59c68\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/countQuery.js\":\"21b0aeee2dbece4b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/expansionStore.js\":\"964bbe6450245fe0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/index.js\":\"9da2829a9f60e986\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3e81a7b51e8a3a24\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/presentationInvalidation.js\":\"5bf432a9bbb0ab8e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/propertyEditorOverride.js\":\"5c03e526be2709b6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/propertyFilter.js\":\"8ba9d92dbcaf4068\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/query.js\":\"c69380797e128f3d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/resolveFilter.js\":\"37679cf43fd336d6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/sourceBatch.js\":\"4aee853d8db1e22b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/sources.js\":\"e612a6523c7d5dc4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/useBacklinks.js\":\"e0919d125f816bfd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"4d04bf057107a9ca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/BirthdayCelebration.js\":\"57424a9a3f59f863\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/BirthdayOverlay.js\":\"e1b95260a30a8048\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/gate.js\":\"8c622445ec081334\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/index.js\":\"a07ad3a4dd1fd088\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/wolfTheme.js\":\"9c513992d0b2de52\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/BlockDragLayer.js\":\"ae2087938289e1c4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/dragController.js\":\"0258a86598eb8a4c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/dropTarget.js\":\"d5836466fc09fd34\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/index.js\":\"9389c0d7053034ce\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/projection.js\":\"d10616dbd342d9c6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-info/BlockMetaCard.js\":\"3ed29d84e73c7f87\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-info/index.js\":\"bf5f3f6e6ec62b59\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/AddTagDialog.js\":\"0e8b39993b5b0483\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"d04fb049827c07c0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/TagNameIssueHint.js\":\"742fb603bd2d362d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/addTagAction.js\":\"741bc86bc751902d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/appendTag.js\":\"3a3ec3684294d326\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/config.js\":\"21bb162f8fc58840\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/dataExtension.js\":\"54100c8b400f14f0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/index.js\":\"92fb145f23319278\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/propertyEditorOverride.js\":\"83d30e42878b36dc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f4c7f9330a497068\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ba265f30781ac377\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/Breadcrumbs.js\":\"81a2416f603afa91\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"34c77b3c5b303c70\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"699256356cfcc993\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/index.js\":\"b0498f7c507e5937\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1590505ec2b176e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/CharacterCountItem.js\":\"c68dd0958f2818e0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/ProfilePropertyEditor.js\":\"433a23c07249f87d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/actions.js\":\"15f092ea071b92ea\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/blockType.js\":\"268db09bad2b7c22\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/charCount.js\":\"e0724ca64dd10551\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/dataExtension.js\":\"f3e3def5b7a4f366\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/index.js\":\"7d020fe723200e95\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/profiles.js\":\"619b0abe4a08ff08\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/properties.js\":\"ac446ee96c3e42c0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/subtree.js\":\"9b5e587bcf68450e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/textCounts.js\":\"0b330fbf4b79f3ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/colemak-keybindings/index.js\":\"a589c007765681b8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/CommandPalette.js\":\"3145757ca86f36eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/HeaderItem.js\":\"1c9bb56833e98c4c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/context.js\":\"a602890b9e7248ae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/index.js\":\"d81e5c7493cdc086\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/selection.js\":\"0ae0ac9fb26e3d22\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/toggleStore.js\":\"50f2efbdf0342df0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/useCommandPaletteActions.js\":\"a4f54198c5841bfd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/ContributorBadges.js\":\"d45a8e989d3a22e5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/ProfilePicture.js\":\"3606668769941436\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/author.js\":\"6ae30b0e2f7439e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/codeMirrorExtensions.js\":\"811094b0758c73de\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/dataExtension.js\":\"e53fc6a8dd75d72e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/index.js\":\"9654b2c23a76a489\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/mentionAutocomplete.js\":\"06ebf477f2d92ecf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/processor.js\":\"dd78aac7939d7204\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/profiles.js\":\"5c72c8c24a9b4c2e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/queries.js\":\"f2e6617ae227d1ad\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/schema.js\":\"3de492152a84ca16\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/useCommentAuthor.js\":\"8481c9a45c917570\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"121d6dd06f099c15\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/followOrigin.js\":\"bf29200cf586b8aa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/index.js\":\"19403620216659b0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"f5123cca4e596fb3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"95d85e68ff3e7a31\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/CalendarGrid.js\":\"9d8469fef068a3f5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DailyNotePicker.js\":\"a278008a0415d0dd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"406852eb3a65ac3f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateNavDecorator.js\":\"fcbccb8ba23b5a2f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateScrubOverlay.js\":\"e333606a245cef74\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DayPropertyControl.js\":\"473a72d18435c61d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DayValueReferenceControl.js\":\"44ece6a932a709cf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/HeaderItem.js\":\"4767653fcf5c78ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/ReschedulePicker.js\":\"25fd865dbd1713f4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/SpreadDatesDialog.js\":\"9bc953ce2747e776\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/actions.js\":\"721919c98e9fe667\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/blockDateAdapter.js\":\"b1926a7267151e2c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/calendar.js\":\"4d9b3bc3fc799f5e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dailyNotes.js\":\"bdd618afaad13f11\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dataExtension.js\":\"c0c367d7f86967e2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubActions.js\":\"0c4ccc727a2cd676\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubGesture.js\":\"500d0164558acf49\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0a6d0f2fabe8239e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ded0a35d4d12ac1f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dayProperty.js\":\"44f8ca8efec38ae9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"2d9a80e7af7a9d59\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/deletionGuard.js\":\"6743068dbb128e7e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dueQuery.js\":\"86e709902f154960\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/index.js\":\"aa32827bfc34af1a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/landing.js\":\"1b9f06ad167a12f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/localSchema.js\":\"fc93183de5549b5a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/referenceDateAdapter.js\":\"d8c771bf57a6c280\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/rescheduleAction.js\":\"715399a4f5812e3d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/schema.js\":\"c47e56ec2e19fb9c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/spreadBlockDates.js\":\"a0f7800299acbaf1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/spreadDatesAction.js\":\"9f43ea2c5583a57a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/today.js\":\"8201eea2a671f552\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"8b9ab82fffb7644c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"7aac5ed6e0306292\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/audit.js\":\"976d85bf700b7cde\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/auditAction.js\":\"ea0b0e91400e72b7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/auditRanges.js\":\"bf364be3147f9145\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/diagnosticsSource.js\":\"7a0b9a3406af45e0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/divergenceScan.js\":\"f2641b7dabe462a7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/index.js\":\"b1957a570d62e461\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/propertyChildrenChecks.js\":\"9172d6c86f2205b0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/referencesMirror.js\":\"914855e7845de87b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/rowJson.js\":\"2061079f35efffae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/schedule.js\":\"4df7c087604a83cb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/store.js\":\"a113c993d62531b3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/action.js\":\"874154227a7f35e4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/index.js\":\"4651a2160689e9d1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/plugin.js\":\"c1edb26f812c023f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"63cd2eeff7964373\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/actions.js\":\"2377c0665c8a5e21\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/changeMarker.js\":\"a113187d5734e9a4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/diagnostics.js\":\"71a91f3a7aa3d8fd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/fileSystemAccess.js\":\"48de34025a7a8271\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/filenames.js\":\"3b6a2d23cff30236\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/index.js\":\"fac4c5265bfc3f36\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/mirror.js\":\"d481ebaa518e8f77\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/runLock.js\":\"e3d9fdb0a80cc33c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/runtimeHealth.js\":\"c834d5640ae045c1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/schedule.js\":\"948bf51e52eaa67b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/store.js\":\"727f454f65b6b955\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/default-themes/index.js\":\"bfb975d8d0d0c6fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/default-themes/themes.js\":\"7524986911632e3c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/diagnostics/facet.js\":\"5cc4034f1b8d5754\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/diagnostics/useDiagnostics.js\":\"7a1e9a463393219b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/dismissals.js\":\"b164b8330cb2c3a9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/index.js\":\"9067536bf36a701d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/status.js\":\"161e4d7a9b83519e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/store.js\":\"973fde298064ca48\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"25d527b928b13252\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/ExtensionsSettings.js\":\"620f0f9f3da6776b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/actions.js\":\"10fb69056a53e7bd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/config.js\":\"541a9aebd10e777d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/dataExtension.js\":\"a3f1df8eec70ec50\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/effect.js\":\"4bba46d095f7425f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/index.js\":\"4e188f37ed2a0bd6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7de39f108530a339\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/useToggleTree.js\":\"418595529a106ca9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/ExtractTypeDialog.js\":\"95f561e533ffdbfd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"c98e8507ed0a113b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/PropertyShapePicker.js\":\"2a38631cfed0a263\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/action.js\":\"0ef533eb0cf50f4f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/index.js\":\"41aa665ca1ae2970\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/FindReplaceDialog.js\":\"d0b6acc2cc389d7f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/HeaderItem.js\":\"0218c8bf4949ad66\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/dataExtension.js\":\"7b6e65832831b5b0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/index.js\":\"7f66cb40ada5e309\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/search.js\":\"d422f172949281fb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/toggleStore.js\":\"d3e2e265d7b45b96\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/LocationPropertyEditor.js\":\"f5b206b88674c18b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/MapView.js\":\"2cb3d5e2a873e944\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/blockTypes.js\":\"82e24d9e2454ae95\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/codeMirrorExtensions.js\":\"934eab72794e423b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/createOrFindPlace.js\":\"47d3ba0328cb80e7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/currentLocation.js\":\"04c96574bafd88c6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/dataExtension.js\":\"d58a253ada1e3b0a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/geoContentDecorator.js\":\"b01046d5d2008969\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/googlePlacesClient.js\":\"ef2932596ff67131\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/index.js\":\"016fcf0a60a8e2ae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/locationsPage.js\":\"fb29e318ffb7c74d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/mapViewport.js\":\"38759eb39347e499\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/pickCurrentLocation.js\":\"3300c16a63b1ad6b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/placeAutocomplete.js\":\"053dbe264e6c2f1d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/placeNameCollision.js\":\"20e5befe59623ab6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/properties.js\":\"6a142d87d3d61cbd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/propertyEditorOverrides.js\":\"af70cff223eb07bf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/query.js\":\"ae2d394c08fc10a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/usePlaceSearch.js\":\"aaf9be06f9315065\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"347022dc7602f05b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"bc6e7b29726f6a5f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"df09755bd47b13bf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/config.js\":\"58f6193c0c6dc0f0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/dataExtension.js\":\"38df3b7fc9b537a8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/facet.js\":\"759fe64a4627920e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/grouping.js\":\"164197b50b53fc7e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/index.js\":\"67b4efdfefe25140\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"e0ed78fc6ad525cd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/query.js\":\"27c41df45744f841\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/resolveConfig.js\":\"a38dc016ac65bde5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"162064153aa2496e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"05f0a1b9d94a9bf9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/HtmlDocumentContent.js\":\"3277b5d9baa257fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/HtmlFrame.js\":\"c73a4db03389da6f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/actions.js\":\"16a238897d4e8a9b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/blockType.js\":\"ff97fa962064a704\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/confirmRunScripts.js\":\"9cd5dc735d691f66\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/dataExtension.js\":\"4269a5f05d26155c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameAnnotations.js\":\"7886937457ac053b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameDocument.js\":\"f0a6bec4800fcbfd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameTheme.js\":\"222a113a34f86a68\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/index.js\":\"c0ec0132eec73fba\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/scriptConsent.js\":\"2d8291e5db71e0e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/sourceMap.js\":\"83a898d7c0dbdc9f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/useDocumentScripts.js\":\"ed6a35691398460c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/index.js\":\"c77e3b3099b2d0e2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/record.js\":\"c538e2c790e543ba\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/recordStore.js\":\"acc305e3ecfcf200\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/responsiveness.js\":\"6f1c7daa431043b4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/schedule.js\":\"d0413abb3bd282a6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/sessionContext.js\":\"03716555672ed513\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b128daaeeddea356\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"a6fc60037f8fc51f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/actions.js\":\"6f99678fc178efb0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/config.js\":\"8ffe33cfe7183a8e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/dataExtension.js\":\"9fdb269302bd90a7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/effect.js\":\"8c4e73f26ce45d65\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/index.js\":\"abbe620eca3749c1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/keyCapture.js\":\"7b89f86d76433944\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/overrideStore.js\":\"ede77e2f1fd0e906\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4176bc2d5086f132\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/HeaderItem.js\":\"1b3a626deb0665ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/LeftSidebar.js\":\"5e23a278f5344dab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/actions.js\":\"322a08538fc92815\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/facet.js\":\"4391ff8302aa1d8a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/index.js\":\"7579e69e771db4a1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/shortcuts.js\":\"8143cca93fa61fe6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/toggleStore.js\":\"091555fccb6b2493\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/MergePicker.js\":\"7ed13a5f97ff072c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/index.js\":\"3b73240570b20433\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/mergeAction.js\":\"5c808ef9cbab9788\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/strategy.js\":\"aeda65bf90c0287c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/Button.js\":\"4bc9f80e7c78fe74\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"78ba00204499d827\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7478665fc5d46b8e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/facet.js\":\"0d781443e4daa713\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/index.js\":\"846b963faafba066\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"69651563c0522e95\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6966898db3891742\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0dd507aeaf287a32\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/facet.js\":\"09aa57e4b1b63a45\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/index.js\":\"0f65a338324de40c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/MoveDestinationPicker.js\":\"11c97104f6475f0b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/blockSubtreeMembership.js\":\"fee01ad796f01c2d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/contextMenuItem.js\":\"247ac11f79577b57\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/index.js\":\"b30be0add08f5565\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/moveAction.js\":\"dc27b5aa4526b377\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/moveBlocks.js\":\"56e3b80ac27c6a92\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/selectionAfterMove.js\":\"a37d4180fea7c0c5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/TutorialBanner.js\":\"774c87257625cbd1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/action.js\":\"68e78a76a62e0e36\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/bannerDismissal.js\":\"b51374ff13a59143\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/documents/cheatSheet.js\":\"6cf19a1ff283b51d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/index.js\":\"94f8b5cc96c72917\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/keys.js\":\"cfec51618dd96cde\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/landing.js\":\"2dcf8754cf66a669\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/outline.js\":\"0397f237edca01a4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/seed.js\":\"09cab85486026a1c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/PerfTrendDialog.js\":\"22eccbfcf093d50b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/analyze.js\":\"76ab82eba8fd1c99\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/diagnosticsSource.js\":\"4b872cf5db52a2be\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/index.js\":\"d6d3921dbeac047e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/load.js\":\"307c2a2b73d95fcf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/monitorRun.js\":\"1c10e3a5c9ad2614\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/schedule.js\":\"4d85a473989961cb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/series.js\":\"4c6491786018a5d2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/store.js\":\"25f764ec8d87f3e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/trendAction.js\":\"10c6ad11778964de\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/verdict.js\":\"b2df6cde1b8ad108\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/clickToEditAction.js\":\"9d36872f24a818ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/index.js\":\"9b9ca9768c8b3e27\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/interactions.js\":\"bf5e02eea821c364\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c85b69a38afb02fc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/MigrationGate.js\":\"924285306a1c3b92\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/MigrationGateDialog.js\":\"48dfce01554d525a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/action.js\":\"9d199885d347295c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/index.js\":\"3dbb65e12b80cc8f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/localRunMessage.js\":\"d208ea58a401f079\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/plugin.js\":\"799cf50f47c0b114\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/progressReport.js\":\"c896b5d72f04e495\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/sweepProgress.js\":\"a8174c80ac0c643b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/FieldRowRenderer.js\":\"449ab689e5585ffa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/ValueRowRenderer.js\":\"dcf309e40cea111a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/actions.js\":\"9db8c3b3b84f8d31\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/autocomplete.js\":\"82e6199be48a0be7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/fieldRow.js\":\"470a2fdbea632f0d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/index.js\":\"8a8f3214e789fb64\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/referenceWarning.js\":\"661083a430331bf9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/valueAutocomplete.js\":\"d928181bd1f918ce\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/valueSchema.js\":\"149146fee23698b5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/HeaderItem.js\":\"d255da887035831e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/QuickFind.js\":\"082b5c94d1386fa3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/index.js\":\"ad74fd1bcafd7260\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/recents.js\":\"458882eb1fe7358e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/resultItems.js\":\"b3e02beddc61e25e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/selection.js\":\"ee94fff32fea0464\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/toggleStore.js\":\"227aacad823a6d83\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/HeaderItem.js\":\"13d1f8fd2cdb868b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/RecentsPageBlockRenderer.js\":\"70dfd6d9abc6b496\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/grouping.js\":\"0749cee1481f76b0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/index.js\":\"841a4d13e802255b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/target.js\":\"e25568c3f21c363e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/codeMirrorExtensions.js\":\"3ccf35951f96b10b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/contentPrefill.js\":\"10c78a779c9181d2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/dataExtension.js\":\"0d00349b2f0bf51a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/index.js\":\"18eb64584413a31e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"eb13ca1117b97d55\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/invalidation.js\":\"93347d3563a54ad9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/localSchema.js\":\"b7db066b52b5d18b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/blockrefs/index.js\":\"6feeb710de8d49bc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"91004b7ef5bd3594\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/index.js\":\"117bac0fcc8150a5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/referenceNode.js\":\"8bc65924012ecd72\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/remark-reference-occurrences.js\":\"2bf6dbee91bf164c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"44250068c2d01874\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/index.js\":\"5e3cd5941e8cf2c7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5d387807a78bdcbe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"19de4e7f48f2e3e6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/mergeRetargetProcessor.js\":\"eca56775bbe20ffb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/parseFence.js\":\"e335991b36bb37ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referenceParser.js\":\"a08ac205c07b6c9e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referenceProjection.js\":\"c825d190a909dc96\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referencesProcessor.js\":\"b54afef23c5ebf34\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/renameProcessor.js\":\"7a71772eafc9c7b8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/spanReplacement.js\":\"5e4a2972f363b49b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/htmlToOutline.js\":\"f76eaff57e88ac12\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/index.js\":\"ada009c661280a15\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/normalizeClipboardDom.js\":\"07816b8b78b6664c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/pasteDecision.js\":\"d10dae6020cb60e7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/action.js\":\"e9a94daeb411e2f9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/blockIds.js\":\"ea3fe07fb6823040\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/content.js\":\"9afa4c5f31fbe242\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/effect.js\":\"82639dbdfc40ac7c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/ids.js\":\"f85c5cb695766b42\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/import.js\":\"e5cfe4505b807321\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/index.js\":\"4f531a20538671da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/plan.js\":\"b7dc98c8303e448b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/plugin.js\":\"05ac01b615694a82\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/promotion.js\":\"0ab091c6a7ba1fcb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/properties.js\":\"2697b5703b7b5c4a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/references.js\":\"83dd20fb55da28fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/report.js\":\"584e866d0b1edeed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/roamMemo.js\":\"0eabab67b68534be\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/runtime.js\":\"adb5a05bda7908ba\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/schemaReconciliation.js\":\"10295dc72ad94cb5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/srsMarkers.js\":\"7267d1580a841f81\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/todo.js\":\"8ebbbaa29753fe50\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/typeCandidates.js\":\"1b973aa6960f54a9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/types.js\":\"6713a42d5e334e0e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/search-health/index.js\":\"832026fcb3131f97\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/search-health/store.js\":\"87f7be1125abf395\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/HeaderItem.js\":\"5c5b6bd04a5ba113\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7ac722ba5c2b0231\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/index.js\":\"81e4d11f2eb73ea0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/model.js\":\"1f0b719e31a84d7a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/toggleStore.js\":\"5abcf0dd60e83a9f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/useKeyInspector.js\":\"5408dace213e4db4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"fb7b613fca50fd4a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/ShellDecorator.js\":\"9a73ca6973411f80\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/actions.js\":\"6192fd69316a5779\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/exclusionsFacet.js\":\"59f47ba8a03ef7a7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/index.js\":\"0156a06c6972b1cb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/shell.js\":\"d680aa33fc88ae88\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/surface.js\":\"cd6e5709dd1ac8cc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/walker.js\":\"4c957683bdd974c8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ea487978daf1769d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/dataExtension.js\":\"30e52a17c75ae51c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/index.js\":\"b6ed4970c0e9d630\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/indicator.js\":\"10dc7f722a4be4c0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/moveSrsState.js\":\"cbcbd9a821db0dee\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2f51093ecea62c9c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/scheduler.js\":\"ab431bb43ecbc32c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/schema.js\":\"937714f86024e3e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"39e01f57fbfde5fe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/srsClipboard.js\":\"c423cd09fdbf7bb8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"9090f1d20916e844\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/DailyNoteReviewHint.js\":\"a5ca3662a1986b80\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/DeckPicker.js\":\"3481a88055851368\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewControls.js\":\"9449372cdc0cb6a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewDeckRenderer.js\":\"5f317ff27567f526\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewSession.js\":\"0c835f6e9caa445b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/actions.js\":\"c38e1fec17c79d07\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/archive.js\":\"0ffa5e9644210add\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/dataExtension.js\":\"583609638095e97c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/deck.js\":\"1976176e79b1d4ca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/dueQuery.js\":\"66196b9d6b43f528\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/gradeDecision.js\":\"0ac7033a173c2ebf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/index.js\":\"e5afd018fbe4c5bd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/keyHints.js\":\"851f560c871f4e45\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/reviewCardLayout.js\":\"0b1b1be22d253903\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/reviewProgress.js\":\"3030cd56db24e52f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/schema.js\":\"3a69ea923e1b19d5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/useDueCards.js\":\"4c5fdedc24db840d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/startup-metrics/index.js\":\"7eb1ad8bef195d84\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/startup-metrics/record.js\":\"ababcfb346ce534e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/index.js\":\"607c17860e949d16\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/persistenceStatus.js\":\"a2e5b2af0af5b5e8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/requestAction.js\":\"d0697a63c0377ab3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/TypeChipsDecorator.js\":\"04c7dcadc7f93398\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/codeMirrorExtensions.js\":\"43fbad4c689f316f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/index.js\":\"c900e81b2b40d303\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/typeAutocomplete.js\":\"f937e764344cfbda\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"5c9b247f8dc22ec7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/actions.js\":\"db2f7fc80c30d01e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/anchor.js\":\"cfa4be53443cbdfd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/events.js\":\"0f65c24b8b523cdb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/gestureActions.js\":\"b06b97620966b8a7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/index.js\":\"9f8f44d61b64a282\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f67be0c316ac6ec2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/collect.js\":\"d76b0f7ee961a524\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/index.js\":\"5309ede03e3ee588\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/record.js\":\"4f5c6dd72edc5557\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/RejectionDialog.js\":\"a130e5d0dc81d5ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/SystemStatusHeaderItem.js\":\"e9ee263259ed70f7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/index.js\":\"32f1ea3db7bae564\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/model.js\":\"c4a89719b08415fe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/queueCounts.js\":\"1352e92bccbec8d5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/rejectedHelpers.js\":\"c32684a80388de67\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/rematerializeAction.js\":\"f844ebc67dca6a53\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/useHysteresis.js\":\"c6b7485ed4e0fcb7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/ColumnHeaders.js\":\"cf5cc4417dbb3816\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/QueryUi.js\":\"6d59c746d7212314\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/TableLayout.js\":\"7ec215b5666e6402\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/actions.js\":\"0ab7670e2d6eb3f6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/cellEdits.js\":\"3e193d7b8ed2def8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/childrenViews.js\":\"ed0cf89cde7f272e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/columns.js\":\"261660c01362ede5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/controller.js\":\"006472b80f6e1b5f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/convert.js\":\"cdabe681e9544e88\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/dataExtension.js\":\"8a370d773b6d3ece\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/index.js\":\"99afacc746ac3850\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/keys.js\":\"3700e9c1de49a8e5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/model.js\":\"61c6f20818be8975\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/QueryText.js\":\"132d14163e1877b7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/backfill.js\":\"d72126964c3599ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/completion.js\":\"814a4da6774b60a2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/format.js\":\"c62a77842de71cdb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/parse.js\":\"89e8ef97cb6905cd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/queryValue.js\":\"f5a87b60718e8062\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/registrations.js\":\"ddd9172e9b596711\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/source.js\":\"ebd1b8728361c704\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/registry.js\":\"653a6e0b0c475a0c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/rowGutter.js\":\"e19ed96d2b40c5b8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/rowVerbs.js\":\"428973411b290ac2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/schema.js\":\"3402f715127911ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/sort.js\":\"0fb465ab20cac266\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/effect.js\":\"f9f4cf991f780738\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/index.js\":\"46e370d7a356b17c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/theme.js\":\"b0e61e021415d21e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/actions.js\":\"af915547c0e79a69\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/dataExtension.js\":\"3c9e00c56767133d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/index.js\":\"05559baaeccfa028\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/schema.js\":\"ce10614cea17abc0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/TouchSelectionLayer.js\":\"a2edcfdd6593fdb8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/actions.js\":\"77f9de5dff4c7725\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/defaultItems.js\":\"351833511752e90b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/facet.js\":\"463177c6ebd73b08\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/holdRecognizer.js\":\"40a231311805fe71\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/index.js\":\"4143987203d0ea6f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/UpdateIndicator.js\":\"31528989d960cd0f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/index.js\":\"8a9a51489f2c123e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/loadTimes.js\":\"63f4c450489b1d79\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoNotesRenderer.js\":\"cb032a11af5bd426\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoPlayerRenderer.js\":\"50b0f3bb6e9c0c81\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoTimeStamp.js\":\"ebc39d67554b8383\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/actions.js\":\"be0e2f6a9086b613\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/index.js\":\"ce2405ed2a8ccaf8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/markdown.js\":\"3dfc376dd9c9085b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/notes.js\":\"fdc638be9bfe6bad\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/registry.js\":\"920e6bb44898ab97\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/remark-timestamps.js\":\"479edceef5c95bbb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/view.js\":\"f0d8994d3a5cf4bd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/LinkHints.js\":\"7f79b4cd88bc7e35\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/index.js\":\"84e3b506ca3a8384\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/model.js\":\"63434f830261bfb0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/settings.js\":\"003bb8df112b46c0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/actions.js\":\"6c134826cafe1104\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/index.js\":\"b686cd603d953057\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/interactions.js\":\"94b5fb9844dafc27\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/workspace-header/index.js\":\"de3a64879c584481\",\"/knowledge-medium/pr-preview/pr-1904/src/registerServiceWorker.js\":\"47c852aa8e42fbe4\",\"/knowledge-medium/pr-preview/pr-1904/src/requestPersistentStorage.js\":\"02b3ad9e8385a029\",\"/knowledge-medium/pr-preview/pr-1904/src/services/authRequestDeadline.js\":\"303eebaac11c49e8\",\"/knowledge-medium/pr-preview/pr-1904/src/services/authStorage.js\":\"e6f69bf1a8745952\",\"/knowledge-medium/pr-preview/pr-1904/src/services/powersync.js\":\"c1f0fdbb2f63fb01\",\"/knowledge-medium/pr-preview/pr-1904/src/services/supabase.js\":\"1f4a81f51e48384b\",\"/knowledge-medium/pr-preview/pr-1904/src/services/uploadErrorClassifier.js\":\"c55e5a92267d0c36\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/ActiveContexts.js\":\"4be7b41ec7b4a1fa\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/HotkeyReconciler.js\":\"2886fb9cf148fb34\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/WipeLocalDataDialog.js\":\"722990e8023f7cf0\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/actionDispatch.js\":\"ef237fad670116da\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/actionRefItems.js\":\"1408aa3d8301a142\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/applyKeybindingOverrides.js\":\"42bc2e29e285b7dc\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/blockActions.js\":\"eab3fb0cf0703f5f\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/blockMergeGesture.js\":\"7c24aac780617c86\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/canonicalizeChord.js\":\"af475dd1e98dc273\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/defaultContexts.js\":\"67784d2a72d39d70\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/defaultShortcuts.js\":\"0101557b24969fd4\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/effectiveActions.js\":\"b7863afe6ce4ac4d\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/gestureAction.js\":\"108212fb0ef81487\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/gestureBinding.js\":\"9c1dbc473525d2cd\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/holdRegistry.js\":\"95c16401233f693f\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/keybindingConflicts.js\":\"597671f59e12b3bd\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/keybindingOverrides.js\":\"cf685e402043af30\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/pointerAction.js\":\"18c8599f2856237d\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/resolve.js\":\"c4bd9818d462dc20\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/runAction.js\":\"1c4531804d74181a\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/sequenceMatcher.js\":\"d617652aed5f0907\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/types.js\":\"f9a4a413b68c8f27\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/useActionContext.js\":\"382262e6d15b1b14\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/useActionDiscovery.js\":\"bea9e793e39c34fb\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/utils.js\":\"4c62c28a7fc0ee91\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/bootStore.js\":\"cf7556a9b9f193a0\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/previewDatabases.js\":\"5d3812a354ece58e\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/byteTransform.js\":\"fac7fa0b1ee7d565\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/attachmentCleaner.js\":\"7e27468029b84aa4\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/attachmentParts.js\":\"db9dda7c8043fcf7\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/bundleParts.js\":\"59b5b828f0f881d8\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/bundleRecord.js\":\"1d40d7617d6830e2\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/manifest.js\":\"9eb3a2b7f462b132\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/takeBundle.js\":\"8e3a7ccb982a3d8b\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/verifyBundle.js\":\"5c021368f1e78570\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/cleaningStage.js\":\"15d13a746effef21\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionKey.js\":\"a48016346b43b775\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionServer.js\":\"7f257f38d719d9ea\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/flip.js\":\"d224d0b538d14aed\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/flipAttempts.js\":\"01a5b9ff832445c2\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/pages.js\":\"044c407697e83d86\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/preflight.js\":\"27f0debcf01514fa\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/reseal.js\":\"130609f2fa7a3150\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/runConversion.js\":\"cb93151340ca28ea\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/runLock.js\":\"0b362926e20857c7\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/sealing.js\":\"e97ba99f380d2942\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/sealingStage.js\":\"2acf7290b53331a1\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/stage.js\":\"66b733bc9588464b\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/verifyReseal.js\":\"0daf8465b899faf9\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/aad.js\":\"4c8268b64bacdb1c\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/aead.js\":\"329928af748dec58\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/base32.js\":\"8fb7f61648667979\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/base64url.js\":\"24aa07f5b7633525\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/binaryEnvelope.js\":\"59151201d6aca968\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/byteAead.js\":\"87579a38acc6e26c\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/canary.js\":\"5e1a3f0f5dd96964\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/contentHash.js\":\"0c924140bb98bf19\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/contentKey.js\":\"f893a92c1ddcee0b\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/derivedIdNamespace.js\":\"7b671130954e00a2\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/envelope.js\":\"8ad2729b4f82638a\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/hex.js\":\"0d1c22222ef0e37e\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/sha256Hex.js\":\"538735ce7d7eb94f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/workspaceKey.js\":\"8f8ec8ab2d5bf2c0\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/conversionState.js\":\"ae7b9adc662b2663\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/createEncryptedWorkspace.js\":\"7c7229a1c9e7e9a6\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/pastedKey.js\":\"62a56834ab3b9c0c\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"6f813df850ab09e9\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/upgradeWorkspacePin.js\":\"eed69418396dd570\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/keyStore.js\":\"f96f7f2355a901a9\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/mintWorkspaceKey.js\":\"a0ffce08a208c849\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/modePin.js\":\"c4871c720abb8463\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/openWorkspaceKeys.js\":\"58ec2a49b0df10bc\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/resolveWorkspaceEntry.js\":\"c6a40d3157befa2b\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/resolver.js\":\"fed1abf80d43f318\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/workspaceAccess.js\":\"784bf033787e9617\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/transform.js\":\"08a7910e3c8b3494\",\"/knowledge-medium/pr-preview/pr-1904/src/themeBootDefaults.js\":\"b887058cadbbb47c\",\"/knowledge-medium/pr-preview/pr-1904/src/types.js\":\"8d09be2f8b9bdcdd\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/ClientLocalSettings.js\":\"688d8206172ddda2\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/abortableSleep.js\":\"15667018ade8f19a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/array.js\":\"e51cf75553f7f17a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/backlinkAutocomplete.js\":\"bc992ee7161cbe1b\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/blockCrumbs.js\":\"fcb722e5ec64e11e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/blockrefAutocomplete.js\":\"2d5324732ab8bcbc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/cadencedIdleJob.js\":\"dae21ef702d7769e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/callbackSet.js\":\"83851af67c94b465\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/clientId.js\":\"353f373be2414b20\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/codemirror.js\":\"8d9f7ce82c8556af\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/codemirrorCompletion.js\":\"68ecbae5a9f21dbb\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/copy.js\":\"0360c9e33b5732d7\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dailyPage.js\":\"87753e23cc34ced8\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dbForensics.js\":\"7e8b74a3b4a0ab47\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dbForensicsHooks.js\":\"f2ddd04623ed96e6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/deleteBlockThroughUi.js\":\"681c8231a13582a9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dialogs.js\":\"f43df36591c31c0f\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dom.js\":\"c5b1fc15ffa53a5e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/downloadBlob.js\":\"c94e8feab264bdf3\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/drawnWalk.js\":\"084887b1fd87e3ad\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/exportSqliteDb.js\":\"29ba0b62c5924dbf\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fileSystemAccess.js\":\"f11875664e8da6db\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/flipSlide.js\":\"5eaed0c73acf04dd\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fnv1a.js\":\"7b4fc3287c7e7ba0\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/formatBytes.js\":\"220d9a5fe37d4d1d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fuzzyRank.js\":\"f9864d5c2581a3e4\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/idbKeyedStore.js\":\"0440512f8d7232df\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/idleCallbackPolyfill.js\":\"d15f24a5e653d374\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/keyboardAwareScroll.js\":\"3a9dc5705d712234\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/keyboardViewport.js\":\"f6de463ace9336b2\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/lastWorkspace.js\":\"d19439ebcbe327ac\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutColumns.js\":\"9ff527b0bfc9984e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutSessionDom.js\":\"7500dc9298333392\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutSessionId.js\":\"48b7e701c87e20fd\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/linkClickGestures.js\":\"327aa60d439a15eb\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/linkTargetAutocomplete.js\":\"55f26128c1ecb47b\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/localDbCorruption.js\":\"a0ad1eaf12885806\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/localDbRecovery.js\":\"447d73589a676a8a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/markdownParser.js\":\"76a11b94f854cf82\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/memoize.js\":\"d5ab20c7e2c95e78\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/nameFieldCommit.js\":\"2c3bebb8ca9324e6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/nameList.js\":\"3f9c3db9fdb1c50c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/navigation.js\":\"328fdba81502ebfc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/omnilinerNamespace.js\":\"b2457b5c51a84c98\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/opfsPageScan.js\":\"0d544b8f421cbac3\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelClearance.js\":\"13835844479f452f\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelHistory.js\":\"8fad348973bde015\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelLanes.js\":\"23057f54b8fbe713\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelLayoutProjection.js\":\"c06583a6e4a85b10\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelScrollAnchor.js\":\"97a1976b049de13d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelUrlFlags.js\":\"ebcac5faa5d6f0a1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/platform.js\":\"d74d71b778dd842c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/pluralize.js\":\"4c94e1bd8d1b67d0\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyCreation.js\":\"15ad3ea52fd31c92\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyNavigation.js\":\"5f87ad46549b90c7\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyValueContext.js\":\"916fffc9585f22d9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/react.js\":\"a9b7ee4be6d14cb1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/relativeDate.js\":\"9f19d84ef93e7d08\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/relativeTime.js\":\"f6ffbbc7e572fc60\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/renderScope.js\":\"cdd00c2e02661bfc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/resolvedThenable.js\":\"331e8ff641fb18b0\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/routing.js\":\"9a5b52d3e3f9aae4\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/safeMode.js\":\"08de0b46c09f604c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/scheduleIdle.js\":\"9945ce6a053c59be\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/screenWakeLock.js\":\"db994cc809399c72\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/selection.js\":\"163123df7464026a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/softKeyboardGrab.js\":\"76f4e786823a922a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/startupTimeline.js\":\"92e3367a29a78325\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/state.js\":\"0e86a40557876479\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/string.js\":\"7ddc17fb42c1d5ba\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/surfaceZoom.js\":\"de7532577c57c992\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/time.js\":\"e6da93cdd9d8762c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/toast.js\":\"32fdd6f287536b9c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/toggleStore.js\":\"6612ba6646cfa9ea\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/untilStopped.js\":\"48598ea56f3968d9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/userActivity.js\":\"d14c2616e8bc99a7\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/viewTransition.js\":\"1a6088de55d3f7b8\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/viewport.js\":\"85dd41b4eda89e57\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/webLock.js\":\"47ab73da5253d7c1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/workspaceRecovery.js\":\"b3029cd18d633dbc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/workspaceSnapshotStore.js\":\"cd5caab8874cf6c1\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-compiler-runtime.js\":\"740b18c9867d3c4f\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-client.js\":\"46eba96685c8c4d5\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-server-edge.js\":\"5588beb91bb82431\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-server.js\":\"4b3cdf4efa919187\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-static-edge.js\":\"335a124d984ff370\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-static.js\":\"80a48598d1b0afca\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-test-utils.js\":\"c62acd2959c6e40a\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom.js\":\"7dc74f6258f97bdc\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-jsx-runtime.js\":\"4659ffd5046752f3\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react.js\":\"6e7147c61f3af1e9\",\"/knowledge-medium/pr-preview/pr-1904/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1904/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1904/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
