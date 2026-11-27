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
		buildId: "3dd982717c04-5f87fae7",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/\":\"5ba540c8a59c90f3\",\"/knowledge-medium/pr-preview/pr-1904/index.html\":\"5ba540c8a59c90f3\",\"/knowledge-medium/pr-preview/pr-1904/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1904/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1904/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1904/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1904/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1904/assets/FacadeVFS-BRQpqnC7.js\":\"891ebefe2dd6f73a\",\"/knowledge-medium/pr-preview/pr-1904/assets/OPFSCoopSyncVFS-DMyQDWdY.js\":\"86e4b1b2b1685b21\",\"/knowledge-medium/pr-preview/pr-1904/assets/OPFSWriteAheadVFS-k-M70Pwl.js\":\"eb585f25ac433d89\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-C0HcraJs.js\":\"86aa477d7fa26ed0\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1904/assets/wa-sqlite-async-Fz6hWTwQ.js\":\"b9eb189c33a992bf\",\"/knowledge-medium/pr-preview/pr-1904/assets/worker--hK6-iBI.js\":\"a8493596f780837a\",\"/knowledge-medium/pr-preview/pr-1904/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1904/chunks/app-CqY1NI6_.js\":\"5e02c91473c0825b\",\"/knowledge-medium/pr-preview/pr-1904/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1904/index.js\":\"fcf024decbfd7f0d\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1904/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1904/assets/AccessHandlePoolVFS-BrTCvkYR.js\":\"691b9b6e34e4c6fb\",\"/knowledge-medium/pr-preview/pr-1904/assets/IDBBatchAtomicVFS-xu9p-z6c.js\":\"0bb34832b79a4ba2\",\"/knowledge-medium/pr-preview/pr-1904/assets/MemoryVFS-ClNzB9Vo.js\":\"6ca89a2ce16db9ec\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-B1ZvrQ6z.js\":\"d2e9ceb833f79291\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1904/assets/mc-wa-sqlite-async-pk0cuaze.js\":\"9c6c8a2e595ff098\",\"/knowledge-medium/pr-preview/pr-1904/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1904/chunks/AccessHandlePoolVFS-C-YzluyY.js\":\"5c4ff5a1efa6ce37\",\"/knowledge-medium/pr-preview/pr-1904/chunks/FacadeVFS-BF_p0Mlf.js\":\"eca07ba9e265cf36\",\"/knowledge-medium/pr-preview/pr-1904/chunks/IDBBatchAtomicVFS-BDy0NsLQ.js\":\"7b636afe1a2d85c2\",\"/knowledge-medium/pr-preview/pr-1904/chunks/MemoryVFS-CPpClVRu.js\":\"55931057b922e95d\",\"/knowledge-medium/pr-preview/pr-1904/chunks/OPFSCoopSyncVFS-Cz7ntxCa.js\":\"23c4283c52d2f753\",\"/knowledge-medium/pr-preview/pr-1904/chunks/OPFSWriteAheadVFS-DnzA7NEd.js\":\"33304c96e467dfa8\",\"/knowledge-medium/pr-preview/pr-1904/chunks/Preview-CfBj_fyR.js\":\"2ce14449cd03b959\",\"/knowledge-medium/pr-preview/pr-1904/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1904/chunks/card-DpjtvhT_.js\":\"518c7e19531206c2\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1904/chunks/dist-CHq_2D2t.js\":\"4c424ad514bd8704\",\"/knowledge-medium/pr-preview/pr-1904/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1904/chunks/mc-wa-sqlite-CHQXI_ug.js\":\"3cebfac3cd38c1f1\",\"/knowledge-medium/pr-preview/pr-1904/chunks/mc-wa-sqlite-async-DGCIhIJG.js\":\"b63aa4ddce172a8f\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-5OGUbVzS.js\":\"2b5f0c5288fb6da8\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-BLpQVFsQ.js\":\"a2e3964873421043\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-BQS9ik5n.js\":\"67722c2dbd87984f\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-BipEr92X.js\":\"ca684c89afe1eb66\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-DnySK09h.js\":\"a1357851a3d66d01\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-O9g4DdvD.js\":\"13099dec3ecd8ef6\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-b5mfmxs-.js\":\"899e569b161acf43\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server-legacy.browser.production-BTdPmSDo.js\":\"e928b08d7d5c2802\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server.browser.production-bKj7n9z3.js\":\"906367b34e1c5d70\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-dom-server.edge.production-B5KnQub7.js\":\"a6f9ceb8ad1ef111\",\"/knowledge-medium/pr-preview/pr-1904/chunks/react-tGh2qzKB.js\":\"e2a3a9d505f33057\",\"/knowledge-medium/pr-preview/pr-1904/chunks/server.browser-CJHqHxi2.js\":\"5b64ab345a52315a\",\"/knowledge-medium/pr-preview/pr-1904/chunks/textarea-DX6JkjM2.js\":\"7d06be61a2c0b87c\",\"/knowledge-medium/pr-preview/pr-1904/chunks/ui-B5sMwe0d.js\":\"2f105e4723cb3bce\",\"/knowledge-medium/pr-preview/pr-1904/chunks/wa-sqlite-D7BuUaaA.js\":\"cf882e46564c3495\",\"/knowledge-medium/pr-preview/pr-1904/chunks/wa-sqlite-async-D9DWlblA.js\":\"716c106f748a0b7a\",\"/knowledge-medium/pr-preview/pr-1904/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1904/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1904/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1904/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1904/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1904/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1904/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1904/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1904/src/App.js\":\"97810ad502c601c9\",\"/knowledge-medium/pr-preview/pr-1904/src/appUpdate.js\":\"b8996bfd7d49bb87\",\"/knowledge-medium/pr-preview/pr-1904/src/appVersion.js\":\"13e9a9b10ec5e2c5\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/initialLayout.js\":\"165acce7f5618a77\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/openWorkspaceData.js\":\"606b0e41cda8e983\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/resolveWorkspace.js\":\"3da83dea8ab9cd82\",\"/knowledge-medium/pr-preview/pr-1904/src/bootstrap/workspaceBootstrap.js\":\"2cc2c1c6557771b9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockComponent.js\":\"ffa07ca89bb8b689\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockCrumbs.js\":\"f0a2de38f3d3e3bb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockEditor.js\":\"4a0a4eb993263815\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockLoadingPlaceholder.js\":\"7ea60a3ff9844be8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockProperties.js\":\"ed856699bb42dfcd\",\"/knowledge-medium/pr-preview/pr-1904/src/components/BlockSearchPicker.js\":\"b6d852a7bbf9fca4\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ConfirmBulkDeleteDialog.js\":\"9d60edba96f22452\",\"/knowledge-medium/pr-preview/pr-1904/src/components/DividerHandle.js\":\"f5f03bf0e0e771aa\",\"/knowledge-medium/pr-preview/pr-1904/src/components/DraftEditor.js\":\"5bd50127d9b6604d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/GutterPill.js\":\"5eefea01ee0214d3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/Header.js\":\"59eec5c0ba079833\",\"/knowledge-medium/pr-preview/pr-1904/src/components/LazyBlockComponent.js\":\"bf1df889a2147401\",\"/knowledge-medium/pr-preview/pr-1904/src/components/Login.js\":\"3e4334daacdd92bb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ZoomableSurface.js\":\"ff0b7258eb447c2c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/editModeKeepalive.js\":\"80c57845eb908c1a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c40c03f8de8c3e0c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8736c7d638b4c1fd\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/RefPropertyEditor.js\":\"d8d5336335abeda5\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/RefTargetTypePicker.js\":\"8947501ed69a8744\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/SelectPropertyEditor.js\":\"d92be9fbf5740b48\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/TypesPropertyEditor.js\":\"7162bc6560a8e4d0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/defaults.js\":\"53eeba5b8293a1f8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/kernelValuePresets.js\":\"6fe5230a33d5c6ca\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/selectablePresets.js\":\"84d9c2f89715b884\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyEditors/typesPropertyUi.js\":\"4c496f15485f1b02\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/AddPropertyForm.js\":\"28da088a2675fd87\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/PropertyPicker.js\":\"de7e4c5bff4bfb85\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/PropertyRow.js\":\"764038835247f507\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/Rows.js\":\"82c3a131cfa37e6a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/actions.js\":\"80d4091ed6683b5f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/declarationOnly.js\":\"7f5dca8dc1d03489\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/layout.js\":\"85405af147ef669a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/model.js\":\"36a5dabcdbc8d13c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/shapeUi.js\":\"6993c979996e010f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/shapes.js\":\"3f600ee4b18b1deb\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/usePropertyEditingActivation.js\":\"336f83506f0d5fba\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanel/visibility.js\":\"8c995233b73d4d87\",\"/knowledge-medium/pr-preview/pr-1904/src/components/propertyPanelSections.js\":\"0540b3bda338333c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockEmbed.js\":\"9228e5e234f9db95\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockLink.js\":\"b23463d4578eb63b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/BlockRef.js\":\"7a2e47014d9ebec7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/CompactReferenceLink.js\":\"5d8bfd5024f20b9c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/ReferenceLink.js\":\"3970d2c2cd007bd0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/cycleGuard.js\":\"b3aed80c6a6fe803\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/cycleGuardContext.js\":\"7ea7435038e04672\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/linkInteraction.js\":\"e2e3a30e8f518471\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/referenceLayout.js\":\"c57fa0617553a79f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/references/useBlockRefAncestors.js\":\"a95de462f60890c7\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockGutter.js\":\"34b255e8c166906c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockInfoDialog.js\":\"6af7f93c8dde4a1a\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockReadText.js\":\"7c22339ed802d519\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BlockTypeBlockRenderer.js\":\"e0a8bf6f72af88e6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/BulletHoverCard.js\":\"fda8c2b8a834a264\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/CodeMirrorContentRenderer.js\":\"ad0358172992a3e9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f334113fcc3d420b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/ColumnResizeHandles.js\":\"0e0f96f3ac422d24\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a7f01eef57f1436c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/DefaultBlockRenderer.js\":\"2829da100e862096\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/LayoutRenderer.js\":\"f173e4080527ff94\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/MarkdownContentRenderer.js\":\"1ffe175fb4b2a836\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/MissingDataRenderer.js\":\"9f91404071e9d1b8\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/PanelRenderer.js\":\"64bf77d24e59b099\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/PropertySchemaBlockRenderer.js\":\"2fa3a4dac1247451\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/TopLevelRenderer.js\":\"135ec7fc9c5ba1b3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/blockGutterMode.js\":\"d806e7c0a3b03e08\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/blockTitleText.js\":\"c6b8a59bdef6f665\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/fieldCreationKeydown.js\":\"70ec29907b11cb51\",\"/knowledge-medium/pr-preview/pr-1904/src/components/renderer/layoutRootContext.js\":\"3c539ae7877dc926\",\"/knowledge-medium/pr-preview/pr-1904/src/components/typeChip/TypeChip.js\":\"799795b434f6d788\",\"/knowledge-medium/pr-preview/pr-1904/src/components/typeChip/chipStyle.js\":\"3e50b0175b7fbe02\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/anchored-floating.js\":\"baba158129cee0c3\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/button.js\":\"b644f2a252170a8c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/card.js\":\"4031c9c6be0f4395\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/checkbox.js\":\"32fe6c1dac543536\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/collapsible.js\":\"0b77912109fbb82f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/command.js\":\"2a30f1598c1c1535\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/context-menu.js\":\"50d337951f89efd4\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/dialog.js\":\"baf22202fbdd72b1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/dropdown-menu.js\":\"3bb137ca40b4db0f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/floating-listbox.js\":\"0f436f18229a0c65\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/index.js\":\"50a4c75d4e862cc6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/input.js\":\"d225fb4e33810147\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/kbd.js\":\"0b3b78413f5bdec0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/label.js\":\"51f42500b88fda27\",\"/knowledge-medium/pr-preview/pr-1904/src/components/ui/textarea.js\":\"0413734638457e4d\",\"/knowledge-medium/pr-preview/pr-1904/src/components/useEditModeYieldKeepalive.js\":\"5170772b04260b28\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/BootFallback.js\":\"eb518f2a2bf0d097\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/FocusedRowLazyMount.js\":\"f4da5540d1ce7270\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/LazyViewportMount.js\":\"1b1135bd5d2de4b6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/LocalDbCorruptionFallback.js\":\"84d12a092abb78ae\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/error.js\":\"38ecf83bbc67117f\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/lazyMountRegistry.js\":\"19a9608fa5b5ffaa\",\"/knowledge-medium/pr-preview/pr-1904/src/components/util/suspense.js\":\"17417d82db4c3058\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/CreateWorkspaceDialog.js\":\"f804969fda224994\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/PendingInvitations.js\":\"a9e68f7a7ff92c9c\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/SyncProgress.js\":\"5b65adf4cf91d1a0\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/UnlockProgress.js\":\"2776d277102c4515\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceKeyGate.js\":\"4848cc970a199f03\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSettingsDialog.js\":\"035d2e9cb8fbcff1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSwitcher.js\":\"a0403d9cd1fc2766\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/WorkspaceSyncGate.js\":\"3c4968af6fa6bdcd\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/ConversionFlow.js\":\"fd7c7bbd704d5db9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/ConversionFlowHost.js\":\"af121c89b1eb1699\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/EncryptionSection.js\":\"fdf14f9c4de6fe96\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/attachmentPrompts.js\":\"811f65b933febded\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b6cca7192b9d4c77\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/conversionFlowDeps.js\":\"17a31f3576437504\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/conversionFlowStore.js\":\"b3771a2770f8c9a1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/flowUi.js\":\"2c0bfa718afa9b7b\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/conversion/useConversionRun.js\":\"4683d009bdbcc4e6\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/keyUi.js\":\"17022db29d9532b1\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/useCloseOnKeyLoss.js\":\"9474efc63e7f1ee9\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/useCloseOnServerE2ee.js\":\"89dbc32e39df6140\",\"/knowledge-medium/pr-preview/pr-1904/src/components/workspace/workspaceUnlocked.js\":\"bed97fd50869b41f\",\"/knowledge-medium/pr-preview/pr-1904/src/context/backgroundSubtree.js\":\"941f808a5e14c533\",\"/knowledge-medium/pr-preview/pr-1904/src/context/block.js\":\"059b396b9b04cda3\",\"/knowledge-medium/pr-preview/pr-1904/src/context/layoutWsContext.js\":\"b1f059ba1d9a53d0\",\"/knowledge-medium/pr-preview/pr-1904/src/context/propertyDisplay.js\":\"09fd97bc2fed99c1\",\"/knowledge-medium/pr-preview/pr-1904/src/context/repo.js\":\"b38ee3eae229917e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/aliasClaim.js\":\"2b39367f9c4188ed\",\"/knowledge-medium/pr-preview/pr-1904/src/data/aliasSeatNamespace.js\":\"12528c9569068156\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/blockData.js\":\"5ca3727f782d1917\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/blockType.js\":\"72dd236836c317e7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/changeScope.js\":\"dc01ee3d38dbeb06\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/codecs.js\":\"b8ab30bdc075a411\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/derivedData.js\":\"10f12bc7cbac406b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/errors.js\":\"639e5476a8c5f392\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/events.js\":\"9ee90f9ee04a2122\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/handle.js\":\"cb9f49c0c6448226\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/index.js\":\"ebcac16be01db6f3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/mutator.js\":\"85bb93300079d54e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/processor.js\":\"7bc09773c608a86e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/propertySchema.js\":\"abcd82cd2c4997f3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/query.js\":\"ff1f8fa7c2204e23\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/sameTxProcessor.js\":\"58ed383a5499cd7b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/schema.js\":\"cb9f49c0c6448226\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/tx.js\":\"cb9f49c0c6448226\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/typedBlockQuery.js\":\"5b1183d5cd54e06a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/user.js\":\"f2e6f7ff008a4b2f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/valuePresetCore.js\":\"a4a10ca97095d311\",\"/knowledge-medium/pr-preview/pr-1904/src/data/api/valuePresets.js\":\"01eb856d3e91a068\",\"/knowledge-medium/pr-preview/pr-1904/src/data/attachmentCleanerIOVerb.js\":\"d130bed9e093b63a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/block.js\":\"ace839e956603e81\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockCache.js\":\"b24453839abf9b6f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockId.js\":\"b900ccc39156494e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockLiveness.js\":\"75913d690c23c528\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockMerge.js\":\"39f68c20e72b1c6d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockSchema.js\":\"c3b7034d05a14a60\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockTypeLookup.js\":\"8a673ace93378919\",\"/knowledge-medium/pr-preview/pr-1904/src/data/blockTypes.js\":\"601f7ba370a61c10\",\"/knowledge-medium/pr-preview/pr-1904/src/data/childrenView.js\":\"b2c9297b5631162e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/clientContext.js\":\"9c61d985a84726ce\",\"/knowledge-medium/pr-preview/pr-1904/src/data/dbFileSiblings.js\":\"0ac0422595ef10ab\",\"/knowledge-medium/pr-preview/pr-1904/src/data/definitionSeeds.js\":\"c9db9ee075e212d3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/derivedIds.js\":\"b9383c1e7dda2715\",\"/knowledge-medium/pr-preview/pr-1904/src/data/drawnSubtree.js\":\"3f7ffc7c8d435607\",\"/knowledge-medium/pr-preview/pr-1904/src/data/facetBridge.js\":\"7713dbcbb4ea12d2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/facets.js\":\"aa61895304634f07\",\"/knowledge-medium/pr-preview/pr-1904/src/data/globalState.js\":\"d01aa1fce51bae1b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/aliasClaimRederiveProcessor.js\":\"82e0fd8806cd6a0e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/ancestorBatch.js\":\"947533bb8682e3cc\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/blockTypeTypeifyProcessor.js\":\"c416a6ad97966724\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/clientSchema.js\":\"b52f2d432f804b08\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/commitPipeline.js\":\"302f650d6b11cb2a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/devAssertions.js\":\"1fb04c8703e9d53d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/firstSync.js\":\"c41ad06a626d0320\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/freshInitialLoad.js\":\"25e50da300a4d9b8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/graphBackfillClaim.js\":\"ddfbd86fc4d2174b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/handleStore.js\":\"32cd4f53672a9b69\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/idleMarkerJobs.js\":\"48218206ac074ba1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/initialDownload.js\":\"c4b28f3d255396e7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/initializeClientDatabase.js\":\"1539c687d8996c9c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/jsonCanonical.js\":\"475ba2b4c6e6abb3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelInvalidation.js\":\"1faf0cbc01379d02\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelProcessors.js\":\"237f4209d496ec69\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/kernelQueries.js\":\"a53cf11acff88995\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/mergeTypeMembershipProcessor.js\":\"7fae275f93672395\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/normalizeReferencesProcessor.js\":\"be904129816e3ec8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/poolInstrumentation.js\":\"585cd24af7cb65e2\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/processorRunner.js\":\"ff11496046ea195f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyCellBackfill.js\":\"31734297864df01e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyChildMint.js\":\"b05fe748ff2f560b\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyChildrenProcessor.js\":\"978acf4d620e9fc9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9eb45ce0dd9020e4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyDefinitionSynthesis.js\":\"d771f36177f0e46a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyKeyScan.js\":\"b8768992622a7a08\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertySchemaResolution.js\":\"c0425f454a188c23\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/propertyValueEdits.js\":\"6977ff1899e6f9ea\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/raiseProtocol.js\":\"98c7f4a1e2bbcb0a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/readBatch.js\":\"bf2f2bbfcc3459f4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/refProjection.js\":\"dd4339bb8d45a200\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/referenceTargetLookups.js\":\"efd63a6deae5d900\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/referenceTargetProcessor.js\":\"234049ea89b2a905\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/replayMerge.js\":\"79a7000b6276e69e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/sqlBinds.js\":\"01b9a8dd9e34486c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"19a82a361bea7e18\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/arrivalProcessors.js\":\"481296e534f3db73\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/invalidate.js\":\"96aee1b20fb965de\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/materialize.js\":\"40164efe38bd0a51\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/observer.js\":\"ce9cb7dbb488ea38\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/syncObserver/reconcile.js\":\"f42ee0ef355ecd3d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/timingMetrics.js\":\"fa4ce81c49213cf0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/treeQueries.js\":\"3c964dde65045838\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/txEngine.js\":\"28d5818cca5483e8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/txSnapshots.js\":\"56072db58977e66e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/typedBlockQuery.js\":\"a4c29af627d315b4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/internals/undoManager.js\":\"e94f607d61b3439a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/invalidation.js\":\"927860996d81b41f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelDataExtension.js\":\"945e7ed7074e8f03\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelPage.js\":\"9680ffaf7bafe497\",\"/knowledge-medium/pr-preview/pr-1904/src/data/kernelValuePresetCores.js\":\"961372b41a435b50\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbCorruptionSignal.js\":\"fa835e2e5167ba79\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbStorage.js\":\"10911551763f137f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localDbVfs.js\":\"19ee7616dbdefcd1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/localSchema.js\":\"844624a5af849852\",\"/knowledge-medium/pr-preview/pr-1904/src/data/maintenance.js\":\"215edcff10488e7d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/mergeProperties.js\":\"3fa2492da40e9ec9\",\"/knowledge-medium/pr-preview/pr-1904/src/data/metricsConsoleHook.js\":\"3329435b112705ca\",\"/knowledge-medium/pr-preview/pr-1904/src/data/migrationsPage.js\":\"6251c62d8eab3bb8\",\"/knowledge-medium/pr-preview/pr-1904/src/data/mutators.js\":\"c0191be72989e987\",\"/knowledge-medium/pr-preview/pr-1904/src/data/orderKey.js\":\"7416422478973515\",\"/knowledge-medium/pr-preview/pr-1904/src/data/orderKeyPlacement.js\":\"7db3f13211b95d1e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/outlineSurface.js\":\"83498ccacc8a51a1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pendingEditorContent.js\":\"7ee983041494da1d\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pendingUploadsSql.js\":\"e28f74723ad9ca54\",\"/knowledge-medium/pr-preview/pr-1904/src/data/pluginStateExtensions.js\":\"0f666deef6b9aca7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/powerSyncLogger.js\":\"23acba943d50cb82\",\"/knowledge-medium/pr-preview/pr-1904/src/data/projectorRuntime.js\":\"cd556bc326ab3c69\",\"/knowledge-medium/pr-preview/pr-1904/src/data/properties.js\":\"f24376faf20c2696\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertiesPage.js\":\"89a96a52737af536\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyChildren.js\":\"3cec0f5c80f17ce3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionFanout.js\":\"6e717c656df979e4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionMetadata.js\":\"23a7b66be733a69e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDefinitionRegistry.js\":\"3730c50b5612d009\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyDisplayMode.js\":\"5bb7e81ac2afa36f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertyRowCreation.js\":\"d057f4e79cc5794e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertySchemaCreation.js\":\"98c3ab0dfd4e9124\",\"/knowledge-medium/pr-preview/pr-1904/src/data/propertySeeds.js\":\"6838b29be1e7dbd4\",\"/knowledge-medium/pr-preview/pr-1904/src/data/recentsPage.js\":\"9ae5e68fb3aa941c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/refTargetComparableProperty.js\":\"acc3b6d0304526eb\",\"/knowledge-medium/pr-preview/pr-1904/src/data/referenceBlock.js\":\"c581d3ad43ec5fb7\",\"/knowledge-medium/pr-preview/pr-1904/src/data/rejectedUploads.js\":\"9e58a4d7ab559303\",\"/knowledge-medium/pr-preview/pr-1904/src/data/releasePowerSyncConnection.js\":\"52b9268fbdebaab1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/repo.js\":\"546f650f5ed412c6\",\"/knowledge-medium/pr-preview/pr-1904/src/data/repoProvider.js\":\"6bb4b5af62e4d1ed\",\"/knowledge-medium/pr-preview/pr-1904/src/data/rowProperty.js\":\"6173c8de3c12ea60\",\"/knowledge-medium/pr-preview/pr-1904/src/data/searchFilter.js\":\"20b187e193460736\",\"/knowledge-medium/pr-preview/pr-1904/src/data/seedIdentityLedger.js\":\"bad95a2687d8ef9f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/stateBlocks.js\":\"b58dd5d3225177be\",\"/knowledge-medium/pr-preview/pr-1904/src/data/structuralEditPolicy.js\":\"825ed66f19409ef3\",\"/knowledge-medium/pr-preview/pr-1904/src/data/structuralInsert.js\":\"5f31c3a7de594305\",\"/knowledge-medium/pr-preview/pr-1904/src/data/subtreeDelete.js\":\"b97ed7a7d9534215\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncStreamLock.js\":\"b9e825b4b70e589e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncedTableSqlRecognizer.js\":\"e96895d0982f081f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/syncedTableWriteGuard.js\":\"8df71590a82043d1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/targets.js\":\"0104d6563faded27\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeColors.js\":\"a336b7560129fa98\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeDefinitionMetadata.js\":\"d1f275b0a8e22d84\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeDefinitionRegistry.js\":\"86065f7ac2c0d846\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeExtraction.js\":\"d60bd3665cdb2f8f\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeInitialValues.js\":\"6dc7bb1cb3f1f87e\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typePropertyGroups.js\":\"73ce5cb0e2e6e584\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeSeeds.js\":\"a7047d2a0c2e2178\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typeTagger.js\":\"18e785bfdbb1106c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typedRecords.js\":\"1ced23224decfd82\",\"/knowledge-medium/pr-preview/pr-1904/src/data/typesPage.js\":\"0db6418737bada7c\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userPrefs.js\":\"faf9868b48e8a418\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userSchemasService.js\":\"20ebff6b61b2b236\",\"/knowledge-medium/pr-preview/pr-1904/src/data/userTypesService.js\":\"956331368639a224\",\"/knowledge-medium/pr-preview/pr-1904/src/data/valuePresetRegistry.js\":\"09afaa46f55fb3e5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/visibleChildren.js\":\"ce002025cb302df1\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceConversion.js\":\"9c069157cb583505\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceFirstSync.js\":\"1e10cf5d316008d5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceIdNamespace.js\":\"93d114a0fa321a99\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaceSchema.js\":\"47abb56ba8e8846a\",\"/knowledge-medium/pr-preview/pr-1904/src/data/workspaces.js\":\"93ffd4d01b9f24f0\",\"/knowledge-medium/pr-preview/pr-1904/src/data/writeAheadLog.js\":\"987977d3f0a32ad5\",\"/knowledge-medium/pr-preview/pr-1904/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/BlockPasteShellDecorator.js\":\"3951d1bfcb4a21a1\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/atTrigger.js\":\"36ce26c0d6a222c5\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/autocomplete.js\":\"1c8d18b00dd969dd\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/codeMirrorExtensions.js\":\"49945e87fd0c9772\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/contentFlush.js\":\"ac7574fabbd8804e\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/defaultInteractions.js\":\"0148dbff9b98ec3e\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/editSettleSignal.js\":\"b0a0d6f7bcdee1a6\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/insertImage.js\":\"c49ca511fda789ff\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/referenceCompletionRange.js\":\"e1166612e5644d08\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/referenceTargetTypes.js\":\"ab3279fb90615d83\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/syntaxContext.js\":\"34bd6c1624924216\",\"/knowledge-medium/pr-preview/pr-1904/src/editor/triggerMatch.js\":\"632b183bf22b8878\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/AppRuntimeProvider.js\":\"75d03764d0537c16\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/BlockFocusShellDecorator.js\":\"61f7bcd7ae221357\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/ExtensionRenderBoundary.js\":\"522176a9687449a9\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/PanelContentRecovery.js\":\"acc3da160e4cefc6\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/apiCatalog.js\":\"8e12845337e28482\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/approveExtensionHere.js\":\"c2fc07ff2d501503\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/armedCutAppMount.js\":\"b56eae1f39347d61\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/batchableKeyedStore.js\":\"c1979e731eb10141\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/blockInteraction.js\":\"ff6e9112b03ef9a3\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/blockSelectionAction.js\":\"f48c0b7e225e74f5\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/compileExtensionModule.js\":\"c4ad2102ac612ab3\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/compiledModuleCache.js\":\"08ed3f19f38756b7\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/continuousGestures.js\":\"20ceffedae5bf5fe\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/core.js\":\"9ac3b6c3690f727e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/defaultRenderers.js\":\"366409c6cfe105d5\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/definitionFanoutAppMount.js\":\"53ca6b245638e1d8\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dialogAppMount.js\":\"f4a2892b436c78c8\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dynamicExtensionSeeds.js\":\"fb09e47deb9ebf79\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/dynamicExtensions.js\":\"aad26e8cc2c8a585\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/exampleExtensions.js\":\"d8db1f74d7b408f3\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionApprovalStatus.js\":\"a190bb032cf621d3\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLoadErrorToast.js\":\"46c40f0f8ff48b3b\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLoadErrors.js\":\"5e4d8f268d38d63f\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionLookup.js\":\"754f738cbc359bc0\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionToggles.js\":\"a506afb47c6fec2b\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/extensionUtilitiesCss.js\":\"80c636fd515dd178\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/kernelPageDeletionGuard.js\":\"5a17d0a21c05749d\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/liveRuntime.js\":\"1b421b4950d58354\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/openExtensionsSettings.js\":\"fe9f7f672f41f8ac\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/overridesCache.js\":\"683c50a92fd59525\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/pluginIds.js\":\"76a5e9aebf7a1efb\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/processorRejectionToast.js\":\"7e931a70ef0005c4\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/runtimeActions.js\":\"919ba3f7e97c91b3\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/runtimeContext.js\":\"f7d85ec60bc2412e\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/staticAppExtensions.js\":\"1d73f35c419415d2\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/staticDataExtensions.js\":\"3e0d1ba923e884e2\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/toastAppMount.js\":\"93e781d136606fd2\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/useOverrides.js\":\"48fcf0de9112a740\",\"/knowledge-medium/pr-preview/pr-1904/src/extensions/useShortcutSurfaceActivations.js\":\"2ef9521634db51ed\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/discoverToggleTree.js\":\"98af3abd720fe1b9\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/facet.js\":\"2babdeb1952f2758\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/resolveAppRuntime.js\":\"e99e49befd13d6bf\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/runtimeEvents.js\":\"d33fd383aea9f808\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/togglable.js\":\"a00fcdd5c64e7a27\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/variantFacet.js\":\"4df603eb0f64f977\",\"/knowledge-medium/pr-preview/pr-1904/src/facets/verbFacet.js\":\"36d9537fa11c81b8\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/block.js\":\"60d990a6660eff6b\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/focusedChild.js\":\"1f35f0ac6f0272f0\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/propertySchemas.js\":\"da2a6db870722083\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/typeRegistry.js\":\"5906025b65da81bf\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useAncestorCrumbs.js\":\"e26a0538bcda9508\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useAutocompleteListbox.js\":\"9f0083f20ef07545\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useDebouncedSearch.js\":\"3c3c53d345bac83d\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useDebouncedValue.js\":\"4348720c050cc421\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useFacetValue.js\":\"0cba68ef948dcfcf\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useIsFocalRender.js\":\"d68709c10abcf51b\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useIsReadOnly.js\":\"f44bfb161275f80f\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useMaterializeBacklog.js\":\"e3513368af208efc\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useMinuteClock.js\":\"ee8f8ddcf7ea93cc\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/usePanelLayoutProjection.js\":\"93e2ee813e13756d\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/usePendingInvitations.js\":\"4efbf7221a5c481a\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useRendererRegistry.js\":\"cf634f2bf5c2e977\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useRetainedFieldRows.js\":\"8f7296c3b8f1a19e\",\"/knowledge-medium/pr-preview/pr-1904/src/hooks/useWorkspaces.js\":\"3d4377ffd3fb5019\",\"/knowledge-medium/pr-preview/pr-1904/src/lib/utils.js\":\"37d13fdc6ccecb29\",\"/knowledge-medium/pr-preview/pr-1904/src/main.js\":\"c93ef7787a17a8cb\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/MarkdownImage.js\":\"2e6eb4f5bdcb5cf4\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/blockSeparators.js\":\"483f12a483a5f2ec\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/context.js\":\"ef499a5616dd230f\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/defaultMarkdownExtension.js\":\"778eee2bec4a537d\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/extensions.js\":\"d0fa883f32d1f526\",\"/knowledge-medium/pr-preview/pr-1904/src/markdown/renderMarkdownHtml.js\":\"c0a3022127fed913\",\"/knowledge-medium/pr-preview/pr-1904/src/minimal-editor.js\":\"8508348fb9fc1439\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/armedCut.js\":\"dd4960251f859ff9\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/captureMediaVerb.js\":\"0518cfc10f2a1fdd\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/clipboard.js\":\"45fed2c7db360712\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/decision.js\":\"e7c5ee064b8d2d92\",\"/knowledge-medium/pr-preview/pr-1904/src/paste/operations.js\":\"f166b37221963061\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/account-header/AccountHeaderItem.js\":\"2bc93bacb14db5e8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/account-header/index.js\":\"7e6798cd4718a8d7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"6fd9bccb36e8c020\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/askAgent.js\":\"1ba3a923795f633f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/askedStore.js\":\"4e8913a29c3e0903\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"883dd56c77921a0e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/chipState.js\":\"dfbcde460c9cca0c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/dataExtension.js\":\"fc42bcae3017e138\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/index.js\":\"65af9d9a6a42eaac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"a4dbec7df26fb88a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-dispatch-companion/schema.js\":\"3ce80de74c87d974\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/AgentTokensDialog.js\":\"602b8113a355a3fe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/BridgePairingDialog.js\":\"417200607ccbdeb5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/addMedia.js\":\"8635bb47be0ce4cf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/backlinks.js\":\"de442cfc3c14f5a5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/block.js\":\"6b3823115745ecf4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/context.js\":\"b8ab35f50d69d4ff\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/displayIds.js\":\"1655381937e5cb24\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/index.js\":\"19d5f05ea350987c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/outline.js\":\"ee3846c8a785ca70\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/properties.js\":\"06537bc5f127d4b2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/refs.js\":\"4959225b0f81aa35\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"17eee475e0dad46a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/search.js\":\"74746b3204984ccd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/shared.js\":\"2ae2a01ee7721e9e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"ef022b447a7ca212\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentViews/text.js\":\"6bcf5fda5ca65d3a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/agentWrites.js\":\"0a5c7ac3d72c2580\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/authoringCatalog.js\":\"0f67fd5604e606a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/blockRefTargets.js\":\"c2cfed905413d64c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/bridge.js\":\"71649c03c464a97b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/bridgeLoop.js\":\"9a7ddd80b4253662\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/changeHistory.js\":\"ff04b8c514ab05aa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/commands.js\":\"349f6b0a6082b885\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/commentsCommands.js\":\"b19c2bfad1dba2c3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dataExtension.js\":\"0889d8c9d4ef873b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dataModelGuide.js\":\"18ec692fdbedd1a8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/dayPropertyInputs.js\":\"f91a05dbeccdaf05\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/describeRuntime.js\":\"ee9b4a98a2e7a277\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/extensionLint.js\":\"808b5aa538df144d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/grainAudit.js\":\"81eee1f326bc861f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/healthCommand.js\":\"67b0d37a107a22cf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/index.js\":\"9cb37c17b17a1a94\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/presetIdentity.js\":\"4ddc661ff371fdfb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"6da3c2c53bce66c9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/readMedia.js\":\"6ada764ceb405204\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/schema.js\":\"a410f980f53c6b7c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/serialization.js\":\"478fc6e37a713870\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/targets.js\":\"3405bf562caa568d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/tokens.js\":\"4f5735e167067506\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/watchEvents.js\":\"c22639fbae7f9d58\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/workspaceGuard.js\":\"33e19f463f4be9e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/agent-runtime/writeCommands.js\":\"dab5399e9cbd17ae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/AliasCollisionToast.js\":\"f15b661bc63e9434\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/DuplicateNameBanner.js\":\"b1405a266e4c800d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/collisionMerge.js\":\"6a5f4738c9b56e4a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/dataExtension.js\":\"a702e493952a0252\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/index.js\":\"cb21ac85658be407\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/mergeCollisionAction.js\":\"d2139e0c69ddbb48\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/pageStyling.js\":\"7d0acef0a5b2ba11\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/rejectionToast.js\":\"fa208649c88e528b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/alias/syncProcessor.js\":\"933fc0f80960e974\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/actions.js\":\"2b96862a73e4dde0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/addComment.js\":\"704c93d03058ebd8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/anchor.js\":\"8a488102e46c3b10\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/anchorState.js\":\"c854e9d9ab63bc9d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/commentLinks.js\":\"a909f83e517dbb0d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/confirmThreadDeletion.js\":\"2431259530044f85\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/container.js\":\"aad1626e697632fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/dataExtension.js\":\"e645b6c6c942757c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/deleteComment.js\":\"7e74d5d00b091d26\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/highlights.js\":\"9b1ce84f470067f1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/index.js\":\"5d1d752f637a54b2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/linkedCommentsPill.js\":\"b282ec35f2307f53\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/margin.js\":\"5293e83388c6414d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/marginAnchorLinks.js\":\"9985d1d5a4e6177b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/marginSchema.js\":\"f07417900c7f2ea0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/newComment.js\":\"c31e774ce78a4465\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/ownThreadPicker.js\":\"6be330e00e60ad18\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/placement.js\":\"038cc5c292ac72de\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/queries.js\":\"8b416300cfde62cb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotePosition.js\":\"18430f611b817e40\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotedIn.js\":\"7893dedeb7aa905c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/quotedRange.js\":\"742e0b57df58311a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/rangeRefs.js\":\"07e16fb6aa9e4356\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readHighlights.js\":\"e9b2529eb1943951\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readSelection.js\":\"6f7a199af32a6261\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/readSelectionUi.js\":\"6a75e1d6e515cc96\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/reanchor.js\":\"c9ea6e4c4c0f67c6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/schema.js\":\"823363ffb6570775\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/scope.js\":\"13f5e118bda5225b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/scopeThreads.js\":\"05491490da3fabda\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/splitRetarget.js\":\"9e190dc92ae7acc7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/suggestionCard.js\":\"8010effc20817106\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/suggestions.js\":\"96150bbb71fd4693\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/summaries.js\":\"366706fe88e6be0e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/summaryBatch.js\":\"8f02d20dc2b714ae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/surface.js\":\"e3977546122d4d15\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/threadNavigation.js\":\"5531bd198615ef45\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/threads.js\":\"0fe21836ad42aa32\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/ui.js\":\"8c5b6e0ed610c151\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/annotations/uiStore.js\":\"273913b02cd797a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-intents/appIntents.js\":\"ab9ae279668c1eb5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-intents/index.js\":\"22b3155bdd655995\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-update-prompt/index.js\":\"97137a403ae1a033\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/app-update-prompt/status.js\":\"00520b181b6baa07\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e30e61f1680d641b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaBlockRenderer.js\":\"1290c0af0ddcb962\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4f4f1a820540acf7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/MediaUploadReconciler.js\":\"eb4e9a529c791fdc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetDownLane.js\":\"392cbe35614dab46\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetResolver.js\":\"af0ed1171439ed63\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/assetUpload.js\":\"92e4cb27e5b6176a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/attachmentCleanerIO.js\":\"b77046f8bc9ec394\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/supabaseAuditIO.js\":\"643a1b6328c7b2a5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/blobStore.js\":\"89d5a65c315ba06b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/browserMedia.js\":\"9b85821bdcdb2ad1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/byteStore.js\":\"a8435d94a7251e6a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/cleanerIO.js\":\"afd6b9f79c1ae410\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/cleanupAttachments.js\":\"49319e5194ca2a3b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/dataExtension.js\":\"4866eb78c7e3164b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/downLane.js\":\"f62c834f2028bb61\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/index.js\":\"f2117d9a0be88527\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/insertImageContribution.js\":\"d78799d4e6cf2fb3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/laneArming.js\":\"4a3da48f89c1fe9e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/laneLock.js\":\"13873f1ada160777\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaBlock.js\":\"a5dac1017d9a28b8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaCapture.js\":\"6fac2df397ce23a8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaLanes.js\":\"882f9d5531770489\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaViewers.js\":\"31ae500422f0eed1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/mediaViewersFacet.js\":\"31643aa31ef9f997\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/pasteCapture.js\":\"71a99f3058178ead\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/resolver.js\":\"044e947b071569be\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/retryUploadsAction.js\":\"d8e220d13501b3e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/storagePaths.js\":\"f9eac26313a4e0fc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadDrain.js\":\"69a000321450877c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadLaneStatus.js\":\"f82b9b06de66b940\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadReconcile.js\":\"386b9327b4f2ca6a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadRecovery.js\":\"59d01b0447da560c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/uploadStore.js\":\"b2dfc4f02964bb78\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/attachments/useAssetObjectUrl.js\":\"e5ea3ebcab3e01f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"4549309f82fa1147\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/BacklinksViewSection.js\":\"9badaa4198f2aec0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/facet.js\":\"5db42b3d6c7ef11e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/index.js\":\"bdb47bb26aa3c547\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks-view/prop.js\":\"f7d8ecc4bf6fe3e6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BacklinkFilters.js\":\"cc335a33b9b1ee5b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b58c209b41133266\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/BlockEntry.js\":\"cf62fca4c0043726\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/LinkedReferences.js\":\"09a7f23ede76fb77\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"2b38c1762f8d93bb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/dailyNoteDefaults.js\":\"8d17eea60381125d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/dataExtension.js\":\"1f348f97a4647a27\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/edgeExclusions.js\":\"5c758114aa4a8abc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/filterProperty.js\":\"729cacf3554a2617\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/index.js\":\"69a48742b9827b05\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"eee7714fb4909532\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/applies.js\":\"ebb6404dd8849b27\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/countQuery.js\":\"cebea4b41fd32859\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/expansionStore.js\":\"8a22bff0b9e02346\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/index.js\":\"26efe37c443025da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f96709e3d9f6278d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/presentationInvalidation.js\":\"763658479445c279\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/propertyEditorOverride.js\":\"1b97dc74f8c41e35\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/propertyFilter.js\":\"31bc5cd5aba7af13\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/query.js\":\"04231ed6d6783de9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/resolveFilter.js\":\"0fff837fe7b3f5f1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/sourceBatch.js\":\"f1b2816390797eb5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/sources.js\":\"a038ce25d5cce400\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/useBacklinks.js\":\"1ba5d3ca78505751\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"78b93779e42db085\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/BirthdayCelebration.js\":\"e2359deceef1b020\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/BirthdayOverlay.js\":\"6f3a479181eb467b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/gate.js\":\"fd2675c70d436ad7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/index.js\":\"9f65af8c237ad562\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/birthday/wolfTheme.js\":\"a87d07a318184b77\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/BlockDragLayer.js\":\"81e4fa516f93ad68\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/dragController.js\":\"d8b07da772545eb7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/dropTarget.js\":\"afb0d8ebc32559f4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/index.js\":\"a842da1fe0e66494\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-drag/projection.js\":\"6730d0d201a63328\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-info/BlockMetaCard.js\":\"2505bf3332d2e0f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-info/index.js\":\"087c4cc5288fc5a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/AddTagDialog.js\":\"f5ab7a08e6ac3265\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"8bc00a9e4cfaaa61\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/TagNameIssueHint.js\":\"56bcf0d1c2f16e7b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/addTagAction.js\":\"78a335bfeeed4f8a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/appendTag.js\":\"20b4e888bf583971\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/config.js\":\"d26825af7cd9a25a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/dataExtension.js\":\"d2ad29cd6d4b2918\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/index.js\":\"23ce25007f53e1f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/block-tagging/propertyEditorOverride.js\":\"83056a60b8112faf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/BreadcrumbList.js\":\"25c87b758c12da41\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"d4ead3d160879b82\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/Breadcrumbs.js\":\"18b3fb9309cde375\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8fde569163653c84\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"dbc5c6480442707d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/index.js\":\"15aaf056768f350c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"dda92bbf6f0fd13e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/CharacterCountItem.js\":\"86a015ca2fc624af\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/ProfilePropertyEditor.js\":\"875d379e043850da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/actions.js\":\"802dfdc48f943d02\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/blockType.js\":\"719402dfa549a3ac\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/charCount.js\":\"0a5da66632efe117\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/dataExtension.js\":\"126652e3571ae260\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/index.js\":\"6a95ebac6f141c29\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/profiles.js\":\"8e0e6ea9f06d42f1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/properties.js\":\"7481a0063d29fa91\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/subtree.js\":\"e20f46bad08144f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/character-counter/textCounts.js\":\"84ccef1fe8d9040a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/colemak-keybindings/index.js\":\"44c2e8e72ec7f0a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/CommandPalette.js\":\"2a34746757ed302c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/HeaderItem.js\":\"acfa5613b516b3dd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/context.js\":\"c1eafb63a84ddfa9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/index.js\":\"6b8800b196314b19\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/selection.js\":\"e3af1c67f63116e0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/toggleStore.js\":\"18ba047847a42d63\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/command-palette/useCommandPaletteActions.js\":\"7cbff85986bf22d9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/ContributorBadges.js\":\"fc47fcf614ddfb59\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/ProfilePicture.js\":\"9cc67fda5f5a7d7b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/author.js\":\"a8fe48b9a4a74850\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/codeMirrorExtensions.js\":\"250e156c2c2dd3d2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/dataExtension.js\":\"48d6762b1dfbe493\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/index.js\":\"e5713bc1d11cdb68\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/mentionAutocomplete.js\":\"353fdd4e05b269a7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/processor.js\":\"ce2ec055ab1a12a2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/profiles.js\":\"65fea8f8b44969bf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/queries.js\":\"0cf9a603df369984\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/schema.js\":\"877f55975672c925\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/contributors/useCommentAuthor.js\":\"ef684e43231a3050\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3c4295bbcdc49367\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e89980bd8c733a0f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/index.js\":\"c694b7e631aa68c8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2632c7f9e3b55dae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"eea986de66900492\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/CalendarGrid.js\":\"3b523845b69ba567\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DailyNotePicker.js\":\"1c7d8019c49c5a2d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e52b8f3cad62da56\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateNavDecorator.js\":\"26dd0394f93c9c63\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DateScrubOverlay.js\":\"973062827ae532df\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DayPropertyControl.js\":\"5da91816921eb034\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/DayValueReferenceControl.js\":\"25a0648edf078c9f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/HeaderItem.js\":\"a74022adb40e76ae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/ReschedulePicker.js\":\"31897fe69cfce9a2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/SpreadDatesDialog.js\":\"6e969c3837bc67d6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/actions.js\":\"78ad7a65c845603e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/blockDateAdapter.js\":\"edce3d8a424f0801\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/calendar.js\":\"2153bd2e4ff8d4f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dailyNotes.js\":\"c9c75ea6cd858c33\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dataExtension.js\":\"f6cbd31010f8c4fd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubActions.js\":\"5ab4c375866984ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubGesture.js\":\"060e23260db799e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubGestureActions.js\":\"8f69f63a07112c6e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c54e2a00c81bf0fe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dayProperty.js\":\"7aad9debda52c4b2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"581b947089801c42\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/deletionGuard.js\":\"52da341ec2eefeff\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/dueQuery.js\":\"46026e94deb4a078\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/index.js\":\"2d873e97aa3ece90\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/landing.js\":\"81d7729f38eab1ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/localSchema.js\":\"227f40d85939f157\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/referenceDateAdapter.js\":\"dfbc1fc62a2055b1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/rescheduleAction.js\":\"d62034d1924ed3a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/schema.js\":\"a3e45a62627677ea\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/spreadBlockDates.js\":\"c514227abbf33b9a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/spreadDatesAction.js\":\"66796f06e715944c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/today.js\":\"05e697939525977f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ced5479ad760c3a1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"cbcff722ff3f0a61\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/audit.js\":\"8a4c5cdf094e3f86\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/auditAction.js\":\"b2f035e32cb820f8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/auditRanges.js\":\"b018d8b73c47c84a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/diagnosticsSource.js\":\"31c37c46c076d9c4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/divergenceScan.js\":\"800581234ee2c9a6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/index.js\":\"188f445aefe271fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b920a458cba1718a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/referencesMirror.js\":\"da5a3ec299f4fd72\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/rowJson.js\":\"674cab658eb1911b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/schedule.js\":\"9c9d6f3e2f24fd59\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/data-integrity/store.js\":\"206ebfbd8696a38f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/action.js\":\"01c5662aa87c2af9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/index.js\":\"2c8e46974c8848ea\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-maintenance/plugin.js\":\"df27fad255cca196\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"6f558d385a3acbda\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/actions.js\":\"810e3c59739312f7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/changeMarker.js\":\"aeb09b6ceaac2662\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/diagnostics.js\":\"d7ef7e5b3a88e3d4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/fileSystemAccess.js\":\"2e250500ad8950b4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/filenames.js\":\"d88b87e3c0c27ed6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/index.js\":\"0c78284fbb40cc52\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/mirror.js\":\"55c87d9971292a8d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/runLock.js\":\"f594f5aa652e9afd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/runtimeHealth.js\":\"757e34eb9cbad877\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/schedule.js\":\"8fa53be8c8a7798d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/db-mirror/store.js\":\"4c7a22d95a72b2e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/default-themes/index.js\":\"87a126b13ad98f53\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/default-themes/themes.js\":\"ce381c527605d221\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/diagnostics/facet.js\":\"dac107c56b3aeb18\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/diagnostics/useDiagnostics.js\":\"0140da7fdf5afb82\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/dismissals.js\":\"02854cfc74da7d9e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/index.js\":\"7c0d9589a606d561\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/status.js\":\"c101214dddc3e547\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extension-prompts/store.js\":\"ca0fedeef0775931\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9a8e7f02265a2ac9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/ExtensionsSettings.js\":\"855db25f46d59541\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/actions.js\":\"84ef7f836ec9606b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/config.js\":\"a324c491ee70abad\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/dataExtension.js\":\"0026a079b49fd786\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/effect.js\":\"ba512e2c65c48c31\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/index.js\":\"c8b107a747320e3b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/propertyEditorOverride.js\":\"197e668365a6aac6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extensions-settings/useToggleTree.js\":\"b0e2b807034a51bf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/ExtractTypeDialog.js\":\"6f8f8650c847bb2f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"9102fd43afd371b9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/PropertyShapePicker.js\":\"482d4560fe9daa4f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/action.js\":\"4aa75c1888f81a7e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/extract-type/index.js\":\"c9bf7d0bfca7899c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/FindReplaceDialog.js\":\"4d5e25e2d1875445\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/HeaderItem.js\":\"d1a56f6defdc3f04\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/dataExtension.js\":\"04c2d182e6e7ae53\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/index.js\":\"66a3cce5aeb29add\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/search.js\":\"67080712ef643ca5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/toggleStore.js\":\"5d0c1de7ac90ad83\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/LocationPropertyEditor.js\":\"899913ba079fa902\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/MapView.js\":\"368f731c9b72328a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/blockTypes.js\":\"441848249532e4eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/codeMirrorExtensions.js\":\"bb54a01f5c2eae78\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/createOrFindPlace.js\":\"dbafbcd0dd6301e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/currentLocation.js\":\"d153d8b4f8863e5f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/dataExtension.js\":\"6cfa7b984b1938dc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/geoContentDecorator.js\":\"86f88594846356d3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/googlePlacesClient.js\":\"99951de74132ea66\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/index.js\":\"5a3e04825f820961\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/locationsPage.js\":\"31021dae45896099\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/mapViewport.js\":\"c65b5236ad53cb9b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/pickCurrentLocation.js\":\"2405fc7b784f12e9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/placeAutocomplete.js\":\"19ac32a82b250170\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/placeNameCollision.js\":\"cf9587afe00a0efd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/properties.js\":\"cb0fb7f52fb68903\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/propertyEditorOverrides.js\":\"fd2974e104164cce\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/query.js\":\"e1d9d075bc36fcd0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/geo/usePlaceSearch.js\":\"2bdbeb695eff77b9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"541ea8de3e7ef23c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"89854c48cc802d05\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"74c83a714f056739\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/config.js\":\"c706e657ea83d080\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/dataExtension.js\":\"4412baa7c7c77d8a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/facet.js\":\"79b5e97aef5b93ed\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/grouping.js\":\"51b9319c2df754fc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/index.js\":\"a6495ab1dbf4bb67\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6e44803584867a07\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/query.js\":\"a93968c46dcc81f4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/resolveConfig.js\":\"809261b9156ad5eb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"fc3f37a82183f8d0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"73c73b69f3c3b032\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/HtmlDocumentContent.js\":\"96d9b5e11c03835d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/HtmlFrame.js\":\"fcff134d22601f52\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/actions.js\":\"a4d1fcea55a75c88\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/blockType.js\":\"b6ebc5954715b061\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/confirmRunScripts.js\":\"384b1d45e2841c50\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/dataExtension.js\":\"ba4741250344016b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameAnnotations.js\":\"54016c5500503cd7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameDocument.js\":\"281d5fd120b60860\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/frameTheme.js\":\"f1991ecacb1f3da0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/index.js\":\"8002193346fec342\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/scriptConsent.js\":\"5dd6d4a211061144\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/sourceMap.js\":\"893f30a7384accc7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/html-document/useDocumentScripts.js\":\"6504e17623ba370c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/index.js\":\"3c21f4c7485eb31b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/record.js\":\"dac119a32f5fad54\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/recordStore.js\":\"190ee9783c88e522\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/responsiveness.js\":\"7b4a7b38d4704dae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/schedule.js\":\"7746f66248d3499b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/interaction-metrics/sessionContext.js\":\"c48bf5a6212ecc0e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"135901e5a30d018b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5cbc52e4d8897043\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/actions.js\":\"fa1227c42a13fd2d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/config.js\":\"0b3cc216884dd852\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/dataExtension.js\":\"45c66bf4a02d267e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/effect.js\":\"dfb71328b095c909\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/index.js\":\"a3bef79cf2eb4d6e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/keyCapture.js\":\"9a6e6c28cddcf598\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/overrideStore.js\":\"2fffaebbb65dbbc7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"b130ca1a7ddc87ec\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/HeaderItem.js\":\"229766372aa8170c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/LeftSidebar.js\":\"db0d9dd3d8922f84\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/actions.js\":\"e7c2ce4dfb1e2b3d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/facet.js\":\"a405bf14b1a79342\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/index.js\":\"0fabf6e1f06e29da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/shortcuts.js\":\"3f5f223650b92800\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/left-sidebar/toggleStore.js\":\"0756aa4fb8078afb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/MergePicker.js\":\"56297b4f86f5a1be\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/index.js\":\"84bd93c1164aede8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/mergeAction.js\":\"375cd441ac7fa3c4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/merge-blocks/strategy.js\":\"55b05d951dfe6a9e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/Button.js\":\"980acdcc2f0cb9ec\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a0c6aefc91281f90\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/defaultItems.js\":\"559c87efd8c2bd6a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/facet.js\":\"bf094215fb1ac1f8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-bottom-nav/index.js\":\"e2879ba5c321b9db\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"e1b3143131820e10\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/actions.js\":\"bb3174b4f3d04692\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"e3f579f2ba1da749\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/facet.js\":\"3c697ad409b519aa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/mobile-keyboard-toolbar/index.js\":\"03d65425c2773c64\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/MoveDestinationPicker.js\":\"16fadfddf3bcf40d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/blockSubtreeMembership.js\":\"89df43dec2cef3db\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/contextMenuItem.js\":\"91a0fb53d0506ef3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/index.js\":\"d4227e2e756ccacc\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/moveAction.js\":\"4093deb67a9befdb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/moveBlocks.js\":\"e2a6ab68305d4329\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/move-blocks/selectionAfterMove.js\":\"8dbff1a41ae67fba\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/TutorialBanner.js\":\"e8af9c7db4c75180\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/action.js\":\"9482af5f1b3ddd45\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/bannerDismissal.js\":\"96ef2aa2cc8c91f4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/documents/cheatSheet.js\":\"9d256b71b07ddf63\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/index.js\":\"ccc2beb4da7e4b78\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/keys.js\":\"68511e4ae7798366\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/landing.js\":\"24208743174716a6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/outline.js\":\"2fa71330a6e29536\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/onboarding/seed.js\":\"5e7f14afed067a41\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/PerfTrendDialog.js\":\"61690338f74e28a6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/analyze.js\":\"748cd434726ebd3b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/diagnosticsSource.js\":\"92b0750de7657acd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/index.js\":\"6e9a0e8b9c162484\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/load.js\":\"7151150afdc1312e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/monitorRun.js\":\"3a19fb9f014fdd1e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/schedule.js\":\"5dd586e8256dfa23\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/series.js\":\"06a488a8a344339b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/store.js\":\"8e7ca399e17653bf\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/trendAction.js\":\"39d5cde2ad58d9a6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/perf-monitor/verdict.js\":\"4f9fee022f7cbfca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/clickToEditAction.js\":\"447016c0daebf4ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/index.js\":\"fecfc1bf8bdd3656\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/plain-outliner/interactions.js\":\"5c3bae9f1a854593\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"faaf8b4078b4edc6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/MigrationGate.js\":\"50c65fc386636c7a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/MigrationGateDialog.js\":\"681fd69281c095e6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/action.js\":\"a67c881227c0c93b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/index.js\":\"904344d83e77c9a2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/localRunMessage.js\":\"9ae72ef6023ccf39\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/plugin.js\":\"c2f91fe4f73668da\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/progressReport.js\":\"338b765866930832\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/properties-migration/sweepProgress.js\":\"7ad7e0be4b23c26b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/FieldRowRenderer.js\":\"b0b155f4bd2965f3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/ValueRowRenderer.js\":\"553aa7ccad4ab561\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/actions.js\":\"5ecacaaa0164460d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/autocomplete.js\":\"e346c653a6c99afb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/fieldRow.js\":\"7832371b8ee28ef9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/index.js\":\"ac7417cabdb5b148\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/referenceWarning.js\":\"a2d9d9a931726af1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/valueAutocomplete.js\":\"d10125ba81a77b1e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/property-rows/valueSchema.js\":\"0d1723bc38389020\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/HeaderItem.js\":\"681e5b6f84915900\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/QuickFind.js\":\"9803f1364abbcb92\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/index.js\":\"7424331eb1614c01\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/recents.js\":\"1c848e040096e1a1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/resultItems.js\":\"7bdff02effd2128f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/selection.js\":\"30b759c0eaaf5054\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/quick-find/toggleStore.js\":\"b5d504d3b6922404\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/HeaderItem.js\":\"3876ed4330b32b12\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/RecentsPageBlockRenderer.js\":\"dafc065de3dc89e3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/grouping.js\":\"ca82bb2414083270\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/index.js\":\"481ec342333fda0d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/recents/target.js\":\"285a1c619508dfd7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/codeMirrorExtensions.js\":\"ba6c83999d757818\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/contentPrefill.js\":\"c9a58c528f4ebd32\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/dataExtension.js\":\"578141e360ddd7e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/index.js\":\"d22fc036b48b9868\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d8189b46e691e7ef\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/invalidation.js\":\"ae7f5f76a91b0064\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/localSchema.js\":\"71c6ffd16316baf1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/blockrefs/index.js\":\"f1edcf3deefa9fa1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"aead804ec1c00ede\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/index.js\":\"a3e17128cf59e599\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/referenceNode.js\":\"d2ade461f659427b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/remark-reference-occurrences.js\":\"f8b7a43ec5219925\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f6b37a36f1149cfa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/index.js\":\"8187ff84d065c098\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"a8d0cdf6435cfb3a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"60ac6a278c359737\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/mergeRetargetProcessor.js\":\"7957f281091ac15a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/parseFence.js\":\"0212668429efd1a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referenceParser.js\":\"f2b9d51bc1192a99\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referenceProjection.js\":\"31db50a32c768f66\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/referencesProcessor.js\":\"3815876e939cc9ae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/renameProcessor.js\":\"e53a310299d77f26\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/references/spanReplacement.js\":\"28865d315ce504d1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/htmlToOutline.js\":\"196bdff7b2cbf851\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/index.js\":\"390a60d5bbea058c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/normalizeClipboardDom.js\":\"62da6de7c6111900\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/rich-paste/pasteDecision.js\":\"be14b814595f5725\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/action.js\":\"4c697d64cb7ed221\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/blockIds.js\":\"0db8f661bbc6a20f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/content.js\":\"1e1a849b58843a7e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/effect.js\":\"e4cde66eaeb61f22\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/ids.js\":\"bc05de87886a5738\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/import.js\":\"1f554bce92b7e836\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/index.js\":\"cfa256b83c5ddfae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/plan.js\":\"fee60d94ab2f3eea\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/plugin.js\":\"7469ffe3ec634250\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/promotion.js\":\"f3716fc7285e8cf3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/properties.js\":\"216c26a4ec617675\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/references.js\":\"03281b56b462cc26\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/report.js\":\"8447e2b787aea673\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/roamMemo.js\":\"f78aead67001b49b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/runtime.js\":\"df42784f51836113\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/schemaReconciliation.js\":\"7090542630da4ea1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/srsMarkers.js\":\"d69c127535caf630\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/todo.js\":\"faa64afd492f3827\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/typeCandidates.js\":\"e60ef3d13ad75e17\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/roam-import/types.js\":\"74e35a723a824038\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/search-health/index.js\":\"5b2b5d6ff6e28810\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/search-health/store.js\":\"0fc5b5f1753ad3b3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/HeaderItem.js\":\"cf085a719c61cda2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"fb25ee6c0f83a544\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/index.js\":\"bc44bb377035f611\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/model.js\":\"3edc884e2d0ed06a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/toggleStore.js\":\"729bbd2a0f2247ca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/shortcut-help/useKeyInspector.js\":\"3a9ca9e70d98a52f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c117dab405c3fd53\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/ShellDecorator.js\":\"d5dc15cdfb6d6468\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/actions.js\":\"a831011e2d80be75\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/exclusionsFacet.js\":\"549804edb0377fe7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/index.js\":\"883fb924834024f1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/shell.js\":\"c84d877486e2d576\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/surface.js\":\"689359c5a2c828e7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/spatial-navigation/walker.js\":\"9309feb9423f67ad\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/RescheduleToast.js\":\"035198293217a423\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/dataExtension.js\":\"e6f104142b8f9fbe\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/index.js\":\"a29d8d892a3b9cc4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/indicator.js\":\"249c5cba02844d91\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/moveSrsState.js\":\"67b3b0cd6c574afa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d31fb52aec77a763\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/scheduler.js\":\"7c4db8f574844650\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/schema.js\":\"7ccb77d2e68469ee\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"657bb72ae9b1fe4c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/srsClipboard.js\":\"dca1f5e73e3039c7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"4e944fe9edde640a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/DailyNoteReviewHint.js\":\"277f0bc1365cb13c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/DeckPicker.js\":\"7a118b61570c1000\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewControls.js\":\"2ddc6671f79ba7a0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3e30d17fad0b78a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/ReviewSession.js\":\"2e1ef3ee491f5ac0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/actions.js\":\"179a3f241ab255a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/archive.js\":\"27d244f745676293\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/dataExtension.js\":\"115dd4c4654dabfa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/deck.js\":\"e774b16cfbef1c7a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/dueQuery.js\":\"6f9c554b223bd659\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/gradeDecision.js\":\"04d3e506286b9beb\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/index.js\":\"72a673ca8688e67e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/keyHints.js\":\"1ee3d0011f0b9ac8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/reviewCardLayout.js\":\"bbd308db2a8736e6\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/reviewProgress.js\":\"7362d202b6f5ae18\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/schema.js\":\"3037ae0a272c6bb9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/srs-review/useDueCards.js\":\"966d89c5d87aa613\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/startup-metrics/index.js\":\"84a6d98f95d99f0d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/startup-metrics/record.js\":\"167469f77f6db79e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/index.js\":\"884a51ae3b200c46\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/persistenceStatus.js\":\"2f69a70f56ccc39c\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/storage-persistence/requestAction.js\":\"0f7bb555180a9a80\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/TypeChipsDecorator.js\":\"9dba8195f5ee98a7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/codeMirrorExtensions.js\":\"e08b3a4dfdc657a2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/index.js\":\"96cc9400d7808f26\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/supertags/typeAutocomplete.js\":\"89f3d0cca1ac1a19\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"64e79d71f631a42e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/actions.js\":\"f9219956f98eb3a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/anchor.js\":\"fef720576dd2d1d8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/events.js\":\"494e189944d7aa8a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/gestureActions.js\":\"460cfe0dd39f1934\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/index.js\":\"d1250ea0cc467a6a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"8d51951f01f20ea4\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/collect.js\":\"04139bf4af6ae081\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/index.js\":\"10ed65f8c56b195d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/sync-metrics/record.js\":\"70e09399e9b8ffab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/RejectionDialog.js\":\"049b1bc04267d762\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/SystemStatusHeaderItem.js\":\"515b371e46c673ae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/index.js\":\"dc0bcb7331b9745d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/model.js\":\"9c952dd3ce1e52ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/queueCounts.js\":\"3ecdae5f4e9028f8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/rejectedHelpers.js\":\"c6c0478855d5a45a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/rematerializeAction.js\":\"938ccd740000c731\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/system-status/useHysteresis.js\":\"fee9b3fc2b88d28f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/ColumnHeaders.js\":\"a02938a5cd809720\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/QueryUi.js\":\"965985efcbe78d3d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/TableLayout.js\":\"85a0c51da98d9bf0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/actions.js\":\"11b8804cda6af3ca\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/cellEdits.js\":\"fcf237c2b5f309c5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/childrenViews.js\":\"0e6692590704f2ab\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/columns.js\":\"0ee92514805fb25e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/controller.js\":\"be82ec94b7d5493e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/convert.js\":\"f6c52c881893628f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/dataExtension.js\":\"5a8466c509e5be9f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/index.js\":\"51a783317da8f0a3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/keys.js\":\"1353c8d7afd78869\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/model.js\":\"759f267741b2a5c3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/QueryText.js\":\"4d38eab41cc79cc3\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/backfill.js\":\"16e30bef38dbbf2d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/completion.js\":\"3c3baf772fd39fa9\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/format.js\":\"3361718a3bfd6f18\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/parse.js\":\"bbb31af995ae0f74\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/queryValue.js\":\"0e88debd0cbc6fa5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/registrations.js\":\"94d88b68e36eab2b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/query/source.js\":\"64b4bf70f9aeea44\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/registry.js\":\"a03a80df263f75c8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/rowGutter.js\":\"ed592d43537fc498\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/rowVerbs.js\":\"3a00bf0ef50018f7\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/schema.js\":\"697654ad7ace885e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/tables/sort.js\":\"b13a62880c1cbef0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/effect.js\":\"1ada51e97e474c68\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/index.js\":\"438d115e2b541513\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/theme-toggle/theme.js\":\"82742da830eb5bf5\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/actions.js\":\"64b6f25e5546d5c2\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/dataExtension.js\":\"7157586ae4984979\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/index.js\":\"204a14e0864296e8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/todo/schema.js\":\"16c1be61ce0e94fa\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1df5b47dd04bef1f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/actions.js\":\"209806ed7c8919e0\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/defaultItems.js\":\"a8a72a07d7db2a5d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/facet.js\":\"49b55d5ed6ba7b03\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/holdRecognizer.js\":\"cc455413d6352a9a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/touch-selection/index.js\":\"793a47f7bb356471\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/UpdateIndicator.js\":\"317c0ac0dda15212\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/index.js\":\"ff51a58184876884\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/update-indicator/loadTimes.js\":\"f3a87d0811bdf3ae\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoNotesRenderer.js\":\"127345d91614342f\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoPlayerRenderer.js\":\"17643cbc954d16e1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/VideoTimeStamp.js\":\"00b581a6134e3c9a\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/actions.js\":\"ab732d8c74a69fdd\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/index.js\":\"e0bd22fd3bbb8793\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/markdown.js\":\"b0f1898d2e15b85e\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/notes.js\":\"7a551de74a5c49d8\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/registry.js\":\"01d2189242e1ee14\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/remark-timestamps.js\":\"de841bb1aa988887\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/video-player/view.js\":\"5e43f5d9c51f1f0d\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/LinkHints.js\":\"a985eabcf752bfd1\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/index.js\":\"7e02d145b187896b\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/model.js\":\"507d88008a7ce656\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-link-hints/settings.js\":\"c490f9f00bf86663\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/actions.js\":\"a04ddf5138eff163\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/index.js\":\"66c945d2c0d1cb49\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/vim-normal-mode/interactions.js\":\"6143a8a275693d66\",\"/knowledge-medium/pr-preview/pr-1904/src/plugins/workspace-header/index.js\":\"1606b3d9e9c2de5e\",\"/knowledge-medium/pr-preview/pr-1904/src/registerServiceWorker.js\":\"31ae16ae03e41d4f\",\"/knowledge-medium/pr-preview/pr-1904/src/requestPersistentStorage.js\":\"661a9359bb4e66d0\",\"/knowledge-medium/pr-preview/pr-1904/src/services/authRequestDeadline.js\":\"3478d3ac84d088ef\",\"/knowledge-medium/pr-preview/pr-1904/src/services/authStorage.js\":\"758c31ae3031b29d\",\"/knowledge-medium/pr-preview/pr-1904/src/services/powersync.js\":\"1395f384dc0d38f6\",\"/knowledge-medium/pr-preview/pr-1904/src/services/supabase.js\":\"9c5c766dcf150d97\",\"/knowledge-medium/pr-preview/pr-1904/src/services/uploadErrorClassifier.js\":\"25076a2bc91be8f7\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/ActiveContexts.js\":\"447aa328f01ac68e\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/HotkeyReconciler.js\":\"5959b98bb0d84f30\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/WipeLocalDataDialog.js\":\"a198162f759dd56c\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/actionDispatch.js\":\"37dcd46631e942ff\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/actionRefItems.js\":\"095d60c9e2756d0c\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/applyKeybindingOverrides.js\":\"eb39ed59b2ac8b2d\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/blockActions.js\":\"ec8cbb18744477c9\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/blockMergeGesture.js\":\"89ea14fb4a918717\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/canonicalizeChord.js\":\"883d70bcadb01776\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/defaultContexts.js\":\"e343763d4ed37bec\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/defaultShortcuts.js\":\"b0e59ece62aca301\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/effectiveActions.js\":\"d45a5f44a034333b\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/gestureAction.js\":\"54e681756d7b50b1\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/gestureBinding.js\":\"a16507d8f95ca80d\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/holdRegistry.js\":\"d40e2b57c4dca5e3\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/keybindingConflicts.js\":\"4549935d10e3d6ec\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/keybindingOverrides.js\":\"2d46bed0c299157b\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/pointerAction.js\":\"78654a0f4bc0edea\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/resolve.js\":\"35302aa92eeea7ab\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/runAction.js\":\"0924a87e8a4069a5\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/sequenceMatcher.js\":\"3d6e2e845eaecf30\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/types.js\":\"3f6ba92fa1f25e5c\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/useActionContext.js\":\"1e2a1fd5a50ce305\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/useActionDiscovery.js\":\"60f0db3409d7aef8\",\"/knowledge-medium/pr-preview/pr-1904/src/shortcuts/utils.js\":\"3b3f2ba54e6bb621\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/bootStore.js\":\"b8d16452f1936dde\",\"/knowledge-medium/pr-preview/pr-1904/src/sw/previewDatabases.js\":\"474c86452f82b3c4\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/byteTransform.js\":\"1d8dc24fa11b72cd\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/attachmentCleaner.js\":\"512eb42b0bf25096\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/attachmentParts.js\":\"ba3fb204225827f0\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/bundleParts.js\":\"82d38c1b2c7caef0\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/bundleRecord.js\":\"50e1b924544c59c0\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/manifest.js\":\"7ec2eae49c872d47\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/takeBundle.js\":\"461db0e236746cf1\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/bundle/verifyBundle.js\":\"03fdd1f7e4d35e85\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/cleaningStage.js\":\"08e08db61cffb637\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionKey.js\":\"77db05fa9dee7a20\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/conversionServer.js\":\"e2de95c313b6832e\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/flip.js\":\"5bb7f22e728ab04c\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/flipAttempts.js\":\"8966505123928f73\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/pages.js\":\"443783d6a449dddf\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/preflight.js\":\"fd0534558f1c8b2b\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/reseal.js\":\"d2e38f590bfd6840\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/runConversion.js\":\"8f8d6fc4646d6084\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/runLock.js\":\"28bdf26664149e27\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/sealing.js\":\"353b1000039dc6fa\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/sealingStage.js\":\"67c1be30a2d75b41\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/stage.js\":\"dc44f90b624c94ae\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/conversion/verifyReseal.js\":\"2481159965e0cfaf\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/aad.js\":\"460f4fc1850d3670\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/aead.js\":\"06fc568d41de2931\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/base32.js\":\"38d5a9b824cf9893\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/base64url.js\":\"e2028f5d9a698d73\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/binaryEnvelope.js\":\"dffe01ce1e51b2cf\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/byteAead.js\":\"944b87aeab19bd6f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/canary.js\":\"3b55d0d2c434b31a\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/contentHash.js\":\"d64d56a20a22e4cb\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/contentKey.js\":\"3092213124d7f0d3\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/derivedIdNamespace.js\":\"d3b76cbeda855721\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/envelope.js\":\"4f8efd9c1553d05f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/hex.js\":\"802f337e7b12cd2f\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/sha256Hex.js\":\"0761da9dffd5ef91\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/crypto/workspaceKey.js\":\"d4efc1a5e2f41e19\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/conversionState.js\":\"e218c899878990cd\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3baddda05bddf230\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/pastedKey.js\":\"ef0f91f87ee34c6e\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bcf7c588eb868e27\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/flows/upgradeWorkspacePin.js\":\"04893b1cb704b58a\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/keyStore.js\":\"24f4f84bc2c83baa\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/mintWorkspaceKey.js\":\"b0da7d863a056b6b\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/modePin.js\":\"0a3d942ce50b043a\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/openWorkspaceKeys.js\":\"e3b644acc3853940\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/resolveWorkspaceEntry.js\":\"1863ace2a2896c25\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/resolver.js\":\"6de185d76e847a62\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/keys/workspaceAccess.js\":\"01d35775861d3940\",\"/knowledge-medium/pr-preview/pr-1904/src/sync/transform.js\":\"241272e6868d67ab\",\"/knowledge-medium/pr-preview/pr-1904/src/themeBootDefaults.js\":\"fbccf00bbc905640\",\"/knowledge-medium/pr-preview/pr-1904/src/types.js\":\"07a729266881c5da\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/ClientLocalSettings.js\":\"30824f4c4668bf5f\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/abortableSleep.js\":\"ece583eb0110007a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/array.js\":\"0bee16ccb5d61821\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/backlinkAutocomplete.js\":\"2f3d1a27fefd03f8\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/blockCrumbs.js\":\"50e4f1b2ca8e6847\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/blockrefAutocomplete.js\":\"42702435f92b9706\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/cadencedIdleJob.js\":\"254ec302a0611f91\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/callbackSet.js\":\"1b6b6ce4145cdfda\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/clientId.js\":\"fa449e2c3cbfb9e3\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/codemirror.js\":\"c4e523afe7484c2a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/codemirrorCompletion.js\":\"b67c5eebffc3739e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/copy.js\":\"f086ef491c71a465\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dailyPage.js\":\"89cd84c96aca93ff\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dbForensics.js\":\"8dbf44d26d957ec9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dbForensicsHooks.js\":\"b5927cee44ef184c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/deleteBlockThroughUi.js\":\"6707941120f36125\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dialogs.js\":\"8fc0bf6b4eb034fa\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/dom.js\":\"5f638fc7a2f94cfb\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/downloadBlob.js\":\"722368b0dc28bd2e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/drawnWalk.js\":\"4cb643e03f9a6e6e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/exportSqliteDb.js\":\"125e237d6563341f\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fileSystemAccess.js\":\"500f381640b7d5cb\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/flipSlide.js\":\"3dd62add7977b124\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fnv1a.js\":\"93d37de37f84efe8\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/formatBytes.js\":\"b676fdfe827d0306\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/fuzzyRank.js\":\"d0a497f333fd16c2\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/idbKeyedStore.js\":\"733e828cc4691a3f\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/idleCallbackPolyfill.js\":\"352c1d66d68dbed7\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/keyboardAwareScroll.js\":\"3e3639ea655e36fa\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/keyboardViewport.js\":\"773aaefb71c1f0b7\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/lastWorkspace.js\":\"715c46ff45a06a6d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutColumns.js\":\"27cbc3e2dcadf389\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutSessionDom.js\":\"25c1155235eaa3b4\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/layoutSessionId.js\":\"12fe604f63db9b93\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/linkClickGestures.js\":\"7953a422ef58fde6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/linkTargetAutocomplete.js\":\"fa3bfa77ec73661d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/localDbCorruption.js\":\"d9704fc09896d9bb\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/localDbRecovery.js\":\"16dc66c6b4f1409d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/markdownParser.js\":\"8a99448aa82ec26b\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/memoize.js\":\"ab7205171ae73bbc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/nameFieldCommit.js\":\"b81ceeccf64575c3\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/nameList.js\":\"4d56037305c97ef8\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/navigation.js\":\"2f527e10ef0739c1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/omnilinerNamespace.js\":\"33618dbb63eb264a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/opfsPageScan.js\":\"5fe57f6198525976\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelClearance.js\":\"c6b26578c50f1a91\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelHistory.js\":\"199f8cbb1b515780\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelLanes.js\":\"bb627be5e5af9157\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelLayoutProjection.js\":\"b03789d66ce86d1f\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelScrollAnchor.js\":\"af5c8464df111f52\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/panelUrlFlags.js\":\"905a0e759be40e0e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/platform.js\":\"864c8fdcdbab3efe\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/pluralize.js\":\"b0ff9a1f958116bc\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyCreation.js\":\"80f4ef01d5a9609c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyNavigation.js\":\"42e6149778660bac\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/propertyValueContext.js\":\"6f59a5f1ecab8f40\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/react.js\":\"a8138bb03d036933\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/relativeDate.js\":\"8bc01bca8811f70f\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/relativeTime.js\":\"39ef6f2554cf7d7c\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/renderScope.js\":\"72e7beb2ff5d76a0\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/resolvedThenable.js\":\"24a03c496c611955\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/routing.js\":\"69b3779b8d9bea80\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/safeMode.js\":\"5aa067bbb984387b\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/scheduleIdle.js\":\"f8184760643f94dd\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/screenWakeLock.js\":\"f899ddf6e4c3634a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/selection.js\":\"66fed5694ea246b6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/softKeyboardGrab.js\":\"e0cb8934230375db\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/startupTimeline.js\":\"75be37afc3ca9d1d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/state.js\":\"da39d4a6edb30242\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/string.js\":\"83ab1102ed49e62a\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/surfaceZoom.js\":\"f07851f1f60e9620\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/time.js\":\"1830bcdc3032ec46\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/toast.js\":\"2fe7c052863254d8\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/toggleStore.js\":\"14ecde7809f95dbf\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/untilStopped.js\":\"9c9e918cdfa64ddd\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/userActivity.js\":\"d09262a71f68a2f9\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/viewTransition.js\":\"42ff942acb13fee5\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/viewport.js\":\"82c3c786e09676a1\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/webLock.js\":\"e7a654e3e2bda81e\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/workspaceRecovery.js\":\"68ef774176aaad6d\",\"/knowledge-medium/pr-preview/pr-1904/src/utils/workspaceSnapshotStore.js\":\"f5c321713744929b\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-compiler-runtime.js\":\"a6732dd3aa6ce849\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-client.js\":\"07e87b4ca53db5e4\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-server-edge.js\":\"af9b78baca5dd3c6\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-server.js\":\"b412d5ce7b1e1dc9\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-static-edge.js\":\"e36031eb1be9007d\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-static.js\":\"3170bb6e90e8092e\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom-test-utils.js\":\"b2205a438c524b9a\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-dom.js\":\"d289d9f7be4cd878\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react-jsx-runtime.js\":\"f1d5a679df2bfa8b\",\"/knowledge-medium/pr-preview/pr-1904/src/vendor/react.js\":\"e1eb27b943659aca\",\"/knowledge-medium/pr-preview/pr-1904/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1904/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1904/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
