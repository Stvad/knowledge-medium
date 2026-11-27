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
		buildId: "a020f394d675-9d2242e2",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/\":\"8586d0a2a606583a\",\"/knowledge-medium/pr-preview/pr-1904/index.html\":\"8586d0a2a606583a\",\"/knowledge-medium/pr-preview/pr-1904/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1904/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1904/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1904/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1904/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1904/assets/FacadeVFS-BRQpqnC7.js\":\"891ebefe2dd6f73a\",\"/knowledge-medium/pr-preview/pr-1904/assets/OPFSCoopSyncVFS-DMyQDWdY.js\":\"86e4b1b2b1685b21\",\"/knowledge-medium/pr-preview/pr-1904/assets/OPFSWriteAheadVFS-k-M70Pwl.js\":\"eb585f25ac433d89\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-C0HcraJs.js\":\"86aa477d7fa26ed0\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-async-Fz6hWTwQ.js\":\"b9eb189c33a992bf\",\"/knowledge-medium/pr-preview/pr-1904/assets/worker--hK6-iBI.js\":\"a8493596f780837a\",\"/knowledge-medium/pr-preview/pr-1904/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1904/chunks/app-CuVlsfu7.js\":\"8271c4f04fdb547f\",\"/knowledge-medium/pr-preview/pr-1904/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1904/index.js\":\"766db94bb054e548\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1904/assets/AccessHandlePoolVFS-BrTCvkYR.js\":\"691b9b6e34e4c6fb\",\"/knowledge-medium/pr-preview/pr-1904/assets/IDBBatchAtomicVFS-xu9p-z6c.js\":\"0bb34832b79a4ba2\",\"/knowledge-medium/pr-preview/pr-1904/assets/MemoryVFS-ClNzB9Vo.js\":\"6ca89a2ce16db9ec\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-B1ZvrQ6z.js\":\"d2e9ceb833f79291\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-async-pk0cuaze.js\":\"9c6c8a2e595ff098\",\"/knowledge-medium/pr-preview/pr-1904/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1904/chunks/AccessHandlePoolVFS-BAPinyx_.js\":\"eae0d13c95326882\",\"/knowledge-medium/pr-preview/pr-1904/chunks/FacadeVFS-D6KETTrI.js\":\"34f02088ab54c2c1\",\"/knowledge-medium/pr-preview/pr-1904/chunks/IDBBatchAtomicVFS-CdGeYXQ_.js\":\"391cf983b29c3fda\",\"/knowledge-medium/pr-preview/pr-1904/chunks/MemoryVFS-DB-5ruT7.js\":\"5b62576ceae40d0d\",\"/knowledge-medium/pr-preview/pr-1904/chunks/OPFSCoopSyncVFS-DMkszqJe.js\":\"af28c1c69e93100b\",\"/knowledge-medium/pr-preview/pr-1904/chunks/OPFSWriteAheadVFS-Bjqm3kCZ.js\":\"8f2437c6d8d20a2a\",\"/knowledge-medium/pr-preview/pr-1904/chunks/Preview-LlBFCY1S.js\":\"080a526d50a7d113\",\"/knowledge-medium/pr-preview/pr-1904/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1904/chunks/card-Bxco0eLc.js\":\"ba400fb7b4dcd519\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-DcYqL7Jv.js\":\"c4b996c78c4a8d2d\",\"/knowledge-medium/pr-preview/pr-1904/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1904/chunks/mc-wa-sqlite-CHQXI_ug.js\":\"3cebfac3cd38c1f1\",\"/knowledge-medium/pr-preview/pr-1904/chunks/mc-wa-sqlite-async-DGCIhIJG.js\":\"b63aa4ddce172a8f\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-B31NqPDx.js\":\"c5f5e4cfcfacbf18\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-BOFDLpiY.js\":\"b517487ea30f8ca0\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-Bhmg49Tv.js\":\"b4fe0ac58166669f\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-Bx1RTw4z.js\":\"9e0d535a4c518e1c\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-ByH2YCTI.js\":\"c6a82d1117ecb5e5\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-C6AwJ-It.js\":\"d6c87cd1af96a5ee\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-DmvbP-Jh.js\":\"3cb9ad49b492dd36\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-ZXXvcXo3.js\":\"129046b2004792b5\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server-legacy.browser.production-BaYwSPlT.js\":\"9edce6559f2d0731\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server.browser.production-DeeSSdhL.js\":\"9af7d16dec77878a\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server.edge.production-uQjceg2X.js\":\"37d348d0dfe88d0b\",\"/knowledge-medium/pr-preview/pr-1904/chunks/server.browser-CnQDK4mR.js\":\"02d12ee1dbd93e34\",\"/knowledge-medium/pr-preview/pr-1904/chunks/textarea-C8hnx32o.js\":\"e69e354945d820bc\",\"/knowledge-medium/pr-preview/pr-1904/chunks/ui-CXuX94oC.js\":\"9a99d9fb7bdd2c90\",\"/knowledge-medium/pr-preview/pr-1904/chunks/wa-sqlite-D7BuUaaA.js\":\"cf882e46564c3495\",\"/knowledge-medium/pr-preview/pr-1904/chunks/wa-sqlite-async-D9DWlblA.js\":\"716c106f748a0b7a\",\"/knowledge-medium/pr-preview/pr-1904/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1904/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1904/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1904/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1904/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1904/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1904/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1904/src/App.js\":\"197ae53179596665\",\"/knowledge-medium/pr-preview/pr-1904/src/appUpdate.js\":\"12f8c7f13b8b4f75\",\"/knowledge-medium/pr-preview/pr-1904/src/appVersion.js\":\"22b2f028a31d1c56\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/initialLayout.js\":\"258dcf10e8715a21\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/openWorkspaceData.js\":\"0946cba3b55f03fd\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/resolveWorkspace.js\":\"f56d63e581556e52\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/workspaceBootstrap.js\":\"4b1c20c0930b923d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockComponent.js\":\"4be0755ee0c46c0c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockCrumbs.js\":\"4139132c98d62c04\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockEditor.js\":\"4dc8e56811c77bef\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockLoadingPlaceholder.js\":\"4f7fabb3c68a48b7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockProperties.js\":\"d3d85812642a47d7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockSearchPicker.js\":\"6e16b1459af78615\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ConfirmBulkDeleteDialog.js\":\"5e756e0fd309e67c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/DividerHandle.js\":\"6e7aac2d8eb574a5\",\"/knowledge-medium/pr-preview/pr-1904/src/components/DraftEditor.js\":\"eb47f195b8a12c10\",\"/knowledge-medium/pr-preview/pr-1904/src/components/GutterPill.js\":\"92e84a49b532f6af\",\"/knowledge-medium/pr-preview/pr-1904/src/components/Header.js\":\"1b1291dd7b690fac\",\"/knowledge-medium/pr-preview/pr-1904/src/components/LazyBlockComponent.js\":\"21881d076671f971\",\"/knowledge-medium/pr-preview/pr-1904/src/components/Login.js\":\"cd276136ee136da3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ZoomableSurface.js\":\"baf030a038179caf\",\"/knowledge-medium/pr-preview/pr-1904/src/components/editModeKeepalive.js\":\"05aa45c2e42df3a9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e717fc353da7259e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8f858c29b0a4e7f6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/RefPropertyEditor.js\":\"00668c944dc1f1f8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/RefTargetTypePicker.js\":\"bfeb7f9f382d1050\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/SelectPropertyEditor.js\":\"1f0eb07a64a3e3f6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/TypesPropertyEditor.js\":\"d124606f11cae763\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/defaults.js\":\"fbe9fe7fb23cdf1c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/kernelValuePresets.js\":\"713c35be9e2cb417\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/selectablePresets.js\":\"106caccb066b5db6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/typesPropertyUi.js\":\"156db0bc4ec607b2\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/AddPropertyForm.js\":\"0e9ed950d5a0d6c6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/PropertyPicker.js\":\"080e2e2fb6cf885e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/PropertyRow.js\":\"ced8adda6fc55e09\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/Rows.js\":\"84326cf701bc5c2c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/actions.js\":\"cedc78997a92d122\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/declarationOnly.js\":\"8aadbdd9b1902b01\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/layout.js\":\"c2aba9ede86ea1fb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/model.js\":\"33c1f24f315c317e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/shapeUi.js\":\"f5cd9a319dc64d7b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/shapes.js\":\"1fce320e1cfded77\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/usePropertyEditingActivation.js\":\"da9c3d2ea7b525f4\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/visibility.js\":\"31abe25d047509a6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanelSections.js\":\"79e39001e832a4c7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockEmbed.js\":\"7c90dfcbffa1887f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockLink.js\":\"b5643c134ad49a06\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockRef.js\":\"f070c0727fef0a21\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/CompactReferenceLink.js\":\"7ea84647d3429726\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/ReferenceLink.js\":\"94f442cb3609df63\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/cycleGuard.js\":\"d91b7f6e79f9be44\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/cycleGuardContext.js\":\"db7ca52cdcad1fec\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/linkInteraction.js\":\"6de6f1f587039736\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/referenceLayout.js\":\"9bfa93f1af41c2c9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/useBlockRefAncestors.js\":\"31efd1bea87d7488\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockGutter.js\":\"b23af4a995e3e9e1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockInfoDialog.js\":\"7657133c21e5fb9e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockReadText.js\":\"11df9190b46c51ac\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockTypeBlockRenderer.js\":\"4e1d323cfd1cd8fe\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BulletHoverCard.js\":\"cee862899668db83\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/CodeMirrorContentRenderer.js\":\"34c91eb77a5d1c17\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7a6dc6d722040914\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/ColumnResizeHandles.js\":\"f3a76d360dfe58e8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d3eec946502a7211\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/DefaultBlockRenderer.js\":\"20f93ef145b1a675\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/LayoutRenderer.js\":\"b91377e61773c231\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/MarkdownContentRenderer.js\":\"4a2c451c65c00e68\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/MissingDataRenderer.js\":\"56b4ccbe08e74cd9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/PanelRenderer.js\":\"be7129cd248e0b87\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b7da7d1709021360\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/TopLevelRenderer.js\":\"25572657ee962456\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/blockGutterMode.js\":\"912243ec97fd937b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/blockTitleText.js\":\"78c8dcfa5052a091\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/fieldCreationKeydown.js\":\"c76804e79dafc348\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/layoutRootContext.js\":\"2c64d5e2e88513a0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/typeChip/TypeChip.js\":\"614611260d8764bb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/typeChip/chipStyle.js\":\"ce3f816cf0de9916\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/anchored-floating.js\":\"a2f3aa42a3b58e7a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/button.js\":\"852d1d4d07721be1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/card.js\":\"dbe7885be9ae086e\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/checkbox.js\":\"355c7b322ac5ea8b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/collapsible.js\":\"03b311491a4db8b8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/command.js\":\"aefd742db6f9a111\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/context-menu.js\":\"d2fe452354cc9a87\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/dialog.js\":\"3c5184809b6b8fda\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/dropdown-menu.js\":\"f8e22ca072329323\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/floating-listbox.js\":\"206cd25eb293c14a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/index.js\":\"b541ecf61e507d74\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/input.js\":\"7b895dbbcf284d40\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/kbd.js\":\"2869cb5d30c8c5d4\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/label.js\":\"f05dbe6ac1243f48\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/textarea.js\":\"15ed4fe6977d4167\",\"/knowledge-medium/pr-preview/pr-1904/src/components/useEditModeYieldKeepalive.js\":\"e3a87bd4674f34d2\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/BootFallback.js\":\"4ecdbfb6d8ce9f82\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/FocusedRowLazyMount.js\":\"806a3036ccb17296\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/LazyViewportMount.js\":\"c23ba0516e5fe5f0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/LocalDbCorruptionFallback.js\":\"c30afe1f38711ff5\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/error.js\":\"f59dd0b2e21f3b50\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/lazyMountRegistry.js\":\"a63a8853e618592f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/suspense.js\":\"c81823ecbe0d4363\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/CreateWorkspaceDialog.js\":\"2e440fe2ad494021\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/PendingInvitations.js\":\"327ee45429d16197\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/SyncProgress.js\":\"9a6ab0666dd2d1d6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/UnlockProgress.js\":\"a99daaa5c21062fa\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceKeyGate.js\":\"8f64467987f5109b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSettingsDialog.js\":\"7521ba2551829de9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSwitcher.js\":\"bb414bd4d6f0eb67\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSyncGate.js\":\"a5b831cd73f481ac\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/ConversionFlow.js\":\"cba388d5b63f38d1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/ConversionFlowHost.js\":\"5242502942093dbc\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/EncryptionSection.js\":\"d0ca05e62625a945\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/attachmentPrompts.js\":\"51fb3ef64253117d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/bundleFolderPrompts.js\":\"9f9427400d364e98\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/conversionFlowDeps.js\":\"5c05836f9963b7b9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/conversionFlowStore.js\":\"5c27a104be62a177\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/flowUi.js\":\"a73991208c819d87\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/useConversionRun.js\":\"534c28f2e2b4dd61\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/keyUi.js\":\"3a8f5c3c9b29ea2c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/useCloseOnKeyLoss.js\":\"0f142401cf22e196\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/useCloseOnServerE2ee.js\":\"3882cc10accb7d76\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/workspaceUnlocked.js\":\"d6226d077fe20a57\",\"/knowledge-medium/pr-preview/pr-1904/src/context/backgroundSubtree.js\":\"f977b673b0bacb16\",\"/knowledge-medium/pr-preview/pr-1904/src/context/block.js\":\"c16823f703e00846\",\"/knowledge-medium/pr-preview/pr-1904/src/context/layoutWsContext.js\":\"29508db5e363b18f\",\"/knowledge-medium/pr-preview/pr-1904/src/context/propertyDisplay.js\":\"d8f8bdcd84933b7b\",\"/knowledge-medium/pr-preview/pr-1904/src/context/repo.js\":\"a91839e847719c92\",\"/knowledge-medium/pr-preview/pr-1904/src/data/aliasClaim.js\":\"d09b92f9c9db0b60\",\"/knowledge-medium/pr-preview/pr-1904/src/data/aliasSeatNamespace.js\":\"f90326dd15392047\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/blockData.js\":\"2f136943dc8127a8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/blockType.js\":\"eb7773b223c988ae\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/changeScope.js\":\"527bd7c075ca91ab\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/codecs.js\":\"3fdc5b0cbb478bed\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/derivedData.js\":\"89c354f70fc69045\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/errors.js\":\"3c195f14315e504f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/events.js\":\"4b9bd32d26443665\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/handle.js\":\"adc55f0bb5ba7b77\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/index.js\":\"b90b7f119da7671d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/mutator.js\":\"ba4111172396bd79\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/processor.js\":\"77bf8afedcc08459\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/propertySchema.js\":\"97e5776e84d6fa86\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/query.js\":\"7ff599268453a9b8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/sameTxProcessor.js\":\"90333404a92ae34f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/schema.js\":\"adc55f0bb5ba7b77\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/tx.js\":\"adc55f0bb5ba7b77\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/typedBlockQuery.js\":\"e92803fb1d0f50c0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/user.js\":\"004b20c565ee5daa\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/valuePresetCore.js\":\"40808e9d1a8651d0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/valuePresets.js\":\"3de448946fa248d5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/attachmentCleanerIOVerb.js\":\"ba408023b1e2db89\",\"/knowledge-medium/pr-preview/pr-1904/src/data/block.js\":\"5412140eadcf24b1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockCache.js\":\"5f29d1c627abe09b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockId.js\":\"8e514e56a73868b2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockLiveness.js\":\"ea9ce95ce470ea32\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockMerge.js\":\"e3a0a3f2918bb2bf\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockSchema.js\":\"9bb7f0c0b263dd9c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockTypeLookup.js\":\"255887ae3636672b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockTypes.js\":\"65707670924cfa53\",\"/knowledge-medium/pr-preview/pr-1904/src/data/childrenView.js\":\"c41df02ff295e382\",\"/knowledge-medium/pr-preview/pr-1904/src/data/clientContext.js\":\"d05b9617f8d95e51\",\"/knowledge-medium/pr-preview/pr-1904/src/data/dbFileSiblings.js\":\"479fdfa2012e314c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/definitionSeeds.js\":\"10f5a1908a754c44\",\"/knowledge-medium/pr-preview/pr-1904/src/data/derivedIds.js\":\"a4b900af162b6159\",\"/knowledge-medium/pr-preview/pr-1904/src/data/drawnSubtree.js\":\"8abc86d8f73fee21\",\"/knowledge-medium/pr-preview/pr-1904/src/data/facetBridge.js\":\"1245a72496643898\",\"/knowledge-medium/pr-preview/pr-1904/src/data/facets.js\":\"ce83442de21ee2d2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/globalState.js\":\"0b4e2d4d18147f8f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/aliasClaimRederiveProcessor.js\":\"4fac950cdd1062d1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/ancestorBatch.js\":\"7a0012b1928a3f16\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/blockTypeTypeifyProcessor.js\":\"4679ac54a8f3b4a0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/clientSchema.js\":\"49553440592b4d6a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/commitPipeline.js\":\"a47e2ebf9fed4fc2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/devAssertions.js\":\"76f55f1bea78e694\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/firstSync.js\":\"842c6c0547f4d266\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/freshInitialLoad.js\":\"189420871f308012\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/graphBackfillClaim.js\":\"b91015cd6efbff96\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/handleStore.js\":\"3c972aa58223fcd6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/idleMarkerJobs.js\":\"e9c6ad640a64c5b1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/initialDownload.js\":\"371feaef14844ced\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/initializeClientDatabase.js\":\"18a8c5e31a052ea3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/jsonCanonical.js\":\"fcd2bfdfd1b1e568\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelInvalidation.js\":\"297c9babb374e235\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelProcessors.js\":\"45c62c40b324e9c3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelQueries.js\":\"5fe549cb4c0db1aa\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/mergeTypeMembershipProcessor.js\":\"827c8fafd8d546f7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/normalizeReferencesProcessor.js\":\"c334293116960782\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/poolInstrumentation.js\":\"b27aebff12071a45\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/processorRunner.js\":\"ef27c19f2d1dc2f3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyCellBackfill.js\":\"4277897317daa512\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyChildMint.js\":\"0437bfa1f2e34888\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyChildrenProcessor.js\":\"5316235511fafa69\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyDefinitionChangeProcessor.js\":\"58636350b185a23b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyDefinitionSynthesis.js\":\"17e3ad962ac34b48\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyKeyScan.js\":\"56aee57f33720017\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertySchemaResolution.js\":\"902846fe42f84be3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyValueEdits.js\":\"1ae73e1c901f5497\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/raiseProtocol.js\":\"e2f555a6488e73ec\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/readBatch.js\":\"db8871a4587cbe95\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/refProjection.js\":\"fc220dd0d37340e2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/referenceTargetLookups.js\":\"3b8f53dd1467d17b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/referenceTargetProcessor.js\":\"5b9c573f7e40d6f3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/replayMerge.js\":\"1984d2b9d95d5124\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/sqlBinds.js\":\"0b3062daf0e7e7ce\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"711762251fb2a3a8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/arrivalProcessors.js\":\"d90ffe8a408fc2bc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/invalidate.js\":\"7de71c881db51d4a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/materialize.js\":\"a69acc649014abc6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/observer.js\":\"e851d4496f8f4842\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/reconcile.js\":\"80f6ef7c18acd403\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/timingMetrics.js\":\"161d5f425ad52164\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/treeQueries.js\":\"b79fba91bd1be8c1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/txEngine.js\":\"ac72881904ede3b9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/txSnapshots.js\":\"328cb4fc27bacea5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/typedBlockQuery.js\":\"171ba5fa1bb69413\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/undoManager.js\":\"5682cdfe0f5bae7d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/invalidation.js\":\"de465d03f4093c72\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelDataExtension.js\":\"70e59b75624ba667\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelPage.js\":\"6421e6a4a73960ea\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelValuePresetCores.js\":\"72ba52b1eb87c49a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbCorruptionSignal.js\":\"ed627b7c3c6bc877\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbStorage.js\":\"a276891e5999809b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbVfs.js\":\"1180e31ec5a13582\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localSchema.js\":\"7155261f84a67c8a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/maintenance.js\":\"e4cb59237d0fdeb9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/mergeProperties.js\":\"4ef5810c4ecd750b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/metricsConsoleHook.js\":\"9e408bbd148436c7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/migrationsPage.js\":\"68a32fd88b247598\",\"/knowledge-medium/pr-preview/pr-1904/src/data/mutators.js\":\"ad397b8ebb9a35a5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/orderKey.js\":\"c66ee669e4677c54\",\"/knowledge-medium/pr-preview/pr-1904/src/data/orderKeyPlacement.js\":\"bfb32b717ca9bb52\",\"/knowledge-medium/pr-preview/pr-1904/src/data/outlineSurface.js\":\"c0236e8ab931c15c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pendingEditorContent.js\":\"b9aa3c8adf172711\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pendingUploadsSql.js\":\"a673c24304b8a61b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pluginStateExtensions.js\":\"36021a308c04499c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/powerSyncLogger.js\":\"38ebe315a98c76a6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/projectorRuntime.js\":\"ca4092fa76e13d14\",\"/knowledge-medium/pr-preview/pr-1904/src/data/properties.js\":\"03c3e6a329482b25\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertiesPage.js\":\"9389d057af496b43\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyChildren.js\":\"8f89fa4bffb4bdd0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionFanout.js\":\"9b3523d216faeb1d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionMetadata.js\":\"5310eb0c04fc4705\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionRegistry.js\":\"118c24c413d77c7b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDisplayMode.js\":\"b78962c55e6bd0c7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyRowCreation.js\":\"a374c5c7c3165190\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertySchemaCreation.js\":\"794237eae77d222b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertySeeds.js\":\"4661b465e2ca638d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/recentsPage.js\":\"c8a580cbfc709dea\",\"/knowledge-medium/pr-preview/pr-1904/src/data/refTargetComparableProperty.js\":\"143ddc2873d44ab4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/referenceBlock.js\":\"6389282a2c6ac24b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/rejectedUploads.js\":\"775f05a2814eabf8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/releasePowerSyncConnection.js\":\"a83a83fea44e873a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/repo.js\":\"951680d08de94e43\",\"/knowledge-medium/pr-preview/pr-1904/src/data/repoProvider.js\":\"8942802be458afad\",\"/knowledge-medium/pr-preview/pr-1904/src/data/rowProperty.js\":\"f95949fec4c30b75\",\"/knowledge-medium/pr-preview/pr-1904/src/data/searchFilter.js\":\"45fb0a702a6a9f37\",\"/knowledge-medium/pr-preview/pr-1904/src/data/seedIdentityLedger.js\":\"46f9c95212ad039d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/stateBlocks.js\":\"8b2b4d3e22dda8f8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/structuralEditPolicy.js\":\"e24cd1e6392ce67c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/structuralInsert.js\":\"2af78ee9e7717eba\",\"/knowledge-medium/pr-preview/pr-1904/src/data/subtreeDelete.js\":\"76ece6b4fc03266b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncStreamLock.js\":\"abe6942eae7d0988\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncedTableSqlRecognizer.js\":\"d21e4fab0de1c7e7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncedTableWriteGuard.js\":\"f53906b5f2b5a4f9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/targets.js\":\"adcf034c7a3f3f26\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeColors.js\":\"c683e2a9b2489f91\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeDefinitionMetadata.js\":\"5eb175cbfbd06802\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeDefinitionRegistry.js\":\"0a66be8acf0f504b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeExtraction.js\":\"c7cf8565ee94b40f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeInitialValues.js\":\"f7c366bcae660f8b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typePropertyGroups.js\":\"edf39155e695edc4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeSeeds.js\":\"9f80f1d9409f1049\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeTagger.js\":\"16ef5d5f4b73f593\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typedRecords.js\":\"8b672d507f64a0ee\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typesPage.js\":\"a29347591b14482a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userPrefs.js\":\"09a1c2d331a1856c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userSchemasService.js\":\"ccf731f063f5153f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userTypesService.js\":\"16b7cfb57919be63\",\"/knowledge-medium/pr-preview/pr-1904/src/data/valuePresetRegistry.js\":\"79689a822c8600de\",\"/knowledge-medium/pr-preview/pr-1904/src/data/visibleChildren.js\":\"ebd2cf9407c79279\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceConversion.js\":\"cdb0ce1251c8f2d5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceFirstSync.js\":\"4bc6575233d8f5bb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceIdNamespace.js\":\"749a15d09bf1ae72\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceSchema.js\":\"ea40d1a79324d4fc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaces.js\":\"3605a7e24f5ed1ca\",\"/knowledge-medium/pr-preview/pr-1904/src/data/writeAheadLog.js\":\"96945da475f800f5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/BlockPasteShellDecorator.js\":\"ae44d3ae9a00e6a8\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/atTrigger.js\":\"2d010feb145e54f0\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/autocomplete.js\":\"875e251d862b664e\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/codeMirrorExtensions.js\":\"0c9640108683405c\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/contentFlush.js\":\"999c75ab043385c2\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/defaultInteractions.js\":\"015fe1e8f25db534\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/editSettleSignal.js\":\"5fd8ef657c36cafe\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/insertImage.js\":\"7577c9de1021db54\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/referenceCompletionRange.js\":\"a78f9e3b428c53d5\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/referenceTargetTypes.js\":\"6cbf47c1f35dca81\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/syntaxContext.js\":\"027719d17ae891a7\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/triggerMatch.js\":\"afe33e9a1efca857\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/AppRuntimeProvider.js\":\"e1a7d5cb79847089\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/BlockFocusShellDecorator.js\":\"1ffa7cd05b1b237d\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/ExtensionRenderBoundary.js\":\"30e46937b4bfb8ce\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/PanelContentRecovery.js\":\"cd8b332ea8a9c346\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/apiCatalog.js\":\"7aeda736858adc25\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/approveExtensionHere.js\":\"5e8374fcd910fd18\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/armedCutAppMount.js\":\"f1dc6213ebbe8a38\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/batchableKeyedStore.js\":\"5f349d91e9cb5014\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/blockInteraction.js\":\"e0dcc7e510084181\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/blockSelectionAction.js\":\"cd437eecb0ea62fb\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/compileExtensionModule.js\":\"64430faec05a9496\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/compiledModuleCache.js\":\"3532d76ea649d182\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/continuousGestures.js\":\"008e1cb000fd424c\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/core.js\":\"bc48a4d6339d6c2a\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/defaultRenderers.js\":\"42f2d49299e3fb07\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/definitionFanoutAppMount.js\":\"b44a3254ba52bbd3\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dialogAppMount.js\":\"0ba30f0b7f9577a9\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dynamicExtensionSeeds.js\":\"d32270442e020273\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dynamicExtensions.js\":\"48f676b4c7594886\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/exampleExtensions.js\":\"06594bb78f86a497\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionApprovalStatus.js\":\"38ee83ac73fdaa9c\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLoadErrorToast.js\":\"ae6d17cf75b78121\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLoadErrors.js\":\"e125493ddaa872e9\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLookup.js\":\"2d43150ec7746b62\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionToggles.js\":\"e2d30c4058b0e67a\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionUtilitiesCss.js\":\"a3862aac52ae04ad\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/kernelPageDeletionGuard.js\":\"de099ea24f5ff0f3\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/liveRuntime.js\":\"909a581bd45792c6\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/openExtensionsSettings.js\":\"df73dc066759e6f5\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/overridesCache.js\":\"00a953e5cd04d166\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/pluginIds.js\":\"d6d5294429b06a05\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/processorRejectionToast.js\":\"42a08ffd52b4cc0e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/runtimeActions.js\":\"2c44f2975a917323\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/runtimeContext.js\":\"818a16ef9c49437f\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/staticAppExtensions.js\":\"86c6b0ce7ac0d162\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/staticDataExtensions.js\":\"eaa2af2711a1133b\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/toastAppMount.js\":\"ff05faf58a9c7896\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/useOverrides.js\":\"fecbfd3cd83cd4d7\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/useShortcutSurfaceActivations.js\":\"4a7d363b020d0253\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/discoverToggleTree.js\":\"42827e7792d82e0e\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/facet.js\":\"0d69efc6f253f0fe\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/resolveAppRuntime.js\":\"8d94d09910e7f70f\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/runtimeEvents.js\":\"c259a82d958c6191\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/togglable.js\":\"3c06190ff340ae13\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/variantFacet.js\":\"c89d334eb98678c8\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/verbFacet.js\":\"545afe7fe94336eb\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/block.js\":\"ae13b9d75194b869\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/focusedChild.js\":\"396334c7db8ae680\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/propertySchemas.js\":\"f4413ca248038987\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/typeRegistry.js\":\"83ea876812ccb10e\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useAncestorCrumbs.js\":\"65733e9148baff88\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useAutocompleteListbox.js\":\"fa3becfb0a07623b\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useDebouncedSearch.js\":\"9ac029edac7efad2\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useDebouncedValue.js\":\"b6f9767a45d7d960\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useFacetValue.js\":\"23967365c7850a8a\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useIsFocalRender.js\":\"260e9f26fd454cd5\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useIsReadOnly.js\":\"935bbb50a916572f\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useMaterializeBacklog.js\":\"b9c5002b052dbe55\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useMinuteClock.js\":\"b86938f1a765d4fd\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/usePanelLayoutProjection.js\":\"e287379077ea9b38\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/usePendingInvitations.js\":\"9e4442a7521e05cc\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useRendererRegistry.js\":\"f93d053904a97292\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useRetainedFieldRows.js\":\"e3f3061adc95d517\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useWorkspaces.js\":\"a2f97c74a356612d\",\"/knowledge-medium/pr-preview/pr-1904/src/lib/utils.js\":\"928169ce1c9ac011\",\"/knowledge-medium/pr-preview/pr-1904/src/main.js\":\"5977883df3426163\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/MarkdownImage.js\":\"319ea39ced0a27b1\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/blockSeparators.js\":\"5ee07364b9379e1e\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/context.js\":\"47a6e29b5bfa5e8a\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/defaultMarkdownExtension.js\":\"33b88f6be040eee2\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/extensions.js\":\"71b1cbb30b32717d\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/renderMarkdownHtml.js\":\"5987ced0a14e93ca\",\"/knowledge-medium/pr-preview/pr-1904/src/minimal-editor.js\":\"8da8a72ae0392e99\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/armedCut.js\":\"b125884f8cb09630\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/captureMediaVerb.js\":\"031925ef55b1955f\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/clipboard.js\":\"7427792634dec7cb\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/decision.js\":\"22dec8acc5caa1ed\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/operations.js\":\"23778f16edcdaeaf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/account-header/AccountHeaderItem.js\":\"ab2dbde2b7c3eb22\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/account-header/index.js\":\"18a343759b6fd04a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"a4d98e5bf540f04d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/askAgent.js\":\"4c45fe74891b2704\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/askedStore.js\":\"8c4aa173eeb08df8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"a30c283ecb2b14d0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/chipState.js\":\"21213a642a7aa0af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/dataExtension.js\":\"61d84772ed1d89ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/index.js\":\"053e89b8bc82b790\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d16fc9c21341cfea\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/schema.js\":\"88251a5a43800ea7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/AgentTokensDialog.js\":\"bfa7547ec03fe647\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/BridgePairingDialog.js\":\"281d290bba08e04c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/addMedia.js\":\"861732377c2ad6f4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/backlinks.js\":\"2bbab572d8c7f322\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/block.js\":\"580cf3f2dee019b4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/context.js\":\"0a325aa691109b64\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/displayIds.js\":\"6d297e07af77cdd4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/index.js\":\"26c2bc9fec508f00\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/outline.js\":\"99498809a19026e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/properties.js\":\"0a8dd1ee5d7298b6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/refs.js\":\"63a5de1a6f753c06\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"92dfeea1d9b6ad1f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/search.js\":\"98f68cab74cd831f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/shared.js\":\"9ba7ab5edc203c30\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d410bb4a9b81958e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/text.js\":\"a3991efc4ca0c11d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentWrites.js\":\"d65cb2e2a05ed832\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/authoringCatalog.js\":\"e1f1c559acc959b9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/blockRefTargets.js\":\"d944ec3d0aef839f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/bridge.js\":\"25dada140524e70a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/bridgeLoop.js\":\"7f6452b9069b5f3b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/changeHistory.js\":\"83f89702795423da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/commands.js\":\"556f670ad55af518\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/commentsCommands.js\":\"063da7156fb32bce\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dataExtension.js\":\"95884a57dca33ede\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dataModelGuide.js\":\"52255fa0042d7a7f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dayPropertyInputs.js\":\"972ec2b16b065ff4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/describeRuntime.js\":\"546f25adde94ae85\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/extensionLint.js\":\"41871f137a2d6f4b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/grainAudit.js\":\"6fef8f364b4b9a89\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/healthCommand.js\":\"2341c04025e10b32\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/index.js\":\"75f243b34cad9d55\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/presetIdentity.js\":\"2fde0af21662c782\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"6e79f1a8ddda156f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/readMedia.js\":\"6c90e74ddfa51bc6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/schema.js\":\"2c85706278a125b2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/serialization.js\":\"73acd4d44534796f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/targets.js\":\"ba48d756e3a40ef1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/tokens.js\":\"1ee981861e88c9ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/watchEvents.js\":\"969fac9c4eb39bff\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/workspaceGuard.js\":\"04258c92d4f8af99\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/writeCommands.js\":\"398ca57531755ae8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/AliasCollisionToast.js\":\"2a0922b365d81d24\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/DuplicateNameBanner.js\":\"19ec3449370ca1be\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/collisionMerge.js\":\"f2a838133b2392e5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/dataExtension.js\":\"2b275fcf2b0029c3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/index.js\":\"84346ea37afeec01\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/mergeCollisionAction.js\":\"a03ff2e3e25717f4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/pageStyling.js\":\"f70bc675af1ab3a7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/rejectionToast.js\":\"643f7884bfb72af6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/syncProcessor.js\":\"d4159c6de18322df\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/actions.js\":\"f9698a6f7f935ff3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/addComment.js\":\"40a790b46d51be78\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/anchor.js\":\"999de5c050abfb50\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/anchorState.js\":\"71f8a52b95cd9dc9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/commentLinks.js\":\"b532791e00f22bc0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/confirmThreadDeletion.js\":\"06f9ce32ed819c83\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/container.js\":\"d156686d415b089b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/dataExtension.js\":\"b88dbb1585a52758\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/deleteComment.js\":\"d31332d00ef7bcee\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/highlights.js\":\"e8544eb7b1d2e373\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/index.js\":\"15b233f408daa930\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/linkedCommentsPill.js\":\"a9bdc00e8738b061\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/margin.js\":\"f8d1d56cf8f57219\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/marginAnchorLinks.js\":\"0a152abcb497fe44\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/marginSchema.js\":\"944216f8febf6d44\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/newComment.js\":\"1182fb31c7f0c0aa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/ownThreadPicker.js\":\"8f9169598bbde6a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/placement.js\":\"a53ec1eede89f830\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/queries.js\":\"9ba2cac93b3d0093\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotePosition.js\":\"7554d4e3592f2b86\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotedIn.js\":\"07cfbe554fabfd0d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotedRange.js\":\"2b89d85a00d549bf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/rangeRefs.js\":\"9442fef5f3fe34e5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readHighlights.js\":\"e5e7359e7962e328\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readSelection.js\":\"d45122f3c50ffce2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readSelectionUi.js\":\"c6fc1b854ca48885\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/reanchor.js\":\"4e0f3222d4d18f84\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/schema.js\":\"e934106de63f2c78\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/scope.js\":\"7e8ed8572f85ebbe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/scopeThreads.js\":\"0af136ee43cd0d2f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/splitRetarget.js\":\"6c51c8a8fffcfe7b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/suggestionCard.js\":\"bb610d75ddeb5e15\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/suggestions.js\":\"ab90124b4dbde95d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/summaries.js\":\"a5fd3e04e2f6ef63\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/summaryBatch.js\":\"15e7b1ccd2f49861\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/surface.js\":\"e28d21964367d3e6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/threadNavigation.js\":\"8780532627694315\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/threads.js\":\"627d7fc67188aa44\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/ui.js\":\"92fcad577f2b4dfd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/uiStore.js\":\"7dfc987983848aac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-intents/appIntents.js\":\"4f1bf1a78c420f74\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-intents/index.js\":\"9b874fb787fd6b4c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-update-prompt/index.js\":\"f74ec872481ec842\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-update-prompt/status.js\":\"88373b9ce069a16b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"5f0af336daafeaca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaBlockRenderer.js\":\"3ef84f46986753b2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e9d5190a3843db05\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaUploadReconciler.js\":\"f0c1a7fb390ec2a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetDownLane.js\":\"183063003be904fd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetResolver.js\":\"a5f61aa993facc13\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetUpload.js\":\"66596fb807a862e0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/attachmentCleanerIO.js\":\"c1a4e85ebb98859a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/supabaseAuditIO.js\":\"69a65d2430c62f84\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/blobStore.js\":\"ceacf57ca647a798\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/browserMedia.js\":\"86a7eb8245653f9b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/byteStore.js\":\"17794324afe2f05f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/cleanerIO.js\":\"e8e60ef5c9d1102e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/cleanupAttachments.js\":\"f1f19f80a59be441\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/dataExtension.js\":\"557e8722968051e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/downLane.js\":\"9ddc9d9e9910d9da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/index.js\":\"066e2c6cd2f7cda1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/insertImageContribution.js\":\"610b9ad7ad07d88f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/laneArming.js\":\"d2f3c289563d903b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/laneLock.js\":\"25acd399ea0055bf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaBlock.js\":\"ffa291a8c2116ef3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaCapture.js\":\"f15b44958a2bb436\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaLanes.js\":\"8960a480cdada042\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaViewers.js\":\"feace12a71d5dc7c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaViewersFacet.js\":\"d2936f40a3a3b5e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/pasteCapture.js\":\"bf0782665c9c87be\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/resolver.js\":\"71e3ca1dd32a7ab7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/retryUploadsAction.js\":\"24262fcc6347761c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/storagePaths.js\":\"27456510921c3914\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadDrain.js\":\"ae1dc5f6d2c4c09d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadLaneStatus.js\":\"4f71d8fc68bcc959\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadReconcile.js\":\"c99fc51720b2af41\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadRecovery.js\":\"deacc5cbf82a9238\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadStore.js\":\"a1d225e89c7b75a4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/useAssetObjectUrl.js\":\"8accf4ad266d88b7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"af51cbc9b41265c0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/BacklinksViewSection.js\":\"290bee67183a1586\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/facet.js\":\"a2dd389df8d2587e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/index.js\":\"a9a60e7bc3ad7c4d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/prop.js\":\"7f5b4d065112346c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BacklinkFilters.js\":\"67039cc23b2c98d8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"606dff29a09f4e3f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BlockEntry.js\":\"5f6a9eff842e2707\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/LinkedReferences.js\":\"c94791348768e3f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"4aafc492062abdb2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/dailyNoteDefaults.js\":\"38aacf5c7656c6ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/dataExtension.js\":\"1d0a257b3b2913b6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/edgeExclusions.js\":\"a30aef354d07a773\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/filterProperty.js\":\"586f7528a6a32d9d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/index.js\":\"e742b5b9284d479a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"4ab308b3bb4e7c3a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/applies.js\":\"e0063693c2c059f8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/countQuery.js\":\"815b610bf0abdfc0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/expansionStore.js\":\"6c6fff918c278d12\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/index.js\":\"f5c5df589ad0dd12\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"924df494008827e6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/presentationInvalidation.js\":\"5990a4239f55bda7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/propertyEditorOverride.js\":\"e6f5de8a4f000065\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/propertyFilter.js\":\"0189f03cfc680ed6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/query.js\":\"35724555f1efffa9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/resolveFilter.js\":\"738004918f24e47c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/sourceBatch.js\":\"eb04ac57f4af26cb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/sources.js\":\"3b2a8806cf2acc9a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/useBacklinks.js\":\"28bfb62322088d2a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5a1c15350ef132bd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/BirthdayCelebration.js\":\"84221e4d8ebf1c24\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/BirthdayOverlay.js\":\"7507164356956de7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/gate.js\":\"37b1a0c4cf00a26a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/index.js\":\"ca26ff297dd48616\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/wolfTheme.js\":\"a410fa47b418418c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/BlockDragLayer.js\":\"2b0d1ce0e1d5f7db\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/dragController.js\":\"8a4cb4b11700b441\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/dropTarget.js\":\"a872a2ceaa7db184\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/index.js\":\"d031282508334dbb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/projection.js\":\"73ae04dcd1910a0c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-info/BlockMetaCard.js\":\"94871f7bbcaa02df\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-info/index.js\":\"12856df0a9d338cc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/AddTagDialog.js\":\"65682b175e4b93f4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"757ca7b2e077ca6a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/TagNameIssueHint.js\":\"5875517a04fc81c7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/addTagAction.js\":\"e267da7b5df49763\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/appendTag.js\":\"a6fe4a46644fac1b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/config.js\":\"742c4d05ec97d1eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/dataExtension.js\":\"ac43e5c634a4d85f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/index.js\":\"4aeb3ddd19c90666\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/propertyEditorOverride.js\":\"ed00a4ac955eee48\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/BreadcrumbList.js\":\"648ab7476332a0c0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"dac63af4ff31213a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/Breadcrumbs.js\":\"61470fae67f51483\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"ee5e2a72efd84e06\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"da61abdca861530f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/index.js\":\"785c7e5214fd2233\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"97aca3ab103aa769\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/CharacterCountItem.js\":\"c40061122295b980\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/ProfilePropertyEditor.js\":\"ca03463d21b0b8c6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/actions.js\":\"c32c6e8620dc53fb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/blockType.js\":\"df36ff6ba4abd4ff\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/charCount.js\":\"b92b93555107a0b4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/dataExtension.js\":\"2c3917b14f23db9b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/index.js\":\"87614790c7561aab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/profiles.js\":\"a50a374c2f445545\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/properties.js\":\"386987c92a29f62c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/subtree.js\":\"b7db9493195e3006\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/textCounts.js\":\"e9628209668d047d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/colemak-keybindings/index.js\":\"b4ea2dfe9ef36810\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/CommandPalette.js\":\"8c0512e2915cd3e6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/HeaderItem.js\":\"a48bbe5c9dbad5dd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/context.js\":\"7256c3bfa58ddf4c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/index.js\":\"07be4a7c72f7f749\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/selection.js\":\"a124427b1d5d6748\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/toggleStore.js\":\"2af0b7a31aceedf4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/useCommandPaletteActions.js\":\"f0e655b7a4144d31\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/ContributorBadges.js\":\"ffb0b5707fe613b7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/ProfilePicture.js\":\"06453f3d3b0b97fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/author.js\":\"08e07524c8d5cfee\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/codeMirrorExtensions.js\":\"c79751062c6835cd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/dataExtension.js\":\"ab9a1643544f0c42\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/index.js\":\"7e1a59f83d9a8dca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/mentionAutocomplete.js\":\"72dbdb3c6c5b61cb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/processor.js\":\"2214871bb5074c96\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/profiles.js\":\"d4a6b1a638074468\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/queries.js\":\"7cb8aa45f98fbd81\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/schema.js\":\"ae444b8debe44bf1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/useCommentAuthor.js\":\"cc8313130120c7da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"154961066c4de8cc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6727e1f44d31aa39\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/index.js\":\"055c6c90dce0c860\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"9adfe87ef1190262\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"029d076cc4f585bf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/CalendarGrid.js\":\"8140c947f6b04090\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DailyNotePicker.js\":\"c411aed58f80b446\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"cb8152849d3945ba\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateNavDecorator.js\":\"0c315f08ab8a90cf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateScrubOverlay.js\":\"5d581e87a3c5f14a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DayPropertyControl.js\":\"1b889b269e858a85\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DayValueReferenceControl.js\":\"8521999867f5ab4e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/HeaderItem.js\":\"c0b748b37ab4802f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/ReschedulePicker.js\":\"fe128a2dfbca7ccd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8097d171ccec7d37\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/actions.js\":\"6670d7974c762832\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/blockDateAdapter.js\":\"e44c2d6de0c81039\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/calendar.js\":\"d1ae3d51d10c094d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dailyNotes.js\":\"e6c2c767c8259eb1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dataExtension.js\":\"8c0fef83c2452503\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubActions.js\":\"c6edb4f8184e3c63\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubGesture.js\":\"9ba39f2d29cc45a6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubGestureActions.js\":\"9f04e0a2ac62acb0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9a3d844210f6ad21\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dayProperty.js\":\"8a42f34321e7216e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"2b438a48e309f66c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/deletionGuard.js\":\"2435816e3427b98a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dueQuery.js\":\"609faa8e125920a1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/index.js\":\"d7fcd9eda4651d2c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/landing.js\":\"75ac0fc3e2bdc3c1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/localSchema.js\":\"6a3b03dc4b1cb269\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/referenceDateAdapter.js\":\"856aa0c9fe9f8dac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/rescheduleAction.js\":\"07ef020dd9077a50\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/schema.js\":\"d457443f22542bf2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/spreadBlockDates.js\":\"5c2caff9820b03d5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/spreadDatesAction.js\":\"fd8010a1c0cac037\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/today.js\":\"ac59126d862ebada\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"04b314e473c490b0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"fabfbb331c82cd8f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/audit.js\":\"181260bc92dc333c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/auditAction.js\":\"516e7ea2a1609a58\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/auditRanges.js\":\"e15937ef3cc92a20\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/diagnosticsSource.js\":\"24f11108b1838d34\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/divergenceScan.js\":\"19f424b768ab821c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/index.js\":\"8f4f13bad56266b4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/propertyChildrenChecks.js\":\"a6c430f5dd01c15a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/referencesMirror.js\":\"485c82f01ab3b8d2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/rowJson.js\":\"554e01812dd92f80\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/schedule.js\":\"b235833c2feae2a6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/store.js\":\"8fff4b6a517b4b18\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/action.js\":\"eb5db07bd92354d4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/index.js\":\"4a4b9fcc4984a85c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/plugin.js\":\"418a5ac7ca1c3674\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"669c09c22100bdb8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/actions.js\":\"425060a910744e10\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/changeMarker.js\":\"3938deecc5e2a248\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/diagnostics.js\":\"8ccb39522b7b5432\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/fileSystemAccess.js\":\"0d21fc9a0f7e1d00\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/filenames.js\":\"1550759a5242fd7c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/index.js\":\"c89b48b206e60ddc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/mirror.js\":\"edb5cf70f2684983\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/runLock.js\":\"a5d861f19a1e67c0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/runtimeHealth.js\":\"daad5d33ec57c912\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/schedule.js\":\"8c98f31d4f88512a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/store.js\":\"a18c6035ec1aadac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/default-themes/index.js\":\"af3b9cb17900c05d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/default-themes/themes.js\":\"e2d595b3a3207d7d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/diagnostics/facet.js\":\"539681ca745163a4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/diagnostics/useDiagnostics.js\":\"e2bf3df7a867b57f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/dismissals.js\":\"20da2ab75667fcd0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/index.js\":\"d6f607da7880a78d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/status.js\":\"4a11e78fba607775\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/store.js\":\"17fc9a433283eee4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"bb18facaf0bd6078\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/ExtensionsSettings.js\":\"cef0e9e9eb9c748a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/actions.js\":\"445230f2dd448519\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/config.js\":\"4c655ef11cc0a3fd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/dataExtension.js\":\"5424a8512dcf7452\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/effect.js\":\"4045639e09041248\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/index.js\":\"fc18e6fe976d2a93\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f934f3a714c27945\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/useToggleTree.js\":\"3b6e427568a1c9af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/ExtractTypeDialog.js\":\"15ceb2ce7793c0e7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"abc6b365f0dd0869\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/PropertyShapePicker.js\":\"b1fd007476f810b5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/action.js\":\"ef7da9d2de1c432e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/index.js\":\"53e0f0bb0653c6d5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/FindReplaceDialog.js\":\"2e93515db556d178\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/HeaderItem.js\":\"e5da8d3475d082fb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/dataExtension.js\":\"67dbee90c4481d32\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/index.js\":\"14f351fa84cee59c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/search.js\":\"c542e6275966533e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/toggleStore.js\":\"7ff0fb93339d4cf8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/LocationPropertyEditor.js\":\"b8452b27020e3d6a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/MapView.js\":\"98ca52727f5512d1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/blockTypes.js\":\"bf62467753d8470a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/codeMirrorExtensions.js\":\"5817e986a6510edc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/createOrFindPlace.js\":\"1ad87bf212aaf8dc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/currentLocation.js\":\"de419817a44cdeb8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/dataExtension.js\":\"ac6ab8be90c82b7e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/geoContentDecorator.js\":\"249de9ed0f607885\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/googlePlacesClient.js\":\"07a9c4ee4be0fb05\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/index.js\":\"325f6a3a37dc4cfb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/locationsPage.js\":\"14134b790fbac3e8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/mapViewport.js\":\"52a7192fd380391e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/pickCurrentLocation.js\":\"bc41cae8ded2dbf8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/placeAutocomplete.js\":\"ff181b5f847f24fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/placeNameCollision.js\":\"2cd3d97272885051\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/properties.js\":\"601cb1a580498af6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/propertyEditorOverrides.js\":\"6edac3be8e6ac560\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/query.js\":\"d35b54a8f863b912\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/usePlaceSearch.js\":\"f6bb346c02f2787b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"cc68efa74ff19297\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ab98663d9a4cbd85\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a2d034e601a8b2da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/config.js\":\"a7879d13ea3c027f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/dataExtension.js\":\"868949d789082702\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/facet.js\":\"7712eb717b7b6bca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/grouping.js\":\"469c4ebde9a5c559\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/index.js\":\"b5f761ff35d29335\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"eaa265ca481575ba\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/query.js\":\"7c41f765ce46430b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/resolveConfig.js\":\"0bf40aef6e6f07d1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"3e1a88e22a93b84a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"369d9ad09b41e955\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/HtmlDocumentContent.js\":\"a0030c1d1f087df5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/HtmlFrame.js\":\"98ed55e8142a848c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/actions.js\":\"bb4c16ecacde2cf6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/blockType.js\":\"3cf6e479aac90d8a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/confirmRunScripts.js\":\"c06b43b78503f49e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/dataExtension.js\":\"d9c332471af3b3ca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameAnnotations.js\":\"e42683806fb6d23d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameDocument.js\":\"4eef06e79fdbe53d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameTheme.js\":\"5564458e38c80a46\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/index.js\":\"283269ff2465daf5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/scriptConsent.js\":\"162b727bce4f97c8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/sourceMap.js\":\"6643e7207e5c29ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/useDocumentScripts.js\":\"d12157e783148374\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/index.js\":\"58ce31a53d0ad7a7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/record.js\":\"db39e17ff829d528\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/recordStore.js\":\"4a7ff83b8d1fbdd4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/responsiveness.js\":\"74f2ee47ff9e2dc6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/schedule.js\":\"9a689ee6558e5d17\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/sessionContext.js\":\"dc4107608a63bca6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"37472a385aba77a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ab6484db2cdf9e8f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/actions.js\":\"149b9428517f0182\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/config.js\":\"dd885356167b931f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/dataExtension.js\":\"e0e6c42d3fa31636\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/effect.js\":\"9108df01dcfd3faa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/index.js\":\"c452bfbf00ab2f04\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/keyCapture.js\":\"0a1d26efebb9a09f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/overrideStore.js\":\"8c6f16804d86518d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6067f74a356468cd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/HeaderItem.js\":\"0ddb790967c3475a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/LeftSidebar.js\":\"3a2751084389b375\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/actions.js\":\"dcd1c0aebb69719e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/facet.js\":\"b0d72f9071f1c858\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/index.js\":\"e802b2358da24210\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/shortcuts.js\":\"445f2493dee27591\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/toggleStore.js\":\"50285e95f8433d47\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/MergePicker.js\":\"90e8452ab8d6845f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/index.js\":\"9847aafc2d5370ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/mergeAction.js\":\"0687f834679f595c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/strategy.js\":\"63bc4a189204208e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/Button.js\":\"5aaad65d31753c90\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"835b2ea747037f14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/defaultItems.js\":\"371a41e4b22a8cee\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/facet.js\":\"c4b2a6318fbefaa3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/index.js\":\"895f7c436725fa8a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"2b6a9b28fb3b3bf6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/actions.js\":\"09ad7bb8aa90843e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ee0c3af785a2458c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/facet.js\":\"00e78699115fe1b7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/index.js\":\"5bce015d3bea1c1b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/MoveDestinationPicker.js\":\"86ffe03f9f8c25f6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/blockSubtreeMembership.js\":\"3d062b96e1b10384\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/contextMenuItem.js\":\"480f6d527fbce8c8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/index.js\":\"a3eac809feb0d5a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/moveAction.js\":\"0b0ff7e4ee1f047c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/moveBlocks.js\":\"8a4a19b0e8361957\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/selectionAfterMove.js\":\"d08c217b1ca48dab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/TutorialBanner.js\":\"f25f5da5a93cb678\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/action.js\":\"ef8112aaecf4cc87\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/bannerDismissal.js\":\"7a097a41e2b9327d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/documents/cheatSheet.js\":\"ce7c33c0a7101ac2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/index.js\":\"c1cf2ba878f40bcc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/keys.js\":\"95114be71e7d5fd1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/landing.js\":\"89118c57a6e63a67\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/outline.js\":\"c2a17feb6eb2d7bf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/seed.js\":\"76a5b82b516d0e31\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/PerfTrendDialog.js\":\"10c46858b0ddb8a9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/analyze.js\":\"d11fcd60eb07e04d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/diagnosticsSource.js\":\"725bbab3fd34be44\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/index.js\":\"e9acc4320e2b5bc1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/load.js\":\"cd5f835aa2f29e7a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/monitorRun.js\":\"13e6fe332ed1ad5e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/schedule.js\":\"a26fc9db54813320\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/series.js\":\"d9cd6156c81d6aeb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/store.js\":\"357d285740fdff5b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/trendAction.js\":\"2996c8ab5cd8fab6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/verdict.js\":\"ba1aeafefc322843\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/clickToEditAction.js\":\"dfcf920ffa9782f2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/index.js\":\"3cec6b4c8d5bc372\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/interactions.js\":\"58faf7aa625961b2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"0241f338840a2cc6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/MigrationGate.js\":\"436a905a30ba9ec7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/MigrationGateDialog.js\":\"756e62ae486cd5e2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/action.js\":\"9f160d2dbaadce26\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/index.js\":\"a35b8bbeb6fc3a3e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/localRunMessage.js\":\"b50a0ca6bb617a08\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/plugin.js\":\"4ce3b831b8529779\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/progressReport.js\":\"7e2818916933b9af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/sweepProgress.js\":\"21305b2b769271d2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/FieldRowRenderer.js\":\"87a0ee340f413400\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/ValueRowRenderer.js\":\"723f35793e32b7e7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/actions.js\":\"f2cb61be92d19e5b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/autocomplete.js\":\"dc6d8163f0d10c9c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/fieldRow.js\":\"405f01135d455b46\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/index.js\":\"c072c18eb9373dcb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/referenceWarning.js\":\"de781900905ee093\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/valueAutocomplete.js\":\"9adecb897ef6515d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/valueSchema.js\":\"c50b6ea3bf690d01\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/HeaderItem.js\":\"b46bb7c535d1114c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/QuickFind.js\":\"3faf185598453e1d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/index.js\":\"643a0fac7fa9be35\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/recents.js\":\"7fc9bbeb915132ae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/resultItems.js\":\"bf53530a29836710\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/selection.js\":\"7a0de81424173d32\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/toggleStore.js\":\"b629acdb531754b3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/HeaderItem.js\":\"59ea746e98abe54c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/RecentsPageBlockRenderer.js\":\"43d6ea6214b620eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/grouping.js\":\"6508eb38becaf1fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/index.js\":\"88617e98c18bdbc7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/target.js\":\"746d706f080a4bbc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/codeMirrorExtensions.js\":\"7b1ec2b061a7e235\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/contentPrefill.js\":\"ed313060e2dc1641\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/dataExtension.js\":\"f3c14d7b1554c2b9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/index.js\":\"a11bf4ebd5596517\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"8bbc988650fab255\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/invalidation.js\":\"a85493cb32adfc5c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/localSchema.js\":\"4e03d7289375efb7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/blockrefs/index.js\":\"acdfab262cd40b48\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"f5fa8ad9468d1ffd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/index.js\":\"b9c0d93a3dd7d90f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/referenceNode.js\":\"77387196fe128696\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/remark-reference-occurrences.js\":\"6b8fb9d1c21db89a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"465edd98562267e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/index.js\":\"752d1aaf626bff92\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"04b593496862d5f6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7a8acf623fb8b2cf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/mergeRetargetProcessor.js\":\"eb6a840c73c8d089\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/parseFence.js\":\"463689437d7209c1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referenceParser.js\":\"da09e723e7ac849e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referenceProjection.js\":\"c4c34c644c456779\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referencesProcessor.js\":\"18dc7467d64e1263\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/renameProcessor.js\":\"47d90d346c9c0b62\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/spanReplacement.js\":\"ff01453212160175\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/htmlToOutline.js\":\"d69c3d95e8bf2bc9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/index.js\":\"b814454db59abf3f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/normalizeClipboardDom.js\":\"601dec41c8793838\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/pasteDecision.js\":\"63c7bed8fa4fd758\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/action.js\":\"c21eeeab60c98815\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/blockIds.js\":\"a252317af34c61c9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/content.js\":\"b12dc2ce333e9d4a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/effect.js\":\"489bbd4bba094938\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/ids.js\":\"b761f7cd2e58befd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/import.js\":\"ff5527b3b952fe87\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/index.js\":\"b6c2b7afff846050\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/plan.js\":\"e5929cdb4f0fa0d6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/plugin.js\":\"444da2fb339e2a68\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/promotion.js\":\"29bacf1bda724d6a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/properties.js\":\"58852f1dba96bb12\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/references.js\":\"00b60e5e100b4498\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/report.js\":\"031b20d974bee3af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/roamMemo.js\":\"6eb93ef299d2b818\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/runtime.js\":\"1a2bb26e8d996956\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/schemaReconciliation.js\":\"0c31ff6d9ff88486\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/srsMarkers.js\":\"85c1243e9cdd518d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/todo.js\":\"116f0ab612ea7405\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/typeCandidates.js\":\"34d5d70e58f06eb1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/types.js\":\"acfdf08213844e62\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/search-health/index.js\":\"41280ebbbb71a8cd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/search-health/store.js\":\"0bb30f650eba00e2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/HeaderItem.js\":\"ecaa605dea8a61f6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6e187b870eb55a00\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/index.js\":\"6c3b498a3ffecd53\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/model.js\":\"7b51c57521412a76\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/toggleStore.js\":\"18cc0a295f0e7372\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/useKeyInspector.js\":\"979c8483648a253f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"4fff421866ac6813\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/ShellDecorator.js\":\"4f6cac5ea63c2211\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/actions.js\":\"396625b265ef2201\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/exclusionsFacet.js\":\"805f88b35bb70f39\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/index.js\":\"a2dbde69c590b5aa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/shell.js\":\"75a4fb0efa7e793e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/surface.js\":\"c6a3954fc531a130\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/walker.js\":\"1a1e5bdb519314fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/RescheduleToast.js\":\"33680a1c8fd55d12\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/dataExtension.js\":\"fc7a7a9aa8ea24b2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/index.js\":\"9dae382618eb31f7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/indicator.js\":\"6619e9c24d1abdca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/moveSrsState.js\":\"12c63ce8781a5d55\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9006a88fa00b6d9a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/scheduler.js\":\"bc112f1663085d1d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/schema.js\":\"3a6d20f33e45452d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"38092596684936c2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/srsClipboard.js\":\"5a9fa991bcbcb6f5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"961a0f13fa336d37\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/DailyNoteReviewHint.js\":\"2fbe836bda96faa9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/DeckPicker.js\":\"3c49a46a3f88a81b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewControls.js\":\"4cb033bf82ec91f2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2a2da65ebfeb62c7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewSession.js\":\"2981126c2c1c8f94\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/actions.js\":\"34d8493d9eda655b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/archive.js\":\"e618ecb13478be87\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/dataExtension.js\":\"8e604c8a8edd0d84\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/deck.js\":\"0c98919c6432d38b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/dueQuery.js\":\"594ee29cbd52b4b8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/gradeDecision.js\":\"3bb969181ec0cc72\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/index.js\":\"88b843efec826392\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/keyHints.js\":\"a2795fbf80d894e0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/reviewCardLayout.js\":\"97d4d56a19fdd72e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/reviewProgress.js\":\"30de523233b46a0b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/schema.js\":\"cbb5b8a99ff2ce18\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/useDueCards.js\":\"87cea4600077e117\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/startup-metrics/index.js\":\"088b42d1e015f93d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/startup-metrics/record.js\":\"133e8054f6cb132c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/index.js\":\"b8cf05aaa67e0ec1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/persistenceStatus.js\":\"8793651a967267e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/requestAction.js\":\"1571adf941c40d95\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/TypeChipsDecorator.js\":\"d7101ba851fa6abf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/codeMirrorExtensions.js\":\"ef4098e85b2cea86\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/index.js\":\"54a528f263d8f88a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/typeAutocomplete.js\":\"f18127a16e6e5285\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"6d4166dbec00e561\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/actions.js\":\"9697389f36528d05\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/anchor.js\":\"80ba152b8a7c7222\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/events.js\":\"81edfb3fef8a06a4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/gestureActions.js\":\"03dfdd3576a35050\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/index.js\":\"a4e13e5e1a5e2501\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"24c5f137391b6a9a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/collect.js\":\"8dc164f7b392baaa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/index.js\":\"0011accc9ce8367a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/record.js\":\"bf27c0e601db7523\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/RejectionDialog.js\":\"d9a1d9d79ad5f194\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/SystemStatusHeaderItem.js\":\"64b51444d2191faa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/index.js\":\"aa957b750f85dcfe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/model.js\":\"d1f484273d77020d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/queueCounts.js\":\"395e4270960ad5a9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/rejectedHelpers.js\":\"c67c805ebe30ad53\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/rematerializeAction.js\":\"c95707779906019f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/useHysteresis.js\":\"8c5003858a501447\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/ColumnHeaders.js\":\"d2cd039c75d73bae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/QueryUi.js\":\"b78ebf1d1aae51ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/TableLayout.js\":\"57ca368bae8b0829\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/actions.js\":\"8535e39f943e539f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/cellEdits.js\":\"48744f867374d785\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/childrenViews.js\":\"14dbbc5b1ee86891\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/columns.js\":\"42273e7ecc8d2142\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/controller.js\":\"a7437fb8492a4583\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/convert.js\":\"7384f13b17002f4e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/dataExtension.js\":\"9f0b9791c5b99fb7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/index.js\":\"e3bbf68c50363527\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/keys.js\":\"8057553d9bd9082e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/model.js\":\"f4e148d0f6a6a97e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/QueryText.js\":\"42c6ed66ef03dd8e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/backfill.js\":\"e34ad3e6ae0d0e7e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/completion.js\":\"db739a68cd395d85\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/format.js\":\"c2c754d8b3401fa2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/parse.js\":\"3162c701542d60af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/queryValue.js\":\"d0cc41ac83c7234a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/registrations.js\":\"df1036149a5f8919\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/source.js\":\"31076edf1d2c4c4d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/registry.js\":\"11c3ef086a4d1183\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/rowGutter.js\":\"967b17878affa70e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/rowVerbs.js\":\"22eb78b7d3c1d3a1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/schema.js\":\"c2f6c0a3f4a45208\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/sort.js\":\"9774a026583e373a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/effect.js\":\"cdf0dae759ee8951\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/index.js\":\"df8ab26c62454575\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/theme.js\":\"3c16141713af7474\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/actions.js\":\"9284d46ea7fdc155\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/dataExtension.js\":\"e08b82ace1427d26\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/index.js\":\"a9a95d227225eed0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/schema.js\":\"09462c0f95adf88b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/TouchSelectionLayer.js\":\"80d3df83b32561f0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/actions.js\":\"91ce41128bdfa21e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/defaultItems.js\":\"e54877e4852354e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/facet.js\":\"bfb0f7480fd5b4a9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/holdRecognizer.js\":\"511e60a8aaa65173\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/index.js\":\"994df7b867910dd1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/UpdateIndicator.js\":\"8eedd3d8732f283f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/index.js\":\"bdac418233197362\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/loadTimes.js\":\"8ce70da7999a435f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoNotesRenderer.js\":\"7b18f0a038c2b6b3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoPlayerRenderer.js\":\"b6794f346988695f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoTimeStamp.js\":\"11ea37f91f14e4a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/actions.js\":\"7c0ed5858e28ea60\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/index.js\":\"870d3fe77460afc1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/markdown.js\":\"acbbbaf4c5111268\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/notes.js\":\"13f817a5ff253f54\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/registry.js\":\"d8b777091f919406\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/remark-timestamps.js\":\"c5f78a992b5d9c70\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/view.js\":\"9ee5821a22f12986\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/LinkHints.js\":\"d70dfb2d94a218d7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/index.js\":\"963bc4e6fe845e3e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/model.js\":\"06fee435e2cef3f4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/settings.js\":\"f18e0d291932aa24\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/actions.js\":\"ddee5319d3e7da42\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/index.js\":\"084ea5ddb855f057\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/interactions.js\":\"7fe955ae8866a03c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/workspace-header/index.js\":\"b3c2ba83cd74006e\",\"/knowledge-medium/pr-preview/pr-1904/src/registerServiceWorker.js\":\"bd2eebe540e700b3\",\"/knowledge-medium/pr-preview/pr-1904/src/requestPersistentStorage.js\":\"f5e1f9d4c1704e33\",\"/knowledge-medium/pr-preview/pr-1904/src/services/authRequestDeadline.js\":\"2f91b9992c879758\",\"/knowledge-medium/pr-preview/pr-1904/src/services/authStorage.js\":\"e0b444da1c4b8858\",\"/knowledge-medium/pr-preview/pr-1904/src/services/powersync.js\":\"0f59759499cacd09\",\"/knowledge-medium/pr-preview/pr-1904/src/services/supabase.js\":\"105479da0f9bbd0f\",\"/knowledge-medium/pr-preview/pr-1904/src/services/uploadErrorClassifier.js\":\"9f6bebc91d43aa44\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/ActiveContexts.js\":\"23ca413392f32a5f\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/HotkeyReconciler.js\":\"99452bcc4e7cb897\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/WipeLocalDataDialog.js\":\"4ec0c2ab6e72ef42\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/actionDispatch.js\":\"d8ba6a1dee8d266d\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/actionRefItems.js\":\"1f007ff1482656ce\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/applyKeybindingOverrides.js\":\"10f2ae5f9a46b1de\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/blockActions.js\":\"73ddf75c33768671\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/blockMergeGesture.js\":\"0069a95fd4791e73\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/canonicalizeChord.js\":\"e7fba6c81e523439\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/defaultContexts.js\":\"77c3e6f981a970c5\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/defaultShortcuts.js\":\"d42c82a5168592e4\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/effectiveActions.js\":\"fa792b3480a1b460\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/gestureAction.js\":\"7c3566c5a41d2a4e\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/gestureBinding.js\":\"e0ef336bcf1c634c\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/holdRegistry.js\":\"8aab3ee99663d4f7\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/keybindingConflicts.js\":\"29e2cccbf007e28f\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/keybindingOverrides.js\":\"82fe838c3914d51d\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/pointerAction.js\":\"10e152da6133d03c\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/resolve.js\":\"de0c994552e54069\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/runAction.js\":\"8ba5b96de39df1e3\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/sequenceMatcher.js\":\"bba9acc5b763386a\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/types.js\":\"df3aa0f8a8c4a265\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/useActionContext.js\":\"9f5976c538295f53\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/useActionDiscovery.js\":\"69afc4bdbcebfd62\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/utils.js\":\"560b889da929595f\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/bootStore.js\":\"a302317f391e381e\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/previewDatabases.js\":\"c3fc9eee98ac6599\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/byteTransform.js\":\"a4fb64973789e951\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/attachmentCleaner.js\":\"d19870325623bf1d\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/attachmentParts.js\":\"311221f01faf5a36\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/bundleParts.js\":\"8a5898ef2c3b903e\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/bundleRecord.js\":\"fc012b6e9091f3f6\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/manifest.js\":\"27b73d4f25d0629f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/takeBundle.js\":\"993767305e15dbfb\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/verifyBundle.js\":\"98ee873ae08e5fe5\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/cleaningStage.js\":\"b6f7a4b7381b2065\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionKey.js\":\"0b5300e2f8dc16b6\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionServer.js\":\"cc251cd8003bbfc6\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/flip.js\":\"2c6aad895a26764b\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/flipAttempts.js\":\"88d29f1716ea8a57\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/pages.js\":\"25371c118c073e88\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/preflight.js\":\"f76f9ffe7ba0d5a6\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/reseal.js\":\"cfd05c4c456b3174\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/runConversion.js\":\"87e056f4acb8971f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/runLock.js\":\"78f69f338c8c4c76\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/sealing.js\":\"9be574b416ece132\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/sealingStage.js\":\"5f6530ce2ff89bb7\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/stage.js\":\"cc3696dab3e654ec\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/verifyReseal.js\":\"e196ebb116d5c119\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/aad.js\":\"9b2c79763e6e1eab\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/aead.js\":\"3a2270b58b807e38\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/base32.js\":\"d8b539ba279cbb41\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/base64url.js\":\"aa75a2cce1d1d776\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/binaryEnvelope.js\":\"2ce8b7e3beab499f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/byteAead.js\":\"e22993bfafca750e\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/canary.js\":\"55e49d3f22dc6f66\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/contentHash.js\":\"89f6c66359bf225a\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/contentKey.js\":\"c8421a7618e9e8ed\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/derivedIdNamespace.js\":\"46e5feb2adf507f1\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/envelope.js\":\"967610b1979daf06\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/hex.js\":\"32c2cd4675879546\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/sha256Hex.js\":\"5f8463382895a105\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/workspaceKey.js\":\"f238e6448041dd89\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/conversionState.js\":\"b36d6a41700862ba\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/createEncryptedWorkspace.js\":\"460164669073e6f2\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/pastedKey.js\":\"c731f7a647683696\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"cf6aad1c6bd14323\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ad0173ae22092c57\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/keyStore.js\":\"635480f15cd78211\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/mintWorkspaceKey.js\":\"a50ae056f247b4b2\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/modePin.js\":\"c32f1b9f173a9afe\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/openWorkspaceKeys.js\":\"43785b9e5d3361d3\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/resolveWorkspaceEntry.js\":\"d0c1f78cc0ee2d1d\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/resolver.js\":\"03a6fee58d6ef1cc\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/workspaceAccess.js\":\"823de5ac5445738d\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/transform.js\":\"d3df0f37108a8ce1\",\"/knowledge-medium/pr-preview/pr-1904/src/themeBootDefaults.js\":\"ccf34e1da718dbc4\",\"/knowledge-medium/pr-preview/pr-1904/src/types.js\":\"23fe852433cec015\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/ClientLocalSettings.js\":\"16d7b3c0d875e4ea\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/abortableSleep.js\":\"e8f37db5569efc95\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/array.js\":\"874a3898b3b9dd92\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/backlinkAutocomplete.js\":\"f619488c1799cd28\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/blockCrumbs.js\":\"04e5b3ada5b1a88f\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/blockrefAutocomplete.js\":\"1e24c79838056495\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/cadencedIdleJob.js\":\"0e3d027520fef109\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/callbackSet.js\":\"7c77daaeb88c4134\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/clientId.js\":\"6b4a07da84db20c2\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/codemirror.js\":\"592ce784e3d94b25\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/codemirrorCompletion.js\":\"83320d3519caad78\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/copy.js\":\"4cd0581d40239fc8\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dailyPage.js\":\"2877fc53672e8dc2\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dbForensics.js\":\"5cab87644221f6e6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dbForensicsHooks.js\":\"b3d60a8c541e73a9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/deleteBlockThroughUi.js\":\"f30a323a00d290f5\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dialogs.js\":\"5fcf86088d46e92c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dom.js\":\"37326ede0ea40fca\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/downloadBlob.js\":\"ac3a52b15da6ac47\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/drawnWalk.js\":\"01bfba3484f4c309\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/exportSqliteDb.js\":\"fb59098f7b050f69\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fileSystemAccess.js\":\"30beb59cf7f66b43\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/flipSlide.js\":\"13cad1977d820506\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fnv1a.js\":\"6d05ab969e5f8aed\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/formatBytes.js\":\"ce3e5079d3961849\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fuzzyRank.js\":\"4428000307de0996\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/idbKeyedStore.js\":\"dc1ae7a8bfe2a6cb\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/idleCallbackPolyfill.js\":\"bbb6df904d3e1203\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/keyboardAwareScroll.js\":\"f7bb8c857d7bc18a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/keyboardViewport.js\":\"5e4ca316c7ef940c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/lastWorkspace.js\":\"c69f8a1aad5c6fea\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutColumns.js\":\"60fd7528efa70511\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutSessionDom.js\":\"e0f83fa889440aa0\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutSessionId.js\":\"8ab6538b9e744a98\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/linkClickGestures.js\":\"5a960c6435a5f624\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/linkTargetAutocomplete.js\":\"757464d5f4b2dde4\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/localDbCorruption.js\":\"ecf2d22fd83fa238\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/localDbRecovery.js\":\"9f73f29821b96324\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/markdownParser.js\":\"6992ddb25ee3f22a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/memoize.js\":\"2b406d4787a97644\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/nameFieldCommit.js\":\"be9c11ba3ed54d27\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/nameList.js\":\"546c9c77f306fd6f\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/navigation.js\":\"24540f307c935ad9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/omnilinerNamespace.js\":\"c46f15ad43cdda89\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/opfsPageScan.js\":\"feadffce66be8a83\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelClearance.js\":\"429035a508787cff\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelHistory.js\":\"11241b3f5535e0ad\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelLanes.js\":\"42d0135f8212251d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelLayoutProjection.js\":\"78fc48ca540543ab\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelScrollAnchor.js\":\"658a405af6b98810\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelUrlFlags.js\":\"545667e50151c19c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/platform.js\":\"742933ed798fda8b\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/pluralize.js\":\"8e6e2fd11aaca30a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyCreation.js\":\"fce5d676afb4b4eb\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyNavigation.js\":\"8242028ca46bca4f\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyValueContext.js\":\"7a0663fd2802bf2c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/react.js\":\"d227e0ed96a63f46\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/relativeDate.js\":\"cce7c0e8c87ce0e4\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/relativeTime.js\":\"55370ee95f92c296\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/renderScope.js\":\"90fe190594e3c868\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/resolvedThenable.js\":\"580a3fc52503f102\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/routing.js\":\"d09d10f33f691cb0\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/safeMode.js\":\"4effc0429f2aa0e1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/scheduleIdle.js\":\"de6fd5ed73fda8b0\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/screenWakeLock.js\":\"2160c6fe067e71b5\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/selection.js\":\"ee775f1cc514dd04\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/softKeyboardGrab.js\":\"697218377faf024c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/startupTimeline.js\":\"ed0d21bc3ac0534d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/state.js\":\"1bbb15a785b0c7f8\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/string.js\":\"5101fa81ad053171\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/surfaceZoom.js\":\"30dfbf7d305dbe27\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/time.js\":\"4e84bf6424203a1c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/toast.js\":\"18dfcc9eba99d023\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/toggleStore.js\":\"879a974fb07a5ff3\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/untilStopped.js\":\"0fd36cfc7d01036e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/userActivity.js\":\"d1a2e59d0121b74a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/viewTransition.js\":\"81fb70584d3f2ade\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/viewport.js\":\"d6d24011e64688bc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/webLock.js\":\"b855cd5926675330\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/workspaceRecovery.js\":\"1a7cdcc0491dd157\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/workspaceSnapshotStore.js\":\"585d0dd28980e8c2\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-compiler-runtime.js\":\"118c30b1146da48b\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-client.js\":\"090c1f3fe1014feb\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-server-edge.js\":\"aa9a2d8284d3394d\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-server.js\":\"2dba84b936ec76a5\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-static-edge.js\":\"446ecb168db06549\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-static.js\":\"bf3d8c722622a288\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-test-utils.js\":\"778826f06ec125c5\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom.js\":\"6baaeff02ca9f1fc\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-jsx-runtime.js\":\"591caed549ce273f\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react.js\":\"0478bbfd26ed21a1\",\"/knowledge-medium/pr-preview/pr-1904/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1904/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1904/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
